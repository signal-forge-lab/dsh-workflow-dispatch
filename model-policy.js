const ROLES = ['fast', 'balanced', 'deep'];
const PRIVACY = ['public-only', 'private-safe'];
const SENSITIVITIES = ['public', 'private'];
const DEFAULT_SENSITIVITY = 'public';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown ${label === 'model policy' ? 'key' : `${label} key`} "${key}"`);
  }
}

function parseUtcMinute(value, label) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new Error(`${label} must be HH:MM`);
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function roleName(role) {
  if (!ROLES.includes(role)) throw new Error(`unknown routing role "${role}"`);
  return role;
}

export function candidateKey(candidate) {
  return `${candidate.provider}\0${candidate.model}\0${candidate.effort}\0${candidate.subagentProvider ?? ''}`;
}

function routeKey(candidate) {
  return `${candidate.provider}\0${candidate.model}`;
}

export function modelRouteKey(candidate) {
  return routeKey(candidate);
}

function providerKey(candidate) {
  return candidate.provider;
}

function providerFailure(classification) {
  const base = classification.split(':', 1)[0];
  if (classification.includes('code_no_available_channel')) return false;
  return ['balance_exhausted', 'auth_unavailable', 'transient_provider_error'].includes(base);
}

function rateLimitFailure(classification) {
  return classification?.split(':', 1)[0] === 'rate_limit';
}

function validateCandidateChain(candidates, role, label, options) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`${label} needs at least one candidate`);
  if (candidates.length > 9) throw new Error(`${label} supports at most 9 candidates`);
  const seen = new Set();
  return Object.freeze(candidates.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`${label} candidate ${index + 1} must be an object`);
    assertExactKeys(candidate, ['provider', 'model', 'effort', 'privacy', 'subagentProvider'], 'candidate');
    if (['provider', 'model', 'effort', 'privacy'].some(key => typeof candidate[key] !== 'string' || candidate[key].trim() === '')) throw new Error(`${label} candidate ${index + 1} needs provider, model, effort, and privacy`);
    const normalized = {
      provider: candidate.provider.trim(),
      model: candidate.model.trim(),
      effort: candidate.effort.trim(),
      privacy: candidate.privacy.trim(),
      ...(candidate.subagentProvider === undefined ? {} : { subagentProvider: candidate.subagentProvider.trim() }),
    };
    if (!PRIVACY.includes(normalized.privacy)) throw new Error(`${label} candidate ${index + 1} has invalid privacy`);
    if (!/^\S{1,256}$/u.test(normalized.provider) || !/^\S{1,256}$/u.test(normalized.model)) throw new Error(`${label} candidate ${index + 1} has invalid provider/model shape`);
    if (candidate.subagentProvider !== undefined && (typeof candidate.subagentProvider !== 'string' || !/^\S{1,256}$/u.test(candidate.subagentProvider.trim()))) throw new Error(`${label} candidate ${index + 1} has invalid subagentProvider`);
    const key = candidateKey(normalized);
    if (seen.has(key)) throw new Error(`${label} has a duplicate candidate`);
    if (options.availableRoutes !== undefined && normalized.subagentProvider === undefined) {
      const available = options.availableRoutes;
      const present = typeof available.has === 'function' ? available.has(routeKey(normalized)) : Array.isArray(available) && available.includes(routeKey(normalized));
      if (!present) throw new Error(`${label} candidate ${index + 1} route is not available`);
    }
    seen.add(key);
    return Object.freeze(normalized);
  }));
}

export function validateModelPolicy(value, options = {}) {
  if (!isRecord(value)) throw new Error('model policy must be an object');
  assertExactKeys(value, ['version', 'roles', 'schedule', 'capacity'], 'model policy');
  if (value.version !== 1 || !isRecord(value.roles)) throw new Error('model policy must have version 1 and roles');
  for (const role of Object.keys(value.roles)) {
    if (!ROLES.includes(role)) throw new Error(`unknown role "${role}" in model policy`);
  }
  const roles = {};
  for (const role of ROLES) roles[role] = validateCandidateChain(value.roles[role], role, role, options);

  let capacity;
  if (value.capacity !== undefined) {
    if (!Array.isArray(value.capacity)) throw new Error('capacity must be an array');
    const seen = new Set();
    capacity = Object.freeze(value.capacity.map((rule, index) => {
      if (!isRecord(rule)) throw new Error(`capacity rule ${index + 1} must be an object`);
      assertExactKeys(rule, ['provider', 'model', 'maxInFlight'], 'capacity rule');
      if (typeof rule.provider !== 'string' || rule.provider.trim() === '' || typeof rule.model !== 'string' || rule.model.trim() === '') throw new Error(`capacity rule ${index + 1} needs provider and model`);
      if (!Number.isSafeInteger(rule.maxInFlight) || rule.maxInFlight <= 0) throw new Error(`capacity rule ${index + 1} maxInFlight must be a positive safe integer`);
      const normalized = Object.freeze({ provider: rule.provider.trim(), model: rule.model.trim(), maxInFlight: rule.maxInFlight });
      const key = routeKey(normalized);
      if (seen.has(key)) throw new Error('capacity has a duplicate provider/model rule');
      seen.add(key);
      return normalized;
    }));
  }

  let schedule;
  if (value.schedule !== undefined) {
    if (!isRecord(value.schedule)) throw new Error('schedule must be an object');
    assertExactKeys(value.schedule, ['id', 'timezone', 'defaultWindow', 'matchedWindow', 'ranges', 'roleOverrides'], 'schedule');
    const { id, timezone, defaultWindow, matchedWindow, ranges, roleOverrides } = value.schedule;
    if (typeof id !== 'string' || !/^[A-Za-z0-9._~-]{1,64}$/u.test(id)) throw new Error('schedule id is invalid');
    if (timezone !== 'UTC') throw new Error('schedule timezone must be UTC');
    if (typeof defaultWindow !== 'string' || defaultWindow.trim() === '' || typeof matchedWindow !== 'string' || matchedWindow.trim() === '') throw new Error('schedule windows need names');
    if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > 8) throw new Error('schedule needs 1 to 8 ranges');
    const normalizedRanges = ranges.map((range, index) => {
      if (!isRecord(range)) throw new Error(`schedule range ${index + 1} must be an object`);
      assertExactKeys(range, ['start', 'end'], 'schedule range');
      const startMinute = parseUtcMinute(range.start, `schedule range ${index + 1} start`);
      const endMinute = parseUtcMinute(range.end, `schedule range ${index + 1} end`);
      if (startMinute >= endMinute) throw new Error(`schedule range ${index + 1} must end after it starts`);
      return Object.freeze({ start: range.start, end: range.end, startMinute, endMinute });
    }).sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < normalizedRanges.length; index += 1) {
      if (normalizedRanges[index].startMinute < normalizedRanges[index - 1].endMinute) throw new Error('schedule ranges must not overlap');
    }
    if (!isRecord(roleOverrides) || Object.keys(roleOverrides).length === 0) throw new Error('schedule roleOverrides must be a non-empty object');
    const normalizedOverrides = {};
    for (const [role, candidates] of Object.entries(roleOverrides)) {
      if (!ROLES.includes(role)) throw new Error(`unknown role "${role}" in schedule roleOverrides`);
      normalizedOverrides[role] = validateCandidateChain(candidates, role, `schedule ${role}`, options);
    }
    schedule = Object.freeze({
      id,
      timezone,
      defaultWindow: defaultWindow.trim(),
      matchedWindow: matchedWindow.trim(),
      ranges: Object.freeze(normalizedRanges),
      roleOverrides: Object.freeze(normalizedOverrides),
    });
  }
  return Object.freeze({ version: 1, roles: Object.freeze(roles), ...(capacity === undefined ? {} : { capacity }), ...(schedule === undefined ? {} : { schedule }) });
}

function scheduleMatches(schedule, nowMs) {
  if (schedule === undefined) return false;
  const date = new Date(nowMs);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return schedule.ranges.some(range => minute >= range.startMinute && minute < range.endMinute);
}

function routingSnapshot(policy, role, nowMs) {
  const schedule = policy.schedule;
  const matched = scheduleMatches(schedule, nowMs);
  return {
    candidates: matched && schedule?.roleOverrides[role] !== undefined ? schedule.roleOverrides[role] : policy.roles[role],
    pricingWindow: schedule === undefined ? 'default' : matched ? schedule.matchedWindow : schedule.defaultWindow,
    scheduleRule: schedule?.id,
  };
}

export class RoutingExhaustedError extends Error {
  constructor(role, phaseKey, candidates) {
    super(`routing exhausted for ${role}${phaseKey === undefined ? '' : ` phase ${phaseKey}`}`);
    this.name = 'RoutingExhaustedError';
    this.code = 'bounded_exhaustion';
    this.role = role;
    this.phaseKey = phaseKey;
    this.candidateChain = candidates;
  }
}

export class ModelPolicyResolver {
  constructor(source, options = {}) {
    this.source = typeof source === 'function' ? source : () => source;
    this.now = options.now ?? (() => Date.now());
    this.circuitTtlMs = options.circuitTtlMs ?? 300_000;
    this.phaseTtlMs = options.phaseTtlMs ?? 3_600_000;
    this.availableRoutes = options.availableRoutes;
    this.routeValidator = options.routeValidator;
    this.circuits = new Map();
    this.providerCircuits = new Map();
    this.phases = new Map();
    this.phaseInitializations = new Map();
    this.policy = validateModelPolicy(this.source(), { ...(this.availableRoutes === undefined ? {} : { availableRoutes: this.availableRoutes }) });
  }

  reload() {
    this.policy = validateModelPolicy(this.source(), { ...(this.availableRoutes === undefined ? {} : { availableRoutes: this.availableRoutes }) });
    this.prune();
    return this.policy;
  }

  async preflight(policy) {
    if (this.routeValidator === undefined) return;
    const candidateSets = [...Object.entries(policy.roles)];
    if (policy.schedule !== undefined) candidateSets.push(...Object.entries(policy.schedule.roleOverrides));
    for (const [role, candidates] of candidateSets) {
      for (const candidate of candidates) {
        if (candidate.subagentProvider !== undefined) continue;
        let available = false;
        try {
          available = await this.routeValidator(candidate, role);
        } catch (error) {
          throw new Error(`model policy route preflight failed for ${role} candidate ${candidate.provider}/${candidate.model}`, { cause: error });
        }
        const key = candidateKey(candidate);
        const existing = this.circuits.get(key);
        if (available === true) {
          if (existing?.classification === 'model_unavailable:preflight') this.circuits.delete(key);
          continue;
        }
        const now = this.now();
        this.circuits.set(key, {
          until: now + this.circuitTtlMs,
          classification: 'model_unavailable:preflight',
          generation: (existing?.generation ?? 0) + 1,
        });
      }
    }
  }

  phaseId(role, phaseKey) {
    return phaseKey === undefined ? undefined : `${role}\0${phaseKey}`;
  }

  circuitState(candidate) {
    const state = this.circuits.get(candidateKey(candidate));
    if (state === undefined || state.until <= this.now()) {
      this.circuits.delete(candidateKey(candidate));
    }
    const providerState = this.providerCircuits.get(providerKey(candidate));
    if (providerState === undefined || providerState.until <= this.now()) {
      this.providerCircuits.delete(providerKey(candidate));
    }
    if (this.circuits.has(candidateKey(candidate)) || this.providerCircuits.has(providerKey(candidate))) {
      return 'open';
    }
    return 'closed';
  }

  async beginPhase(role, phaseKey, sensitivity = DEFAULT_SENSITIVITY) {
    const resolvedRole = roleName(role);
    if (!SENSITIVITIES.includes(sensitivity)) throw new Error(`invalid phase sensitivity "${sensitivity}"`);
    this.prune();
    const id = this.phaseId(resolvedRole, phaseKey);
    const existing = id === undefined ? undefined : this.phases.get(id);
    if (existing !== undefined) {
      if (existing.sensitivity !== sensitivity) throw new Error(`phase ${phaseKey} sensitivity cannot change`);
      return this.select(resolvedRole, phaseKey);
    }
    if (id === undefined) {
      this.reload();
      await this.preflight(this.policy);
      return this.select(resolvedRole, phaseKey, sensitivity);
    }
    const pending = this.phaseInitializations.get(id);
    if (pending !== undefined) {
      await pending;
      const initialized = this.phases.get(id);
      if (initialized?.sensitivity !== sensitivity) throw new Error(`phase ${phaseKey} sensitivity cannot change`);
      return this.select(resolvedRole, phaseKey);
    }
    const initialization = (async () => {
      this.reload();
      await this.preflight(this.policy);
      const snapshot = routingSnapshot(this.policy, resolvedRole, this.now());
      this.phases.set(id, {
        candidates: Object.freeze([...snapshot.candidates]),
        sensitivity,
        index: 0,
        usagePreferenceApplied: false,
        lastUsed: this.now(),
        pricingWindow: snapshot.pricingWindow,
        scheduleRule: snapshot.scheduleRule,
      });
    })();
    this.phaseInitializations.set(id, initialization);
    try {
      await initialization;
    } finally {
      if (this.phaseInitializations.get(id) === initialization) this.phaseInitializations.delete(id);
    }
    return this.select(resolvedRole, phaseKey);
  }

  select(role, phaseKey, sensitivity = DEFAULT_SENSITIVITY) {
    return this.selectWithOptions(role, phaseKey, sensitivity, {});
  }

  selectWithOptions(role, phaseKey, sensitivity = DEFAULT_SENSITIVITY, options = {}) {
    const resolvedRole = roleName(role);
    this.prune();
    const id = this.phaseId(resolvedRole, phaseKey);
    const state = id === undefined ? undefined : this.phases.get(id);
    const snapshot = state === undefined ? routingSnapshot(this.policy, resolvedRole, this.now()) : undefined;
    const candidates = state?.candidates ?? snapshot.candidates;
    const phaseSensitivity = state?.sensitivity ?? sensitivity;
    const skipRoutes = options.skipRoutes ?? new Set();
    let index = state?.index ?? 0;
    while (index < candidates.length && (
      phaseSensitivity === 'private' && candidates[index].privacy !== 'private-safe'
      || this.circuitState(candidates[index]) === 'open'
      || skipRoutes.has(routeKey(candidates[index]))
    )) index += 1;
    if (index >= candidates.length) throw new RoutingExhaustedError(resolvedRole, phaseKey, candidates);
    if (state !== undefined && options.commit !== false) {
      state.index = index;
      state.lastUsed = this.now();
    }
    return {
      role: resolvedRole,
      phaseKey,
      target: candidates[index],
      candidateChain: candidates,
      index,
      attempt: index + 1,
      circuitGeneration: this.circuits.get(candidateKey(candidates[index]))?.generation ?? 0,
      providerCircuitGeneration: this.providerCircuits.get(providerKey(candidates[index]))?.generation ?? 0,
      circuitState: this.circuitState(candidates[index]),
      pricingWindow: state === undefined ? snapshot.pricingWindow : state.pricingWindow,
      scheduleRule: state === undefined ? snapshot.scheduleRule : state.scheduleRule,
    };
  }

  capacityLimit(candidate) {
    return this.policy.capacity?.find(rule => routeKey(rule) === routeKey(candidate))?.maxInFlight;
  }

  /** @param {string[]} [preferredRoutes] */
  reprioritizePhase(role, phaseKey, preferredRoutes) {
    const resolvedRole = roleName(role);
    const orderedRoutes = Array.isArray(preferredRoutes) ? preferredRoutes.map(String) : [];
    const id = this.phaseId(resolvedRole, phaseKey);
    if (id === undefined) return false;
    const state = this.phases.get(id);
    if (state === undefined) throw new Error(`usage reprioritization requires an initialized ${resolvedRole} phase`);
    if (state.usagePreferenceApplied === true) return false;
    state.usagePreferenceApplied = true;
    if (orderedRoutes.length === 0) return false;
    state.candidates = Object.freeze([...state.candidates].sort((left, right) => {
      const leftRank = orderedRoutes.indexOf(routeKey(left));
      const rightRank = orderedRoutes.indexOf(routeKey(right));
      if (leftRank < 0 && rightRank < 0) return 0;
      if (leftRank < 0) return 1;
      if (rightRank < 0) return -1;
      return leftRank - rightRank;
    }));
    state.index = 0;
    state.lastUsed = this.now();
    return true;
  }

  nextRateLimitRecovery(role, phaseKey, sensitivity = DEFAULT_SENSITIVITY) {
    const resolvedRole = roleName(role);
    this.prune();
    const id = this.phaseId(resolvedRole, phaseKey);
    const state = id === undefined ? undefined : this.phases.get(id);
    const snapshot = state === undefined ? routingSnapshot(this.policy, resolvedRole, this.now()) : undefined;
    const candidates = state?.candidates ?? snapshot.candidates;
    const phaseSensitivity = state?.sensitivity ?? sensitivity;
    const now = this.now();
    let recovery;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (phaseSensitivity === 'private' && candidate.privacy !== 'private-safe') continue;
      const candidateState = this.circuits.get(candidateKey(candidate));
      if (candidateState === undefined || candidateState.until <= now || !rateLimitFailure(candidateState.classification)) continue;
      const providerState = this.providerCircuits.get(providerKey(candidate));
      if (providerState !== undefined && providerState.until > now && !rateLimitFailure(providerState.classification)) continue;
      const until = Math.max(candidateState.until, providerState?.until ?? 0);
      if (recovery === undefined || until < recovery.until || (until === recovery.until && index < recovery.index)) {
        recovery = { index, waitMs: Math.max(0, until - now), until };
      }
    }
    return recovery;
  }

  resumeRateLimitRecovery(role, phaseKey, index) {
    const resolvedRole = roleName(role);
    const id = this.phaseId(resolvedRole, phaseKey);
    if (id === undefined) throw new Error('rate-limit recovery requires a phase key');
    const state = this.phases.get(id);
    if (state === undefined || state.candidates[index] === undefined) throw new Error(`rate-limit recovery requires an initialized ${resolvedRole} phase candidate`);
    state.index = Math.min(state.index, index);
    state.lastUsed = this.now();
  }

  recordFailure({ role, phaseKey, index, classification, advancePhase = true }) {
    const resolvedRole = roleName(role);
    const id = this.phaseId(resolvedRole, phaseKey);
    const phase = id === undefined ? undefined : this.phases.get(id);
    const candidates = phase?.candidates ?? this.policy.roles[resolvedRole];
    const candidate = candidates[index];
    if (candidate === undefined) throw new Error(`unknown candidate ${index + 1} for ${resolvedRole}`);
    const now = this.now();
    const key = candidateKey(candidate);
    this.circuitState(candidate);
    const generation = (this.circuits.get(key)?.generation ?? 0) + 1;
    this.circuits.set(key, { until: now + this.circuitTtlMs, classification, generation });
    if (providerFailure(classification)) {
      const provider = providerKey(candidate);
      const providerGeneration = (this.providerCircuits.get(provider)?.generation ?? 0) + 1;
      this.providerCircuits.set(provider, { until: now + this.circuitTtlMs, classification, generation: providerGeneration });
    }
    if (id !== undefined && advancePhase) {
      const snapshot = routingSnapshot(this.policy, resolvedRole, now);
      const state = this.phases.get(id) ?? { candidates: Object.freeze([...candidates]), sensitivity: DEFAULT_SENSITIVITY, index, lastUsed: now, pricingWindow: snapshot.pricingWindow, scheduleRule: snapshot.scheduleRule };
      state.index = Math.max(state.index, index + 1);
      state.lastUsed = now;
      this.phases.set(id, state);
    }
    return { circuitState: 'open', until: now + this.circuitTtlMs };
  }

  advanceForQuality({ role, phaseKey, index, skipRoutes = new Set() }) {
    const resolvedRole = roleName(role);
    const id = this.phaseId(resolvedRole, phaseKey);
    if (id === undefined) throw new Error('quality escalation requires a phase key');
    const state = this.phases.get(id);
    if (state === undefined) throw new Error(`quality escalation requires an initialized ${resolvedRole} phase`);
    let nextIndex = index + 1;
    while (state.candidates[nextIndex]?.subagentProvider !== undefined) nextIndex += 1;
    state.index = Math.max(state.index, nextIndex);
    state.lastUsed = this.now();
    return this.selectWithOptions(resolvedRole, phaseKey, state.sensitivity, { skipRoutes });
  }

  recordSuccess({ role, phaseKey, index, circuitGeneration = 0, providerCircuitGeneration = 0, advancePhase = true }) {
    const resolvedRole = roleName(role);
    const id = this.phaseId(resolvedRole, phaseKey);
    const phase = id === undefined ? undefined : this.phases.get(id);
    const candidate = (phase?.candidates ?? this.policy.roles[resolvedRole])[index];
    if (candidate === undefined) throw new Error(`unknown candidate ${index + 1} for ${resolvedRole}`);
    const key = candidateKey(candidate);
    this.circuitState(candidate);
    const circuit = this.circuits.get(key);
    if (circuit === undefined || circuit.generation === circuitGeneration) this.circuits.delete(key);
    const provider = providerKey(candidate);
    const providerCircuit = this.providerCircuits.get(provider);
    if (providerCircuit === undefined || providerCircuit.generation === providerCircuitGeneration) this.providerCircuits.delete(provider);
    if (id !== undefined && advancePhase) {
      const snapshot = routingSnapshot(this.policy, resolvedRole, this.now());
      const state = this.phases.get(id) ?? { candidates: Object.freeze([...(phase?.candidates ?? snapshot.candidates)]), sensitivity: DEFAULT_SENSITIVITY, index, lastUsed: this.now(), pricingWindow: snapshot.pricingWindow, scheduleRule: snapshot.scheduleRule };
      state.index = Math.max(state.index, index);
      state.lastUsed = this.now();
      this.phases.set(id, state);
    }
    return { circuitState: this.circuitState(candidate) };
  }

  prune() {
    const now = this.now();
    for (const [key, state] of this.circuits) if (state.until <= now) this.circuits.delete(key);
    for (const [key, state] of this.providerCircuits) if (state.until <= now) this.providerCircuits.delete(key);
    for (const [key, state] of this.phases) if (state.lastUsed + this.phaseTtlMs <= now) this.phases.delete(key);
  }
}
