// divernote-local-url: when a Divernote issue is closed, stop the preview servers
// it started and remove their Tailscale serve URLs. A server stays while an
// open issue (say, a follow-up) still mentions one of its URLs, and goes once
// none does. See servers.mjs.
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPiSessions, releaseClosedIssueServers } from './servers.mjs';

const SHARED_RETRY_MS = 2 * 60_000;
const LOG = join(homedir(), 'Library', 'Logs', 'divernote-local-url.log');
const recheckAt = new Map();

async function log(result) {
  try {
    await mkdir(dirname(LOG), { recursive: true });
    await appendFile(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...result })}\n`);
  } catch { /* logging never stops cleanup */ }
}

export default function previewServers(divernote) {
  divernote.on('closed-issues', async (issues, helpers) => {
    const now = Date.now();
    const results = await releaseClosedIssueServers(issues, {
      readIssueSession: worktree => readPiSessions(worktree, helpers.piSessionDirectory),
      skip: pid => (recheckAt.get(pid) ?? 0) > now,
    });
    for (const result of results) {
      if (result.status === 'shared') {
        // Log a shared server once, not every two minutes.
        if (!recheckAt.has(result.pid)) await log(result);
        recheckAt.set(result.pid, now + SHARED_RETRY_MS);
      } else {
        recheckAt.delete(result.pid);
        await log(result);
      }
    }
  });
}
