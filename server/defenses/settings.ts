/**
 * settings.ts — which defense layers are on, and how to say so.
 *
 * Six layers, each switchable, each labeled with how far it can be
 * trusted (the full descriptions are in each layer's own file):
 *
 *   1. hardened-prompt       SOFT    model stage — rules in the system prompt
 *   2. spotlighting          SOFT    input stage — untrusted text fenced off
 *   3. classifier            MEDIUM  input stage — a second model call looks for injections
 *   4. output-filter         MEDIUM  tool + output stages — code blocks secrets and strange recipients
 *   5. tool-permissions      HARD    tool stage, in the tool server — scoped to the ticket's customer
 *   6. privilege-separation  HARD    a pipeline MODE — the model with tools never reads untrusted text
 *
 * EVERY LAYER DEFAULTS TO OFF (decision 9). The lab starts from the
 * undefended assistant: run an attack, watch it land, then add layers one
 * at a time and watch what each stops — and what each costs in legitimate
 * tickets blocked. A request that omits a layer gets it off, and the
 * description says so plainly, so nobody mistakes the default for a
 * protected app.
 *
 * This file imports nothing at runtime, so every layer can depend on it
 * without risk of a cycle.
 */

import type { DefenseId, DefenseSettings } from "../../shared/types.js";

/** Every layer, in pipeline order. */
export const DEFENSE_IDS: readonly DefenseId[] = [
  "hardened-prompt",
  "spotlighting",
  "classifier",
  "output-filter",
  "tool-permissions",
  "privilege-separation",
];

/** All six off: the undefended assistant, and the default. */
export const NO_DEFENSES: DefenseSettings = {
  "hardened-prompt": false,
  "spotlighting": false,
  "classifier": false,
  "output-filter": false,
  "tool-permissions": false,
  "privilege-separation": false,
};

/**
 * The arena's named stacks (PLAN §9.1): a fixed list, not every
 * combination. Each one is a question the results answer — what does this
 * layer buy alone, what do the soft layers buy together, what does
 * everything buy, and what is left for privilege separation to add.
 */
export const STACKS: Readonly<Record<string, readonly DefenseId[]>> = {
  "none": [],
  "prompt": ["hardened-prompt"],
  "spotlight": ["spotlighting"],
  "classifier": ["classifier"],
  "output-filter": ["output-filter"],
  "tool-permissions": ["tool-permissions"],
  "privilege-separation": ["privilege-separation"],
  "soft": ["hardened-prompt", "spotlighting"],
  "all-but-separation": ["hardened-prompt", "spotlighting", "classifier", "output-filter", "tool-permissions"],
  "everything": ["hardened-prompt", "spotlighting", "classifier", "output-filter", "tool-permissions", "privilege-separation"],
};

/** The settings for a named stack, or undefined if there is no such stack. */
export function stackSettings(name: string): DefenseSettings | undefined {
  const ids = STACKS[name];
  if (!ids) return undefined;
  const out = { ...NO_DEFENSES };
  for (const id of ids) out[id] = true;
  return out;
}

/**
 * Reads defense settings from a request body or a set of flags. Missing
 * or non-boolean values are OFF — the lab's default, stated, not hidden.
 */
export function parseDefenses(input: unknown): DefenseSettings {
  const source = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const out = { ...NO_DEFENSES };
  for (const id of DEFENSE_IDS) out[id] = source[id] === true;
  return out;
}

/** "none (the undefended assistant)" or "hardened-prompt, tool-permissions" — for log labels and badges. */
export function describeDefenses(settings: DefenseSettings): string {
  const on = DEFENSE_IDS.filter((id) => settings[id]);
  return on.length === 0 ? "none (the undefended assistant)" : on.join(", ");
}
