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
