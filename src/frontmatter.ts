// Minimal YAML-subset frontmatter parser for cronfish job files.
// Supports the scalar keys we use: schedule, model, enabled, timeout,
// retries, concurrency. Values are string | number | boolean. No nesting,
// no arrays.
//
// `every:` is accepted as a silent alias for `schedule:` for one version
// to ease migration; new jobs should use `schedule:` only.

export type Scalar = string | number | boolean;

export interface Parsed {
  frontmatter: Record<string, Scalar>;
  body: string;
  raw: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(raw: string): Parsed {
  const m = raw.match(FM_RE);
  if (!m) return { frontmatter: {}, body: raw, raw };
  const fm: Record<string, Scalar> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    const hashIdx = val.search(/\s#/);
    if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    let parsed: Scalar;
    if (val === "true") parsed = true;
    else if (val === "false") parsed = false;
    else if (/^-?\d+$/.test(val)) parsed = parseInt(val, 10);
    else parsed = val;
    // Silent migration: `every:` aliases to `schedule:` if schedule wasn't set.
    if (key === "every" && fm.schedule === undefined) {
      fm.schedule = parsed;
    } else {
      fm[key] = parsed;
    }
  }
  return { frontmatter: fm, body: m[2], raw };
}

// Parse the scheduling-relevant keys out of a TS job's `config` block by
// reading the source text. Avoids `await import()` so we don't (a) execute
// the module's side effects in the runner process or (b) get stuck with a
// stale module cache after enable/disable rewrites the file.
export interface TsJobConfigShape {
  schedule?: string | number;
  enabled?: boolean;
  timeout?: number;
  retries?: number;
  concurrency?: "skip" | "queue";
  model?: string;
}

export function parseTsJobConfig(source: string): TsJobConfigShape {
  const block = source.match(/\bconfig\b\s*(?::\s*[^=]+)?=\s*\{([\s\S]*?)\}/);
  if (!block) return {};
  const body = block[1];
  const cfg: TsJobConfigShape = {};
  const pick = (key: string): string | undefined => {
    const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]+)`, "m");
    const m = body.match(re);
    return m
      ? m[1]
          .trim()
          .replace(/[,;]+$/, "")
          .trim()
      : undefined;
  };
  const sched = pick("schedule") ?? pick("every");
  if (sched !== undefined) {
    const unquoted = sched.replace(/^['"]|['"]$/g, "");
    cfg.schedule = /^-?\d+$/.test(unquoted) ? parseInt(unquoted, 10) : unquoted;
  }
  const enabled = pick("enabled");
  if (enabled === "true") cfg.enabled = true;
  else if (enabled === "false") cfg.enabled = false;
  const timeout = pick("timeout");
  if (timeout !== undefined && /^-?\d+$/.test(timeout))
    cfg.timeout = parseInt(timeout, 10);
  const retries = pick("retries");
  if (retries !== undefined && /^\d+$/.test(retries))
    cfg.retries = parseInt(retries, 10);
  const concurrency = pick("concurrency");
  if (concurrency !== undefined) {
    const c = concurrency.replace(/^['"]|['"]$/g, "");
    if (c === "skip" || c === "queue") cfg.concurrency = c;
  }
  const model = pick("model");
  if (model !== undefined) cfg.model = model.replace(/^['"]|['"]$/g, "");
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
