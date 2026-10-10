import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';

// Divernote extension helpers: see index.mjs.
//
// Preview servers an issue starts (python -m http.server, a dev server, and so
// on) and the Tailscale serve URLs that point at them outlive the issue unless
// something stops them. A server belongs to the issue whose worktree it was
// started in, or in a scratch directory kept for that worktree. When that issue is closed, the server and its URLs go, unless an
// open issue still mentions one of its URLs: a follow-up issue often keeps
// using the preview its parent made, so that preview stays until no open
// issue refers to it.

const run = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;

async function output(command, args) {
  try {
    return (await run(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    // lsof exits 1 when it matches nothing; its output is still usable.
    return typeof error?.stdout === 'string' ? error.stdout : '';
  }
}

function isTailscaleProcess(command) {
  return /^(IPNExtension|IPNExtens|tailscaled?)\b/.test(command);
}

/** TCP listeners other than Tailscale's own, with each process's working directory. */
export async function listListeningServers() {
  const listening = await output('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const byPid = new Map();
  let pid;
  let command = '';
  for (const line of listening.split('\n')) {
    const value = line.slice(1);
    if (line[0] === 'p') pid = Number(value);
    else if (line[0] === 'c') command = value;
    else if (line[0] === 'n' && pid && !isTailscaleProcess(command)) {
      const match = /^(.*):(\d+)$/.exec(value);
      if (!match) continue;
      const entry = byPid.get(pid) ?? { pid, command, ports: new Set(), binds: new Set(), cwd: '' };
      entry.ports.add(Number(match[2]));
      entry.binds.add(match[1]);
      byPid.set(pid, entry);
    }
  }
  if (byPid.size === 0) return [];
  const cwds = await output('lsof', ['-a', '-d', 'cwd', '-p', [...byPid.keys()].join(','), '-Fpn']);
  for (const line of cwds.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && byPid.has(pid)) byPid.get(pid).cwd = line.slice(1);
  }
  return [...byPid.values()].map(entry => ({ ...entry, ports: [...entry.ports], binds: [...entry.binds] }));
}

/** Tailscale serve entries as { url, host, listenPort, path, backendPort }. */
export async function listTailscaleServes() {
  let config;
  try {
    config = JSON.parse(await output('tailscale', ['serve', 'status', '--json']) || '{}');
  } catch {
    return [];
  }
  const entries = [];
  for (const [hostPort, web] of Object.entries(config?.Web ?? {})) {
    const match = /^(.*):(\d+)$/.exec(hostPort);
    if (!match) continue;
    const [, host, port] = match;
    for (const [path, handler] of Object.entries(web?.Handlers ?? {})) {
      const backend = /:(\d+)(?:\/|$)/.exec(String(handler?.Proxy ?? ''));
      if (!backend) continue;
      entries.push({
        url: `https://${host}${port === '443' ? '' : `:${port}`}${path === '/' ? '' : path}`,
        host,
        listenPort: Number(port),
        path,
        backendPort: Number(backend[1]),
      });
    }
  }
  return entries;
}

export async function removeTailscaleServe(entry) {
  const args = ['serve', `--https=${entry.listenPort}`];
  if (entry.path !== '/') args.push('--set-path', entry.path);
  args.push('off');
  await run('tailscale', args, { timeout: COMMAND_TIMEOUT_MS });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* it exited */ }
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Patterns that match a mention of one of the server's addresses. A port is
 * only a mention after a host, so "8080" alone or "localhost:80801" does not
 * keep a server. The root Tailscale URL has no port, so it must not be
 * followed by one.
 */
export function serverMentionPatterns(server, serves) {
  const patterns = [];
  for (const port of server.ports) {
    const hosts = ['localhost', '127\\.0\\.0\\.1', '0\\.0\\.0\\.0', '\\[::1?\\]', ...server.binds
      .filter(bind => !['*', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(bind))
      .map(escapeRegExp)];
    patterns.push(new RegExp(`(?:${hosts.join('|')}):${port}(?!\\d)`));
  }
  for (const entry of serves) {
    if (!server.ports.includes(entry.backendPort)) continue;
    const host = escapeRegExp(entry.host);
    patterns.push(entry.listenPort === 443
      ? new RegExp(`${host}(?::443)?(?![\\w.:-])`)
      : new RegExp(`${host}:${entry.listenPort}(?!\\d)`));
  }
  return patterns;
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * A server belongs to an issue if it runs in the issue's worktree, or in a
 * scratch directory an agent keeps for that worktree. Claude Code names those
 * after the worktree path with each "/" and "." turned into "-".
 */
function ownedBy(cwd, worktree) {
  if (within(cwd, worktree)) return true;
  const scratchName = worktree.replace(/[/\\.]/g, '-');
  return cwd.split(sep).includes(scratchName);
}

function issueText(issue) {
  return [issue.text, issue.description, ...(issue.messages ?? [])].filter(text => typeof text === 'string').join('\n');
}

/** Every Pi conversation file of the issue's worktree, newest part of each if huge. */
export async function readPiSessions(worktree, piSessionDirectory) {
  let directory;
  try {
    directory = piSessionDirectory(worktree);
  } catch {
    return '';
  }
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return '';
  }
  const texts = [];
  for (const name of names.filter(name => name.endsWith('.jsonl'))) {
    try {
      const text = await readFile(join(directory, name), 'utf8');
      texts.push(text.length > MAX_SESSION_BYTES ? text.slice(-MAX_SESSION_BYTES) : text);
    } catch { /* a session file that cannot be read mentions nothing */ }
  }
  return texts.join('\n');
}

/**
 * Stop the preview servers of closed issues and remove their Tailscale serve
 * URLs. `closed` and `open` are the closed-issues hook's issues. A server one
 * of whose URLs an open issue mentions (in its text, messages, or Pi
 * conversation) stays and is reported as `shared`.
 */
export async function releaseClosedIssueServers({ closed = [], open = [] }, {
  listServers = listListeningServers,
  listServes = listTailscaleServes,
  readIssueSession = async () => '',
  stop = stopProcess,
  unserve = removeTailscaleServe,
  skip = () => false,
} = {}) {
  if (closed.length === 0) return [];
  const owned = [];
  for (const server of await listServers()) {
    const owner = server.cwd ? closed.find(issue => ownedBy(server.cwd, issue.worktree)) : undefined;
    if (owner && !skip(server.pid)) owned.push({ server, owner });
  }
  if (owned.length === 0) return [];

  const serves = await listServes();
  let openTexts;
  const results = [];
  for (const { server, owner } of owned) {
    const patterns = serverMentionPatterns(server, serves);
    openTexts ??= await Promise.all(open.map(async issue => ({
      issue,
      text: `${issueText(issue)}\n${await readIssueSession(issue.worktree)}`,
    })));
    const sharedWith = openTexts.find(({ text }) => patterns.some(pattern => pattern.test(text)));
    const base = { projectSlug: owner.projectSlug, sessionId: owner.sessionId, pid: server.pid, ports: server.ports };
    if (sharedWith) {
      results.push({ ...base, status: 'shared', sharedWith: sharedWith.issue.sessionId });
      continue;
    }
    await stop(server.pid);
    const removed = [];
    for (const entry of serves.filter(entry => server.ports.includes(entry.backendPort))) {
      try {
        await unserve(entry);
        removed.push(entry.url);
      } catch { /* the next pass tries again */ }
    }
    results.push({ ...base, status: 'stopped', urls: removed });
  }
  return results;
}
