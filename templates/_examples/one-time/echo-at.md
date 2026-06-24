---
description: "Smoke test for cron/one-time/ — fires once at +10s and writes a tempfile"
run_at: "+10s"
model: haiku
timeout: 30
---

Append the line `hello from one-time` to `/tmp/cronfish-one-time-smoke.txt` (create the file if needed). Then print exactly:

`__CRONFISH_RESULT_V1__::{"summary":"echo-at fired","ok":true}`
