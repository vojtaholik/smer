#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultHome, loadConfig, saveConfig } from "./config.ts";
import { Store } from "./store.ts";
import type { CommandEnvelope, EventEnvelope, RuntimeContext } from "./types.ts";
import { ingestEvent, redactText } from "./events.ts";
import { dayRange, parseSince, recentEvents, searchEvents, stats, timeline } from "./query.ts";
import { drainSpool, spoolEvent } from "./spool.ts";
import { doctor } from "./doctor.ts";
import { runDaemon } from "./daemon.ts";
import { runTui } from "./tui.ts";
import {
  setup,
  digestAutomationStatus,
  installAgentFiles,
  installDigestAutomation,
  removeDigestAutomation,
  installPulseAutomation,
  removePulseAutomation,
  pulseAutomationStatus,
  shellHookSnippet,
} from "./setup.ts";
import { runPulse, runWatch } from "./monitor.ts";
import { importChatGPT, importJsonl } from "./importers.ts";
import { importZshHistory, scanBrowsers, scanClaude, scanCodex, scanCursor, scanGit } from "./providers/local.ts";
import { scanFigma } from "./providers/figma.ts";
import { scanAssets } from "./providers/assets.ts";
import { scanWorkspaces } from "./providers/workspace.ts";
import { BUILTIN_ADAPTERS, listProviders, runProvider } from "./providers/index.ts";
import { loadCustomProviders } from "./providers/custom.ts";
import { storeKeychainToken } from "./providers/cloud.ts";
import { buildBrief } from "./brief.ts";

const VERSION = "0.1.0";
const BOOLEAN_FLAGS = new Set([
  "json",
  "quiet",
  "dry-run",
  "spool",
  "segment",
  "install-shell",
  "no-launchd",
  "no-backfill",
  "token-stdin",
  "notify",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx: RuntimeContext = {
    home: resolve(String(args.flags.home || defaultHome())),
    json: Boolean(args.flags.json),
    quiet: Boolean(args.flags.quiet),
  };
  const command = args.positionals.shift();

  if (!command) {
    if (!process.stdin.isTTY) {
      console.log(HELP);
      return;
    }
    const store = new Store(ctx.home);
    try {
      await runTui(store);
    } finally {
      store.close();
    }
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
    return;
  }
  if (["version", "--version", "-v"].includes(command)) {
    console.log(`smer ${VERSION}`);
    return;
  }

  let store: Store | null = null;
  try {
    store = new Store(ctx.home);
    const config = loadConfig(ctx.home);
    switch (command) {
      case "setup": {
        const roots = stringFlag(args, "dev-root")?.split(",").map((path) => resolve(path.trim())).filter(Boolean);
        const result = await setup(store, {
          devRoots: roots,
          installShell: boolFlag(args, "install-shell"),
          launchd: !boolFlag(args, "no-launchd"),
          backfill: !boolFlag(args, "no-backfill"),
        });
        respond(ctx, "setup", result, () => printSetup(result), [
          result.shellHook.installed ? "Run smer doctor" : `Add this line to ~/.zshrc: ${result.shellHook.line}`,
          "Run smer timeline",
        ]);
        break;
      }
      case "emit": {
        const source = requiredFlag(args, "source");
        const kind = requiredFlag(args, "kind");
        const title = stringFlag(args, "title") || args.positionals.join(" ");
        const text = stringFlag(args, "text") || args.positionals.join(" ") || title;
        const meta = parseMeta(stringFlag(args, "meta"));
        if (stringFlag(args, "cwd")) meta.cwd = resolve(stringFlag(args, "cwd")!);
        if (stringFlag(args, "url")) meta.url = stringFlag(args, "url");
        if (stringFlag(args, "repo")) meta.repo = stringFlag(args, "repo");
        if (stringFlag(args, "exit-code") !== undefined) meta.exit_code = Number(stringFlag(args, "exit-code"));
        if (stringFlag(args, "duration-ms") !== undefined) meta.duration_ms = Number(stringFlag(args, "duration-ms"));
        const event = {
          ts: stringFlag(args, "ts") ? Number(stringFlag(args, "ts")) : Math.floor(Date.now() / 1000),
          source,
          kind,
          project: stringFlag(args, "project") || null,
          title,
          text,
          meta,
        };
        const dryRun = boolFlag(args, "dry-run");
        if (boolFlag(args, "spool")) {
          const prepared = ingestEvent(store, config, event, { dryRun: true });
          const path = prepared.duplicate ? null : spoolEvent(store.home, prepared.event);
          respond(ctx, "emit", { event: publicEvent(prepared.event), spooled: path, duplicate: prepared.duplicate, dryRun }, () => {
            console.log(prepared.duplicate ? "duplicate skipped" : `spooled ${path}`);
          });
        } else {
          const result = ingestEvent(store, config, event, { dryRun });
          respond(ctx, "emit", { ...result, event: publicEvent(result.event), dryRun }, () => {
            console.log(dryRun ? JSON.stringify(publicEvent(result.event), null, 2) : result.duplicate ? "duplicate skipped" : `event #${result.id} inserted`);
          });
        }
        break;
      }
      case "ingest": {
        const result = drainSpool(store, config);
        respond(ctx, "ingest", result, () => {
          console.log(`${result.inserted} inserted, ${result.duplicates} duplicates, ${result.rejected.length} rejected from ${result.files} files`);
        });
        break;
      }
      case "search": {
        const term = args.positionals.join(" ").trim();
        if (!term) throw new Error("Usage: smer search \"fts5 query\"");
        const result = searchEvents(store, term, queryOptions(args));
        respond(ctx, "search", result, () => printEvents(result), result.length ? [] : ["Try a broader FTS5 query or a longer --since range"]);
        break;
      }
      case "timeline": {
        const options = queryOptions(args);
        const day = stringFlag(args, "day");
        if (day) Object.assign(options, dayRange(day));
        const result = timeline(store, options);
        respond(ctx, "timeline", result, () => printTimeline(result));
        break;
      }
      case "stats": {
        const result = stats(store, queryOptions(args));
        respond(ctx, "stats", result, () => printStats(result));
        break;
      }
      case "brief": {
        const now = Math.floor(Date.now() / 1000);
        const result = buildBrief(store, config, {
          since: parseSince(stringFlag(args, "since") || "7d", new Date(now * 1000))!,
          now,
        });
        respond(ctx, "brief", result, () => printBrief(result), ["Inspect evidence with smer show EVENT_ID"]);
        break;
      }
      case "show": {
        const id = Number(args.positionals[0]);
        if (!Number.isInteger(id)) throw new Error("Usage: smer show EVENT_ID");
        const event = store.getEvent(id);
        if (!event) throw new Error(`Event ${id} not found`);
        respond(ctx, "show", event, () => printEventDetail(event));
        break;
      }
      case "watch": {
        if (ctx.json) throw new Error("smer watch does not support --json; use smer timeline --json for a snapshot");
        await runWatch(store, config, {
          ...queryOptions(args),
          since: parseSince(stringFlag(args, "since") || "5m"),
          intervalMs: stringFlag(args, "interval") ? parseWatchInterval(stringFlag(args, "interval")!) : undefined,
        });
        break;
      }
      case "pause": {
        const duration = args.positionals[0] || "1h";
        const until = Math.floor(Date.now() / 1000) + parseDuration(duration);
        ingestEvent(store, config, gapEvent("Capture paused", { duration, until }));
        store.setSetting("paused_until", String(until));
        respond(ctx, "pause", { pausedUntil: until, duration }, () => console.log(`capture paused until ${new Date(until * 1000).toLocaleString()}`), ["Run smer resume to end the pause early"]);
        break;
      }
      case "resume": {
        store.setSetting("paused_until", "0");
        const event = ingestEvent(store, config, gapEvent("Capture resumed", {}));
        respond(ctx, "resume", { resumed: true, eventId: event.id }, () => console.log("capture resumed"));
        break;
      }
      case "providers": {
        await providerCommand(store, config, ctx, args);
        break;
      }
      case "workspace": {
        const action = args.positionals.shift() || "scan";
        if (action !== "scan") throw new Error("Usage: smer workspace scan [ROOT]");
        const roots = args.positionals.length ? args.positionals.map(resolve) : config.devRoots;
        const result = await scanWorkspaces(store, config, roots);
        respond(ctx, "workspace scan", result, () => printWorkspace(result));
        break;
      }
      case "projects": {
        const action = args.positionals.shift() || "list";
        if (action === "list") {
          const result = store.projects();
          respond(ctx, "projects", result, () => {
            for (const project of result) console.log(`${project.name.padEnd(20)} ${project.path}\n  domains: ${project.domains.join(", ") || "-"}\n  keywords: ${project.keywords.join(", ") || "-"}`);
          });
          break;
        }
        if (action !== "map") throw new Error("Usage: smer projects [list|map NAME --path PATH --domain DOMAIN --keyword WORD]");
        const name = args.positionals.shift();
        if (!name) throw new Error("Project name is required");
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new Error("Project name may contain only letters, numbers, ., _, and -");
        const current = store.projects().find((project) => project.name === name);
        const path = stringFlag(args, "path") ? resolve(stringFlag(args, "path")!) : current?.path;
        if (!path) throw new Error("--path is required for a new project");
        const project = {
          name,
          path,
          repo: stringFlag(args, "repo") || current?.repo || null,
          domains: [...new Set([...(current?.domains || []), ...listFlag(args, "domain")])],
          keywords: [...new Set([...(current?.keywords || [name]), ...listFlag(args, "keyword")])],
          discoveredAt: current?.discoveredAt,
        };
        store.upsertProject(project);
        respond(ctx, "projects map", project, () => console.log(`${name} mapping updated`));
        break;
      }
      case "backfill": {
        const provider = args.positionals.shift() || "all";
        const since = parseSince(stringFlag(args, "since") || "30d");
        const results = [];
        if (["all", "workspace"].includes(provider)) results.push(await scanWorkspaces(store, config));
        if (["all", "shell"].includes(provider)) results.push(importZshHistory(store, config, stringFlag(args, "path"), since));
        if (["all", "git"].includes(provider)) results.push(scanGit(store, config, since));
        if (["all", "claude-code"].includes(provider)) results.push(scanClaude(store, config));
        if (["all", "codex"].includes(provider)) results.push(scanCodex(store, config));
        if (["all", "cursor"].includes(provider)) results.push(scanCursor(store, config, since));
        if (["all", "figma"].includes(provider)) results.push(scanFigma(store, config, undefined, since));
        if (["all", "assets"].includes(provider)) results.push(scanAssets(store, config, since));
        if (["all", "browser"].includes(provider)) results.push(scanBrowsers(store, config));
        if (!results.length) throw new Error(`Unknown backfill provider: ${provider}`);
        respond(ctx, "backfill", results, () => console.log(JSON.stringify(results, null, 2)), ["Run smer timeline"]);
        break;
      }
      case "import": {
        const type = args.positionals.shift();
        const path = args.positionals.shift();
        if (!type || !path) throw new Error("Usage: smer import chatgpt EXPORT.zip | smer import jsonl EVENTS.jsonl");
        const result = type === "chatgpt"
          ? importChatGPT(store, config, resolve(path))
          : type === "jsonl"
            ? importJsonl(store, config, resolve(path))
            : (() => { throw new Error(`Unknown import type: ${type}`); })();
        respond(ctx, `import ${type}`, result, () => console.log(JSON.stringify(result, null, 2)), ["Run smer timeline"]);
        break;
      }
      case "doctor": {
        const result = doctor(store, config);
        respond(ctx, "doctor", result, () => printDoctor(result));
        if (!result.healthy) process.exitCode = 1;
        break;
      }
      case "automation": {
        const target = args.positionals.shift();
        const action = args.positionals.shift() || "status";
        if (target === "pulse") {
          if (action === "enable") {
            const result = installPulseAutomation(store.home, stringFlag(args, "every") || "5m");
            respond(ctx, "automation pulse enable", result, () => console.log(`conditional pulse scheduled every ${result.every}`));
          } else if (action === "disable") {
            const result = removePulseAutomation();
            respond(ctx, "automation pulse disable", result, () => console.log(result.removed ? "pulse automation removed" : "pulse automation was not installed"));
          } else if (action === "status") {
            const result = pulseAutomationStatus();
            respond(ctx, "automation pulse status", result, () => console.log(result.installed ? `pulse installed at ${result.path}` : "pulse automation is not installed"));
          } else throw new Error("Usage: smer automation pulse [enable --every 5m|disable|status]");
          break;
        }
        if (target !== "digest") throw new Error("Usage: smer automation [digest|pulse] [enable|disable|status]");
        if (action === "enable") {
          const result = installDigestAutomation(store.home, stringFlag(args, "at") || "18:00", stringFlag(args, "agent-path"));
          respond(ctx, "automation digest enable", result, () => console.log(`daily digest scheduled for ${result.time}`));
        } else if (action === "disable") {
          const result = removeDigestAutomation();
          respond(ctx, "automation digest disable", result, () => console.log(result.removed ? "daily digest automation removed" : "daily digest automation was not installed"));
        } else if (action === "status") {
          const result = digestAutomationStatus();
          respond(ctx, "automation digest status", result, () => console.log(result.installed ? `daily digest installed at ${result.path}` : "daily digest automation is not installed"));
        } else throw new Error("Usage: smer automation digest [enable|disable|status]");
        break;
      }
      case "pulse": {
        const result = runPulse(store, config, { notify: boolFlag(args, "notify") });
        respond(ctx, "pulse", result, () => console.log(result.notify ? result.message : "No notable activity or health issues."));
        break;
      }
      case "daemon": {
        if (!ctx.quiet) console.log(`smer daemon ${VERSION} using ${store.home}`);
        await runDaemon(store, config);
        break;
      }
      case "status": {
        const since = parseSince("today")!;
        const rows = recentEvents(store, { since, limit: 5000 });
        const pausedUntil = Number(store.setting("paused_until") || 0);
        const result = { today: rows.length, paused: pausedUntil > Math.floor(Date.now() / 1000), pausedUntil };
        respond(ctx, "status", result, () => {
          console.log(boolFlag(args, "segment") ? `smer:${rows.length}${result.paused ? ":paused" : ""}` : JSON.stringify(result, null, 2));
        });
        break;
      }
      case "hook": {
        const result = { shell: "zsh", snippet: shellHookSnippet() };
        respond(ctx, "hook", result, () => console.log(result.snippet));
        break;
      }
      case "commands": {
        const action = args.positionals.shift() || "install";
        if (action !== "install") throw new Error("Usage: smer commands install");
        installAgentFiles(store.home);
        respond(ctx, "commands install", { path: `${store.home}/commands`, installed: ["digest.md", "mine.md", "retro.md", "new-provider.md"] }, () => console.log(`agent commands installed in ${store.home}/commands`));
        break;
      }
      case "redact": {
        const input = stringFlag(args, "text") || args.positionals.join(" ") || readFileSync(0, "utf8");
        const result = redactText(input, store.redactionKeys(), config.emailAllowlist);
        respond(ctx, "redact", { text: result }, () => console.log(result));
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}. Run smer help.`);
    }
  } finally {
    if (store) store.close();
  }
}

async function providerCommand(store: Store, config: ReturnType<typeof loadConfig>, ctx: RuntimeContext, args: ParsedArgs): Promise<void> {
  const action = args.positionals.shift() || "list";
  if (action === "list") {
    const result = listProviders(store, config);
    respond(ctx, "providers", result, () => printProviders(result));
    return;
  }
  if (action === "run") {
    const id = args.positionals.shift();
    if (!id) throw new Error("Usage: smer providers run ID");
    const result = await runProvider(id, store, config, { since: parseSince(stringFlag(args, "since")) });
    respond(ctx, "providers run", result, () => console.log(`${id}: ${result.inserted} inserted, ${result.duplicates} duplicates`));
    return;
  }
  if (["enable", "disable"].includes(action)) {
    const id = args.positionals.shift();
    if (!id) throw new Error(`Usage: smer providers ${action} ID`);
    const all = listProviders(store, config);
    const provider = all.find((item) => item.id === id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    const enabled = action === "enable";
    store.setProviderState({ ...provider, enabled });
    config.enabledProviders = enabled
      ? [...new Set([...config.enabledProviders, id])]
      : config.enabledProviders.filter((item) => item !== id);
    saveConfig(store.home, config);
    respond(ctx, `providers ${action}`, { id, enabled }, () => console.log(`${id} ${enabled ? "enabled" : "disabled"}`));
    return;
  }
  if (action === "add") {
    const id = args.positionals.shift();
    if (!id) throw new Error("Usage: smer providers add ID");
    if (!Object.hasOwn(BUILTIN_ADAPTERS, id)) {
      const custom = loadCustomProviders(store.home).find((provider) => provider.id === id);
      if (!custom) throw new Error(`Put provider.toml in ${store.home}/providers/${id}/ first`);
      config.enabledProviders = [...new Set([...config.enabledProviders, id])];
      saveConfig(store.home, config);
      respond(ctx, "providers add", { id, adapter: custom.adapter, config: custom.configPath }, () => console.log(`${id} added`));
      return;
    }
    if (!["vercel", "github", "inngest", "fal", "slack"].includes(id)) {
      config.enabledProviders = [...new Set([...config.enabledProviders, id])];
      saveConfig(store.home, config);
      respond(ctx, "providers add", { id }, () => console.log(`${id} enabled`));
      return;
    }
    const service = stringFlag(args, "keychain") || `smer-${id}`;
    const token = boolFlag(args, "token-stdin") ? readFileSync(0, "utf8").trim() : await readSecret(`${id} read-only token: `);
    if (!token) throw new Error("No token provided");
    const historyDays = stringFlag(args, "history-days");
    if (historyDays && (!Number.isInteger(Number(historyDays)) || Number(historyDays) < 1)) {
      throw new Error("--history-days must be a positive integer");
    }
    storeKeychainToken(service, token);
    config.cloud[id] = {
      ...(config.cloud[id] || {}),
      keychain: service,
      ...(stringFlag(args, "endpoint") ? { endpoint: stringFlag(args, "endpoint")! } : {}),
      ...(stringFlag(args, "username") ? { username: stringFlag(args, "username")! } : {}),
      ...(stringFlag(args, "team-id") ? { team_id: stringFlag(args, "team-id")! } : {}),
      ...(stringFlag(args, "channels") ? { channels: stringFlag(args, "channels")! } : {}),
      ...(stringFlag(args, "types") ? { types: stringFlag(args, "types")! } : {}),
      ...(historyDays ? { history_days: Number(historyDays) } : {}),
    };
    config.enabledProviders = [...new Set([...config.enabledProviders, id])];
    saveConfig(store.home, config);
    respond(ctx, "providers add", { id, keychain: service, tokenStored: true }, () => console.log(`${id} configured; token stored in Keychain service ${service}`), [`Run smer providers run ${id}`]);
    return;
  }
  if (action === "credential") {
    const id = args.positionals.shift();
    if (!id) throw new Error("Usage: smer providers credential ID [--keychain SERVICE]");
    const service = stringFlag(args, "keychain") || `smer-${id}`;
    const token = boolFlag(args, "token-stdin") ? readFileSync(0, "utf8").trim() : await readSecret(`${id} read-only token: `);
    if (!token) throw new Error("No token provided");
    storeKeychainToken(service, token);
    respond(ctx, "providers credential", { id, keychain: service, tokenStored: true }, () => console.log(`credential stored in Keychain service ${service}`));
    return;
  }
  throw new Error("Usage: smer providers [list|run|enable|disable|add|credential]");
}

function respond<T>(
  ctx: RuntimeContext,
  command: string,
  result: T,
  human: () => void,
  nextActions: string[] = [],
): void {
  if (ctx.json) {
    const envelope: CommandEnvelope<T> = { ok: true, command, result, next_actions: nextActions };
    console.log(JSON.stringify(envelope, null, 2));
  } else if (!ctx.quiet) human();
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split(/=(.*)/s, 2);
    const key = rawKey;
    let value: string | boolean = true;
    if (inline !== undefined) value = inline;
    else if (!BOOLEAN_FLAGS.has(key) && argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) value = argv[++index];
    const previous = flags[key];
    if (previous === undefined) flags[key] = value;
    else if (Array.isArray(previous)) previous.push(String(value));
    else flags[key] = [String(previous), String(value)];
  }
  return { positionals, flags };
}

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return Array.isArray(value) ? value.at(-1) : typeof value === "string" ? value : undefined;
}

function boolFlag(args: ParsedArgs, key: string): boolean {
  return args.flags[key] === true || args.flags[key] === "true";
}

function listFlag(args: ParsedArgs, key: string): string[] {
  const value = args.flags[key];
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

function requiredFlag(args: ParsedArgs, key: string): string {
  const value = stringFlag(args, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function queryOptions(args: ParsedArgs): { project?: string; source?: string; kind?: string; since?: number; until?: number; limit?: number } {
  return {
    project: stringFlag(args, "project"),
    source: stringFlag(args, "source"),
    kind: stringFlag(args, "kind"),
    since: parseSince(stringFlag(args, "since")),
    limit: stringFlag(args, "limit") ? Number(stringFlag(args, "limit")) : undefined,
  };
}

function parseMeta(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--meta must be a JSON object");
  return parsed;
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${value}; use 30m, 1h, or 1d`);
  return Number(match[1]) * { m: 60, h: 3600, d: 86400 }[match[2] as "m" | "h" | "d"];
}

function parseWatchInterval(value: string): number {
  const match = value.match(/^(\d+)(ms|s)$/);
  if (!match) throw new Error("Watch interval must use milliseconds or seconds, such as 500ms or 2s");
  return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

function gapEvent(title: string, meta: Record<string, unknown>): EventEnvelope {
  return {
    ts: Math.floor(Date.now() / 1000),
    source: "smer",
    kind: "note",
    project: null,
    title,
    text: title,
    meta,
  };
}

function publicEvent(event: EventEnvelope): EventEnvelope {
  const meta = { ...event.meta };
  delete meta._fingerprint;
  return { ...event, meta };
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, "utf8").trim();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  return await new Promise<string>((resolveSecret, reject) => {
    const onData = (key: string): void => {
      if (key === "\x03") {
        cleanup();
        reject(new Error("Cancelled"));
      } else if (key === "\r" || key === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolveSecret(value);
      } else if (key === "\x7f") {
        if (value) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (key >= " ") {
        value += key;
        process.stdout.write("*");
      }
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on("data", onData);
  });
}

function printEvents(events: Array<EventEnvelope & { id?: number; snippet?: string }>): void {
  if (!events.length) {
    console.log("No events found.");
    return;
  }
  for (const event of events) {
    const time = new Date(event.ts * 1000).toLocaleString();
    const context = [event.project || "-", event.source, event.kind].join(" / ");
    console.log(`#${event.id || "-"}  ${time}  ${context}\n${event.title}\n${stripFts(event.snippet || event.text).slice(0, 300)}\n`);
  }
}

function printTimeline(blocks: ReturnType<typeof timeline>): void {
  if (!blocks.length) {
    console.log("No activity in this range.");
    return;
  }
  for (const block of blocks) {
    const start = new Date(block.startedAt * 1000).toLocaleString();
    const end = new Date(block.endedAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    console.log(`\n${start} - ${end}  ${block.project || "mixed / unattributed"}`);
    for (const event of block.events) console.log(`  #${event.id} [${event.source}] ${event.title}`);
  }
}

function printStats(result: ReturnType<typeof stats>): void {
  console.log(`${result.total} events\n`);
  console.log("By source");
  for (const row of result.bySource) console.log(`  ${row.source.padEnd(22)} ${row.count}`);
  console.log("\nBy kind");
  for (const row of result.byKind) console.log(`  ${row.kind.padEnd(22)} ${row.count}`);
  console.log("\nBy project");
  for (const row of result.byProject) console.log(`  ${(row.project || "unattributed").padEnd(22)} ${String(row.count).padStart(6)}  ~${formatDuration(row.activeSeconds)}`);
  console.log(`\n${result.note}`);
}

function printBrief(result: ReturnType<typeof buildBrief>): void {
  const start = new Date(result.windows.current.since * 1000).toLocaleString();
  const end = new Date(result.windows.current.until * 1000).toLocaleString();
  console.log(`Brief v${result.schemaVersion} · ${start} — ${end}`);
  console.log(`${result.totals.current} events (${result.totals.previous} in the prior equal window)`);

  if (result.openLoopCandidates.length) {
    console.log("\nOpen-loop candidates");
    for (const item of result.openLoopCandidates) {
      console.log(`  #${item.eventIds.join(", #")} ${item.project || "unattributed"}: ${item.title}`);
    }
  }
  if (result.failureSignals.length) {
    console.log("\nFailure signals");
    for (const item of result.failureSignals) {
      console.log(`  ${item.count}× ${item.project || "unattributed"}/${item.source}: ${item.title} (#${item.eventIds.join(", #")})`);
    }
  }
  if (result.deltas.projects.length) {
    console.log("\nProject deltas");
    for (const item of result.deltas.projects) {
      console.log(`  ${item.key}: ${item.previous} → ${item.current} (${item.status}, #${item.eventIds.join(", #")})`);
    }
  }
  if (result.coverageCaveats.length) {
    console.log("\nCoverage caveats");
    for (const item of result.coverageCaveats) console.log(`  ${item.message}`);
  }
}

function printEventDetail(event: EventEnvelope & { id: number }): void {
  console.log(`#${event.id} ${event.title}\n${new Date(event.ts * 1000).toLocaleString()}  ${event.source}/${event.kind}  ${event.project || "unattributed"}\n\n${event.text}\n\n${JSON.stringify(event.meta, null, 2)}`);
}

function printProviders(providers: ReturnType<typeof listProviders>): void {
  for (const provider of providers) {
    const health = provider.enabled ? provider.healthy ? "ok" : "error" : "off";
    const last = provider.lastRun ? new Date(provider.lastRun * 1000).toLocaleString() : "never";
    console.log(`${health.padEnd(6)} ${provider.id.padEnd(18)} ${provider.adapter.padEnd(12)} last: ${last}${provider.error ? `\n       ${provider.error}` : ""}`);
  }
}

function printDoctor(result: ReturnType<typeof doctor>): void {
  for (const check of result.checks) {
    const mark = check.status === "ok" ? "[ok]" : check.status === "warn" ? "[!!]" : "[xx]";
    console.log(`${mark} ${check.message}`);
    if (check.details && Array.isArray(check.details) && check.details.length) console.log(`     ${JSON.stringify(check.details)}`);
  }
}

function printWorkspace(result: Awaited<ReturnType<typeof scanWorkspaces>>): void {
  console.log(`${result.projects.length} projects found; ${result.newProjects.length} new; ${result.redactionKeys} env key names observed`);
  for (const project of result.projects) console.log(`  ${project.name.padEnd(20)} ${project.path}`);
  for (const suggestion of result.providerSuggestions) console.log(`  suggest ${suggestion.provider} for ${suggestion.project} (${suggestion.evidence.join(", ")})`);
}

function printSetup(result: Awaited<ReturnType<typeof setup>>): void {
  console.log(`smer is ready at ${result.home}`);
  console.log(`${result.workspace.projects.length} projects discovered`);
  for (const item of result.backfill) console.log(`${item.provider}: ${item.inserted} events imported`);
  console.log(result.shellHook.installed ? "zsh hook installed" : `zsh hook available: ${result.shellHook.line}`);
  console.log(result.launchAgent ? `daemon installed: ${result.launchAgent}` : "daemon install skipped");
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function stripFts(value: string): string {
  return value.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
}

const HELP = `smer ${VERSION} - local, event-driven work memory

Usage:
  smer                                      Open the search TUI
  smer setup [--dev-root PATH] [--install-shell]
  smer search "FTS5 query" [--project P] [--source S] [--kind K] [--since 7d]
  smer timeline [--day YYYY-MM-DD] [--project P] [--source S] [--kind K] [--since 7d]
  smer stats [--source S] [--since 30d]
  smer brief [--since 7d] [--json]
  smer show EVENT_ID
  smer watch [--since 5m] [--interval 1s] [--project P] [--source S] [--kind K]
  smer emit --source ID --kind KIND --title TEXT [--text TEXT] [--spool]
  smer pause 1h | smer resume
  smer providers [list|run ID|enable ID|disable ID|add ID]
  smer workspace scan [ROOT]
  smer projects [list|map NAME --path PATH --domain DOMAIN --keyword WORD]
  smer backfill [all|shell|git|claude-code|codex|cursor|figma|assets|browser]
  smer import chatgpt EXPORT.zip
  smer import jsonl EVENTS.jsonl
  smer doctor
  smer daemon
  smer automation digest [enable --at 18:00|disable|status]
  smer automation pulse [enable --every 5m|disable|status]
  smer pulse [--notify]
  smer status --segment

Global options:
  --home PATH      Override ~/.smer (or use SMER_HOME)
  --json           ADR-001 JSON envelope
  --quiet          Suppress human output

Everything stays under ~/.smer unless setup explicitly installs the optional zsh hook and LaunchAgent.
`;

main().catch((error) => {
  const args = process.argv.slice(2);
  const json = args.includes("--json") || args.some((arg) => arg.startsWith("--json="));
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    const command = args.filter((arg) => !arg.startsWith("--"))[0] || "smer";
    console.error(JSON.stringify({ ok: false, command, result: { error: message }, next_actions: ["Run smer help"] }, null, 2));
  } else {
    console.error(`smer: ${message}`);
  }
  process.exitCode = 1;
});
