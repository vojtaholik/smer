import { createHash } from "node:crypto";
import { URL } from "node:url";
import type { SmerConfig, EventEnvelope, EventKind, ProjectRecord } from "./types.ts";
import { EVENT_KINDS } from "./types.ts";
import type { Store } from "./store.ts";

const ALLOWED_FIELDS = new Set(["ts", "source", "kind", "project", "title", "text", "meta"]);
const MAX_TEXT_BYTES = 64 * 1024;

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventValidationError";
  }
}

export function validateEvent(input: unknown, strict = true): EventEnvelope {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EventValidationError("Event must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  if (strict) {
    const unknown = Object.keys(raw).filter((key) => !ALLOWED_FIELDS.has(key));
    if (unknown.length) throw new EventValidationError(`Unknown event fields: ${unknown.join(", ")}`);
  }

  const ts = Number(raw.ts);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(ts) || ts <= 0) throw new EventValidationError("ts must be positive unix seconds");
  if (ts > now + 86_400) throw new EventValidationError("ts is more than 24 hours in the future");

  const source = String(raw.source || "");
  if (!/^[a-z0-9][a-z0-9/_-]{0,63}$/i.test(source)) {
    throw new EventValidationError("source must be a provider id");
  }

  const kind = String(raw.kind || "") as EventKind;
  if (!(EVENT_KINDS as readonly string[]).includes(kind) && !/^x-[a-z0-9][a-z0-9_-]{0,62}$/i.test(kind)) {
    throw new EventValidationError(`Unsupported kind: ${kind || "(empty)"}`);
  }

  const project = raw.project === null || raw.project === undefined || raw.project === "" ? null : String(raw.project);
  if (project && (project.length > 100 || !/^[\w.-]+$/u.test(project))) {
    throw new EventValidationError("project must be 100 characters or fewer and contain letters, numbers, ., _, or -");
  }

  const title = raw.title === undefined || raw.title === null ? "" : String(raw.title);
  const text = raw.text === undefined || raw.text === null ? "" : String(raw.text);
  if (Buffer.byteLength(title) > 4096) throw new EventValidationError("title exceeds 4KB");
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new EventValidationError("text exceeds 64KB");

  const meta = raw.meta === undefined ? {} : raw.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new EventValidationError("meta must be a JSON object");
  }
  if (Buffer.byteLength(JSON.stringify(meta)) > MAX_TEXT_BYTES) throw new EventValidationError("meta exceeds 64KB");

  return { ts, source, kind, project, title, text, meta: meta as Record<string, unknown> };
}

export function redactEvent(event: EventEnvelope, keys: string[], config: SmerConfig): EventEnvelope {
  return {
    ...event,
    title: redactText(event.title, keys, config.emailAllowlist),
    text: redactText(event.text, keys, config.emailAllowlist),
    meta: redactMeta(event.meta, keys, config.emailAllowlist) as Record<string, unknown>,
  };
}

export function redactText(input: string, keys: string[] = [], emailAllowlist: string[] = []): string {
  let output = input;
  const replacements: Array<[RegExp, string]> = [
    [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "<redacted:api-key>"],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "<redacted:github-token>"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted:github-token>"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "<redacted:aws-key>"],
    [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted:jwt>"],
    [/\b(?:\d[ -]*?){13,19}\b/g, (match) => (passesLuhn(match) ? "<redacted:card>" : match) as never],
  ];
  for (const [pattern, replacement] of replacements) output = output.replace(pattern, replacement as string);

  output = output.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
    return emailAllowlist.some((allowed) => email.toLowerCase().endsWith(allowed.toLowerCase()))
      ? email
      : "<redacted:email>";
  });

  for (const key of keys) {
    const escaped = escapeRegExp(key);
    output = output.replace(
      new RegExp(`(\\b${escaped}\\b\\s*(?:=|:)\\s*)([^\\s'\"]+|'[^']*'|\"[^\"]*\")`, "gi"),
      `$1<redacted:${key.toLowerCase()}>`,
    );
  }

  output = output.replace(/\b[A-Za-z0-9+/_=-]{32,}\b/g, (token) => {
    if (/^[0-9a-f]{32,64}$/i.test(token)) return token;
    return shannonEntropy(token) >= 4.2 ? "<redacted:high-entropy>" : token;
  });
  return output;
}

const STRUCTURAL_META_FIELDS = new Set([
  "cwd",
  "repo",
  "jsonl_path",
  "history_path",
  "path",
  "relative_path",
  "files",
  "changed_files",
  "consulted_files",
]);

function redactMeta(value: unknown, keys: string[], allowlist: string[], field?: string): unknown {
  if (field && STRUCTURAL_META_FIELDS.has(field) && typeof value === "string") return value;
  if (typeof value === "string") return redactText(value, keys, allowlist);
  if (Array.isArray(value)) return value.map((item) => redactMeta(item, keys, allowlist, field));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactMeta(item, keys, allowlist, key)]),
    );
  }
  return value;
}

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alternate = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveProject(event: EventEnvelope, projects: ProjectRecord[]): string | null {
  if (event.project) return event.project;
  const cwd = typeof event.meta.cwd === "string" ? event.meta.cwd : null;
  const repo = typeof event.meta.repo === "string" ? event.meta.repo : null;
  const url = typeof event.meta.url === "string" ? event.meta.url : extractUrl(event.text);

  if (cwd) {
    const match = projects.find((project) => cwd === project.path || cwd.startsWith(`${project.path}/`));
    if (match) return match.name;
  }
  if (repo) {
    const normalized = normalizeRepo(repo);
    const match = projects.find((project) => project.repo && normalizeRepo(project.repo) === normalized);
    if (match) return match.name;
  }
  if (url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      const match = projects.find((project) => project.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)));
      if (match) return match.name;
    } catch {
      // Ignore malformed URLs and continue with keyword matching.
    }
  }

  const haystack = `${event.title} ${event.text} ${cwd || ""}`.toLowerCase();
  return projects.find((project) => project.keywords.some((keyword) => containsKeyword(haystack, keyword)))?.name || null;
}

function containsKeyword(haystack: string, keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalized)}([^a-z0-9]|$)`, "i").test(haystack);
}

function normalizeRepo(value: string): string {
  return value.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "").toLowerCase();
}

function extractUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s)\]}]+/)?.[0] || null;
}

export function fingerprint(event: EventEnvelope): string {
  const stable = event.kind === "browser_visit"
    ? String(event.meta.url || event.text)
    : `${event.kind}\0${event.title}\0${event.text}\0${String(event.meta.cwd || "")}`;
  return createHash("sha256").update(stable).digest("hex");
}

export function dedupeWindow(event: EventEnvelope): number {
  if (event.kind === "shell_cmd") return 2;
  if (event.kind === "browser_visit") return 60;
  if (["deploy", "api_job", "git_commit"].includes(event.kind)) return 300;
  return 0;
}

export function contentHash(provider: string, stableId: string, payload = ""): string {
  return createHash("sha256").update(`${provider}\0${stableId}\0${payload}`).digest("hex");
}

export function ingestEvent(
  store: Store,
  config: SmerConfig,
  input: unknown,
  options: { strict?: boolean; contentHash?: string; dryRun?: boolean; upsert?: boolean } = {},
): { event: EventEnvelope; id: number | null; duplicate: boolean } {
  let event = validateEvent(input, options.strict ?? true);
  event = redactEvent(event, store.redactionKeys(), config);
  event.project = resolveProject(event, store.projects());
  const hash = fingerprint(event);
  const window = dedupeWindow(event);
  const duplicate = window > 0 && store.isDuplicate(event, hash, window);
  event.meta = { ...event.meta, _fingerprint: hash };
  if (options.dryRun || duplicate) return { event, id: null, duplicate };
  if (options.contentHash && options.upsert) {
    const upserted = store.upsertEvent(event, options.contentHash);
    return { event, id: upserted.id, duplicate: !upserted.created };
  }
  const id = store.insertEvent(event, options.contentHash);
  return { event, id, duplicate: id === null };
}
