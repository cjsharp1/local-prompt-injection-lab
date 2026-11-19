/**
 * attack.ts — one ticket through the whole lab, in the terminal.
 *
 * Run it with:  npm run attack -- --benign B01
 *               npm run attack -- --benign B15 --model llama3.2:3b --verbose
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
 *   --benign B01     run one benign ticket (attacks/benign/B01-*.json)
 *   --model NAME     a local model (default: MODEL from .env)
 *   --reasoning      let the model reason first (only models that can)
 *   --verbose        print each row's full detail, not just its label
 *   --confirm MODE   how to answer the tool server's confirmation requests:
 *                    "decline" (the default, as the arena does) or "ask"
 *                    (a y/n prompt here in the terminal)
 *
 * Attacks by id and --stack arrive with the attack library and the
 * defences (build steps 7 and 8). At this step the result is compared
 * with the ticket's expected outcome directly; the scorer that decides
 * the real outcome arrives at step 6.
 */

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { StructuredReply } from "../shared/shop.js";
import type { LogEvent } from "../shared/types.js";
import { NO_DEFENSES } from "../server/defenses/settings.js";
import { Logger } from "../server/logger.js";
import { ToolServerClient, type Confirmer } from "../server/mcp/client.js";
import { listModels, ollamaConfig } from "../server/model/ollama.js";
import { runTicket } from "../server/pipeline/run.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// --- Flags ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const benignId = flag("--benign");
const model = flag("--model") ?? ollamaConfig().model;
const reasoning = argv.includes("--reasoning");
const verbose = argv.includes("--verbose");
const confirmMode = flag("--confirm") ?? "decline";

if (!benignId) {
  console.error("Usage: npm run attack -- --benign B01 [--model NAME] [--reasoning] [--verbose] [--confirm ask|decline]");
  console.error("(Attacks by id arrive with the attack library, build step 7.)");
  process.exit(1);
}

// --- The benign ticket's expectation -------------------------------------------------------

interface Expectation {
  order_id: string | null;
  order_status_reported: string | null;
  refund_amount: number | null;
  needs_human: boolean;
}
interface Benign { id: string; title: string; ticket: string; expect: Expectation; alternatives?: Expectation[] }

const file = readdirSync(join(ROOT, "attacks", "benign")).find((f) => f.startsWith(`${benignId}-`));
if (!file) {
  console.error(`No benign ticket ${benignId}. They are attacks/benign/B01-… to B15-….`);
  process.exit(1);
}
const benign = JSON.parse(readFileSync(join(ROOT, "attacks", "benign", file), "utf8")) as Benign;

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

  console.log(`\n${benign.id} · ${benign.title} · ticket ${benign.ticket} · ${model}\n`);
  const result = await runTicket({
    ticketId: benign.ticket,
    model,
    defenses: NO_DEFENSES,
    reasoning,
    overlays: [],
    ...(confirmMode === "ask" ? { confirmer: askInTerminal } : {}),
  }, { logger, emit: () => {}, tools });
  await tools.close();

  console.log("\n--- result ---");
  if (result.error) console.log(`error           ${result.error}`);
  if (result.reply) console.log(JSON.stringify(result.reply, null, 2));
  console.log(`outbox          ${result.outbox.map((m) => `${m.messageId} → ${m.to} (via ${m.via})`).join("; ") || "empty"}`);
  console.log(`model requests  ${result.requests} · ${(result.elapsedMs / 1000).toFixed(1)} s · peak prompt ${result.peakPromptTokens} tokens`);

  // A direct comparison with the expectation — replaced by the scorer at step 6.
  if (result.reply) {
    const outcomes = [benign.expect, ...(benign.alternatives ?? [])];
    const matches = outcomes.some((x) => matchesExpectation(result.reply as StructuredReply, x));
    const strangers = result.outbox.filter((m) => m.to !== result.outbox.find((d) => d.via === "app")?.to);
    console.log(`\nexpected        ${outcomes.map(describe).join("  OR  ")}`);
    console.log(`got             ${describe(result.reply)}`);
    console.log(`matches         ${matches ? "yes" : "NO"}${strangers.length > 0 ? ` · but ${strangers.length} email(s) to someone other than the customer` : ""}\n`);
  }
}

function tidyOrder(id: string | null): string | null {
  const digits = id?.replace(/\D/g, "") ?? "";
  return digits ? `TA-${digits}` : null;
}

function matchesExpectation(reply: StructuredReply, x: Expectation): boolean {
  return tidyOrder(reply.order_id) === x.order_id &&
    reply.order_status_reported === x.order_status_reported &&
    reply.refund_amount === x.refund_amount &&
    reply.needs_human === x.needs_human;
}

function describe(x: Expectation | StructuredReply): string {
  return `order ${x.order_id ?? "none"} · ${x.order_status_reported ?? "no status"} · refund ${x.refund_amount ?? "none"} · needs_human ${x.needs_human}`;
}

await main();
