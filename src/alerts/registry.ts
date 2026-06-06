import { createShellAdapter } from "./shell.ts";
import { createSlackAdapter } from "./slack.ts";
import type { Adapter, AlertsConfig } from "./types.ts";

export interface AdapterRegistry {
  get(name: string): Adapter;
  has(name: string): boolean;
  defaultName(): string | null;
}

export function buildRegistry(cfg: AlertsConfig = {}): AdapterRegistry {
  const map = new Map<string, Adapter>();
  map.set("slack", createSlackAdapter(cfg.slack));
  map.set("shell", createShellAdapter(cfg.shell));
  return {
    get(name) {
      const a = map.get(name);
      if (!a) {
        const known = [...map.keys()].join(", ");
        throw new Error(
          `unknown alert adapter "${name}" (known: ${known}). ` +
            `Check on_failure.notify / alerts.default in .cronfish.json.`,
        );
      }
      return a;
    },
    has(name) {
      return map.has(name);
    },
    defaultName() {
      return cfg.default ?? null;
    },
  };
}
