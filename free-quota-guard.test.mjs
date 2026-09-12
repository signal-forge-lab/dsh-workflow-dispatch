import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FreeQuotaGuard,
  estimateReservation,
  usageTokens,
  utcDay,
} from './free-quota-guard.js';

const rule = {
  provider: 'openai',
  group: 'sol',
  models: ['gpt-5.6-sol'],
  safetyLimit: 220000,
  defaultMaxTokensReserve: 32768,
  rejectTools: true,
  rejectImages: true,
};

test('usage accounting is conservative', () => {
  assert.equal(usageTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 }), 15);
  assert.ok(estimateReservation({ messages: [], maxTokens: 100 }) >= 100);
});
test('tool-bearing free request is blocked before network dispatch', async () => {
  const guard = new FreeQuotaGuard([rule], path.join(os.tmpdir(), `iw-quota-tool-${process.pid}.json`));
  let nextCalled = false;
  const stream = guard.wrap({
    provider: 'openai',
    model: 'gpt-5.6-sol',
    messages: [],
    tools: [{ name: 'noop' }],
    maxTokens: 10,
  }, () => {
    nextCalled = true;
    return (async function* empty() {})();
  });
  await assert.rejects(async () => {
    for await (const _ of stream) {}
  }, /FREE_QUOTA_GUARD.*rejects tool-bearing/);
  assert.equal(nextCalled, false);
});

test('successful usage reconciles a conservative reservation', async () => {
  const ledger = path.join(os.tmpdir(), `iw-quota-usage-${process.pid}.json`);
  await fs.rm(ledger, { force: true });
  await fs.rm(`${ledger}.lock`, { force: true });
  const guard = new FreeQuotaGuard([rule], ledger);
  const stream = guard.wrap({
    provider: 'openai',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxTokens: 100,
  }, () => (async function* response() {
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } };
  })());
  for await (const _ of stream) {}
  const state = JSON.parse(await fs.readFile(ledger, 'utf8'));
  assert.equal(state.day, utcDay());
  assert.equal(state.groups.sol.used, 10);
  await fs.rm(ledger, { force: true });
  await fs.rm(`${ledger}.lock`, { force: true });
});

test('request is blocked before dispatch when reservation exceeds safety limit', async () => {
  const ledger = path.join(os.tmpdir(), `iw-quota-limit-${process.pid}.json`);
  const guard = new FreeQuotaGuard([{ ...rule, safetyLimit: 50 }], ledger);
  let nextCalled = false;
  const stream = guard.wrap({ provider: 'openai', model: 'gpt-5.6-sol', messages: [], maxTokens: 100 }, () => {
    nextCalled = true;
    return (async function* empty() {})();
  });
  await assert.rejects(async () => { for await (const _ of stream) {} }, /daily safety limit/);
  assert.equal(nextCalled, false);
});
