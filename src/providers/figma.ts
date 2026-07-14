import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SmerConfig } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";
import type { ProviderRunResult } from "./local.ts";

type JsonRecord = Record<string, unknown>;

interface FigmaDocument {
  fileKey: string;
  path: string;
  title: string;
  editorType: string;
  editedAt: number;
  createdAt: number | null;
  lastViewedAt: number | null;
  nodeId: string | null;
  isDiscarded: boolean;
  hasThumbnail: boolean;
}

// @lat: [[architecture#System Architecture#Provider System]]
export function scanFigma(
  store: Store,
  config: SmerConfig,
  settingsPath = figmaSettingsPath(),
  since = Math.floor(Date.now() / 1000) - 30 * 86400,
): ProviderRunResult {
  const result = emptyResult();
  if (!existsSync(settingsPath)) return result;

  let root: JsonRecord;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("root is not an object");
    root = parsed;
  } catch (error) {
    result.warnings.push(`Could not read Figma desktop state: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  if (!Array.isArray(root.windows)) {
    result.warnings.push("Figma desktop state has no windows array; its private schema may have changed");
    return result;
  }

  const cursor = parseCursor(store.providerState("figma")?.cursor, result);
  const nextCursor = { ...cursor };
  const documents = latestDocuments(root.windows);
  const now = Math.floor(Date.now() / 1000);

  for (const document of documents.values()) {
    const editedAtSeconds = Math.floor(document.editedAt / 1000);
    nextCursor[document.fileKey] = Math.max(nextCursor[document.fileKey] || 0, document.editedAt);
    if (editedAtSeconds < since || document.editedAt <= (cursor[document.fileKey] || 0)) continue;
    if (editedAtSeconds > now + 86400) {
      result.warnings.push(`${document.title}: edit timestamp is more than 24 hours in the future`);
      continue;
    }

    result.scanned += 1;
    const url = figmaUrl(document.path, document.nodeId);
    const editor = document.editorType === "whiteboard" ? "FigJam" : "Figma";
    const inserted = ingestEvent(
      store,
      config,
      {
        ts: editedAtSeconds,
        source: "figma",
        kind: "x-figma-file",
        project: null,
        title: `Edited in ${editor}: ${document.title}`.slice(0, 240),
        text: `${document.title}\n${editor} document activity\n${url}`,
        meta: {
          url,
          file_key: document.fileKey,
          figma_path: document.path,
          node_id: document.nodeId,
          editor_type: document.editorType,
          created_at: toUnixSeconds(document.createdAt),
          edited_at: editedAtSeconds,
          last_viewed_at: toUnixSeconds(document.lastViewedAt),
          is_discarded: document.isDiscarded,
          has_thumbnail: document.hasThumbnail,
          desktop_settings_path: settingsPath,
          activity_basis: "desktop-edited-at",
        },
      },
      { contentHash: contentHash("figma", `${document.fileKey}:${document.editedAt}`) },
    );
    if (inserted.duplicate) result.duplicates += 1;
    else result.inserted += 1;
  }

  result.cursor = JSON.stringify(nextCursor);
  return result;
}

export function figmaSettingsPath(): string {
  return join(homedir(), "Library", "Application Support", "Figma", "settings.json");
}

function latestDocuments(windows: unknown[]): Map<string, FigmaDocument> {
  const documents = new Map<string, FigmaDocument>();
  for (const window of windows) {
    if (!isRecord(window) || !Array.isArray(window.tabs)) continue;
    for (const tab of window.tabs) {
      const document = parseDocument(tab);
      if (!document) continue;
      const previous = documents.get(document.fileKey);
      if (!previous || document.editedAt > previous.editedAt) documents.set(document.fileKey, document);
    }
  }
  return documents;
}

function parseDocument(value: unknown): FigmaDocument | null {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.title !== "string") return null;
  const match = value.path.match(/^\/(?:file|design|board|proto)\/([^/?#]+)/);
  const editedAt = timestampMillis(value.editedAt);
  if (!match || !editedAt) return null;
  const params = typeof value.params === "string" ? new URLSearchParams(value.params.replace(/^\?/, "")) : null;
  return {
    fileKey: match[1],
    path: value.path,
    title: value.title.trim() || "Untitled",
    editorType: typeof value.editorType === "string" ? value.editorType : "design",
    editedAt,
    createdAt: timestampMillis(value.createdAt),
    lastViewedAt: timestampMillis(value.lastViewedAt),
    nodeId: params?.get("node-id") || null,
    isDiscarded: value.isDiscarded === true,
    hasThumbnail: isRecord(value.thumbnail) && typeof value.thumbnail.url === "string",
  };
}

function parseCursor(raw: string | null | undefined, result: ProviderRunResult): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("cursor is not an object");
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
        .map(([key, value]) => [key, Number(value)]),
    );
  } catch {
    result.warnings.push("Malformed Figma cursor; performing a bounded 30-day backfill");
    return {};
  }
}

function figmaUrl(path: string, nodeId: string | null): string {
  const url = new URL(path, "https://www.figma.com");
  if (nodeId) url.searchParams.set("node-id", nodeId);
  return url.toString();
}

function timestampMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return timestampMillis(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function toUnixSeconds(value: number | null): number | null {
  return value === null ? null : Math.floor(value / 1000);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emptyResult(): ProviderRunResult {
  return { provider: "figma", scanned: 0, inserted: 0, duplicates: 0, warnings: [] };
}
