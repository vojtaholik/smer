import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  openSync,
  closeSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SmerConfig, EventEnvelope } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";

export interface ProviderRunResult {
  provider: string;
  scanned: number;
  inserted: number;
  duplicates: number;
  cursor?: string | null;
  warnings: string[];
}

type AgentProvider = "claude-code" | "codex" | "cursor";

export function importZshHistory(
  store: Store,
  config: SmerConfig,
  path = join(homedir(), ".zsh_history"),
  since = Math.floor(Date.now() / 1000) - 30 * 86400,
): ProviderRunResult {
  const result = emptyResult("shell");
  if (!existsSync(path)) {
    result.warnings.push(`History not found: ${path}`);
    return result;
  }
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const extended = line.match(/^: (\d+):\d+;(.*)$/);
    const ts = extended ? Number(extended[1]) : Math.floor(Date.now() / 1000);
    const command = (extended ? extended[2] : line).trim();
    if (ts < since || !command) continue;
    result.scanned += 1;
    const inserted = ingestEvent(
      store,
      config,
      {
        ts,
        source: "shell",
        kind: "shell_cmd",
        project: null,
        title: command.slice(0, 240),
        text: command,
        meta: { imported: true, history_path: path },
      },
      { contentHash: contentHash("shell-history", `${ts}:${command}`) },
    );
    countResult(result, inserted.duplicate);
  }
  return result;
}

export function scanGit(store: Store, config: SmerConfig, since?: number): ProviderRunResult {
  const result = emptyResult("git");
  const state = store.providerState("git");
  const lowerBound = since || Number(state?.cursor || Math.floor(Date.now() / 1000) - 30 * 86400);
  let maxTs = lowerBound;
  for (const project of store.projects()) {
    if (!existsSync(join(project.path, ".git"))) continue;
    const proc = Bun.spawnSync(
      ["git", "-C", project.path, "reflog", `--since=@${lowerBound}`, "--format=%ct%x1f%H%x1f%gs"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      result.warnings.push(`${project.name}: ${proc.stderr.toString().trim()}`);
      continue;
    }
    for (const line of proc.stdout.toString().split("\n")) {
      if (!line) continue;
      const [rawTs, sha, subject] = line.split("\x1f");
      const ts = Number(rawTs);
      if (!ts || !sha) continue;
      result.scanned += 1;
      maxTs = Math.max(maxTs, ts);
      const event = ingestEvent(
        store,
        config,
        {
          ts,
          source: "git",
          kind: "git_commit",
          project: project.name,
          title: subject || sha.slice(0, 10),
          text: `${subject || "git activity"}\n${sha}`,
          meta: { cwd: project.path, repo: project.repo, sha },
        },
        { contentHash: contentHash("git", `${project.path}:${ts}:${sha}:${subject}`) },
      );
      countResult(result, event.duplicate);
    }
  }
  result.cursor = String(maxTs);
  return result;
}

export function scanClaude(
  store: Store,
  config: SmerConfig,
  since = Math.floor(Date.now() / 1000) - 30 * 86400,
): ProviderRunResult {
  const roots = [join(homedir(), ".claude", "projects")];
  return scanAgentLogs(store, config, "claude-code", roots, (path) => extname(path) === ".jsonl", since);
}

export function scanCodex(
  store: Store,
  config: SmerConfig,
  since = Math.floor(Date.now() / 1000) - 30 * 86400,
): ProviderRunResult {
  const root = join(homedir(), ".codex");
  const roots = [join(root, "sessions"), join(root, "archived_sessions")];
  return scanAgentLogs(store, config, "codex", roots, (path) => basename(path).startsWith("rollout-") && extname(path) === ".jsonl", since);
}

export function scanCursor(
  store: Store,
  config: SmerConfig,
  since = Number(store.providerState("cursor")?.cursor || Math.floor(Date.now() / 1000) - 30 * 86400),
  roots = [join(homedir(), ".cursor", "projects")],
  historyRoots = [join(homedir(), "Library", "Application Support", "Cursor", "User", "History")],
): ProviderRunResult {
  const transcripts = scanAgentLogs(
    store,
    config,
    "cursor",
    roots,
    isCursorTranscript,
    since,
  );
  const edits = scanCursorHistory(store, config, since, historyRoots);
  return {
    provider: "cursor",
    scanned: transcripts.scanned + edits.scanned,
    inserted: transcripts.inserted + edits.inserted,
    duplicates: transcripts.duplicates + edits.duplicates,
    cursor: edits.cursor || undefined,
    warnings: [...transcripts.warnings, ...edits.warnings],
  };
}

export function scanCursorHistory(
  store: Store,
  config: SmerConfig,
  since: number,
  roots = [join(homedir(), "Library", "Application Support", "Cursor", "User", "History")],
): ProviderRunResult {
  const result = emptyResult("cursor");
  let maxTs = since;
  const projects = store.projects();
  for (const root of roots) {
    for (const indexPath of recursiveFiles(root, 2)) {
      if (basename(indexPath) !== "entries.json") continue;
      try {
        const stats = statSync(indexPath);
        if (stats.size > 1024 * 1024) {
          result.warnings.push(`${indexPath}: skipped local-history index over 1MB`);
          continue;
        }
        const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
        if (typeof parsed.resource !== "string" || !Array.isArray(parsed.entries)) continue;
        const url = new URL(parsed.resource);
        if (url.protocol !== "file:") continue;
        const filePath = fileURLToPath(url);
        const project = projects.find((item) => filePath === item.path || filePath.startsWith(`${item.path}${sep}`));
        if (!project) continue;
        const projectRelativePath = relative(project.path, filePath);
        if (!projectRelativePath || projectRelativePath.startsWith(`..${sep}`) || projectRelativePath === "..") continue;
        const parts = projectRelativePath.split(sep);
        if (parts.some((part) => config.excludedRoots.includes(part))) continue;

        for (const rawEntry of parsed.entries.slice(-5000)) {
          if (!rawEntry || typeof rawEntry !== "object") continue;
          const entry = rawEntry as Record<string, unknown>;
          const id = typeof entry.id === "string" ? entry.id : "";
          const rawTimestamp = Number(entry.timestamp);
          const ts = rawTimestamp > 10_000_000_000 ? Math.floor(rawTimestamp / 1000) : Math.floor(rawTimestamp);
          if (!id || !Number.isFinite(ts) || ts < since || ts > Math.floor(Date.now() / 1000) + 86400) continue;
          result.scanned += 1;
          maxTs = Math.max(maxTs, ts);
          const event = ingestEvent(store, config, {
            ts,
            source: "cursor",
            kind: "x-file-edit",
            project: project.name,
            title: `Edited ${projectRelativePath}`,
            text: `Cursor saved ${projectRelativePath}`,
            meta: {
              cwd: dirname(filePath),
              path: filePath,
              relative_path: projectRelativePath,
              extension: extname(filePath),
              editor: "cursor",
              history_entry_id: id,
              content_captured: false,
            },
          }, { contentHash: contentHash("cursor-file-edit", `${parsed.resource}:${id}`) });
          countResult(result, event.duplicate);
        }
      } catch (error) {
        result.warnings.push(`${indexPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  result.cursor = maxTs > since ? String(maxTs) : null;
  return result;
}

export function isCursorTranscript(path: string): boolean {
  return path.includes(`${sep}agent-transcripts${sep}`) && [".jsonl", ".txt"].includes(extname(path));
}

export function scanAgentLogs(
  store: Store,
  config: SmerConfig,
  provider: AgentProvider,
  roots: string[],
  matches: (path: string) => boolean,
  since: number,
): ProviderRunResult {
  const result = emptyResult(provider);
  const now = Date.now();
  for (const root of roots) {
    for (const path of recursiveFiles(root, 8)) {
      if (!matches(path)) continue;
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.mtimeMs / 1000 < since) continue;
      result.scanned += 1;
      if (now - stats.mtimeMs < 10 * 60_000) continue;
      const signatureKey = `log_signature:${provider}:${createHash("sha1").update(path).digest("hex")}`;
      const signature = `${provider === "cursor" ? "cursor-context-v2:" : ""}${stats.size}:${Math.floor(stats.mtimeMs)}`;
      if (store.setting(signatureKey) === signature) continue;
      const lines = readCappedLines(path, 16 * 1024 * 1024);
      const parsed = summarizeAgentLog(lines, provider, path, Math.floor(stats.mtimeMs / 1000));
      if (!parsed) continue;
      if (provider === "cursor" && !parsed.meta.cwd) {
        parsed.meta.cwd = inferCursorProjectPath(path, store);
      }
      if (provider === "cursor") {
        parsed.meta.transcript_created_at = Math.floor(stats.birthtimeMs / 1000);
        parsed.meta.transcript_modified_at = Math.floor(stats.mtimeMs / 1000);
      }
      const event = ingestEvent(store, config, parsed, {
        contentHash: contentHash(provider, parsed.meta.session_id as string),
        upsert: true,
      });
      countResult(result, event.duplicate);
      store.setSetting(signatureKey, signature);
      if (stats.size > 16 * 1024 * 1024) result.warnings.push(`${path}: read with a 16MB cap (${stats.size} bytes)`);
    }
  }
  return result;
}

function summarizeAgentLog(
  lines: string[],
  provider: AgentProvider,
  path: string,
  fallbackTs: number,
): EventEnvelope | null {
  if (provider === "cursor" && extname(path) === ".jsonl") {
    const cursorEvent = summarizeCursorJsonl(lines, path, fallbackTs);
    if (cursorEvent) return cursorEvent;
  }
  const userText: string[] = [];
  const assistantText: string[] = [];
  const commands: string[] = [];
  const plainText: string[] = [];
  const files = new Set<string>();
  let cwd: string | null = null;
  let ts = fallbackTs;
  let sessionId = basename(path, extname(path)).replace(/^rollout-/, "");

  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      if (line.trim()) plainText.push(line);
      continue;
    }
    const timestamp = row.timestamp || row.ts || row.created_at;
    if (typeof timestamp === "string" || typeof timestamp === "number") {
      const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp) / 1000;
      if (Number.isFinite(parsed)) ts = Math.max(ts, Math.floor(parsed));
    }
    if (typeof row.cwd === "string") cwd = row.cwd;
    if (typeof row.session_id === "string") sessionId = row.session_id;
    if (typeof row.sessionId === "string") sessionId = row.sessionId;

    const type = String(row.type || "");
    const payload = row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : row.message && typeof row.message === "object"
        ? row.message as Record<string, unknown>
        : {};
    const role = String(payload.role || row.role || (type.includes("user") ? "user" : type.includes("assistant") ? "assistant" : ""));
    const text = extractText(
      payload.content ?? row.content ?? payload.text ?? row.text ?? (typeof row.message === "string" ? row.message : undefined),
    );
    if (text) {
      if (role === "user") userText.push(text);
      else if (role === "assistant") assistantText.push(text);
    }

    const name = String(payload.name || row.name || "");
    const args = payload.arguments ?? row.arguments ?? payload.input ?? row.input;
    if (/exec|shell|command/i.test(name) && args) commands.push(extractCommand(args));
    for (const candidate of JSON.stringify(args || "").match(/(?:\/[^\s"']+|[\w.-]+\.(?:ts|tsx|js|jsx|css|md|json|py|rs|go))/g) || []) {
      files.add(candidate);
    }
    if (!cwd) cwd = findString(row, ["cwd", "working_directory"]);
  }

  const plainDigest = !userText.length && !assistantText.length && !commands.length
    ? plainText.join("\n").trim()
    : "";
  const plainTitle = plainText.find((line) => line.trim() && !/^\s*(user|assistant|system)\s*:?\s*$/i.test(line))?.trim();
  const firstPrompt = userText.find((text) => text.trim())?.trim() || plainTitle;
  if (!firstPrompt && !assistantText.length && !commands.length && !plainDigest) return null;
  const digest = [
    firstPrompt ? `Prompt: ${firstPrompt}` : "",
    ...assistantText.slice(-8),
    commands.length ? `Commands:\n${commands.slice(-20).join("\n")}` : "",
    plainDigest,
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 64 * 1024);

  return {
    ts,
    source: provider,
    kind: "agent_session",
    project: null,
    title: (firstPrompt || `${provider} session`).replace(/\s+/g, " ").slice(0, 240),
    text: digest,
    meta: {
      session_id: sessionId,
      cwd,
      files: [...files].slice(0, 200),
      jsonl_path: path,
      summarized: true,
    },
  };
}

function summarizeCursorJsonl(lines: string[], path: string, fallbackTs: number): EventEnvelope | null {
  const userTurns: string[] = [];
  const assistantTurns: string[] = [];
  const changedFiles = new Set<string>();
  const consultedFiles = new Set<string>();
  const commands: string[] = [];
  const errors: string[] = [];
  const statuses = new Set<string>();
  const toolCounts = new Map<string, number>();
  let ts = fallbackTs;
  let recognizedRows = 0;

  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const timestamp = row.timestamp || row.ts || row.created_at;
    if (typeof timestamp === "string" || typeof timestamp === "number") {
      const parsed = typeof timestamp === "number" ? timestamp : Date.parse(timestamp) / 1000;
      if (Number.isFinite(parsed)) ts = Math.max(ts, Math.floor(parsed));
    }

    const role = typeof row.role === "string" ? row.role : "";
    const message = row.message;
    const content = message && typeof message === "object"
      ? (message as Record<string, unknown>).content
      : message;
    const text = extractText(content).trim();
    if (role === "user" || role === "assistant") {
      recognizedRows += 1;
      if (text) (role === "user" ? userTurns : assistantTurns).push(text);
    }

    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") continue;
        const tool = item as Record<string, unknown>;
        const name = typeof tool.name === "string" ? tool.name : "";
        if (!name) continue;
        const input = tool.input && typeof tool.input === "object" ? tool.input as Record<string, unknown> : {};
        toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
        const target = /^(write|strreplace|delete)$/i.test(name) ? changedFiles : consultedFiles;
        collectCursorPaths(input, target);
        if (/^(shell|terminal|command)$/i.test(name) && typeof input.command === "string") {
          commands.push(input.command);
        }
      }
    }

    if (!role && (row.status !== undefined || row.error !== undefined)) {
      recognizedRows += 1;
      if (typeof row.status === "string") {
        statuses.add([typeof row.type === "string" ? row.type : "status", row.status].join(":"));
      }
      const error = cursorDiagnostic(row.error);
      if (error) errors.push(error);
    }
  }

  const firstPrompt = userTurns.find(Boolean)?.trim();
  const outcome = assistantTurns.at(-1)?.trim();
  if (!recognizedRows || (!firstPrompt && !outcome && !commands.length && !errors.length)) return null;
  for (const path of changedFiles) consultedFiles.delete(path);

  const toolSummary = [...toolCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name} ${count}`);
  const sections = [
    cursorSection("Requests", userTurns.map((turn, index) => `${index + 1}. ${turn}`)),
    cursorSection("Outcome", outcome ? [outcome] : []),
    cursorSection("Changed files", [...changedFiles].sort()),
    cursorSection("Commands", commands),
    cursorSection("Failures", errors),
    cursorSection("Status", [...statuses].sort()),
    cursorSection("Tools", toolSummary),
    cursorSection("Consulted files", [...consultedFiles].sort()),
  ].filter(Boolean);
  const rawText = sections.join("\n\n");

  return {
    ts,
    source: "cursor",
    kind: "agent_session",
    project: null,
    title: (firstPrompt || outcome || "cursor session").replace(/\s+/g, " ").slice(0, 240),
    text: truncateUtf8(rawText, 64 * 1024),
    meta: {
      session_id: basename(path, extname(path)),
      cwd: null,
      files: [...new Set([...changedFiles, ...consultedFiles])].slice(0, 200),
      changed_files: [...changedFiles].slice(0, 100),
      consulted_files: [...consultedFiles].slice(0, 100),
      tool_counts: Object.fromEntries([...toolCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      user_turns: userTurns.length,
      assistant_turns: assistantTurns.length,
      status_rows: statuses.size,
      error_rows: errors.length,
      jsonl_path: path,
      transcript_format: "cursor-agent-jsonl",
      summarized: true,
      truncated: Buffer.byteLength(rawText) > 64 * 1024,
    },
  };
}

function collectCursorPaths(input: Record<string, unknown>, output: Set<string>): void {
  for (const key of ["path", "paths", "target_directory"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) output.add(value);
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) output.add(item);
    }
  }
}

function cursorDiagnostic(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    if (typeof row[key] === "string") return String(row[key]).trim();
  }
  return JSON.stringify(value).slice(0, 4096);
}

function cursorSection(title: string, values: string[]): string {
  const content = values.filter((value) => value.trim()).join("\n");
  return content ? `${title}:\n${content}` : "";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const suffix = "\n<truncated>";
  const bytes = Buffer.from(value).subarray(0, maxBytes - Buffer.byteLength(suffix));
  return `${bytes.toString("utf8").replace(/\uFFFD$/, "")}${suffix}`;
}

function inferCursorProjectPath(path: string, store: Store): string | null {
  const parts = path.split(sep);
  const transcriptsIndex = parts.lastIndexOf("agent-transcripts");
  const slug = transcriptsIndex > 0 ? parts[transcriptsIndex - 1] : "";
  return store.projects()
    .map((project) => project.path)
    .find((projectPath) => projectPath.replace(/^\/+/, "").replaceAll("/", "-") === slug) || null;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const row = item as Record<string, unknown>;
          if (typeof row.text === "string") return row.text;
          if (row.type === "input_text" && typeof row.content === "string") return row.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractCommand(value: unknown): string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return extractCommand(parsed);
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return String(row.cmd || row.command || row.input || "");
  }
  return "";
}

function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  for (const key of keys) if (typeof row[key] === "string") return row[key] as string;
  for (const nested of Object.values(row)) {
    const found = findString(nested, keys);
    if (found) return found;
  }
  return null;
}

export function scanBrowsers(
  store: Store,
  config: SmerConfig,
  historyPaths = browserHistoryPaths(),
): ProviderRunResult {
  const result = emptyResult("browser");
  const state = store.providerState("browser");
  let cursors: Record<string, { time: number; id: number }> = {};
  try {
    const parsed = JSON.parse(state?.cursor || "{}") as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      cursors = Object.fromEntries(Object.entries(parsed).map(([path, value]) => {
        if (typeof value === "number") return [path, { time: value, id: 0 }];
        const row = value as Record<string, unknown>;
        return [path, { time: Number(row?.time || 0), id: Number(row?.id || 0) }];
      }));
    }
  } catch {
    cursors = {};
  }
  for (const path of historyPaths) {
    if (!existsSync(path)) continue;
    let cursor = cursors[path] || { time: 0, id: 0 };
    const cachePath = join(store.home, "cache", `browser-${createHash("sha1").update(path).digest("hex")}.db`);
    try {
      copyFileSync(path, cachePath);
      const db = new Database(cachePath, { readonly: true, strict: true });
      const rows = db
        .query(`
          SELECT id, url, title, last_visit_time
          FROM urls
          WHERE last_visit_time > ? OR (last_visit_time = ? AND id > ?)
          ORDER BY last_visit_time, id
          LIMIT 5000
        `)
        .all(cursor.time, cursor.time, cursor.id) as Array<{ id: number; url: string; title: string; last_visit_time: number }>;
      db.close();
      for (const row of rows) {
        result.scanned += 1;
        cursor = { time: Number(row.last_visit_time), id: Number(row.id) };
        let hostname = "";
        try {
          hostname = new URL(row.url).hostname.replace(/^www\./, "");
        } catch {
          continue;
        }
        if (config.browserDenylist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) continue;
        const unixMicros = Number(row.last_visit_time) - 11_644_473_600_000_000;
        const ts = Math.floor(unixMicros / 1_000_000);
        const event = ingestEvent(store, config, {
          ts: Math.max(1, ts),
          source: "browser",
          kind: "browser_visit",
          project: null,
          title: row.title || hostname,
          text: `${row.title || ""}\n${row.url}`,
          meta: { url: row.url, domain: hostname, history_path: path },
        });
        countResult(result, event.duplicate);
      }
      cursors[path] = cursor;
    } catch (error) {
      result.warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  result.cursor = JSON.stringify(cursors);
  return result;
}

export function codexPermissionWarnings(): string[] {
  const warnings: string[] = [];
  for (const root of [join(homedir(), ".codex", "sessions"), join(homedir(), ".codex", "archived_sessions")]) {
    for (const path of recursiveFiles(root, 8)) {
      if (!basename(path).startsWith("rollout-") || extname(path) !== ".jsonl") continue;
      try {
        const mode = statSync(path).mode & 0o777;
        if ((mode & 0o077) !== 0) warnings.push(`${path} has permissions ${mode.toString(8)}; recommended 600`);
      } catch {
        // Ignore files that disappear during inspection.
      }
    }
  }
  return warnings.slice(0, 20);
}

function browserHistoryPaths(): string[] {
  const roots = [
    join(homedir(), "Library", "Application Support", "Google", "Chrome"),
    join(homedir(), "Library", "Application Support", "Arc", "User Data"),
    join(homedir(), "Library", "Application Support", "Chromium"),
  ];
  const paths: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const profile of ["Default", ...safeDirectories(root).filter((name) => name.startsWith("Profile "))]) {
      const history = join(root, profile, "History");
      if (existsSync(history)) paths.push(history);
    }
  }
  return paths;
}

function recursiveFiles(root: string, maxDepth: number, depth = 0): string[] {
  if (!existsSync(root) || depth > maxDepth) return [];
  const output: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...recursiveFiles(path, maxDepth, depth + 1));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function safeDirectories(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readCappedLines(path: string, cap: number): string[] {
  const size = statSync(path).size;
  if (size <= cap) return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
  const half = Math.floor(cap / 2);
  const start = Buffer.alloc(half);
  const end = Buffer.alloc(half);
  const fd = openSync(path, "r");
  try {
    readSync(fd, start, 0, half, 0);
    readSync(fd, end, 0, half, size - half);
  } finally {
    closeSync(fd);
  }
  const first = start.toString("utf8").split(/\r?\n/);
  const last = end.toString("utf8").split(/\r?\n/);
  last.shift();
  return [...first, ...last].filter(Boolean);
}

function emptyResult(provider: string): ProviderRunResult {
  return { provider, scanned: 0, inserted: 0, duplicates: 0, warnings: [] };
}

function countResult(result: ProviderRunResult, duplicate: boolean): void {
  if (duplicate) result.duplicates += 1;
  else result.inserted += 1;
}
