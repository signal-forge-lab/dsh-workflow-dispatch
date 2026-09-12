import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, failureEvidence, loadModelPolicy } from './index.js';

test('classifies every permitted provider failure family', () => {
  const cases = [
    [{ status: 401 }, 'auth_unavailable:http_401'],
    [{ status: 402 }, 'balance_exhausted:http_402'],
    [{ status: 403 }, 'auth_unavailable:http_403'],
    [{ status: 408 }, 'transient_provider_error:http_408'],
    [{ status: 429 }, 'rate_limit:http_429'],
    [{ status: 500 }, 'transient_provider_error:http_500'],
    [{ status: 504 }, 'transient_provider_error:http_504'],
    [new Error('quota exhausted'), 'quota_exhausted'],
    [new Error('credit exhausted'), 'balance_exhausted'],
    [new Error('network timeout'), 'transient_provider_error'],
    [new Error('provider unavailable'), 'transient_provider_error'],
    [new Error('unknown model'), 'model_unavailable'],
    [new Error('authentication unavailable'), 'auth_unavailable'],
  ];
  for (const [failure, expected] of cases) assert.equal(classifyFailure(failure), expected);
});

test('extracts Gemini RetryInfo and treats temporary quota exhaustion as a rate limit', () => {
  const evidence = failureEvidence({
    code: 'QUOTA',
    message: '{"error":{"code":429,"message":"quota exceeded; Please retry in 55.289658228s.","details":[{"retryDelay":"55s"}]}}',
  });
  assert.deepEqual(evidence, {
    classification: 'rate_limit',
    httpStatus: 429,
    code: 'quota',
    retryAfterMs: 55000,
  });
});

test('quality and workflow failures never trigger provider fallback', () => {
  for (const message of ['generated code failure', 'test failure', 'validator failure', 'review failure', 'logic failure', 'low-quality response']) {
    assert.equal(classifyFailure(new Error(message)), undefined, message);
  }
  assert.equal(classifyFailure({ code: 'TEST_FAILED', message: 'unit tests failed' }), undefined);
  assert.equal(failureEvidence({ status: 400, message: 'quality failure' }), undefined);
});

test('checked-in policy has one bounded candidate chain for every role', () => {
  const policy = loadModelPolicy();
  assert.deepEqual(Object.keys(policy.roles).sort(), ['balanced', 'deep', 'fast']);
  for (const candidates of Object.values(policy.roles)) {
    assert.ok(candidates.length >= 1 && candidates.length <= 9);
    assert.ok(candidates.every(candidate => ['public-only', 'private-safe'].includes(candidate.privacy)));
    assert.equal(new Set(candidates.map(candidate => `${candidate.provider}\0${candidate.model}\0${candidate.effort}`)).size, candidates.length);
  }
  assert.deepEqual(policy.roles.fast[0], { provider: 'orcarouter', model: 'deepseek/deepseek-v4-flash-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.fast[1], { provider: 'aihubmix', model: 'coding-glm-5.3-flash-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.fast[2], { provider: 'google', model: 'gemini-3.5-flash-lite', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.fast[3], { provider: 'aihubmix', model: 'coding-glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.fast[4], { provider: 'aihubmix', model: 'glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.fast[5], { provider: 'aihubmix', model: 'coding-glm-5.3', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[0], { provider: 'orcarouter', model: 'deepseek/deepseek-v4-flash-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[1], { provider: 'aihubmix', model: 'coding-glm-5.3-flash-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[2], { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' });
  assert.deepEqual(policy.roles.balanced[3], { provider: 'aihubmix', model: 'coding-glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[4], { provider: 'aihubmix', model: 'glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[5], { provider: 'aihubmix', model: 'coding-glm-5.3', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[6], { provider: 'google', model: 'gemini-3.8-flash', effort: 'medium', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.balanced[7], { provider: 'openai-codex', model: 'gpt-5.6-luna', effort: 'max', privacy: 'private-safe' });
  assert.equal(policy.roles.balanced.length, 8);
  assert.equal(policy.roles.deep.length, 9);
  assert.deepEqual(policy.roles.deep[0], { provider: 'opencode-zen', model: 'muse-spark-1.3-contributor-free', effort: 'xhigh', privacy: 'public-only' });
  assert.deepEqual(policy.roles.deep[1], { provider: 'orcarouter', model: 'deepseek/deepseek-v4-flash-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[2], { provider: 'aihubmix', model: 'coding-glm-5.3-free', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[3], { provider: 'browser-chat', model: 'gemini-3.8-flash-ui', effort: 'high', privacy: 'public-only', subagentProvider: 'browser-chat' });
  assert.deepEqual(policy.roles.deep[4], { provider: 'aihubmix', model: 'coding-glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[5], { provider: 'aihubmix', model: 'glm-5.3-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[6], { provider: 'aihubmix', model: 'coding-glm-5.3', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[7], { provider: 'google', model: 'gemini-3.8-flash', effort: 'high', privacy: 'private-safe' });
  assert.deepEqual(policy.roles.deep[8], { provider: 'openai-codex', model: 'gpt-5.6-sol', effort: 'xhigh', privacy: 'private-safe' });
  assert.deepEqual(policy.capacity, [
    { provider: 'opencode-zen', model: 'muse-spark-1.3-contributor-free', maxInFlight: 1 },
    { provider: 'aihubmix', model: 'coding-glm-5.3-flash', maxInFlight: 1 },
    { provider: 'aihubmix', model: 'glm-5.3-flash', maxInFlight: 1 },
    { provider: 'aihubmix', model: 'coding-glm-5.3', maxInFlight: 2 },
  ]);
  assert.equal(policy.schedule, undefined);
});
