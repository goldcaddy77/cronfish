#!/usr/bin/env bun
// Tiny shim: import a cronfish TS job by absolute path, validate its shape,
// then await its default export. Stdout/stderr go to the parent runner's log
// file via FD redirection.
//
// If the default export returns a non-null/non-undefined value, the shim
// emits a `__CRONFISH_RESULT_V1__::<json>` sentinel line so the runner can
// persist it to the ledger. Void return = no sentinel (back-compat).

import { SENTINEL_PREFIX } from "./result.ts";

interface TsJobModule {
  config: Record<string, unknown>;
  default: () => Promise<unknown> | unknown;
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (!jobPath) {
    console.error("ts-shim: missing job path");
    process.exit(2);
  }
  const mod = (await import(jobPath)) as TsJobModule;
  if (!mod.config || typeof mod.default !== "function") {
    throw new Error(
      `${jobPath}: must export \`config\` and a default async function`,
    );
  }
  const ret = await mod.default();
  if (ret !== null && ret !== undefined) {
    try {
      console.log(SENTINEL_PREFIX + JSON.stringify(ret));
    } catch (e) {
      console.error(
        `ts-shim: failed to serialize result: ${(e as Error).message}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(`ts-shim ERROR: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
