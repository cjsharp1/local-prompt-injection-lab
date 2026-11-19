/**
 * check-env.ts — checks that this machine can run the lab, one piece at a time.
 *
 * Run it with:  npm run check-env
 *
 * The lab depends on several separate things, and when it does not work
 * the useful question is WHICH one is missing. A single "something is
 * wrong" teaches nothing and fixes nothing. So each check prints its own
 * PASS / FAIL / note line, with what to do next.
 *
 * Checked so far:
 *
 *   1. Node version — the tool server reads the shop data with
 *      node:sqlite, which needs Node 24 or later.
 *   2. Settings — every value in .env (or its default) is usable: ports
 *      are ports and do not collide, the context window is a sensible
 *      number, the Ollama URL points at this machine, the model is a
 *      local one.
 *   3. The shop database — data/shop.db exists. It is generated, not
 *      committed, so a fresh clone has none until `npm run seed`.
 *
 * Added at build step 4, each as its own line: Ollama — running, both
 * models pulled, able to call tools, no cloud models, and whether
 * Ollama's own local-only switch is on.
 *
 * ---------------------------------------------------------------------------
 * Why settings are checked as well as read
 * ---------------------------------------------------------------------------
 *
 * Two settings carry the lab's promise that nothing leaves the machine.
 * OLLAMA_URL pointing at another host, or MODEL naming a ":cloud" model,
 * would each quietly send every ticket, attack payload and planted secret
 * elsewhere — and the lab would still work, which is exactly why each is
 * worth a check that fails loudly.
 */

import "dotenv/config"; // reads .env, if there is one, onto process.env
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The project root, derived from this file rather than from cwd. */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Defaults — kept in step with .env.example. */
const DEFAULTS = {
  PORT: "3300",
  TOOL_SERVER_PORT: "3301",
  OLLAMA_URL: "http://127.0.0.1:11434",
  MODEL: "qwen3.5:4b",
  NUM_CTX: "8192",
} as const;

/** The lowest Node major with node:sqlite usable unflagged and read-only. */
const MIN_NODE_MAJOR = 24;

/** Hostnames that mean "this machine". */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Ollama's own port: the lab's servers must not try to take it. */
const OLLAMA_PORT = 11434;

/**
 * The smallest context window worth running with. Below this, the ticket,
 * an attachment and six tool definitions do not fit, and Ollama silently
 * drops messages from the start of the turn.
 */
const MIN_NUM_CTX = 4096;

/** A running tally, so the summary line can say whether anything failed. */
let failures = 0;

function pass(message: string): void {
  console.log(`PASS  ${message}`);
}

function fail(message: string, ...fix: string[]): void {
  failures += 1;
  console.error(`FAIL  ${message}`);
  for (const line of fix) console.error(`      ${line}`);
}

function note(message: string, ...more: string[]): void {
  console.log(`note  ${message}`);
  for (const line of more) console.log(`      ${line}`);
}

/**
 * A setting's value, or its default when unset.
 *
 * An empty string counts as unset: `PORT=` in a .env file is almost
 * always a line someone cleared, not a request for port "".
 */
function setting(name: keyof typeof DEFAULTS): string {
  const value = process.env[name];
  return value === undefined || value === "" ? DEFAULTS[name] : value;
}

/**
 * Parses a port, or returns null if it is not one.
 *
 * Number("") is 0 and Number("abc") is NaN, so both a blank and a typo
 * land in the null branch rather than becoming a port nothing can bind.
 */
function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

// --- 1. Node -----------------------------------------------------------------

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) {
    pass(`Node ${process.versions.node}`);
  } else {
    fail(
      `Node ${process.versions.node} is too old.`,
      "The tool server reads the shop data with node:sqlite, which needs",
      `Node ${MIN_NODE_MAJOR} or later. Install a current Node 24 release.`,
    );
  }
}

// --- 2. Settings -------------------------------------------------------------

function checkPorts(): void {
  const app = parsePort(setting("PORT"));
  const tools = parsePort(setting("TOOL_SERVER_PORT"));

  if (app === null) {
    fail(`PORT is "${setting("PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (tools === null) {
    fail(`TOOL_SERVER_PORT is "${setting("TOOL_SERVER_PORT")}", which is not a usable port.`,
      "Expected a whole number between 1 and 65535.");
  }
  if (app === null || tools === null) return;

  if (app === tools) {
    // Only breaks when both run at once — and the error you get then
    // (EADDRINUSE) does not say which setting caused it.
    fail(`PORT and TOOL_SERVER_PORT are both ${app}.`,
      "The lab and the HTTP tool server need different ports.");
    return;
  }
  if (app === OLLAMA_PORT || tools === OLLAMA_PORT) {
    fail(`A port is set to ${OLLAMA_PORT}, which is Ollama's.`,
      "Whichever starts second will fail to bind.");
    return;
  }
  pass(`PORT = ${app}, TOOL_SERVER_PORT = ${tools}`);
}

function checkOllamaUrl(): void {
  const raw = setting("OLLAMA_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error: unknown) {
    // new URL throws TypeError for anything unparseable; anything else is
    // a real bug and should surface.
    if (!(error instanceof TypeError)) throw error;
    fail(`OLLAMA_URL is "${raw}", which is not a URL.`,
      `Expected something like ${DEFAULTS.OLLAMA_URL}.`);
    return;
  }

  if (!LOCAL_HOSTS.has(url.hostname)) {
    // The lab would work — that is the danger. Every ticket, every attack
    // payload and every canary secret would cross the network.
    fail(`OLLAMA_URL points at ${url.hostname}, not this machine.`,
      "Every prompt, attack payload and planted secret would be sent there.",
      `Use ${DEFAULTS.OLLAMA_URL} to keep everything local.`);
    return;
  }
  pass(`OLLAMA_URL = ${url.origin}`);
}

/**
 * The model name, checked for the one thing that can be checked without
 * Ollama running: that it does not name a cloud model.
 *
 * Ollama names cloud models with a ":cloud" suffix (some older tags used
 * "-cloud"). The same rule is enforced again, by name, in the model client
 * before any request is sent (build step 4) — this line catches it before
 * anything starts.
 */
function checkModel(): void {
  const model = setting("MODEL");
  if (/[:-]cloud$/i.test(model)) {
    fail(`MODEL is "${model}", a cloud model.`,
      "It runs on ollama.com, so every ticket and attack would leave this machine.",
      `Use a local model, such as ${DEFAULTS.MODEL}.`);
    return;
  }
  pass(`MODEL = ${model} (by name, a local model — whether it is installed is checked once Ollama is wired in)`);
}

function checkNumCtx(): void {
  const raw = setting("NUM_CTX");
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`NUM_CTX is "${raw}", which is not a whole number of tokens.`,
      `Expected something like ${DEFAULTS.NUM_CTX}.`);
    return;
  }
  if (value < MIN_NUM_CTX) {
    fail(`NUM_CTX is ${value}, below ${MIN_NUM_CTX}.`,
      "A ticket with an attachment and six tool definitions will not fit, and",
      "Ollama drops whole messages silently when that happens.");
    return;
  }
  pass(`NUM_CTX = ${value}`);
}

// --- 3. The shop database -------------------------------------------------------

function checkDatabase(): void {
  if (existsSync(join(ROOT, "data", "shop.db"))) {
    pass("data/shop.db exists");
  } else {
    // Generated, never committed: a fresh clone always lands here once.
    fail("data/shop.db is missing.",
      "Run:  npm run seed   (it builds the same invented shop on every machine)");
  }
}

// --- Run -----------------------------------------------------------------------

console.log("\nChecking this machine for the prompt injection lab.\n");
checkNode();
checkPorts();
checkOllamaUrl();
checkModel();
checkNumCtx();
checkDatabase();
note("Ollama is not checked yet.", "Its checks are added at build step 4.");

console.log(failures === 0
  ? "\nEverything checked so far is ready.\n"
  : `\n${failures} check${failures === 1 ? "" : "s"} failed — fix the lines marked FAIL above.\n`);
process.exitCode = failures === 0 ? 0 : 1;
