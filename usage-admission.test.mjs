import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBarUsageAdmission, evaluateDashboardSnapshot } from './usage-admission.js';

const NOW = Date.parse('2026-09-06T17:05:30Z');
const candidates = [
  { provider: 'browser-chat', model: 'gemini-3.8-flash-ui' },
  { provider: 'aihubmix', model: 'coding-glm-5.3-flash' },
];

function snapshot(remaining = 100, overrides = {}) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-06T17:05:00Z',
    staleAfterSeconds: 180,
    providers: [{
      id: 'geminiapps', enabled: true, error: null,
      updatedAt: '2026-09-06T17:05:00Z',
      windows: [{ kind: 'weekly', remainingPercent: remaining, resetAt: '2026-09-08T12:52:06Z' }],
    }, { id: 'aihubmix', enabled: true, error: null, updatedAt: '2026-09-06T17:05:00Z', windows: [{ kind: 'monthly', remainingPercent: 80 }] }],
    ...overrides,
  };
}

test('fresh usage below threshold skips exact route and preserves reset metadata', () => {
  const result = evaluateDashboardSnapshot(snapshot(4), candidates, { now: NOW, minRemainingPercent: 10 });
  assert.equal(result.status, 'fresh');
  assert.deepEqual([...result.skippedRoutes], ['browser-chat\0gemini-3.8-flash-ui']);
  assert.equal(result.decisions[0].reason, 'usage_below_threshold');
  assert.equal(result.decisions[0].resetAt, '2026-09-08T12:52:06Z');
  assert.equal(result.decisions[1].admitted, true);
});

test('exhausted route skips even when threshold is zero', () => {
  const result = evaluateDashboardSnapshot(snapshot(0), candidates, { now: NOW, minRemainingPercent: 0 });
  assert.equal(result.decisions[0].reason, 'usage_exhausted');
  assert.equal(result.skippedRoutes.size, 1);
});

test('lower remaining quota is preferred before higher remaining quota', () => {
  const value = snapshot(30);
  value.providers[1].windows[0].remainingPercent = 5;
  const result = evaluateDashboardSnapshot(value, candidates, { now: NOW, minRemainingPercent: 0 });
  assert.deepEqual(result.preferredRoutes, [
    'aihubmix\0coding-glm-5.3-flash',
    'browser-chat\0gemini-3.8-flash-ui',
  ]);
  assert.equal(result.skippedRoutes.size, 0);
});

test('CodexBar codex usage is applied to the openai-codex route', () => {
  const value = snapshot(30);
  value.providers.push({
    id: 'codex', enabled: true, error: null,
    updatedAt: '2026-09-06T17:05:00Z',
    windows: [{ kind: 'weekly', remainingPercent: 5, resetAt: '2026-09-13T17:05:00Z' }],
  });
  const routes = [
    { provider: 'browser-chat', model: 'gemini-3.8-flash-ui' },
    { provider: 'openai-codex', model: 'gpt-5.6-luna' },
  ];
  const result = evaluateDashboardSnapshot(value, routes, { now: NOW, minRemainingPercent: 0 });
  assert.deepEqual(result.preferredRoutes, [
    'openai-codex\0gpt-5.6-luna',
    'browser-chat\0gemini-3.8-flash-ui',
  ]);
  assert.equal(result.decisions[1].snapshotProvider, 'codex');
  assert.equal(result.decisions[1].remainingPercent, 5);
});

test('at or above threshold remains admitted and candidate order is untouched', () => {
  const result = evaluateDashboardSnapshot(snapshot(10), candidates, { now: NOW, minRemainingPercent: 10 });
  assert.equal(result.skippedRoutes.size, 0);
  assert.deepEqual(result.decisions.map(d => `${d.provider}/${d.model}`), [
    'browser-chat/gemini-3.8-flash-ui', 'aihubmix/coding-glm-5.3-flash',
  ]);
});

test('provider usage limit blocks Gemini API at 90 percent used without affecting Gemini browser chat', () => {
  const value = snapshot(40);
  value.providers.push({
    id: 'gemini-api', enabled: true, error: null,
    updatedAt: '2026-09-06T17:05:00Z',
    windows: [{ kind: 'monthly', remainingPercent: 10, resetAt: '2026-10-01T00:00:00Z' }],
  });
  const routes = [
    { provider: 'google', model: 'gemini-3.8-flash' },
    { provider: 'browser-chat', model: 'gemini-3.8-flash-ui' },
  ];
  const options = {
    now: NOW,
    minRemainingPercent: 0,
    providerUsageLimits: [{ provider: 'gemini-api', maxUsedPercent: 90 }],
  };
  const result = evaluateDashboardSnapshot(value, routes, options);
  assert.deepEqual([...result.skippedRoutes], ['google\0gemini-3.8-flash']);
  assert.equal(result.decisions[0].admitted, false);
  assert.equal(result.decisions[0].reason, 'provider_usage_limit');
  assert.equal(result.decisions[0].maxUsedPercent, 90);
  assert.equal(result.decisions[0].remainingPercent, 10);
  assert.equal(result.decisions[1].admitted, true);

  value.providers[2].windows[0].remainingPercent = 10.1;
  assert.equal(evaluateDashboardSnapshot(value, routes, options).skippedRoutes.size, 0);
});

test('stale, invalid, provider-error, and unknown-provider data fail open', () => {
  assert.equal(evaluateDashboardSnapshot(snapshot(0, { generatedAt: '2026-09-06T16:00:00Z' }), candidates, { now: NOW, minRemainingPercent: 10 }).status, 'stale');
  assert.equal(evaluateDashboardSnapshot({}, candidates, { now: NOW }).status, 'invalid');
  const errorSnapshot = snapshot(0);
  errorSnapshot.providers[0].error = { message: 'not authenticated' };
  assert.equal(evaluateDashboardSnapshot(errorSnapshot, candidates, { now: NOW, minRemainingPercent: 10 }).skippedRoutes.size, 0);
  const staleProviderSnapshot = snapshot(0);
  staleProviderSnapshot.providers[0].updatedAt = '2026-09-06T16:00:00Z';
  assert.equal(evaluateDashboardSnapshot(staleProviderSnapshot, candidates, { now: NOW, minRemainingPercent: 10 }).skippedRoutes.size, 0);
  assert.equal(evaluateDashboardSnapshot(snapshot(0), [{ provider: 'unknown', model: 'x' }], { now: NOW, minRemainingPercent: 10 }).skippedRoutes.size, 0);
});

test('admission refreshes after TTL and fails open when source throws', async () => {
  let now = NOW;
  let calls = 0;
  const admission = new CodexBarUsageAdmission({ now: () => now, refreshMs: 1000, minRemainingPercent: 10, snapshotSource: async () => { calls += 1; return snapshot(calls === 1 ? 5 : 50); } });
  assert.equal((await admission.evaluate(candidates)).skippedRoutes.size, 1);
  assert.equal((await admission.evaluate(candidates)).skippedRoutes.size, 1);
  assert.equal(calls, 1);
  now += 1001;
  assert.equal((await admission.evaluate(candidates)).skippedRoutes.size, 0);
  assert.equal(calls, 2);
  const broken = new CodexBarUsageAdmission({ snapshotSource: async () => { throw new Error('boom'); } });
  assert.equal((await broken.evaluate(candidates)).status, 'unavailable');
});
