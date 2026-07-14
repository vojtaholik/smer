import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureLayout } from "./config.ts";
import type { EventEnvelope, ProjectRecord, ProviderStatus, StoredEvent } from "./types.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS events(
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  project      TEXT,
  title        TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL DEFAULT '',
  meta         TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project, ts);
CREATE INDEX IF NOT EXISTS idx_events_source_ts ON events(source, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_content_hash
  ON events(content_hash) WHERE content_hash IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title,
  text,
  content='events',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, text)
  VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, text)
  VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO events_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
END;

CREATE TABLE IF NOT EXISTS projects(
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  repo          TEXT,
  domains       TEXT NOT NULL DEFAULT '[]',
  keywords      TEXT NOT NULL DEFAULT '[]',
  discovered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);

CREATE TABLE IF NOT EXISTS redaction_keys(
  name       TEXT PRIMARY KEY,
  project    TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_state(
  id         TEXT PRIMARY KEY,
  adapter    TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  healthy    INTEGER NOT NULL DEFAULT 1,
  last_run   INTEGER,
  cursor     TEXT,
  error      TEXT,
  failures   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class Store {
  readonly db: Database;
  readonly home: string;

  constructor(home: string, readonly = false) {
    this.home = home;
    ensureLayout(home);
    this.db = new Database(databasePath(home), { create: !readonly, readonly, strict: true });
    if (!readonly) this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insertEvent(event: EventEnvelope, contentHash?: string): number | null {
    try {
      const result = this.db
        .query(`
          INSERT INTO events(ts, source, kind, project, title, text, meta, content_hash)
          VALUES ($ts, $source, $kind, $project, $title, $text, $meta, $hash)
        `)
        .run({
          ts: event.ts,
          source: event.source,
          kind: event.kind,
          project: event.project,
          title: event.title,
          text: event.text,
          meta: JSON.stringify(event.meta),
          hash: contentHash || null,
        });
      return Number(result.lastInsertRowid);
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: events.content_hash")) return null;
      throw error;
    }
  }

  insertEvents(items: Array<{ event: EventEnvelope; hash?: string }>): number {
    const insert = this.db.transaction((rows: Array<{ event: EventEnvelope; hash?: string }>) => {
      let inserted = 0;
      for (const row of rows) {
        if (this.insertEvent(row.event, row.hash) !== null) inserted += 1;
      }
      return inserted;
    });
    return insert(items);
  }

  upsertEvent(event: EventEnvelope, contentHash: string): { id: number; created: boolean } {
    const existing = this.db.query("SELECT id FROM events WHERE content_hash = ?").get(contentHash) as { id: number } | null;
    if (!existing) {
      const id = this.insertEvent(event, contentHash);
      if (id === null) throw new Error("Could not insert event");
      return { id, created: true };
    }
    this.db
      .query(`
        UPDATE events SET
          ts = $ts,
          source = $source,
          kind = $kind,
          project = $project,
          title = $title,
          text = $text,
          meta = $meta
        WHERE id = $id
      `)
      .run({
        ts: event.ts,
        source: event.source,
        kind: event.kind,
        project: event.project,
        title: event.title,
        text: event.text,
        meta: JSON.stringify(event.meta),
        id: existing.id,
      });
    return { id: Number(existing.id), created: false };
  }

  isDuplicate(event: EventEnvelope, fingerprint: string, windowSeconds: number): boolean {
    const row = this.db
      .query(`
        SELECT 1 AS found
        FROM events
        WHERE source = $source
          AND ts BETWEEN $start AND $end
          AND json_extract(meta, '$._fingerprint') = $fingerprint
        LIMIT 1
      `)
      .get({
        source: event.source,
        start: event.ts - windowSeconds,
        end: event.ts + windowSeconds,
        fingerprint,
      }) as { found: number } | null;
    return Boolean(row);
  }

  getEvent(id: number): StoredEvent | null {
    const row = this.db.query("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown> | null;
    return row ? hydrateEvent(row) : null;
  }

  upsertProject(project: ProjectRecord): void {
    this.db
      .query(`
        INSERT INTO projects(name, path, repo, domains, keywords, discovered_at)
        VALUES ($name, $path, $repo, $domains, $keywords, $discoveredAt)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          repo = COALESCE(excluded.repo, projects.repo),
          domains = excluded.domains,
          keywords = excluded.keywords
      `)
      .run({
        name: project.name,
        path: project.path,
        repo: project.repo || null,
        domains: JSON.stringify(project.domains),
        keywords: JSON.stringify(project.keywords),
        discoveredAt: project.discoveredAt || Math.floor(Date.now() / 1000),
      });
  }

  projects(): ProjectRecord[] {
    const rows = this.db.query("SELECT * FROM projects ORDER BY length(path) DESC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      path: String(row.path),
      repo: row.repo ? String(row.repo) : null,
      domains: parseStringArray(row.domains),
      keywords: parseStringArray(row.keywords),
      discoveredAt: Number(row.discovered_at),
    }));
  }

  addRedactionKey(name: string, project?: string): void {
    this.db
      .query(`
        INSERT INTO redaction_keys(name, project, created_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET project = COALESCE(excluded.project, redaction_keys.project)
      `)
      .run(name.toUpperCase(), project || null, Math.floor(Date.now() / 1000));
  }

  redactionKeys(): string[] {
    return (this.db.query("SELECT name FROM redaction_keys ORDER BY name").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  }

  setting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .query("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  setProviderState(status: ProviderStatus, failures = 0): void {
    this.db
      .query(`
        INSERT INTO provider_state(id, adapter, enabled, healthy, last_run, cursor, error, failures, updated_at)
        VALUES ($id, $adapter, $enabled, $healthy, $lastRun, $cursor, $error, $failures, $now)
        ON CONFLICT(id) DO UPDATE SET
          adapter=excluded.adapter,
          enabled=excluded.enabled,
          healthy=excluded.healthy,
          last_run=excluded.last_run,
          cursor=excluded.cursor,
          error=excluded.error,
          failures=excluded.failures,
          updated_at=excluded.updated_at
      `)
      .run({
        id: status.id,
        adapter: status.adapter,
        enabled: status.enabled ? 1 : 0,
        healthy: status.healthy ? 1 : 0,
        lastRun: status.lastRun,
        cursor: status.cursor,
        error: status.error,
        failures,
        now: Math.floor(Date.now() / 1000),
      });
  }

  providerState(id: string): (ProviderStatus & { failures: number }) | null {
    const row = this.db.query("SELECT * FROM provider_state WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id),
      adapter: String(row.adapter),
      enabled: Boolean(row.enabled),
      healthy: Boolean(row.healthy),
      lastRun: row.last_run === null ? null : Number(row.last_run),
      cursor: row.cursor === null ? null : String(row.cursor),
      error: row.error === null ? null : String(row.error),
      failures: Number(row.failures),
    };
  }

  providerStates(): Array<ProviderStatus & { failures: number }> {
    return (this.db.query("SELECT * FROM provider_state ORDER BY id").all() as Array<Record<string, unknown>>).map(
      (row) => ({
        id: String(row.id),
        adapter: String(row.adapter),
        enabled: Boolean(row.enabled),
        healthy: Boolean(row.healthy),
        lastRun: row.last_run === null ? null : Number(row.last_run),
        cursor: row.cursor === null ? null : String(row.cursor),
        error: row.error === null ? null : String(row.error),
        failures: Number(row.failures),
      }),
    );
  }
}

function databasePath(home: string): string {
  const current = join(home, "smer.db");
  const legacy = join(home, "smem.db");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function hydrateEvent(row: Record<string, unknown>): StoredEvent {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(String(row.meta || "{}"));
  } catch {
    meta = {};
  }
  delete meta._fingerprint;
  return {
    id: Number(row.id),
    ts: Number(row.ts),
    source: String(row.source),
    kind: String(row.kind) as StoredEvent["kind"],
    project: row.project === null ? null : String(row.project),
    title: String(row.title || ""),
    text: String(row.text || ""),
    meta,
  };
}
