# cronfish examples

Copy any of these into your own `cron/` directory, tweak the frontmatter, and run
`cronfish sync`. They all ship **`enabled: false`** so nothing fires until you flip it on
with `cronfish enable <slug>`.

| File | Kind | Shows |
| --- | --- | --- |
| [`hello.md`](./hello.md) | recurring · Markdown agent | An agentic Claude job — the whole body is the prompt |
| [`healthcheck.ts`](./healthcheck.ts) | recurring · TypeScript | A deterministic Bun job with typed `config` |
| [`disk-space.sh`](./disk-space.sh) | recurring · Bash | A shell job with a `# ---` frontmatter block |
| [`one-time/reminder.md`](./one-time/reminder.md) | one-shot · Markdown | Fire-once at a `run_at` timestamp |
| [`one-time/cleanup.ts`](./one-time/cleanup.ts) | one-shot · TypeScript | Idempotent one-shot with the flock + `executed_at` pattern |
| [`.cronfish.json`](./.cronfish.json) | config | Bundle prefix, bun path, UI URL, Slack + shell alerts |

## The 60-second loop

```bash
cp examples/healthcheck.ts cron/healthcheck.ts   # drop a file
cronfish list                                    # it shows up as `healthcheck-ts` (disabled)
cronfish enable healthcheck-ts                    # flip on + sync to launchd
cronfish next healthcheck-ts                       # preview the next 5 fire times
cronfish run healthcheck-ts                         # run it now, no launchd, for testing
```

No code change registers a job — the file *is* the registration. See the
[root README](../README.md) for the full job spec, schedule shapes, alerts, and the
one-time `run_at` semantics.
