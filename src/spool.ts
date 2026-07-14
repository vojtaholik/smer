import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SmerConfig, EventEnvelope } from "./types.ts";
import type { Store } from "./store.ts";
import { ingestEvent } from "./events.ts";
import { writePrivateFile } from "./config.ts";

export function spoolEvent(home: string, event: EventEnvelope): string {
  const path = join(home, "spool", `${Date.now()}-${process.pid}-${randomUUID()}.jsonl`);
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
  notifyDaemon(home);
  return path;
}

function notifyDaemon(home: string): void {
  const pidPath = join(home, "run", "daemon.pid");
  if (!existsSync(pidPath)) return;
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    if (pid) process.kill(pid, "SIGUSR1");
  } catch {
    // A missing or stale daemon is fine; the event remains crash-safe in spool.
  }
}

export function drainSpool(store: Store, config: SmerConfig): {
  files: number;
  inserted: number;
  duplicates: number;
  rejected: Array<{ file: string; line: number; error: string }>;
} {
  const dir = join(store.home, "spool");
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".jsonl") || file.endsWith(".jsonl.processing"))
    .sort();
  let inserted = 0;
  let duplicates = 0;
  const rejected: Array<{ file: string; line: number; error: string }> = [];

  for (const file of files) {
    const sourcePath = join(dir, file);
    const processingPath = file.endsWith(".processing") ? sourcePath : `${sourcePath}.processing`;
    const originalName = file.replace(/\.processing$/, "");
    if (!existsSync(sourcePath)) continue;
    if (processingPath !== sourcePath) renameSync(sourcePath, processingPath);
    const lines = readFileSync(processingPath, "utf8").split(/\r?\n/).filter(Boolean);
    const fileRejected: Array<{ line: number; error: string; raw: string }> = [];
    const ingestFile = store.db.transaction(() => {
      for (let index = 0; index < lines.length; index += 1) {
        try {
          const result = ingestEvent(store, config, JSON.parse(lines[index]));
          if (result.duplicate) duplicates += 1;
          else inserted += 1;
        } catch (error) {
          rejected.push({
            file: originalName,
            line: index + 1,
            error: error instanceof Error ? error.message : String(error),
          });
          fileRejected.push({
            line: index + 1,
            error: error instanceof Error ? error.message : String(error),
            raw: lines[index],
          });
        }
      }
    });
    ingestFile();
    if (fileRejected.length) {
      const rejectedDir = join(dir, "rejected");
      writePrivateFile(join(rejectedDir, originalName), `${fileRejected.map((item) => item.raw).join("\n")}\n`);
      writePrivateFile(
        join(rejectedDir, `${originalName}.errors.json`),
        `${JSON.stringify(fileRejected.map(({ line, error }) => ({ line, error })), null, 2)}\n`,
      );
    }
    unlinkSync(processingPath);
  }
  return { files: files.length, inserted, duplicates, rejected };
}
