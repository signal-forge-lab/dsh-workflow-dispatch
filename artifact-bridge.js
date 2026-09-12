import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, opendir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const READ_ONLY_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'lsp', 'skill', 'web_search']);
const SENSITIVE_PATH = /(^|\/)(\.env(?:\.|$)|.*(?:secret|credential|private[_-]?key|api[_-]?key|token).*)/iu;
const BINARY_PATH = /\.(?:png|jpe?g|gif|webp|avif|ico|pdf|zip|7z|gz|tar|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi)$/iu;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_STAGE_BYTES = 128 * 1024 * 1024;

function normalizePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\//u, '');
}

function promptText(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) return undefined;
  let text = '';
  for (const block of prompt) {
    if (block?.type !== 'text' || typeof block.text !== 'string') return undefined;
    text += `${text ? '\n\n' : ''}${block.text}`;
  }
  return text.trim().length === 0 ? undefined : text;
}

function safeTrackedPath(path) {
  const normalized = normalizePath(path);
  return normalized.length > 0
    && !normalized.startsWith('../')
    && !normalized.includes('/../')
    && !SENSITIVE_PATH.test(normalized)
    && !BINARY_PATH.test(normalized);
}

async function git(cwd, args, maxBuffer = 2 * 1024 * 1024) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer });
  return stdout;
}

async function gitWithInput(cwd, args, input) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 8192) stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('close', code => {
      if (code === 0) resolvePromise(undefined);
      else rejectPromise(new Error(`git exited ${code}: ${stderr.slice(0, 512)}`));
    });
    child.stdin.end(input);
  });
}

async function gitRoot(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
}

function within(root, candidate) {
  const child = relative(resolve(root), resolve(candidate));
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultWorkspaceRoot(root) {
  let cursor = resolve(root);
  while (true) {
    const candidate = join(cursor, 'browser-chat-workspace');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function taskDirectoryName(request) {
  const id = String(request?.parent?.session?.header?.id ?? 'task')
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .slice(0, 48) || 'task';
  return `${id}-${randomUUID().slice(0, 8)}`;
}

async function trackedSnapshot(root, path) {
  const full = resolve(root, path);
  if (!within(root, full)) return undefined;
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return undefined;
  const value = await readFile(full);
  return { hash: hash(value), value };
}

async function walkFiles(root) {
  const files = new Array();
  async function walk(directory) {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const full = join(directory, entry.name);
      const path = normalizePath(relative(root, full));
      if (entry.isSymbolicLink()) throw new Error(`unsafe staged path: ${path}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path, full });
      else throw new Error(`unsafe staged path: ${path}`);
    }
  }
  await walk(root);
  return files;
}

async function currentHash(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return undefined;
    return hash(await readFile(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function artifactBridgeMode(request) {
  const allow = request?.toolFilter?.allow;
  if (Array.isArray(allow) && allow.length === 0) return 'direct';
  if (promptText(request?.prompt) === undefined) return 'local-only';
  if (Array.isArray(allow)) {
    return allow.every(tool => READ_ONLY_TOOLS.has(tool)) ? 'read-only' : 'local-only';
  }
  return request?.outputSchema === undefined ? 'mutation' : 'local-only';
}

export const ARTIFACT_PATCH_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['patch', 'unsupported'] },
    summary: { type: 'string' },
    patch: { type: 'string' },
    tests: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'summary', 'patch', 'tests'],
});

function patchResultFromOutcome(outcome) {
  const structured = outcome?.structured;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) return structured;
  const text = Array.isArray(outcome?.output)
    ? outcome.output.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
    : '';
  if (!text) return undefined;
  const candidate = text.startsWith('```')
    ? text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '')
    : text;
  try {
    return JSON.parse(candidate);
  } catch {
    // Spark currently emits the unified-diff metadata line with one raw
    // backslash inside JSON. Repair only that exact Git diff marker.
    const repaired = candidate.replaceAll('\\ No newline at end of file', '\\\\ No newline at end of file');
    if (repaired === candidate) return undefined;
    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
  }
}

function normalizeUnifiedDiffHeaders(patch) {
  const lines = String(patch ?? '').split(/\r?\n/u);
  let headerCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const prefix = line.startsWith('--- ') ? '--- ' : line.startsWith('+++ ') ? '+++ ' : undefined;
    if (prefix === undefined) continue;
    const raw = line.slice(prefix.length);
    const [path, ...rest] = raw.split('\t');
    if (path === '/dev/null') {
      if (prefix === '+++ ') return undefined;
      headerCount += 1;
      continue;
    }
    const normalized = normalizePath(path);
    const expectedPrefix = prefix === '--- ' ? 'a/' : 'b/';
    const withoutGitPrefix = normalized.startsWith('a/') || normalized.startsWith('b/')
      ? normalized.slice(2)
      : normalized;
    if (!safeTrackedPath(withoutGitPrefix) || withoutGitPrefix.includes('..') || isAbsolute(withoutGitPrefix)) return undefined;
    lines[index] = `${prefix}${expectedPrefix}${withoutGitPrefix}${rest.length ? `\t${rest.join('\t')}` : ''}`;
    headerCount += 1;
  }
  return headerCount >= 2 ? lines.join('\n') : undefined;
}

export class ArtifactBridge {
  /** @type {boolean} */
  enabled;
  /** @type {number} */
  maxFiles;
  /** @type {string | undefined} */
  workspaceRoot;

  /**
   * @param {{enabled?: boolean, maxFiles?: number, workspaceRoot?: string}} [options]
   */
  constructor(options) {
    const resolvedOptions = options ?? {};
    this.enabled = resolvedOptions.enabled !== false;
    this.maxFiles = Math.max(1, Number(resolvedOptions.maxFiles ?? 2000));
    this.workspaceRoot = typeof resolvedOptions.workspaceRoot === 'string' && resolvedOptions.workspaceRoot.trim()
      ? resolve(resolvedOptions.workspaceRoot)
      : undefined;
  }

  async prepare(request) {
    const detectedMode = artifactBridgeMode(request);
    if (detectedMode === 'direct') return { mode: 'direct' };
    const mode = this.enabled ? detectedMode : 'local-only';
    if (mode === 'local-only') return { mode };
    const text = promptText(request.prompt);
    const cwd = request?.parent?.session?.header?.cwd;
    if (text === undefined || typeof cwd !== 'string' || !isAbsolute(cwd)) return { mode: 'local-only' };
    const root = await gitRoot(cwd);
    if (root === undefined || !within(root, cwd)) return { mode: 'local-only' };
    const workspaceRoot = this.workspaceRoot ?? defaultWorkspaceRoot(root);
    if (workspaceRoot === undefined) return { mode: 'local-only' };
    let stageRoot;
    try {
      await mkdir(workspaceRoot, { recursive: true });
      stageRoot = join(workspaceRoot, taskDirectoryName(request));
      await mkdir(stageRoot, { recursive: true });
      const trackedRaw = await git(root, ['ls-files']);
      const tracked = trackedRaw.split(/\r?\n/u).filter(Boolean).map(normalizePath).filter(safeTrackedPath);
      if (tracked.length > this.maxFiles) {
        await rm(stageRoot, { recursive: true, force: true });
        return { mode: 'local-only' };
      }
      const snapshots = new Map();
      let copiedBytes = 0;
      for (const path of tracked) {
        let snapshot;
        try {
          snapshot = await trackedSnapshot(root, path);
        } catch {
          snapshot = undefined;
        }
        if (snapshot === undefined) continue;
        copiedBytes += snapshot.value.byteLength;
        if (copiedBytes > MAX_STAGE_BYTES) {
          await rm(stageRoot, { recursive: true, force: true });
          return { mode: 'local-only' };
        }
        const destination = resolve(stageRoot, path);
        if (!within(stageRoot, destination)) continue;
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(resolve(root, path), destination);
        snapshots.set(path, snapshot.hash);
      }
      if (snapshots.size === 0) return { mode: 'local-only' };
      return { mode, root, workspaceRoot, stageRoot, snapshots };
    } catch {
      if (stageRoot !== undefined) await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      return { mode: 'local-only' };
    }
  }

  async cleanup(plan) {
    if (!plan?.workspaceRoot || !plan?.stageRoot || !within(plan.workspaceRoot, plan.stageRoot)) return;
    await rm(plan.stageRoot, { recursive: true, force: true });
  }

  browserRequest(request, plan) {
    if (!plan || !['read-only', 'mutation'].includes(plan.mode)) return request;
    const original = promptText(request.prompt);
    if (original === undefined) return request;
    const defaultRoot = defaultWorkspaceRoot(plan.root);
    const workspacePrefix = defaultRoot !== undefined && resolve(defaultRoot) === resolve(plan.workspaceRoot)
      ? ''
      : `${basename(plan.workspaceRoot)}\\`;
    const browserPath = `Gドライブのルート\\${workspacePrefix}${basename(plan.stageRoot)}`;
    const instruction = plan.mode === 'mutation'
      ? [
          '--- DSH FILE WORKSPACE CONTRACT ---',
          `Workspace path: ${browserPath}`,
          'The Drive workspace is READ-ONLY. Use Google Drive only to read files needed for the task.',
          'Use no other tools: do not use Computer, Python, code execution, Google Workspace Search, web search, or exploratory search outside the exact workspace path.',
          'Do not use Drive write, create, update, delete, or rename operations. Do not modify staged files.',
          'Treat every requested file mutation only as patch planning: inspect the necessary files, then return the minimal unified diff immediately after reading.',
          'As soon as the requested file content is read, return the requested JSON immediately. Do not perform extra validation, diff-format research, or additional tool calls.',
          'Return only valid JSON with no prose or markdown fence: {"status":"patch","summary":"short summary","patch":"unified diff text","tests":[]}.',
          'Escape backslashes inside the JSON patch string correctly. If the requested change cannot be represented safely, return status "unsupported" with an empty patch.',
          'Git操作は禁止です。Do not access outside the workspace folder. Do not claim tests were run.',
        ].join('\n')
      : [
          '--- DSH FILE WORKSPACE CONTRACT ---',
          `Workspace path: ${browserPath}`,
          'The Drive workspace is READ-ONLY. Read only the files required to answer the task.',
          'Do not write, create, update, delete, or rename Drive files. Git操作は禁止です。Do not access outside the workspace folder.',
        ].join('\n');
    return {
      ...request,
      prompt: [{ type: 'text', text: `${instruction}\n\n--- TASK REQUEST ---\n${original}` }],
      toolFilter: { allow: [] },
    };
  }

  async finalizeMutation(plan, outcome) {
    if (plan?.mode !== 'mutation' || outcome?.stopReason !== 'completed') return { ok: true, outcome };
    try {
      const staged = await walkFiles(plan.stageRoot);
      const stagedByPath = new Map(staged.map(file => [file.path, file]));
      for (const path of plan.snapshots.keys()) {
        if (!stagedByPath.has(path)) return { ok: false, reason: `deletion is not supported: ${path}` };
      }
      for (const file of staged) {
        if (!safeTrackedPath(file.path) || file.path === '.git' || file.path.startsWith('.git/')) {
          return { ok: false, reason: `unsafe staged path: ${file.path}` };
        }
        const info = await lstat(file.full);
        if (info.size > MAX_FILE_BYTES) return { ok: false, reason: `staged file too large: ${file.path}` };
      }

      const changes = new Array();
      for (const file of staged) {
        const stagedHash = await currentHash(file.full);
        const originalHash = plan.snapshots.get(file.path);
        if (originalHash === undefined || stagedHash !== originalHash) changes.push({ ...file, originalHash });
      }
      if (changes.length === 0) {
        const value = patchResultFromOutcome(outcome);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return { ok: false, reason: 'browser-chat made no staged file changes and patch result is missing' };
        }
        if (value.status === 'unsupported') return { ok: false, reason: 'browser-chat declared workspace task unsupported' };
        const rawPatch = typeof value.patch === 'string' ? value.patch.trim() : '';
        const patch = normalizeUnifiedDiffHeaders(rawPatch);
        if (!patch || patch.length > 512_000) return { ok: false, reason: 'patch missing, unsafe, or too large' };
        if (/^(?:rename (?:from|to)|deleted file mode|GIT binary patch|Binary files )/mu.test(patch)) {
          return { ok: false, reason: 'patch operation rejected' };
        }
        const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map(match => normalizePath(match[1]));
        if (paths.length === 0 || paths.some(path => !safeTrackedPath(path) || path === '.git' || path.startsWith('.git/') || path.includes('..'))) {
          return { ok: false, reason: 'patch path rejected' };
        }
        for (const path of paths) {
          const destination = resolve(plan.root, path);
          if (!within(plan.root, destination)) return { ok: false, reason: `patch path rejected: ${path}` };
          const sourceHash = await currentHash(destination);
          const originalHash = plan.snapshots.get(path);
          if (originalHash === undefined) {
            if (sourceHash !== undefined) return { ok: false, reason: `source path already exists: ${path}` };
          } else if (sourceHash !== originalHash) {
            return { ok: false, reason: `source changed after materialization: ${path}` };
          }
        }
        try {
          await gitWithInput(plan.root, ['apply', '--check', '--whitespace=nowarn', '-'], `${patch}\n`);
          await gitWithInput(plan.root, ['apply', '--whitespace=nowarn', '-'], `${patch}\n`);
        } catch {
          return { ok: false, reason: 'git apply rejected patch' };
        }
        return { ok: true, outcome, paths };
      }

      for (const change of changes) {
        const destination = resolve(plan.root, change.path);
        if (!within(plan.root, destination)) return { ok: false, reason: `unsafe staged path: ${change.path}` };
        const sourceHash = await currentHash(destination);
        if (change.originalHash === undefined) {
          if (sourceHash !== undefined) return { ok: false, reason: `source path already exists: ${change.path}` };
        } else if (sourceHash !== change.originalHash) {
          return { ok: false, reason: `source changed after materialization: ${change.path}` };
        }
      }

      for (const change of changes) {
        const destination = resolve(plan.root, change.path);
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(change.full, destination);
      }
      return { ok: true, outcome, paths: changes.map(change => change.path) };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error ?? 'workspace collect failed') };
    }
  }
}
