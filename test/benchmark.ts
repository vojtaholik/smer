import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { searchEvents } from "../src/query.ts";

const home = mkdtempSync(join(tmpdir(), "smer-benchmark-"));
const store = new Store(home);
const now = Math.floor(Date.now() / 1000);
const insert = store.db.query(`
  INSERT INTO events(ts, source, kind, project, title, text, meta)
  VALUES (?, 'shell', 'shell_cmd', ?, ?, ?, '{}')
`);
const load = store.db.transaction(() => {
  for (let index = 0; index < 100_000; index += 1) {
    insert.run(now - index, `project-${index % 8}`, `build ${index}`, `deploy failed build needle${index % 100}`);
  }
});

const loadStarted = performance.now();
load();
const loadMs = performance.now() - loadStarted;
searchEvents(store, "needle42", { limit: 25 });
const samples: number[] = [];
for (let index = 0; index < 20; index += 1) {
  const started = performance.now();
  searchEvents(store, "needle42", { limit: 25 });
  samples.push(performance.now() - started);
}
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
console.log(JSON.stringify({ events: 100_000, loadMs: Math.round(loadMs), searchP50Ms: Number(p50.toFixed(2)), searchP95Ms: Number(p95.toFixed(2)), budgetMs: 100, pass: p95 < 100 }, null, 2));
store.close();
rmSync(home, { recursive: true, force: true });
if (p95 >= 100) process.exit(1);
