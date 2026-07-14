import type { SmerConfig, ProviderStatus } from "../types.ts";
import type { Store } from "../store.ts";
import { pollCloudProvider } from "./cloud.ts";
import { loadCustomProviders, runCustomProvider } from "./custom.ts";
import { scanFigma } from "./figma.ts";
import { scanWorkspaces } from "./workspace.ts";
import { scanBrowsers, scanClaude, scanCodex, scanCursor, scanGit, type ProviderRunResult } from "./local.ts";

export const BUILTIN_ADAPTERS: Record<string, string> = {
  workspace: "fs-scan",
  shell: "hook",
  git: "log-tail",
  "claude-code": "log-tail",
  codex: "log-tail",
  cursor: "log-tail",
  figma: "json-poll",
  chatgpt: "import",
  browser: "sqlite-tail",
  vercel: "api-poll",
  github: "api-poll",
  inngest: "api-poll",
  fal: "api-poll",
  slack: "api-poll",
};

export function listProviders(store: Store, config: SmerConfig): ProviderStatus[] {
  const custom = loadCustomProviders(store.home);
  const ids = [...Object.keys(BUILTIN_ADAPTERS), ...custom.map((provider) => provider.id)];
  return ids.map((id) => {
    const state = store.providerState(id);
    const customProvider = custom.find((provider) => provider.id === id);
    return {
      id,
      adapter: BUILTIN_ADAPTERS[id] || customProvider?.adapter || "unknown",
      enabled: state ? state.enabled : config.enabledProviders.includes(id),
      healthy: state?.healthy ?? true,
      lastRun: state?.lastRun ?? null,
      cursor: state?.cursor ?? null,
      error: state?.error ?? null,
      details: customProvider?.configPath,
    };
  });
}

export async function runProvider(
  id: string,
  store: Store,
  config: SmerConfig,
  options: { since?: number } = {},
): Promise<ProviderRunResult> {
  const adapter = BUILTIN_ADAPTERS[id] || loadCustomProviders(store.home).find((provider) => provider.id === id)?.adapter;
  if (!adapter) throw new Error(`Unknown provider: ${id}`);
  const previous = store.providerState(id);
  if (previous && !previous.enabled) throw new Error(`${id} is disabled`);

  try {
    let result: ProviderRunResult;
    if (id === "workspace") {
      const scan = await scanWorkspaces(store, config);
      result = {
        provider: id,
        scanned: scan.projects.length,
        inserted: scan.newProjects.length,
        duplicates: scan.projects.length - scan.newProjects.length,
        warnings: scan.providerSuggestions.map(
          (suggestion) => `${suggestion.project}: consider ${suggestion.provider} (${suggestion.evidence.join(", ")})`,
        ),
      };
    } else if (id === "git") result = scanGit(store, config, options.since);
    else if (id === "claude-code") result = scanClaude(store, config);
    else if (id === "codex") result = scanCodex(store, config);
    else if (id === "cursor") result = scanCursor(store, config);
    else if (id === "figma") result = scanFigma(store, config);
    else if (id === "browser") result = scanBrowsers(store, config);
    else if (["vercel", "github", "inngest", "fal", "slack"].includes(id)) {
      result = await pollCloudProvider(id as "vercel" | "github" | "inngest" | "fal" | "slack", store, config);
    } else if (id === "shell" || id === "chatgpt") {
      result = { provider: id, scanned: 0, inserted: 0, duplicates: 0, warnings: [`${id} is event/import driven`] };
    } else {
      const provider = loadCustomProviders(store.home).find((item) => item.id === id);
      if (!provider) throw new Error(`Unknown custom provider: ${id}`);
      result = await runCustomProvider(provider, store, config);
    }

    store.setProviderState({
      id,
      adapter,
      enabled: true,
      healthy: true,
      lastRun: Math.floor(Date.now() / 1000),
      cursor: result.cursor ?? previous?.cursor ?? null,
      error: null,
    });
    return result;
  } catch (error) {
    const failures = (previous?.failures || 0) + 1;
    const isExecutable = adapter === "executable";
    store.setProviderState(
      {
        id,
        adapter,
        enabled: !(isExecutable && failures >= 5),
        healthy: false,
        lastRun: Math.floor(Date.now() / 1000),
        cursor: previous?.cursor || null,
        error: error instanceof Error ? error.message : String(error),
      },
      failures,
    );
    throw error;
  }
}

export async function runDueProviders(store: Store, config: SmerConfig): Promise<ProviderRunResult[]> {
  const now = Math.floor(Date.now() / 1000);
  const custom = loadCustomProviders(store.home);
  const results: ProviderRunResult[] = [];
  for (const status of listProviders(store, config)) {
    if (!status.enabled || ["shell", "chatgpt"].includes(status.id)) continue;
    const interval = custom.find((provider) => provider.id === status.id)?.interval || config.providerIntervals[status.id] || 600;
    if (status.lastRun && now - status.lastRun < interval) continue;
    try {
      results.push(await runProvider(status.id, store, config));
    } catch {
      // State captures the error; one provider never stops the daemon.
    }
  }
  return results;
}
