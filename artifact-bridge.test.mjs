import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ArtifactBridge, artifactBridgeMode } from './artifact-bridge.js';

const execFileAsync = promisify(execFile);

async function fixtureRepo(prefix, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, prefix));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.js'), 'export const answer = 42;\n');
  await writeFile(join(root, 'private-key.txt'), 'excluded fixture\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
  await execFileAsync('git', ['add', '.'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

function request(root, extra = {}) {
  return {
    parent: { session: { header: { id: 'parent-1', cwd: root } } },
    prompt: [{ type: 'text', text: 'Review and update src/a.js for correctness.' }],
    ...extra,
  };
}

test('artifact bridge classifies direct, read-only, mutation, and explicit local-tool tasks', () => {
  const base = { prompt: [{ type: 'text', text: 'review src/a.js' }] };
  assert.equal(artifactBridgeMode({ ...base, toolFilter: { allow: [] } }), 'direct');
  assert.equal(artifactBridgeMode({ ...base, toolFilter: { allow: ['read', 'grep'] } }), 'read-only');
  assert.equal(artifactBridgeMode({ ...base, toolFilter: { allow: ['read', 'grep'] }, outputSchema: { type: 'object' } }), 'read-only');
  assert.equal(artifactBridgeMode(base), 'mutation');
  assert.equal(artifactBridgeMode({ ...base, toolFilter: { allow: ['exec_command'] } }), 'local-only');
  assert.equal(artifactBridgeMode({ ...base, outputSchema: { type: 'object' } }), 'local-only');
});

test('read-only workspace materializes safe tracked files and gives Browser Chat only the G-drive path', async () => {
  const root = await fixtureRepo('artifact-workspace-source-');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-workspace-stage-'));
  try {
    const bridge = new ArtifactBridge({ workspaceRoot, maxFiles: 100 });
    const plan = await bridge.prepare(request(root, { toolFilter: { allow: ['read', 'grep'] } }));
    assert.equal(plan.mode, 'read-only');
    assert.equal(await readFile(join(plan.stageRoot, 'src', 'a.js'), 'utf8'), 'export const answer = 42;\n');
    await assert.rejects(access(join(plan.stageRoot, 'private-key.txt')));

    const browser = bridge.browserRequest(request(root), plan);
    const browserText = browser.prompt[0].text;
    assert.match(browserText, new RegExp(`Gドライブのルート\\\\${basename(plan.workspaceRoot)}\\\\${basename(plan.stageRoot)}`));
    assert.doesNotMatch(browserText, /export const answer = 42/u);
    assert.match(browserText, /Git操作は禁止/u);
    assert.ok(browserText.indexOf('--- DSH FILE WORKSPACE CONTRACT ---') < browserText.indexOf('Review and update src/a.js for correctness.'));
    assert.equal(browser.outputSchema, undefined);

    await bridge.cleanup(plan);
    await assert.rejects(access(plan.stageRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('default mirrored My Drive workspace addresses the staged session directly under Drive root', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'artifact-drive-default-'));
  const workspaceContainer = join(temp, 'workspace-container');
  await mkdir(workspaceContainer, { recursive: true });
  const root = await fixtureRepo('source-', workspaceContainer);
  const workspaceRoot = join(workspaceContainer, 'browser-chat-workspace');
  await mkdir(workspaceRoot, { recursive: true });
  try {
    const bridge = new ArtifactBridge({ maxFiles: 100 });
    const plan = await bridge.prepare(request(root, { toolFilter: { allow: ['read', 'grep'] } }));
    assert.equal(plan.workspaceRoot, workspaceRoot);
    const browser = bridge.browserRequest(request(root), plan);
    const expected = `Gドライブのルート\\${basename(plan.stageRoot)}`;
    assert.ok(browser.prompt[0].text.includes(expected), browser.prompt[0].text);
    assert.ok(!browser.prompt[0].text.includes(`Gドライブのルート\\browser-chat-workspace\\`), browser.prompt[0].text);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('workspace materialization fails closed instead of silently truncating tracked files', async () => {
  const root = await fixtureRepo('artifact-limit-source-');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-limit-stage-'));
  try {
    const bridge = new ArtifactBridge({ workspaceRoot, maxFiles: 1 });
    const plan = await bridge.prepare(request(root, { toolFilter: { allow: ['read'] } }));
    assert.equal(plan.mode, 'local-only');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('mutation workspace applies staged edits and new safe files without using a model-generated patch', async () => {
  const root = await fixtureRepo('artifact-mutation-source-');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-mutation-stage-'));
  try {
    const bridge = new ArtifactBridge({ workspaceRoot, maxFiles: 100 });
    const plan = await bridge.prepare(request(root));
    await writeFile(join(plan.stageRoot, 'src', 'a.js'), 'export const answer = 43;\n');
    await mkdir(join(plan.stageRoot, 'docs'));
    await writeFile(join(plan.stageRoot, 'docs', 'result.txt'), 'created by browser chat\n');

    const result = await bridge.finalizeMutation(plan, {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'Updated the requested files.' }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.paths.sort(), ['docs/result.txt', 'src/a.js']);
    assert.equal(await readFile(join(root, 'src', 'a.js'), 'utf8'), 'export const answer = 43;\n');
    assert.equal(await readFile(join(root, 'docs', 'result.txt'), 'utf8'), 'created by browser chat\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('mutation workspace falls back to a validated unified diff when Spark cannot write staged files', async () => {
  const root = await fixtureRepo('artifact-patch-fallback-source-');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-patch-fallback-stage-'));
  try {
    const bridge = new ArtifactBridge({ workspaceRoot, maxFiles: 100 });
    const plan = await bridge.prepare(request(root));
    const browser = bridge.browserRequest(request(root), plan);
    assert.equal(browser.outputSchema, undefined);
    assert.match(browser.prompt[0].text, /unified diff/u);
    assert.match(browser.prompt[0].text, /Drive workspace is READ-ONLY/u);
    assert.match(browser.prompt[0].text, /Do not use Drive write, create, update, delete, or rename operations/u);
    assert.match(browser.prompt[0].text, /do not use Computer, Python, code execution, Google Workspace Search, web search/u);
    assert.match(browser.prompt[0].text, /return the requested JSON immediately/u);
    assert.ok(browser.prompt[0].text.indexOf('Drive workspace is READ-ONLY') < browser.prompt[0].text.indexOf('Review and update src/a.js for correctness.'));

    const result = await bridge.finalizeMutation(plan, {
      stopReason: 'completed',
      output: [{
        type: 'text',
        text: String.raw`{"status":"patch","summary":"updated answer\ No newline at end of file","patch":"--- src/a.js\n+++ src/a.js\n@@ -1 +1 @@\n-export const answer = 42;\n+export const answer = 44;","tests":[]}`,
      }],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.paths, ['src/a.js']);
    assert.equal((await readFile(join(root, 'src', 'a.js'), 'utf8')).replace(/\r\n/g, '\n'), 'export const answer = 44;\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('mutation workspace rejects concurrent source changes and unsafe created paths', async () => {
  const root = await fixtureRepo('artifact-conflict-source-');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-conflict-stage-'));
  try {
    const bridge = new ArtifactBridge({ workspaceRoot, maxFiles: 100 });
    const conflict = await bridge.prepare(request(root));
    await writeFile(join(conflict.stageRoot, 'src', 'a.js'), 'browser edit\n');
    await writeFile(join(root, 'src', 'a.js'), 'concurrent edit\n');
    const conflictResult = await bridge.finalizeMutation(conflict, { stopReason: 'completed', output: [] });
    assert.equal(conflictResult.ok, false);
    assert.match(conflictResult.reason, /source changed after materialization/u);
    assert.equal(await readFile(join(root, 'src', 'a.js'), 'utf8'), 'concurrent edit\n');

    await writeFile(join(root, 'src', 'a.js'), 'export const answer = 42;\n');
    const unsafe = await bridge.prepare(request(root));
    await writeFile(join(unsafe.stageRoot, 'private-key-new.txt'), 'unsafe browser output\n');
    const unsafeResult = await bridge.finalizeMutation(unsafe, { stopReason: 'completed', output: [] });
    assert.equal(unsafeResult.ok, false);
    assert.match(unsafeResult.reason, /unsafe staged path/u);
    await assert.rejects(access(join(root, 'private-key-new.txt')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
