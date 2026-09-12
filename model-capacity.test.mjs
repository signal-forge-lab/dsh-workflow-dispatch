import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ModelCapacityLeaseManager } from './model-capacity.js';

const target = { provider: 'opencode-zen', model: 'muse-spark-1.3-contributor-free' };

test('model capacity admits up to maxInFlight and releases idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-capacity-'));
  try {
    const manager = new ModelCapacityLeaseManager({ databasePath: join(directory, 'capacity.sqlite') });
    const one = await manager.tryAcquire(target, 2);
    const two = await manager.tryAcquire(target, 2);
    assert.ok(one);
    assert.ok(two);
    assert.equal(await manager.tryAcquire(target, 2), undefined);
    await one.release();
    await one.release();
    const three = await manager.tryAcquire(target, 2);
    assert.ok(three);
    await two.release();
    await three.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('model capacity is shared across processes and reclaims a crashed owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-capacity-xproc-'));
  const databasePath = join(directory, 'capacity.sqlite');
  const childPath = fileURLToPath(new URL('./model-capacity-child.mjs', import.meta.url));
  const child = spawn(process.execPath, [childPath, databasePath, target.provider, target.model], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    let output = '';
    child.stdout.setEncoding('utf8');
    while (!output.includes('ACQUIRED')) {
      const [chunk] = await once(child.stdout, 'data');
      output += chunk;
    }
    const manager = new ModelCapacityLeaseManager({ databasePath });
    assert.equal(await manager.tryAcquire(target, 1), undefined, 'second process must observe the occupied slot');
    child.kill();
    await once(child, 'exit');
    const recovered = await manager.tryAcquire(target, 1);
    assert.ok(recovered, 'dead owner lease must be reclaimed');
    await recovered.release();
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous cross-process acquisition admits exactly one maxInFlight=1 owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-capacity-race-'));
  const databasePath = join(directory, 'capacity.sqlite');
  const childPath = fileURLToPath(new URL('./model-capacity-child.mjs', import.meta.url));
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [childPath, databasePath, target.provider, target.model], { stdio: ['ignore', 'pipe', 'inherit'] }));
  try {
    const outputs = await Promise.all(children.map(async child => {
      child.stdout.setEncoding('utf8');
      const [chunk] = await once(child.stdout, 'data');
      return String(chunk).trim();
    }));
    assert.equal(outputs.filter(value => value === 'ACQUIRED').length, 1);
    assert.equal(outputs.filter(value => value === 'BUSY').length, 3);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.allSettled(children.map(child => child.exitCode === null ? once(child, 'exit') : Promise.resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
