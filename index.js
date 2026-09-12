import z from '@deepseek-ai/schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { FreeQuotaGuard } from './free-quota-guard.js';
import { ModelCapacityLeaseManager } from './model-capacity.js';
import { ModelPolicyResolver, modelRouteKey } from './model-policy.js';
import { CodexBarUsageAdmission } from './usage-admission.js';
import { ArtifactBridge } from './artifact-bridge.js';

export const name = 'iw-dsh-workflow-dispatch';
export const inject = ['dynamicWorkflows', 'llm', 'subagents', 'tools'];

const FreeQuotaRuleSchema = z.object({
  provider: z.string(),
  group: z.string(),
  models: z.array(z.string()),
  safetyLimit: z.natural(),
  defaultMaxTokensReserve: z.natural().default(32768),
  rejectTools: z.boolean().default(true),
  rejectImages: z.boolean().default(true),
});

const ResourceGuardSchema = z.object({
  enabled: z.boolean().default(true),
  maxFreshTokens: z.natural().min(1).default(500_000),
  maxLlmCalls: z.natural().min(1).default(100),
});

const RoutingProbeSchema = z.object({
  enabled: z.boolean().default(true),
  toolName: z.string().default('routing_probe'),
  maxCandidates: z.natural().min(1).default(8),
  defaultMaxTokens: z.natural().min(1).default(64),
  browserChatWorkspaceRoundTrip: z.boolean().default(true),
});

const UsageAdmissionSchema = z.object({
  enabled: z.boolean().default(true),
  minRemainingPercent: z.natural().default(0),
  providerUsageLimits: z.array(z.object({
    provider: z.string(),
    maxUsedPercent: z.natural().max(100),
  })).default([{ provider: 'gemini-api', maxUsedPercent: 90 }]),
  refreshMs: z.natural().min(1000).default(60_000),
  timeoutSeconds: z.natural().min(1).default(12),
});

const ArtifactBridgeSchema = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.natural().min(1).default(2000),
});

export const Config = z.object({
  freeQuotaRules: z.array(FreeQuotaRuleSchema).default([]),
  passthroughSubagentProviders: z.array(z.string()).default(['browser-chat']),
  resourceGuard: ResourceGuardSchema.default({}),
  routingProbe: RoutingProbeSchema.default({}),
  usageAdmission: UsageAdmissionSchema.default({ enabled: true, minRemainingPercent: 0, providerUsageLimits: [{ provider: 'gemini-api', maxUsedPercent: 90 }], refreshMs: 60_000, timeoutSeconds: 12 }),
  artifactBridge: ArtifactBridgeSchema.default({ enabled: true, maxFiles: 2000 }),
});

const MAX_RATE_LIMIT_RECOVERY_WAITS = 1;
const MAX_RATE_LIMIT_RECOVERY_WAIT_MS = 5 * 60_000;
const MAX_ROUTE_ATTEMPTS = 16;
const AIHUBMIX_NO_CHANNEL_RETRY_MS = 20_000;
const execFileAsync = promisify(execFile);
const ROUTING_PROBE_FILE = 'routing-probe.txt';
const ROUTING_PROBE_INPUT_PREFIX = 'WORKSPACE_INPUT_';
const ROUTING_PROBE_OUTPUT_PREFIX = 'WORKSPACE_OUTPUT_';

function boundedExhaustion(message) {
  const error = new Error(message);
  error.code = 'bounded_exhaustion';
  return error;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function safeCode(value) {
  return normalize(value).replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80);
}

function isInactiveContextError(error) {
  return error instanceof Error && /cannot create effect on inactive context/iu.test(error.message);
}

function retryInfoDelayMs(message) {
  const text = message.replaceAll('\\"', '"');
  const match = text.match(/"retrydelay"\s*:\s*"([0-9]+(?:\.[0-9]+)?)(ms|s)"/u)
    ?? text.match(/retry\s+in\s+([0-9]+(?:\.[0-9]+)?)(ms|s)\b/u);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(match[2] === 's' ? value * 1000 : value);
}

export function failureEvidence(failure) {
  if (failure == null) return undefined;
  const message = normalize(failure instanceof Error ? failure.message : failure.message ?? failure);
  const normalizedMessage = message.replaceAll('\\"', '"');
  const status = Number(failure.status);
  const embeddedStatus = Number(normalizedMessage.match(/"code"\s*:\s*([1-5][0-9]{2})/u)?.[1]);
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : Number.isInteger(embeddedStatus) ? embeddedStatus : undefined;
  const embeddedCode = normalizedMessage.match(/"code"\s*:\s*"([^"\\]+)"/u)?.[1];
  const code = safeCode(failure.code ?? embeddedCode);
  const retryAfterMs = retryInfoDelayMs(message);
  const haystack = `${code} ${message}`;
  if (/generated.?code.?failure|test.?failure|validator.?failure|review.?failure|logic.?failure|low.?quality|quality.?failure/.test(haystack)) return undefined;
  let classification;
  const explicitClassification = haystack.match(/\b(capacity_busy|rate_limit|quota_exhausted|balance_exhausted|auth_unavailable|model_unavailable|transient_provider_error)\b/u)?.[1];
  if (explicitClassification !== undefined) {
    classification = explicitClassification;
  } else if (retryAfterMs !== undefined && (httpStatus === 429 || /quota|rate.?limit|resource.?exhausted|too.?many/.test(haystack))) {
    classification = 'rate_limit';
  } else if (/quota|usage.?limit|token.?limit|token.?quota|insufficient.?tokens?|free.?quota.?guard/.test(haystack)) {
    classification = 'quota_exhausted';
  } else if (httpStatus === 402 || /insufficient.?(balance|credit)|billing|payment.?required|balance.?exhaust|credit.?exhaust/.test(haystack)) {
    classification = 'balance_exhausted';
  } else if ([401, 403].includes(httpStatus) || /auth|credential|unauthor|forbid|invalid.?key/.test(haystack)) {
    classification = 'auth_unavailable';
  } else if (httpStatus === 404 || /no.?adapter|unknown.?model|model.?not.?found|unsupported.?reasoning|function tools with reasoning_effort are not supported/.test(haystack)) {
    classification = 'model_unavailable';
  } else if (httpStatus === 429 || /rate.?limit|too.?many/.test(haystack)) {
    classification = 'rate_limit';
  } else if ([408, 409, 425].includes(httpStatus) || (httpStatus !== undefined && httpStatus >= 500) || /timeout|network|transport|provider.*unavailable|unavailable.*provider|no.?available.?channel|current.?model.?cannot.?be.?routed|overload|capacity|connection|temporar/.test(haystack)) {
    classification = 'transient_provider_error';
  }
  if (!classification) return undefined;
  return { classification, ...(httpStatus === undefined ? {} : { httpStatus }), ...(code ? { code } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function formatFailureEvidence(evidence) {
  if (!evidence) return undefined;
  return [evidence.classification, evidence.httpStatus === undefined ? undefined : `http_${evidence.httpStatus}`, evidence.code ? `code_${evidence.code}` : undefined].filter(Boolean).join(':');
}

export function classifyFailure(failure) {
  return formatFailureEvidence(failureEvidence(failure));
}

export function classifyStartError(error) {
  return classifyFailure(error);
}

class StartGate {
  tail = Promise.resolve();

  async run(fn) {
    const previous = this.tail.catch(() => {});
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function phaseKeyFor(input) {
  if (input.phaseKey !== undefined) return input.phaseKey;
  const parent = input.request.parent?.session?.header?.id;
  return `${parent ?? 'unscoped'}:${input.phase ?? 'default'}`;
}

function isMatchingChild(agent, parent, target) {
  const header = agent.session?.header;
  return header?.origin === 'subagent' && header?.parentSession === parent.session?.header?.id && normalize(agent.options?.provider) === normalize(target.provider) && normalize(agent.options?.model) === normalize(target.model);
}

function isNaturalTerminalAssistantMessage(event) {
  return event?.type === 'assistant/message'
    && event.data?.message?.source?.kind === 'model'
    && event.data?.message?.source?.replayState?.response?.stopReason === 'stop';
}

function attachSelection(agent, target, resourceGuard) {
  const ref = { current: { provider: target.provider, model: target.model, reasoningEffort: target.effort }, assembled: undefined };
  let disposeSelection = () => {};
  let disposeRequestFailure = () => {};
  let disposeAgentError = () => {};
  let disposeResourceGuard = () => {};
  let lastFailure;
  let completedAtLimit = false;
  const guard = {
    enabled: resourceGuard.enabled,
    maxFreshTokens: resourceGuard.maxFreshTokens,
    maxLlmCalls: resourceGuard.maxLlmCalls,
    freshTokens: 0,
    llmCalls: 0,
    tripped: false,
    reason: undefined,
  };
  const cancelForGuard = () => {
    completedAtLimit = false;
    agent.cancel?.({ kind: 'hook', reason: `iw-dsh-workflow-dispatch resource guard: ${guard.reason}` });
  };
  try {
    disposeSelection = installModelSelection(agent.ctx, ref);
    disposeRequestFailure = agent.ctx.on('agent/request-error', async (payload, next) => {
      lastFailure = payload.failure;
      if (failureEvidence(payload.failure)?.classification === 'rate_limit') return undefined;
      return await next();
    });
    disposeAgentError = agent.ctx.on('agent/error', payload => { lastFailure = payload.error; });
    disposeResourceGuard = agent.ctx.on('session/event', (session, event) => {
      if (!guard.enabled || session !== agent.session) return;
      if (guard.tripped) {
        if (completedAtLimit && event?.type === 'step/start') cancelForGuard();
        return;
      }
      if (event?.type !== 'assistant/message') return;
      const usage = event.data?.usage;
      guard.llmCalls += 1;
      guard.freshTokens += Math.max(0, Number(usage?.inputTokens) || 0) + Math.max(0, Number(usage?.outputTokens) || 0);
      if (guard.freshTokens < guard.maxFreshTokens && guard.llmCalls < guard.maxLlmCalls) return;
      guard.tripped = true;
      guard.reason = guard.freshTokens >= guard.maxFreshTokens ? 'fresh_tokens' : 'llm_calls';
      if (isNaturalTerminalAssistantMessage(event)) {
        completedAtLimit = true;
        return;
      }
      cancelForGuard();
    });
  } catch (error) {
    disposeResourceGuard();
    disposeAgentError();
    disposeRequestFailure();
    disposeSelection();
    if (isInactiveContextError(error)) return undefined;
    throw error;
  }
  return {
    failure: () => lastFailure,
    guard: () => ({ ...guard }),
    allowsCompletedOutcome: () => completedAtLimit,
    setTarget(next) {
      ref.current = { provider: next.provider, model: next.model, reasoningEffort: next.effort };
    },
    dispose() {
      disposeResourceGuard();
      disposeAgentError();
      disposeRequestFailure();
      disposeSelection();
    },
  };
}

function manageRun(run, attachment, lease) {
  let disposed = false;
  let leaseReleased = false;
  const releaseLease = async () => {
    if (leaseReleased) return;
    leaseReleased = true;
    await lease?.release();
  };
  const result = Promise.resolve(run.result).finally(releaseLease);
  return {
    id: run.id,
    get localAgent() { return run.localAgent; },
    result,
    guard: () => attachment?.guard?.(),
    guardAllowsCompletedOutcome: () => attachment?.allowsCompletedOutcome?.() === true,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await run.dispose();
      } finally {
        attachment?.dispose();
        await releaseLease();
      }
    },
  };
}

function terminalRunFailure(run, outcome) {
  const events = run.localAgent?.session?.events;
  if (Array.isArray(events)) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== 'turn/end') continue;
      const reason = event.data?.reason;
      if (reason?.kind === 'error') return reason.error ?? { message: 'child turn ended with an error' };
      break;
    }
  }
  return typeof outcome?.diagnostic === 'string' && outcome.diagnostic.trim().length > 0
    ? { message: outcome.diagnostic }
    : undefined;
}

function targetWithConstraint(selection, effort) {
  return effort === undefined || selection.target.subagentProvider !== undefined
    ? selection.target
    : { ...selection.target, effort };
}

function requestWithoutAgentOptions(request) {
  const { agentOptions: _agentOptions, ...rest } = request;
  return rest;
}

function browserChatRoute(candidate) {
  return candidate?.subagentProvider === 'browser-chat';
}

function outcomeText(outcome) {
  return (outcome?.output ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('\n');
}

function probePolicy(candidates) {
  return {
    version: 1,
    roles: {
      fast: candidates,
      balanced: candidates,
      deep: candidates,
    },
  };
}

function disabledUsageAdmission() {
  return { evaluate: async _candidates => ({ status: 'disabled', skippedRoutes: new Set(), decisions: new Array() }) };
}

function findWorkspaceContainer(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return undefined;
  let cursor = resolve(cwd);
  while (true) {
    if (existsSync(join(cursor, 'browser-chat-workspace'))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function parentWithCwd(parent, cwd) {
  const wrapped = Object.create(parent ?? null);
  const originalSession = parent?.session;
  const session = Object.create(originalSession ?? null);
  Object.defineProperty(session, 'header', {
    value: { ...(originalSession?.header ?? {}), cwd },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(wrapped, 'session', { value: session, enumerable: true, configurable: true });
  return wrapped;
}

async function createBrowserWorkspaceProbe(parent, artifactBridge) {
  const currentCwd = parent?.session?.header?.cwd;
  const root = artifactBridge?.workspaceRoot === undefined
    ? findWorkspaceContainer(currentCwd)
    : dirname(artifactBridge.workspaceRoot);
  if (root === undefined) throw new Error('browser-chat workspace probe requires an existing browser-chat-workspace ancestor or an explicit ArtifactBridge workspaceRoot');
  const fixtureBase = join(root, '.dsh-routing-probe');
  await mkdir(fixtureBase, { recursive: true });
  const sourceRoot = await mkdtemp(join(fixtureBase, 'source-'));
  const suffix = randomUUID().replace(/-/gu, '');
  const inputText = `${ROUTING_PROBE_INPUT_PREFIX}${suffix}\n`;
  const expectedText = `${ROUTING_PROBE_OUTPUT_PREFIX}${suffix}\n`;
  try {
    await writeFile(join(sourceRoot, ROUTING_PROBE_FILE), inputText, 'utf8');
    await execFileAsync('git', ['init', '--quiet'], { cwd: sourceRoot, windowsHide: true });
    await execFileAsync('git', ['add', ROUTING_PROBE_FILE], { cwd: sourceRoot, windowsHide: true });
    return {
      sourceRoot,
      parent: parentWithCwd(parent, sourceRoot),
      inputText,
      expectedText,
      prompt: `Read ${ROUTING_PROBE_FILE} from the provided DSH file workspace. Replace only the prefix ${ROUTING_PROBE_INPUT_PREFIX} with ${ROUTING_PROBE_OUTPUT_PREFIX}, preserving the exact suffix you actually read from the file. Make no other change.`,
    };
  } catch (error) {
    await rm(sourceRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function createRoutingProbeTool(ctx, config = {}, usageAdmission = disabledUsageAdmission(), artifactBridge = new ArtifactBridge({ enabled: false })) {
  const enabled = config.enabled === true;
  const maxCandidates = Math.max(1, Number(config.maxCandidates) || 8);
  const defaultMaxTokens = Math.max(1, Number(config.defaultMaxTokens) || 64);
  const toolName = String(config.toolName ?? 'routing_probe');
  const browserChatWorkspaceRoundTrip = config.browserChatWorkspaceRoundTrip !== false;
  return {
    name: toolName,
    description: 'Test an explicit provider/model candidate chain. Browser Chat candidates require a staged workspace read/patch/apply round trip by default; other candidates use a minimal text probe. Test-only: does not change Stable Routing policy or circuits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        candidates: {
          type: 'array',
          minItems: 1,
          maxItems: maxCandidates,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
              privacy: { type: 'string', enum: ['public-only', 'private-safe'] },
              subagentProvider: { type: 'string' },
            },
            required: ['provider', 'model', 'effort', 'privacy'],
          },
        },
        prompt: { type: 'string' },
        expected: { type: 'string' },
        role: { type: 'string', enum: ['fast', 'balanced', 'deep'] },
        maxTokens: { type: 'integer', minimum: 1, maximum: 512 },
      },
      required: ['candidates'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args, exec) {
      if (!enabled) throw new Error('routing probe is disabled');
      if (!Array.isArray(args.candidates) || args.candidates.length < 1 || args.candidates.length > maxCandidates) {
        throw new Error(`routing probe requires 1 to ${maxCandidates} candidates`);
      }
      if (!exec?.agent) throw new Error('routing probe requires an active parent agent');
      const role = args.role ?? 'balanced';
      const prompt = args.prompt ?? 'Reply exactly: ROUTING_PROBE_OK';
      const expected = args.expected ?? 'ROUTING_PROBE_OK';
      const maxTokens = Math.min(512, Math.max(1, Number(args.maxTokens) || defaultMaxTokens));
      const candidates = args.candidates.map(candidate => ({ ...candidate }));
      const requiresWorkspaceRoundTrip = browserChatWorkspaceRoundTrip && candidates.some(browserChatRoute);
      const workspaceProbe = requiresWorkspaceRoundTrip ? await createBrowserWorkspaceProbe(exec.agent, artifactBridge) : undefined;
      const resolver = new ModelPolicyResolver(() => probePolicy(candidates), { routeValidator: routeValidatorFor(ctx) });
      const dispatch = new WorkflowDispatch(
        ctx,
        resolver,
        { enabled: true, maxFreshTokens: 16_384, maxLlmCalls: 4 },
        new ModelCapacityLeaseManager(),
        [],
        sleep,
        usageAdmission,
        artifactBridge,
      );
      const probeParent = workspaceProbe?.parent ?? exec.agent;
      const probePrompt = workspaceProbe?.prompt ?? prompt;
      const envelope = await dispatch.start({
        role,
        phase: 'routing-probe',
        phaseKey: `routing-probe:${exec.agent.session?.header?.id ?? 'unscoped'}:${Date.now()}`,
        provider: 'spawn',
        sensitivity: 'public',
        subagents: ctx.subagents,
        request: {
          parent: probeParent,
          signal: exec.signal ?? new AbortController().signal,
          prompt: [{ type: 'text', text: probePrompt }],
          ...(workspaceProbe === undefined ? { toolFilter: { allow: [] } } : {}),
          agentOptions: { maxTokens },
        },
      });
      try {
        const outcome = await envelope.run.result;
        const telemetry = await envelope.telemetry;
        const responseText = outcomeText(outcome);
        const workspaceActual = workspaceProbe === undefined
          ? undefined
          : await readFile(join(workspaceProbe.sourceRoot, ROUTING_PROBE_FILE), 'utf8').catch(() => undefined);
        const workspacePassed = workspaceProbe === undefined
          ? undefined
          : (telemetry.finalProvider ?? telemetry.provider) === 'browser-chat'
            && workspaceActual?.replace(/\r\n?/gu, '\n') === workspaceProbe.expectedText;
        const probeCompleted = outcome.stopReason === 'completed' && (workspacePassed ?? true);
        return {
          status: probeCompleted ? 'completed' : 'error',
          childId: envelope.run.id,
          responseText,
          responseMatched: workspaceProbe === undefined ? responseText.trim() === expected.trim() : workspacePassed,
          ...(workspaceProbe === undefined ? {} : {
            browserChatWorkspaceRoundTrip: {
              required: true,
              passed: workspacePassed,
              file: ROUTING_PROBE_FILE,
              inputPrefix: ROUTING_PROBE_INPUT_PREFIX,
              outputPrefix: ROUTING_PROBE_OUTPUT_PREFIX,
            },
          }),
          candidateChain: telemetry.candidateChain ?? candidates,
          attempts: telemetry.attempts ?? [],
          ...(telemetry.initialProvider === undefined ? {} : { initialProvider: telemetry.initialProvider }),
          ...(telemetry.initialModel === undefined ? {} : { initialModel: telemetry.initialModel }),
          ...((telemetry.finalProvider ?? telemetry.provider) === undefined ? {} : { finalProvider: telemetry.finalProvider ?? telemetry.provider }),
          ...((telemetry.finalModel ?? telemetry.model) === undefined ? {} : { finalModel: telemetry.finalModel ?? telemetry.model }),
          fallbackReason: telemetry.fallbackReason ?? '',
          usageAdmission: telemetry.usageAdmission,
          ...(telemetry.failureClassification === undefined ? {} : { failureClassification: telemetry.failureClassification }),
          ...(telemetry.durationMs === undefined ? {} : { durationMs: telemetry.durationMs }),
        };
      } finally {
        await envelope.run.dispose();
        if (workspaceProbe !== undefined) await rm(workspaceProbe.sourceRoot, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export class WorkflowDispatch {
  capacityManager;
  passthroughSubagentProviders;
  usageAdmission;
  artifactBridge;

  constructor(ctx, resolver, resourceGuard = {}, capacityManager = new ModelCapacityLeaseManager(), passthroughSubagentProviders = [], sleepFn = sleep, usageAdmission = disabledUsageAdmission(), artifactBridge = new ArtifactBridge({ enabled: false })) {
    this.ctx = ctx;
    this.resolver = resolver;
    this.gate = new StartGate();
    this.capacityManager = capacityManager;
    this.passthroughSubagentProviders = new Set(passthroughSubagentProviders);
    this.sleep = sleepFn;
    this.usageAdmission = usageAdmission;
    this.artifactBridge = artifactBridge;
    this.resourceGuard = {
      enabled: resourceGuard.enabled !== false,
      maxFreshTokens: Math.max(1, Number(resourceGuard.maxFreshTokens) || 500_000),
      maxLlmCalls: Math.max(1, Number(resourceGuard.maxLlmCalls) || 100),
    };
  }

  async startPassthrough(input, subagentProvider) {
    const startedAt = Date.now();
    const phase = input.phase ?? 'default';
    const phaseKey = phaseKeyFor(input);
    const sensitivity = input.sensitivity ?? 'public';
    const run = await input.subagents.start(subagentProvider, requestWithoutAgentOptions(input.request));
    const telemetry = Promise.resolve(run.result).then(outcome => {
      const failureClassification = outcome?.stopReason === 'error'
        ? classifyFailure(outcome?.diagnostic)
        : undefined;
      return {
        phase,
        phaseKey,
        sensitivity,
        role: input.role,
        ...(failureClassification === undefined ? {} : { failureClassification }),
        circuitState: 'closed',
        durationMs: Date.now() - startedAt,
      };
    });
    return { run, telemetry };
  }

  async startSelected(input, selectionOptions, onStartFailure, artifactPlan) {
    return await this.gate.run(async () => {
      const selection = this.resolver.selectWithOptions(
        input.role,
        phaseKeyFor(input),
        input.sensitivity ?? 'public',
        selectionOptions,
      );
      const target = targetWithConstraint(selection, input.effort);
      let attachment;
      let attachedAgent;
      let lease;
      let disposeCreated = () => {};
      try {
        const fixedTransport = target.subagentProvider !== undefined;
        const maxInFlight = fixedTransport ? undefined : this.resolver.capacityLimit(target);
        if (maxInFlight !== undefined) {
          lease = await this.capacityManager.tryAcquire(target, maxInFlight);
          if (lease === undefined) {
            throw Object.assign(new Error(`model capacity unavailable for ${target.provider}/${target.model}`), { code: 'capacity_busy' });
          }
        }
        if (!fixedTransport) {
          try {
            disposeCreated = this.ctx.on('agent/created', ({ agent }) => {
              if (attachment || !isMatchingChild(agent, input.request.parent, target)) return;
              attachedAgent = agent;
              attachment = attachSelection(agent, target, this.resourceGuard);
              disposeCreated();
            });
          } catch (error) {
            // Durable workflow runs can survive a plugin-context reload.  In
            // that case this event hook is no longer registrable, while the
            // child itself can still start and expose raw.localAgent below.
            // Suppress only this exact lifecycle error; every other failure
            // remains fail-closed.
            if (!isInactiveContextError(error)) throw error;
          }
        }
        const selectedRequest = browserChatRoute(target)
          ? this.artifactBridge.browserRequest(input.request, artifactPlan)
          : input.request;
        const request = fixedTransport
          ? requestWithoutAgentOptions(selectedRequest)
          : { ...selectedRequest, agentOptions: { ...(selectedRequest.agentOptions ?? {}), provider: target.provider, model: target.model, reasoningEffort: target.effort } };
        const raw = await input.subagents.start(target.subagentProvider ?? input.provider, request);
        disposeCreated();
        if (!fixedTransport && !attachment && raw.localAgent) {
          attachedAgent = raw.localAgent;
          attachment = attachSelection(raw.localAgent, target, this.resourceGuard);
        }
        return {
          selection,
          target,
          run: manageRun(raw, attachment, lease),
          verificationAgent: raw.localAgent ?? attachedAgent,
          failure: () => attachment?.failure(),
          setTarget: next => attachment?.setTarget(next),
        };
      } catch (error) {
        disposeCreated();
        attachment?.dispose();
        await lease?.release();
        onStartFailure?.(error, selection, target);
        throw error;
      }
    });
  }

  async start(input) {
    if (input.target !== undefined) throw new Error('iw-dsh-workflow-dispatch does not implement target-agent dispatch');
    if (!['fast', 'balanced', 'deep'].includes(input.role)) throw new Error('iw-dsh-workflow-dispatch requires role fast, balanced, or deep');
    const subagentProvider = input.subagentProvider ?? input.provider;
    if (!subagentProvider) throw new Error('iw-dsh-workflow-dispatch requires a subagent transport provider');
    if (this.passthroughSubagentProviders.has(subagentProvider)) {
      return await this.startPassthrough(input, subagentProvider);
    }
    input = { ...input, provider: subagentProvider };
    const role = input.role;
    const phase = input.phase ?? 'default';
    const phaseKey = phaseKeyFor(input);
    const sensitivity = input.sensitivity ?? 'public';
    const startedAt = Date.now();
    const retryAbort = new AbortController();
    let rateLimitRecoveryWaits = 0;
    let rateLimitRecoveryWaitMs = 0;
    let rateLimitRecoveryCapped = false;
    let routeAttemptCapped = false;
    const waitForRateLimitRecovery = async error => {
      if (error?.code !== 'bounded_exhaustion' || routeAttemptCapped) return false;
      const recovery = this.resolver.nextRateLimitRecovery(role, phaseKey, sensitivity);
      if (recovery === undefined) return false;
      if (
        rateLimitRecoveryWaits >= MAX_RATE_LIMIT_RECOVERY_WAITS
        || rateLimitRecoveryWaitMs + recovery.waitMs > MAX_RATE_LIMIT_RECOVERY_WAIT_MS
      ) {
        rateLimitRecoveryCapped = true;
        return false;
      }
      rateLimitRecoveryWaits += 1;
      rateLimitRecoveryWaitMs += recovery.waitMs;
      if (recovery.waitMs > 0) await sleep(recovery.waitMs, undefined, { signal: retryAbort.signal });
      this.resolver.resumeRateLimitRecovery(role, phaseKey, recovery.index);
      return true;
    };
    let first;
    while (first === undefined) {
      try {
        first = await this.resolver.beginPhase(role, phaseKey, sensitivity);
      } catch (error) {
        if (!await waitForRateLimitRecovery(error)) throw error;
      }
    }
    const attempts = [];
    let fallbackReason = '';
    const addFallbackReason = reason => {
      fallbackReason += `${fallbackReason ? ' -> ' : ''}${reason}`;
    };
    const capacitySkippedRoutes = new Set();
    const usageAdmission = await this.usageAdmission.evaluate(first.candidateChain ?? []);
    const artifactPlan = sensitivity === 'private'
      ? { mode: 'local-only' }
      : await this.artifactBridge.prepare(input.request);
    this.resolver.reprioritizePhase(role, phaseKey, usageAdmission.preferredRoutes ?? []);
    first = this.resolver.select(role, phaseKey, sensitivity);
    const capabilitySkippedRoutes = new Set();
    if (artifactPlan.mode === 'local-only') {
      for (const candidate of first.candidateChain ?? []) {
        if (browserChatRoute(candidate)) capabilitySkippedRoutes.add(modelRouteKey(candidate));
      }
    }
    const usageSkippedRoutes = usageAdmission.skippedRoutes ?? new Set();
    const browserPrioritySkippedRoutes = new Set();
    if (artifactPlan.mode !== 'local-only') {
      const chain = first.candidateChain ?? [];
      const browserIndex = chain.findIndex(candidate => browserChatRoute(candidate)
        && !usageSkippedRoutes.has(modelRouteKey(candidate))
        && this.resolver.circuitState(candidate) !== 'open');
      if (browserIndex >= 0) {
        for (let index = 0; index < browserIndex; index += 1) {
          if (!browserChatRoute(chain[index])) browserPrioritySkippedRoutes.add(modelRouteKey(chain[index]));
        }
      }
    }
    const skippedRoutes = () => new Set([
      ...capabilitySkippedRoutes,
      ...capacitySkippedRoutes,
      ...usageSkippedRoutes,
      ...browserPrioritySkippedRoutes,
    ]);
    try {
      first = this.resolver.selectWithOptions(role, phaseKey, sensitivity, { skipRoutes: skippedRoutes(), commit: false });
    } catch (error) {
      if (error?.code !== 'bounded_exhaustion') throw error;
    }
    const startedRuns = new Set();
    const verificationAgents = new Set();
    const verificationSessionIds = new Set();
    let current;
    let currentRun;
    let currentTarget = targetWithConstraint(first, input.effort);
    let currentCircuitState = first.circuitState;
    let disposed = false;
    let retryInfoRetries = 0;
    let retryInfoWaitMs = 0;
    const noChannelRetries = new Map();
    let noChannelRetryCount = 0;
    let noChannelRetryWaitMs = 0;
    let telemetryResolve;
    const telemetry = new Promise(resolve => { telemetryResolve = resolve; });

    const claimRetryInfoWait = evidence => {
      const retryAfterMs = evidence?.retryAfterMs;
      if (retryAfterMs === undefined || retryInfoRetries >= 16 || retryInfoWaitMs + retryAfterMs > 15 * 60_000) return undefined;
      retryInfoRetries += 1;
      retryInfoWaitMs += retryAfterMs;
      return retryAfterMs;
    };

    const claimNoChannelRetry = (target, evidence) => {
      if (normalize(target?.provider) !== 'aihubmix' || evidence?.code !== 'no_available_channel') return undefined;
      const key = modelRouteKey(target);
      const count = noChannelRetries.get(key) ?? 0;
      if (count >= 1) return undefined;
      noChannelRetries.set(key, count + 1);
      noChannelRetryCount += 1;
      noChannelRetryWaitMs += AIHUBMIX_NO_CHANNEL_RETRY_MS;
      return AIHUBMIX_NO_CHANNEL_RETRY_MS;
    };

    const claimRetryWait = (target, evidence) => {
      if (evidence?.code === 'no_available_channel') return claimNoChannelRetry(target, evidence);
      if (evidence?.classification === 'rate_limit') return undefined;
      return claimRetryInfoWait(evidence);
    };

    const startAttempt = async () => {
      if (attempts.length >= MAX_ROUTE_ATTEMPTS) {
        routeAttemptCapped = true;
        throw boundedExhaustion(`routing attempt limit reached (${MAX_ROUTE_ATTEMPTS})`);
      }
      let failedSelection;
      let failedTarget;
      let failedEvidence;
      try {
        const started = await this.startSelected(input, {
          skipRoutes: skippedRoutes(),
          commit: capacitySkippedRoutes.size === 0 && browserPrioritySkippedRoutes.size === 0,
        }, (error, selection, target) => {
          failedSelection = selection;
          failedTarget = target;
          failedEvidence = failureEvidence(error);
        }, artifactPlan);
        startedRuns.add(started.run);
        verificationSessionIds.add(String(started.run.id));
        if (started.verificationAgent !== undefined) verificationAgents.add(started.verificationAgent);
        currentTarget = started.target;
        currentCircuitState = 'closed';
        attempts.push({ attempt: attempts.length + 1, provider: started.target.provider, model: started.target.model, effort: started.target.effort, privacy: started.target.privacy, circuitState: 'closed' });
        return started;
      } catch (error) {
        const evidence = failedEvidence ?? failureEvidence(error);
        const classification = formatFailureEvidence(evidence);
        if (classification === undefined) throw error;
        const selection = failedSelection ?? this.resolver.selectWithOptions(role, phaseKey, sensitivity, { skipRoutes: skippedRoutes(), commit: false });
        const target = failedTarget ?? targetWithConstraint(selection, input.effort);
        currentTarget = target;
        const capacityBusy = evidence?.classification === 'capacity_busy';
        const browserWasPriority = browserChatRoute(target) && browserPrioritySkippedRoutes.size > 0;
        const retryAfterMs = claimRetryWait(target, evidence);
        attempts.push({ attempt: attempts.length + 1, provider: target.provider, model: target.model, effort: target.effort, privacy: target.privacy, failureClassification: classification, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), circuitState: capacityBusy || retryAfterMs !== undefined ? 'closed' : 'open' });
        if (capacityBusy) {
          if (browserWasPriority) browserPrioritySkippedRoutes.clear();
          capacitySkippedRoutes.add(modelRouteKey(target));
          addFallbackReason(classification);
          currentCircuitState = 'closed';
          return undefined;
        }
        if (retryAfterMs !== undefined) {
          currentCircuitState = 'closed';
          await this.sleep(retryAfterMs, undefined, { signal: retryAbort.signal });
          return undefined;
        }
        addFallbackReason(classification);
        if (browserWasPriority) browserPrioritySkippedRoutes.clear();
        currentCircuitState = this.resolver.recordFailure({
          role, phaseKey, index: selection.index, classification,
          advancePhase: capacitySkippedRoutes.size === 0 && !browserWasPriority,
        }).circuitState;
        return undefined;
      }
    };

    const startAvailable = async () => {
      while (true) {
        try {
          const started = await startAttempt();
          if (started !== undefined) return started;
        } catch (error) {
          if (await waitForRateLimitRecovery(error)) continue;
          throw error;
        }
      }
    };

    const buildTelemetry = () => ({
      phase,
      phaseKey,
      sensitivity,
      role,
      pricingWindow: first.pricingWindow,
      ...(first.scheduleRule === undefined ? {} : { scheduleRule: first.scheduleRule }),
      candidateChain: first.candidateChain,
      attempts,
      attempt: attempts.length,
      provider: currentTarget.provider,
      model: currentTarget.model,
      initialProvider: first.target.provider,
      initialModel: first.target.model,
      finalProvider: currentTarget.provider,
      finalModel: currentTarget.model,
      ...(fallbackReason ? { fallbackReason } : {}),
      failureClassification: attempts.at(-1)?.failureClassification,
      circuitState: currentCircuitState,
      resolvedEffort: currentTarget.effort,
      ...(retryInfoRetries === 0 ? {} : { retryInfoRetries, retryInfoWaitMs }),
      ...(noChannelRetryCount === 0 ? {} : { noChannelRetryCount, noChannelRetryWaitMs }),
      ...(rateLimitRecoveryWaits === 0 ? {} : { rateLimitRecoveryWaits, rateLimitRecoveryWaitMs }),
      ...(rateLimitRecoveryCapped ? { rateLimitRecoveryCapped: true } : {}),
      ...(routeAttemptCapped ? { routeAttemptCapped: true } : {}),
      usageAdmission: {
        status: usageAdmission.status,
        preferredRoutes: usageAdmission.preferredRoutes ?? [],
        skipped: usageAdmission.decisions?.filter(decision => decision.admitted === false) ?? [],
        ...(usageAdmission.diagnostic === undefined ? {} : { diagnostic: usageAdmission.diagnostic }),
      },
      artifactBridge: {
        mode: artifactPlan.mode,
        browserPreferred: artifactPlan.mode !== 'local-only' && (first.candidateChain ?? []).some(browserChatRoute),
      },
      ...(currentRun?.run.guard?.()?.tripped ? { resourceGuard: currentRun.run.guard() } : {}),
      durationMs: Date.now() - startedAt,
    });

    let started;
    try {
      started = await startAvailable();
    } catch (error) {
      if (error?.code !== 'bounded_exhaustion') throw error;
      try { await this.artifactBridge.cleanup?.(artifactPlan); } catch {}
      telemetryResolve(buildTelemetry());
      const exhausted = { id: `routing-exhausted-${startedAt}`, localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => {} };
      return { run: exhausted, telemetry };
    }
    current = started.selection;
    currentRun = started;
    const result = (async () => {
      try {
        while (true) {
          const outcome = await currentRun.run.result;
          const resourceGuard = currentRun.run.guard?.();
          const preserveCompletedAtLimit = resourceGuard?.tripped
            && outcome.stopReason !== 'error'
            && currentRun.run.guardAllowsCompletedOutcome?.() === true;
          if (resourceGuard?.tripped && !preserveCompletedAtLimit) {
            return {
              output: [],
              stopReason: 'error',
              diagnostic: `resource_guard_exceeded:${resourceGuard.reason}:fresh_tokens=${resourceGuard.freshTokens}:llm_calls=${resourceGuard.llmCalls}`,
            };
          }
          let effectiveOutcome = outcome;
          let artifactFailure;
          if (browserChatRoute(currentTarget) && artifactPlan.mode === 'mutation' && outcome.stopReason !== 'error') {
            const finalized = await this.artifactBridge.finalizeMutation(artifactPlan, outcome);
            if (finalized.ok) {
              effectiveOutcome = finalized.outcome;
            } else {
              artifactFailure = { classification: 'capacity_busy', code: 'artifact_bridge_unavailable' };
            }
          }
          const evidence = artifactFailure ?? (outcome.stopReason === 'error'
            ? failureEvidence(currentRun.failure() ?? terminalRunFailure(currentRun.run, outcome))
            : undefined);
          const classification = formatFailureEvidence(evidence);
          const browserWasPriority = browserChatRoute(currentTarget) && browserPrioritySkippedRoutes.size > 0;
          if (classification === undefined) {
            currentCircuitState = this.resolver.recordSuccess({
              role, phaseKey, index: current.index,
              circuitGeneration: current.circuitGeneration,
              providerCircuitGeneration: current.providerCircuitGeneration,
              advancePhase: capacitySkippedRoutes.size === 0 && !browserWasPriority,
            }).circuitState;
            return effectiveOutcome;
          }
          const attempt = attempts.at(-1);
          const retryAfterMs = claimRetryWait(currentTarget, evidence);
          const capacityBusy = evidence?.classification === 'capacity_busy';
          if (attempt) {
            attempt.failureClassification = classification;
            if (retryAfterMs !== undefined) attempt.retryAfterMs = retryAfterMs;
            attempt.circuitState = capacityBusy || retryAfterMs !== undefined ? 'closed' : 'open';
          }
          await currentRun.run.dispose();
          if (capacityBusy) {
            if (browserWasPriority) browserPrioritySkippedRoutes.clear();
            capacitySkippedRoutes.add(modelRouteKey(currentTarget));
            addFallbackReason(classification);
            currentCircuitState = 'closed';
            let next;
            try {
              next = await startAvailable();
            } catch (error) {
              if (error?.code === 'bounded_exhaustion') return outcome;
              throw error;
            }
            current = next.selection;
            currentRun = next;
            continue;
          }
          if (retryAfterMs !== undefined) {
            currentCircuitState = 'closed';
            await this.sleep(retryAfterMs, undefined, { signal: retryAbort.signal });
            const next = await startAvailable();
            current = next.selection;
            currentRun = next;
            continue;
          }
          addFallbackReason(classification);
          if (browserWasPriority) browserPrioritySkippedRoutes.clear();
          currentCircuitState = this.resolver.recordFailure({
            role, phaseKey, index: current.index, classification,
            advancePhase: capacitySkippedRoutes.size === 0 && !browserWasPriority,
          }).circuitState;
          let next;
          try {
            next = await startAvailable();
          } catch (error) {
            if (error?.code === 'bounded_exhaustion') return outcome;
            throw error;
          }
          current = next.selection;
          currentRun = next;
        }
      } finally {
        try { await this.artifactBridge.cleanup?.(artifactPlan); } catch {}
        telemetryResolve(buildTelemetry());
      }
    })();

    return {
      run: {
        id: started.run.id,
        get localAgent() { return currentRun.run.localAgent; },
        result,
        async dispose() {
          if (disposed) return;
          disposed = true;
          retryAbort.abort();
          await Promise.allSettled([...startedRuns].map(run => run.dispose()));
          try { await this.artifactBridge.cleanup?.(artifactPlan); } catch {}
        },
      },
      verificationAgents: () => [...verificationAgents],
      verificationSessionIds: () => [...verificationSessionIds],
      telemetry,
      escalate: async reason => {
        if (reason !== 'verification_failed') throw new Error(`unsupported quality escalation reason "${reason}"`);
        if (role !== 'deep') throw new Error('quality escalation is restricted to the deep role');
        let next;
        try {
          next = this.resolver.advanceForQuality({ role, phaseKey, index: current.index, skipRoutes: skippedRoutes() });
        } catch (error) {
          if (error?.code === 'bounded_exhaustion') return buildTelemetry();
          throw error;
        }
        const previousAttempt = attempts.at(-1);
        if (previousAttempt) previousAttempt.fallbackReason = `quality_escalation:${reason}`;
        const nextTarget = targetWithConstraint(next, input.effort);
        currentRun.setTarget?.(nextTarget);
        current = next;
        currentTarget = nextTarget;
        currentCircuitState = next.circuitState;
        addFallbackReason(`quality_escalation:${reason}`);
        attempts.push({ attempt: attempts.length + 1, provider: nextTarget.provider, model: nextTarget.model, effort: nextTarget.effort, privacy: nextTarget.privacy, fallbackReason: `quality_escalation:${reason}`, circuitState: next.circuitState });
        return buildTelemetry();
      },
    };
  }
}

export function loadModelPolicy() {
  return JSON.parse(readFileSync(new URL('./model-policy.json', import.meta.url), 'utf8'));
}

function routeValidatorFor(ctx) {
  const llm = ctx.llm ?? ctx.get?.('llm');
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return async () => false;
  return async candidate => {
    if (!llm.listProviders().some(provider => provider?.id === candidate.provider)) return false;
    const models = await llm.listModels(candidate.provider);
    return models.some(model => model?.provider === candidate.provider && model?.id === candidate.model);
  };
}

export function apply(ctx, config) {
  const resolvedConfig = config ?? {};
  const usageAdmission = new CodexBarUsageAdmission(resolvedConfig.usageAdmission ?? {});
  const artifactBridge = new ArtifactBridge(resolvedConfig.artifactBridge ?? {});
  const quotaGuard = new FreeQuotaGuard(resolvedConfig.freeQuotaRules ?? []);
  if ((resolvedConfig.freeQuotaRules?.length ?? 0) > 0) {
    ctx.effect(() => ctx.on('llm/stream', (options, next) => quotaGuard.wrap(options, next), { global: true, prepend: true }), 'iw-dsh-workflow-dispatch: enforce free quota guard');
  }
  const adapter = new WorkflowDispatch(
    ctx,
    new ModelPolicyResolver(loadModelPolicy, { routeValidator: routeValidatorFor(ctx) }),
    resolvedConfig.resourceGuard,
    new ModelCapacityLeaseManager(),
    resolvedConfig.passthroughSubagentProviders ?? [],
    sleep,
    usageAdmission,
    artifactBridge,
  );
  ctx.effect(() => ctx.dynamicWorkflows.registerDispatchAdapter(adapter), 'iw-dsh-workflow-dispatch: register stable routing adapter');
  if (resolvedConfig.routingProbe?.enabled === true) {
    ctx.tools.register(createRoutingProbeTool(ctx, resolvedConfig.routingProbe, usageAdmission, artifactBridge));
  }
}

export default { name, inject, Config, apply };
