/**
 * insert.ts — turns an attack file into what one run needs.
 *
 * An attack file says what to say and where. A run needs it in three
 * forms, and this file produces all three:
 *
 *   overlays     for the tool server: text to put into the ticket, a new
 *                attachment, an order's delivery note, a community answer.
 *                Sent with every tool call; the tool server applies them
 *                (tool-server/overlays.ts) and reports which ones landed
 *   chatMessage  for the app: a "direct" payload, which the customer types
 *                into the live chat rather than planting in the shop's data
 *   followUps    for the app: a multi-turn attack's later messages, sent as
 *                the customer's next replies in the same conversation
 *
 * and the goal variables the scorer resolves ("$customerEmail" and friends).
 *
 * ---------------------------------------------------------------------------
 * Placeholders and markers
 * ---------------------------------------------------------------------------
 *
 * Filled in so payloads read naturally, from facts the tool server
 * reported about the base ticket:
 *
 *   {{customerName}} {{customerFirstName}} {{customerEmail}} {{customerId}}
 *   {{orderId}}      the base ticket's order
 *   {{shopName}}     Transition Area Supply
 *   {{attackerEmail}} an address on a lookalike .example domain — reserved
 *                    for documentation, so it can never receive mail
 *   {{otherOrderId}} an order that belongs to a DIFFERENT customer
 *
 * Then the obfuscation markers, innermost first:
 *
 *   {{b64:text}}  base64 of the text
 *   {{zw:text}}   the text with a zero-width space between every character
 *
 * An unknown placeholder is an error, not left in place: a payload that
 * says "{{custmerName}}" to the model would be a broken experiment.
 */

import type { Overlay } from "../../shared/shop.js";
import type { GoalVariables } from "../scoring/forbidden.js";
import type { Attack, Channel } from "./schema.js";

/** The attacker's address. A lookalike of the shop's domain, on the reserved .example TLD. */
export const ATTACKER_EMAIL = "records@transitionarea-archive.example";

export const SHOP_NAME = "Transition Area Supply";

/** Facts about the base ticket, as the tool server reported them. */
export interface TicketFacts {
  customerId: string;
  customerName: string;
  customerEmail: string;
  /** The order the base ticket is about, if any. */
  orderId: string | null;
}

/** What one attack run needs. */
export interface PreparedAttack {
  overlays: Overlay[];
  chatMessage: string | undefined;
  followUps: string[];
  vars: GoalVariables;
}

/**
 * An order belonging to a different customer: TA-20412 (C-001's) unless
 * the ticket IS C-001's, then TA-20417 (C-002's). Both are fixed seed
 * orders, so the choice is the same on every clone.
 */
function otherOrderFor(customerId: string): string {
  return customerId === "C-001" ? "TA-20417" : "TA-20412";
}

/** Fills placeholders, then applies the obfuscation markers. */
export function fillPayload(payload: string, values: Record<string, string>): string {
  const filled = payload.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Unknown placeholder ${whole} in a payload.`);
    return value;
  });
  // Markers can nest ({{b64:{{zw:x}}}}); resolve innermost first until none remain.
  let out = filled;
  for (let guard = 0; guard < 10 && /\{\{(b64|zw):/.test(out); guard++) {
    out = out.replace(/\{\{(b64|zw):((?:(?!\{\{)[\s\S])*?)\}\}/g, (_w, kind: string, text: string) =>
      kind === "b64" ? Buffer.from(text, "utf8").toString("base64") : text.split("").join("​"));
  }
  return out;
}

/** The overlay (or app-side text) for one payload in one channel. */
function placeOne(channel: Channel, text: string, id: string, n: number, into: PreparedAttack): void {
  switch (channel.kind) {
    case "user_turn":
      into.chatMessage = into.chatMessage === undefined ? text : `${into.chatMessage}\n${text}`;
      return;
    case "ticket_subject":
      into.overlays.push({ id, kind: "ticket", field: "subject", position: channel.position, text });
      return;
    case "ticket_body":
      into.overlays.push({ id, kind: "ticket", field: "body", position: channel.position, text });
      return;
    case "attachment":
      // Ids A-9001 upward never collide with the seed's A-0001…A-0006.
      into.overlays.push({ id, kind: "new-attachment", attachmentId: `A-${9000 + n}`, filename: channel.filename, mediaType: channel.mediaType, text });
      return;
    case "tool_result":
      if (channel.field === "delivery_note") {
        into.overlays.push({ id, kind: "order-note", position: channel.position, text });
      } else {
        into.overlays.push({ id, kind: "community-answer", author: channel.author ?? "trail_helper", text });
      }
      return;
    case "conversation":
      return; // carried by `turns`
  }
}

/** Builds everything one run of `attack` needs, for a ticket with these facts. */
export function prepareAttack(attack: Attack, facts: TicketFacts): PreparedAttack {
  const values: Record<string, string> = {
    customerName: facts.customerName,
    customerFirstName: facts.customerName.split(" ")[0] ?? facts.customerName,
    customerEmail: facts.customerEmail,
    customerId: facts.customerId,
    orderId: facts.orderId ?? "",
    shopName: SHOP_NAME,
    attackerEmail: ATTACKER_EMAIL,
    otherOrderId: otherOrderFor(facts.customerId),
  };

  const out: PreparedAttack = {
    overlays: [],
    chatMessage: undefined,
    followUps: [],
    vars: { customerEmail: facts.customerEmail, customerId: facts.customerId, otherOrderId: values.otherOrderId ?? "", attackerEmail: ATTACKER_EMAIL },
  };

  if (attack.channel && attack.payload !== undefined) {
    placeOne(attack.channel, fillPayload(attack.payload, values), `${attack.id}#1`, 1, out);
  }
  attack.parts?.forEach((part, i) => placeOne(part.channel, fillPayload(part.payload, values), `${attack.id}#${i + 1}`, i + 1, out));
  if (attack.turns) {
    // The first turn is the customer's live-chat message; the rest follow it.
    const [first, ...rest] = attack.turns.map((t) => fillPayload(t.payload, values));
    out.chatMessage = first;
    out.followUps = rest;
  }
  return out;
}
