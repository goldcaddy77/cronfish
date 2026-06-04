#!/usr/bin/env bun
// Tiny shim: import a cronfish TS job by absolute path, validate its shape,
// then await its default export. Stdout/stderr go to the parent runner's log
// file via FD redirection.

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
  await mod.default();
}

main().catch((e) => {
  console.error(`ts-shim ERROR: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
