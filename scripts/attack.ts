/**
 * attack.ts — one ticket through the whole lab, in the terminal.
 *
 * Run it with:  npm run attack -- direct-ignore-previous
 *               npm run attack -- tool-order-fake-system --model llama3.2:3b --verbose
 *               npm run attack -- --benign B01
 *               npm run attack -- --benign B15 --confirm ask
 *
 * The same pipeline the UI runs (`runTicket`), the real tool server over
 * MCP, the real local model — with the activity log printed as it
 * happens, one row per line, and the run's result at the end. It is the
 * fastest way to see a run end to end, and the first place to debug one:
 * no browser, no server, just the rows.
 *
 * Flags:
 *
 *   <attack-id>      run one attack from attacks/ (the file name, without .json)
 *   --benign B01     or run one benign ticket (attacks/benign/B01-*.json)
 *   --model NAME     a local model (default: MODEL from .env)
 *   --reasoning      let the model reason first (only models that can)
 *   --verbose        print each row's full detail, not just its label
 *   --confirm MODE   how to answer the tool server's confirmation requests:
 *                    "decline" (the default, as the arena does) or "ask"
 *                    (a y/n prompt here in the terminal)
 *
 * --stack arrives with the defences (build step 8). The outcome is
 * decided by the same scorer the arena uses (server/scoring/), never by a
 * model — and the evidence it found is printed with it.
 */

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import type { LogEvent } from "../shared/types.js";
import { ticketFacts } from "../server/attacks/facts.js";
import { prepareAttack, type PreparedAttack } from "../server/attacks/insert.js";
import { LibraryError, loadAttacks, loadBenign } from "../server/attacks/load.js";
import { NO_DEFENSES } from "../server/defenses/settings.js";
import { Logger } from "../server/logger.js";
import { ToolServerClient, type Confirmer } from "../server/mcp/client.js";
import { listModels, ollamaConfig } from "../server/model/ollama.js";
import { runTicket } from "../server/pipeline/run.js";
import { scoreAttack, scoreBenign } from "../server/scoring/outcome.js";

// --- Flags ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const benignId = flag("--benign");
/** The first argument that is not a flag or a flag's value. */
const attackId = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--benign", "--model", "--confirm"].includes(argv[i - 1] ?? "")));
const model = flag("--model") ?? ollamaConfig().model;
const reasoning = argv.includes("--reasoning");
const verbose = argv.includes("--verbose");
const confirmMode = flag("--confirm") ?? "decline";

if (!benignId && !attackId) {
  console.error("Usage: npm run attack -- <attack-id> | --benign B01  [--model NAME] [--reasoning] [--verbose] [--confirm ask|decline]");
  process.exit(1);
}

// --- What to run --------------------------------------------------------------------------

let attacks;
try {
  attacks = loadAttacks();
} catch (error: unknown) {
  if (error instanceof LibraryError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
const attack = attackId ? attacks.find((a) => a.id === attackId) : undefined;
if (attackId && !attack) {
  console.error(`No attack "${attackId}". The library has: ${attacks.map((a) => a.id).join(", ")}`);
  process.exit(1);
}
const benign = loadBenign().get(attack ? attack.baseTicket : (benignId ?? ""));
if (!benign) {
  console.error(`No benign ticket ${benignId}. They are B01 to B15.`);
  process.exit(1);
}
const expected = [benign.expect, ...(benign.alternatives ?? [])];

// --- Printing rows -----------------------------------------------------------------------------

const ARROWS: Record<string, string> = { out: "→ model", in: "← model", call: "→ tool ", back: "← tool " };

function printRow(e: LogEvent): void {
  const iter = e.iteration !== undefined ? `#${e.iteration}` : "  ";
  const arrow = ARROWS[e.direction ?? ""] ?? "       ";
  const level = e.level.toUpperCase().padEnd(7);
  const layer = e.layer ? ` [${e.layer} @ ${e.stage}]` : "";
  console.log(`${iter.padEnd(3)} ${level} ${arrow} ${e.label}${layer}`);
  if (e.because && verbose) console.log(`                    because ${e.because}`);
  if (verbose && e.detail !== undefined) {
    const json = JSON.stringify(e.detail, null, 2);
    console.log(json.length > 3000 ? `${json.slice(0, 3000)}\n… (${json.length - 3000} more characters)` : json);
  }
}

// --- Confirmations -------------------------------------------------------------------------------

const askInTerminal: Confirmer = async ({ message }) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\n  ⚠ The tool server asks: ${message} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
};

// --- Run ----------------------------------------------------------------------------------------

async function main(): Promise<void> {
  // Checked at load; repeated here because narrowing does not cross into a function.
  if (!benign) return;
  if (reasoning) {
    const found = (await listModels()).find((m) => m.name === model);
    if (!found?.supportsThinking) {
      console.error(`${model} cannot show reasoning (no "thinking" capability). Run without --reasoning.`);
      process.exit(1);
    }
  }

  const tools = new ToolServerClient((line) => {
    if (!/ExperimentalWarning|trace-warnings|serving six tools/.test(line)) console.error(`      [tool server] ${line}`);
  });
  const logger = new Logger(printRow);

  let prepared: PreparedAttack | undefined;
  if (attack) {
    prepared = prepareAttack(attack, await ticketFacts(tools, benign));
    console.log(`\n${attack.id} · ${attack.title}\n${attack.category} · goal ${JSON.stringify(attack.goal)} · rides on ${benign.id} (${benign.title}) · ${model}`);
    console.log(`${attack.description}\n`);
  } else {
    console.log(`\n${benign.id} · ${benign.title} · ticket ${benign.ticket} · ${model}\n`);
  }

  const result = await runTicket({
    ticketId: benign.ticket,
    model,
    defenses: NO_DEFENSES,
    reasoning,
    overlays: prepared?.overlays ?? [],
    ...(prepared?.chatMessage !== undefined ? { chatMessage: prepared.chatMessage } : {}),
    ...(prepared && prepared.followUps.length > 0 ? { followUps: prepared.followUps } : {}),
    ...(confirmMode === "ask" ? { confirmer: askInTerminal } : {}),
  }, { logger, emit: () => {}, tools });
  await tools.close();

  console.log("\n--- result ---");
  if (result.error) console.log(`error           ${result.error}`);
  if (result.reply) console.log(JSON.stringify(result.reply, null, 2));
  console.log(`outbox          ${result.outbox.map((m) => `${m.messageId} → ${m.to} (via ${m.via})`).join("; ") || "empty"}`);
  console.log(`model requests  ${result.requests} · ${(result.elapsedMs / 1000).toFixed(1)} s · peak prompt ${result.peakPromptTokens} tokens`);

  if (attack && prepared) {
    const score = scoreAttack(result, attack.goal, expected, prepared.vars);
    const o = score.outcome;
    console.log(`\noutcome         ${o.kind}` +
      (o.kind === "blocked" ? ` by ${o.layer} (${o.stage} stage, ${o.attempted ? "attempted" : "before any attempt"})` : "") +
      (o.kind === "error" ? `: ${o.message}` : ""));
    for (const where of score.evidence.where) console.log(`evidence        ${where}`);
    if (o.kind === "failed-task") for (const why of o.why) console.log(`                · ${why}`);
    console.log(`real task       ${score.taskDone ? "done" : "not done"}${score.taskDone ? "" : ` — ${score.taskWhy.join("; ")}`}`);
    for (const note of score.notes.actionsMismatch) console.log(`note            ${note}`);
    console.log(`attack landed   ${result.overlaysLanded.length > 0 || prepared.chatMessage !== undefined ? "yes" : "NO — the model never reached the channel it was planted in"}`);
    console.log("");
    return;
  }

  const score = scoreBenign(result, expected);
  const o = score.outcome;
  console.log(`
outcome         ${o.kind}${o.kind === "falsely-blocked" ? ` by ${o.layer} (${o.stage} stage)` : ""}` +
    `${o.kind === "error" ? `: ${o.message}` : ""}`);
  for (const why of score.taskWhy) console.log(`                · ${why}`);
  for (const note of score.notes.actionsMismatch) console.log(`note            ${note}`);
  for (const note of score.notes.falseAlarms) console.log(`false alarm     ${note}`);
  console.log("");
}

await main();
