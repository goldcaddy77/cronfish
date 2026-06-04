// Platform selector. v0.x ships launchd only; this seam exists so systemd /
// Task Scheduler backends can hang off the same interface without touching
// cli.ts.

import * as launchd from "./launchd.ts";

export type Platform = typeof launchd;

export function platform(): Platform {
  if (process.platform === "darwin") return launchd;
  throw new Error(
    `cronfish currently supports macOS only (got ${process.platform}). Linux/Windows are on the roadmap.`,
  );
}
