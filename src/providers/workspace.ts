import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SmerConfig, ProjectRecord } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROVIDER_HINTS: Array<[RegExp, string]> = [
  [/^VERCEL_/, "vercel"],
  [/^(GH|GITHUB)_/, "github"],
  [/^INNGEST_/, "inngest"],
  [/^(FAL|FALAI)_/, "fal"],
];

export interface WorkspaceScanResult {
  roots: string[];
  projects: ProjectRecord[];
  newProjects: string[];
  redactionKeys: number;
  providerSuggestions: Array<{ project: string; provider: string; evidence: string[] }>;
}

export async function scanWorkspaces(
  store: Store,
  config: SmerConfig,
  roots = config.devRoots,
): Promise<WorkspaceScanResult> {
  const existing = new Set(store.projects().map((project) => project.path));
  const discovered: ProjectRecord[] = [];
  const suggestions = new Map<string, Set<string>>();
  let redactionKeys = 0;

  for (const inputRoot of roots) {
    const root = resolve(inputRoot);
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    walk(root, config, 0, (projectPath) => {
      const project = inspectProject(projectPath);
      discovered.push(project);
      store.upsertProject(project);
      for (const envPath of envFiles(projectPath)) {
        for (const key of readEnvKeyNames(envPath)) {
          store.addRedactionKey(key, project.name);
          redactionKeys += 1;
          for (const [pattern, provider] of PROVIDER_HINTS) {
            if (pattern.test(key)) {
              const id = `${project.name}\0${provider}`;
              const set = suggestions.get(id) || new Set<string>();
              set.add(key);
              suggestions.set(id, set);
            }
          }
        }
      }
    });
  }

  const newProjects = discovered.filter((project) => !existing.has(project.path));
  for (const project of newProjects) {
    ingestEvent(
      store,
      config,
      {
        ts: Math.floor(Date.now() / 1000),
        source: "workspace",
        kind: "x-project-discovered",
        project: project.name,
        title: `Discovered ${project.name}`,
        text: [project.path, project.repo].filter(Boolean).join("\n"),
        meta: { cwd: project.path, repo: project.repo, domains: project.domains },
      },
      { contentHash: contentHash("workspace", project.path) },
    );
  }

  return {
    roots,
    projects: discovered,
    newProjects: newProjects.map((project) => project.name),
    redactionKeys,
    providerSuggestions: [...suggestions.entries()].map(([id, keys]) => {
      const [project, provider] = id.split("\0");
      return { project, provider, evidence: [...keys].sort() };
    }),
  };
}

function walk(path: string, config: SmerConfig, depth: number, found: (path: string) => void): void {
  if (depth > 5) return;
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((entry) => entry.name));
  const isProject = names.has(".git") || names.has("package.json") || names.has("wrangler.toml") || names.has("Cargo.toml");
  if (isProject) found(realpathSync(path));

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".") || config.excludedRoots.includes(entry.name)) continue;
    walk(join(path, entry.name), config, depth + 1, found);
  }
}

function inspectProject(path: string): ProjectRecord {
  let name = basename(path);
  const keywords = new Set<string>([name]);
  const domains = new Set<string>();
  let repo: string | null = null;

  const packagePath = join(path, "package.json");
  if (existsSync(packagePath)) {
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
      if (typeof manifest.name === "string") {
        name = manifest.name.replace(/^@[^/]+\//, "");
        keywords.add(manifest.name);
        keywords.add(name);
      }
    } catch {
      // Discovery remains useful even with an invalid manifest.
    }
  }

  const remote = Bun.spawnSync(["git", "-C", path, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (remote.exitCode === 0) {
    repo = remote.stdout.toString().trim();
    const repoName = repo.match(/[/ :]([^/ :]+?)(?:\.git)?$/)?.[1];
    if (repoName) keywords.add(repoName);
  }

  const vercelPath = join(path, ".vercel", "project.json");
  if (existsSync(vercelPath)) {
    try {
      const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
      if (typeof vercel.projectName === "string") keywords.add(vercel.projectName);
    } catch {
      // Ignore incomplete Vercel metadata.
    }
  }

  const wranglerPath = join(path, "wrangler.toml");
  if (existsSync(wranglerPath)) {
    try {
      const wrangler = Bun.TOML.parse(readFileSync(wranglerPath, "utf8")) as Record<string, unknown>;
      if (typeof wrangler.name === "string") keywords.add(wrangler.name);
      const routes = Array.isArray(wrangler.routes) ? wrangler.routes : [];
      for (const route of routes) {
        const pattern = typeof route === "string" ? route : String((route as Record<string, unknown>)?.pattern || "");
        const host = pattern.replace(/^https?:\/\//, "").split("/")[0].replace(/^\*\./, "");
        if (host.includes(".")) domains.add(host);
      }
    } catch {
      // Ignore malformed provider metadata.
    }
  }

  return {
    name: slug(name),
    path,
    repo,
    domains: [...domains],
    keywords: [...keywords].filter(Boolean),
    discoveredAt: Math.floor(Date.now() / 1000),
  };
}

function envFiles(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\.env(?:\.|$)/.test(entry.name))
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

function readEnvKeyNames(path: string): string[] {
  const keys: string[] = [];
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return keys;
  }
  const chunk = Buffer.alloc(4096);
  let prefix = "";
  let discardingValue = false;
  try {
    let bytes = 0;
    while ((bytes = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      for (let index = 0; index < bytes; index += 1) {
        const byte = chunk[index];
        if (byte === 10 || byte === 13) {
          prefix = "";
          discardingValue = false;
          continue;
        }
        if (discardingValue) continue;
        if (byte === 61) {
          const match = prefix.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*$/);
          if (match && ENV_NAME.test(match[1])) keys.push(match[1].toUpperCase());
          prefix = "";
          discardingValue = true;
          continue;
        }
        if (prefix.length < 512) prefix += String.fromCharCode(byte);
      }
    }
  } finally {
    closeSync(fd);
  }
  return [...new Set(keys)];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 100) || "project";
}
