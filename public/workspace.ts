/**
 * workspace.ts — the ticket as a support agent sees it, and what the assistant did with it.
 *
 * Top: the ticket — sender, subject, body, attachments, any live-chat
 * message. The body is shown as its SOURCE: an HTML email is text here,
 * never rendered, so hidden instructions are visible to anyone who reads
 * it (the studio's reveal view marks exactly where).
 *
 * Bottom, after a run: the structured reply as a form (reply text, order,
 * status, refund, actions, needs-human), the run's outbox — every message
 * that would have been sent, and to whom — and the OUTCOME BADGE, decided
 * by the scorer, with its evidence one click away: where a canary was
 * found, which call was forbidden, what the task needed.
 *
 * The run's canaries are listed too, so a reader can see exactly what the
 * scorer was looking for.
 */

import { byId, dollars, el, fill } from "./dom.js";
import type { PreviewResponse, RunRecord, StructuredReply } from "./types.js";

/** Draws the ticket from a preview (the ticket exactly as the run will load it). */
export function renderTicket(preview: PreviewResponse): void {
  const t = preview.ticket;
  if (!t) {
    byId("ticket-view").replaceChildren(el("p", { class: "muted", text: "The ticket could not be loaded." }));
    return;
  }
  const planted = new Set(preview.overlays.filter((o) => o.kind === "new-attachment").map((o) => (o.kind === "new-attachment" ? o.attachmentId : "")));
  fill(byId("ticket-view"), [
    el("div", { class: "ticket-head" }, [
      el("span", { class: "ticket-id", text: t.ticketId }),
      el("span", { text: `${t.customerName} <${t.from}> · ${t.customerId}` }),
      el("span", { class: "muted", text: t.contentType }),
    ]),
    el("div", { class: "ticket-subject", text: t.subject }),
    el("pre", { class: "ticket-body", text: t.body }),
    t.attachments.length === 0 ? null : el("ul", { class: "attachments" }, t.attachments.map((a) =>
      el("li", { class: planted.has(a.attachmentId) ? "planted" : "" }, [
        el("span", { text: `${a.attachmentId} ${a.filename}` }),
        el("span", { class: "muted", text: ` ${a.mediaType}, ${a.size} bytes${planted.has(a.attachmentId) ? " · planted by the attack" : ""}` }),
      ]))),
    preview.chatMessage === null ? null : el("div", { class: "chat-message" }, [
      el("span", { class: "muted", text: "Live chat from the customer:" }),
      el("pre", { text: preview.chatMessage }),
      ...preview.followUps.map((f, i) => el("pre", { class: "follow-up", text: `Turn ${i + 2}: ${f}` })),
    ]),
  ]);
}

/** One field of the structured reply. */
function field(label: string, value: string): HTMLElement {
  return el("div", { class: "reply-field" }, [el("span", { class: "muted", text: label }), el("span", { text: value })]);
}

/** A short, plain description of an outcome. */
function outcomeText(record: RunRecord): string {
  const o = record.outcome;
  switch (o.kind) {
    case "blocked": return `blocked by ${o.layer} (${o.stage} stage${o.attempted ? ", after the model went for it" : ", before any attempt"})`;
    case "falsely-blocked": return `falsely blocked by ${o.layer} (${o.stage} stage)`;
    case "error": return `error: ${o.message}`;
    default: return o.kind;
  }
}

/** Draws the result of a run. */
export function renderRecord(record: RunRecord): void {
  const reply = record.reply as StructuredReply | null;
  const badgeClass = ["succeeded", "wrong", "falsely-blocked", "error"].includes(record.outcome.kind) ? "bad"
    : record.outcome.kind === "failed-task" ? "warn" : "good";

  const evidence = [
    ...(record.evidence?.where ?? []).map((w) => `evidence: ${w}`),
    ...record.taskWhy.map((w) => `task: ${w}`),
    ...record.notes.actionsMismatch.map((w) => `note: ${w}`),
    ...record.notes.falseAlarms.map((w) => `false alarm: ${w}`),
  ];

  fill(byId("result-view"), [
    el("div", { class: `outcome-badge ${badgeClass}`, text: outcomeText(record) }),
    evidence.length === 0 ? null : el("details", { class: "evidence" }, [
      el("summary", { text: `why (${evidence.length})` }),
      el("ul", {}, evidence.map((e) => el("li", { text: e }))),
    ]),
    reply ? el("div", { class: "reply-form" }, [
      el("pre", { class: "reply-text", text: reply.reply_text }),
      field("Order", reply.order_id ?? "none"),
      field("Status reported", reply.order_status_reported ?? "none"),
      field("Refund", dollars(reply.refund_amount)),
      field("Actions (as the model reports them)", reply.actions_taken.join(", ") || "none"),
      field("Needs a person", reply.needs_human ? "yes" : "no"),
      field("Delivered to the customer", record.delivered ? "yes" : "no — withheld or not reached"),
    ]) : el("p", { class: "muted", text: "No structured reply — the run ended before one." }),
    el("div", { class: "outbox" }, [
      el("span", { class: "muted", text: "Outbox (simulated — nothing is sent)" }),
      el("ul", {}, record.outbox.length === 0 ? [el("li", { class: "muted", text: "empty" })]
        : record.outbox.map((m) => el("li", { class: m.via === "model" ? "via-model" : "", text: `→ ${m.to} · "${m.subject}" · via ${m.via}` }))),
    ]),
    el("details", { class: "canaries" }, [
      el("summary", { text: "This run's secrets (what the scorer looks for)" }),
      el("ul", {}, Object.entries(record.canaries).map(([k, v]) => el("li", { text: `${k}: ${v}` }))),
    ]),
  ]);
}

/** While a run is going: say so, rather than showing an empty reply. */
export function showWaiting(): void {
  byId("result-view").replaceChildren(el("p", { class: "waiting", text: "The assistant is working on this ticket. Its reply, the outbox and the outcome appear here when the run finishes. The activity log shows each step as it happens." }));
}

export function clearRecord(): void {
  byId("result-view").replaceChildren(el("p", { class: "muted", text: "Run the ticket to see the assistant's reply, the outbox and the outcome." }));
}
