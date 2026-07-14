import { closeSync, existsSync, openSync, readFileSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SmerConfig } from "./types.ts";
import type { Store } from "./store.ts";
import { drainSpool } from "./spool.ts";
import { runDueProviders } from "./providers/index.ts";

export async function runDaemon(store: Store, config: SmerConfig): Promise<never> {
  const lockPath = join(store.home, "run", "daemon.pid");
  acquireLock(lockPath);
  let running = false;
  let queued = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let cpuSample = process.cpuUsage();
  let cpuSampleAt = performance.now();

  const cycle = async (): Promise<void> => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    const started = performance.now();
    try {
      const pausedUntil = Number(store.setting("paused_until") || 0);
      if (pausedUntil <= Math.floor(Date.now() / 1000)) {
        drainSpool(store, config);
        await runDueProviders(store, config);
      }
      store.setSetting("daemon_heartbeat", String(Math.floor(Date.now() / 1000)));
      store.setSetting("daemon_rss_bytes", String(process.memoryUsage.rss()));
      store.setSetting("daemon_cycle_ms", String(Math.round(performance.now() - started)));
      const sampledAt = performance.now();
      const elapsedMs = sampledAt - cpuSampleAt;
      if (elapsedMs >= 30_000) {
        const nextCpu = process.cpuUsage();
        const cpuMs = (nextCpu.user - cpuSample.user + nextCpu.system - cpuSample.system) / 1000;
        store.setSetting("daemon_cpu_percent", String((cpuMs / elapsedMs) * 100));
        cpuSample = nextCpu;
        cpuSampleAt = sampledAt;
      }
    } catch (error) {
      store.setSetting("daemon_error", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void cycle();
      }
    }
  };

  const watcher = watch(join(store.home, "spool"), () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void cycle(), 100);
  });
  const interval = setInterval(() => void cycle(), 60_000);

  const shutdown = (): void => {
    watcher.close();
    clearInterval(interval);
    if (debounce) clearTimeout(debounce);
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock may already be gone during shutdown.
    }
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("SIGUSR1", () => void cycle());
  await cycle();
  return await new Promise<never>(() => {});
}

function acquireLock(path: string): void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8"));
    if (pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`smer daemon is already running (pid ${pid})`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("smer daemon")) throw error;
      }
    }
    unlinkSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
}
