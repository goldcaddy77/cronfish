#!/bin/bash
# ---
# schedule: every 6 hours
# enabled: false
# timeout: 30
# concurrency: skip
# ---
#
# Recurring bash job. Config lives in the `# ---` block above (after the shebang).
# Cronfish invokes this as `/bin/bash <path>` with cwd = your repo root; stdout and
# stderr go to the per-run log. A `.sh` file with NO frontmatter block fails at
# discovery on purpose — cronfish surfaces the error in `list`/`sync`.

set -euo pipefail

# Warn (non-zero exit → alert) when the root volume crosses this fullness threshold.
THRESHOLD=90

used=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
echo "root volume ${used}% used (threshold ${THRESHOLD}%)"

if [ "$used" -ge "$THRESHOLD" ]; then
  echo "disk usage ${used}% >= ${THRESHOLD}% — failing so the alert fires" >&2
  exit 1
fi
