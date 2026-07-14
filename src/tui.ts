import type { Store } from "./store.ts";
import { recentEvents, searchEvents, type SearchResult } from "./query.ts";
import type { StoredEvent } from "./types.ts";

const ESC = "\x1b[";

export async function runTui(store: Store): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The TUI needs an interactive terminal; use smer search or smer timeline here");
  }
  let query = "";
  let results: Array<StoredEvent | SearchResult> = recentEvents(store, { limit: 100 });
  let selected = 0;

  const render = (): void => {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 30;
    const split = width >= 100 ? Math.floor(width * 0.55) : width;
    const listRows = Math.max(5, height - 5);
    const selectedEvent = results[selected];
    const lines: string[] = [];
    lines.push(`${ESC}2J${ESC}H${ESC}1;1H${ESC}7m smer ${ESC}0m  / search   arrows navigate   enter run   ctrl-o open   ctrl-c quit`);
    lines.push(`${ESC}2mquery>${ESC}0m ${query || `${ESC}2mtype an FTS5 query${ESC}0m`}`);
    lines.push(`${ESC}2m${"-".repeat(Math.max(1, width))}${ESC}0m`);

    const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), Math.max(0, results.length - listRows)));
    for (let row = 0; row < listRows; row += 1) {
      const index = start + row;
      const event = results[index];
      const left = event ? listLine(event, index === selected, split) : "";
      if (width < 100) {
        lines.push(left);
        continue;
      }
      const detail = selectedEvent ? detailLines(selectedEvent, width - split - 3)[row] || "" : "";
      lines.push(`${padAnsi(left, split)} ${ESC}2m|${ESC}0m ${detail}`);
    }
    lines.push(`${ESC}2m${results.length} result${results.length === 1 ? "" : "s"}${ESC}0m`);
    process.stdout.write(lines.join("\n"));
  };

  const cleanup = (): void => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  };

  process.stdout.write(`${ESC}?1049h${ESC}?25l`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  render();

  await new Promise<void>((resolve) => {
    const onResize = (): void => render();
    process.stdout.on("resize", onResize);
    process.stdin.on("data", (key: string) => {
      if (key === "\x03") {
        process.stdout.off("resize", onResize);
        cleanup();
        resolve();
        return;
      }
      if (key === "\x1b[A") selected = Math.max(0, selected - 1);
      else if (key === "\x1b[B") selected = Math.min(Math.max(0, results.length - 1), selected + 1);
      else if (key === "\r" || key === "\n") {
        try {
          results = query.trim() ? searchEvents(store, query.trim(), { limit: 100 }) : recentEvents(store, { limit: 100 });
          selected = 0;
        } catch {
          // Keep the query visible so the user can fix invalid FTS syntax.
        }
      } else if (key === "\x7f") query = query.slice(0, -1);
      else if (key === "\x1b") query = "";
      else if (key === "\x0f") openEvent(results[selected]);
      else if (!key.startsWith("\x1b") && key >= " ") query += key;
      render();
    });
  });
}

function listLine(event: StoredEvent, selected: boolean, width: number): string {
  const time = new Date(event.ts * 1000).toLocaleString(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const project = event.project || "-";
  const prefix = `${time}  ${project.padEnd(14).slice(0, 14)}  `;
  const title = truncate(event.title || event.text, Math.max(8, width - visibleLength(prefix) - 2));
  return `${selected ? `${ESC}7m` : ""} ${prefix}${title}${selected ? `${ESC}0m` : ""}`;
}

function detailLines(event: StoredEvent, width: number): string[] {
  const fields = [
    `${ESC}1m#${event.id} ${event.title}${ESC}0m`,
    `${new Date(event.ts * 1000).toLocaleString()}  ${event.source}/${event.kind}`,
    event.project ? `project: ${event.project}` : "project: unattributed",
    "",
    ...wrap(stripAnsi(event.text), width),
    "",
    ...wrap(JSON.stringify(event.meta, null, 2), width).map((line) => `${ESC}2m${line}${ESC}0m`),
  ];
  return fields;
}

function openEvent(event: StoredEvent | undefined): void {
  if (!event) return;
  const candidate = typeof event.meta.url === "string"
    ? event.meta.url
    : typeof event.meta.jsonl_path === "string"
      ? event.meta.jsonl_path
      : event.text.match(/https?:\/\/[^\s]+/)?.[0];
  if (candidate) Bun.spawn(["open", candidate], { stdout: "ignore", stderr: "ignore" });
}

function wrap(value: string, width: number): string[] {
  const output: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = paragraph;
    while (line.length > width) {
      const cut = Math.max(1, line.lastIndexOf(" ", width));
      output.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }
    output.push(line);
  }
  return output;
}

function truncate(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ");
  return clean.length > width ? `${clean.slice(0, Math.max(1, width - 3))}...` : clean;
}

function padAnsi(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleLength(value)))}`;
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
