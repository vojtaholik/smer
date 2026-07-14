import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { SmerConfig } from "./types.ts";
import type { Store } from "./store.ts";
import { contentHash, ingestEvent } from "./events.ts";

type JsonRecord = Record<string, unknown>;

export function importChatGPT(
  store: Store,
  config: SmerConfig,
  path: string,
): { conversations: number; inserted: number; duplicates: number; messages: number } {
  if (!existsSync(path)) throw new Error(`Import file not found: ${path}`);
  let raw: string;
  if (extname(path).toLowerCase() === ".zip") {
    const result = Bun.spawnSync(["unzip", "-p", path, "conversations.json"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
      throw new Error(`Could not read conversations.json from export: ${result.stderr.toString().trim()}`);
    }
    raw = result.stdout.toString();
  } else {
    raw = readFileSync(path, "utf8");
  }
  const parsed = JSON.parse(raw);
  const conversations = Array.isArray(parsed) ? parsed as JsonRecord[] : [];
  let inserted = 0;
  let duplicates = 0;
  let messageCount = 0;

  for (const conversation of conversations) {
    const id = String(conversation.id || conversation.conversation_id || "");
    const messages = chatGptMessages(conversation);
    if (!messages.length) continue;
    messageCount += messages.length;
    const title = String(conversation.title || messages.find((message) => message.role === "user")?.text || "ChatGPT conversation");
    const ts = normalizeTimestamp(conversation.update_time || conversation.create_time || Date.now() / 1000);
    const text = messages
      .map((message) => `${message.role}: ${message.text}`)
      .join("\n\n")
      .slice(0, 64 * 1024);
    const payloadHash = contentHash("chatgpt", id || title, text);
    const result = ingestEvent(store, config, {
      ts,
      source: "chatgpt",
      kind: "agent_session",
      project: null,
      title: title.replace(/\s+/g, " ").slice(0, 240),
      text,
      meta: {
        conversation_id: id,
        imported_from: path,
        message_count: messages.length,
        local_import: true,
      },
    }, { contentHash: payloadHash });
    if (result.duplicate) duplicates += 1;
    else inserted += 1;
  }
  return { conversations: conversations.length, inserted, duplicates, messages: messageCount };
}

export function importJsonl(
  store: Store,
  config: SmerConfig,
  path: string,
): { lines: number; inserted: number; duplicates: number; rejected: Array<{ line: number; error: string }> } {
  if (!existsSync(path)) throw new Error(`Import file not found: ${path}`);
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  let inserted = 0;
  let duplicates = 0;
  const rejected: Array<{ line: number; error: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const result = ingestEvent(store, config, JSON.parse(lines[index]));
      if (result.duplicate) duplicates += 1;
      else inserted += 1;
    } catch (error) {
      rejected.push({ line: index + 1, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { lines: lines.length, inserted, duplicates, rejected };
}

function chatGptMessages(conversation: JsonRecord): Array<{ role: string; text: string; ts: number }> {
  const mapping = conversation.mapping;
  if (!mapping || typeof mapping !== "object") return [];
  const output: Array<{ role: string; text: string; ts: number }> = [];
  for (const node of Object.values(mapping as JsonRecord)) {
    if (!node || typeof node !== "object") continue;
    const message = (node as JsonRecord).message;
    if (!message || typeof message !== "object") continue;
    const row = message as JsonRecord;
    const author = (row.author || {}) as JsonRecord;
    const content = (row.content || {}) as JsonRecord;
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts.map((part) => typeof part === "string" ? part : "").filter(Boolean).join("\n").trim();
    if (!text) continue;
    output.push({
      role: String(author.role || "unknown"),
      text,
      ts: normalizeTimestamp(row.create_time || 0),
    });
  }
  return output.sort((a, b) => a.ts - b.ts);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
}
