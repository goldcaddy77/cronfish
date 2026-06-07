import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alertStatusFor,
  buildUiUrl,
  chooseAdapterName,
  dispatchAlert,
  loadConsumerAlertsConfig,
  readLogTail,
} from "../src/alerts/dispatch.ts";
import {
  getPreviousFinishedStatus,
  finishInvocation,
  getJobIdBySlug,
  openDb,
  setInvocationAlert,
  startInvocation,
  upsertJob,
} from "../src/db.ts";
import type { JobMeta } from "../src/jobs.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "cronfish-test-"));
}

function fakeJob(overrides: Partial<JobMeta> = {}): JobMeta {
  return {
    slug: "test-md",
    path: "/tmp/test.md",
    kind: "md",
    enabled: true,
    schedule: "every 5 minutes",
    ...overrides,
  };
}

describe("alertStatusFor", () => {
  test("maps invocation statuses to alert statuses", () => {
    expect(alertStatusFor("fail")).toBe("fail");
    expect(alertStatusFor("timeout")).toBe("timeout");
    expect(alertStatusFor("crashed")).toBe("crashed");
    expect(alertStatusFor("ok")).toBeNull();
    expect(alertStatusFor("running")).toBeNull();
  });
});

describe("chooseAdapterName", () => {
  test("job override wins over default", () => {
    expect(
      chooseAdapterName({ notify: "shell" }, { default: "slack" }),
    ).toBe("shell");
  });
  test("falls back to alerts.default", () => {
    expect(chooseAdapterName(undefined, { default: "slack" })).toBe("slack");
  });
  test("returns null when nothing configured", () => {
    expect(chooseAdapterName(undefined, undefined)).toBeNull();
    expect(chooseAdapterName({}, {})).toBeNull();
  });
});

describe("buildUiUrl", () => {
  test("appends /runs/<id>", () => {
    expect(
      buildUiUrl({ ui: { public_url: "https://x.example/" } }, 42),
    ).toBe("https://x.example/runs/42");
  });
  test("returns null when no public_url", () => {
    expect(buildUiUrl({}, 1)).toBeNull();
  });
});

describe("readLogTail", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("returns last 20 lines from a log file", () => {
    const path = join(root, "log.txt");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    writeFileSync(path, lines.join("\n"));
    const tail = readLogTail(path);
    const tailLines = tail.split("\n");
    expect(tailLines.length).toBe(20);
    expect(tailLines[tailLines.length - 1]).toBe("line 49");
  });

  test("returns empty when path missing", () => {
    expect(readLogTail(join(root, "nope.log"))).toBe("");
  });

  test("truncates to 4 KB", () => {
    const path = join(root, "fat.log");
    const big = Array.from({ length: 30 }, () => "x".repeat(500)).join("\n");
    writeFileSync(path, big);
    const tail = readLogTail(path);
    expect(Buffer.byteLength(tail, "utf-8")).toBeLessThanOrEqual(4 * 1024);
  });
});

describe("loadConsumerAlertsConfig", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("reads alerts + ui sections", () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({
        bundle_prefix: "com.test",
        alerts: { default: "slack", slack: { webhook_url_env: "X" } },
        ui: { public_url: "https://ui.example" },
      }),
    );
    const cfg = loadConsumerAlertsConfig(root);
    expect(cfg.alerts?.default).toBe("slack");
    expect(cfg.ui?.public_url).toBe("https://ui.example");
  });

  test("returns empty object when file missing", () => {
    expect(loadConsumerAlertsConfig(root)).toEqual({});
  });
});

describe("dispatchAlert", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("skipped when no adapter configured", async () => {
    const outcome = await dispatchAlert({
      job: fakeJob(),
      invocationId: 1,
      invocationStatus: "fail",
      alertStatus: "fail",
      exitCode: 1,
      durationMs: 100,
      startedAt: "2026-06-06T00:00:00.000Z",
      logPath: "/dev/null",
      consumerRoot: root,
    });
    expect(outcome.kind).toBe("skipped");
  });

  test("sent when slack adapter succeeds", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({
        alerts: { default: "slack", slack: { webhook_url_env: "TEST_HOOK" } },
      }),
    );
    process.env.TEST_HOOK = "https://hooks.example/x";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("ok", { status: 200 })) as typeof fetch;
    try {
      const outcome = await dispatchAlert({
        job: fakeJob(),
        invocationId: 1,
        invocationStatus: "fail",
        alertStatus: "fail",
        exitCode: 1,
        durationMs: 100,
        startedAt: "2026-06-06T00:00:00.000Z",
        logPath: "/dev/null",
        consumerRoot: root,
      });
      expect(outcome.kind).toBe("sent");
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.TEST_HOOK;
    }
  });

  test("error when webhook fails — never throws", async () => {
    writeFileSync(
      join(root, ".cronfish.json"),
      JSON.stringify({
        alerts: { default: "slack", slack: { webhook_url_env: "TEST_HOOK2" } },
      }),
    );
    process.env.TEST_HOOK2 = "https://hooks.example/x";
    const origFetch = globalThis.fetch;
    const origErr = console.error;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    console.error = () => {};
    try {
      const outcome = await dispatchAlert({
        job: fakeJob(),
        invocationId: 1,
        invocationStatus: "fail",
        alertStatus: "fail",
        exitCode: 1,
        durationMs: 100,
        startedAt: "2026-06-06T00:00:00.000Z",
        logPath: "/dev/null",
        consumerRoot: root,
      });
      expect(outcome.kind).toBe("error");
    } finally {
      globalThis.fetch = origFetch;
      console.error = origErr;
      delete process.env.TEST_HOOK2;
    }
  });

  test("error when on_failure references unknown adapter", async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
      const outcome = await dispatchAlert({
        job: fakeJob({ on_failure: { notify: "pushover" } }),
        invocationId: 1,
        invocationStatus: "fail",
        alertStatus: "fail",
        exitCode: 1,
        durationMs: 100,
        startedAt: "2026-06-06T00:00:00.000Z",
        logPath: "/dev/null",
        consumerRoot: root,
      });
      expect(outcome.kind).toBe("error");
    } finally {
      console.error = origErr;
    }
  });
});

describe("ledger v4 alert columns", () => {
  let root: string;
  beforeEach(() => {
    root = tempRoot();
    mkdirSync(join(root, ".cronfish"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("migration adds alert_status + alert_error columns", () => {
    const db = openDb(root);
    const cols = db.query("PRAGMA table_info(cron_invocations)").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("alert_status");
    expect(names).toContain("alert_error");
    db.close();
  });

  test("setInvocationAlert + getPreviousFinishedStatus round-trip", () => {
    const db = openDb(root);
    const job = fakeJob();
    upsertJob(db, job);
    const jobId = getJobIdBySlug(db, job.slug)!;
    const firstId = startInvocation(db, jobId, "schedule", "/log/1");
    finishInvocation(db, firstId, "fail", 1);
    setInvocationAlert(db, firstId, "sent", null);

    const secondId = startInvocation(db, jobId, "schedule", "/log/2");
    expect(getPreviousFinishedStatus(db, jobId, secondId)).toBe("fail");

    finishInvocation(db, secondId, "ok", 0);
    setInvocationAlert(db, secondId, "recovered", null);

    const rows = db
      .query(
        "SELECT id, alert_status, alert_error FROM cron_invocations ORDER BY id",
      )
      .all() as { id: number; alert_status: string; alert_error: string | null }[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.alert_status).toBe("sent");
    expect(rows[1]!.alert_status).toBe("recovered");
    db.close();
  });
});
