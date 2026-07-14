import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { SmerConfig } from "../types.ts";
import type { Store } from "../store.ts";
import { contentHash, ingestEvent } from "../events.ts";
import type { ProviderRunResult } from "./local.ts";

const ASSET_EXTENSIONS = new Set([".avif", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);

// @lat: [[architecture#System Architecture#Provider System]]
export function scanAssets(
  store: Store,
  config: SmerConfig,
  since?: number,
  candidatePaths?: string[],
): ProviderRunResult {
  const result: ProviderRunResult = { provider: "assets", scanned: 0, inserted: 0, duplicates: 0, warnings: [] };
  const now = Math.floor(Date.now() / 1000);
  const previous = Number(store.providerState("assets")?.cursor || 0);
  const windowStart = since ?? (previous ? Math.max(0, previous - 60) : now - 86400);
  const paths = candidatePaths || discoverRecentAssets(assetRoots(config), windowStart, config.excludedRoots, result.warnings);

  for (const rawPath of [...new Set(paths)]) {
    const path = resolve(rawPath);
    const extension = extname(path).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension) || isExcluded(path, config.excludedRoots)) continue;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const modifiedAt = Math.floor(stat.mtimeMs / 1000);
    if (modifiedAt < windowStart || modifiedAt > now + 300) continue;

    result.scanned += 1;
    const dimensions = imageDimensions(path);
    const displayName = basename(path).replaceAll("@", " at ");
    const inserted = ingestEvent(
      store,
      config,
      {
        ts: modifiedAt,
        source: "assets",
        kind: "x-asset-save",
        project: null,
        title: `Saved asset: ${displayName}`.slice(0, 240),
        text: `${displayName}\nLocal asset saved\n${dirname(path)}`,
        meta: {
          cwd: dirname(path),
          path,
          extension,
          bytes: stat.size,
          width: dimensions.width,
          height: dimensions.height,
          content_captured: false,
          activity_basis: "filesystem-mtime",
        },
      },
      { contentHash: contentHash("asset-save", `${path}:${stat.mtimeMs}:${stat.size}`), upsert: true },
    );
    if (inserted.duplicate) result.duplicates += 1;
    else result.inserted += 1;
  }

  result.cursor = String(now);
  return result;
}

function assetRoots(config: SmerConfig): string[] {
  return [...new Set(config.devRoots)].filter(existsSync);
}

function discoverRecentAssets(roots: string[], since: number, excluded: string[], warnings: string[]): string[] {
  if (process.platform === "darwin") {
    const iso = new Date(since * 1000).toISOString();
    const query = `kMDItemFSContentChangeDate >= $time.iso(${iso}) && kMDItemContentTypeTree == "public.image"c`;
    const paths: string[] = [];
    for (const root of roots) {
      const scan = Bun.spawnSync(["mdfind", "-onlyin", root, query], { stdout: "pipe", stderr: "pipe" });
      if (scan.exitCode !== 0) {
        warnings.push(`Spotlight asset scan failed for ${root}: ${scan.stderr.toString().trim()}`);
        continue;
      }
      paths.push(...scan.stdout.toString().split("\n").filter(Boolean));
    }
    return paths.filter((path) => !isExcluded(path, excluded));
  }
  return roots.flatMap((root) => walkRecentAssets(root, since, excluded));
}

function walkRecentAssets(root: string, since: number, excluded: string[]): string[] {
  const output: string[] = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop()!;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isExcluded(path, excluded)) queue.push(path);
      } else if (entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        try {
          if (statSync(path).mtimeMs / 1000 >= since) output.push(path);
        } catch {
          // The file may disappear while scanning.
        }
      }
    }
  }
  return output;
}

function imageDimensions(path: string): { width: number | null; height: number | null } {
  if (process.platform !== "darwin") return { width: null, height: null };
  const result = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return { width: null, height: null };
  const output = result.stdout.toString();
  return {
    width: Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]) || null,
    height: Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]) || null,
  };
}

function isExcluded(path: string, excluded: string[]): boolean {
  const segments = path.split("/");
  return excluded.some((name) => segments.includes(name));
}
