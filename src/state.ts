// Persistent cronfish state. Today tracks `seen_prefixes` so we can clean up
// orphaned plists when `bundle_prefix` changes.
//
// Location: <consumer>/tmp/.cronfish/state.json. Lives under tmp/ on purpose
// — losing it is recoverable (worst case: orphan plists remain until manual
// bootout). Treating it as durable would mean .gitignore plumbing on every
// consumer.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CronfishState {
  seen_prefixes: string[];
}

const EMPTY: CronfishState = { seen_prefixes: [] };

function statePath(consumerRoot: string): string {
  return join(consumerRoot, "tmp", ".cronfish", "state.json");
}

export function loadState(consumerRoot: string): CronfishState {
  const p = statePath(consumerRoot);
  if (!existsSync(p)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(
      readFileSync(p, "utf-8"),
    ) as Partial<CronfishState>;
    return {
      seen_prefixes: Array.isArray(parsed.seen_prefixes)
        ? parsed.seen_prefixes.filter((x) => typeof x === "string")
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveState(consumerRoot: string, state: CronfishState): void {
  const p = statePath(consumerRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), "utf-8");
}

export function rememberPrefix(
  consumerRoot: string,
  prefix: string,
): CronfishState {
  const state = loadState(consumerRoot);
  if (!state.seen_prefixes.includes(prefix)) {
    state.seen_prefixes.push(prefix);
    saveState(consumerRoot, state);
  }
  return state;
}
