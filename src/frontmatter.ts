// Strict YAML-subset frontmatter parser for cronfish job files.
//
// Supported scalar types: string, integer, boolean. No floats, no nulls.
// One level of nesting is supported (a key with no value followed by
// indented child key/value scalars) — used today only for `on_failure:`.
// Single-line inline arrays (`key: [a, "b c", d]`) are supported and land in
// a separate `lists` map — used by `env:` and `allowed_tools:`.
// Every key is validated against an expected type; unexpected types throw
// with file + key + expected + got.
//
// `every:` is no longer accepted — use `schedule:`.

export type Scalar = string | number | boolean;

export interface ParsedFrontmatter {
  frontmatter: Record<string, Scalar>;
  nested: Record<string, Record<string, Scalar>>;
  lists: Record<string, string[]>;
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

function indentOf(line: string): number {
  const m = line.match(/^( *)/);
  return m ? m[0].length : 0;
}

// Split on commas at bracket/brace/paren depth 0, respecting quotes. Shared by
// inline-array parsing (YAML and TS config). Tool patterns like
// `Bash(git *, git status)` keep their inner commas because parens raise depth.
function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let s: string | null = null;
  let d = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const prev = inner[i - 1];
    if (s) {
      buf += c;
      if (c === s && prev !== "\\") s = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      s = c;
      buf += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    if (c === "," && d === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

// Parse a single-line inline array `[a, "b c", d]` into a string[]. Everything
// after the closing `]` (e.g. a trailing ` # comment`) is ignored. An empty
// `[]` yields `[]` — meaningfully "declared but empty" (scope to nothing),
// distinct from the key being absent.
function parseInlineList(raw: string, lineNo: number): string[] {
  const t = raw.trim();
  const lb = t.indexOf("[");
  const rb = t.lastIndexOf("]");
  if (lb < 0 || rb < lb) {
    throw new FrontmatterError(
      `line ${lineNo}: inline array must open with "[" and close with "]" on the same line`,
    );
  }
  return splitTopLevelCommas(t.slice(lb + 1, rb))
    .map((p) => unquote(p.trim()).trim())
    .filter((p) => p.length > 0);
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const m = raw.match(FM_RE);
  if (!m) return { frontmatter: {}, nested: {}, lists: {}, body: raw };
  const fm: Record<string, Scalar> = {};
  const nested: Record<string, Record<string, Scalar>> = {};
  const lists: Record<string, string[]> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indentOf(line) > 0) {
      // Stray indented line outside a nested block — surface clearly.
      throw new FrontmatterError(
        `line ${i + 1}: unexpected indented line outside a nested block`,
      );
    }
    const idx = trimmed.indexOf(":");
    if (idx < 0) {
      throw new FrontmatterError(
        `line ${i + 1}: missing ":" — frontmatter is "key: value" only`,
      );
    }
    const key = trimmed.slice(0, idx).trim();
    if (!key) throw new FrontmatterError(`line ${i + 1}: empty key`);
    const rawVal = trimmed.slice(idx + 1).trim();
    if (key === "every") {
      throw new FrontmatterError(
        `key "every" is no longer supported — rename to "schedule"`,
      );
    }
    if (rawVal === "") {
      // Nested block — consume following indented lines.
      const child: Record<string, Scalar> = {};
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextTrimmed = next.trim();
        if (!nextTrimmed || nextTrimmed.startsWith("#")) {
          i++;
          continue;
        }
        if (indentOf(next) === 0) break;
        i++;
        const cIdx = nextTrimmed.indexOf(":");
        if (cIdx < 0) {
          throw new FrontmatterError(
            `line ${i + 1}: missing ":" inside nested "${key}" block`,
          );
        }
        const cKey = nextTrimmed.slice(0, cIdx).trim();
        if (!cKey)
          throw new FrontmatterError(`line ${i + 1}: empty nested key`);
        const cRaw = nextTrimmed.slice(cIdx + 1).trim();
        if (cRaw === "") {
          throw new FrontmatterError(
            `line ${i + 1}: nested key "${cKey}" needs a value (only one level of nesting supported)`,
          );
        }
        const cleaned = unquote(stripInlineComment(cRaw));
        child[cKey] = parseScalar(cleaned);
      }
      nested[key] = child;
      continue;
    }
    if (rawVal.startsWith("[")) {
      lists[key] = parseInlineList(rawVal, i + 1);
      continue;
    }
    const cleaned = unquote(stripInlineComment(rawVal));
    fm[key] = parseScalar(cleaned);
  }
  return { frontmatter: fm, nested, lists, body: m[2] };
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

export interface ParsedShellFrontmatter {
  frontmatter: Record<string, Scalar>;
  nested: Record<string, Record<string, Scalar>>;
  lists: Record<string, string[]>;
}

export function parseShellFrontmatter(raw: string): ParsedShellFrontmatter {
  const block = findShellFmBlock(raw);
  if (!block) return { frontmatter: {}, nested: {}, lists: {} };
  const inner = block.inner
    .split(/\r?\n/)
    // Strip the leading `# ` but preserve indentation after it so nested
    // `#   notify: x` lines come through as `  notify: x`.
    .map((line) => line.replace(/^\s*#(?: |$)/, ""))
    .join("\n");
  const fake = `---\n${inner}\n---\n`;
  const parsed = parseFrontmatter(fake);
  return {
    frontmatter: parsed.frontmatter,
    nested: parsed.nested,
    lists: parsed.lists,
  };
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
  description?: string;
  missed_after?: string;
  on_failure?: Record<string, Scalar>;
  // scoped secrets / capability fence (string arrays)
  env?: string[];
  // one-time jobs (cron/one-time/)
  run_at?: string | number;
  grace_seconds?: number;
  executed_at?: string;
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
  const description = pickFromConfig(body, "description");
  if (description !== undefined) {
    cfg.description = description.replace(/^['"`]|['"`]$/g, "");
  }
  const missedAfter = pickFromConfig(body, "missed_after");
  if (missedAfter !== undefined) {
    cfg.missed_after = missedAfter.replace(/^['"`]|['"`]$/g, "");
  }
  const onFailure = pickNestedObjectFromConfig(body, "on_failure");
  if (onFailure !== undefined) cfg.on_failure = onFailure;
  const env = pickListFromConfig(body, "env");
  if (env !== undefined) cfg.env = env;
  const runAt = pickFromConfig(body, "run_at");
  if (runAt !== undefined) {
    const u = runAt.replace(/^['"`]|['"`]$/g, "");
    cfg.run_at = /^-?\d+$/.test(u) ? parseInt(u, 10) : u;
  }
  const graceSeconds = pickFromConfig(body, "grace_seconds");
  if (graceSeconds !== undefined) {
    if (!/^\d+$/.test(graceSeconds)) {
      throw new FrontmatterError(
        `grace_seconds must be a non-negative integer, got: ${graceSeconds}`,
      );
    }
    cfg.grace_seconds = parseInt(graceSeconds, 10);
  }
  const executedAt = pickFromConfig(body, "executed_at");
  if (executedAt !== undefined) {
    cfg.executed_at = executedAt.replace(/^['"`]|['"`]$/g, "");
  }
  return cfg;
}

// Find `key: { ... }` at the top level of the config block and return the
// inner k/v pairs as scalars. Only supports flat objects with string / number /
// boolean values — same surface as the YAML nested block.
function pickNestedObjectFromConfig(
  body: string,
  key: string,
): Record<string, Scalar> | undefined {
  const re = new RegExp(`\\b${key}\\b\\s*:\\s*\\{`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    // Verify top-level
    let depth = 0;
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
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (depth !== 0 || s !== null) continue;
    const start = m.index + m[0].length;
    let d = 1;
    let str: string | null = null;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      const prev = body[i - 1];
      if (str) {
        if (c === str && prev !== "\\") str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        str = c;
        continue;
      }
      if (c === "{") d++;
      else if (c === "}") {
        d--;
        if (d === 0) {
          const inner = body.slice(start, i);
          return parseInlineObject(inner);
        }
      }
    }
    return undefined;
  }
  return undefined;
}

// Find `key: [ ... ]` at the top level of the config block and return the
// items as a string[]. Mirrors pickNestedObjectFromConfig but for arrays.
function pickListFromConfig(
  body: string,
  key: string,
): string[] | undefined {
  const re = new RegExp(`\\b${key}\\b\\s*:\\s*\\[`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    // Verify top-level (depth 0, not inside a string).
    let depth = 0;
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
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
    }
    if (depth !== 0 || s !== null) continue;
    const start = m.index + m[0].length;
    let d = 1;
    let str: string | null = null;
    for (let i = start; i < body.length; i++) {
      const c = body[i];
      const prev = body[i - 1];
      if (str) {
        if (c === str && prev !== "\\") str = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        str = c;
        continue;
      }
      if (c === "[" || c === "{") d++;
      else if (c === "]" || c === "}") {
        d--;
        if (d === 0) {
          const inner = body.slice(start, i);
          return splitTopLevelCommas(inner)
            .map((p) => p.trim().replace(/^['"`]|['"`]$/g, "").trim())
            .filter((p) => p.length > 0);
        }
      }
    }
    return undefined;
  }
  return undefined;
}

function parseInlineObject(inner: string): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  // Split on commas at depth 0.
  const parts: string[] = [];
  let buf = "";
  let s: string | null = null;
  let d = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const prev = inner[i - 1];
    if (s) {
      buf += c;
      if (c === s && prev !== "\\") s = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      s = c;
      buf += c;
      continue;
    }
    if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
    if (c === "," && d === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const idx = p.indexOf(":");
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim().replace(/^['"`]|['"`]$/g, "");
    const v = p.slice(idx + 1).trim().replace(/,$/, "").trim();
    if (!k) continue;
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else if (/^-?\d+$/.test(v)) out[k] = parseInt(v, 10);
    else out[k] = v.replace(/^['"`]|['"`]$/g, "");
  }
  return out;
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
