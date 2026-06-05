// Local web dashboard for cronfish. Bound to 127.0.0.1 (no auth).
//
// Serves the prebuilt ui/dist/ bundle + a JSON API + a Range-aware log
// streaming endpoint. The dashboard is read-only — no mutating endpoints.

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { openDb } from "../db.ts";
import { dispatchSchedule } from "../schedule.ts";

export interface UiServerOptions {
  consumerRoot: string;
  port: number;
  hostname?: string;
}

interface JobRow {
  id: number;
  slug: string;
  kind: string;
  schedule: string;
  enabled: number;
  timeout_s: number | null;
  retries: number;
  concurrency: string;
  model: string | null;
  description: string | null;
  last_synced_at: string;
  deleted_at: string | null;
}

function filenameFromSlug(slug: string): string {
  // slug encodes the kind as `-<ext>` — reverse it to get the on-disk name.
  return slug.replace(/-(md|ts|sh|py)$/, ".$1");
}

function nextRunIso(
  schedule: string,
  lastStartedAt: string | null,
): string | null {
  try {
    const d = dispatchSchedule(schedule);
    if (d.kind !== "seconds") return null;
    const baseMs = lastStartedAt
      ? new Date(lastStartedAt).getTime()
      : Date.now();
    const periodMs = d.value * 1000;
    let next = baseMs + periodMs;
    if (next <= Date.now()) {
      // skip past missed fires
      const elapsed = Date.now() - baseMs;
      next = baseMs + Math.ceil(elapsed / periodMs) * periodMs;
    }
    return new Date(next).toISOString();
  } catch {
    return null;
  }
}

interface InvocationRow {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  exit_code: number | null;
  trigger: string;
  log_path: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function distRoot(): string {
  // server.ts lives at src/ui/server.ts in source, but is consumed from the
  // installed package layout. Walk up from this file to repo root and join
  // "ui/dist". URL → pathname avoids node:url import.
  const here = new URL(".", import.meta.url).pathname;
  return resolve(here, "..", "..", "ui", "dist");
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

function notFound(msg = "not found"): Response {
  return new Response(msg, { status: 404 });
}

function badRequest(msg: string): Response {
  return new Response(msg, { status: 400 });
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const dist = distRoot();
  if (!existsSync(dist)) return null;
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(rel).replace(/^\/+/, "");
  if (safe.startsWith("..")) return null;
  const full = join(dist, safe);
  if (!full.startsWith(dist)) return null;
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (st.isDirectory()) return null;
  const file = Bun.file(full);
  const mime = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
  return new Response(file, { headers: { "content-type": mime } });
}

async function spaFallback(): Promise<Response> {
  const dist = distRoot();
  const indexPath = join(dist, "index.html");
  if (!existsSync(indexPath)) {
    return new Response(
      "cronfish ui bundle not found.\n\n" +
        `Expected: ${indexPath}\n\n` +
        "If you're running from source, build it first:\n" +
        "  cd ui && bun install && bun run build\n",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  let start: number;
  let end: number;
  if (startRaw === "" && endRaw === "") return null;
  if (startRaw === "") {
    // suffix range: last N bytes
    const n = parseInt(endRaw, 10);
    if (Number.isNaN(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(startRaw, 10);
    end = endRaw === "" ? size - 1 : parseInt(endRaw, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

async function serveLog(
  consumerRoot: string,
  invocationId: number,
  rangeHeader: string | null,
): Promise<Response> {
  const db = openDb(consumerRoot);
  try {
    const inv = db
      .query("SELECT log_path FROM cron_invocations WHERE id = $id")
      .get({ $id: invocationId }) as { log_path: string } | undefined;
    if (!inv) return notFound("invocation not found");
    const path = inv.log_path;
    if (!existsSync(path)) {
      return new Response("[log file missing]\n", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const st = statSync(path);
    const size = st.size;
    const range = parseRange(rangeHeader, size);
    const file = Bun.file(path);
    if (range) {
      const sliced = file.slice(range.start, range.end + 1);
      return new Response(sliced, {
        status: 206,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "content-range": `bytes ${range.start}-${range.end}/${size}`,
          "content-length": String(range.end - range.start + 1),
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        },
      });
    }
    return new Response(file, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-length": String(size),
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      },
    });
  } finally {
    db.close();
  }
}

function listJobs(consumerRoot: string): unknown {
  const db = openDb(consumerRoot);
  try {
    const jobs = db
      .query<
        JobRow & {
          last_status: string | null;
          last_started_at: string | null;
          last_finished_at: string | null;
          last_exit_code: number | null;
          last_duration_ms: number | null;
          last_invocation_id: number | null;
        },
        []
      >(
        `
        SELECT j.*,
               last.status         AS last_status,
               last.started_at     AS last_started_at,
               last.finished_at    AS last_finished_at,
               last.exit_code      AS last_exit_code,
               last.id             AS last_invocation_id,
               CASE
                 WHEN last.finished_at IS NULL THEN NULL
                 ELSE CAST(
                   (julianday(last.finished_at) - julianday(last.started_at)) * 86400000 AS INTEGER
                 )
               END AS last_duration_ms
        FROM cron_jobs j
        LEFT JOIN cron_invocations last
          ON last.id = (
            SELECT id FROM cron_invocations
            WHERE job_id = j.id
            ORDER BY started_at DESC
            LIMIT 1
          )
        ORDER BY j.deleted_at IS NOT NULL, j.slug
      `,
      )
      .all();
    return jobs.map((j) => ({
      ...j,
      filename: filenameFromSlug(j.slug),
      next_run: nextRunIso(j.schedule, j.last_started_at),
    }));
  } finally {
    db.close();
  }
}

function getJob(consumerRoot: string, slug: string): unknown {
  const db = openDb(consumerRoot);
  try {
    const job = db
      .query<JobRow, [string]>("SELECT * FROM cron_jobs WHERE slug = ?")
      .get(slug);
    if (!job) return null;
    const lastInv = db
      .query<{ started_at: string | null }, [string]>(
        `SELECT i.started_at FROM cron_invocations i
         JOIN cron_jobs j ON j.id = i.job_id
         WHERE j.slug = ?
         ORDER BY i.started_at DESC LIMIT 1`,
      )
      .get(slug);
    return {
      ...job,
      filename: filenameFromSlug(job.slug),
      next_run: nextRunIso(job.schedule, lastInv?.started_at ?? null),
    };
  } finally {
    db.close();
  }
}

function listInvocations(
  consumerRoot: string,
  slug: string,
  limit: number,
): unknown {
  const db = openDb(consumerRoot);
  try {
    const rows = db
      .query<InvocationRow & { duration_ms: number | null }, [string, number]>(
        `
        SELECT i.*,
          CASE
            WHEN i.finished_at IS NULL THEN NULL
            ELSE CAST(
              (julianday(i.finished_at) - julianday(i.started_at)) * 86400000 AS INTEGER
            )
          END AS duration_ms
        FROM cron_invocations i
        JOIN cron_jobs j ON j.id = i.job_id
        WHERE j.slug = ?
        ORDER BY i.started_at DESC
        LIMIT ?
      `,
      )
      .all(slug, limit);
    return rows;
  } finally {
    db.close();
  }
}

function getInvocation(consumerRoot: string, id: number): unknown {
  const db = openDb(consumerRoot);
  try {
    const row = db
      .query<
        InvocationRow & { slug: string; duration_ms: number | null },
        [number]
      >(
        `
        SELECT i.*, j.slug AS slug,
          CASE
            WHEN i.finished_at IS NULL THEN NULL
            ELSE CAST(
              (julianday(i.finished_at) - julianday(i.started_at)) * 86400000 AS INTEGER
            )
          END AS duration_ms
        FROM cron_invocations i
        JOIN cron_jobs j ON j.id = i.job_id
        WHERE i.id = ?
      `,
      )
      .get(id);
    return row ?? null;
  } finally {
    db.close();
  }
}

export async function startUiServer(opts: UiServerOptions): Promise<string> {
  const hostname = opts.hostname ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: opts.port,
    fetch: async (req) => {
      const url = new URL(req.url);
      const { pathname } = url;

      // --- API ---
      if (pathname === "/api/jobs" && req.method === "GET") {
        return json(listJobs(opts.consumerRoot));
      }

      const jobDetail = pathname.match(/^\/api\/jobs\/([^/]+)$/);
      if (jobDetail && req.method === "GET") {
        const slug = decodeURIComponent(jobDetail[1]);
        const row = getJob(opts.consumerRoot, slug);
        return row ? json(row) : notFound("job not found");
      }

      const jobInv = pathname.match(/^\/api\/jobs\/([^/]+)\/invocations$/);
      if (jobInv && req.method === "GET") {
        const slug = decodeURIComponent(jobInv[1]);
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : 50;
        if (Number.isNaN(limit) || limit <= 0 || limit > 1000) {
          return badRequest("limit must be 1..1000");
        }
        return json(listInvocations(opts.consumerRoot, slug, limit));
      }

      const invDetail = pathname.match(/^\/api\/invocations\/(\d+)$/);
      if (invDetail && req.method === "GET") {
        const id = parseInt(invDetail[1], 10);
        const row = getInvocation(opts.consumerRoot, id);
        return row ? json(row) : notFound("invocation not found");
      }

      const invLog = pathname.match(/^\/api\/invocations\/(\d+)\/log$/);
      if (invLog && req.method === "GET") {
        const id = parseInt(invLog[1], 10);
        return serveLog(opts.consumerRoot, id, req.headers.get("range"));
      }

      if (pathname.startsWith("/api/")) return notFound("unknown api route");

      // --- Static + SPA ---
      const staticHit = await serveStatic(pathname);
      if (staticHit) return staticHit;
      return spaFallback();
    },
    error: (err) => {
      console.error("[cronfish ui]", err);
      return new Response(`server error: ${err.message}`, { status: 500 });
    },
  });
  return `http://${server.hostname}:${server.port}`;
}
