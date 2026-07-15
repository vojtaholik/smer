import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { ingestEvent, validateEvent } from "../src/events.ts";
import { searchEvents, stats, timeline } from "../src/query.ts";
import { drainSpool, spoolEvent } from "../src/spool.ts";
import { scanWorkspaces } from "../src/providers/workspace.ts";
import { BUILTIN_ADAPTERS, runProvider } from "../src/providers/index.ts";
import { pollSlack } from "../src/providers/cloud.ts";
import { importChatGPT, scanChatGPTInbox } from "../src/importers.ts";
import { setup } from "../src/setup.ts";
import { doctor } from "../src/doctor.ts";
import { Database } from "bun:sqlite";
import { scanAgentLogs, scanBrowsers, scanCursor, scanGit, scanGitWorkingState, importZshHistory } from "../src/providers/local.ts";
import { scanFigma } from "../src/providers/figma.ts";
import { evaluatePulse, runPulse } from "../src/monitor.ts";
import { scanAssets } from "../src/providers/assets.ts";
import { buildBrief, briefLimits } from "../src/brief.ts";

const homes: string[] = [];
const projectRoot = join(import.meta.dir, "..");

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "smer-test-"));
  homes.push(path);
  return path;
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: Math.floor(Date.now() / 1000),
    source: "shell",
    kind: "shell_cmd",
    project: null,
    title: "bun test",
    text: "bun test",
    meta: {},
    ...overrides,
  };
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("store and ingest", () => {
  test("creates a private WAL/FTS store", () => {
    const home = tempHome();
    const store = new Store(home);
    expect((Bun.file(join(home, "smer.db")) as unknown)).toBeTruthy();
    expect(store.db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(store.db.query("SELECT count(*) AS count FROM events_fts").get()).toEqual({ count: 0 });
    store.close();
  });

  test("opens a legacy smem database without creating an empty replacement", () => {
    const home = tempHome();
    const store = new Store(home);
    ingestEvent(store, defaultConfig(), event({ title: "legacy corpus", text: "preserved migration event" }));
    store.close();
    renameSync(join(home, "smer.db"), join(home, "smem.db"));

    const migrated = new Store(home);
    expect(searchEvents(migrated, "preserved migration event")).toHaveLength(1);
    expect(existsSync(join(home, "smer.db"))).toBe(false);
    migrated.close();
  });

  test("validates strictly, redacts before insert, resolves projects, and narrowly dedupes", async () => {
    const home = tempHome();
    const root = join(home, "work");
    const project = join(root, "Roomka App");
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "@acme/roomka" }));
    writeFileSync(join(project, ".env.local"), "VERCEL_TOKEN=must-never-reach-the-db\nOTHER=value\n");
    const config = { ...defaultConfig(), devRoots: [root] };
    const store = new Store(home);
    const scan = await scanWorkspaces(store, config);
    expect(scan.projects[0]?.name).toBe("roomka");
    expect(store.redactionKeys()).toContain("VERCEL_TOKEN");
    store.upsertProject({
      name: "roomka",
      path: project,
      repo: "git@github.com:acme/roomka.git",
      domains: ["roomka.test"],
      keywords: ["roomka", "apex-sync"],
    });
    expect(ingestEvent(store, config, event({ kind: "note", title: "repo signal", meta: { repo: "https://github.com/acme/roomka" } }), { dryRun: true }).event.project).toBe("roomka");
    expect(ingestEvent(store, config, event({ kind: "note", title: "domain signal", meta: { url: "https://docs.roomka.test/fix" } }), { dryRun: true }).event.project).toBe("roomka");
    expect(ingestEvent(store, config, event({ kind: "note", title: "apex-sync investigation" }), { dryRun: true }).event.project).toBe("roomka");

    expect(() => validateEvent({ ...event(), surprise: true })).toThrow("Unknown event fields");
    const now = Math.floor(Date.now() / 1000);
    const first = ingestEvent(store, config, event({
      ts: now,
      title: "deploy roomka",
      text: "VERCEL_TOKEN=must-never-reach-the-db failed for dev@example.com",
      meta: { cwd: project },
    }));
    expect(first.event.project).toBe("roomka");
    expect(first.event.text).toContain("<redacted:vercel_token>");
    expect(first.event.text).toContain("<redacted:email>");
    expect(first.event.text).not.toContain("must-never-reach-the-db");

    const duplicate = ingestEvent(store, config, event({
      ts: now + 1,
      title: "deploy roomka",
      text: "VERCEL_TOKEN=must-never-reach-the-db failed for dev@example.com",
      meta: { cwd: project },
    }));
    expect(duplicate.duplicate).toBe(true);
    const retry = ingestEvent(store, config, event({
      ts: now + 3,
      title: "deploy roomka",
      text: "VERCEL_TOKEN=must-never-reach-the-db failed for dev@example.com",
      meta: { cwd: project },
    }));
    expect(retry.duplicate).toBe(false);

    const allText = store.db.query("SELECT group_concat(title || text || meta) AS value FROM events").get() as { value: string };
    expect(allText.value).not.toContain("must-never-reach-the-db");
    store.close();
  });

  test("search, timeline, stats, and spool ingestion share the same corpus", () => {
    const home = tempHome();
    const store = new Store(home);
    const config = defaultConfig();
    const now = Math.floor(Date.now() / 1000);
    ingestEvent(store, config, event({ ts: now - 1200, title: "start deploy", text: "roomka deploy started", project: "roomka" }));
    ingestEvent(store, config, event({ ts: now - 1100, title: "deploy failed", text: "roomka edge deploy failed", project: "roomka" }));
    ingestEvent(store, config, event({ ts: now, source: "claude-code", kind: "agent_session", title: "fixed deploy", text: "roomka deploy fixed", project: "roomka" }));

    const prepared = ingestEvent(store, config, event({ ts: now + 10, title: "spooled note", text: "sk-proj-abcdefghijklmnopqrstuvwxyz123456 spooled" }), { dryRun: true });
    spoolEvent(home, prepared.event);
    const drained = drainSpool(store, config);
    expect(drained.inserted).toBe(1);
    expect(searchEvents(store, "deploy", { project: "roomka" }).length).toBe(3);
    expect(searchEvents(store, "deploy", { source: "claude-code" })).toHaveLength(1);
    expect(timeline(store, { since: now - 3600 }).length).toBe(2);
    expect(timeline(store, { since: now - 3600, source: "claude-code" }).flatMap((block) => block.events)).toHaveLength(1);
    expect(stats(store, { since: now - 3600, source: "claude-code" }).total).toBe(1);
    expect(stats(store, { since: now - 3600 }).bySource).toContainEqual({ source: "claude-code", count: 1 });
    expect(store.db.query("SELECT text FROM events WHERE title='spooled note'").get()).toEqual({ text: "<redacted:api-key> spooled" });
    writeFileSync(join(home, "spool", "recover.jsonl.processing"), `${JSON.stringify(event({ ts: now + 20, title: "recovered", text: "recovered after crash" }))}\n`);
    writeFileSync(join(home, "spool", "invalid.jsonl"), "{}\n");
    const recovered = drainSpool(store, config);
    expect(recovered.inserted).toBe(1);
    expect(recovered.rejected).toHaveLength(1);
    expect(searchEvents(store, "recovered after crash")).toHaveLength(1);
    expect(existsSync(join(home, "spool", "rejected", "invalid.jsonl"))).toBe(true);
    store.close();
  });

  // @lat: [[tests#Runtime Contract#Brief Contract]]
  test("brief compares equal windows with bounded evidence-backed candidates", () => {
    const home = tempHome();
    const store = new Store(home);
    const config = { ...defaultConfig(), enabledProviders: ["git"] };
    const now = Math.floor(Date.now() / 1000);
    ingestEvent(store, config, event({ ts: now - 5400, project: "alpha", title: "prior work", text: "prior work" }));
    const firstFailure = ingestEvent(store, config, event({
      ts: now - 900,
      source: "vercel",
      kind: "deploy",
      project: "alpha",
      title: "Deploy 101 failed",
      text: "build failed at compile",
      meta: { status: "failed" },
    }));
    const secondFailure = ingestEvent(store, config, event({
      ts: now - 300,
      source: "vercel",
      kind: "deploy",
      project: "alpha",
      title: "Deploy 102 failed",
      text: "build failed at compile again",
      meta: { status: "failed" },
    }));
    ingestEvent(store, config, event({
      ts: now - 100,
      source: "smer",
      kind: "x-observation",
      project: "alpha",
      title: "Derived observation",
      text: "must not feed the next brief",
    }));
    store.setSetting("daemon_heartbeat", String(now));
    store.setProviderState({ id: "git", adapter: "log-tail", enabled: true, healthy: true, lastRun: now, cursor: null, error: null });

    const brief = buildBrief(store, config, { since: now - 3600, now });
    expect(brief).toMatchObject({
      schemaVersion: 1,
      generatedAt: now,
      windows: {
        current: { since: now - 3600, until: now },
        previous: { since: now - 7200, until: now - 3600 },
      },
      totals: { current: 2, previous: 1, truncated: false },
    });
    expect(brief.deltas.projects).toContainEqual(expect.objectContaining({ key: "alpha", current: 2, previous: 1, status: "increased" }));
    expect(brief.failureSignals[0]).toMatchObject({ project: "alpha", source: "vercel", count: 2 });
    expect(brief.failureSignals[0]?.eventIds).toEqual([firstFailure.id, secondFailure.id]);
    expect(brief.outcomes.map((item) => item.id)).toEqual([secondFailure.id, firstFailure.id]);
    expect(brief.openLoopCandidates).toContainEqual(expect.objectContaining({ reason: "unresolved_failure", eventIds: [secondFailure.id] }));
    expect(brief.coverageCaveats).toEqual([]);
    expect(JSON.stringify(brief).length).toBeLessThan(50_000);
    expect(brief.projectSourceMatrix.length).toBeLessThanOrEqual(briefLimits().matrixRows);
    store.close();
  });
});

describe("providers, imports, setup, and CLI", () => {
  test("imports ChatGPT exports idempotently", () => {
    const home = tempHome();
    const path = join(home, "conversations.json");
    writeFileSync(path, JSON.stringify([{
      id: "conversation-1",
      title: "Fix a deploy",
      create_time: 1_784_000_000,
      mapping: {
        one: { message: { author: { role: "user" }, create_time: 1_784_000_000, content: { parts: ["Why did deploy fail?"] } } },
        two: { message: { author: { role: "assistant" }, create_time: 1_784_000_001, content: { parts: ["Inspect the build log."] } } },
      },
    }]));
    const store = new Store(home);
    const first = importChatGPT(store, defaultConfig(), path);
    const second = importChatGPT(store, defaultConfig(), path);
    expect(first.inserted).toBe(1);
    expect(second.duplicates).toBe(1);
    expect(searchEvents(store, "build log").length).toBe(1);
    const inbox = join(home, "imports", "chatgpt");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "conversations.json"), readFileSync(path));
    const inboxFirst = scanChatGPTInbox(store, defaultConfig());
    const inboxSecond = scanChatGPTInbox(store, defaultConfig());
    expect(inboxFirst.scanned).toBe(1);
    expect(inboxFirst.duplicates).toBe(1);
    expect(inboxSecond).toMatchObject({ scanned: 1, inserted: 0, duplicates: 0, warnings: [] });
    store.close();
  });

  test("runs a declarative custom log-tail provider incrementally", async () => {
    const home = tempHome();
    const log = join(home, "source.jsonl");
    writeFileSync(log, `${JSON.stringify({ id: "one", timestamp: 1_784_000_000, action: "synced", project: "roomka", detail: "first" })}\n`);
    const providerDir = join(home, "providers", "local-tool");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "provider.toml"), `[provider.local-tool]\nadapter = "log-tail"\npath = ${JSON.stringify(log)}\ninterval = "1m"\ncursor = "id"\n\n[provider.local-tool.map]\nts = "{timestamp}"\nkind = "x-local-tool"\nproject = "{project}"\ntitle = "{action}"\ntext = "{action} {detail}"\n`);
    const config = { ...defaultConfig(), enabledProviders: [...defaultConfig().enabledProviders, "local-tool"] };
    const store = new Store(home);
    const first = await runProvider("local-tool", store, config);
    const second = await runProvider("local-tool", store, config);
    expect(first.inserted).toBe(1);
    expect(second.scanned).toBe(0);
    expect(searchEvents(store, "synced").length).toBe(1);
    store.close();
  });

  test("polls a declarative API provider and persists its cursor", async () => {
    const home = tempHome();
    const payload = JSON.stringify([{ id: "api-one", timestamp: 1_784_000_000, action: "published", project: "roomka" }]);
    const endpoint = `data:application/json,${encodeURIComponent(payload)}`;
    const providerDir = join(home, "providers", "api-tool");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "provider.toml"), `[provider.api-tool]\nadapter = "api-poll"\nendpoint = ${JSON.stringify(endpoint)}\ninterval = "1m"\ncursor = "id"\n\n[provider.api-tool.map]\nts = "{timestamp}"\nkind = "x-api-tool"\nproject = "{project}"\ntitle = "{action}"\ntext = "{action} from api"\n`);
    const config = { ...defaultConfig(), enabledProviders: [...defaultConfig().enabledProviders, "api-tool"] };
    const store = new Store(home);
    try {
      const first = await runProvider("api-tool", store, config);
      expect(first.inserted).toBe(1);
      expect(first.cursor).toBe("api-one");
      expect(store.providerState("api-tool")?.cursor).toBe("api-one");
      expect(searchEvents(store, "published from api")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("disables an executable provider after five consecutive failures", async () => {
    const home = tempHome();
    const providerDir = join(home, "providers", "broken-tool");
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(join(providerDir, "provider.toml"), `[provider.broken-tool]\nadapter = "executable"\ncommand = ["/bin/sh", "-c", "exit 7"]\ninterval = "1m"\n`);
    const config = { ...defaultConfig(), enabledProviders: [...defaultConfig().enabledProviders, "broken-tool"] };
    const store = new Store(home);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await runProvider("broken-tool", store, config);
        throw new Error("provider unexpectedly succeeded");
      } catch (error) {
        expect(String(error)).toContain("executable exited 7");
      }
    }
    expect(store.providerState("broken-tool")).toMatchObject({ enabled: false, healthy: false, failures: 5 });
    store.close();
  });

  test("harvests bounded agent logs once and updates a completed session in place", () => {
    const home = tempHome();
    const logs = join(home, "logs");
    mkdirSync(logs, { recursive: true });
    const path = join(logs, "rollout-session-1.jsonl");
    writeFileSync(path, [
      JSON.stringify({ timestamp: "2026-07-14T08:00:00Z", session_id: "session-1", cwd: home, type: "user", message: { role: "user", content: [{ text: "Fix apex deploy" }] } }),
      JSON.stringify({ timestamp: "2026-07-14T08:10:00Z", session_id: "session-1", type: "assistant", message: { role: "assistant", content: [{ text: "Resolved the routing failure" }] } }),
    ].join("\n"));
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(path, old, old);
    const store = new Store(home);
    store.upsertProject({ name: "agent-fixture", path: home, domains: [], keywords: ["fixture"] });
    const config = defaultConfig();
    const first = scanAgentLogs(store, config, "codex", [logs], (file) => file.endsWith(".jsonl"), 0);
    const second = scanAgentLogs(store, config, "codex", [logs], (file) => file.endsWith(".jsonl"), 0);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(searchEvents(store, "routing failure")[0]?.project).toBe("agent-fixture");

    writeFileSync(path, `${readFileSync(path, "utf8")}\n${JSON.stringify({ timestamp: "2026-07-14T08:12:00Z", session_id: "session-1", type: "assistant", message: { role: "assistant", content: [{ text: "Shipped the final fix" }] } })}`);
    utimesSync(path, old, old);
    scanAgentLogs(store, config, "codex", [logs], (file) => file.endsWith(".jsonl"), 0);
    expect((store.db.query("SELECT count(*) AS count FROM events WHERE source='codex'").get() as { count: number }).count).toBe(1);
    expect(searchEvents(store, "final fix")).toHaveLength(1);
    store.close();
  });

  test("harvests Cursor JSONL and plain-text transcripts with project attribution", () => {
    const home = tempHome();
    const project = join(home, "cursor-project");
    const slug = project.replace(/^\/+/, "").replaceAll("/", "-");
    const cursorRoot = join(home, "cursor");
    const logs = join(cursorRoot, slug, "agent-transcripts");
    const nestedLogs = join(logs, "session-jsonl");
    mkdirSync(nestedLogs, { recursive: true });
    const jsonl = join(nestedLogs, "session-jsonl.jsonl");
    const plain = join(logs, "session-plain.txt");
    const historyRoot = join(home, "history");
    const historyIndex = join(historyRoot, "saved-file", "entries.json");
    const editedPath = join(project, "src", "editor-context.ts");
    writeFileSync(jsonl, [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Repair Cursor indexing" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [
        { type: "text", text: "I will inspect the current collector" },
        { type: "tool", name: "Read", input: { path: join(project, "src", "collector.ts"), limit: 200 } },
        { type: "tool", name: "StrReplace", input: { path: join(project, "src", "collector.ts"), old_string: "diffbodymarker", new_string: "replacement" } },
      ] } }),
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Also retain the final verification" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [
        { type: "text", text: "Updated the transcript collector and verified the result" },
        { type: "tool", name: "Shell", input: { command: "bun test", description: "Run tests" } },
      ] } }),
      JSON.stringify({ type: "run", status: "completed" }),
      JSON.stringify({ type: "tool", status: "failed", error: "A recoverable fixture failure" }),
    ].join("\n"));
    writeFileSync(plain, "User:\nInvestigate the legacy transcript\n\nAssistant:\nLegacy transcript captured\n");
    mkdirSync(dirname(historyIndex), { recursive: true });
    writeFileSync(historyIndex, JSON.stringify({
      version: 1,
      resource: pathToFileURL(editedPath).href,
      entries: [{ id: "edit-1.ts", timestamp: Date.now() - 12 * 60_000 }],
    }));
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(jsonl, old, old);
    utimesSync(plain, old, old);
    const store = new Store(home);
    store.upsertProject({ name: "cursor-project", path: project, domains: [], keywords: [] });
    const result = scanCursor(store, defaultConfig(), 0, [cursorRoot], [historyRoot]);
    expect(result.inserted).toBe(3);
    const cursorEvent = searchEvents(store, "Cursor indexing")[0];
    expect(cursorEvent?.project).toBe("cursor-project");
    expect(cursorEvent?.text).toContain("Also retain the final verification");
    expect(cursorEvent?.text).toContain("Changed files:");
    expect(cursorEvent?.text).toContain("bun test");
    expect(cursorEvent?.text).toContain("A recoverable fixture failure");
    expect(cursorEvent?.meta).toMatchObject({
      user_turns: 2,
      assistant_turns: 2,
      error_rows: 1,
      tool_counts: { Read: 1, Shell: 1, StrReplace: 1 },
      changed_files: [join(project, "src", "collector.ts")],
    });
    expect(searchEvents(store, "transcript collector")).toHaveLength(1);
    expect(searchEvents(store, "Legacy transcript captured")).toHaveLength(1);
    const editEvent = searchEvents(store, '"editor-context"')[0];
    expect(editEvent).toMatchObject({ source: "cursor", kind: "x-file-edit", project: "cursor-project" });
    expect(editEvent?.meta).toMatchObject({
      relative_path: join("src", "editor-context.ts"),
      extension: ".ts",
      editor: "cursor",
      content_captured: false,
    });
    expect(searchEvents(store, "diffbodymarker")).toHaveLength(0);
    store.close();
  });

  test("polls Slack channels incrementally with API pagination", async () => {
    const home = tempHome();
    const store = new Store(home);
    const config = defaultConfig();
    config.cloud.slack = { endpoint: "https://slack.test/api", channels: "engineering" };
    const now = Math.floor(Date.now() / 1000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("conversations.list")) {
        return Response.json({ ok: true, channels: [{ id: "C1", name: "engineering", is_member: true }], response_metadata: { next_cursor: "" } });
      }
      const secondPage = url.searchParams.get("cursor") === "page-2";
      return Response.json({
        ok: true,
        messages: secondPage
          ? [{ ts: `${now - 10}.000002`, user: "U2", text: "Shipped the Slack collector" }]
          : [{ ts: `${now - 20}.000001`, user: "U1", text: "Review the provider pagination" }],
        response_metadata: { next_cursor: secondPage ? "" : "page-2" },
      });
    }) as typeof fetch;
    try {
      const first = await pollSlack(store, config, "xoxb-test-token");
      store.setProviderState({ id: "slack", adapter: "api-poll", enabled: true, healthy: true, lastRun: now, cursor: first.cursor || null, error: null });
      const second = await pollSlack(store, config, "xoxb-test-token");
      expect(first).toMatchObject({ scanned: 2, inserted: 2 });
      expect(second.duplicates).toBe(2);
      expect(JSON.parse(first.cursor || "{}")).toEqual({ C1: `${now - 10}.000002` });
      expect(searchEvents(store, "Slack collector")).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
    }
  });

  test("lists Cursor, Figma, assets, and Slack as built-in providers", () => {
    expect(BUILTIN_ADAPTERS).toMatchObject({ cursor: "log-tail", figma: "json-poll", assets: "fs-scan", slack: "api-poll" });
    expect(defaultConfig().enabledProviders).toContain("cursor");
    expect(defaultConfig().enabledProviders).toContain("figma");
    expect(defaultConfig().enabledProviders).toContain("assets");
    expect(defaultConfig().enabledProviders).not.toContain("slack");
  });

  test("tails each browser profile with an independent cursor and drops denied domains", () => {
    const home = tempHome();
    const history = join(home, "History");
    const browser = new Database(history, { create: true });
    browser.exec("CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER)");
    const now = Math.floor(Date.now() / 1000);
    const chromiumTime = (now + 11_644_473_600) * 1_000_000;
    browser.query("INSERT INTO urls(url, title, last_visit_time) VALUES (?, ?, ?)").run("https://docs.example.com/deploy", "Deploy docs", chromiumTime);
    browser.query("INSERT INTO urls(url, title, last_visit_time) VALUES (?, ?, ?)").run("https://bank.test/account", "Private account", chromiumTime + 1);
    browser.close();
    const store = new Store(home);
    const config = { ...defaultConfig(), browserDenylist: ["bank.test"] };
    const first = scanBrowsers(store, config, [history]);
    store.setProviderState({ id: "browser", adapter: "sqlite-tail", enabled: true, healthy: true, lastRun: now, cursor: first.cursor || null, error: null });
    const second = scanBrowsers(store, config, [history]);
    expect(first.scanned).toBe(2);
    expect(first.inserted).toBe(1);
    expect(second.scanned).toBe(0);
    expect(searchEvents(store, "Deploy docs")).toHaveLength(1);
    expect(searchEvents(store, "Private account")).toHaveLength(0);
    store.close();
  });

  test("captures Figma desktop edit markers without transient or signed metadata", () => {
    const home = tempHome();
    const settings = join(home, "figma-settings.json");
    const now = Math.floor(Date.now() / 1000);
    const writeSettings = (editedAt: number): void => {
      writeFileSync(settings, JSON.stringify({
        windows: [{
          tabs: [{
            path: "/file/fixture-key/Product-Screens",
            params: "?node-id=12-34&viewport=private&t=session-token",
            title: "Product screens",
            editorType: "design",
            createdAt: (now - 3600) * 1000,
            editedAt,
            lastViewedAt: now * 1000,
            isDiscarded: false,
            thumbnail: { url: "https://signed.example.test/private?signature=secret" },
          }],
        }],
      }));
    };
    writeSettings((now - 60) * 1000);
    const store = new Store(home);
    const first = scanFigma(store, defaultConfig(), settings, now - 86400);
    store.setProviderState({ id: "figma", adapter: "json-poll", enabled: true, healthy: true, lastRun: now, cursor: first.cursor || null, error: null });
    expect(first.inserted).toBe(1);
    expect(scanFigma(store, defaultConfig(), settings, now - 86400).scanned).toBe(0);

    writeSettings(now * 1000);
    const second = scanFigma(store, defaultConfig(), settings, now - 86400);
    expect(second.inserted).toBe(1);
    const rows = searchEvents(store, "Product screens");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.meta).toMatchObject({
      url: "https://www.figma.com/file/fixture-key/Product-Screens?node-id=12-34",
      node_id: "12-34",
      has_thumbnail: true,
      activity_basis: "desktop-edited-at",
    });
    expect(JSON.stringify(rows[0]?.meta)).not.toContain("session-token");
    expect(JSON.stringify(rows[0]?.meta)).not.toContain("signed.example.test");

    writeFileSync(settings, JSON.stringify({ windows: "changed" }));
    expect(scanFigma(store, defaultConfig(), settings).warnings[0]).toContain("private schema may have changed");
    store.close();
  });

  // @lat: [[tests#Provider Contracts#Local Asset Saves]]
  test("captures image save metadata without reading image content", () => {
    const home = tempHome();
    const project = join(home, "Developer", "badass.dev");
    mkdirSync(project, { recursive: true });
    const image = join(project, "hero-export@2x.png");
    writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X1nKAAAAAElFTkSuQmCC", "base64"));
    const now = Math.floor(Date.now() / 1000);
    const store = new Store(home);
    store.upsertProject({ name: "false-positive", path: join(home, "unrelated", "very-long-project-path"), domains: [], keywords: ["eve"] });
    store.upsertProject({ name: "asset-project", path: join(home, "unrelated"), domains: [], keywords: ["badass"] });
    const config = { ...defaultConfig(), devRoots: [home] };
    const first = scanAssets(store, config, now - 60, [image]);
    const second = scanAssets(store, config, now - 60, [image]);
    expect(first).toMatchObject({ scanned: 1, inserted: 1 });
    expect(second).toMatchObject({ scanned: 1, duplicates: 1 });
    const saved = searchEvents(store, '"hero-export"')[0];
    expect(saved).toMatchObject({ source: "assets", kind: "x-asset-save", project: "asset-project" });
    expect(saved?.meta).toMatchObject({ path: image, extension: ".png", content_captured: false, activity_basis: "filesystem-mtime" });
    expect(saved?.title).toContain("hero-export at 2x.png");
    expect(saved?.text).not.toContain("iVBOR");
    store.close();
  });

  test("backfills shell history and git reflog with project evidence", () => {
    const home = tempHome();
    const history = join(home, ".zsh_history");
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(history, `: ${now}:0;bun test\n`);
    const repo = join(home, "repo");
    mkdirSync(repo, { recursive: true });
    expect(Bun.spawnSync(["git", "init", repo], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "fixture\n");
    Bun.spawnSync(["git", "-C", repo, "add", "README.md"]);
    expect(Bun.spawnSync(["git", "-C", repo, "-c", "user.name=smer test", "-c", "user.email=smer@example.test", "commit", "-m", "initial fixture"], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    const store = new Store(home);
    store.upsertProject({ name: "fixture", path: repo, domains: [], keywords: ["fixture"] });
    const config = defaultConfig();
    expect(importZshHistory(store, config, history, now - 60).inserted).toBe(1);
    expect(scanGit(store, config, now - 60).inserted).toBeGreaterThan(0);
    expect(searchEvents(store, "initial fixture")[0]?.project).toBe("fixture");
    store.close();
  });

  // @lat: [[tests#Provider Contracts#Git Working State]]
  test("git working state emits metadata only when the state changes", () => {
    const home = tempHome();
    const repo = join(home, "state-repo");
    mkdirSync(repo, { recursive: true });
    expect(Bun.spawnSync(["git", "init", repo], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    writeFileSync(join(repo, "README.md"), "clean\n");
    Bun.spawnSync(["git", "-C", repo, "add", "README.md"]);
    expect(Bun.spawnSync(["git", "-C", repo, "-c", "user.name=smer test", "-c", "user.email=smer@example.test", "commit", "-m", "initial"], { stdout: "ignore", stderr: "pipe" }).exitCode).toBe(0);
    const store = new Store(home);
    store.upsertProject({ name: "state-repo", path: repo, domains: [], keywords: ["state-repo"] });
    const config = defaultConfig();

    expect(scanGitWorkingState(store, config)).toMatchObject({ scanned: 1, inserted: 1, duplicates: 0 });
    expect(scanGitWorkingState(store, config)).toMatchObject({ scanned: 1, inserted: 0, duplicates: 1 });
    writeFileSync(join(repo, "README.md"), "dirty\n");
    expect(scanGitWorkingState(store, config)).toMatchObject({ scanned: 1, inserted: 1, duplicates: 0 });

    const rows = store.db.query("SELECT meta FROM events WHERE kind = 'x-git-state' ORDER BY id").all() as Array<{ meta: string }>;
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].meta)).toMatchObject({ dirty_files: 0, content_captured: false, schema_version: 1 });
    expect(JSON.parse(rows[1].meta)).toMatchObject({ dirty_files: 1, content_captured: false, schema_version: 1 });
    expect(rows.join(" ")).not.toContain("dirty\\n");
    store.close();
  });

  test("setup installs agent files without touching launchd or zsh when opted out", async () => {
    const home = tempHome();
    const root = join(home, "workspace");
    mkdirSync(join(root, "sample", ".git"), { recursive: true });
    const store = new Store(home);
    const result = await setup(store, { devRoots: [root], launchd: false, backfill: false, installShell: false });
    expect(result.launchAgent).toBeNull();
    expect(result.shellHook.installed).toBe(false);
    expect(await Bun.file(join(home, "commands", "mine.md")).exists()).toBe(true);
    expect(await Bun.file(join(home, "commands", "digest.md")).text()).toContain("smer brief --since 1d --json");
    expect(loadConfig(home).devRoots).toEqual([root]);
    expect(store.providerState("workspace")).toMatchObject({ adapter: "fs-scan", healthy: true });
    const health = doctor(store, loadConfig(home));
    expect(health.healthy).toBe(true);
    store.close();
  });

  // @lat: [[tests#Runtime Contract#Conditional Pulse]]
  test("pulse suppresses ambient events and advances its reporting window", () => {
    const home = tempHome();
    const store = new Store(home);
    const config = { ...defaultConfig(), enabledProviders: ["shell", "git", "browser"] };
    const now = Math.floor(Date.now() / 1000);
    store.setSetting("daemon_heartbeat", String(now));
    ingestEvent(store, config, event({ ts: now - 30, source: "browser", kind: "browser_visit", title: "Docs", text: "Docs" }));
    ingestEvent(store, config, event({ ts: now - 20, source: "shell", kind: "shell_cmd", title: "bun test", text: "bun test", meta: { exit_code: 0 } }));
    ingestEvent(store, config, event({ ts: now - 10, source: "git", kind: "git_commit", project: "smer", title: "Add pulse", text: "Add pulse" }));

    const first = runPulse(store, config, { now });
    expect(first).toMatchObject({ notify: true, eventCount: 3, notableCount: 1, healthIssues: [] });
    expect(first.message).toContain("1 commit in smer");

    store.setSetting("daemon_heartbeat", String(now + 300));
    const second = runPulse(store, config, { now: now + 300 });
    expect(second).toMatchObject({ notify: false, eventCount: 0, notableCount: 0, healthIssues: [] });
    store.close();
  });

  // @lat: [[tests#Runtime Contract#Conditional Pulse Health]]
  test("pulse reports stale daemon and unhealthy providers without events", () => {
    const home = tempHome();
    const store = new Store(home);
    const config = { ...defaultConfig(), enabledProviders: ["git"] };
    const now = Math.floor(Date.now() / 1000);
    store.setSetting("daemon_heartbeat", String(now - 600));
    store.setProviderState({ id: "git", adapter: "log-tail", enabled: true, healthy: false, lastRun: now - 60, cursor: null, error: "fixture failure" });
    const result = evaluatePulse(store, config, now);
    expect(result.notify).toBe(true);
    expect(result.healthIssues).toEqual(["daemon heartbeat is 10m old", "providers unhealthy: git"]);
    expect(result.title).toBe("smer needs attention");
    store.close();
  });

  test("CLI returns ADR-001 envelopes", () => {
    const home = tempHome();
    const cli = join(projectRoot, "src", "cli.ts");
    const emit = Bun.spawnSync(["bun", cli, "emit", "--home", home, "--source", "shell", "--kind", "shell_cmd", "--title", "compile release", "--text", "compile release", "--json"]);
    expect(emit.exitCode).toBe(0);
    expect(JSON.parse(emit.stdout.toString()).ok).toBe(true);
    const search = Bun.spawnSync(["bun", cli, "search", "--home", home, "compile", "--json"]);
    const payload = JSON.parse(search.stdout.toString());
    expect(payload).toMatchObject({ ok: true, command: "search" });
    expect(payload.result).toHaveLength(1);
    const brief = Bun.spawnSync(["bun", cli, "brief", "--home", home, "--since", "7d", "--json"]);
    expect(brief.exitCode).toBe(0);
    expect(JSON.parse(brief.stdout.toString())).toMatchObject({ ok: true, command: "brief", result: { schemaVersion: 1 } });
  });

  test("daemon makes a spooled event searchable within five seconds", async () => {
    const home = tempHome();
    const cli = join(projectRoot, "src", "cli.ts");
    const config = { ...defaultConfig(), devRoots: [home], enabledProviders: ["shell"] };
    saveConfig(home, config);
    const daemon = Bun.spawn(["bun", cli, "daemon", "--home", home, "--quiet"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(join(home, "run", "daemon.pid")).exists()); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(join(home, "run", "daemon.pid")).exists()).toBe(true);
      const started = performance.now();
      const emit = Bun.spawnSync(["bun", cli, "emit", "--home", home, "--source", "shell", "--kind", "shell_cmd", "--title", "daemon latency", "--text", "latencyneedle", "--spool", "--json"]);
      expect(emit.exitCode).toBe(0);
      let found = false;
      while (!found && performance.now() - started < 5000) {
        const search = Bun.spawnSync(["bun", cli, "search", "--home", home, "latencyneedle", "--json"]);
        found = search.exitCode === 0 && JSON.parse(search.stdout.toString()).result.length === 1;
        if (!found) await Bun.sleep(25);
      }
      expect(found).toBe(true);
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      daemon.kill("SIGTERM");
      await daemon.exited;
    }
  }, 10_000);
});
