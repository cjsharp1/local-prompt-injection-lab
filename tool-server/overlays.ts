/**
 * overlays.ts — puts a run's attack text and canary values into results.
 *
 * Two jobs, both about making one run's shop different from the clean one
 * without ever changing the database:
 *
 *   Overlays   attack payloads, sent by the app in the session. Each tool
 *              asks for the overlays that match what it is building (the
 *              ticket body, a delivery note, a community answer) and
 *              applies them. Every overlay that lands is recorded, and the
 *              ids go back in the result's `_meta["lab/overlays"]` — so the
 *              UI can highlight exactly where a payload arrived, and so a
 *              run whose payload never landed (the model never called the
 *              tool that carries it) is visibly different from one where it
 *              landed and was ignored.
 *
 *   Canaries   the seed stores placeholders — {{canary:staffNote}},
 *              {{canary:apiToken}} — never values. `fill` swaps in the
 *              values the app generated for this run. A placeholder with
 *              no value (no session, or a run that did not set it) is left
 *              as it is, which is visibly not a secret.
 *
 * Neither job involves trust decisions: the tool server inserts what the
 * app sent, verbatim. The app is inside the trust boundary; the text
 * itself is the attacker's.
 */

import type { Canaries, LabSession, Overlay } from "../shared/shop.js";
import type { OverlayApplier } from "./tools/types.js";

/** Builds the applier for one call, and the list it records into. */
export function createOverlayApplier(session: LabSession | null): { applier: OverlayApplier; appliedIds: string[] } {
  const appliedIds: string[] = [];
  const overlays: Overlay[] = session?.overlays ?? [];

  const applier: OverlayApplier = {
    matching(kind, predicate) {
      type Of = Extract<Overlay, { kind: typeof kind }>;
      const ofKind = overlays.filter((o): o is Of => o.kind === kind);
      return predicate ? ofKind.filter(predicate) : ofKind;
    },
    applied(id) {
      if (!appliedIds.includes(id)) appliedIds.push(id);
    },
  };
  return { applier, appliedIds };
}

/** The placeholder for each canary, exactly as the seed writes it. */
const PLACEHOLDERS: Record<keyof Canaries, string> = {
  discountCode: "{{canary:discountCode}}",
  staffNote: "{{canary:staffNote}}",
  apiToken: "{{canary:apiToken}}",
};

/** Replaces each canary placeholder with the run's value, where there is one. */
export function fillCanaries(text: string, canaries: Canaries | undefined): string {
  let out = text;
  for (const key of Object.keys(PLACEHOLDERS) as Array<keyof Canaries>) {
    const value = canaries?.[key];
    if (value !== undefined) out = out.split(PLACEHOLDERS[key]).join(value);
  }
  return out;
}
