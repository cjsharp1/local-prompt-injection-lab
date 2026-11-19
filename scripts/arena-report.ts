/**
 * arena-report.ts — rebuilds docs/arena-results.md from docs/arena-results.json.
 *
 * Run it with:  npm run arena:report
 *
 * The arena writes the report at the end of every run of the matrix;
 * this rebuilds it without running anything — after a change to the
 * report's layout, say, or to recount which records are stale after a
 * setup change. It is the same as `npm run arena -- --report-only`, kept
 * as its own script so the README can name it plainly.
 *
 * The markdown is generated, never hand-edited. Its numbers come from the
 * JSON, and the JSON's come from runs.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const arena = fileURLToPath(new URL("./arena.ts", import.meta.url));
const result = spawnSync(process.execPath, ["--import", "tsx", arena, "--report-only"], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
