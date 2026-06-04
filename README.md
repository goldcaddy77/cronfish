# cronfish 🐟

**Drop a file. Cronfish does the rest. Markdown is a valid cron job.**

The simplest scheduler for personal automation on macOS. Drop a `.md` (agentic Claude prompt) or
`.ts` (Bun program) in `cron/`, run `cronfish sync`, and launchd takes it from there.

## 60-second quickstart

```bash
bun add cronfish              # or `bun add file:../cronfish` for local dev
bunx cronfish init            # creates cron/hello.md + cron/touch.ts (disabled)
bunx cronfish enable hello    # flip on, sync to launchd
bunx cronfish list            # see what's scheduled and what's loaded
```

That's it. No code change to register a job — just drop a file in `cron/`.

## Job spec

### Markdown — `cron/<slug>.md`

```markdown
---
schedule: "every 5 minutes" # see below for all accepted shapes
model: haiku # claude alias | raw ID | local:<name>
enabled: true # default true
timeout: 300 # seconds; runner kills past this
retries: 0 # retry count on non-zero exit
concurrency: skip # skip | queue
---

Anything you'd type into a fresh Claude session. Tools, files, prompts, all of it.
```

Cronfish shells to `claude --dangerously-skip-permissions --model <id> -p <body>` with `cwd =
consumer repo root`, so the job inherits your project's `.claude/` config (tools, MCP servers,
permissions) and your global `~/.claude/`.

### TypeScript — `cron/<slug>.ts`

```ts
export const config = {
  schedule: "every 10 minutes",
  enabled: true,
  timeout: 540,
  retries: 0,
  concurrency: "skip",
};

export default async function run(): Promise<void> {
  // anything. stdout/stderr captured to the log file.
}
```

## `schedule:` — one key, four shapes

| Input                     | Meaning                                       |
| ------------------------- | --------------------------------------------- |
| `"0 9 * * *"`             | cron (5 fields, integers or `*`)              |
| `"every 5 minutes"`       | human (`every minute`, `every N hours`, etc.) |
| `60`                      | bare number → seconds                         |
| `"60s"` / `"5m"` / `"1d"` | compact unit suffix                           |

The `every:` key (used by older harnesses) is silently aliased to `schedule:` for one version.

## Config — `.cronfish.json` (optional, at repo root)

```json
{ "bundle_prefix": "com.example.myapp" }
```

Becomes the launchd plist label prefix: cronfish appends `.<slug>` per job. Defaults to
`com.cronfish.<basename(cwd)>` if absent.

## CLI

```
cronfish init                       scaffold cron/hello.md + cron/touch.ts
cronfish list                       every job + state
cronfish sync                       reconcile cron/ ↔ launchd (idempotent)
cronfish enable <slug>              flip enabled, then sync
cronfish disable <slug>             flip disabled, then sync
cronfish delete <slug> --yes        bootout + remove plist + job file
cronfish status [slug]              launchctl print + tail of latest log
cronfish run <slug>                 invoke runner directly (no launchd) — for testing
```

## Files cronfish writes

```
cron/<slug>.{md,ts}                                # job files (you write these)
~/Library/LaunchAgents/<prefix>.<slug>.plist        # launchd registration
<consumer>/tmp/cron/<slug>/<ISO>.log                # per-run log
<consumer>/tmp/cron/<slug>/runner.pid               # concurrency lock
```

## Retries & concurrency

- `retries:` — on non-zero exit, retry up to N more times with exponential backoff (5s, 15s, 45s,
  capped at 60s). Retry lines append to the same log.
- `concurrency: skip` — if a prior run is still in flight, exit 0 immediately.
- `concurrency: queue` — poll every 2s for the lock, up to the job's `timeout`.

## Platform

macOS only (launchd) for v0.1. Linux (systemd) and Windows (Task Scheduler) are on the backlog.

## Status

v0.1 — private, used in production by the author. API may break before v1. File issues if you
hit something rough.

## License

MIT. See `LICENSE`.
