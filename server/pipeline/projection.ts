/**
 * projection.ts — what the privileged model may read of each tool result.
 *
 * In privilege-separation mode, a tool result is not passed to the model
 * with tools as-is. It is PROJECTED: rebuilt from the structured result,
 * keeping the fields the shop itself wrote and withholding the fields a
 * customer — and so an attacker — could have written:
 *
 *   lookup_order          lines, prices, totals, status, dates: kept.
 *                         delivery_note (typed by the customer at
 *                         checkout): withheld
 *   search_help_articles  article titles and bodies (written by the shop):
 *                         kept. community answers (written by other
 *                         customers): withheld
 *   get_internal_notes    staff notes (written by staff): kept
 *   send_email            the queued message's id: kept
 *   get_attachment        the attachment is the customer's text: NOT
 *                         projected here at all — it goes to the
 *                         quarantined reader, and the privileged model gets
 *                         its facts (separated.ts)
 *
 * The rules are code, here, not a model's judgment — and a withheld field
 * is shown as "[withheld: untrusted text, 214 chars]", so a reader of the
 * log can see exactly what the privileged model did not see.
 *
 * (The plan put these lists beside each tool definition in the tool
 * server. They live in the app instead, because projecting is the app's
 * policy for ITS model; the tool server's job is to return the true result
 * to whoever asks, as described in shared/shop.ts.)
 */

import type { HelpSearchResult, InternalNotesResult, OrderResult, SendEmailResult } from "../../shared/shop.js";
import type { ToolCallOutcome } from "../mcp/client.js";

/** "$64.95" from cents — the same form the tool server's text uses. */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const withheld = (text: string, what = "untrusted text") => `[withheld: ${what}, ${text.length} chars]`;

/** What was withheld, for the log. */
export interface Projection {
  text: string;
  withheld: string[];
}

/** The privileged model's view of one tool result. */
export function project(name: string, outcome: ToolCallOutcome): Projection {
  // Errors and refusals are the tool server's own words: trusted.
  if (outcome.isError || outcome.data === null) return { text: outcome.text, withheld: [] };

  switch (name) {
    case "lookup_order": {
      const o = outcome.data as OrderResult;
      const dates = `placed ${o.placedOn}` + (o.deliveredOn ? `, delivered ${o.deliveredOn}` : "");
      const lines = o.lines.map((l) => `- ${l.qty} × ${l.name} (${l.sku}) at ${money(l.unitPriceCents)} = ${money(l.lineTotalCents)}`).join("\n");
      return {
        text: `Order ${o.orderId} (customer ${o.customerId}). Status: ${o.status} (${dates}).\nLines:\n${lines}\n` +
          `Subtotal ${money(o.subtotalCents)}, shipping ${money(o.shippingCents)}, total ${money(o.totalCents)}.\n` +
          `Delivery note: ${o.deliveryNote === "" ? "(none)" : withheld(o.deliveryNote, "written by the customer")}`,
        withheld: o.deliveryNote === "" ? [] : [`delivery_note (${o.deliveryNote.length} chars)`],
      };
    }
    case "search_help_articles": {
      const r = outcome.data as HelpSearchResult;
      const answers = r.results.reduce((n, a) => n + a.communityAnswers.length, 0);
      const text = r.results.length === 0
        ? `No help articles matched "${r.query}".`
        : r.results.map((a) => `${a.articleId} · ${a.title} (${a.visibility})\n${a.body}` +
            (a.communityAnswers.length === 0 ? "" : `\nCommunity answers: [withheld: ${a.communityAnswers.length} written by customers]`)).join("\n\n");
      return { text, withheld: answers === 0 ? [] : [`${answers} community answer(s)`] };
    }
    case "get_internal_notes": {
      const n = outcome.data as InternalNotesResult;
      return { text: `Staff notes for ${n.customerId} (internal):\n${n.notes}`, withheld: [] };
    }
    case "send_email": {
      const m = outcome.data as SendEmailResult;
      return { text: `Message ${m.messageId} to ${m.to}: ${m.status}.`, withheld: [] };
    }
    default:
      // A tool with no projection rule is withheld entirely: a new tool must
      // be given a rule before the privileged model can read its results.
      return { text: `[withheld: no projection rule for ${name}]`, withheld: [`the whole ${name} result`] };
  }
}
