import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SmerConfig } from "./types.ts";
import type { Store } from "./store.ts";
import { codexPermissionWarnings } from "./providers/local.ts";
import { listProviders } from "./providers/index.ts";

export interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  message: string;
  details?: unknown;
}

export function doctor(store: Store, config: SmerConfig): { healthy: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  const mode = statSync(store.home).mode & 0o777;
  checks.push({
    id: "home-permissions",
    status: mode === 0o700 ? "ok" : "fail",
    message: mode === 0o700 ? `${store.home} is private (700)` : `${store.home} permissions are ${mode.toString(8)}; expected 700`,
  });

  const integrity = store.db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  checks.push({
    id: "database-integrity",
    status: integrity.integrity_check === "ok" ? "ok" : "fail",
    message: `SQLite integrity: ${integrity.integrity_check}`,
  });
  const modeRow = store.db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  checks.push({
    id: "wal",
    status: modeRow.journal_mode.toLowerCase() === "wal" ? "ok" : "fail",
    message: `Journal mode: ${modeRow.journal_mode}`,
  });

  const events = store.db.query("SELECT count(*) AS count FROM events").get() as { count: number };
  const fts = store.db.query("SELECT count(*) AS count FROM events_fts").get() as { count: number };
  checks.push({
    id: "fts",
    status: Number(events.count) === Number(fts.count) ? "ok" : "fail",
    message: `FTS index has ${fts.count} of ${events.count} events`,
  });

  const spool = readdirSync(join(store.home, "spool")).filter((file) => file.endsWith(".jsonl"));
  checks.push({
    id: "spool",
    status: spool.length > 100 ? "warn" : "ok",
    message: `${spool.length} spool file${spool.length === 1 ? "" : "s"} pending`,
  });
  const rejectedDir = join(store.home, "spool", "rejected");
  const rejectedFiles = existsSync(rejectedDir)
    ? readdirSync(rejectedDir).filter((file) => file.endsWith(".jsonl"))
    : [];
  checks.push({
    id: "rejected-events",
    status: rejectedFiles.length ? "warn" : "ok",
    message: rejectedFiles.length
      ? `${rejectedFiles.length} rejected spool file(s) need review in ${rejectedDir}`
      : "No rejected spool events",
  });

  const shellPath = join(store.home, "shell.zsh");
  const zshrc = join(homedir(), ".zshrc");
  const shellInstalled = existsSync(shellPath) && existsSync(zshrc) && readFileSync(zshrc, "utf8").includes(shellPath);
  checks.push({
    id: "shell-hook",
    status: shellInstalled ? "ok" : "warn",
    message: shellInstalled ? "zsh hook is installed" : "zsh hook is not installed; run smer setup --install-shell",
  });

  const heartbeat = Number(store.setting("daemon_heartbeat") || 0);
  const age = Math.floor(Date.now() / 1000) - heartbeat;
  checks.push({
    id: "daemon",
    status: heartbeat && age < 180 ? "ok" : "warn",
    message: heartbeat ? `Last daemon heartbeat ${age}s ago` : "No daemon heartbeat recorded",
  });

  const rss = Number(store.setting("daemon_rss_bytes") || 0);
  checks.push({
    id: "memory-budget",
    status: !rss || rss < 100 * 1024 * 1024 ? "ok" : "fail",
    message: rss ? `Daemon RSS ${(rss / 1024 / 1024).toFixed(1)} MB (budget <100 MB)` : "Daemon memory has not been sampled yet",
  });

  const cpu = Number(store.setting("daemon_cpu_percent") || 0);
  checks.push({
    id: "cpu-budget",
    status: !cpu || cpu < 0.3 ? "ok" : "fail",
    message: cpu ? `Daemon CPU ${cpu.toFixed(3)}% (budget <0.3%)` : "Daemon CPU has not completed a 30s sample yet",
  });

  const dailyBytes = store.db
    .query("SELECT COALESCE(sum(length(title)+length(text)+length(meta)+128), 0) AS bytes FROM events WHERE ts >= ?")
    .get(Math.floor(Date.now() / 1000) - 86400) as { bytes: number };
  checks.push({
    id: "write-budget",
    status: Number(dailyBytes.bytes) < 20 * 1024 * 1024 ? "ok" : "fail",
    message: `Approximate event data written in 24h: ${(Number(dailyBytes.bytes) / 1024 / 1024).toFixed(2)} MB (budget <20 MB)`,
  });

  const providerChecks = listProviders(store, config).filter((provider) => provider.enabled);
  const unhealthy = providerChecks.filter((provider) => !provider.healthy);
  const neverRun = providerChecks.filter((provider) => !provider.lastRun && !["shell", "chatgpt"].includes(provider.id));
  checks.push({
    id: "providers",
    status: unhealthy.length ? "fail" : neverRun.length ? "warn" : "ok",
    message: unhealthy.length
      ? `${unhealthy.length} enabled provider(s) unhealthy`
      : neverRun.length
        ? `${neverRun.length} enabled provider(s) have not completed a run yet`
        : `${providerChecks.length} enabled provider(s) healthy`,
    details: [
      ...unhealthy.map((provider) => ({ id: provider.id, error: provider.error })),
      ...neverRun.map((provider) => ({ id: provider.id, status: "never-run" })),
    ],
  });

  const permissions = codexPermissionWarnings();
  checks.push({
    id: "codex-permissions",
    status: permissions.length ? "warn" : "ok",
    message: permissions.length ? `${permissions.length} Codex session permission warning(s)` : "Codex session permissions look private",
    details: permissions,
  });

  const configSecrets = findLikelySecrets(join(store.home, "config.toml"));
  checks.push({
    id: "config-secrets",
    status: configSecrets.length ? "fail" : "ok",
    message: configSecrets.length ? "Possible secret values found in config.toml" : "No obvious secret values found in config.toml",
    details: configSecrets,
  });

  return { healthy: !checks.some((check) => check.status === "fail"), checks };
}

function findLikelySecrets(path: string): string[] {
  if (!existsSync(path)) return [];
  const findings: string[] = [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:token|api_key|secret|password)\s*=\s*"(?!(?:smer|smem)-)[^"]{8,}"/i.test(line)) findings.push(`line ${index + 1}`);
  }
  return findings;
}
