// Per-run structured result parsing.
//
// Every job may print one tagged sentinel line on stdout:
//   __CRONFISH_RESULT_V1__::{"summary":"...","ok":true,"metrics":{...},"links":[...]}
//
// The runner reads the last 64KB of the log file post-exit, scans backward for
// the LAST sentinel line, and validates it. Anything that fails (missing,
// malformed JSON, schema violation) returns { result: null } and warns to
// stderr — never blocks the run.

import { openSync, closeSync, fstatSync, readSync } from "node:fs";

export const SENTINEL_PREFIX = "__CRONFISH_RESULT_V1__::";
const TAIL_BYTES = 64 * 1024;
const MAX_SUMMARY = 140;

export interface JobResult {
  summary: string;
  ok?: boolean;
  metrics?: Record<string, number | string | boolean>;
  links?: string[];
}

export interface ParsedResult {
  result: JobResult | null;
  truncated: boolean;
}

function warn(msg: string): void {
  console.error(`[result] WARN: ${msg}`);
}

function validate(raw: unknown): JobResult | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.summary !== "string") return null;
  if (o.summary.length === 0 || o.summary.length > MAX_SUMMARY) return null;
  const out: JobResult = { summary: o.summary };
  if (o.ok !== undefined) {
    if (typeof o.ok !== "boolean") return null;
    out.ok = o.ok;
  }
  if (o.metrics !== undefined) {
    if (!o.metrics || typeof o.metrics !== "object" || Array.isArray(o.metrics))
      return null;
    const m: Record<string, number | string | boolean> = {};
    for (const [k, v] of Object.entries(o.metrics as Record<string, unknown>)) {
      const t = typeof v;
      if (t !== "number" && t !== "string" && t !== "boolean") return null;
      m[k] = v as number | string | boolean;
    }
    out.metrics = m;
  }
  if (o.links !== undefined) {
    if (!Array.isArray(o.links)) return null;
    if (!o.links.every((l) => typeof l === "string")) return null;
    out.links = o.links as string[];
  }
  return out;
}

function readTail(logPath: string): { text: string; truncated: boolean } {
  const fd = openSync(logPath, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf-8"), truncated: start > 0 };
  } finally {
    closeSync(fd);
  }
}

export async function parseLastResult(logPath: string): Promise<ParsedResult> {
  let tail: { text: string; truncated: boolean };
  try {
    tail = readTail(logPath);
  } catch (e) {
    warn(`read ${logPath} failed: ${(e as Error).message}`);
    return { result: null, truncated: false };
  }
  const lines = tail.text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf(SENTINEL_PREFIX);
    if (idx === -1) continue;
    // If our tail started mid-line, the first line may be partial. Skip it
    // if it's at index 0 and the tail was truncated.
    if (i === 0 && tail.truncated) {
      warn(`sentinel found on possibly-truncated first line of tail`);
      return { result: null, truncated: tail.truncated };
    }
    const payload = line.slice(idx + SENTINEL_PREFIX.length).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (e) {
      warn(`invalid JSON after sentinel: ${(e as Error).message}`);
      return { result: null, truncated: tail.truncated };
    }
    const validated = validate(parsed);
    if (!validated) {
      warn(`sentinel payload failed schema validation`);
      return { result: null, truncated: tail.truncated };
    }
    return { result: validated, truncated: tail.truncated };
  }
  return { result: null, truncated: tail.truncated };
}
