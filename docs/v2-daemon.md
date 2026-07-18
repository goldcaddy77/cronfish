# Cronfish v2 — daemon architecture

Design locked 2026-07-17 (CAD-691). This branch replaces per-job launchd plists with a single
supervised daemon backed by SQLite.

## Why

Per-job plists were chronically unreliable: N plists for launchd to juggle, a watchdog cron to
detect missed runs, and a liveness monitor to watch the watchdog. That stack is a tower of
workarounds for not having a daemon. v2 inverts it: launchd's only job is "keep one process
alive" — the thing launchd is actually good at.

## Architecture

- **One launchd entry, `KeepAlive=true`**, running a long-lived cronfish daemon process.
  Crashes → launchd restarts it. Wedges → heartbeat detection (below).
- **SQLite is runtime state**, extending the existing `.cronfish/db.sqlite`: a `jobs` table
  (`last_run`, `next_run`, state) plus the existing run records and new run-request rows.
- **Job files remain the source of truth for definitions.** The daemon mtime-scans the `cron/`
  directory on each tick; a changed file re-parses frontmatter and updates the schedule — edits
  take effect within one tick, no sync step.
- **Tick loop at 1 Hz**: every second, run every job whose `next_run <= now` by spawning a child
  process. The existing runner machinery (locks, logs, retries, result footers, concurrency
  skip/queue) is reused as-is — the daemon changes *who decides when to spawn*, not *how a job
  runs*. Jobs never execute in the daemon's own process: a hung or OOMing job can't take the
  scheduler down, and timeout = kill the child. 1s ticks also unlock sub-minute intervals.
- **Self-healing**: after downtime, the first tick simply finds everything with `next_run` in the
  past and runs it — **coalesced to ONE catch-up run per job**, never N. No per-job override.
- **Post-restore herd jitter** (`STARTUP_STALE_MS` / `STARTUP_JITTER_MS`): a db restored from
  backup (or a fresh db over existing job files) starts with every recurring job's `next_run` stale
  in the past — the naive first tick would dispatch all of them at once and hammer whatever the jobs
  call. On a **cold start** (heartbeat absent, or its last tick older than `STARTUP_STALE_MS` → the
  daemon was clearly down a while) the first tick leaves the single most-overdue recurring job to
  fire immediately and spreads the rest of the overdue catch-up wave across `STARTUP_JITTER_MS` (a
  few minutes). Fires once per process; a quick restart (fresh heartbeat) or a lone overdue job is
  left to dispatch normally. The staggered `next_run`s are persisted, so a re-restart mid-window
  can't re-form the herd.
- **`croner`** computes next occurrences for cron expressions (DST-correct); interval schedules
  are plain arithmetic.

## Schedule-change rule

One uniform rule, no special cases — on any interval change:

```
next_run = max(now, last_run + new_interval)
```

- Hourly → every-5-min with a 40-min-old last run: overdue → fires on the next tick.
- Every-5-min → hourly with a 2-min-old last run: lands 58 minutes out.
- Cron-expression schedules recompute the next occurrence from now.

## Job lifecycle FSM

`active` → `disabled` (frontmatter `enabled: false`) → `deleted` (file removed). Disabled and
deleted jobs never run; deleted rows are kept for run history, never dropped.

## The daemon is THE runner

Manual runs (`cron run <slug>`) insert a `trigger=manual` run-request row that the daemon picks
up — so alerting, logging, and metrics pipes apply to every run identically. One-time jobs become
rows with a `next_run` and no recurrence; the `cron/one-time/` special-casing goes away.

## Liveness

The daemon writes a heartbeat row to SQLite every tick. Missed-run alerting moves in-process (the
old standalone watchdog folds in). External liveness — the only outside check needed — is a
consumer-side monitor on that single heartbeat (the CAD-688 pattern in the agents repo).

## Housekeeping

Once per UTC day (a date-change check in the tick loop), the daemon runs the same opt-in
retention prune that `cronfish sync` runs: old per-run logs AND old ledger rows
(`cron_invocations`, `cron_run_requests`, `cron_missed_alerts`) beyond the configured
`max_age_days` window are deleted. `cron_jobs` rows are never deleted, and a `running` row
younger than 24h is always protected. No `retention` block in `.cronfish.json` → no deletion.

## Migration

Single-user hot swap: unload all per-job plists, confirm none remain, install the one daemon
plist. Both modes running on the same consumer must be impossible by construction, not by
discipline. v1 code stays on `main` until this branch is proven and merged (merge == npm publish).

## Build order

1. `croner` dependency + next-occurrence helpers
2. Schema migration: `jobs` table, run-request rows, heartbeat
3. Daemon: tick loop, file sync, dispatch, child-process spawning
4. `cron daemon install` + hot-swap teardown of per-job plists
5. In-daemon missed-run alerting; consumer liveness on the heartbeat
6. Migrate the agents-repo consumer; retire per-job plists
