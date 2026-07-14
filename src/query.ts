import type { Store } from "./store.ts";
import { hydrateEvent } from "./store.ts";
import type { StoredEvent } from "./types.ts";

export interface EventQuery {
  project?: string;
  source?: string;
  kind?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface SearchResult extends StoredEvent {
  snippet: string;
  rank: number;
}

export interface TimelineBlock {
  startedAt: number;
  endedAt: number;
  project: string | null;
  events: StoredEvent[];
}

export function searchEvents(store: Store, term: string, options: EventQuery = {}): SearchResult[] {
  const filters: string[] = [];
  const params: Record<string, string | number> = {
    query: term,
    limit: clampLimit(options.limit, 25),
    now: Math.floor(Date.now() / 1000),
  };
  if (options.project) {
    filters.push("e.project = $project");
    params.project = options.project;
  }
  if (options.source) {
    filters.push("e.source = $source");
    params.source = options.source;
  }
  if (options.kind) {
    filters.push("e.kind = $kind");
    params.kind = options.kind;
  }
  if (options.since) {
    filters.push("e.ts >= $since");
    params.since = options.since;
  }
  if (options.until) {
    filters.push("e.ts < $until");
    params.until = options.until;
  }
  const where = filters.length ? `AND ${filters.join(" AND ")}` : "";
  const rows = store.db
    .query(`
      SELECT e.*,
        snippet(events_fts, 1, '[', ']', ' ... ', 24) AS snippet,
        bm25(events_fts, 5.0, 1.0) / exp(MIN(($now - e.ts) / 86400.0, 365.0) / 30.0) AS weighted_rank
      FROM events_fts
      JOIN events e ON e.id = events_fts.rowid
      WHERE events_fts MATCH $query ${where}
      ORDER BY weighted_rank ASC, e.ts DESC
      LIMIT $limit
    `)
    .all(params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    ...hydrateEvent(row),
    snippet: String(row.snippet || row.text || ""),
    rank: Number(row.weighted_rank || 0),
  }));
}

export function recentEvents(store: Store, options: EventQuery = {}): StoredEvent[] {
  const filters: string[] = [];
  const params: Record<string, string | number> = { limit: clampLimit(options.limit, 100) };
  if (options.project) {
    filters.push("project = $project");
    params.project = options.project;
  }
  if (options.source) {
    filters.push("source = $source");
    params.source = options.source;
  }
  if (options.kind) {
    filters.push("kind = $kind");
    params.kind = options.kind;
  }
  if (options.since) {
    filters.push("ts >= $since");
    params.since = options.since;
  }
  if (options.until) {
    filters.push("ts < $until");
    params.until = options.until;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const rows = store.db
    .query(`SELECT * FROM events ${where} ORDER BY ts DESC, id DESC LIMIT $limit`)
    .all(params) as Array<Record<string, unknown>>;
  return rows.map(hydrateEvent);
}

export function timeline(store: Store, options: EventQuery = {}): TimelineBlock[] {
  const events = recentEvents(store, { ...options, limit: options.limit || 500 }).reverse();
  const blocks: TimelineBlock[] = [];
  for (const event of events) {
    const previous = blocks.at(-1);
    if (!previous || event.ts - previous.endedAt > 15 * 60) {
      blocks.push({
        startedAt: event.ts,
        endedAt: event.ts,
        project: event.project,
        events: [event],
      });
    } else {
      previous.endedAt = event.ts;
      previous.events.push(event);
      if (previous.project !== event.project) previous.project = null;
    }
  }
  return blocks;
}

export function stats(store: Store, options: EventQuery = {}): {
  total: number;
  since: number | null;
  bySource: Array<{ source: string; count: number }>;
  byKind: Array<{ kind: string; count: number }>;
  byProject: Array<{ project: string | null; count: number; activeSeconds: number }>;
  note: string;
} {
  const since = options.since || null;
  const filters: string[] = [];
  const params: Record<string, string | number> = {};
  if (since) {
    filters.push("ts >= $since");
    params.since = since;
  }
  if (options.source) {
    filters.push("source = $source");
    params.source = options.source;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const total = store.db.query(`SELECT count(*) AS count FROM events ${where}`).get(params) as { count: number };
  const bySource = store.db
    .query(`SELECT source, count(*) AS count FROM events ${where} GROUP BY source ORDER BY count DESC`)
    .all(params) as Array<{ source: string; count: number }>;
  const byKind = store.db
    .query(`SELECT kind, count(*) AS count FROM events ${where} GROUP BY kind ORDER BY count DESC`)
    .all(params) as Array<{ kind: string; count: number }>;
  const rows = store.db
    .query(`SELECT project, ts FROM events ${where} ORDER BY project, ts`)
    .all(params) as Array<{ project: string | null; ts: number }>;

  const projects = new Map<string, { count: number; activeSeconds: number; previous: number | null }>();
  for (const row of rows) {
    const key = row.project || "(unattributed)";
    const value = projects.get(key) || { count: 0, activeSeconds: 0, previous: null };
    value.count += 1;
    if (value.previous !== null) {
      const gap = row.ts - value.previous;
      if (gap <= 15 * 60) value.activeSeconds += Math.max(60, gap);
    }
    value.previous = row.ts;
    projects.set(key, value);
  }
  const byProject = [...projects.entries()]
    .map(([project, value]) => ({
      project: project === "(unattributed)" ? null : project,
      count: value.count,
      activeSeconds: value.activeSeconds,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total: Number(total.count),
    since,
    bySource,
    byKind,
    byProject,
    note: "Active spans are estimates from event density; smer does not capture app focus.",
  };
}

export function parseSince(value: string | undefined, now = new Date()): number | undefined {
  if (!value) return undefined;
  if (value === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }
  const match = value.match(/^(\d+)(m|h|d|w)$/);
  if (match) {
    const amount = Number(match[1]);
    const seconds = { m: 60, h: 3600, d: 86400, w: 604800 }[match[2] as "m" | "h" | "d" | "w"];
    return Math.floor(now.getTime() / 1000) - amount * seconds;
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return Math.floor(date.getTime() / 1000);
  throw new Error(`Invalid date or duration: ${value}`);
}

export function dayRange(value: string): { since: number; until: number } {
  const start = new Date(`${value}T00:00:00`);
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid day: ${value}`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: Math.floor(start.getTime() / 1000), until: Math.floor(end.getTime() / 1000) };
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value || fallback, 5000));
}
