// Shared config helpers. The bundle-prefix formula has to be identical
// everywhere a launchd label is computed — cli.ts (install/bootout) and
// runner.ts (one-time self-removal) both derive labels from it, so it lives
// here rather than being duplicated and drifting.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export function defaultBundlePrefix(consumerRoot: string): string {
  return `com.cronfish.${basename(consumerRoot)}`;
}

// Tolerant prefix read for non-CLI callers (the runner). Returns the default
// on a missing/unparseable .cronfish.json — the strict validation that the
// CLI applies at install time has already gated the value by the time a job
// is running, so the runner only needs to reproduce the same string.
export function loadBundlePrefix(consumerRoot: string): string {
  const def = defaultBundlePrefix(consumerRoot);
  const path = join(consumerRoot, ".cronfish.json");
  if (!existsSync(path)) return def;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      bundle_prefix?: string;
    };
    return (parsed.bundle_prefix ?? "").trim() || def;
  } catch {
    return def;
  }
}
