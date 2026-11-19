/**
 * load.ts — reads the attack library and the benign suite, and checks them.
 *
 * Every JSON file in attacks/ is an attack; every file in attacks/benign/
 * is a benign ticket's expectation. Both are checked before anything runs:
 *
 *   - each attack against the schema (schema.ts), with errors that name
 *     the file and the field
 *   - the id matches the file name, so "attack 10" means one thing
 *   - the base ticket exists in the benign suite
 *   - no payload carries a canary placeholder ({{canary:…}}) or anything
 *     shaped like a real canary value — an attack asks for a secret, it
 *     cannot contain one
 *   - every placeholder is one insert.ts knows how to fill
 *
 * One invalid file stops the whole load, with every problem listed. The
 * arena refuses to start on a library it cannot trust: a half-loaded
 * library would make the results quietly about a different experiment.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpectedReply } from "../../shared/arena.js";
import { attackSchema, type Attack } from "./schema.js";

const ATTACKS_DIR = fileURLToPath(new URL("../../attacks/", import.meta.url));
const BENIGN_DIR = join(ATTACKS_DIR, "benign");

/** Placeholders insert.ts fills; anything else in a payload is a mistake. */
const KNOWN_PLACEHOLDERS = new Set([
  "customerName", "customerFirstName", "customerEmail", "customerId", "orderId", "shopName", "attackerEmail", "otherOrderId",
]);

/** A benign ticket and its expected outcome(s). */
export interface BenignTicket {
  id: string;
  slug: string;
  title: string;
  ticket: string;
  awkward: boolean;
  why: string;
  expect: ExpectedReply;
  alternatives?: ExpectedReply[];
}

/** The library failed to load; `problems` lists every one, by file. */
export class LibraryError extends Error {
  override name = "LibraryError";
  constructor(public readonly problems: string[]) {
    super(`The attack library has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  }
}

/** The benign suite, by id (B01…B15). */
export function loadBenign(): Map<string, BenignTicket> {
  const out = new Map<string, BenignTicket>();
  for (const file of readdirSync(BENIGN_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const ticket = JSON.parse(readFileSync(join(BENIGN_DIR, file), "utf8")) as BenignTicket;
    out.set(ticket.id, ticket);
  }
  return out;
}

/** Every text a payload might carry, for the content checks. */
function payloadsOf(a: Attack): string[] {
  return [a.payload ?? "", ...(a.parts ?? []).map((p) => p.payload), ...(a.turns ?? []).map((t) => t.payload)];
}

/** The library, checked. Throws LibraryError listing every problem. */
export function loadAttacks(): Attack[] {
  const benign = loadBenign();
  const problems: string[] = [];
  const attacks: Attack[] = [];

  for (const file of readdirSync(ATTACKS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(ATTACKS_DIR, file), "utf8"));
    } catch (error: unknown) {
      problems.push(`${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const parsed = attackSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${file}: ${issue.path.join(".") || "(file)"} — ${issue.message}`);
      continue;
    }
    const a = parsed.data;

    if (`${a.id}.json` !== file) problems.push(`${file}: id is "${a.id}" — it must match the file name`);
    if (!benign.has(a.baseTicket)) problems.push(`${file}: baseTicket ${a.baseTicket} is not in attacks/benign/`);

    for (const text of payloadsOf(a)) {
      if (/\{\{\s*canary/i.test(text)) problems.push(`${file}: a payload contains a canary placeholder — attacks ask for secrets, they cannot carry them`);
      if (/TAS-VIP-|tas_live_|ridge-[0-9A-Z]{8}/.test(text)) problems.push(`${file}: a payload contains something shaped like a canary value`);
      for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!KNOWN_PLACEHOLDERS.has(m[1] ?? "")) problems.push(`${file}: unknown placeholder {{${m[1]}}}`);
      }
    }
    attacks.push(a);
  }

  if (problems.length > 0) throw new LibraryError(problems);
  return attacks;
}
