/**
 * results-file.ts — reads and writes docs/arena-results.json, safely.
 *
 * The arena is an overnight run, so its results file has two jobs beyond
 * holding results:
 *
 *   Survive a crash   Every run is appended and the file rewritten
 *                     immediately — to a temporary file first, then renamed
 *                     over the real one. A rename is atomic on the same
 *                     disk, so a crash mid-write leaves the old file intact,
 *                     never a half-written one. At most one run is lost.
 *
 *   Resume            On start, the arena loads the file and skips every
 *                     cell already done with the current setup hash. An
 *                     interrupted night continues where it stopped. A cell
 *                     that ended in an ERROR is retried once — and the retry
 *                     is a new record with attempt 2, so the first failure
 *                     stays visible rather than being overwritten.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ArenaFile, RunRecord } from "../../shared/arena.js";

export function loadResults(path: string): ArenaFile {
  if (!existsSync(path)) return { version: 1, meta: { ollamaVersion: "", numCtx: 0, updatedAt: "" }, records: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ArenaFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error(`${path} is not an arena results file (version 1).`);
  return parsed;
}

/** Writes the file atomically: a temp file, then a rename. */
export function saveResults(path: string, file: ArenaFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 1) + "\n");
  renameSync(tmp, path);
}

/** What resuming should do with a cell. */
export function cellStatus(records: RunRecord[], key: string): { run: boolean; attempt: number } {
  const previous = records.filter((r) => r.key === key);
  if (previous.length === 0) return { run: true, attempt: 1 };
  if (previous.some((r) => r.outcome.kind !== "error")) return { run: false, attempt: 0 };
  // Only errors so far: retry once.
  return previous.length >= 2 ? { run: false, attempt: 0 } : { run: true, attempt: previous.length + 1 };
}

/** The records that count: the latest attempt of each cell, current setup only. */
export function currentRecords(records: RunRecord[], isCurrent: (r: RunRecord) => boolean): RunRecord[] {
  const latest = new Map<string, RunRecord>();
  for (const r of records) {
    if (!isCurrent(r)) continue;
    const held = latest.get(r.key);
    if (!held || r.attempt > held.attempt) latest.set(r.key, r);
  }
  return [...latest.values()];
}
