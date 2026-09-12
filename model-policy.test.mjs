import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelPolicyResolver,
  RoutingExhaustedError,
  validateModelPolicy,
} from './model-policy.js';

const candidate = (provider, model, effort = 'high', privacy = 'private-safe', subagentProvider) => ({
  provider,
  model,
  effort,
  privacy,
  ...(subagentProvider === undefined ? {} : { subagentProvider }),
});
const modelRoute = value => `${value.provider}\0${value.model}`;

function policy() {
  return {
    version: 1,
    roles: {
      fast: [candidate('p-fast-1', 'm-fast-1'), candidate('p-fast-2', 'm-fast-2')],
      balanced: [
        candidate('p-balanced-1', 'm-balanced-1'),
        candidate('p-balanced-2', 'm-balanced-2'),
        candidate('p-balanced-3', 'm-balanced-3'),
      ],
      deep: [candidate('p-deep-1', 'm-deep-1')],
    },
  };
}

test('resolves semantic roles, snapshots a phase, and reloads only for a new phase', async () => {
  let current = policy();
  const resolver = new ModelPolicyResolver(() => current);
  const first = await resolver.beginPhase('balanced', 'run-1:analysis');
  assert.deepEqual(first.target, candidate('p-balanced-1', 'm-balanced-1'));
  assert.deepEqual(first.candidateChain, current.roles.balanced);

  current = { ...current, roles: { ...current.roles, balanced: [candidate('changed', 'changed-model')] } };
  const samePhase = await resolver.beginPhase('balanced', 'run-1:analysis');
  assert.deepEqual(samePhase.target, candidate('p-balanced-1', 'm-balanced-1'));
  assert.deepEqual(samePhase.candidateChain, first.candidateChain);

  current = { ...current, roles: { ...current.roles, deep: [candidate('reloaded', 'deep-model')] } };
  const reloaded = await resolver.beginPhase('deep', 'run-1:verification');
  assert.deepEqual(reloaded.target, candidate('reloaded', 'deep-model'));
});

test('pricing schedule swaps only the configured role and remains sticky across the phase', async () => {
  const configured = policy();
  configured.roles.deep = [candidate('orca', 'pro'), candidate('codex', 'sol')];
  configured.schedule = {
    id: 'timed-pricing', timezone: 'UTC', defaultWindow: 'off-peak', matchedWindow: 'peak',
    ranges: [{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }],
    roleOverrides: { deep: [candidate('codex', 'sol'), candidate('orca', 'pro')] },
  };
  let now = Date.parse('2026-09-01T03:59:00Z');
  const resolver = new ModelPolicyResolver(configured, { now: () => now });
  const peak = await resolver.beginPhase('deep', 'run-1:deep');
  assert.equal(peak.target.provider, 'codex');
  assert.equal(peak.pricingWindow, 'peak');
  assert.equal(peak.scheduleRule, 'timed-pricing');
  now = Date.parse('2026-09-01T04:01:00Z');
  const samePhase = await resolver.beginPhase('deep', 'run-1:deep');
  assert.equal(samePhase.target.provider, 'codex');
  assert.equal(samePhase.pricingWindow, 'peak');
  const offPeak = await resolver.beginPhase('deep', 'run-1:next-deep');
  assert.equal(offPeak.target.provider, 'orca');
  assert.equal(offPeak.pricingWindow, 'off-peak');
  const balanced = await resolver.beginPhase('balanced', 'run-1:balanced');
  assert.equal(balanced.target.provider, 'p-balanced-1');
  assert.equal(balanced.pricingWindow, 'off-peak');
});

test('pricing schedule is fail-closed on malformed windows and override routes', () => {
  const configured = policy();
  configured.schedule = {
    id: 'timed-pricing', timezone: 'UTC', defaultWindow: 'off-peak', matchedWindow: 'peak',
    ranges: [{ start: '04:00', end: '01:00' }],
    roleOverrides: { deep: [candidate('p', 'm')] },
  };
  assert.throws(() => validateModelPolicy(configured), /must end after/u);
  configured.schedule.ranges = [{ start: '01:00', end: '04:00' }];
  configured.schedule.roleOverrides.deep = [candidate('missing', 'm')];
  assert.throws(() => validateModelPolicy(configured, { availableRoutes: new Set(['p\0m']) }), /route is not available/u);
});

test('allows up to nine candidates and rejects ten, duplicate candidates, and missing roles', () => {
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [], balanced: [], deep: [] } }), /at least one candidate/u);
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('p', 'm'), candidate('p', 'm')], balanced: [candidate('p', 'm')], deep: [candidate('p', 'm')] } }), /duplicate/u);
  assert.doesNotThrow(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('p', 'm')], balanced: Array.from({ length: 9 }, (_, i) => candidate('p', `m-${i}`)), deep: [candidate('p', 'm')] } }));
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('p', 'm')], balanced: Array.from({ length: 10 }, (_, i) => candidate('p', `m-${i}`)), deep: [candidate('p', 'm')] } }), /at most 9/u);
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('p', 'm')], balanced: [candidate('p', 'm')], deep: [candidate('p', 'm')], ultra: [candidate('p', 'm')] } }), /unknown role/u);
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [{ ...candidate('p', 'm'), quota: 'free' }], balanced: [candidate('p', 'm')], deep: [candidate('p', 'm')] } }), /unknown candidate key/u);
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('bad provider', 'm')], balanced: [candidate('p', 'm')], deep: [candidate('p', 'm')] } }), /provider\/model shape/u);
  assert.throws(() => validateModelPolicy({ version: 1, roles: { fast: [candidate('missing', 'm')], balanced: [candidate('p', 'm')], deep: [candidate('p', 'm')] } }, { availableRoutes: new Set(['p\0m']) }), /route is not available/u);
});

test('fixed subagent candidates bypass model-route availability checks and remain ordered in the chain', async () => {
  const configured = policy();
  configured.roles.balanced = [
    candidate('free', 'free-model'),
    candidate('browser-chat', 'gemini-3.8-flash-ui', 'high', 'public-only', 'browser-chat'),
    candidate('paid', 'paid-model'),
  ];
  const validated = validateModelPolicy(configured, {
    availableRoutes: new Set([
      modelRoute(candidate('p-fast-1', 'm-fast-1')),
      modelRoute(candidate('p-fast-2', 'm-fast-2')),
      modelRoute(candidate('free', 'free-model')),
      modelRoute(candidate('paid', 'paid-model')),
      modelRoute(candidate('p-deep-1', 'm-deep-1')),
    ]),
  });
  assert.equal(validated.roles.balanced[1].subagentProvider, 'browser-chat');

  const checked = [];
  const resolver = new ModelPolicyResolver(configured, {
    routeValidator: async route => {
      checked.push(route.provider);
      return true;
    },
  });
  const first = await resolver.beginPhase('balanced', 'run-1:mixed-transport');
  assert.equal(first.target.provider, 'free');
  assert.deepEqual(checked, ['p-fast-1', 'p-fast-2', 'free', 'paid', 'p-deep-1']);
});

test('validates model capacity rules by provider/model and shares the limit across efforts', async () => {
  const configured = policy();
  configured.capacity = [{ provider: 'p-balanced-1', model: 'm-balanced-1', maxInFlight: 1 }];
  const validated = validateModelPolicy(configured);
  assert.deepEqual(validated.capacity, [{ provider: 'p-balanced-1', model: 'm-balanced-1', maxInFlight: 1 }]);
  const resolver = new ModelPolicyResolver(configured);
  assert.equal(resolver.capacityLimit(candidate('p-balanced-1', 'm-balanced-1', 'medium')), 1);
  assert.equal(resolver.capacityLimit(candidate('p-balanced-1', 'm-balanced-1', 'xhigh')), 1);
  assert.equal(resolver.capacityLimit(candidate('other', 'model')), undefined);
  assert.throws(() => validateModelPolicy({ ...configured, capacity: [{ provider: 'p', model: 'm', maxInFlight: 0 }] }), /positive safe integer/u);
  assert.throws(() => validateModelPolicy({ ...configured, capacity: [{ provider: 'p', model: 'm', maxInFlight: 1 }, { provider: 'p', model: 'm', maxInFlight: 2 }] }), /duplicate provider\/model/u);
});

test('capacity-only selection can skip a busy route without making the fallback phase-sticky', async () => {
  const resolver = new ModelPolicyResolver(policy());
  const phase = 'run-1:capacity-local';
  const first = await resolver.beginPhase('balanced', phase);
  const fallback = resolver.selectWithOptions('balanced', phase, 'public', { skipRoutes: new Set([modelRoute(first.target)]), commit: false });
  assert.equal(fallback.target.model, 'm-balanced-2');
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-1');
});

test('privacy filters public-only candidates and keeps sensitivity sticky', async () => {
  const configured = policy();
  configured.roles.balanced = [candidate('public', 'public-model', 'high', 'public-only'), candidate('private', 'private-model', 'high', 'private-safe')];
  const resolver = new ModelPolicyResolver(configured);
  const publicPhase = await resolver.beginPhase('balanced', 'run-1:public', 'public');
  assert.equal(publicPhase.target.provider, 'public');
  const privatePhase = await resolver.beginPhase('balanced', 'run-1:private', 'private');
  assert.equal(privatePhase.target.provider, 'private');
  await assert.rejects(() => resolver.beginPhase('balanced', 'run-1:public', 'private'), /sensitivity cannot change/u);
});

test('omitted sensitivity defaults to public and allows public-only routes', async () => {
  const configured = policy();
  configured.roles.balanced = [candidate('public', 'public-model', 'high', 'public-only')];
  const resolver = new ModelPolicyResolver(configured);
  assert.equal((await resolver.beginPhase('balanced', 'run-1:implicit-public')).target.provider, 'public');
  assert.equal((await resolver.beginPhase('balanced', undefined)).target.provider, 'public');
});

test('route preflight skips an unavailable candidate and selects the next available route', async () => {
  const resolver = new ModelPolicyResolver(policy(), { routeValidator: async route => route.provider !== 'p-balanced-1' });
  const selected = await resolver.beginPhase('balanced', 'run-1:preflight');
  assert.equal(selected.target.provider, 'p-balanced-2');
  assert.equal(selected.target.model, 'm-balanced-2');
});

test('route preflight still exhausts when every candidate is unavailable', async () => {
  const resolver = new ModelPolicyResolver(policy(), { routeValidator: async () => false });
  await assert.rejects(() => resolver.beginPhase('balanced', 'run-1:preflight-all-down'), error => {
    assert.ok(error instanceof RoutingExhaustedError);
    assert.equal(error.code, 'bounded_exhaustion');
    return true;
  });
});

test('concurrent starts share one phase initialization snapshot', async () => {
  let current = policy();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const resolver = new ModelPolicyResolver(() => current, { routeValidator: async () => { await gate; return true; } });
  const first = resolver.beginPhase('balanced', 'run-1:parallel-init');
  const second = resolver.beginPhase('balanced', 'run-1:parallel-init');
  current = { ...current, roles: { ...current.roles, balanced: [candidate('changed', 'changed-model')] } };
  release();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.target.provider, 'p-balanced-1');
  assert.equal(two.target.provider, 'p-balanced-1');
});

test('provider failure advances the phase and remains sticky for later agents', async () => {
  const resolver = new ModelPolicyResolver(policy);
  const phase = 'run-1:work';
  const first = await resolver.beginPhase('balanced', phase);
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: first.index, classification: 'rate_limit' });
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-2');
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-2');
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: 1, classification: 'transient_provider_error' });
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-3');
});

test('quality escalation advances only the current phase without opening provider circuits', async () => {
  const configured = policy();
  configured.roles.deep = [
    candidate('shared-provider', 'flash'),
    candidate('shared-provider', 'full'),
    candidate('independent-provider', 'judge'),
  ];
  const resolver = new ModelPolicyResolver(configured);
  const phase = 'run-1:deep-quality';
  const first = await resolver.beginPhase('deep', phase);
  assert.equal(first.target.model, 'flash');

  const full = resolver.advanceForQuality({ role: 'deep', phaseKey: phase, index: first.index });
  assert.equal(full.target.model, 'full');
  assert.equal(full.circuitState, 'closed');

  const separatePhase = await resolver.beginPhase('deep', 'run-1:other-deep');
  assert.equal(separatePhase.target.model, 'flash');
});

test('quality escalation skips fixed subagent candidates that cannot continue the current local child', async () => {
  const configured = policy();
  configured.roles.deep = [
    candidate('free', 'free-model'),
    candidate('browser-chat', 'gemini-3.8-flash-ui', 'high', 'public-only', 'browser-chat'),
    candidate('paid', 'paid-model'),
  ];
  const resolver = new ModelPolicyResolver(configured);
  const first = await resolver.beginPhase('deep', 'run-1:deep-quality-mixed');
  const escalated = resolver.advanceForQuality({ role: 'deep', phaseKey: 'run-1:deep-quality-mixed', index: first.index });
  assert.equal(escalated.target.provider, 'paid');
});

test('circuit breaker skips a failed candidate for new phases and recovers after TTL', async () => {
  let now = 10_000;
  const resolver = new ModelPolicyResolver(policy, { now: () => now, circuitTtlMs: 300_000 });
  resolver.recordFailure({ role: 'balanced', phaseKey: 'run-1:a', index: 0, classification: 'http_504' });
  assert.equal((await resolver.beginPhase('balanced', 'run-1:b')).target.model, 'm-balanced-2');
  now += 300_001;
  assert.equal((await resolver.beginPhase('balanced', 'run-1:c')).target.model, 'm-balanced-1');
});

test('circuit TTL recovery never reopens an earlier route inside an existing phase', async () => {
  let now = 10_000;
  const resolver = new ModelPolicyResolver(policy, { now: () => now, circuitTtlMs: 100 });
  const first = await resolver.beginPhase('balanced', 'run-1:ttl-sticky');
  resolver.recordFailure({ role: 'balanced', phaseKey: 'run-1:ttl-sticky', index: first.index, classification: 'rate_limit' });
  assert.equal(resolver.select('balanced', 'run-1:ttl-sticky').target.model, 'm-balanced-2');
  now += 101;
  assert.equal(resolver.select('balanced', 'run-1:ttl-sticky').target.model, 'm-balanced-2');
});

test('provider circuit skips every candidate for the failed provider', async () => {
  const configured = policy();
  configured.roles.balanced = [candidate('shared-provider', 'model-a'), candidate('shared-provider', 'model-b'), candidate('other-provider', 'model-c')];
  const resolver = new ModelPolicyResolver(configured);
  resolver.recordFailure({ role: 'balanced', phaseKey: 'run-1:provider-down', index: 0, classification: 'transient_provider_error:http_504' });
  assert.equal((await resolver.beginPhase('balanced', 'run-1:after-provider-down')).target.provider, 'other-provider');
});

test('model rate limits and quota exhaustion keep same-provider sibling models eligible', async () => {
  for (const classification of ['rate_limit:http_429', 'quota_exhausted']) {
    const configured = policy();
    configured.roles.balanced = [candidate('shared-provider', 'model-a'), candidate('shared-provider', 'model-b'), candidate('other-provider', 'model-c')];
    const resolver = new ModelPolicyResolver(configured);
    const first = await resolver.beginPhase('balanced', `run-1:${classification}`);
    resolver.recordFailure({ role: 'balanced', phaseKey: `run-1:${classification}`, index: first.index, classification });
    assert.equal(resolver.select('balanced', `run-1:${classification}`).target.model, 'model-b', classification);
  }
});

test('bounded exhaustion never cycles and concurrent failure updates cannot move backward', () => {
  const resolver = new ModelPolicyResolver(policy);
  const phase = 'run-1:bounded';
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: 0, classification: 'quota_exhausted' });
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: 1, classification: 'auth_unavailable' });
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: 0, classification: 'timeout' });
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-3');
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: 2, classification: 'model_unavailable' });
  assert.throws(() => resolver.select('balanced', phase), error => {
    assert.ok(error instanceof RoutingExhaustedError);
    assert.equal(error.code, 'bounded_exhaustion');
    return true;
  });
});

test('rate-limit exhaustion exposes the earliest recoverable route and rewinds only for that cooldown', async () => {
  let now = 10_000;
  const resolver = new ModelPolicyResolver(policy(), { now: () => now, circuitTtlMs: 100 });
  const phase = 'run-1:rate-limit-recovery';
  const first = await resolver.beginPhase('balanced', phase);
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: first.index, classification: 'quota_exhausted' });
  const second = resolver.select('balanced', phase);
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: second.index, classification: 'rate_limit:http_429' });
  const third = resolver.select('balanced', phase);
  resolver.recordFailure({ role: 'balanced', phaseKey: phase, index: third.index, classification: 'rate_limit:http_429' });

  assert.throws(() => resolver.select('balanced', phase), error => error instanceof RoutingExhaustedError);
  assert.deepEqual(resolver.nextRateLimitRecovery('balanced', phase), { index: 1, waitMs: 100, until: 10_100 });

  now += 100;
  resolver.resumeRateLimitRecovery('balanced', phase, 1);
  assert.equal(resolver.select('balanced', phase).target.model, 'm-balanced-2');
});

test('a stale concurrent success cannot clear a newer circuit failure', async () => {
  const resolver = new ModelPolicyResolver(policy);
  const first = await resolver.beginPhase('balanced', 'run-1:concurrent');
  resolver.recordFailure({ role: 'balanced', phaseKey: 'run-1:concurrent', index: first.index, classification: 'transient_provider_error' });
  resolver.recordSuccess({ role: 'balanced', phaseKey: 'run-1:concurrent', index: first.index, circuitGeneration: first.circuitGeneration });
  assert.equal((await resolver.beginPhase('balanced', 'run-1:next')).target.model, 'm-balanced-2');
});
