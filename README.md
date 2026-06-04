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

## Where jobs live

`cron/` is a tree, not a flat directory. Any `.md` or `.ts` file at any depth is a job. The slug
is the path relative to `cron/` with the extension stripped — `cron/email/triage.ts` →
`email/triage`. Use folders to group related crons (`cron/email/`, `cron/linkedin/`).

**One magic filename: `README.md`.** A file named exactly `README.md` is ignored at any depth, so
you can document a folder of crons without the README getting parsed as a job. No other reserved
names.

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

## `schedule:` — one key, five shapes

| Input                     | Meaning                                       |
| ------------------------- | --------------------------------------------- |
| `"0 9 * * *"`             | cron (5 fields, integers or `*`)              |
| `"every 5 minutes"`       | human (`every minute`, `every N hours`, etc.) |
| `60`                      | bare number → seconds                         |
| `"60s"` / `"5m"` / `"1d"` | compact unit suffix                           |
| `"manual"`                | no autoschedule; run only via `cronfish run`  |

`manual` jobs are discovered, validated, and listed, but no plist is installed and no calendar
fires them. Use it for scheduling candidates — jobs you're staging in `cron/` before flipping on
a real schedule. Pure on-demand scripts that aren't scheduling candidates belong outside `cron/`.

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
cronfish next [slug] [N]            preview the next N fire times (default 5)
cronfish sync                       reconcile cron/ ↔ launchd (idempotent)
cronfish enable <slug>              flip enabled, then sync
cronfish disable <slug>             flip disabled, then sync
cronfish delete <slug> --yes        bootout + remove plist + job file
cronfish status [slug]              launchctl print + tail of latest log
cronfish run <slug>                 invoke runner directly (no launchd) — for testing
cronfish --version
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

## How cronfish finds bun

Plists invoke `/usr/bin/env bun <runner.ts>`. At `cronfish sync` time, cronfish resolves your
current `bun` binary and bakes its directory into the plist's `PATH` along with the standard
candidates (`~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`). Bun
auto-loads `.env` from the consumer root (set via plist `WorkingDirectory`), so no shell wrapper
is needed.

- After `bun upgrade` (in place) or a `brew upgrade bun` (same dir) — no re-sync needed.
- After moving bun to a different directory — re-run `cronfish sync` so the plist PATH picks up
  the new location.
- asdf-managed bun is **not** in the default allowlist; install bun via the official installer
  (`curl -fsSL https://bun.sh/install | bash` → `~/.bun/bin`) or Homebrew.

## Requirements

- macOS (launchd). Linux (systemd) and Windows (Task Scheduler) are on the backlog.
- Bun ≥ 1.0.

## Status

v0.2 — private, used in production by the author. API may break before v1. File issues if you
hit something rough.

## License

MIT. See `LICENSE`.
