import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ensureLayout, loadConfig, saveConfig, writePrivateFile } from "./config.ts";
import type { SmerConfig } from "./types.ts";
import type { Store } from "./store.ts";
import { AGENT_COMMANDS, CLAUDE_MD } from "./prompts.ts";
import { scanWorkspaces } from "./providers/workspace.ts";
import { importZshHistory, scanBrowsers, scanClaude, scanCodex, scanCursor, scanGit } from "./providers/local.ts";
import { scanFigma } from "./providers/figma.ts";
import { scanAssets } from "./providers/assets.ts";

const HOOK_MARKER = "# smer shell hook";
const LEGACY_HOOK_MARKER = "# smem shell hook";

export interface SetupOptions {
  devRoots?: string[];
  installShell?: boolean;
  launchd?: boolean;
  backfill?: boolean;
}

export async function setup(
  store: Store,
  options: SetupOptions = {},
): Promise<{
  home: string;
  config: string;
  launchAgent: string | null;
  shellHook: { installed: boolean; line: string };
  workspace: Awaited<ReturnType<typeof scanWorkspaces>>;
  backfill: Array<{ provider: string; inserted: number; warnings: string[] }>;
}> {
  ensureLayout(store.home);
  const config = loadConfig(store.home);
  if (options.devRoots?.length) config.devRoots = options.devRoots.map((path) => resolve(path));
  saveConfig(store.home, config);
  installAgentFiles(store.home);

  const workspace = await scanWorkspaces(store, config);
  store.setProviderState({
    id: "workspace",
    adapter: "fs-scan",
    enabled: config.enabledProviders.includes("workspace"),
    healthy: true,
    lastRun: Math.floor(Date.now() / 1000),
    cursor: null,
    error: null,
  });
  const shellHook = installShellHook(store.home, options.installShell ?? false);
  const backfill: Array<{ provider: string; inserted: number; warnings: string[] }> = [];
  if (options.backfill !== false) {
    const runs = [
      importZshHistory(store, config),
      scanGit(store, config, Math.floor(Date.now() / 1000) - 30 * 86400),
      scanClaude(store, config),
      scanCodex(store, config),
      scanCursor(store, config),
      scanFigma(store, config),
      scanAssets(store, config),
      scanBrowsers(store, config),
    ];
    const adapters: Record<string, string> = {
      shell: "hook",
      git: "log-tail",
      "claude-code": "log-tail",
      codex: "log-tail",
      cursor: "log-tail",
      figma: "json-poll",
      assets: "fs-scan",
      browser: "sqlite-tail",
    };
    for (const run of runs) {
      store.setProviderState({
        id: run.provider,
        adapter: adapters[run.provider],
        enabled: config.enabledProviders.includes(run.provider),
        healthy: run.warnings.length === 0 || run.inserted > 0,
        lastRun: Math.floor(Date.now() / 1000),
        cursor: run.cursor || null,
        error: run.warnings.length && run.inserted === 0 ? run.warnings.join("; ") : null,
      });
    }
    backfill.push(...runs.map((run) => ({ provider: run.provider, inserted: run.inserted, warnings: run.warnings })));
  }
  const launchAgent = options.launchd === false ? null : installLaunchAgent(store.home);
  return {
    home: store.home,
    config: join(store.home, "config.toml"),
    launchAgent,
    shellHook,
    workspace,
    backfill,
  };
}

export interface AgentFileInstallResult {
  mode: "linked" | "copied";
  commands: Array<{ name: string; path: string; source: string | null }>;
}

// @lat: [[architecture#System Architecture#Agent Layer]]
export function installAgentFiles(home: string, requestedSource: string | null | undefined = undefined): AgentFileInstallResult {
  writePrivateFile(join(home, "CLAUDE.md"), CLAUDE_MD);
  const commandsDir = join(home, "commands");
  mkdirSync(commandsDir, { recursive: true, mode: 0o700 });
  const sourceDir = requestedSource === null ? null : requestedSource
    ? resolveCommandSource(requestedSource)
    : discoverCommandSource();
  if (requestedSource && !sourceDir) throw new Error(`Command source does not contain the bundled prompts: ${requestedSource}`);

  if (sourceDir) {
    const commands = Object.keys(AGENT_COMMANDS).map((name) => {
      const path = join(commandsDir, name);
      const source = join(sourceDir, name);
      replaceWithSymlink(path, source);
      return { name, path, source };
    });
    return { mode: "linked", commands };
  }

  const existingLinks = linkedCommands(commandsDir);
  if (existingLinks) return { mode: "linked", commands: existingLinks };

  const commands = Object.entries(AGENT_COMMANDS).map(([name, prompt]) => {
    const path = join(commandsDir, name);
    removeFile(path);
    writePrivateFile(path, prompt);
    return { name, path, source: null };
  });
  return { mode: "copied", commands };
}

function discoverCommandSource(): string | null {
  const explicit = process.env.SMER_COMMANDS_DIR;
  if (explicit) return resolveCommandSource(explicit);
  const moduleSource = resolveCommandSource(join(import.meta.dir, "..", "commands"));
  if (moduleSource) return moduleSource;
  const manifest = join(process.cwd(), "package.json");
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    return parsed.name === "smer-cli" ? resolveCommandSource(join(process.cwd(), "commands")) : null;
  } catch {
    return null;
  }
}

function resolveCommandSource(input: string): string | null {
  for (const candidate of [resolve(input), resolve(input, "commands")]) {
    if (Object.keys(AGENT_COMMANDS).every((name) => existsSync(join(candidate, name)))) return realpathSync(candidate);
  }
  return null;
}

function linkedCommands(commandsDir: string): AgentFileInstallResult["commands"] | null {
  const commands: AgentFileInstallResult["commands"] = [];
  for (const name of Object.keys(AGENT_COMMANDS)) {
    const path = join(commandsDir, name);
    try {
      if (!lstatSync(path).isSymbolicLink() || !existsSync(path)) return null;
      commands.push({ name, path, source: realpathSync(path) });
    } catch {
      return null;
    }
  }
  return commands;
}

function replaceWithSymlink(path: string, source: string): void {
  try {
    if (lstatSync(path).isSymbolicLink() && existsSync(path) && realpathSync(path) === realpathSync(source)) return;
  } catch {
    // Missing and broken links are replaced below.
  }
  removeFile(path);
  symlinkSync(source, path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function shellHookSnippet(): string {
  return `${HOOK_MARKER}
zmodload zsh/datetime 2>/dev/null
typeset -g SMER_CMD_START=0 SMER_LAST_CMD=""
smer_preexec() {
  SMER_LAST_CMD="$1"
  SMER_CMD_START=$EPOCHREALTIME
}
smer_precmd() {
  local exit_code=$?
  [[ -z "$SMER_LAST_CMD" ]] && return
  local duration_ms=$(( (EPOCHREALTIME - SMER_CMD_START) * 1000 ))
  command smer emit --source shell --kind shell_cmd --title "$SMER_LAST_CMD" --text "$SMER_LAST_CMD" --cwd "$PWD" --exit-code "$exit_code" --duration-ms "$duration_ms" --spool >/dev/null 2>&1 &!
  SMER_LAST_CMD=""
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec smer_preexec
add-zsh-hook precmd smer_precmd`;
}

function installShellHook(home: string, install: boolean): { installed: boolean; line: string } {
  const zshrc = join(homedir(), ".zshrc");
  const sourceLine = `source ${shellQuote(join(home, "shell.zsh"))}`;
  if (!install) return { installed: false, line: sourceLine };
  const hookPath = join(home, "shell.zsh");
  writePrivateFile(hookPath, `${shellHookSnippet()}\n`);
  let current = existsSync(zshrc) ? readFileSync(zshrc, "utf8") : "";
  const legacyShellPath = join(homedir(), ".smem", "shell.zsh");
  if (current.includes(legacyShellPath) || current.includes(LEGACY_HOOK_MARKER)) {
    current = current
      .split(/\r?\n/)
      .filter((line) => !line.includes(legacyShellPath) && line.trim() !== LEGACY_HOOK_MARKER)
      .join("\n");
    writeFileSync(zshrc, `${current.replace(/\n+$/, "")}\n`, { mode: 0o600 });
  }
  if (!current.includes(sourceLine)) appendFileSync(zshrc, `\n${HOOK_MARKER}\n${sourceLine}\n`);
  return { installed: true, line: sourceLine };
}

function installLaunchAgent(home: string): string {
  const label = "dev.smer.daemon";
  const path = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  const args = daemonArguments();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>SMER_HOME</key><string>${escapeXml(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(home, "run", "daemon.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(home, "run", "daemon.error.log"))}</string>
</dict></plist>\n`;
  writeFileSync(path, plist, { mode: 0o600 });
  chmodSync(path, 0o600);
  const domain = `gui/${process.getuid?.() || 501}`;
  const legacyPath = join(homedir(), "Library", "LaunchAgents", "dev.smem.daemon.plist");
  if (existsSync(legacyPath)) {
    Bun.spawnSync(["launchctl", "bootout", domain, legacyPath], { stdout: "ignore", stderr: "ignore" });
  }
  Bun.spawnSync(["launchctl", "bootout", domain, path], { stdout: "ignore", stderr: "ignore" });
  const loaded = Bun.spawnSync(["launchctl", "bootstrap", domain, path], { stdout: "ignore", stderr: "pipe" });
  if (loaded.exitCode !== 0) throw new Error(`LaunchAgent install failed: ${loaded.stderr.toString().trim()}`);
  if (existsSync(legacyPath)) unlinkSync(legacyPath);
  return path;
}

export function installDigestAutomation(
  home: string,
  time = "18:00",
  requestedAgent?: string,
): { path: string; script: string; agent: string; time: string } {
  const match = time.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error("Digest time must use 24-hour HH:MM format");
  const agent = requestedAgent || findExecutable("claude");
  if (!agent) throw new Error("Claude CLI was not found; pass --agent-path /absolute/path/to/claude");
  installAgentFiles(home);
  const script = join(home, "run", "digest.sh");
  writePrivateFile(script, `#!/bin/zsh
set -euo pipefail
day=$(date +%F)
tmp="$SMER_HOME/digests/$day.md.tmp"
out="$SMER_HOME/digests/$day.md"
${shellQuote(agent)} -p "$(cat "$SMER_HOME/commands/digest.md")" > "$tmp"
mv "$tmp" "$out"
/usr/bin/osascript -e 'display notification "Daily work digest is ready" with title "smer"' >/dev/null 2>&1 || true
`);

  const label = "dev.smer.digest";
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  const path = join(launchAgents, `${label}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>${escapeXml(script)}</string></array>
  <key>EnvironmentVariables</key><dict><key>SMER_HOME</key><string>${escapeXml(home)}</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(match[1])}</integer><key>Minute</key><integer>${Number(match[2])}</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(home, "run", "digest.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(home, "run", "digest.error.log"))}</string>
</dict></plist>\n`;
  writeFileSync(path, plist, { mode: 0o600 });
  chmodSync(path, 0o600);
  const domain = `gui/${process.getuid?.() || 501}`;
  const legacyPath = join(launchAgents, "dev.smem.digest.plist");
  if (existsSync(legacyPath)) {
    Bun.spawnSync(["launchctl", "bootout", domain, legacyPath], { stdout: "ignore", stderr: "ignore" });
  }
  Bun.spawnSync(["launchctl", "bootout", domain, path], { stdout: "ignore", stderr: "ignore" });
  const loaded = Bun.spawnSync(["launchctl", "bootstrap", domain, path], { stdout: "ignore", stderr: "pipe" });
  if (loaded.exitCode !== 0) throw new Error(`Digest LaunchAgent install failed: ${loaded.stderr.toString().trim()}`);
  if (existsSync(legacyPath)) unlinkSync(legacyPath);
  return { path, script, agent, time: `${match[1].padStart(2, "0")}:${match[2]}` };
}

export function removeDigestAutomation(): { removed: boolean; path: string } {
  const path = join(homedir(), "Library", "LaunchAgents", "dev.smer.digest.plist");
  const domain = `gui/${process.getuid?.() || 501}`;
  const legacyPath = join(homedir(), "Library", "LaunchAgents", "dev.smem.digest.plist");
  let removed = false;
  for (const candidate of [path, legacyPath]) {
    if (!existsSync(candidate)) continue;
    Bun.spawnSync(["launchctl", "bootout", domain, candidate], { stdout: "ignore", stderr: "ignore" });
    unlinkSync(candidate);
    removed = true;
  }
  return { removed, path };
}

export function digestAutomationStatus(): { installed: boolean; path: string } {
  const path = join(homedir(), "Library", "LaunchAgents", "dev.smer.digest.plist");
  const legacyPath = join(homedir(), "Library", "LaunchAgents", "dev.smem.digest.plist");
  return existsSync(path)
    ? { installed: true, path }
    : { installed: existsSync(legacyPath), path: existsSync(legacyPath) ? legacyPath : path };
}

export function installPulseAutomation(home: string, every = "5m"): { path: string; every: string; seconds: number } {
  const seconds = parseAutomationInterval(every);
  const label = "dev.smer.pulse";
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(launchAgents, { recursive: true });
  const path = join(launchAgents, `${label}.plist`);
  const args = [...cliArguments(), "pulse", "--notify", "--quiet"];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join("")}</array>
  <key>EnvironmentVariables</key><dict><key>SMER_HOME</key><string>${escapeXml(home)}</string></dict>
  <key>StartInterval</key><integer>${seconds}</integer>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(join(home, "run", "pulse.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(home, "run", "pulse.error.log"))}</string>
</dict></plist>\n`;
  writeFileSync(path, plist, { mode: 0o600 });
  chmodSync(path, 0o600);
  const domain = `gui/${process.getuid?.() || 501}`;
  Bun.spawnSync(["launchctl", "bootout", domain, path], { stdout: "ignore", stderr: "ignore" });
  const loaded = Bun.spawnSync(["launchctl", "bootstrap", domain, path], { stdout: "ignore", stderr: "pipe" });
  if (loaded.exitCode !== 0) throw new Error(`Pulse LaunchAgent install failed: ${loaded.stderr.toString().trim()}`);
  return { path, every, seconds };
}

export function removePulseAutomation(): { removed: boolean; path: string } {
  const path = join(homedir(), "Library", "LaunchAgents", "dev.smer.pulse.plist");
  const domain = `gui/${process.getuid?.() || 501}`;
  if (!existsSync(path)) return { removed: false, path };
  Bun.spawnSync(["launchctl", "bootout", domain, path], { stdout: "ignore", stderr: "ignore" });
  unlinkSync(path);
  return { removed: true, path };
}

export function pulseAutomationStatus(): { installed: boolean; path: string } {
  const path = join(homedir(), "Library", "LaunchAgents", "dev.smer.pulse.plist");
  return { installed: existsSync(path), path };
}

function daemonArguments(): string[] {
  return [...cliArguments(), "daemon"];
}

function cliArguments(): string[] {
  const executable = process.execPath;
  if (basename(executable).startsWith("bun") && import.meta.path) return [executable, import.meta.path.replace(/setup\.ts$/, "cli.ts")];
  return [executable];
}

function parseAutomationInterval(value: string): number {
  const match = value.match(/^(\d+)(m|h)$/);
  if (!match) throw new Error("Pulse interval must use a value like 5m or 1h");
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : 60);
  if (seconds < 300) throw new Error("Pulse interval must be at least 5m");
  return seconds;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function findExecutable(name: string): string | null {
  const result = Bun.spawnSync(["which", name], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
