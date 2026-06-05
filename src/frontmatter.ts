// Strict YAML-subset frontmatter parser for cronfish job files.
//
// Supported scalar types: string, integer, boolean. No floats, no arrays,
// no nesting, no nulls. Every key is validated against an expected type;
// unexpected types throw with file + key + expected + got.
//
// `every:` is no longer accepted — use `schedule:`.

export type Scalar = string | number | boolean;

export interface ParsedFrontmatter {
  frontmatter: Record<string, Scalar>;
  body: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

function parseScalar(val: string): Scalar {
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  return val;
}

function stripInlineComment(val: string): string {
  // Strip ` #...` (space-then-hash) only when the value is unquoted.
  // Quoted values keep `#` literally.
  if (val.startsWith('"') || val.startsWith("'")) return val;
  const idx = val.search(/\s#/);
  return idx >= 0 ? val.slice(0, idx).trim() : val;
}

function unquote(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    return val.slice(1, -1);
  }
  return val;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const m = raw.match(FM_RE);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, Scalar> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) {
      throw new FrontmatterError(
        `line ${i + 1}: missing ":" — frontmatter is "key: value" only`,
      );
    }
    const key = trimmed.slice(0, idx).trim();
    if (!key) throw new FrontmatterError(`line ${i + 1}: empty key`);
    const rawVal = trimmed.slice(idx + 1).trim();
    const cleaned = unquote(stripInlineComment(rawVal));
    if (key === "every") {
      throw new FrontmatterError(
        `key "every" is no longer supported — rename to "schedule"`,
      );
    }
    fm[key] = parseScalar(cleaned);
  }
  return { frontmatter: fm, body: m[2] };
}

// --- Shell job frontmatter parser ---
//
// Shell scripts use a comment-block frontmatter delimited by `# ---` lines.
// Each inner line is `# key: value`. The leading `# ` is stripped and the
// inner block is fed through parseFrontmatter so the same scalar rules apply.
//
//   #!/bin/bash
//   # ---
//   # schedule: every 5 minutes
//   # timeout: 30
//   # ---
//   echo hello

// The fence block itself — does NOT consume the leading shebang/blank lines.
const SH_FM_BLOCK_RE = /# ---\r?\n([\s\S]*?)\r?\n# ---\r?\n?/;

// Where is the start of "the top" — after a shebang if present, else 0.
function topOffset(raw: string): number {
  if (!raw.startsWith("#!")) return 0;
  const nl = raw.indexOf("\n");
  return nl < 0 ? raw.length : nl + 1;
}

// Find the fence block only if it lives at the top of the file (immediately
// after the shebang, modulo blank lines). Returns the match index/length and
// the inner content, or null.
function findShellFmBlock(
  raw: string,
): { start: number; end: number; inner: string } | null {
  const top = topOffset(raw);
  const rest = raw.slice(top);
  const lead = rest.match(/^(?:\s*\n)*/);
  const leadLen = lead ? lead[0].length : 0;
  const m = rest.slice(leadLen).match(SH_FM_BLOCK_RE);
  if (!m || m.index !== 0) return null;
  return {
    start: top + leadLen,
    end: top + leadLen + m[0].length,
    inner: m[1],
  };
}

export function parseShellFrontmatter(raw: string): Record<string, Scalar> {
  const block = findShellFmBlock(raw);
  if (!block) return {};
  const inner = block.inner
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#\s?/, ""))
    .join("\n");
  const fake = `---\n${inner}\n---\n`;
  return parseFrontmatter(fake).frontmatter;
}

// --- TS job config parser ---
//
// Reads `config = { ... }` from a TS source by hand-scanning brace depth so
// nested objects (e.g. `env: { FOO: "bar" }`) don't trip the matcher.

export interface TsJobConfigShape {
  schedule?: string | number;
  enabled?: boolean;
  timeout?: number;
  retries?: number;
  concurrency?: "skip" | "queue";
  model?: string;
}

function extractConfigBlock(source: string): string | null {
  const re = /\bconfig\b\s*(?::\s*[^=]+)?=\s*\{/g;
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let inStr: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    const prev = source[i - 1];
    if (inStr) {
      if (c === inStr && prev !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i);
    }
  }
  return null;
}

function pickFromConfig(body: string, key: string): string | undefined {
  // Match `key:` only at the top level (depth 0) of the config block.
  let depth = 0;
  let inStr: string | null = null;
  const re = new RegExp(`\\b${key}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    let d = 0;
    let s: string | null = null;
    for (let i = 0; i < m.index; i++) {
      const c = body[i];
      const prev = body[i - 1];
      if (s) {
        if (c === s && prev !== "\\") s = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        s = c;
        continue;
      }
      if (c === "{") d++;
      else if (c === "}") d--;
    }
    if (d !== 0 || s !== null) continue;
    // After the key, expect ":"
    const after = body.slice(m.index + key.length).match(/^\s*:\s*([^,\n}]+)/);
    if (!after) continue;
    return after[1]
      .trim()
      .replace(/[,;]+$/, "")
      .replace(/\s+as\s+(?:const|[A-Za-z_$][\w$.]*)\s*$/, "")
      .trim();
  }
  return undefined;
  void depth;
  void inStr;
}

export function parseTsJobConfig(source: string): TsJobConfigShape {
  const body = extractConfigBlock(source);
  if (!body) return {};
  const cfg: TsJobConfigShape = {};

  const sched = pickFromConfig(body, "schedule");
  if (pickFromConfig(body, "every") !== undefined) {
    throw new FrontmatterError(
      `key "every" is no longer supported — rename to "schedule"`,
    );
  }
  if (sched !== undefined) {
    const u = sched.replace(/^['"`]|['"`]$/g, "");
    cfg.schedule = /^-?\d+$/.test(u) ? parseInt(u, 10) : u;
  }
  const enabled = pickFromConfig(body, "enabled");
  if (enabled === "true") cfg.enabled = true;
  else if (enabled === "false") cfg.enabled = false;
  else if (enabled !== undefined) {
    throw new FrontmatterError(
      `enabled must be true or false, got: ${enabled}`,
    );
  }
  const timeout = pickFromConfig(body, "timeout");
  if (timeout !== undefined) {
    if (!/^\d+$/.test(timeout)) {
      throw new FrontmatterError(
        `timeout must be a positive integer, got: ${timeout}`,
      );
    }
    cfg.timeout = parseInt(timeout, 10);
  }
  const retries = pickFromConfig(body, "retries");
  if (retries !== undefined) {
    if (!/^\d+$/.test(retries)) {
      throw new FrontmatterError(
        `retries must be a non-negative integer, got: ${retries}`,
      );
    }
    cfg.retries = parseInt(retries, 10);
  }
  const concurrency = pickFromConfig(body, "concurrency");
  if (concurrency !== undefined) {
    const c = concurrency.replace(/^['"`]|['"`]$/g, "");
    if (c !== "skip" && c !== "queue") {
      throw new FrontmatterError(
        `concurrency must be "skip" or "queue", got: ${c}`,
      );
    }
    cfg.concurrency = c;
  }
  const model = pickFromConfig(body, "model");
  if (model !== undefined) {
    cfg.model = model.replace(/^['"`]|['"`]$/g, "");
  }
  return cfg;
}

// Update or insert a key in a shell job's comment-block frontmatter. If no
// block exists, one is inserted after the shebang (or at the top if no
// shebang). Mirrors setFrontmatterKey but operates on `# key: value` lines
// inside `# ---` / `# ---` fences.
export function setShellFrontmatterKey(
  raw: string,
  key: string,
  value: Scalar,
): string {
  const rendered =
    typeof value === "string"
      ? value
      : value === true
        ? "true"
        : value === false
          ? "false"
          : String(value);
  const block = findShellFmBlock(raw);
  if (!block) {
    const inserted = `# ---\n# ${key}: ${rendered}\n# ---\n`;
    const top = topOffset(raw);
    return `${raw.slice(0, top)}${inserted}${raw.slice(top)}`;
  }
  const innerLines = block.inner.split(/\r?\n/);
  let found = false;
  const next = innerLines.map((line) => {
    const stripped = line.replace(/^\s*#\s?/, "");
    const idx = stripped.indexOf(":");
    if (idx < 0) return line;
    const k = stripped.slice(0, idx).trim();
    if (k !== key) return line;
    found = true;
    return `# ${k}: ${rendered}`;
  });
  if (!found) next.push(`# ${key}: ${rendered}`);
  const replacement = `# ---\n${next.join("\n")}\n# ---\n`;
  return `${raw.slice(0, block.start)}${replacement}${raw.slice(block.end)}`;
}

export function setFrontmatterKey(
  raw: string,
  key: string,
  value: Scalar,
): string {
  const m = raw.match(FM_RE);
  const rendered =
    typeof value === "string"
      ? value
      : value === true
        ? "true"
        : value === false
          ? "false"
          : String(value);
  if (!m) {
    return `---\n${key}: ${rendered}\n---\n${raw}`;
  }
  const lines = m[1].split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    const idx = line.indexOf(":");
    if (idx < 0) return line;
    const k = line.slice(0, idx).trim();
    if (k !== key) return line;
    found = true;
    return `${k}: ${rendered}`;
  });
  if (!found) next.push(`${key}: ${rendered}`);
  return raw.replace(FM_RE, `---\n${next.join("\n")}\n---\n${m[2] ?? ""}`);
}
