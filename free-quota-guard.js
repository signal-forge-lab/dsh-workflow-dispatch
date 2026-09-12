import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function usageTokens(usage = {}) {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.reasoningTokens,
  ].reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
  } catch {
    return 0;
  }
}
export function estimateReservation(options, defaultMaxTokens = 32768) {
  const inputBytes =
    Buffer.byteLength(String(options.system ?? ''), 'utf8') +
    jsonBytes(options.messages) +
    jsonBytes(options.tools);
  const maxTokens = Number(options.maxTokens) > 0
    ? Number(options.maxTokens)
    : defaultMaxTokens;
  // One UTF-8 byte == one reserved input token is intentionally conservative.
  return Math.ceil(inputBytes) + Math.ceil(maxTokens);
}

export function containsImage(options) {
  const stack = [...(options.messages ?? [])];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (value.type === 'image') return true;
    if (Array.isArray(value)) stack.push(...value);
    else stack.push(...Object.values(value));
  }
  return false;
}

export function findQuotaRule(rules, provider, model) {
  const p = normalize(provider);
  const m = normalize(model);
  return rules.find(rule =>
    normalize(rule.provider) === p &&
    rule.models.some(candidate => normalize(candidate) === m)
  );
}
function defaultLedgerPath() {
  return path.join(os.homedir(), '.dsh', 'state', 'iw-openai-free-quota.json');
}

function blankState(day) {
  return { version: 1, day, groups: {} };
}

async function readState(file, day) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed?.version === 1 && parsed.day === day && parsed.groups) return parsed;
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.name !== 'SyntaxError') throw error;
  }
  return blankState(day);
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temp, file);
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
async function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(lock, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(lock).catch(() => {});
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > 30000) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {}
      await sleep(20);
    }
  }
  throw new Error('FREE_QUOTA_GUARD lock timeout');
}
function guardError(message) {
  const error = new Error(`FREE_QUOTA_GUARD ${message}`);
  error.code = 'FREE_QUOTA_GUARD';
  return error;
}

export class FreeQuotaGuard {
  constructor(rules = [], ledgerPath = defaultLedgerPath()) {
    this.rules = rules;
    this.ledgerPath = ledgerPath;
  }

  async reserve(rule, options) {
    const day = utcDay();
    const amount = estimateReservation(options, rule.defaultMaxTokensReserve);
    await withFileLock(this.ledgerPath, async () => {
      const state = await readState(this.ledgerPath, day);
      const group = state.groups[rule.group] ?? { used: 0 };
      const used = Number(group.used) || 0;
      if (used + amount > rule.safetyLimit) {
        throw guardError(
          `${rule.group} daily safety limit: used=${used}, reserve=${amount}, limit=${rule.safetyLimit}`,
        );
      }
      state.groups[rule.group] = {
        used: used + amount,
        safetyLimit: rule.safetyLimit,
        updatedAt: new Date().toISOString(),
      };
      await writeState(this.ledgerPath, state);
    });
    return { day, amount };
  }
  async reconcile(rule, reservation, actual) {
    if (!Number.isFinite(actual) || actual < 0) return;
    await withFileLock(this.ledgerPath, async () => {
      const today = utcDay();
      if (today !== reservation.day) return;
      const state = await readState(this.ledgerPath, today);
      const group = state.groups[rule.group] ?? { used: 0 };
      const used = Number(group.used) || 0;
      state.groups[rule.group] = {
        used: Math.max(0, used - reservation.amount + actual),
        safetyLimit: rule.safetyLimit,
        updatedAt: new Date().toISOString(),
      };
      await writeState(this.ledgerPath, state);
    });
  }

  wrap(options, next) {
    const rule = findQuotaRule(this.rules, options.provider, options.model);
    if (!rule) return next();
    const self = this;
    return (async function* guardedStream() {
      if (rule.rejectTools && (options.tools?.length ?? 0) > 0) {
        throw guardError(`${rule.group} rejects tool-bearing requests`);
      }
      if (rule.rejectImages && containsImage(options)) {
        throw guardError(`${rule.group} rejects image-bearing requests`);
      }
      const reservation = await self.reserve(rule, options);
      let actual;
      try {
        for await (const chunk of next()) {
          if (chunk?.type === 'usage') actual = usageTokens(chunk.usage);
          yield chunk;
        }
      } finally {
        if (actual !== undefined) await self.reconcile(rule, reservation, actual);
      }
    })();
  }
}
