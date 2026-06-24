<p align="center">
  <img src="assets/cronfish-mascot.png" alt="cronfish mascot" width="240">
</p>

<h1 align="center">cronfish 🐟</h1>

<p align="center"><strong>Drop a file. Cronfish does the rest. Markdown is a valid cron job.</strong></p>

<p align="center">
  <a href="https://github.com/goldcaddy77/cronfish/actions/workflows/ci.yml"><img src="https://github.com/goldcaddy77/cronfish/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-black?logo=bun" alt="Bun >= 1.0">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple" alt="macOS">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

The simplest scheduler for personal automation on macOS. Drop a `.md` (agentic Claude prompt),
`.ts` (Bun program), or `.sh` (bash script) in `cron/`, run `cronfish sync`, and launchd takes
it from there.

**Why not raw `crontab` or `launchd`?** Because both make you hand-write plists or crontab lines,
wire your own logging, and guess at why a job didn't fire. Cronfish makes the *file* the job:
frontmatter is the schedule, the path is the slug, and you get per-run logs, retries, concurrency
guards, failure alerts, fire-once jobs, and a dashboard for free — no registration step, no plist
XML. See the [`examples/`](./examples) directory for a copy-pasteable job of every kind.

## 60-second quickstart

```bash
bun add cronfish                 # or `bun add file:../cronfish` for local dev
bunx cronfish init               # creates cron/hello.md, touch.ts, ping.sh (disabled)
bunx cronfish enable hello-md    # flip on, sync to launchd
bunx cronfish list               # see what's scheduled and what's loaded
```

That's it. No code change to register a job — just drop a file in `cron/`.

## Where jobs live

`cron/` is a tree, not a flat directory. Any `.md`, `.ts`, or `.sh` file at any depth is a job.

**The slug encodes the kind.** The path relative to `cron/` has its trailing `.<ext>` rewritten
to `-<ext>`, so:

- `cron/email/triage.ts` → slug `email/triage-ts`
- `cron/hello.md` → slug `hello-md`
- `cron/obsidian-keepalive.sh` → slug `obsidian-keepalive-sh`

This means `foo.md` and `foo.sh` can coexist without colliding. Use folders to group related
crons (`cron/email/`, `cron/linkedin/`).

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

### Bash — `cron/<slug>.sh`

```sh
#!/bin/bash
# ---
# schedule: every 5 minutes
# enabled: true
# timeout: 30
# concurrency: skip
# ---

echo "hello from bash"
```

Config lives in a `# ---` / `# ---` comment block at the top of the file (after the shebang, if
present). Each inner line is `# key: value` — same scalar rules as Markdown frontmatter. Cronfish
invokes the file as `/bin/bash <path>` with `cwd = consumer repo root`; stdout/stderr go to the
per-run log. **A `.sh` file with no frontmatter block fails at discovery** — cronfish prints the
error in `list`/`sync` so you know to add one.

## `model:` — claude alias, raw ID, or local

For Anthropic-hosted models, use the aliases `haiku` / `sonnet` / `opus` (resolve to the latest
pinned IDs), or pass a raw ID like `claude-sonnet-4-6` verbatim.

For a **local model**, prefix with `local:` — e.g. `local:qwen2.5-coder:32b`. Cronfish still
spawns the same `claude` CLI, but with `ANTHROPIC_BASE_URL` pointed at a local
Anthropic-Messages-compatible endpoint. Ollama 0.14+ speaks this format natively, so the default
target is `http://localhost:11434` with auth token `ollama`. The model ID is passed as
`--model` **and** as the three slot overrides (`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`)
plus `CLAUDE_CODE_SUBAGENT_MODEL`, so any sub-agents Claude spawns also route locally.

Override the endpoint for LiteLLM, LM Studio, or a LAN box:

```bash
export CRONFISH_LOCAL_BASE_URL="http://192.168.1.50:4000"
export CRONFISH_LOCAL_AUTH_TOKEN="sk-litellm-key"
```

Caveats: small local models (≤7B) often can't follow Claude Code's tool-heavy system prompt and
will hallucinate tool calls. Use 14B+ for any agentic loop; 32B is the practical floor for
multi-step work. Local providers serve one request at a time — set `concurrency: queue` on
overlapping jobs.

## One-shot jobs — `cron/one-time/`

Drop a `.md`, `.ts`, or `.sh` under `cron/one-time/` to schedule a job that
fires **exactly once** at a `run_at` timestamp, then archives itself. Same
file format as recurring jobs except `schedule:` is replaced by `run_at:`.

```yaml
---
run_at: 2026-06-25T15:00:00-04:00   # absolute ISO, OR
run_at: "+30s"                      # relative to file mtime (s|m|h|d)
grace_seconds: 300                  # optional override; default 300 (5 min)
---
```

Sync behavior:

| `run_at` vs. now              | What happens                                      |
| ----------------------------- | ------------------------------------------------- |
| Future                        | plist installed with `StartCalendarInterval` for the exact minute |
| Within `grace_seconds` of now | plist installed with `RunAtLoad: true` — fires on bootstrap |
| Past `grace_seconds`          | **refused**; sentinel written to `cron/.errors/`  |
| `executed_at:` already set    | skipped (file should already be archived)         |

On every fire the runner takes a `flock(LOCK_EX|LOCK_NB)` on the source file,
re-checks `executed_at` under lock, runs the job, then writes
`executed_at: <ISO>` (with `fsync`) and **moves the file to
`~/Library/Application Support/cronfish/done/`** — outside the repo so the
audit trail doesn't bloat git. The next `cronfish sync` removes the orphaned
plist.

**One-time jobs must be idempotent.** launchd can re-fire on machine restart,
system unsleep, or load spikes; the flock + `executed_at` guard catches the
double-fire, but only after the file is stamped. Anything destructive between
"start" and "stamp" can repeat. Write handlers that tolerate two invocations.

**Failure surface — `cron/.errors/`.** Any sync-time refusal (past-grace, bad
YAML, missing `run_at`) writes a sentinel file there with the slug, timestamp,
and reason. Runner-side failures (archive failed, executed_at write failed)
also land here. Wire a heartbeat cron to alert on non-empty.

Smoke-test template: `templates/_examples/one-time/echo-at.md`.

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
{
  "bundle_prefix": "com.example.myapp",
  "bun_path": "/opt/homebrew/bin/bun",
  "ui": { "public_url": "https://mini.tail-xxx.ts.net:4747" },
  "alerts": {
    "on_failure": { "notify": "slack" },
    "default": "slack",
    "slack": { "webhook_url_env": "CRONFISH_SLACK_WEBHOOK" },
    "shell": { "command": "/Users/you/bin/cronfish-pushover.sh" }
  }
}
```

- **`bundle_prefix`** — launchd plist label prefix; cronfish appends `.<slug>` per job. Defaults to
  `com.cronfish.<basename(cwd)>`.
- **`bun_path`** — optional absolute path to the `bun` binary baked into every plist's PATH.
  Use when you want to pin a specific install (multiple bun copies, version managers, non-standard
  prefix). When unset, cronfish resolves bun in this order: `$BUN_INSTALL/bin` → `/opt/homebrew/bin`
  → `~/.bun/bin` → `/usr/local/bin` → `which bun`. Homebrew and the official installer
  (`~/.bun`) work out of the box; for asdf/mise/proto, set `bun_path` explicitly.
- **`ui.public_url`** — base URL used to build links in alert payloads (e.g. `<base>/runs/<id>`).
  Explicit only; no Tailscale auto-detect.
- **`alerts`** — see [Alerts](#alerts) below.

## CLI

```
cronfish init                       scaffold cron/hello.md + cron/touch.ts + cron/ping.sh + cron/watchdog.sh
cronfish list                       every job + state
cronfish next [slug] [N]            preview the next N fire times (default 5)
cronfish sync                       reconcile cron/ ↔ launchd (idempotent)
cronfish enable <slug>              flip enabled, then sync
cronfish disable <slug>             flip disabled, then sync
cronfish delete <slug> --yes        bootout + remove plist + job file
cronfish status [slug]              launchctl print + tail of latest log
cronfish run <slug>                 invoke runner directly (no launchd) — for testing
cronfish watchdog                   detect missed schedules → fire alerts
cronfish alerts test [adapter]      send a test alert via the named (or default) adapter
cronfish ui [--port N] [--no-open]  local web dashboard (default 127.0.0.1:4747)
cronfish ui install [--port N]      install dashboard as a launchd daemon (auto-restart, runs at login)
cronfish ui uninstall               bootout + remove dashboard daemon
cronfish ui status                  show dashboard daemon state
cronfish --version
```

## Alerts

Every failed (`fail` / `timeout` / `crashed`) scheduled run pings the configured adapter, and the first `ok` after a failure pings once as `recovered`. Missed schedules are caught by `cronfish watchdog` (scaffolded as `cron/watchdog.sh`, scheduled `every 5 minutes`, disabled by default — flip on after configuring `alerts`).

Adapters ship with cronfish:

- **`slack`** — POSTs Block Kit to an incoming webhook. Reads the URL from the env var named in `alerts.slack.webhook_url_env` (default `CRONFISH_SLACK_WEBHOOK`).
- **`shell`** — runs an arbitrary command from `alerts.shell.command` with the payload as env vars (`CRONFISH_ALERT_SLUG`, `…_STATUS`, `…_EXIT_CODE`, `…_DURATION_MS`, `…_STARTED_AT`, `…_UI_URL`, `…_LOG_TAIL`) plus the JSON payload on stdin. Use this for Pushover/ntfy/osascript.

Two knobs in `.cronfish.json`, two distinct jobs:

- **`alerts.on_failure: { notify: "slack" }`** — fleet-wide default. When set, every scheduled job alerts via that adapter on failure unless its frontmatter says otherwise. When unset, jobs are silent by default.
- **`alerts.default: "slack"`** — picks which adapter `cronfish alerts test` uses when invoked without an arg. Adapter-selection only; does NOT cause jobs to alert.

Per-job overrides via frontmatter:

```yaml
schedule: "every 5 minutes"
on_failure:
  notify: slack          # opt in / pick a specific adapter for this job
missed_after: 30m        # optional override of the watchdog's grace window
```

```yaml
on_failure:
  notify: none           # opt OUT of the fleet default for this job
```

Resolution order: per-job `notify` (including the `"none"` opt-out) → `alerts.on_failure.notify` → no alert (silent skip — recorded in the ledger as `alert_status='skipped'`).

Failures inside the adapter never block the run: `alert_status='error'` and `alert_error` capture the reason; stderr gets one line. Manual `cronfish run <slug>` invocations do **not** fire alerts — that's the debugging path.

Sanity check:

```
export CRONFISH_SLACK_WEBHOOK=https://hooks.slack.com/services/...
cronfish alerts test slack
```

## Always-on dashboard

`cronfish ui` runs the dashboard in the foreground. To keep it up across reboots and crashes, install it as a launchd daemon:

```
cronfish ui install            # one-time, default port 4747
cronfish ui status             # label + plist + pid
cronfish ui uninstall          # bootout + remove
```

`install` writes `~/Library/LaunchAgents/<prefix>.ui.plist` with `KeepAlive` + `RunAtLoad`, logs to `<consumer>/.cronfish/logs/ui.log`, and dispatches it via `launchctl bootstrap`. Default bind is `127.0.0.1` (no auth, not exposed). To reach the dashboard from another machine on your LAN, install with `--host 0.0.0.0`:

```
cronfish ui install --host 0.0.0.0
```

`ui status` then prints the LAN URL.

## Files cronfish writes

```
cron/<slug>.{md,ts,sh}                              # job files (you write these)
~/Library/LaunchAgents/<prefix>.<slug>.plist        # launchd registration
<consumer>/tmp/cron/<slug>/<ISO>.log                # per-run log
<consumer>/tmp/cron/<slug>/runner.pid               # concurrency lock
```

## Retries & concurrency

- `retries:` — on non-zero exit, retry up to N more times with exponential backoff (5s, 15s, 45s,
  capped at 60s). Retry lines append to the same log.
- `concurrency: skip` — if a prior run is still in flight, exit 0 immediately.
- `concurrency: queue` — poll every 2s for the lock, up to the job's `timeout`.

## `.env` is baked into every plist

At `cronfish sync`, every plist's `EnvironmentVariables` block is populated
with the consumer's `.env` plus the required keys (`HOME`,
`CRONFISH_CONSUMER_ROOT`, `PATH`). This is what lets `.md` and `.sh` runs
(which bypass bun's auto-`.env` loader) reach postgres, Linear, Slack, etc.

Required keys win on collision. Quoted values are unquoted; `#` is treated as
an inline comment only on unquoted values. Re-run `cronfish sync` after
editing `.env` so the plists pick up the new values.

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

v0.11 — used in production by the author. API may still break before v1. File issues if you hit
something rough.

## License

MIT. See `LICENSE`.
