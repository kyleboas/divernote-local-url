import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readPiSessions, releaseClosedIssueServers, serverMentionPatterns } from '../servers.mjs';
import previewServers from '../index.mjs';

const ROOT = '/pi-worktrees';
const HOST = 'mac.example.ts.net';

function issue(sessionId, { text = 'Issue', messages = [] } = {}) {
  return { projectSlug: 'site', sessionId, text, description: '', messages, worktree: `${ROOT}/site/${sessionId}` };
}

function server(pid, port, cwd, binds = ['127.0.0.1']) {
  return { pid, command: 'Python', ports: [port], binds, cwd };
}

function serve(listenPort, backendPort) {
  return { url: `https://${HOST}${listenPort === 443 ? '' : `:${listenPort}`}`, host: HOST, listenPort, path: '/', backendPort };
}

function harness({ servers, serves = [], sessions = {} }) {
  const stopped = [];
  const unserved = [];
  const options = {
    listServers: async () => servers,
    listServes: async () => serves,
    readIssueSession: async worktree => sessions[worktree] ?? '',
    stop: async pid => { stopped.push(pid); },
    unserve: async entry => { unserved.push(entry.url); },
  };
  return { options, stopped, unserved };
}

test('closing an issue stops its preview server and removes its Tailscale URL', async () => {
  const h = harness({
    servers: [server(11, 8183, `${ROOT}/site/done/app`)],
    serves: [serve(8183, 8183), serve(8200, 8200)],
  });
  const results = await releaseClosedIssueServers({ closed: [issue('done')], open: [] }, h.options);
  assert.deepEqual(h.stopped, [11]);
  assert.deepEqual(h.unserved, [`https://${HOST}:8183`]);
  assert.equal(results[0].status, 'stopped');
});

test('a server started from an agent scratch directory for the worktree belongs to the issue', async () => {
  const h = harness({ servers: [server(17, 8212, '/private/tmp/claude-503/-pi-worktrees-site-done/abc/scratchpad/view')] });
  await releaseClosedIssueServers({ closed: [issue('done')], open: [] }, h.options);
  assert.deepEqual(h.stopped, [17]);
});

test('a server an open issue mentions stays until no open issue mentions it', async () => {
  const servers = [server(12, 8140, `${ROOT}/site/parent`)];
  const serves = [serve(443, 8140)];
  const child = issue('child', { messages: [`Fix the header on https://${HOST}/ please`] });

  const shared = harness({ servers, serves });
  const results = await releaseClosedIssueServers({ closed: [issue('parent')], open: [child] }, shared.options);
  assert.deepEqual(shared.stopped, []);
  assert.deepEqual(shared.unserved, []);
  assert.deepEqual(results.map(({ status, sharedWith }) => ({ status, sharedWith })), [{ status: 'shared', sharedWith: 'child' }]);

  const childClosed = harness({ servers, serves });
  await releaseClosedIssueServers({ closed: [issue('parent'), child], open: [] }, childClosed.options);
  assert.deepEqual(childClosed.stopped, [12]);
  assert.deepEqual(childClosed.unserved, [`https://${HOST}`]);
});

test('a mention in an open issue\'s Pi conversation also keeps the server', async () => {
  const h = harness({
    servers: [server(13, 8765, `${ROOT}/site/parent`)],
    sessions: { [`${ROOT}/site/child`]: '{"text":"Preview at http://127.0.0.1:8765/index.html"}' },
  });
  const results = await releaseClosedIssueServers({ closed: [issue('parent')], open: [issue('child')] }, h.options);
  assert.deepEqual(h.stopped, []);
  assert.equal(results[0].status, 'shared');
});

test('servers of open issues and servers outside any worktree are left alone', async () => {
  const h = harness({
    servers: [
      server(14, 8001, `${ROOT}/site/busy`),
      server(15, 8002, '/tmp/scratch'),
      server(16, 8003, `${ROOT}/site/done-later`),
    ],
  });
  assert.deepEqual(await releaseClosedIssueServers({ closed: [issue('done')], open: [issue('busy')] }, h.options), []);
  assert.deepEqual(h.stopped, []);
});

test('only a host and the exact port count as a mention', () => {
  const [local, root] = serverMentionPatterns(server(1, 8080, '/x', ['*']), [serve(443, 8080)]);
  assert.equal(local.test('open http://localhost:8080/'), true);
  assert.equal(local.test('open http://localhost:80801/'), false);
  assert.equal(local.test('port 8080'), false);
  assert.equal(root.test(`https://${HOST}/page`), true);
  assert.equal(root.test(`https://${HOST}`), true);
  assert.equal(root.test(`https://${HOST}:8183/`), false);

  const [tailnet] = serverMentionPatterns(server(2, 8090, '/x', ['100.72.79.116']), []);
  assert.equal(tailnet.test('http://100.72.79.116:8090'), true);
});

test('Pi conversations are read from the directory Divernote names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'preview-servers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'sessions'));
  await writeFile(join(directory, 'sessions', 'a.jsonl'), 'http://localhost:8765');
  await writeFile(join(directory, 'sessions', 'notes.txt'), 'ignored');
  assert.equal(await readPiSessions('/w', worktree => join(directory, 'sessions')), 'http://localhost:8765');
  assert.equal(await readPiSessions('/w', () => { throw new Error('none'); }), '');
});

test('the extension registers a closed-issues hook', () => {
  const hooks = [];
  previewServers({ on: (hook, handler) => hooks.push([hook, typeof handler]) });
  assert.deepEqual(hooks, [['closed-issues', 'function']]);
});
