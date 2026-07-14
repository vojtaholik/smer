import type { SmerConfig } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";
import type { ProviderRunResult } from "./local.ts";

type JsonRecord = Record<string, unknown>;

export async function pollCloudProvider(
  id: "vercel" | "github" | "inngest" | "fal" | "slack",
  store: Store,
  config: SmerConfig,
): Promise<ProviderRunResult> {
  if (id === "vercel") return pollVercel(store, config);
  if (id === "github") return pollGitHub(store, config);
  if (id === "slack") return pollSlack(store, config);
  return pollGenericJobs(id, store, config);
}

export async function pollSlack(
  store: Store,
  config: SmerConfig,
  tokenOverride?: string,
): Promise<ProviderRunResult> {
  const result = empty("slack");
  const provider = config.cloud.slack || {};
  const credential = providerCredential(provider, "smer-slack", "smem-slack");
  const token = tokenOverride || credential.token;
  if (!token) throw new Error(`Slack token missing from Keychain (service: ${credential.services.join(" or ")})`);

  const baseUrl = String(provider.endpoint || "https://slack.com/api").replace(/\/$/, "");
  const requested = new Set(String(provider.channels || "").split(",").map((value) => value.trim().replace(/^#/, "")).filter(Boolean));
  const conversations: JsonRecord[] = [];
  let listCursor = "";
  do {
    const url = new URL(`${baseUrl}/conversations.list`);
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "200");
    url.searchParams.set("types", String(provider.types || "public_channel,private_channel"));
    if (provider.team_id) url.searchParams.set("team_id", String(provider.team_id));
    if (listCursor) url.searchParams.set("cursor", listCursor);
    const body = await fetchSlack(url, token);
    conversations.push(...(Array.isArray(body.channels) ? body.channels as JsonRecord[] : []));
    listCursor = slackNextCursor(body);
  } while (listCursor);

  let cursors: Record<string, string> = {};
  try {
    const parsed = JSON.parse(store.providerState("slack")?.cursor || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cursors = parsed as Record<string, string>;
  } catch {
    // A malformed cursor starts a bounded backfill instead of stopping capture.
  }
  const historyDays = Math.max(1, Number(provider.history_days || 30));
  const initialOldest = String(Math.floor(Date.now() / 1000) - historyDays * 86400);

  for (const conversation of conversations) {
    const channelId = String(conversation.id || "");
    const channelName = String(conversation.name || conversation.user || channelId);
    if (!channelId || conversation.is_member === false) continue;
    if (requested.size && !requested.has(channelId) && !requested.has(channelName)) continue;

    const oldest = cursors[channelId] || initialOldest;
    let newest = oldest;
    let historyCursor = "";
    do {
      const url = new URL(`${baseUrl}/conversations.history`);
      url.searchParams.set("channel", channelId);
      url.searchParams.set("oldest", oldest);
      url.searchParams.set("limit", "200");
      if (historyCursor) url.searchParams.set("cursor", historyCursor);
      const body = await fetchSlack(url, token);
      const messages = Array.isArray(body.messages) ? body.messages as JsonRecord[] : [];
      for (const row of messages.reverse()) {
        result.scanned += 1;
        const message = row.message && typeof row.message === "object" ? row.message as JsonRecord : row;
        const messageTs = String(message.ts || row.ts || "");
        const text = String(message.text || "").trim();
        if (!messageTs || !text) continue;
        if (Number(messageTs) > Number(newest)) newest = messageTs;
        const titleText = text.replace(/\s+/g, " ").slice(0, 200);
        const event = ingestEvent(store, config, {
          ts: normalizeTimestamp(messageTs),
          source: "slack",
          kind: "x-slack-message",
          project: null,
          title: `#${channelName}: ${titleText}`,
          text,
          meta: {
            channel: channelName,
            channel_id: channelId,
            message_ts: messageTs,
            thread_ts: message.thread_ts || null,
            user: message.user || message.bot_id || null,
            subtype: message.subtype || row.subtype || null,
          },
        }, { contentHash: contentHash("slack", `${channelId}:${messageTs}`), upsert: true });
        count(result, event.duplicate);
      }
      historyCursor = slackNextCursor(body);
    } while (historyCursor);
    cursors[channelId] = newest;
  }

  result.cursor = JSON.stringify(cursors);
  return result;
}

async function fetchSlack(url: URL, token: string): Promise<JsonRecord> {
  const body = await fetchJson(url, { Authorization: `Bearer ${token}` }) as JsonRecord;
  if (body.ok !== true) throw new Error(`Slack API error: ${String(body.error || "unknown_error")}`);
  return body;
}

function slackNextCursor(body: JsonRecord): string {
  const metadata = body.response_metadata;
  return metadata && typeof metadata === "object"
    ? String((metadata as JsonRecord).next_cursor || "")
    : "";
}

async function pollVercel(store: Store, config: SmerConfig): Promise<ProviderRunResult> {
  const result = empty("vercel");
  const credential = providerCredential(config.cloud.vercel || {}, "smer-vercel", "smem-vercel");
  const token = credential.token;
  if (!token) throw new Error(`Vercel token missing from Keychain (service: ${credential.services.join(" or ")})`);
  const state = store.providerState("vercel");
  const url = new URL(String(config.cloud.vercel?.endpoint || "https://api.vercel.com/v6/deployments"));
  url.searchParams.set("limit", "100");
  const teamId = config.cloud.vercel?.team_id;
  if (teamId) url.searchParams.set("teamId", String(teamId));
  if (state?.cursor) url.searchParams.set("since", state.cursor);

  const body = await fetchJson(url, { Authorization: `Bearer ${token}` });
  const rows = Array.isArray(body.deployments) ? body.deployments as JsonRecord[] : [];
  let cursor = Number(state?.cursor || 0);
  for (const row of rows) {
    result.scanned += 1;
    const id = String(row.uid || row.id || "");
    const created = normalizeTimestamp(row.createdAt || row.created || row.created_at);
    cursor = Math.max(cursor, created * 1000);
    const name = String(row.name || row.project || "deployment");
    const status = String(row.readyState || row.state || row.status || "unknown").toLowerCase();
    const target = String(row.target || "");
    const deployUrl = row.url ? `https://${String(row.url).replace(/^https?:\/\//, "")}` : "";
    const event = ingestEvent(
      store,
      config,
      {
        ts: created,
        source: "vercel",
        kind: "deploy",
        project: name,
        title: `${name} -> ${status}`,
        text: [name, status, target, deployUrl].filter(Boolean).join(" "),
        meta: { id, status, target, url: deployUrl, duration_ms: row.ready ? Number(row.ready) - created * 1000 : null },
      },
      { contentHash: contentHash("vercel", id || `${name}:${created}:${status}`) },
    );
    count(result, event.duplicate);
  }
  result.cursor = String(cursor || Date.now());
  return result;
}

async function pollGitHub(store: Store, config: SmerConfig): Promise<ProviderRunResult> {
  const result = empty("github");
  const credential = providerCredential(config.cloud.github || {}, "smer-github", "smem-github");
  const token = credential.token;
  if (!token) throw new Error(`GitHub token missing from Keychain (service: ${credential.services.join(" or ")})`);
  let username = String(config.cloud.github?.username || "");
  if (!username) {
    const user = await fetchJson(new URL("https://api.github.com/user"), githubHeaders(token));
    username = String(user.login || "");
  }
  if (!username) throw new Error("Could not determine GitHub username");
  const endpoint = String(config.cloud.github?.endpoint || `https://api.github.com/users/${username}/events`);
  const body = await fetchJson(new URL(endpoint), githubHeaders(token));
  const rows = Array.isArray(body) ? body as JsonRecord[] : [];
  let newestId = store.providerState("github")?.cursor || null;

  for (const row of rows.reverse()) {
    const id = String(row.id || "");
    if (id && id === store.providerState("github")?.cursor) continue;
    result.scanned += 1;
    const type = String(row.type || "");
    const repo = (row.repo || {}) as JsonRecord;
    const payload = (row.payload || {}) as JsonRecord;
    const repoName = String(repo.name || "");
    const project = repoName.split("/").at(-1) || null;
    const ts = normalizeTimestamp(row.created_at);
    if (type === "PushEvent") {
      const commits = Array.isArray(payload.commits) ? payload.commits as JsonRecord[] : [];
      for (const commit of commits.length ? commits : [{}]) {
        const sha = String(commit.sha || payload.head || id);
        const message = String(commit.message || `Pushed to ${repoName}`);
        const event = ingestEvent(store, config, {
          ts,
          source: "github",
          kind: "git_commit",
          project,
          title: message.split("\n")[0].slice(0, 240),
          text: `${message}\n${repoName}\n${sha}`,
          meta: { repo: `https://github.com/${repoName}`, sha, event_id: id, remote: true },
        }, { contentHash: contentHash("github", `${id}:${sha}`) });
        count(result, event.duplicate);
      }
    } else if (type === "PullRequestEvent") {
      const pr = (payload.pull_request || {}) as JsonRecord;
      const action = String(payload.action || "updated");
      const title = String(pr.title || `Pull request ${action}`);
      const event = ingestEvent(store, config, {
        ts,
        source: "github",
        kind: "x-pr",
        project,
        title: `${title} (${action})`,
        text: `${title}\n${repoName}\n${String(pr.html_url || "")}`,
        meta: { repo: `https://github.com/${repoName}`, url: pr.html_url, action, event_id: id },
      }, { contentHash: contentHash("github", id) });
      count(result, event.duplicate);
    }
    newestId = String(row.id || newestId || "") || newestId;
  }
  result.cursor = newestId;
  return result;
}

async function pollGenericJobs(
  id: "inngest" | "fal",
  store: Store,
  config: SmerConfig,
): Promise<ProviderRunResult> {
  const result = empty(id);
  const provider = config.cloud[id] || {};
  const endpoint = String(provider.endpoint || "");
  if (!endpoint) throw new Error(`${id} endpoint is not configured in config.toml`);
  const credential = providerCredential(provider, `smer-${id}`, `smem-${id}`);
  const token = credential.token;
  if (!token) throw new Error(`${id} token missing from Keychain (service: ${credential.services.join(" or ")})`);
  const url = new URL(endpoint);
  const state = store.providerState(id);
  if (state?.cursor && provider.cursor_param) url.searchParams.set(String(provider.cursor_param), state.cursor);
  const body = await fetchJson(url, { Authorization: `Bearer ${token}` });
  const candidates = body.data ?? body.runs ?? body.items ?? body.usage ?? body;
  const rows = Array.isArray(candidates) ? candidates as JsonRecord[] : [];
  let cursor = state?.cursor || null;
  for (const row of rows) {
    result.scanned += 1;
    const stableId = String(row.id || row.run_id || row.request_id || JSON.stringify(row));
    const ts = normalizeTimestamp(row.created_at || row.createdAt || row.started_at || row.timestamp);
    const status = String(row.status || row.state || "unknown");
    const name = String(row.function_name || row.function || row.model || row.name || id);
    const project = row.project ? String(row.project) : null;
    const event = ingestEvent(store, config, {
      ts,
      source: id,
      kind: "api_job",
      project,
      title: `${name} -> ${status}`,
      text: [name, status, row.error, row.cost ? `cost=${String(row.cost)}` : ""].filter(Boolean).join("\n"),
      meta: {
        id: stableId,
        status,
        duration_ms: row.duration_ms ?? row.duration,
        cost: row.cost,
        model: row.model,
      },
    }, { contentHash: contentHash(id, stableId) });
    count(result, event.duplicate);
    cursor = String(row.cursor || row.id || cursor || "") || cursor;
  }
  result.cursor = cursor;
  return result;
}

async function fetchJson(url: URL, headers: Record<string, string>): Promise<any> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`${response.status} ${response.statusText}: ${body}`);
  }
  return response.json();
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "smer-local",
  };
}

export function keychainToken(service: string): string | null {
  const result = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function providerCredential(
  provider: Record<string, string | number | boolean>,
  currentService: string,
  legacyService: string,
): { token: string | null; services: string[] } {
  const configured = typeof provider.keychain === "string" && provider.keychain ? provider.keychain : null;
  const services = configured ? [configured] : [currentService, legacyService];
  for (const service of services) {
    const token = keychainToken(service);
    if (token) return { token, services: [service] };
  }
  return { token: null, services };
}

export function storeKeychainToken(service: string, token: string): void {
  const result = Bun.spawnSync(
    ["security", "add-generic-password", "-U", "-a", process.env.USER || "smer", "-s", service, "-w", token],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Could not write token to Keychain");
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number") {
    if (value > 10_000_000_000) return Math.floor(value / 1000);
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric);
  }
  return Math.floor(Date.now() / 1000);
}

function empty(provider: string): ProviderRunResult {
  return { provider, scanned: 0, inserted: 0, duplicates: 0, warnings: [] };
}

function count(result: ProviderRunResult, duplicate: boolean): void {
  if (duplicate) result.duplicates += 1;
  else result.inserted += 1;
}
