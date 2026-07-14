import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SmerConfig, EventEnvelope } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";
import { keychainToken } from "./cloud.ts";
import type { ProviderRunResult } from "./local.ts";

type JsonRecord = Record<string, unknown>;

export interface CustomProvider {
  id: string;
  adapter: "api-poll" | "log-tail" | "executable";
  endpoint?: string;
  command?: string | string[];
  path?: string;
  interval: number;
  cursor?: string;
  auth?: { keychain?: string; header?: string; scheme?: string };
  map: Record<string, string>;
  configPath: string;
}

export function loadCustomProviders(home: string): CustomProvider[] {
  const root = join(home, "providers");
  if (!existsSync(root)) return [];
  const providers: CustomProvider[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = entry.isDirectory() ? join(root, entry.name, "provider.toml") : join(root, entry.name);
    if (!existsSync(path) || basename(path) !== "provider.toml") continue;
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as JsonRecord;
    const container = (parsed.provider || {}) as JsonRecord;
    const id = Object.keys(container)[0];
    if (!id) throw new Error(`${path}: expected [provider.<id>]`);
    const raw = container[id] as JsonRecord;
    const adapter = String(raw.adapter || "") as CustomProvider["adapter"];
    if (!["api-poll", "log-tail", "executable"].includes(adapter)) {
      throw new Error(`${path}: unsupported adapter ${adapter}`);
    }
    providers.push({
      id,
      adapter,
      endpoint: raw.endpoint ? String(raw.endpoint) : undefined,
      command: Array.isArray(raw.command) ? raw.command.map(String) : raw.command ? String(raw.command) : undefined,
      path: raw.path ? String(raw.path) : undefined,
      interval: parseInterval(raw.interval),
      cursor: raw.cursor ? String(raw.cursor) : undefined,
      auth: raw.auth && typeof raw.auth === "object" ? raw.auth as CustomProvider["auth"] : undefined,
      map: raw.map && typeof raw.map === "object" ? raw.map as Record<string, string> : {},
      configPath: path,
    });
  }
  return providers;
}

export async function runCustomProvider(
  provider: CustomProvider,
  store: Store,
  config: SmerConfig,
): Promise<ProviderRunResult> {
  if (provider.adapter === "api-poll") return runApi(provider, store, config);
  if (provider.adapter === "log-tail") return runLogTail(provider, store, config);
  return runExecutable(provider, store, config);
}

async function runApi(provider: CustomProvider, store: Store, config: SmerConfig): Promise<ProviderRunResult> {
  if (!provider.endpoint) throw new Error(`${provider.id}: endpoint is required`);
  const state = store.providerState(provider.id);
  const url = new URL(provider.endpoint);
  if (provider.cursor && state?.cursor) url.searchParams.set(provider.cursor, state.cursor);
  const headers: Record<string, string> = {};
  if (provider.auth?.keychain) {
    const token = keychainToken(provider.auth.keychain);
    if (!token) throw new Error(`${provider.id}: Keychain service ${provider.auth.keychain} is missing`);
    headers[provider.auth.header || "Authorization"] = `${provider.auth.scheme || "Bearer"} ${token}`.trim();
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${provider.id}: ${response.status} ${response.statusText}`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : [];
  return mapRows(provider, rows, store, config);
}

function runLogTail(provider: CustomProvider, store: Store, config: SmerConfig): ProviderRunResult {
  if (!provider.path) throw new Error(`${provider.id}: path is required`);
  const path = expandHome(provider.path);
  if (!existsSync(path)) throw new Error(`${provider.id}: ${path} does not exist`);
  const state = store.providerState(provider.id);
  const offset = Number(state?.cursor || 0);
  const size = statSync(path).size;
  const start = size < offset ? 0 : offset;
  const buffer = readFileSync(path);
  const tail = buffer.subarray(start).toString("utf8");
  const lastNewline = tail.lastIndexOf("\n");
  const text = lastNewline >= 0 ? tail.slice(0, lastNewline + 1) : "";
  const rows: unknown[] = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written final line is picked up on the next pass.
    }
  }
  const result = mapRows(provider, rows, store, config);
  result.cursor = String(start + Buffer.byteLength(text));
  return result;
}

async function runExecutable(provider: CustomProvider, store: Store, config: SmerConfig): Promise<ProviderRunResult> {
  if (!provider.command) throw new Error(`${provider.id}: command is required`);
  const command = Array.isArray(provider.command) ? provider.command : ["zsh", "-lc", provider.command];
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SMER_HOME: store.home, SMEM_HOME: store.home },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${provider.id}: executable exited ${exitCode}: ${stderr.slice(0, 500)}`);
  const rows = stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (provider.map && Object.keys(provider.map).length) return mapRows(provider, rows, store, config);
  const result = empty(provider.id);
  for (const row of rows) {
    result.scanned += 1;
    const event = ingestEvent(store, config, row);
    count(result, event.duplicate);
  }
  return result;
}

function mapRows(
  provider: CustomProvider,
  rows: unknown[],
  store: Store,
  config: SmerConfig,
): ProviderRunResult {
  const result = empty(provider.id);
  let cursor: string | null = store.providerState(provider.id)?.cursor || null;
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as JsonRecord;
    result.scanned += 1;
    const mapped: JsonRecord = {};
    for (const [key, template] of Object.entries(provider.map)) mapped[key] = renderTemplate(String(template), row);
    const stableId = String(row.id || mapped.id || JSON.stringify(row));
    const event: EventEnvelope = {
      ts: parseTimestamp(mapped.ts || row.ts || row.created_at),
      source: provider.id,
      kind: String(mapped.kind || "note") as EventEnvelope["kind"],
      project: mapped.project ? String(mapped.project) : null,
      title: String(mapped.title || `${provider.id} event`),
      text: String(mapped.text || JSON.stringify(row)),
      meta: { provider_id: provider.id, stable_id: stableId },
    };
    const inserted = ingestEvent(store, config, event, { contentHash: contentHash(provider.id, stableId) });
    count(result, inserted.duplicate);
    if (provider.cursor && row[provider.cursor] !== undefined) cursor = String(row[provider.cursor]);
  }
  result.cursor = cursor;
  return result;
}

function renderTemplate(template: string, row: JsonRecord): string {
  return template.replace(/\{([\w.]+)\}/g, (_, path: string) => {
    let value: unknown = row;
    for (const part of path.split(".")) value = value && typeof value === "object" ? (value as JsonRecord)[part] : undefined;
    return value === undefined || value === null ? "" : String(value);
  });
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  if (typeof value === "string") {
    const number = Number(value);
    if (Number.isFinite(number)) return parseTimestamp(number);
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.floor(date / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function parseInterval(value: unknown): number {
  if (typeof value === "number") return Math.max(60, value);
  const match = String(value || "10m").match(/^(\d+)(s|m|h)$/);
  if (!match) return 600;
  const multiplier = { s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"];
  return Math.max(60, Number(match[1]) * multiplier);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(process.env.HOME || "", path.slice(2)) : path;
}

function empty(provider: string): ProviderRunResult {
  return { provider, scanned: 0, inserted: 0, duplicates: 0, warnings: [] };
}

function count(result: ProviderRunResult, duplicate: boolean): void {
  if (duplicate) result.duplicates += 1;
  else result.inserted += 1;
}
