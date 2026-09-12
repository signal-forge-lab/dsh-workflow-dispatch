import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

function routeKey(candidate) {
  return `${candidate.provider}\0${candidate.model}`;
}

const DEFAULT_ALIASES = Object.freeze({
  'openai-codex': 'codex',
  'browser-chat': 'geminiapps',
  google: 'gemini-api',
});

/** @typedef {{ provider: string, model: string }} RouteCandidate */
/**
 * @typedef {{
 *   now?: number,
 *   minRemainingPercent?: number,
 *   providerUsageLimits?: Array<{ provider: string, maxUsedPercent: number }>,
 *   providerAliases?: Record<string, string>
 * }} SnapshotEvaluationOptions
 */
/**
 * @typedef {{
 *   enabled?: boolean,
 *   minRemainingPercent?: number,
 *   providerUsageLimits?: Array<{ provider: string, maxUsedPercent: number }>,
 *   refreshMs?: number,
 *   timeoutSeconds?: number,
 *   providerAliases?: Record<string, string>,
 *   now?: () => number,
 *   snapshotSource?: () => Promise<any> | any
 * }} UsageAdmissionOptions
 */

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : undefined;
}

function restrictiveWindow(provider) {
  const windows = Array.isArray(provider?.windows) ? provider.windows : [];
  let selected;
  for (const window of windows) {
    if (window?.idle === true) continue;
    const remaining = finitePercent(window?.remainingPercent)
      ?? (finitePercent(window?.usedPercent) === undefined ? undefined : 100 - Number(window.usedPercent));
    if (remaining === undefined) continue;
    if (selected === undefined || remaining < selected.remainingPercent) {
      selected = {
        kind: String(window?.kind ?? ''),
        label: String(window?.label ?? ''),
        remainingPercent: remaining,
        resetAt: typeof window?.resetAt === 'string' ? window.resetAt : undefined,
      };
    }
  }
  return selected;
}

/**
 * @param {any} snapshot
 * @param {RouteCandidate[]} candidates
 * @param {SnapshotEvaluationOptions} [options]
 */
export function evaluateDashboardSnapshot(snapshot, candidates, options) {
  const resolvedOptions = options ?? {};
  const now = resolvedOptions.now ?? Date.now();
  const minRemainingPercent = Math.max(0, Math.min(100, Number(resolvedOptions.minRemainingPercent) || 0));
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.providers)) {
    return { status: 'invalid', skippedRoutes: new Set(), decisions: [] };
  }
  const generatedAt = Date.parse(snapshot.generatedAt);
  const staleAfterSeconds = Number(snapshot.staleAfterSeconds);
  if (!Number.isFinite(generatedAt) || !Number.isFinite(staleAfterSeconds) || staleAfterSeconds <= 0) {
    return { status: 'invalid', skippedRoutes: new Set(), decisions: [] };
  }
  if (now - generatedAt > staleAfterSeconds * 1000) {
    return { status: 'stale', skippedRoutes: new Set(), decisions: [], generatedAt: snapshot.generatedAt };
  }

  const aliases = { ...DEFAULT_ALIASES, ...(resolvedOptions.providerAliases ?? {}) };
  /** @type {Map<string, number>} */
  const providerUsageLimits = new Map((resolvedOptions.providerUsageLimits ?? []).map(rule => {
    const provider = normalize(aliases[normalize(rule.provider)] ?? rule.provider);
    const maxUsedPercent = Math.max(0, Math.min(100, Number(rule.maxUsedPercent) || 0));
    return /** @type {[string, number]} */ ([provider, maxUsedPercent]);
  }));
  const providers = new Map(snapshot.providers.map(provider => [normalize(provider?.id), provider]));
  const skippedRoutes = new Set();
  const decisions = new Array();
  const seen = new Set();
  for (const candidate of candidates ?? []) {
    const key = routeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshotProvider = normalize(aliases[normalize(candidate.provider)] ?? candidate.provider);
    const provider = providers.get(snapshotProvider);
    if (!provider) continue;
    const providerEnabled = Reflect.get(provider, 'enabled');
    const providerError = Reflect.get(provider, 'error');
    const providerUpdatedAtValue = Reflect.get(provider, 'updatedAt');
    if (providerEnabled === false || providerError) continue;
    const providerUpdatedAt = Date.parse(providerUpdatedAtValue);
    if (!Number.isFinite(providerUpdatedAt) || now - providerUpdatedAt > staleAfterSeconds * 1000) continue;
    const window = restrictiveWindow(provider);
    if (!window) continue;
    const exhausted = window.remainingPercent <= 0;
    const belowThreshold = window.remainingPercent < minRemainingPercent;
    const maxUsedPercent = providerUsageLimits.get(snapshotProvider);
    const providerLimitReached = maxUsedPercent != null && window.remainingPercent <= 100 - Number(maxUsedPercent);
    const skipped = exhausted || providerLimitReached || belowThreshold;
    if (skipped) skippedRoutes.add(key);
    decisions.push({
      provider: candidate.provider,
      model: candidate.model,
      snapshotProvider,
      providerUpdatedAt: providerUpdatedAtValue,
      remainingPercent: window.remainingPercent,
      thresholdPercent: minRemainingPercent,
      ...(maxUsedPercent == null ? {} : { maxUsedPercent: Number(maxUsedPercent) }),
      windowKind: window.kind,
      ...(window.resetAt === undefined ? {} : { resetAt: window.resetAt }),
      admitted: !skipped,
      ...(skipped ? { reason: exhausted ? 'usage_exhausted' : providerLimitReached ? 'provider_usage_limit' : 'usage_below_threshold' } : {}),
    });
  }
  const preferredRoutes = decisions
    .filter(decision => decision.admitted !== false)
    .sort((left, right) => left.remainingPercent - right.remainingPercent)
    .map(decision => `${decision.provider}\0${decision.model}`);
  return { status: 'fresh', skippedRoutes, preferredRoutes, decisions, generatedAt: snapshot.generatedAt };
}

async function defaultCliPath() {
  const configured = process.env.CODEXBAR_CLI_PATH?.trim();
  if (configured) return configured;
  const installed = process.env.LOCALAPPDATA?.trim()
    ? [
        join(process.env.LOCALAPPDATA, 'Programs', 'CodexBar', 'codexbar-cli.exe'),
        join(process.env.LOCALAPPDATA, 'Programs', 'CodexBar', 'codexbar.exe'),
      ]
    : [];
  for (const candidate of installed) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return process.platform === 'win32' ? 'codexbar-cli.exe' : 'codexbar';
}

export class CodexBarUsageAdmission {
  enabled;
  minRemainingPercent;
  providerUsageLimits;
  refreshMs;
  timeoutSeconds;
  providerAliases;
  now;
  snapshotSource;
  cache;

  /** @param {UsageAdmissionOptions} [options] */
  constructor(options) {
    const resolvedOptions = options ?? {};
    this.enabled = resolvedOptions.enabled !== false;
    this.minRemainingPercent = Number(resolvedOptions.minRemainingPercent ?? 0);
    this.providerUsageLimits = Array.isArray(resolvedOptions.providerUsageLimits) ? resolvedOptions.providerUsageLimits : [];
    this.refreshMs = Math.max(0, Number(resolvedOptions.refreshMs ?? 60_000));
    this.timeoutSeconds = Math.max(1, Number(resolvedOptions.timeoutSeconds ?? 12));
    this.providerAliases = resolvedOptions.providerAliases ?? {};
    this.now = resolvedOptions.now ?? (() => Date.now());
    this.snapshotSource = resolvedOptions.snapshotSource;
    this.cache = undefined;
  }

  async loadSnapshot() {
    if (this.snapshotSource) return await this.snapshotSource();
    const snapshotPath = process.env.CODEXBAR_DASHBOARD_SNAPSHOT?.trim();
    if (snapshotPath) return JSON.parse(await readFile(snapshotPath, 'utf8'));
    const cli = await defaultCliPath();
    if (!cli) throw new Error('CodexBar CLI is unavailable');
    const { stdout } = await execFileAsync(cli, ['dashboard', '--timeout', String(this.timeoutSeconds)], {
      windowsHide: true,
      timeout: (this.timeoutSeconds + 5) * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  async evaluate(candidates) {
    if (!this.enabled) return { status: 'disabled', skippedRoutes: new Set(), preferredRoutes: [], decisions: [] };
    const now = this.now();
    try {
      if (!this.cache || now - this.cache.loadedAt >= this.refreshMs) {
        this.cache = { loadedAt: now, snapshot: await this.loadSnapshot() };
      }
      return evaluateDashboardSnapshot(this.cache.snapshot, candidates, {
        now,
        minRemainingPercent: this.minRemainingPercent,
        providerUsageLimits: this.providerUsageLimits,
        providerAliases: this.providerAliases,
      });
    } catch (error) {
      return { status: 'unavailable', skippedRoutes: new Set(), preferredRoutes: [], decisions: [], diagnostic: String(error?.message ?? error) };
    }
  }
}
