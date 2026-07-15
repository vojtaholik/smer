import type { SmerConfig, StoredEvent } from "./types.ts";
import type { Store } from "./store.ts";
import { hydrateEvent } from "./store.ts";

const SCHEMA_VERSION = 1;
const MAX_EVENTS = 5000;
const MAX_DELTAS = 20;
const MAX_BURSTS = 10;
const MAX_FAILURES = 10;
const MAX_OUTCOMES = 20;
const MAX_MATRIX_ROWS = 50;
const MAX_OPEN_LOOPS = 20;
const DERIVED_KINDS = new Set(["x-observation", "x-open-loop", "x-decision"]);

export interface BriefOptions {
  since: number;
  now?: number;
}

export interface BriefDelta {
  key: string;
  current: number;
  previous: number;
  delta: number;
  status: "first_appearance" | "reawakened" | "silent" | "increased" | "decreased";
  eventIds: number[];
}

export interface BriefReport {
  schemaVersion: number;
  generatedAt: number;
  windows: {
    current: { since: number; until: number };
    previous: { since: number; until: number };
    semantics: "half-open [since, until) in unix seconds";
  };
  totals: { current: number; previous: number; loadedCurrent: number; truncated: boolean };
  deltas: { projects: BriefDelta[]; sources: BriefDelta[] };
  bursts: Array<{
    startedAt: number;
    endedAt: number;
    project: string | null;
    eventCount: number;
    eventIds: number[];
  }>;
  failureSignals: Array<{
    project: string | null;
    source: string;
    title: string;
    count: number;
    lastAt: number;
    eventIds: number[];
  }>;
  outcomes: Array<{
    id: number;
    ts: number;
    project: string | null;
    source: string;
    kind: string;
    title: string;
    text: string;
    textTruncated: boolean;
    eventIds: number[];
  }>;
  projectSourceMatrix: Array<{
    project: string | null;
    source: string;
    count: number;
    eventIds: number[];
  }>;
  openLoopCandidates: Array<{
    project: string | null;
    reason: "git_working_state" | "unresolved_failure" | "latest_activity";
    title: string;
    continuationPrompt: string;
    eventIds: number[];
  }>;
  coverageCaveats: Array<{
    type: "paused" | "heartbeat" | "provider" | "truncated";
    message: string;
    eventIds: number[];
  }>;
}

// @lat: [[roadmap#Distillation Roadmap#Phase 2: The Brief]]
export function buildBrief(store: Store, config: SmerConfig, options: BriefOptions): BriefReport {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isInteger(options.since) || options.since <= 0 || options.since >= now) {
    throw new Error("brief --since must resolve to a time before now");
  }
  const duration = now - options.since;
  const previousStart = Math.max(1, options.since - duration);
  const currentTotal = countEvents(store, options.since, now);
  const previousTotal = countEvents(store, previousStart, options.since);
  const currentEvents = loadEvents(store, options.since, now, MAX_EVENTS);
  const previousEvents = loadEvents(store, previousStart, options.since, MAX_EVENTS);
  const truncated = currentTotal > currentEvents.length;

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now,
    windows: {
      current: { since: options.since, until: now },
      previous: { since: previousStart, until: options.since },
      semantics: "half-open [since, until) in unix seconds",
    },
    totals: { current: currentTotal, previous: previousTotal, loadedCurrent: currentEvents.length, truncated },
    deltas: {
      projects: buildDeltas(store, "project", previousStart, options.since, now, currentEvents, previousEvents),
      sources: buildDeltas(store, "source", previousStart, options.since, now, currentEvents, previousEvents),
    },
    bursts: buildBursts(currentEvents),
    failureSignals: buildFailureSignals(currentEvents),
    outcomes: buildOutcomes(currentEvents),
    projectSourceMatrix: buildMatrix(store, options.since, now),
    openLoopCandidates: buildOpenLoops(currentEvents),
    coverageCaveats: buildCoverageCaveats(store, config, options.since, now, currentEvents, truncated),
  };
}

function countEvents(store: Store, since: number, until: number): number {
  const row = store.db.query(`
    SELECT count(*) AS count FROM events
    WHERE ts >= $since AND ts < $until
      AND kind NOT IN ('x-observation', 'x-open-loop', 'x-decision')
  `).get({ since, until }) as { count: number };
  return Number(row.count);
}

function loadEvents(store: Store, since: number, until: number, limit: number): StoredEvent[] {
  const rows = store.db.query(`
    SELECT * FROM (
      SELECT * FROM events
      WHERE ts >= $since AND ts < $until
        AND kind NOT IN ('x-observation', 'x-open-loop', 'x-decision')
      ORDER BY ts DESC, id DESC
      LIMIT $limit
    ) ORDER BY ts ASC, id ASC
  `).all({ since, until, limit }) as Array<Record<string, unknown>>;
  return rows.map(hydrateEvent);
}

function buildDeltas(
  store: Store,
  dimension: "project" | "source",
  previousStart: number,
  currentStart: number,
  currentEnd: number,
  currentEvents: StoredEvent[],
  previousEvents: StoredEvent[],
): BriefDelta[] {
  const expression = dimension === "project" ? "COALESCE(project, '(unattributed)')" : "source";
  const current = groupedCounts(store, expression, currentStart, currentEnd);
  const previous = groupedCounts(store, expression, previousStart, currentStart);
  const historical = groupedCounts(store, expression, 1, previousStart);
  const keys = new Set([...current.keys(), ...previous.keys()]);
  const events = [...previousEvents, ...currentEvents];

  return [...keys].map((key): BriefDelta | null => {
    const currentCount = current.get(key) || 0;
    const previousCount = previous.get(key) || 0;
    if (currentCount === previousCount) return null;
    const status = currentCount > 0 && previousCount === 0
      ? (historical.get(key) ? "reawakened" : "first_appearance")
      : currentCount === 0
        ? "silent"
        : currentCount > previousCount
          ? "increased"
          : "decreased";
    const matching = events.filter((event) => dimension === "project"
      ? (event.project || "(unattributed)") === key
      : event.source === key);
    const loadedEventIds = representativeIds(matching);
    return {
      key,
      current: currentCount,
      previous: previousCount,
      delta: currentCount - previousCount,
      status,
      eventIds: loadedEventIds.length
        ? loadedEventIds
        : queryEvidenceIds(store, dimension, key, currentCount ? currentStart : previousStart, currentCount ? currentEnd : currentStart),
    };
  }).filter((item): item is BriefDelta => item !== null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key))
    .slice(0, MAX_DELTAS);
}

function groupedCounts(store: Store, expression: string, since: number, until: number): Map<string, number> {
  const rows = store.db.query(`
    SELECT ${expression} AS key, count(*) AS count FROM events
    WHERE ts >= $since AND ts < $until
      AND kind NOT IN ('x-observation', 'x-open-loop', 'x-decision')
    GROUP BY ${expression}
  `).all({ since, until }) as Array<{ key: string; count: number }>;
  return new Map(rows.map((row) => [String(row.key), Number(row.count)]));
}

function buildBursts(events: StoredEvent[]): BriefReport["bursts"] {
  const blocks: Array<{ startedAt: number; endedAt: number; project: string | null; events: StoredEvent[] }> = [];
  for (const event of events) {
    const previous = blocks.at(-1);
    if (!previous || event.ts - previous.endedAt > 15 * 60) {
      blocks.push({ startedAt: event.ts, endedAt: event.ts, project: event.project, events: [event] });
      continue;
    }
    previous.endedAt = event.ts;
    previous.events.push(event);
    if (previous.project !== event.project) previous.project = null;
  }
  return blocks
    .sort((a, b) => b.events.length - a.events.length || b.endedAt - a.endedAt)
    .slice(0, MAX_BURSTS)
    .map((block) => ({
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      project: block.project,
      eventCount: block.events.length,
      eventIds: representativeIds(block.events),
    }));
}

function buildFailureSignals(events: StoredEvent[]): BriefReport["failureSignals"] {
  const groups = new Map<string, StoredEvent[]>();
  for (const event of events.filter(isFailure)) {
    const key = `${event.project || ""}\0${event.source}\0${normalizeFailureTitle(event.title)}`;
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length || b.at(-1)!.ts - a.at(-1)!.ts)
    .slice(0, MAX_FAILURES)
    .map((group) => {
      const latest = group.at(-1)!;
      return {
        project: latest.project,
        source: latest.source,
        title: latest.title,
        count: group.length,
        lastAt: latest.ts,
        eventIds: group.slice(-5).map((event) => event.id),
      };
    });
}

function buildOutcomes(events: StoredEvent[]): BriefReport["outcomes"] {
  return events.filter((event) => ["deploy", "api_job"].includes(event.kind) || isFailure(event))
    .sort((a, b) => b.ts - a.ts || b.id - a.id)
    .slice(0, MAX_OUTCOMES)
    .map((event) => ({
      id: event.id,
      ts: event.ts,
      project: event.project,
      source: event.source,
      kind: event.kind,
      title: event.title,
      text: event.text.slice(0, 500),
      textTruncated: event.text.length > 500,
      eventIds: [event.id],
    }));
}

function buildMatrix(store: Store, since: number, until: number): BriefReport["projectSourceMatrix"] {
  const rows = store.db.query(`
    SELECT project, source, count(*) AS count, max(id) AS event_id
    FROM events
    WHERE ts >= $since AND ts < $until
      AND kind NOT IN ('x-observation', 'x-open-loop', 'x-decision')
    GROUP BY project, source
    ORDER BY count DESC, COALESCE(project, ''), source
    LIMIT $limit
  `).all({ since, until, limit: MAX_MATRIX_ROWS }) as Array<{
    project: string | null;
    source: string;
    count: number;
    event_id: number;
  }>;
  return rows.map((row) => ({
    project: row.project === null ? null : String(row.project),
    source: String(row.source),
    count: Number(row.count),
    eventIds: [Number(row.event_id)],
  }));
}

function buildOpenLoops(events: StoredEvent[]): BriefReport["openLoopCandidates"] {
  const candidates: BriefReport["openLoopCandidates"] = [];
  const latestByProject = new Map<string, StoredEvent>();
  const latestGitState = new Map<string, StoredEvent>();
  for (const event of events) {
    latestByProject.set(event.project || "(unattributed)", event);
    if (event.kind === "x-git-state") latestGitState.set(event.project || "(unattributed)", event);
  }
  for (const event of latestGitState.values()) {
    const dirty = Number(event.meta.dirty_files || 0);
    const ahead = Number(event.meta.ahead || 0);
    const stashes = Number(event.meta.stash_count || 0);
    if (!dirty && !ahead && !stashes) continue;
    candidates.push({
      project: event.project,
      reason: "git_working_state",
      title: event.title,
      continuationPrompt: `Resume ${event.project || "this project"}: inspect event #${event.id} and decide whether to commit, push, or preserve the working state.`,
      eventIds: [event.id],
    });
  }
  for (const event of latestByProject.values()) {
    const failure = isFailure(event);
    candidates.push({
      project: event.project,
      reason: failure ? "unresolved_failure" : "latest_activity",
      title: event.title,
      continuationPrompt: failure
        ? `Resume ${event.project || "this work"}: inspect failure event #${event.id}, verify whether it remains unresolved, and continue from the evidence.`
        : `Resume ${event.project || "this work"}: inspect event #${event.id}, reconstruct the latest state, and choose the next concrete action.`,
      eventIds: [event.id],
    });
  }
  return candidates
    .sort((a, b) => b.eventIds[0] - a.eventIds[0] || (a.project || "").localeCompare(b.project || "") || a.reason.localeCompare(b.reason))
    .slice(0, MAX_OPEN_LOOPS);
}

function buildCoverageCaveats(
  store: Store,
  config: SmerConfig,
  since: number,
  now: number,
  events: StoredEvent[],
  truncated: boolean,
): BriefReport["coverageCaveats"] {
  const caveats: BriefReport["coverageCaveats"] = [];
  const pauseEvents = events.filter((event) => event.source === "smer" && /^Capture (paused|resumed)$/.test(event.title));
  const pausedUntil = Number(store.setting("paused_until") || 0);
  if (pausedUntil > since || pauseEvents.length) {
    caveats.push({
      type: "paused",
      message: pausedUntil > now
        ? `Capture is paused until ${pausedUntil}.`
        : "The current window contains a capture pause or resume marker.",
      eventIds: pauseEvents.map((event) => event.id).slice(-5),
    });
  }
  const heartbeat = Number(store.setting("daemon_heartbeat") || 0);
  if (!heartbeat || now - heartbeat >= 180) {
    caveats.push({
      type: "heartbeat",
      message: heartbeat ? `Daemon heartbeat is ${now - heartbeat}s old.` : "No daemon heartbeat has been recorded.",
      eventIds: [],
    });
  }
  const states = new Map(store.providerStates().map((state) => [state.id, state]));
  for (const id of [...config.enabledProviders].sort()) {
    if (id === "shell") continue;
    const state = states.get(id);
    if (state?.healthy && state.lastRun) continue;
    caveats.push({
      type: "provider",
      message: !state?.lastRun
        ? `Enabled provider ${id} has not completed a run.`
        : `Enabled provider ${id} is unhealthy: ${state.error || "unknown error"}`,
      eventIds: [],
    });
  }
  if (truncated) {
    caveats.push({
      type: "truncated",
      message: `Detailed sections use the newest ${MAX_EVENTS} events; aggregate counts cover the full window.`,
      eventIds: [],
    });
  }
  return caveats;
}

function isFailure(event: StoredEvent): boolean {
  if (typeof event.meta.exit_code === "number") return event.meta.exit_code !== 0;
  const status = String(event.meta.status || event.meta.state || "").toLowerCase();
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) return true;
  return /\b(fail(?:ed|ure)?|error|cancelled|canceled)\b/i.test(event.title);
}

function normalizeFailureTitle(value: string): string {
  return value.toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function representativeIds(events: StoredEvent[]): number[] {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.ts - b.ts || a.id - b.id);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  return [...new Set([sorted[0].id, middle.id, sorted.at(-1)!.id])];
}

function queryEvidenceIds(
  store: Store,
  dimension: "project" | "source",
  key: string,
  since: number,
  until: number,
): number[] {
  const condition = dimension === "project"
    ? key === "(unattributed)" ? "project IS NULL" : "project = $key"
    : "source = $key";
  const params = dimension === "project" && key === "(unattributed)" ? { since, until } : { since, until, key };
  const rows = store.db.query(`
    SELECT id FROM events
    WHERE ts >= $since AND ts < $until
      AND ${condition}
      AND kind NOT IN ('x-observation', 'x-open-loop', 'x-decision')
    ORDER BY ts DESC, id DESC
    LIMIT 3
  `).all(params) as Array<{ id: number }>;
  return rows.map((row) => Number(row.id)).reverse();
}

export function briefLimits(): Record<string, number> {
  return {
    events: MAX_EVENTS,
    deltas: MAX_DELTAS,
    bursts: MAX_BURSTS,
    failures: MAX_FAILURES,
    outcomes: MAX_OUTCOMES,
    matrixRows: MAX_MATRIX_ROWS,
    openLoops: MAX_OPEN_LOOPS,
  };
}
