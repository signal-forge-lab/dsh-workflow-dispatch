import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, loadModelPolicy } from './index.js';

const policy = loadModelPolicy();
const routes = Object.values(policy.roles).flat();
const providers = [...new Set(routes.map(route => route.provider))];

test('isolated Cordis runtime smoke proves registration, preflight, fallback, sticky route, and telemetry', async () => {
  const registered = [];
  const ctx = new Context();
  ctx.provide('dynamicWorkflows', {
    registerDispatchAdapter(adapter) {
      registered.push(adapter);
      return () => {};
    },
  });
  ctx.provide('llm', {
    listProviders: () => providers.map(id => ({ id, name: id })),
    listModels: async provider => routes.filter(route => route.provider === provider).map(route => ({ provider, id: route.model, name: route.model })),
  });
  apply(ctx, {
    freeQuotaRules: [],
    usageAdmission: { enabled: false },
    artifactBridge: { enabled: false },
  });
  assert.equal(registered.length, 1);

  const calls = [];
  let sequence = 0;
  const subagents = {
    start: async (transport, request) => {
      calls.push({ transport, request });
      sequence += 1;
      if (sequence === 1) throw { status: 429 };
      return {
        id: `isolated-${sequence}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'smoke complete' }], stopReason: 'completed' }),
        dispose: async () => {},
      };
    },
  };
  const request = { parent: { session: { header: { id: 'runtime-parent' } } }, prompt: [] };
  const adapter = registered[0];
  const first = await adapter.start({ role: 'balanced', phase: 'smoke', phaseKey: 'runtime-smoke:phase', sensitivity: 'public', subagentProvider: 'spawn', request, subagents });
  assert.deepEqual(await first.run.result, { output: [{ type: 'text', text: 'smoke complete' }], stopReason: 'completed' });
  const telemetry = await first.telemetry;
  assert.equal(telemetry.phase, 'smoke');
  assert.equal(telemetry.phaseKey, 'runtime-smoke:phase');
  assert.equal(telemetry.sensitivity, 'public');
  assert.equal(telemetry.role, 'balanced');
  assert.equal(telemetry.attempt, 2);
  assert.equal(telemetry.fallbackReason, 'rate_limit:http_429');
  assert.equal(telemetry.finalProvider, policy.roles.balanced[1].provider);
  assert.equal(telemetry.finalModel, policy.roles.balanced[1].model);
  assert.equal(telemetry.circuitState, 'closed');
  assert.equal(telemetry.candidateChain.length, policy.roles.balanced.length);

  const second = await adapter.start({ role: 'balanced', phase: 'smoke', phaseKey: 'runtime-smoke:phase', sensitivity: 'public', subagentProvider: 'spawn', request, subagents });
  await second.run.result;
  const secondTelemetry = await second.telemetry;
  assert.equal(secondTelemetry.finalProvider, policy.roles.balanced[1].provider);
  assert.deepEqual(calls.map(call => [call.transport, call.request.agentOptions.provider, call.request.agentOptions.model]), [
    ['spawn', policy.roles.balanced[0].provider, policy.roles.balanced[0].model],
    ['spawn', policy.roles.balanced[1].provider, policy.roles.balanced[1].model],
    ['spawn', policy.roles.balanced[1].provider, policy.roles.balanced[1].model],
  ]);
  await ctx.fiber.dispose();
});
