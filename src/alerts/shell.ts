import { spawn } from "node:child_process";
import type { Adapter, AlertPayload, AlertsConfig } from "./types.ts";

export function payloadEnv(payload: AlertPayload): Record<string, string> {
  return {
    CRONFISH_ALERT_SLUG: payload.slug,
    CRONFISH_ALERT_STATUS: payload.status,
    CRONFISH_ALERT_EXIT_CODE: payload.exit_code == null ? "" : String(payload.exit_code),
    CRONFISH_ALERT_DURATION_MS: payload.duration_ms == null ? "" : String(payload.duration_ms),
    CRONFISH_ALERT_STARTED_AT: payload.started_at,
    CRONFISH_ALERT_UI_URL: payload.ui_url ?? "",
    CRONFISH_ALERT_LOG_TAIL: payload.log_tail,
  };
}

export interface ShellAdapterOptions {
  // Inject a custom runner for tests. Receives the resolved command + env vars
  // + JSON stdin and resolves on completion.
  run?: (
    command: string,
    env: Record<string, string>,
    stdin: string,
  ) => Promise<void>;
}

function defaultRun(
  command: string,
  env: Record<string, string>,
  stdin: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`shell adapter: command exited ${code}`));
    });
    child.stdin.end(stdin);
  });
}

export function createShellAdapter(
  cfg: AlertsConfig["shell"] = {},
  opts: ShellAdapterOptions = {},
): Adapter {
  const command = cfg.command;
  const run = opts.run ?? defaultRun;
  return {
    name: "shell",
    async notify(payload: AlertPayload): Promise<void> {
      if (!command) {
        throw new Error("shell adapter: alerts.shell.command not configured");
      }
      const env = payloadEnv(payload);
      const stdin = JSON.stringify(payload);
      await run(command, env, stdin);
    },
  };
}
