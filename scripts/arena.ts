/**
 * arena.ts — the whole matrix: attacks and benign tickets × defense stacks × models × seeds.
 *
 * Run it with:  npm run arena                              (the default matrix)
 *               npm run arena -- --models llama3.2:3b      (one model — a night's half)
 *               npm run arena -- --seeds 2,3 --stacks none,everything   (the variance pass)
 *               npm run arena -- --quick                   (about 4 minutes; a scratch file)
 *               npm run arena -- --report-only             (rebuild the markdown)
 *
 * Every run goes through the real pipeline (`runTicket`), the real tool
 * server over MCP and the real local model — the same code the UI runs —
 * and is scored by code (server/scoring/). Nothing is mocked.
 *
 * ---------------------------------------------------------------------------
 * The matrix, and the order it runs in
 * ---------------------------------------------------------------------------
 *
 * Items: the 25 attacks and the 15 benign tickets. Stacks: the ten named
 * stacks (server/defenses/settings.ts). Models: both. Seeds: 1 by default.
 *
 * MODEL-OUTERMOST. On this machine's 4 GB GPU only one model stays loaded,
 * and switching costs a 5–8 s reload (measured in step 0). Finishing one
 * model's cells before starting the other's means one switch per night,
 * not one per run.
 *
 * ---------------------------------------------------------------------------
 * Overnight-safe
 * ---------------------------------------------------------------------------
 *
 * Results are appended to docs/arena-results.json after EVERY run, written
 * atomically (results-file.ts). Restarting resumes: cells already done
 * under the current setup hash are skipped; an error is retried once. A
 * cell's key includes the setup hash (setup-hash.ts), so editing a prompt,
 * a tool description, an attack or a scoring rule makes earlier results
 * STALE rather than mixing two experiments — the rule that prompts and
 * checks are fixed before a run and never tuned afterward, enforced.
 *
 * Seeds are fixed (1, 2, 3…) at the model's default temperature: a rerun
 * reproduces the same results, and different seeds show how much a model
 * varies. Reasoning is off throughout (decision 13). Confirmation requests
 * from the tool server are declined, as a cautious person would; the
 * record says so.
 *
 * Flags: --models a,b · --stacks s,t · --attacks id,id · --benign B01,B02 ·
 * --seeds 1,2,3 or --seeds 3 (meaning 1–3) · --quick · --fresh (start a new
 * results file; the old one is kept as .bak) · --report-only.
 */

import "dotenv/config";
import { copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ArenaFile } from "../shared/arena.js";
import { ticketFacts } from "../server/attacks/facts.js";
import { prepareAttack } from "../server/attacks/insert.js";
import { LibraryError, loadAttacks, loadBenign, type BenignTicket } from "../server/attacks/load.js";
import type { Attack } from "../server/attacks/schema.js";
import { toRecord } from "../server/arena/record.js";
import { buildReport } from "../server/arena/report.js";
import { cellStatus, currentRecords, loadResults, saveResults } from "../server/arena/results-file.js";
import { itemSetupHash } from "../server/arena/setup-hash.js";
import { STACKS, stackSettings } from "../server/defenses/settings.js";
import { Logger } from "../server/logger.js";
import { ToolServerClient } from "../server/mcp/client.js";
import { COMPARED_MODELS, listModels, ollamaConfig, ollamaVersion } from "../server/model/ollama.js";
import { runTicket } from "../server/pipeline/run.js";
import { scoreAttack, scoreBenign } from "../server/scoring/outcome.js";
import { writeFileSync } from "node:fs";

const RESULTS = fileURLToPath(new URL("../docs/arena-results.json", import.meta.url));
const REPORT = fileURLToPath(new URL("../docs/arena-results.md", import.meta.url));
const QUICK_RESULTS = fileURLToPath(new URL("../.arena/quick-results.json", import.meta.url));

// --- Flags -------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (name: string): string[] | undefined => flag(name)?.split(",").map((s) => s.trim()).filter(Boolean);

const quick = argv.includes("--quick");

/**
 * --quick: one model, the two ends of the stack list, one item per
 * mechanism, three benign tickets, one seed — 16 runs, about ten minutes.
 * A check that the arena works, written to a scratch file, never to the
 * published results.
 */
const QUICK = {
  models: ["llama3.2:3b"],
  stacks: ["none", "everything"],
  attacks: ["direct-ignore-previous", "email-html-white-text", "tool-order-fake-system", "multi-turn-new-address", "obf-zero-width"],
  benign: ["B01", "B08", "B14"],
};

function parseSeeds(raw: string | undefined): number[] {
  if (!raw) return [1];
  if (/^\d+$/.test(raw)) return Array.from({ length: Number(raw) }, (_, i) => i + 1);
  return raw.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// --- Run --------------------------------------------------------------------------------

/** One item of the matrix: an attack (with its base ticket) or a benign ticket. */
interface Item { kind: "attack" | "benign"; id: string; attack?: Attack; base: BenignTicket; files: string[] }

function writeReport(file: ArenaFile, items: Item[]): void {
  // Current = the record's setup hash matches what that item hashes to NOW.
  const hashes = new Map(items.map((i) => [i.id, itemSetupHash(i.files)]));
  const current = currentRecords(file.records, (r) => hashes.get(r.itemId) === r.setupHash);
  const staleCount = file.records.filter((r) => hashes.get(r.itemId) !== r.setupHash).length;
  writeFileSync(REPORT, buildReport({ file, current, staleCount }) + "\n");
  console.log(`Wrote docs/arena-results.md (${current.length} runs counted, ${staleCount} stale).`);
}

async function main(): Promise<void> {
  let attacks: Attack[];
  try {
    attacks = loadAttacks();
  } catch (error: unknown) {
    if (error instanceof LibraryError) { console.error(error.message); process.exit(1); }
    throw error;
  }
  const benign = loadBenign();
  const allItems: Item[] = [
    ...attacks.map((a) => {
      const base = benign.get(a.baseTicket) as BenignTicket;
      return { kind: "attack" as const, id: a.id, attack: a, base, files: [`attacks/${a.id}.json`, `attacks/benign/${base.id}-${base.slug}.json`] };
    }),
    ...[...benign.values()].map((b) => ({ kind: "benign" as const, id: b.id, base: b, files: [`attacks/benign/${b.id}-${b.slug}.json`] })),
  ];

  const resultsPath = quick ? QUICK_RESULTS : RESULTS;

  if (argv.includes("--report-only")) {
    writeReport(loadResults(RESULTS), allItems);
    return;
  }

  if (argv.includes("--fresh") && existsSync(resultsPath)) {
    copyFileSync(resultsPath, `${resultsPath}.bak`);
    saveResults(resultsPath, { version: 1, meta: { ollamaVersion: "", numCtx: 0, updatedAt: "" }, records: [] });
    console.log(`Started a fresh results file; the old one is ${resultsPath}.bak`);
  }

  const models = quick ? QUICK.models : (list("--models") ?? [...COMPARED_MODELS]);
  const stacks = quick ? QUICK.stacks : (list("--stacks") ?? Object.keys(STACKS));
  const attackIds = quick ? QUICK.attacks : list("--attacks");
  const benignIds = quick ? QUICK.benign : list("--benign");
  const seeds = quick ? [1] : parseSeeds(flag("--seeds"));
  const onlyAttacks = list("--attacks") !== undefined && list("--benign") === undefined && !quick;
  const onlyBenign = list("--benign") !== undefined && list("--attacks") === undefined && !quick;

  const items = allItems.filter((i) =>
    i.kind === "attack" ? !onlyBenign && (!attackIds || attackIds.includes(i.id)) : !onlyAttacks && (!benignIds || benignIds.includes(i.id)));

  for (const s of stacks) if (!STACKS[s]) { console.error(`No stack "${s}". Stacks: ${Object.keys(STACKS).join(", ")}`); process.exit(1); }
  const installed = await listModels();
  for (const m of models) if (!installed.some((x) => x.name === m)) { console.error(`${m} is not installed. Run: ollama pull ${m}`); process.exit(1); }

  const file = loadResults(resultsPath);
  file.meta = { ollamaVersion: await ollamaVersion(), numCtx: ollamaConfig().numCtx, updatedAt: new Date().toISOString() };

  const cells = models.flatMap((model) => seeds.flatMap((seed) => stacks.flatMap((stack) => items.map((item) => ({ model, seed, stack, item })))));
  const digests = new Map(installed.map((m) => [m.name, m.digest]));
  const todo = cells.map((c) => {
    const setupHash = itemSetupHash(c.item.files);
    const key = [c.item.id, c.stack, c.model, digests.get(c.model) ?? "", c.seed, setupHash].join("|");
    return { ...c, setupHash, key, ...cellStatus(file.records, key) };
  }).filter((c) => c.run);

  console.log(`\nArena${quick ? " (quick — scratch results)" : ""}: ${cells.length} cells · ${cells.length - todo.length} already done · ${todo.length} to run`);
  console.log(`models ${models.join(", ")} · stacks ${stacks.length} · items ${items.length} · seeds ${seeds.join(",")}\n`);

  const tools = new ToolServerClient((line) => {
    if (!/ExperimentalWarning|trace-warnings|serving six tools|unrequested confirmation/.test(line)) console.error(`      [tool server] ${line}`);
  });
  const quiet = new Logger(() => {});
  const started = Date.now();
  const factsCache = new Map<string, Awaited<ReturnType<typeof ticketFacts>>>();

  for (const [n, c] of todo.entries()) {
    const settings = stackSettings(c.stack);
    if (!settings) continue;
    const expected = [c.item.base.expect, ...(c.item.base.alternatives ?? [])];
    let facts = factsCache.get(c.item.base.id);
    if (!facts) { facts = await ticketFacts(tools, c.item.base); factsCache.set(c.item.base.id, facts); }
    const prep = c.item.attack ? prepareAttack(c.item.attack, facts) : undefined;
    const startedAt = new Date().toISOString();

    const r = await runTicket({
      ticketId: c.item.base.ticket, model: c.model, defenses: settings, reasoning: false, seed: c.seed,
      overlays: prep?.overlays ?? [],
      ...(prep?.chatMessage !== undefined ? { chatMessage: prep.chatMessage } : {}),
      ...(prep && prep.followUps.length > 0 ? { followUps: prep.followUps } : {}),
    }, { logger: quiet, emit: () => {}, tools });

    const scored = c.item.attack && prep ? scoreAttack(r, c.item.attack.goal, expected, prep.vars) : scoreBenign(r, expected);
    file.records.push(toRecord(c.item, r, scored, {
      key: c.key, stack: c.stack, digest: digests.get(c.model) ?? "", seed: c.seed, setupHash: c.setupHash, attempt: c.attempt, startedAt,
    }));
    file.meta.updatedAt = new Date().toISOString();
    saveResults(resultsPath, file);

    const done = n + 1;
    const avg = (Date.now() - started) / done;
    const eta = new Date(Date.now() + avg * (todo.length - done));
    console.log(`[${done}/${todo.length}] ${c.model} · ${c.stack} · ${c.item.id} · seed ${c.seed} → ${scored.outcome.kind}` +
      ` (${(r.elapsedMs / 1000).toFixed(0)} s)${done < todo.length ? ` · ETA ${eta.toLocaleTimeString()}` : ""}`);
  }
  await tools.close();

  const minutes = (Date.now() - started) / 60000;
  console.log(`\n${todo.length} runs in ${minutes.toFixed(1)} min (${todo.length > 0 ? ((minutes * 60) / todo.length).toFixed(0) : 0} s per run).`);
  if (!quick) writeReport(file, allItems);
}

await main();
