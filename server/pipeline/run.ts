/**
 * run.ts — one ticket through the lab: THE entry point.
 *
 * Everything that handles a ticket calls `runTicket()`: the UI when you
 * press Run, `npm run attack` in the terminal, the arena overnight, the
 * model eval. One entry point means one pipeline — a result in the arena
 * file was produced by exactly the code the UI shows you running.
 *
 * It chooses the pipeline's SHAPE:
 *
 *   direct.ts     the normal shape: the model that calls tools reads the
 *                 ticket and every tool result directly (fenced and
 *                 classified, if those layers are on)
 *   separated.ts  privilege separation (layer 6): a quarantined call reads
 *                 the untrusted text and returns fixed-schema facts; the
 *                 model with tools never sees the raw text
 *
 * Layer 6 is a choice between shapes rather than a filter inside one,
 * which is why it is decided here and not in the defence registry. The
 * shared machinery — ticket loading, tool calls, reply, delivery — is in
 * run-context.ts, so the two shapes differ only where they must.
 */

import { runDirect } from "./direct.js";
import { runSeparated } from "./separated.js";
import type { RunDeps, RunRequest, RunResult } from "./types.js";

export type { RunDeps, RunRequest, RunResult, ToolCallRecord, ToolSource } from "./types.js";

export async function runTicket(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  return request.defenses["privilege-separation"] ? runSeparated(request, deps) : runDirect(request, deps);
}
