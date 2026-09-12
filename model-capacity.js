import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_capacity_leases (
  route TEXT NOT NULL,
  slot INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  pid INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (route, slot)
) STRICT;
`;

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function defaultDatabasePath() {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(dshHome, 'model-capacity', 'iw-dsh-workflow-dispatch.sqlite');
}

function routeHash(target) {
  return createHash('sha256').update(`${String(target.provider)}\0${String(target.model)}`).digest('hex');
}

function sqliteBusy(error) {
  return error?.code === 'ERR_SQLITE_ERROR' && /database is locked|database is busy/i.test(String(error?.message ?? ''));
}

export class ModelCapacityLeaseManager {
  databasePath;
  processId;
  instanceId;
  processAlive;
  now;

  constructor({
    databasePath = defaultDatabasePath(),
    processId = process.pid,
    instanceId = randomUUID(),
    processAlive = defaultProcessAlive,
    now = () => Date.now(),
  } = {}) {
    this.databasePath = databasePath;
    this.processId = processId;
    this.instanceId = instanceId;
    this.processAlive = processAlive;
    this.now = now;
    mkdirSync(dirname(this.databasePath), { recursive: true });
    const db = this.openDatabase(1_000);
    try {
      db.exec(SCHEMA);
    } finally {
      db.close();
    }
  }

  openDatabase(timeoutMs) {
    const db = new DatabaseSync(this.databasePath);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeoutMs))}`);
    return db;
  }

  async tryAcquire(target, maxInFlight) {
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) throw new Error('model capacity maxInFlight must be a positive safe integer');
    const route = routeHash(target);
    const db = this.openDatabase(50);
    let transaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transaction = true;
      const rows = db.prepare('SELECT slot, token, pid FROM model_capacity_leases WHERE route = ? ORDER BY slot').all(route);
      const remove = db.prepare('DELETE FROM model_capacity_leases WHERE route = ? AND slot = ? AND token = ?');
      const active = rows.filter(row => {
        if (this.processAlive(Number(row.pid))) return true;
        remove.run(route, row.slot, row.token);
        return false;
      });
      if (active.length >= maxInFlight) {
        db.exec('COMMIT');
        transaction = false;
        return undefined;
      }
      const occupied = new Set(active.map(row => Number(row.slot)));
      let slot = 0;
      while (occupied.has(slot)) slot += 1;
      const token = randomUUID();
      db.prepare(`
        INSERT INTO model_capacity_leases (route, slot, token, pid, instance_id, provider, model, acquired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(route, slot, token, this.processId, this.instanceId, String(target.provider), String(target.model), this.now());
      db.exec('COMMIT');
      transaction = false;
      let released = false;
      return {
        slot,
        maxInFlight,
        release: async () => {
          if (released) return;
          this.releaseToken(token);
          released = true;
        },
      };
    } catch (error) {
      if (transaction) {
        try { db.exec('ROLLBACK'); } catch { /* best effort */ }
      }
      if (sqliteBusy(error)) return undefined;
      throw error;
    } finally {
      db.close();
    }
  }

  releaseToken(token) {
    const db = this.openDatabase(1_000);
    try {
      db.prepare('DELETE FROM model_capacity_leases WHERE token = ?').run(token);
    } finally {
      db.close();
    }
  }
}
