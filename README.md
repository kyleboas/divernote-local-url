# divernote-local-url

A Divernote extension. When an issue is closed, it stops the preview servers
the issue started and removes their Tailscale serve URLs.

- A server belongs to an issue if it runs in the issue's worktree, or in an
  agent scratch directory named after that worktree.
- A server stays while an open issue mentions one of its URLs
  (`localhost:PORT`, `127.0.0.1:PORT`, its bind IP, or its Tailscale URL) in
  its text, follow-up messages or Pi conversation. It is checked again every
  two minutes and stopped once no open issue mentions it.
- Needs Divernote's `closed-issues` hook. Turn it off in /settings.
- Log: `~/Library/Logs/divernote-local-url.log`.

Tests: `node --test test/servers.test.mjs`
