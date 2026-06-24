---
run_at: "+10s" # relative to file mtime (s|m|h|d), OR an absolute ISO timestamp
model: haiku
enabled: false # flip on with `cronfish enable one-time/reminder-md`
timeout: 60
---

One-shot reminder. Fires once at `run_at`, then archives itself to
`~/Library/Application Support/cronfish/done/` — outside the repo.

Swap the relative `+10s` for an absolute time when you mean a real reminder, e.g.:

```
run_at: 2026-07-01T15:00:00-04:00
```

Body (this is the Claude prompt that runs once):

Post a Slack DM / write a note that says: "Reminder: stand up and stretch." Then stop.
Do nothing else. This job must tolerate being invoked twice and do no harm on the second
run — cronfish's flock + `executed_at` guard normally prevents that, but write idempotent
bodies anyway.
