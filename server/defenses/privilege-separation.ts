/**
 * privilege-separation.ts — layer 6: the model with tools never reads untrusted text. HARD.
 *
 * Not a filter, and so no hooks here. Switching it on replaces the whole
 * pipeline shape (pipeline/run.ts chooses pipeline/separated.ts over
 * pipeline/direct.ts):
 *
 *   a QUARANTINED call   reads the ticket and every untrusted tool field,
 *                        with no tools and no secrets in its prompt, and may
 *                        only answer in a fixed schema with no free text —
 *                        request type, order ids, SKUs, topic, language,
 *                        "wants a person"
 *   a PRIVILEGED call    has the tools and the system prompt with the code,
 *                        and sees only those extracted facts — never the
 *                        customer's words. Tool results reach it projected:
 *                        trusted fields (lines, totals, status) in, attacker-
 *                        controlled fields (delivery notes, community answers)
 *                        withheld
 *
 * Why it helps
 *   The model that holds the secrets and the tools never reads the attack,
 *   and the model that reads the attack has nothing to leak and nothing to
 *   call. Its strength does not depend on either model behaving.
 *
 * How it fails — its scope limit
 *   The attacker still chooses AMONG ALLOWED VALUES. A ticket can make the
 *   quarantined reader report "damaged" for an undamaged item, or the
 *   wrong order id, and the privileged model will act on those facts. The
 *   schema limits the damage; it does not remove it. And it costs: the
 *   privileged model never reads the customer's own words, so nuanced
 *   tickets (B08, B11, B15) may be answered worse, and every untrusted chunk
 *   costs one more request.
 *
 * Attacks aimed at it
 *   None are designed for it specifically. Integrity attacks — direct-
 *   manager-refund, doc-quoted-chain-authority, prompt-policy-update — test
 *   its scope limit through the facts the quarantined reader is allowed to
 *   report.
 *
 * Built at build step 9. Until then, a run asking for it uses the direct
 * pipeline and says so in its first log rows.
 */

import type { DefenseLayer } from "./types.js";

export const privilegeSeparation: DefenseLayer = {
  id: "privilege-separation",
  name: "Privilege separation",
  strength: "hard",
  stages: ["input", "model"],
  summary: "A quarantined call reads untrusted text and returns fixed-schema facts; the model with tools never sees the raw text. The facts can still be wrong.",
};
