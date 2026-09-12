import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelPolicyResolver, modelRouteKey } from './model-policy.js';
import { ModelCapacityLeaseManager } from './model-capacity.js';
import { Config, WorkflowDispatch, classifyFailure, createRoutingProbeTool, loadModelPolicy } from './index.js';
import { ArtifactBridge } from './artifact-bridge.js';

const policy = {
  version: 1,
  roles: {
    fast: [{ provider: 'fast-1', model: 'fast-a', effort: 'high', privacy: 'private-safe' }],
    balanced: [
      { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
      { provider: 'balanced-2', model: 'balanced-b', effort: 'high', privacy: 'private-safe' },
      { provider: 'balanced-3', model: 'balanced-c', effort: 'xhigh', privacy: 'private-safe' },
    ],
    deep: [{ provider: 'deep-1', model: 'deep-a', effort: 'xhigh', privacy: 'private-safe' }],
  },
};

function input(phaseKey, request = {}) {
  return {
    role: 'balanced',
    phaseKey,
    provider: 'spawn',
    request: { parent: { session: { header: { id: 'parent-1' } } }, ...request },
  };
}

function dispatchWith(behaviors) {
  const calls = [];
  let sequence = 0;
  const ctx = { on: () => () => {} };
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, request });
      const behavior = behaviors[sequence++] ?? 'success';
      if (behavior instanceof Error || typeof behavior === 'object') throw behavior;
      return { id: `run-${sequence}`, result: Promise.resolve({ output: [], stopReason: behavior }), dispose: async () => {} };
    },
  };
  const resolver = new ModelPolicyResolver(policy);
  const dispatch = new WorkflowDispatch(ctx, resolver);
  return { calls, dispatch, start: phaseKey => dispatch.start({ ...input(phaseKey), subagents }) };
}

test('inactive plugin context falls back to post-start local-agent attachment', async () => {
  const calls = [];
  const childHandlers = new Map();
  const localAgent = {
    ctx: { on: (event, handler) => { childHandlers.set(event, handler); return () => {}; } },
    session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
    options: { provider: 'balanced-1', model: 'balanced-a' },
  };
  const ctx = {
    on: () => { throw new Error('cannot create effect on inactive context'); },
  };
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, request });
      return {
        id: 'run-inactive-context',
        localAgent,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));

  const envelope = await dispatch.start({ ...input('run-1:re-review'), subagents });
  assert.equal(calls.length, 1);
  assert.equal(envelope.run.id, 'run-inactive-context');
  assert.ok(childHandlers.has('system-prompt/assemble'));
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'balanced-1', model: 'balanced-a', reasoningEffort: 'high' });
});

test('inactive child context keeps the selected route in agentOptions instead of failing dispatch', async () => {
  const calls = [];
  const localAgent = {
    ctx: { on: () => { throw new Error('cannot create effect on inactive context'); } },
    session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
    options: { provider: 'balanced-1', model: 'balanced-a' },
  };
  const ctx = { on: () => { throw new Error('cannot create effect on inactive context'); } };
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, request });
      return {
        id: 'run-inactive-child-context',
        localAgent,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));

  const envelope = await dispatch.start({ ...input('run-1:inactive-child'), subagents });
  assert.equal(envelope.run.id, 'run-inactive-child-context');
  assert.deepEqual(calls[0].request.agentOptions, { provider: 'balanced-1', model: 'balanced-a', reasoningEffort: 'high' });
  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
});

test('verification evidence retains the child captured by agent/created when the provider run does not expose localAgent', async () => {
  let createdHandler;
  const localAgent = {
    ctx: { on: () => () => {} },
    session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
    options: { provider: 'balanced-1', model: 'balanced-a' },
  };
  const ctx = {
    on: (event, handler) => {
      if (event === 'agent/created') createdHandler = handler;
      return () => {};
    },
  };
  const subagents = {
    start: async () => {
      createdHandler?.({ agent: localAgent });
      return {
        id: 'captured-without-local-agent',
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:captured-verification-agent'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.deepEqual(envelope.verificationAgents(), [localAgent]);
});

test('resource guard config defaults are production-safe and reject zero limits', () => {
  assert.deepEqual(Config({}).resourceGuard, { enabled: true, maxFreshTokens: 500_000, maxLlmCalls: 100 });
  assert.deepEqual(Config({}).passthroughSubagentProviders, ['browser-chat']);
  assert.equal(Config({}).routingProbe.enabled, true);
  assert.equal(Config({}).routingProbe.browserChatWorkspaceRoundTrip, true);
  assert.deepEqual(Config({}).usageAdmission, { enabled: true, minRemainingPercent: 0, providerUsageLimits: [{ provider: 'gemini-api', maxUsedPercent: 90 }], refreshMs: 60_000, timeoutSeconds: 12 });
  assert.deepEqual(Config({ usageAdmission: { providerUsageLimits: [{ provider: 'gemini-api', maxUsedPercent: 90 }] } }).usageAdmission.providerUsageLimits, [{ provider: 'gemini-api', maxUsedPercent: 90 }]);
  assert.deepEqual(Config({}).artifactBridge, { enabled: true, maxFiles: 2000 });
  assert.deepEqual(Config({ passthroughSubagentProviders: ['browser-chat'] }).passthroughSubagentProviders, ['browser-chat']);
  assert.throws(() => Config({ resourceGuard: { maxFreshTokens: 0 } }));
  assert.throws(() => Config({ resourceGuard: { maxLlmCalls: 0 } }));
  assert.throws(() => Config({ usageAdmission: { providerUsageLimits: [{ provider: 'gemini-api', maxUsedPercent: 101 }] } }));
});

test('artifact-capable read-only task prefers browser chat and removes local tool dependency', async () => {
  const calls = [];
  let cleanupCalls = 0;
  const browserPolicy = {
    version: 1,
    roles: {
      fast: policy.roles.fast,
      balanced: [
        { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
        { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      ],
      deep: policy.roles.deep,
    },
  };
  const artifactBridge = {
    prepare: async () => ({ mode: 'read-only', bundle: 'BUNDLE' }),
    browserRequest: request => ({ ...request, prompt: [{ type: 'text', text: 'TASK\nBUNDLE' }], toolFilter: { allow: [] } }),
    finalizeMutation: async (_plan, outcome) => ({ ok: true, outcome }),
    cleanup: async () => { cleanupCalls += 1; },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(browserPolicy),
    {}, new ModelCapacityLeaseManager(), [], async () => {}, undefined, artifactBridge,
  );
  const subagents = { start: async (provider, request) => {
    calls.push({ provider, request });
    return { id: 'browser-read', result: Promise.resolve({ output: [{ type: 'text', text: 'OK' }], stopReason: 'completed' }), dispose: async () => {} };
  } };
  const envelope = await dispatch.start({
    ...input('artifact-read', {
      prompt: [{ type: 'text', text: 'TASK' }],
      toolFilter: { allow: ['read', 'grep'] },
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } }, required: ['verdict'] },
    }),
    subagents,
  });
  assert.equal((await envelope.run.result).stopReason, 'completed');
  assert.equal(calls[0].provider, 'browser-chat');
  assert.deepEqual(calls[0].request.toolFilter, { allow: [] });
  assert.match(calls[0].request.prompt[0].text, /BUNDLE/u);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.finalProvider, 'browser-chat');
  assert.equal(telemetry.artifactBridge.mode, 'read-only');
  assert.equal(telemetry.artifactBridge.browserPreferred, true);
  assert.equal(cleanupCalls, 1);
});

test('workspace-capable mutation prefers browser chat and accepts locally collected file edits', async () => {
  const calls = [];
  const browserPolicy = {
    version: 1,
    roles: {
      fast: policy.roles.fast,
      balanced: [
        { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
        { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      ],
      deep: policy.roles.deep,
    },
  };
  const artifactBridge = {
    prepare: async () => ({ mode: 'mutation', root: 'fixture', bundle: 'BUNDLE' }),
    browserRequest: request => ({ ...request, prompt: [{ type: 'text', text: 'TASK\nWORKSPACE' }], toolFilter: { allow: [] } }),
    finalizeMutation: async (_plan, outcome) => ({ ok: true, outcome: { output: outcome.output, stopReason: 'completed' } }),
  };
  const resolver = new ModelPolicyResolver(browserPolicy);
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} }, resolver, {}, new ModelCapacityLeaseManager(), [], async () => {}, undefined, artifactBridge,
  );
  const subagents = { start: async (provider, request) => {
    calls.push({ provider, request });
    return {
      id: 'browser-mutate',
      result: Promise.resolve({ output: [{ type: 'text', text: 'UPDATED' }], stopReason: 'completed' }),
      dispose: async () => {},
    };
  } };
  const envelope = await dispatch.start({ ...input('artifact-mutation', { prompt: [{ type: 'text', text: 'Edit the repository.' }] }), subagents });
  assert.equal((await envelope.run.result).stopReason, 'completed');
  assert.equal(calls[0].provider, 'browser-chat');
  assert.equal(resolver.circuitState(browserPolicy.roles.balanced[1]), 'closed');
});

test('artifact mutation refusal falls back locally without opening browser circuit', async () => {
  const calls = [];
  const browserPolicy = {
    version: 1,
    roles: {
      fast: policy.roles.fast,
      balanced: [
        { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
        { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      ],
      deep: policy.roles.deep,
    },
  };
  const artifactBridge = {
    prepare: async () => ({ mode: 'mutation', root: 'fixture', bundle: 'BUNDLE' }),
    browserRequest: request => ({ ...request, prompt: [{ type: 'text', text: 'TASK\nWORKSPACE' }], toolFilter: { allow: [] } }),
    finalizeMutation: async () => ({ ok: false, reason: 'unsupported' }),
  };
  const resolver = new ModelPolicyResolver(browserPolicy);
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} }, resolver, {}, new ModelCapacityLeaseManager(), [], async () => {}, undefined, artifactBridge,
  );
  const subagents = { start: async (provider, request) => {
    calls.push({ provider, request });
    return provider === 'browser-chat'
      ? { id: 'browser-refuse', result: Promise.resolve({ output: [{ type: 'text', text: 'NO FILE CHANGES' }], stopReason: 'completed' }), dispose: async () => {} }
      : { id: 'local-fallback', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
  } };
  const envelope = await dispatch.start({ ...input('artifact-fallback', { prompt: [{ type: 'text', text: 'Perform a live operation.' }] }), subagents });
  assert.equal((await envelope.run.result).stopReason, 'completed');
  assert.deepEqual(calls.map(call => call.provider), ['browser-chat', 'spawn']);
  assert.equal(resolver.circuitState(browserPolicy.roles.balanced[1]), 'closed');
});

test('browser artifact preference is per-turn and does not poison same-phase local routing', async () => {
  const calls = [];
  let prepareCall = 0;
  const browserPolicy = {
    version: 1,
    roles: {
      fast: policy.roles.fast,
      balanced: [
        { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
        { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      ],
      deep: policy.roles.deep,
    },
  };
  const artifactBridge = {
    prepare: async () => ({ mode: (++prepareCall === 2) ? 'read-only' : 'local-only', bundle: 'BUNDLE' }),
    browserRequest: request => ({ ...request, prompt: [{ type: 'text', text: 'TASK\nBUNDLE' }], toolFilter: { allow: [] } }),
    finalizeMutation: async (_plan, outcome) => ({ ok: true, outcome }),
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} }, new ModelPolicyResolver(browserPolicy), {}, new ModelCapacityLeaseManager(), [], async () => {}, undefined, artifactBridge,
  );
  const subagents = { start: async provider => {
    calls.push(provider);
    return { id: `turn-${calls.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
  } };
  const request = { prompt: [{ type: 'text', text: 'TASK' }], toolFilter: { allow: ['read'] } };
  assert.equal((await (await dispatch.start({ ...input('same-phase', request), subagents })).run.result).stopReason, 'completed');
  assert.equal((await (await dispatch.start({ ...input('same-phase', request), subagents })).run.result).stopReason, 'completed');
  assert.equal((await (await dispatch.start({ ...input('same-phase', request), subagents })).run.result).stopReason, 'completed');
  assert.deepEqual(calls, ['spawn', 'browser-chat', 'spawn']);
});

test('usage admission skips a route before start without opening its circuit', async () => {
  const calls = [];
  const resolver = new ModelPolicyResolver(policy);
  const subagents = { start: async (_provider, request) => {
    calls.push(request.agentOptions);
    return { id: 'usage-route', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
  } };
  const usageAdmission = { evaluate: async () => ({
    status: 'fresh',
    skippedRoutes: new Set(['balanced-1\0balanced-a']),
    decisions: [{ provider: 'balanced-1', model: 'balanced-a', remainingPercent: 2, thresholdPercent: 10, admitted: false, reason: 'usage_below_threshold', resetAt: '2026-09-08T00:00:00Z' }],
  }) };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver, {}, new ModelCapacityLeaseManager(), [], async () => {}, usageAdmission);
  const envelope = await dispatch.start({ ...input('usage-admission'), subagents });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'balanced-2');
  assert.equal(resolver.circuitState(policy.roles.balanced[0]), 'closed');
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.attempts.length, 1);
  assert.equal(telemetry.attempts[0].provider, 'balanced-2');
  assert.equal(telemetry.usageAdmission.skipped[0].reason, 'usage_below_threshold');
  assert.equal(telemetry.usageAdmission.skipped[0].resetAt, '2026-09-08T00:00:00Z');
});

test('usage admission prefers lower remaining quota and keeps that order sticky for the phase', async () => {
  const calls = [];
  let evaluations = 0;
  const resolver = new ModelPolicyResolver(policy);
  const subagents = { start: async (_provider, request) => {
    calls.push(request.agentOptions);
    return { id: `usage-priority-${calls.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
  } };
  const usageAdmission = { evaluate: async () => {
    evaluations += 1;
    return {
      status: 'fresh',
      skippedRoutes: new Set(),
      preferredRoutes: evaluations === 1
        ? ['balanced-2\0balanced-b', 'balanced-1\0balanced-a']
        : ['balanced-1\0balanced-a', 'balanced-2\0balanced-b'],
      decisions: [],
    };
  } };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver, {}, new ModelCapacityLeaseManager(), [], async () => {}, usageAdmission);
  const firstEnvelope = await dispatch.start({ ...input('usage-priority'), subagents });
  await firstEnvelope.run.result;
  const firstTelemetry = await firstEnvelope.telemetry;
  const secondEnvelope = await dispatch.start({ ...input('usage-priority'), subagents });
  await secondEnvelope.run.result;
  const secondTelemetry = await secondEnvelope.telemetry;
  assert.deepEqual(calls.map(call => call.provider), ['balanced-2', 'balanced-2']);
  assert.equal(firstTelemetry.initialProvider, 'balanced-2');
  assert.equal(secondTelemetry.initialProvider, 'balanced-2');
  assert.deepEqual(firstTelemetry.usageAdmission.preferredRoutes.slice(0, 2), ['balanced-2\0balanced-b', 'balanced-1\0balanced-a']);
});

test('usage admission can deterministically exhaust all candidates without starting a provider', async () => {
  let calls = 0;
  const usageAdmission = { evaluate: async candidates => ({
    status: 'fresh',
    skippedRoutes: new Set(candidates.map(modelRouteKey)),
    decisions: candidates.map(candidate => ({ ...candidate, admitted: false, reason: 'usage_exhausted', remainingPercent: 0 })),
  }) };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(policy), {}, new ModelCapacityLeaseManager(), [], async () => {}, usageAdmission);
  const envelope = await dispatch.start({ ...input('usage-exhausted'), subagents: { start: async () => { calls += 1; throw new Error('must not start'); } } });
  assert.equal(calls, 0);
  assert.equal((await envelope.run.result).stopReason, 'error');
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.attempts.length, 0);
  assert.equal(telemetry.usageAdmission.skipped.length, 3);
});

test('routing probe runs only the supplied candidate chain and returns routing telemetry', async () => {
  const calls = [];
  const parent = { session: { header: { id: 'probe-parent' } } };
  const ctx = {
    on: () => () => {},
    llm: {
      listProviders: () => [{ id: 'aihubmix' }],
      listModels: async provider => provider === 'aihubmix'
        ? [{ provider: 'aihubmix', id: 'coding-glm-5.3-flash' }]
        : [],
    },
    subagents: {
      start: async (provider, request) => {
        calls.push({ provider, request });
        if (provider === 'browser-chat') {
          return {
            id: 'browser-probe',
            result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)' }),
            dispose: async () => {},
          };
        }
        return {
          id: 'aihubmix-probe',
          result: Promise.resolve({ output: [{ type: 'text', text: 'ROUTING_PROBE_OK' }], stopReason: 'completed' }),
          dispose: async () => {},
        };
      },
    },
  };
  const tool = createRoutingProbeTool(ctx, { enabled: true, browserChatWorkspaceRoundTrip: false });
  const result = await tool.execute({
    candidates: [
      { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      { provider: 'aihubmix', model: 'coding-glm-5.3-flash', effort: 'high', privacy: 'private-safe' },
    ],
    prompt: 'Reply exactly: ROUTING_PROBE_OK',
    expected: 'ROUTING_PROBE_OK',
    maxTokens: 64,
  }, { agent: parent, signal: new AbortController().signal });

  assert.deepEqual(calls.map(call => [call.provider, call.request.agentOptions?.provider]), [
    ['browser-chat', undefined],
    ['spawn', 'aihubmix'],
  ]);
  assert.equal(result.status, 'completed');
  assert.equal(result.responseMatched, true);
  assert.equal(result.finalProvider, 'aihubmix');
  assert.equal(result.finalModel, 'coding-glm-5.3-flash');
  assert.deepEqual(result.candidateChain.map(candidate => [candidate.provider, candidate.model]), [
    ['browser-chat', 'gemini-3.8-flash-ui'],
    ['aihubmix', 'coding-glm-5.3-flash'],
  ]);
  assert.deepEqual(result.attempts.map(attempt => attempt.provider), ['browser-chat', 'aihubmix']);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('routing probe requires browser-chat workspace round trip when enabled', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'dsh-routing-probe-workspace-'));
  const workspaceRoot = join(temp, 'browser-chat-workspace');
  const parent = { session: { header: { id: 'probe-workspace-parent', cwd: temp } } };
  const ctx = {
    on: () => () => {},
    llm: { listProviders: () => [], listModels: async () => [] },
    subagents: {
      start: async provider => {
        assert.equal(provider, 'browser-chat');
        const directories = (await readdir(workspaceRoot, { withFileTypes: true })).filter(entry => entry.isDirectory());
        assert.equal(directories.length, 1);
        const source = await readFile(join(workspaceRoot, directories[0].name, 'routing-probe.txt'), 'utf8');
        const output = source.replace('WORKSPACE_INPUT_', 'WORKSPACE_OUTPUT_');
        const patch = [
          '--- routing-probe.txt',
          '+++ routing-probe.txt',
          '@@ -1 +1 @@',
          `-${source.trimEnd()}`,
          `+${output.trimEnd()}`,
        ].join('\n');
        return {
          id: 'browser-workspace-probe',
          result: Promise.resolve({
            output: [{ type: 'text', text: JSON.stringify({ status: 'patch', summary: 'workspace probe', patch, tests: [] }) }],
            stopReason: 'completed',
          }),
          dispose: async () => {},
        };
      },
    },
  };
  const artifactBridge = new ArtifactBridge({ enabled: true, workspaceRoot });
  const tool = createRoutingProbeTool(ctx, { enabled: true, browserChatWorkspaceRoundTrip: true }, undefined, artifactBridge);
  try {
    const result = await tool.execute({
      candidates: [
        { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
      ],
      role: 'balanced',
      maxTokens: 64,
    }, { agent: parent, signal: new AbortController().signal });

    assert.equal(result.status, 'completed', JSON.stringify(result, null, 2));
    assert.equal(result.responseMatched, true);
    assert.equal(result.finalProvider, 'browser-chat');
    assert.deepEqual(result.browserChatWorkspaceRoundTrip, {
      required: true,
      passed: true,
      file: 'routing-probe.txt',
      inputPrefix: 'WORKSPACE_INPUT_',
      outputPrefix: 'WORKSPACE_OUTPUT_',
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('routing probe applies the same usage admission before provider start', async () => {
  const calls = [];
  const parent = { session: { header: { id: 'probe-usage-parent' } } };
  const ctx = {
    on: () => () => {},
    llm: {
      listProviders: () => [{ id: 'balanced-1' }, { id: 'balanced-2' }],
      listModels: async provider => [{ provider, id: provider === 'balanced-1' ? 'balanced-a' : 'balanced-b' }],
    },
    subagents: {
      start: async (_provider, request) => {
        calls.push(request.agentOptions);
        return { id: 'probe-usage-run', result: Promise.resolve({ output: [{ type: 'text', text: 'ROUTING_PROBE_OK' }], stopReason: 'completed' }), dispose: async () => {} };
      },
    },
  };
  const usageAdmission = { evaluate: async () => ({
    status: 'fresh',
    skippedRoutes: new Set(['balanced-1\0balanced-a']),
    decisions: [{ provider: 'balanced-1', model: 'balanced-a', admitted: false, remainingPercent: 3, reason: 'usage_below_threshold' }],
  }) };
  const tool = createRoutingProbeTool(ctx, { enabled: true }, usageAdmission);
  const result = await tool.execute({ candidates: [
    { provider: 'balanced-1', model: 'balanced-a', effort: 'high', privacy: 'private-safe' },
    { provider: 'balanced-2', model: 'balanced-b', effort: 'high', privacy: 'private-safe' },
  ] }, { agent: parent });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'balanced-2');
  assert.equal(result.finalProvider, 'balanced-2');
  assert.equal(result.usageAdmission.status, 'fresh');
  assert.equal(result.usageAdmission.skipped[0].reason, 'usage_below_threshold');
});

test('routing probe is disabled unless explicitly enabled and bounds the candidate list', async () => {
  const ctx = { on: () => () => {}, subagents: { start: async () => { throw new Error('should not start'); } } };
  const parent = { session: { header: { id: 'probe-parent' } } };
  await assert.rejects(
    () => createRoutingProbeTool(ctx, { enabled: false }).execute({
      candidates: [{ provider: 'p', model: 'm', effort: 'high', privacy: 'private-safe' }],
    }, { agent: parent, signal: new AbortController().signal }),
    /disabled/u,
  );
  await assert.rejects(
    () => createRoutingProbeTool(ctx, { enabled: true }).execute({ candidates: [] }, { agent: parent, signal: new AbortController().signal }),
    /1 to 8 candidates/u,
  );
});

test('capacity_busy is typed separately from provider health failures', () => {
  const local = new Error('model capacity unavailable');
  local.code = 'capacity_busy';
  assert.equal(classifyFailure(local), 'capacity_busy:code_capacity_busy');
  assert.equal(
    classifyFailure('transient_provider_error: browser-chat bridge failure (status: TARGET_LOST)'),
    'transient_provider_error',
  );
});

test('passthrough subagent provider strips unsupported agentOptions and surfaces capacity_busy without opening model circuits', async () => {
  const calls = [];
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, agentOptions: request.agentOptions });
      return {
        id: 'browser-run',
        result: Promise.resolve({
          output: [],
          stopReason: 'error',
          diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)',
        }),
        dispose: async () => {},
      };
    },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(policy),
    {},
    new ModelCapacityLeaseManager({ databasePath: ':memory:' }),
    ['browser-chat'],
  );

  const envelope = await dispatch.start({
    ...input('run-browser:review', { agentOptions: { maxTokens: 512 } }),
    subagentProvider: 'browser-chat',
    subagents,
  });
  assert.deepEqual(await envelope.run.result, {
    output: [],
    stopReason: 'error',
    diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)',
  });
  assert.deepEqual(calls, [{ provider: 'browser-chat', agentOptions: undefined }]);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.role, 'balanced');
  assert.equal(telemetry.phaseKey, 'run-browser:review');
  assert.equal(telemetry.provider, undefined);
  assert.equal(telemetry.model, undefined);
  assert.equal(telemetry.failureClassification, 'capacity_busy');
  assert.equal(telemetry.circuitState, 'closed');
});

test('mixed routing chain prefers browser-chat, then restores original model order after BUSY', async () => {
  const mixedPolicy = structuredClone(policy);
  mixedPolicy.roles.balanced = [
    { provider: 'free', model: 'free-model', effort: 'high', privacy: 'private-safe' },
    { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
    { provider: 'paid', model: 'paid-model', effort: 'high', privacy: 'private-safe' },
  ];
  const calls = [];
  const subagents = {
    start: async (provider, request) => {
      calls.push({ provider, agentOptions: request.agentOptions });
      if (provider === 'browser-chat') {
        return { id: 'browser-run', result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)' }), dispose: async () => {} };
      }
      if (request.agentOptions.provider === 'free') {
        return { id: 'free-run', result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'rate limit' }), dispose: async () => {} };
      }
      return { id: 'paid-run', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(mixedPolicy));
  const envelope = await dispatch.start({ ...input('run-mixed:work', { agentOptions: { maxTokens: 512 }, toolFilter: { allow: [] } }), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.deepEqual(calls, [
    { provider: 'browser-chat', agentOptions: undefined },
    { provider: 'spawn', agentOptions: { maxTokens: 512, provider: 'free', model: 'free-model', reasoningEffort: 'high' } },
    { provider: 'spawn', agentOptions: { maxTokens: 512, provider: 'paid', model: 'paid-model', reasoningEffort: 'high' } },
  ]);
  const telemetry = await envelope.telemetry;
  assert.deepEqual(telemetry.attempts.map(attempt => [attempt.provider, attempt.failureClassification]), [
    ['browser-chat', 'capacity_busy'],
    ['free', 'rate_limit'],
    ['paid', undefined],
  ]);
  assert.equal(telemetry.finalProvider, 'paid');
  assert.equal(telemetry.finalModel, 'paid-model');
  assert.equal(telemetry.fallbackReason, 'capacity_busy -> rate_limit');
});

test('browser chat is skipped for mutation-capable and local-tool workflow tasks', async () => {
  const constrainedPolicy = structuredClone(policy);
  constrainedPolicy.roles.balanced = [
    { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' },
    { provider: 'paid', model: 'paid-model', effort: 'high', privacy: 'private-safe' },
  ];
  for (const request of [
    { agentOptions: { maxTokens: 512 } },
    { agentOptions: { maxTokens: 512 }, toolFilter: { allow: ['read'] } },
  ]) {
    const calls = [];
    const subagents = {
      start: async (provider, childRequest) => {
        calls.push({ provider, agentOptions: childRequest.agentOptions, toolFilter: childRequest.toolFilter });
        return { id: `run-${calls.length}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
      },
    };
    const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(constrainedPolicy));
    const envelope = await dispatch.start({ ...input(`run-capability-${calls.length}:work`, request), subagents });
    assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'spawn');
    assert.equal(calls[0].agentOptions.provider, 'paid');
    assert.equal(calls[0].agentOptions.model, 'paid-model');
  }
});

test('model capacity falls back for only the busy task, opens no circuit, and returns to the preferred model after release', async () => {
  const configured = structuredClone(policy);
  configured.capacity = [{ provider: 'balanced-1', model: 'balanced-a', maxInFlight: 1 }];
  const calls = [];
  let releaseFirst;
  const firstResult = new Promise(resolve => { releaseFirst = resolve; });
  let starts = 0;
  const subagents = {
    start: async (_provider, request) => {
      starts += 1;
      calls.push([request.agentOptions.provider, request.agentOptions.model]);
      if (starts === 1) return { id: 'held', result: firstResult, dispose: async () => {} };
      return { id: `run-${starts}`, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const leaseDirectory = await mkdtemp(join(tmpdir(), 'dsh-dispatch-capacity-'));
  try {
    const dispatch = new WorkflowDispatch(
      { on: () => () => {} },
      new ModelPolicyResolver(configured),
      {},
      new ModelCapacityLeaseManager({ databasePath: join(leaseDirectory, 'capacity.sqlite') }),
    );
    const first = await dispatch.start({ ...input('run-1:capacity'), subagents });
    const second = await dispatch.start({ ...input('run-1:capacity'), subagents });
    assert.deepEqual(await second.run.result, { output: [], stopReason: 'completed' });
    const secondTelemetry = await second.telemetry;
    assert.deepEqual(calls, [['balanced-1', 'balanced-a'], ['balanced-2', 'balanced-b']]);
    assert.equal(secondTelemetry.attempts[0].failureClassification, 'capacity_busy:code_capacity_busy');
    assert.equal(secondTelemetry.attempts[0].circuitState, 'closed');
    assert.equal(secondTelemetry.fallbackReason, 'capacity_busy:code_capacity_busy');
    releaseFirst({ output: [], stopReason: 'completed' });
    await first.run.result;
    const third = await dispatch.start({ ...input('run-1:capacity'), subagents });
    assert.deepEqual(await third.run.result, { output: [], stopReason: 'completed' });
    assert.deepEqual(calls, [['balanced-1', 'balanced-a'], ['balanced-2', 'balanced-b'], ['balanced-1', 'balanced-a']]);
  } finally {
    await rm(leaseDirectory, { recursive: true, force: true });
  }
});

test('provider fault injection falls back once, stays bounded, and emits route telemetry', async () => {
  const { calls, start } = dispatchWith([{ status: 429 }, 'completed']);
  const envelope = await start('run-1:work');
  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls.map(call => [call.request.agentOptions.provider, call.request.agentOptions.model]), [['balanced-1', 'balanced-a'], ['balanced-2', 'balanced-b']]);
  assert.equal(telemetry.role, 'balanced');
  assert.equal(telemetry.phase, 'default');
  assert.equal(telemetry.phaseKey, 'run-1:work');
  assert.equal(telemetry.sensitivity, 'public');
  assert.equal(telemetry.pricingWindow, 'default');
  assert.equal(telemetry.scheduleRule, undefined);
  assert.equal(telemetry.attempt, 2);
  assert.equal(telemetry.finalProvider, 'balanced-2');
  assert.equal(telemetry.finalModel, 'balanced-b');
  assert.equal(telemetry.fallbackReason, 'rate_limit:http_429');
  assert.equal(telemetry.failureClassification, undefined);
  assert.equal(telemetry.circuitState, 'closed');
  assert.equal(telemetry.candidateChain.length, 3);
  assert.ok(telemetry.durationMs >= 0);
});

test('timeout and 504 faults use the same provider-only fallback path', async () => {
  for (const fault of [new Error('network timeout'), { status: 504 }]) {
    const { calls, start } = dispatchWith([fault, 'completed']);
    const envelope = await start(`run-${String(fault.status ?? 'timeout')}`);
    await envelope.run.result;
    assert.equal(calls.length, 2);
  }
});

test('AIHubMix no-available-channel retries the same model once, then falls back to the next AIHubMix model', async () => {
  const localPolicy = structuredClone(policy);
  localPolicy.roles.balanced = [
    { provider: 'aihubmix', model: 'coding-glm-5.3-flash', effort: 'high', privacy: 'private-safe' },
    { provider: 'aihubmix', model: 'coding-glm-5.3', effort: 'high', privacy: 'private-safe' },
    { provider: 'google', model: 'gemini-3.8-flash', effort: 'high', privacy: 'private-safe' },
  ];
  const fault = new Error('INVALID_REQUEST: 400: {"message":"The current model cannot be routed at the moment, please try again later.","code":"no_available_channel"}');
  const calls = [];
  const waits = [];
  let sequence = 0;
  const subagents = {
    start: async (_provider, request) => {
      calls.push([request.agentOptions.provider, request.agentOptions.model]);
      sequence += 1;
      if (sequence <= 2) throw fault;
      return { id: 'paid-glm', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(localPolicy),
    {},
    new ModelCapacityLeaseManager({ databasePath: ':memory:' }),
    [],
    async ms => { waits.push(ms); },
  );
  const envelope = await dispatch.start({ ...input('run-aihubmix-no-channel'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls, [
    ['aihubmix', 'coding-glm-5.3-flash'],
    ['aihubmix', 'coding-glm-5.3-flash'],
    ['aihubmix', 'coding-glm-5.3'],
  ]);
  assert.deepEqual(waits, [20_000]);
  assert.equal(telemetry.attempts[0].failureClassification, 'transient_provider_error:code_no_available_channel');
  assert.equal(telemetry.attempts[0].retryAfterMs, 20_000);
  assert.equal(telemetry.attempts[1].failureClassification, 'transient_provider_error:code_no_available_channel');
  assert.equal(telemetry.attempts[1].retryAfterMs, undefined);
  assert.equal(telemetry.finalProvider, 'aihubmix');
  assert.equal(telemetry.finalModel, 'coding-glm-5.3');
  assert.equal(telemetry.noChannelRetryCount, 1);
  assert.equal(telemetry.noChannelRetryWaitMs, 20_000);
});

test('a provider response failure on the first child falls back and records the fault', async () => {
  const handlers = new Map();
  const ctx = {
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  };
  let release;
  const firstResult = new Promise(resolve => { release = resolve; });
  let starts = 0;
  const subagents = {
    start: async (_provider, request) => {
      starts += 1;
      if (starts === 1) {
        const localAgent = {
          ctx: { on: (event, handler) => { handlers.set(`child:${event}`, handler); return () => {}; } },
          session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
          options: { provider: request.agentOptions.provider, model: request.agentOptions.model },
        };
        return { id: 'first', localAgent, result: firstResult, dispose: async () => {} };
      }
      return { id: 'second', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:response-failure'), subagents });
  await handlers.get('child:agent/request-error')({ failure: { status: 504 } }, async () => undefined);
  release({ output: [], stopReason: 'error' });
  await envelope.run.result;
  const telemetry = await envelope.telemetry;
  assert.equal(starts, 2);
  assert.equal(telemetry.attempts[0].failureClassification, 'transient_provider_error:http_504');
  assert.equal(telemetry.finalModel, 'balanced-b');
});

test('provider rate limits bypass child retry and fall back immediately', async () => {
  const handlers = new Map();
  const ctx = {
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  };
  let release;
  const firstResult = new Promise(resolve => { release = resolve; });
  const calls = [];
  let starts = 0;
  const subagents = {
    start: async (_provider, request) => {
      calls.push([request.agentOptions.provider, request.agentOptions.model]);
      starts += 1;
      if (starts === 1) {
        const localAgent = {
          ctx: { on: (event, handler) => { handlers.set(`child:${event}`, handler); return () => {}; } },
          session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
          options: { provider: request.agentOptions.provider, model: request.agentOptions.model },
        };
        return { id: 'first-rate-limited', localAgent, result: firstResult, dispose: async () => {} };
      }
      return { id: 'second-after-rate-limit', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:early-rate-limit-fallback'), subagents });
  let downstreamCalls = 0;
  const action = await handlers.get('child:agent/request-error')({
    failure: {
      code: 'RATE_LIMIT',
      status: 429,
      message: '429: free_rate_limited',
    },
  }, async () => {
    downstreamCalls += 1;
    return { kind: 'retry' };
  });
  assert.equal(action, undefined);
  assert.equal(downstreamCalls, 0, 'provider rate limits must not reach the child retry plugin');
  release({ output: [], stopReason: 'error' });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls, [
    ['balanced-1', 'balanced-a'],
    ['balanced-2', 'balanced-b'],
  ]);
  assert.equal(telemetry.attempts[0].failureClassification, 'rate_limit:http_429:code_rate_limit');
  assert.equal(telemetry.attempts[0].retryAfterMs, undefined);
  assert.equal(telemetry.finalProvider, 'balanced-2');
  assert.equal(telemetry.fallbackReason, 'rate_limit:http_429:code_rate_limit');
});

test('a terminal turn error without request-error still falls back using durable child evidence', async () => {
  let starts = 0;
  const subagents = {
    start: async (_provider, request) => {
      starts += 1;
      if (starts === 1) {
        const localAgent = {
          ctx: { on: () => () => {} },
          session: {
            header: { origin: 'subagent', parentSession: 'parent-1' },
            events: [{
              type: 'turn/end',
              data: {
                reason: {
                  kind: 'error',
                  error: {
                    code: 'RATE_LIMIT',
                    message: '400: free_rate_limited: prompt is longer than the free tier allows; retryable=false',
                  },
                },
              },
            }],
          },
          options: { provider: request.agentOptions.provider, model: request.agentOptions.model },
        };
        return { id: 'first-terminal-error', localAgent, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => {} };
      }
      return { id: 'second-after-terminal-error', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:terminal-turn-error'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.equal(starts, 2);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.attempts[0].failureClassification, 'rate_limit:code_rate_limit');
  assert.equal(telemetry.finalModel, 'balanced-b');
});

test('provider fallback retains every task-owned route agent for workflow verification', async () => {
  let starts = 0;
  const priorAgent = {
    ctx: { on: () => () => {} },
    session: {
      header: { origin: 'subagent', parentSession: 'parent-1' },
      events: [
        { type: 'tool/call', data: { callId: 'write-before-fallback', name: 'write', arguments: '{"path":"required.txt"}' } },
        { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'write-before-fallback', content: [{ type: 'text', text: 'ok' }] }] } } },
        { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '400: free_rate_limited' } } } },
      ],
    },
    options: { provider: 'balanced-1', model: 'balanced-a' },
  };
  const finalAgent = {
    ctx: { on: () => () => {} },
    session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
    options: { provider: 'balanced-2', model: 'balanced-b' },
  };
  const subagents = {
    start: async () => {
      starts += 1;
      if (starts === 1) return { id: 'prior-route', localAgent: priorAgent, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => {} };
      return { id: 'final-route', localAgent: finalAgent, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:verification-agents'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.equal(starts, 2);
  assert.deepEqual(envelope.verificationAgents(), [priorAgent, finalAgent]);
  assert.deepEqual(envelope.verificationSessionIds(), ['prior-route', 'final-route']);
});

test('RetryInfo on a provider rate limit falls back instead of restarting the same provider', async () => {
  const handlers = new Map();
  const ctx = {
    on: (event, handler) => {
      handlers.set(event, handler);
      return () => {};
    },
  };
  let release;
  const firstResult = new Promise(resolve => { release = resolve; });
  const calls = [];
  let starts = 0;
  const subagents = {
    start: async (_provider, request) => {
      calls.push([request.agentOptions.provider, request.agentOptions.model]);
      starts += 1;
      if (starts === 1) {
        const localAgent = {
          ctx: { on: (event, handler) => { handlers.set(`child:${event}`, handler); return () => {}; } },
          session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
          options: { provider: request.agentOptions.provider, model: request.agentOptions.model },
        };
        return { id: 'first', localAgent, result: firstResult, dispose: async () => {} };
      }
      return { id: 'retry', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch(ctx, new ModelPolicyResolver(policy));
  const envelope = await dispatch.start({ ...input('run-1:retry-info'), subagents });
  await handlers.get('child:agent/request-error')({
    failure: {
      code: 'QUOTA',
      message: '{"error":{"code":429,"message":"quota exceeded","details":[{"retryDelay":"0.001s"}]}}',
    },
  }, async () => undefined);
  release({ output: [], stopReason: 'error' });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls, [
    ['balanced-1', 'balanced-a'],
    ['balanced-2', 'balanced-b'],
  ]);
  assert.equal(telemetry.attempts[0].failureClassification, 'rate_limit:http_429:code_quota');
  assert.equal(telemetry.attempts[0].retryAfterMs, undefined);
  assert.equal(telemetry.attempts[0].circuitState, 'open');
  assert.equal(telemetry.finalProvider, 'balanced-2');
  assert.equal(telemetry.fallbackReason, 'rate_limit:http_429:code_quota');
  assert.equal(telemetry.circuitState, 'closed');
});

test('quality failure is terminal and does not switch providers', async () => {
  const { calls, start } = dispatchWith([new Error('validator failure')]);
  await assert.rejects(() => start('run-1:quality'), /validator failure/u);
  assert.equal(calls.length, 1);
});

test('explicit engine quality escalation advances a deep phase without exposing a provider/model override', async () => {
  const configured = structuredClone(policy);
  configured.roles.deep = [
    { provider: 'deep-shared', model: 'flash', effort: 'max', privacy: 'private-safe' },
    { provider: 'deep-shared', model: 'full', effort: 'max', privacy: 'private-safe' },
    { provider: 'deep-independent', model: 'judge', effort: 'xhigh', privacy: 'private-safe' },
  ];
  const childHandlers = new Map();
  const localAgent = {
    ctx: { on: (event, handler) => { childHandlers.set(event, handler); return () => {}; } },
    session: { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] },
    options: { provider: 'deep-shared', model: 'flash' },
  };
  const subagents = {
    start: async () => ({ id: 'deep-child', localAgent, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} }),
  };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(configured));
  const envelope = await dispatch.start({ ...input('run-1:deep-escalation'), role: 'deep', subagents });
  await envelope.run.result;

  const escalated = await envelope.escalate('verification_failed');
  assert.equal(escalated.finalProvider, 'deep-shared');
  assert.equal(escalated.finalModel, 'full');
  assert.match(escalated.fallbackReason, /quality_escalation:verification_failed/u);

  const assembled = await childHandlers.get('system-prompt/assemble')({}, {}, async () => ({ variables: {} }));
  assert.equal(assembled.variables.provider, 'deep-shared');
  assert.equal(assembled.variables.model, 'full');
});

test('a successful route is sticky within a phase and a fallback route remains sticky after failover', async () => {
  const first = dispatchWith(['completed', 'completed', 'completed']);
  const one = await first.start('run-1:sticky');
  await one.run.result;
  const two = await first.start('run-1:sticky');
  await two.run.result;
  assert.deepEqual(first.calls.map(call => call.request.agentOptions.provider), ['balanced-1', 'balanced-1']);

  const fallback = dispatchWith([{ status: 429 }, 'completed', 'completed']);
  const failedOver = await fallback.start('run-1:fallback-sticky');
  await failedOver.run.result;
  const later = await fallback.start('run-1:fallback-sticky');
  await later.run.result;
  assert.deepEqual(fallback.calls.map(call => call.request.agentOptions.provider), ['balanced-1', 'balanced-2', 'balanced-2']);
});

test('concurrent starts observe the same post-failure route without reopening the failed circuit', async () => {
  const { calls, start } = dispatchWith([{ status: 504 }, 'completed', 'completed']);
  const envelopes = await Promise.all([start('run-1:concurrent'), start('run-1:concurrent')]);
  await Promise.all(envelopes.map(envelope => envelope.run.result));
  const telemetry = await Promise.all(envelopes.map(envelope => envelope.telemetry));
  assert.deepEqual(calls.map(call => call.request.agentOptions.provider), ['balanced-1', 'balanced-2', 'balanced-2']);
  assert.deepEqual(telemetry.map(item => item.finalProvider), ['balanced-2', 'balanced-2']);
});

test('all provider candidates are attempted at most once per phase and then exhaust', async () => {
  const { calls, start } = dispatchWith([{ status: 401 }, { status: 402 }, new Error('unknown model')]);
  const envelope = await start('run-1:exhaust');
  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'error' });
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.circuitState, 'open');
  assert.equal(telemetry.failureClassification, 'model_unavailable');
  assert.deepEqual(calls.map(call => call.request.agentOptions.provider), ['balanced-1', 'balanced-2', 'balanced-3']);
});

test('all-route temporary rate limit waits for cooldown and resumes the same phase instead of exhausting', async () => {
  const calls = [];
  let sequence = 0;
  const subagents = {
    start: async (_provider, request) => {
      calls.push(request.agentOptions.provider);
      sequence += 1;
      if (sequence === 1) throw { status: 402, message: 'balance exhausted' };
      if (sequence === 2 || sequence === 3) throw { status: 429, message: 'rate limited' };
      return { id: 'recovered', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const resolver = new ModelPolicyResolver(policy, { circuitTtlMs: 20 });
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver);
  const envelope = await dispatch.start({ ...input('run-1:rate-limit-wait'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls, ['balanced-1', 'balanced-2', 'balanced-3', 'balanced-2']);
  assert.equal(telemetry.rateLimitRecoveryWaits, 1);
  assert.ok(telemetry.rateLimitRecoveryWaitMs >= 1);
  assert.equal(telemetry.finalProvider, 'balanced-2');
});

test('rate-limit recovery is hard-capped after one cooldown cycle', async () => {
  const calls = [];
  const subagents = {
    start: async (_provider, request) => {
      calls.push(request.agentOptions.provider);
      throw { status: 429, message: 'rate limited' };
    },
  };
  const resolver = new ModelPolicyResolver(policy, { circuitTtlMs: 5 });
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver);
  const envelope = await dispatch.start({ ...input('run-1:bounded-rate-recovery'), subagents });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'error' });
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.rateLimitRecoveryWaits, 1);
  assert.equal(telemetry.rateLimitRecoveryCapped, true);
  assert.equal(calls.length, 6, 'three candidates are tried once, then exactly one cooldown retry cycle');
  assert.deepEqual(telemetry.attempts.map((attempt) => attempt.attempt), [1, 2, 3, 4, 5, 6], 'published route ordinals remain chronological across cooldown recovery');
});

test('zero-delay provider 429s do not burn the global route-attempt cap', async () => {
  let calls = 0;
  const resolver = new ModelPolicyResolver(policy, { circuitTtlMs: 1 });
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver);
  const envelope = await dispatch.start({
    ...input('run-1:attempt-cap'),
    subagents: {
      start: async () => {
        calls += 1;
        throw { status: 429, message: '{"retryDelay":"0ms","code":429}' };
      },
    },
  });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'error' });
  const telemetry = await envelope.telemetry;
  assert.equal(calls, 6, 'three candidates are tried once, then exactly one bounded cooldown recovery cycle');
  assert.equal(telemetry.attempts.length, 6);
  assert.deepEqual(telemetry.attempts.map((attempt) => attempt.attempt), [1, 2, 3, 4, 5, 6]);
  assert.equal(telemetry.rateLimitRecoveryWaits, 1);
  assert.equal(telemetry.rateLimitRecoveryCapped, true);
  assert.equal(telemetry.routeAttemptCapped, undefined);
});

test('resource guard cancels a child at the configured fresh-token limit without provider fallback', async () => {
  const handlers = new Map();
  let cancelled;
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const session = { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] };
  const localAgent = {
    ctx: {
      on: (event, handler) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    },
    session,
    options: { provider: 'balanced-1', model: 'balanced-a' },
    cancel: reason => { cancelled = reason; },
  };
  const subagents = {
    start: async () => ({ id: 'guarded', localAgent, result, dispose: async () => {} }),
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(policy),
    { enabled: true, maxFreshTokens: 500, maxLlmCalls: 100 },
  );
  const envelope = await dispatch.start({ ...input('run-1:resource-guard'), subagents });
  const observe = handlers.get('session/event');
  observe(session, { type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 50 } } });
  observe(session, { type: 'assistant/message', data: { usage: { inputTokens: 140, outputTokens: 10 } } });
  assert.deepEqual(cancelled, { kind: 'hook', reason: 'iw-dsh-workflow-dispatch resource guard: fresh_tokens' });
  release({ output: [{ type: 'text', text: 'late result' }], stopReason: 'completed' });

  const outcome = await envelope.run.result;
  assert.equal(outcome.stopReason, 'error');
  assert.match(outcome.diagnostic, /^resource_guard_exceeded:fresh_tokens:fresh_tokens=500:llm_calls=2$/u);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.attempts.length, 1, 'resource guard is terminal for the task and does not burn fallback routes');
  assert.deepEqual(telemetry.resourceGuard, {
    enabled: true,
    maxFreshTokens: 500,
    maxLlmCalls: 100,
    freshTokens: 500,
    llmCalls: 2,
    tripped: true,
    reason: 'fresh_tokens',
  });
});

test('resource guard preserves a naturally completed final response that reaches the fresh-token limit', async () => {
  const handlers = new Map();
  let cancelled;
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const session = { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] };
  const localAgent = {
    ctx: { on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } },
    session,
    options: { provider: 'balanced-1', model: 'balanced-a' },
    cancel: reason => { cancelled = reason; },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(policy),
    { enabled: true, maxFreshTokens: 500, maxLlmCalls: 100 },
  );
  const envelope = await dispatch.start({ ...input('run-1:terminal-resource-guard'), subagents: { start: async () => ({ id: 'terminal-guarded', localAgent, result, dispose: async () => {} }) } });
  const observe = handlers.get('session/event');
  observe(session, {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 450, outputTokens: 50 },
      message: { source: { kind: 'model', replayState: { response: { stopReason: 'stop' } } } },
    },
  });
  assert.equal(cancelled, undefined, 'a natural terminal response is already complete and must not be cancelled retroactively');
  release({ output: [{ type: 'text', text: 'final answer' }], stopReason: 'completed' });

  const outcome = await envelope.run.result;
  assert.deepEqual(outcome, { output: [{ type: 'text', text: 'final answer' }], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.resourceGuard?.tripped, true, 'budget exhaustion is still observable in telemetry');
  assert.equal(telemetry.resourceGuard?.reason, 'fresh_tokens');
});

test('resource guard cancels if work continues after a protected terminal-at-limit response', async () => {
  const handlers = new Map();
  let cancelled;
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const session = { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] };
  const localAgent = {
    ctx: { on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } },
    session,
    options: { provider: 'balanced-1', model: 'balanced-a' },
    cancel: reason => { cancelled = reason; },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(policy),
    { enabled: true, maxFreshTokens: 500, maxLlmCalls: 100 },
  );
  const envelope = await dispatch.start({ ...input('run-1:continued-after-terminal-guard'), subagents: { start: async () => ({ id: 'continued-terminal-guarded', localAgent, result, dispose: async () => {} }) } });
  const observe = handlers.get('session/event');
  observe(session, {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 450, outputTokens: 50 },
      message: { source: { kind: 'model', replayState: { response: { stopReason: 'stop' } } } },
    },
  });
  assert.equal(cancelled, undefined);
  observe(session, { type: 'step/start', data: { turn: 1, step: 2 } });
  assert.deepEqual(cancelled, { kind: 'hook', reason: 'iw-dsh-workflow-dispatch resource guard: fresh_tokens' });
  release({ output: [], stopReason: 'error' });

  const outcome = await envelope.run.result;
  assert.match(outcome.diagnostic, /^resource_guard_exceeded:fresh_tokens:/u);
});

test('resource guard cancels a child at the configured LLM-call limit', async () => {
  const handlers = new Map();
  let cancelled = 0;
  let release;
  const result = new Promise(resolve => { release = resolve; });
  const session = { header: { origin: 'subagent', parentSession: 'parent-1' }, events: [] };
  const localAgent = {
    ctx: { on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } },
    session,
    options: { provider: 'balanced-1', model: 'balanced-a' },
    cancel: () => { cancelled += 1; },
  };
  const dispatch = new WorkflowDispatch(
    { on: () => () => {} },
    new ModelPolicyResolver(policy),
    { enabled: true, maxFreshTokens: 999_999, maxLlmCalls: 2 },
  );
  const envelope = await dispatch.start({ ...input('run-1:call-guard'), subagents: { start: async () => ({ id: 'call-guarded', localAgent, result, dispose: async () => {} }) } });
  const observe = handlers.get('session/event');
  observe(session, { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 1 } } });
  observe(session, { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 1 } } });
  observe(session, { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 1 } } });
  assert.equal(cancelled, 1, 'guard trips once and does not repeatedly cancel');
  release({ output: [], stopReason: 'completed' });
  const outcome = await envelope.run.result;
  assert.match(outcome.diagnostic, /^resource_guard_exceeded:llm_calls:/u);
});

test('a new phase waits for an existing rate-limit circuit instead of cascading routing exhaustion', async () => {
  const resolver = new ModelPolicyResolver(policy, { circuitTtlMs: 20 });
  resolver.recordFailure({ role: 'balanced', phaseKey: 'prior-phase', index: 0, classification: 'rate_limit:http_429' });
  resolver.recordFailure({ role: 'balanced', phaseKey: 'prior-phase', index: 1, classification: 'quota_exhausted' });
  resolver.recordFailure({ role: 'balanced', phaseKey: 'prior-phase', index: 2, classification: 'auth_unavailable' });
  const calls = [];
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver);
  const envelope = await dispatch.start({
    ...input('next-phase'),
    subagents: {
      start: async (_provider, request) => {
        calls.push(request.agentOptions.provider);
        return { id: 'new-phase-recovered', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
      },
    },
  });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  const telemetry = await envelope.telemetry;
  assert.deepEqual(calls, ['balanced-1']);
  assert.equal(telemetry.rateLimitRecoveryWaits, 1);
  assert.equal(telemetry.finalProvider, 'balanced-1');
});

test('deep browser priority falls back to original provider order when browser is busy', async () => {
  const calls = [];
  let sequence = 0;
  const subagents = {
    start: async (provider, request) => {
      calls.push(provider === 'browser-chat'
        ? ['browser-chat', 'gemini-3.8-flash-ui']
        : [request.agentOptions.provider, request.agentOptions.model]);
      if (provider === 'browser-chat') {
        return { id: 'browser-busy', result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)' }), dispose: async () => {} };
      }
      sequence += 1;
      if (sequence === 1) throw new Error('unknown model');
      if (sequence === 2) throw { status: 402, message: 'balance exhausted' };
      return { id: 'judge', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const resolver = new ModelPolicyResolver(loadModelPolicy(), { now: () => Date.UTC(2026, 8, 3, 0, 0, 0) });
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, resolver);
  const envelope = await dispatch.start({
    role: 'deep',
    phaseKey: 'run-gemini-only:deep',
    provider: 'spawn',
    request: { parent: { session: { header: { id: 'parent-gemini-only' } } }, toolFilter: { allow: [] } },
    subagents,
  });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.deepEqual(calls, [
    ['browser-chat', 'gemini-3.8-flash-ui'],
    ['opencode-zen', 'muse-spark-1.3-contributor-free'],
    ['orcarouter', 'deepseek/deepseek-v4-flash-free'],
    ['aihubmix', 'coding-glm-5.3-free'],
  ]);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.finalProvider, 'aihubmix');
  assert.equal(telemetry.finalModel, 'coding-glm-5.3-free');
});

test('deep provider exhaustion reaches Codex as the final independent fallback', async () => {
  const calls = [];
  let sequence = 0;
  const subagents = {
    start: async (provider, request) => {
      calls.push(provider === 'browser-chat'
        ? ['browser-chat', 'gemini-3.8-flash-ui']
        : [request.agentOptions.provider, request.agentOptions.model]);
      if (provider === 'browser-chat') {
        return {
          id: 'browser-busy',
          result: Promise.resolve({ output: [], stopReason: 'error', diagnostic: 'capacity_busy: browser-chat bridge failure (stage: turn; status: BUSY)' }),
          dispose: async () => {},
        };
      }
      sequence += 1;
      if (sequence === 1) throw new Error('unknown model');
      if (sequence === 2) throw new Error('unknown model');
      if (sequence === 3) throw new Error('unknown model');
      if (sequence === 4) throw new Error('unknown model');
      if (sequence === 5) throw new Error('unknown model');
      if (sequence === 6) throw { status: 402, message: 'balance exhausted' };
      if (sequence === 7) throw { status: 402, message: 'balance exhausted' };
      return { id: 'codex', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
    },
  };
  const dispatch = new WorkflowDispatch({ on: () => () => {} }, new ModelPolicyResolver(loadModelPolicy()));
  const envelope = await dispatch.start({
    role: 'deep',
    phaseKey: 'run-gemini-emergency:deep',
    provider: 'spawn',
    request: { parent: { session: { header: { id: 'parent-gemini-emergency' } } }, toolFilter: { allow: [] } },
    subagents,
  });

  assert.deepEqual(await envelope.run.result, { output: [], stopReason: 'completed' });
  assert.deepEqual(calls, [
    ['browser-chat', 'gemini-3.8-flash-ui'],
    ['opencode-zen', 'muse-spark-1.3-contributor-free'],
    ['orcarouter', 'deepseek/deepseek-v4-flash-free'],
    ['aihubmix', 'coding-glm-5.3-free'],
    ['aihubmix', 'coding-glm-5.3-flash'],
    ['aihubmix', 'glm-5.3-flash'],
    ['aihubmix', 'coding-glm-5.3'],
    ['google', 'gemini-3.8-flash'],
    ['openai-codex', 'gpt-5.6-sol'],
  ]);
  const telemetry = await envelope.telemetry;
  assert.equal(telemetry.finalProvider, 'openai-codex');
  assert.equal(telemetry.finalModel, 'gpt-5.6-sol');
});
