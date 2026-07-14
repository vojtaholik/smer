import type { Store } from "./store.ts";
import type { SmerConfig, StoredEvent } from "./types.ts";
import { recentEvents, type EventQuery } from "./query.ts";
import { listProviders } from "./providers/index.ts";

const ESC = "\x1b[";
const DEFAULT_PULSE_SECONDS = 5 * 60;

export interface PulseResult {
  notify: boolean;
  since: number;
  until: number;
  eventCount: number;
  notableCount: number;
  healthIssues: string[];
  title: string;
  message: string;
}

export function evaluatePulse(
  store: Store,
  config: SmerConfig,
  now = Math.floor(Date.now() / 1000),
  since?: number,
): PulseResult {
  const windowStart = Math.max(now - 30 * 60, since || now - DEFAULT_PULSE_SECONDS);
  const events = recentEvents(store, { since: windowStart, until: now + 1, limit: 5000 });
  const notable = events.filter(isNotableEvent);
  const healthIssues = pulseHealthIssues(store, config, now);
  const parts: string[] = [];

  if (notable.length) parts.push(summarizeEvents(notable));
  if (healthIssues.length) parts.push(healthIssues.join("; "));

  return {
    notify: parts.length > 0,
    since: windowStart,
    until: now,
    eventCount: events.length,
    notableCount: notable.length,
    healthIssues,
    title: healthIssues.length ? "smer needs attention" : "smer pulse",
    message: parts.join(". ").slice(0, 500),
  };
}

export function runPulse(
  store: Store,
  config: SmerConfig,
  options: { now?: number; notify?: boolean } = {},
): PulseResult {
  const now = options.now || Math.floor(Date.now() / 1000);
  const previous = Number(store.setting("pulse_last_run"));
  const result = evaluatePulse(store, config, now, previous ? previous + 1 : now - DEFAULT_PULSE_SECONDS);
  store.setSetting("pulse_last_run", String(now));
  if (options.notify && result.notify) sendNotification(result.title, result.message);
  return result;
}

export async function runWatch(store: Store, config: SmerConfig, options: EventQuery & { intervalMs?: number } = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("smer watch needs an interactive terminal; use smer timeline --since 5m here");
  }
  const intervalMs = Math.max(250, options.intervalMs || 1000);
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const now = Math.floor(Date.now() / 1000);
    const events = recentEvents(store, { ...options, since: options.since || now - 5 * 60, limit: Math.max(10, height - 6) });
    const providers = listProviders(store, config).filter((provider) => provider.enabled);
    const unhealthy = providers.filter((provider) => !provider.healthy);
    const heartbeat = Number(store.setting("daemon_heartbeat") || 0);
    const daemon = heartbeat && now - heartbeat < 180 ? "daemon ok" : "daemon stale";
    const health = unhealthy.length ? `${unhealthy.length} provider issue${unhealthy.length === 1 ? "" : "s"}` : `${providers.length} providers ok`;
    const lines = [
      `${ESC}2J${ESC}H${ESC}7m smer watch ${ESC}0m  live  ${daemon}  ${health}  q/ctrl-c quit`,
      `${ESC}2m${events.length} events in view  refreshed ${new Date().toLocaleTimeString()}${ESC}0m`,
      `${ESC}2m${"-".repeat(Math.max(1, width))}${ESC}0m`,
    ];
    if (!events.length) lines.push(`${ESC}2mNo recent events. Waiting...${ESC}0m`);
    for (const event of events) lines.push(watchLine(event, width));
    if (unhealthy.length) {
      lines.push(`${ESC}2m${"-".repeat(Math.max(1, width))}${ESC}0m`);
      lines.push(truncate(`issues: ${unhealthy.map((provider) => `${provider.id}: ${provider.error || "unhealthy"}`).join("; ")}`, width));
    }
    process.stdout.write(lines.slice(0, height).join("\n"));
  };

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.off("resize", render);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  };

  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.on("resize", render);
  render();
  timer = setInterval(render, intervalMs);

  await new Promise<void>((resolve) => {
    process.stdin.on("data", function onData(key: string) {
      if (key !== "q" && key !== "\x03") return;
      process.stdin.off("data", onData);
      cleanup();
      resolve();
    });
  });
}

function pulseHealthIssues(store: Store, config: SmerConfig, now: number): string[] {
  const issues: string[] = [];
  const heartbeat = Number(store.setting("daemon_heartbeat") || 0);
  if (!heartbeat || now - heartbeat >= 180) issues.push(heartbeat ? `daemon heartbeat is ${formatAge(now - heartbeat)} old` : "daemon heartbeat is missing");
  const unhealthy = listProviders(store, config).filter((provider) => provider.enabled && !provider.healthy);
  if (unhealthy.length) issues.push(`providers unhealthy: ${unhealthy.map((provider) => provider.id).join(", ")}`);
  return issues;
}

function isNotableEvent(event: StoredEvent): boolean {
  if (event.kind === "browser_visit") return false;
  if (event.source === "workspace" || event.kind === "x-project-discovered") return false;
  if (event.kind === "shell_cmd") return Number(event.meta.exit_code || 0) !== 0;
  return true;
}

function summarizeEvents(events: StoredEvent[]): string {
  const labels = new Map<string, number>();
  for (const event of events) {
    const label = eventLabel(event);
    labels.set(label, (labels.get(label) || 0) + 1);
  }
  const activity = [...labels.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(", ");
  const projects = [...new Set(events.map((event) => event.project).filter((project): project is string => Boolean(project)))].slice(0, 3);
  return `${activity}${projects.length ? ` in ${projects.join(", ")}` : ""}`;
}

function eventLabel(event: StoredEvent): string {
  if (event.kind === "git_commit") return "commit";
  if (event.kind === "agent_session") return "agent session";
  if (event.kind === "deploy") return "deploy";
  if (event.kind === "api_job") return "API job";
  if (event.kind === "x-file-edit") return "file edit";
  if (event.kind === "x-figma-file") return "Figma update";
  if (event.kind === "x-asset-save") return "asset save";
  if (event.kind === "shell_cmd") return "failed command";
  return event.source;
}

function watchLine(event: StoredEvent, width: number): string {
  const time = new Date(event.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const project = (event.project || "-").padEnd(16).slice(0, 16);
  const source = event.source.padEnd(12).slice(0, 12);
  const title = event.kind === "x-asset-save" && typeof event.meta.path === "string"
    ? `Saved asset: ${event.meta.path.split("/").at(-1)}`
    : event.title;
  return truncate(`${ESC}2m${time}${ESC}0m  ${project}  ${source}  #${event.id} ${title}`, width);
}

function sendNotification(title: string, message: string): void {
  const script = `display notification "${appleScriptString(message)}" with title "${appleScriptString(title)}"`;
  Bun.spawnSync(["/usr/bin/osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
}

function appleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function truncate(value: string, width: number): string {
  const visible = value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  if (visible.length <= width) return value;
  return `${visible.slice(0, Math.max(1, width - 3))}...`;
}
