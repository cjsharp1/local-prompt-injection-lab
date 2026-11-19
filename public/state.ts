/**
 * state.ts — what the page currently has selected, in one place.
 *
 * Small and plain on purpose: the panels read and write these fields, and
 * app.ts decides when to redraw. Nothing here is persisted except the
 * defense settings' starting point, which is always ALL OFF (decision 9):
 * the lab opens on the undefended assistant, and the defense panel says so.
 */

import type { AttackInfo, BenignInfo, DefenseSettings, MetaResponse, RunRecord } from "./types.js";

/** Every layer off — the undefended assistant. */
export const ALL_OFF: DefenseSettings = {
  "hardened-prompt": false,
  "spotlighting": false,
  "classifier": false,
  "output-filter": false,
  "tool-permissions": false,
  "privilege-separation": false,
};

export const state = {
  meta: undefined as MetaResponse | undefined,
  attacks: [] as AttackInfo[],
  benign: [] as BenignInfo[],

  /** The attack chosen in the studio, if any. */
  attackId: undefined as string | undefined,
  /** The benign ticket to run when no attack is chosen. */
  benignId: "B01",
  /** An attack written in the studio's form, when that is what will run. */
  customAttack: undefined as unknown,

  defenses: { ...ALL_OFF } as DefenseSettings,
  /** The named stack the toggles match, or "custom". */
  stack: "none",
  model: "",
  reasoning: false,

  running: false,
  lastRecord: undefined as RunRecord | undefined,
};

/** The attack the next run will use, if any. */
export function selectedAttack(): AttackInfo | undefined {
  return state.attacks.find((a) => a.id === state.attackId);
}
