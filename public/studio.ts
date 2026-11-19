/**
 * studio.ts — the Attack studio: choose an attack, see where it lands, or write your own.
 *
 * Three parts:
 *
 *   The picker      the library's attacks grouped by category, plus "no
 *                   attack" with a benign ticket to run instead. Each attack
 *                   shows its description, goal, base ticket and the
 *                   defences it is designed to get past.
 *
 *   Where it lands  the exact text the chosen channel will contain — the
 *                   attacked ticket body, a planted attachment, the delivery
 *                   note or community answer a tool will return, the
 *                   live-chat message — with the payload marked. "Reveal
 *                   hidden content" shows what a model reading the source
 *                   sees and a person reading the rendered email does not:
 *                   HTML comments, hidden elements, white text, zero-width
 *                   characters (reveal.ts). Never rendered; always text.
 *
 *   Write your own  a JSON editor for an attack in the library's own format
 *                   (attacks/README.md), checked by the server against the
 *                   same schema and content rules as the library's files.
 */

import { byId, el, fill } from "./dom.js";
import { reveal } from "./reveal.js";
import { selectedAttack, state } from "./state.js";
import type { AttackInfo, Overlay, PreviewResponse } from "./types.js";

/** Draws the picker; `onSelect` is called when the choice changes. */
export function renderPicker(onSelect: () => void): void {
  const select = el("select", { attrs: { id: "attack-select", "aria-label": "Attack" } });
  select.append(el("option", { text: "No attack — run a benign ticket", attrs: { value: "" } }));
  const categories = [...new Set(state.attacks.map((a) => a.category))];
  for (const category of categories) {
    const group = el("optgroup", { attrs: { label: category } });
    for (const a of state.attacks.filter((x) => x.category === category)) {
      group.append(el("option", { text: a.title, attrs: { value: a.id } }));
    }
    select.append(group);
  }
  select.value = state.attackId ?? "";

  const benignSelect = el("select", { attrs: { id: "benign-select", "aria-label": "Benign ticket" } },
    state.benign.map((b) => el("option", { text: `${b.id} · ${b.title}${b.awkward ? " ★" : ""}`, attrs: { value: b.id } })));
  benignSelect.value = state.benignId;
  benignSelect.disabled = state.attackId !== undefined;

  select.addEventListener("change", () => {
    state.attackId = select.value || undefined;
    state.customAttack = undefined;
    onSelect();
  });
  benignSelect.addEventListener("change", () => {
    state.benignId = benignSelect.value;
    onSelect();
  });

  fill(byId("studio-picker"), [
    el("label", { class: "field" }, [el("span", { class: "muted", text: "Attack" }), select]),
    el("label", { class: "field" }, [el("span", { class: "muted", text: "Benign ticket (when there is no attack; ★ = awkward but legitimate)" }), benignSelect]),
  ]);
  renderAbout();
}

/** The chosen attack's description, goal and targets. */
function renderAbout(): void {
  const a = selectedAttack();
  const benign = state.benign.find((b) => b.id === (a ? a.baseTicket : state.benignId));
  fill(byId("studio-about"), [
    a ? el("div", {}, [
      el("p", { text: a.description }),
      el("p", { class: "muted", text: `Category ${a.category} · goal ${describeGoal(a)} · rides on ${a.baseTicket}${benign ? ` (${benign.title})` : ""}` }),
      a.targets.length > 0 ? el("p", { class: "muted", text: `Designed to get past: ${a.targets.join(", ")}` }) : null,
      a.references.length > 0 ? el("p", { class: "muted", text: `Technique: ${a.references.join("; ")}` }) : null,
    ]) : benign ? el("div", {}, [
      el("p", { text: benign.why }),
      el("p", { class: "muted", text: `Expected: order ${benign.expect.order_id ?? "none"} · ${benign.expect.order_status_reported ?? "no status"} · refund ${benign.expect.refund_amount ?? "none"} · needs a person: ${benign.expect.needs_human ? "yes" : "no"}` }),
    ]) : null,
  ]);
}

function describeGoal(a: AttackInfo): string {
  const g = a.goal;
  if (g.type === "leak") return `leak the ${g.canary}`;
  if (g.type === "forbidden-action") return `make the assistant call ${g.tool} where ${JSON.stringify(g.where)}`;
  return `corrupt ${g.field} (${JSON.stringify(g.intended)})`;
}

/** Text with its hidden parts marked, or plain, depending on the reveal switch. */
function shown(text: string): HTMLElement {
  const revealOn = byId<HTMLInputElement>("reveal-toggle").checked;
  if (!revealOn) return el("pre", { class: "landing-text", text });
  return el("pre", { class: "landing-text" }, reveal(text).map((s) =>
    s.hidden === false ? document.createTextNode(s.text) : el("mark", { class: `hidden-${s.hidden}`, text: s.text, title: `hidden from a person: ${s.hidden}` })));
}

/** Where each overlay of the attack lands, from a preview. */
export function renderLanding(preview: PreviewResponse): void {
  const blocks: HTMLElement[] = [];
  const describe = (o: Overlay): string => {
    switch (o.kind) {
      case "ticket": return `The ticket's ${o.field} (${o.position})`;
      case "new-attachment": return `A new attachment, ${o.attachmentId} ${o.filename} (${o.mediaType})`;
      case "attachment": return `Added to attachment ${o.attachmentId} (${o.position})`;
      case "order-note": return "The delivery note lookup_order will return — only if the model looks the order up";
      case "community-answer": return `A community answer from "${o.author}" in search results — only if the model searches`;
    }
  };
  for (const o of preview.overlays) {
    blocks.push(el("div", { class: "landing" }, [el("div", { class: "landing-where", text: describe(o) }), shown(o.text)]));
  }
  if (preview.chatMessage !== null) {
    blocks.push(el("div", { class: "landing" }, [el("div", { class: "landing-where", text: "The customer's live-chat message" }), shown(preview.chatMessage)]));
    preview.followUps.forEach((f, i) =>
      blocks.push(el("div", { class: "landing" }, [el("div", { class: "landing-where", text: `Turn ${i + 2} of the conversation` }), shown(f)])));
  }
  if (preview.ticket) {
    blocks.push(el("div", { class: "landing" }, [
      el("div", { class: "landing-where", text: "The whole ticket body as the model will read it" }),
      shown(preview.ticket.body),
    ]));
  }
  byId("studio-landing").replaceChildren(...(blocks.length > 0 ? blocks : [el("p", { class: "muted", text: "No attack: the ticket is exactly as seeded." })]));
}

/** The "write your own" editor: fills it with the selected attack as a starting point. */
export function initEditor(onUse: (attack: unknown) => void, onError: (message: string) => void): void {
  const area = byId<HTMLTextAreaElement>("custom-attack");
  byId("custom-load").addEventListener("click", () => {
    const a = selectedAttack() ?? state.attacks[0];
    if (a) area.value = JSON.stringify({ ...a, id: "my-attack" }, null, 2);
  });
  byId("custom-use").addEventListener("click", () => {
    try {
      onUse(JSON.parse(area.value));
    } catch (error: unknown) {
      onError(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
