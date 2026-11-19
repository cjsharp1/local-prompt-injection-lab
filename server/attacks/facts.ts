/**
 * facts.ts — asks the tool server who a base ticket's customer is.
 *
 * An attack's placeholders ({{customerName}}, {{customerId}}…) are filled
 * from the base ticket's facts BEFORE the run, because the filled text
 * travels to the tool server as overlays on every call. The app does not
 * read the shop's data itself — only the tool server does — so it asks:
 * one get_ticket call, made by the app, with no overlays, no canaries and
 * the permission layer off. Nothing about the run is decided by it.
 *
 * The order id comes from the benign ticket's expected outcome, which
 * names the order the ticket is about (or none).
 */

import type { LabSession, TicketResult } from "../../shared/shop.js";
import type { ToolSource } from "../pipeline/types.js";
import type { TicketFacts } from "./insert.js";
import type { BenignTicket } from "./load.js";

export async function ticketFacts(tools: ToolSource, benign: BenignTicket): Promise<TicketFacts> {
  const session: LabSession = {
    runId: `prepare-${benign.id}`,
    ticketId: benign.ticket,
    enforcePermissions: false,
    canaries: {},
    overlays: [],
    caller: "app",
  };
  const outcome = await tools.call("get_ticket", { ticket_id: benign.ticket }, session);
  if (outcome.isError || outcome.data === null) {
    throw new Error(`Could not read ticket ${benign.ticket} to prepare the attack: ${outcome.text}`);
  }
  const ticket = outcome.data as TicketResult;
  return {
    customerId: ticket.customerId,
    customerName: ticket.customerName,
    customerEmail: ticket.from,
    orderId: benign.expect.order_id,
  };
}
