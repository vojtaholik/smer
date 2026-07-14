import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SmerConfig } from "./types.ts";

export const DEFAULT_BROWSER_DENYLIST = [
  "1password.com",
  "bitwarden.com",
  "chase.com",
  "health.google.com",
  "mychart.com",
  "paypal.com",
  "wise.com",
];

export const DEFAULT_PROVIDERS = [
  "workspace",
  "shell",
  "git",
  "claude-code",
  "codex",
  "cursor",
  "figma",
  "browser",
];

export function defaultHome(): string {
  const explicit = process.env.SMER_HOME || process.env.SMEM_HOME;
  if (explicit) return resolve(explicit);
  const current = join(homedir(), ".smer");
  const legacy = join(homedir(), ".smem");
  return resolve(!existsSync(current) && existsSync(legacy) ? legacy : current);
}

export function defaultConfig(): SmerConfig {
  return {
    devRoots: [join(homedir(), "Developer")],
    browserDenylist: DEFAULT_BROWSER_DENYLIST,
    excludedRoots: ["node_modules", ".next", ".turbo", "dist", "build", "Library"],
    emailAllowlist: [],
    enabledProviders: DEFAULT_PROVIDERS,
    providerIntervals: {
      workspace: 900,
      git: 60,
      "claude-code": 60,
      codex: 60,
      cursor: 60,
      chatgpt: 600,
      figma: 60,
      browser: 60,
      vercel: 600,
      github: 600,
      inngest: 600,
      fal: 600,
      slack: 600,
    },
    cloud: {},
  };
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // A read-only filesystem will fail later with a more useful error.
  }
}

export function ensureLayout(home: string): void {
  ensurePrivateDir(home);
  for (const dir of ["spool", "spool/rejected", "providers", "commands", "digests", "imports/chatgpt", "cache", "run"]) {
    ensurePrivateDir(join(home, dir));
  }
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}

export function loadConfig(home: string): SmerConfig {
  const defaults = defaultConfig();
  const path = join(home, "config.toml");
  if (!existsSync(path)) return defaults;

  try {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const intervals = (parsed.intervals || {}) as Record<string, unknown>;
    const cloud = (parsed.cloud || {}) as SmerConfig["cloud"];
    return {
      devRoots: stringArray(parsed.dev_roots, defaults.devRoots).map(expandPath),
      browserDenylist: stringArray(parsed.browser_denylist, defaults.browserDenylist),
      excludedRoots: stringArray(parsed.excluded_roots, defaults.excludedRoots),
      emailAllowlist: stringArray(parsed.email_allowlist, defaults.emailAllowlist),
      enabledProviders: stringArray(parsed.enabled_providers, defaults.enabledProviders),
      providerIntervals: {
        ...defaults.providerIntervals,
        ...Object.fromEntries(
          Object.entries(intervals)
            .filter(([, value]) => typeof value === "number" && value >= 60)
            .map(([key, value]) => [key, Number(value)]),
        ),
      },
      cloud: typeof cloud === "object" && cloud ? cloud : {},
    };
  } catch (error) {
    throw new Error(`Invalid config.toml: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

export function saveConfig(home: string, config: SmerConfig): void {
  ensureLayout(home);
  const lines = [
    `dev_roots = ${tomlArray(config.devRoots)}`,
    `browser_denylist = ${tomlArray(config.browserDenylist)}`,
    `excluded_roots = ${tomlArray(config.excludedRoots)}`,
    `email_allowlist = ${tomlArray(config.emailAllowlist)}`,
    `enabled_providers = ${tomlArray(config.enabledProviders)}`,
    "",
    "[intervals]",
    ...Object.entries(config.providerIntervals).map(([key, value]) => `${JSON.stringify(key)} = ${value}`),
  ];

  for (const [id, values] of Object.entries(config.cloud)) {
    lines.push("", `[cloud.${JSON.stringify(id)}]`);
    for (const [key, value] of Object.entries(values)) {
      lines.push(`${key} = ${typeof value === "string" ? tomlString(value) : String(value)}`);
    }
  }

  const path = join(home, "config.toml");
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function writePrivateFile(path: string, contents: string): void {
  ensurePrivateDir(dirname(path));
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}
