/**
 * defenses.ts — the defense panel: one switch per layer, each labeled with its strength.
 *
 * Five layers are toggles. Privilege separation is a MODE switch instead
 * — Direct or Separated — because it changes the shape of the pipeline
 * rather than adding a filter to it, and a toggle among filters would
 * misdescribe it. A stack picker sets every switch to one of the arena's
 * named stacks, so a reader can reproduce any row of the results table.
 *
 * Every layer shows its strength badge (soft, medium, hard) and its one
 * honest sentence. When everything is off, the panel says, plainly, that
 * this is the undefended assistant — the lab's default, never mistaken for
 * a protected one.
 */

import { byId, el, fill } from "./dom.js";
import { ALL_OFF, state } from "./state.js";
import type { DefenseId } from "./types.js";

/** Which named stack the current switches match, or "custom". */
function matchingStack(): string {
  const stacks = state.meta?.stacks ?? {};
  for (const [name, ids] of Object.entries(stacks)) {
    const on = Object.entries(state.defenses).filter(([, v]) => v).map(([k]) => k).sort();
    if (JSON.stringify(on) === JSON.stringify([...ids].sort())) return name;
  }
  return "custom";
}

/** Redraws the panel from state. */
export function renderDefenses(onChange: () => void): void {
  const meta = state.meta;
  if (!meta) return;
  state.stack = matchingStack();

  const set = (id: DefenseId, on: boolean) => {
    state.defenses = { ...state.defenses, [id]: on };
    renderDefenses(onChange);
    onChange();
  };

  const toggles = meta.layers.filter((l) => l.id !== "privilege-separation").map((layer) => {
    const box = el("input", { attrs: { type: "checkbox", id: `def-${layer.id}` } });
    box.checked = state.defenses[layer.id];
    box.addEventListener("change", () => set(layer.id, box.checked));
    return el("label", { class: `defense ${state.defenses[layer.id] ? "on" : ""}`, attrs: { for: `def-${layer.id}` } }, [
      box,
      el("span", { class: "defense-name", text: layer.name }),
      el("span", { class: `strength strength-${layer.strength}`, text: layer.strength }),
      el("span", { class: "defense-summary", text: layer.summary }),
    ]);
  });

  const separation = meta.layers.find((l) => l.id === "privilege-separation");
  const mode = (value: boolean, text: string) => {
    const radio = el("input", { attrs: { type: "radio", name: "pipeline-mode", id: `mode-${value}` } });
    radio.checked = state.defenses["privilege-separation"] === value;
    radio.addEventListener("change", () => set("privilege-separation", value));
    return el("label", { class: "mode", attrs: { for: `mode-${value}` } }, [radio, el("span", { text })]);
  };

  const stackSelect = el("select", { attrs: { id: "stack-select", "aria-label": "Named stack" } }, [
    ...Object.keys(meta.stacks).map((name) => el("option", { text: name, attrs: { value: name } })),
    el("option", { text: "custom", attrs: { value: "custom", disabled: "" } }),
  ]);
  stackSelect.value = state.stack;
  stackSelect.addEventListener("change", () => {
    const ids = meta.stacks[stackSelect.value] ?? [];
    state.defenses = { ...ALL_OFF };
    for (const id of ids) state.defenses[id] = true;
    renderDefenses(onChange);
    onChange();
  });

  const anyOn = Object.values(state.defenses).some(Boolean);
  fill(byId("defense-panel"), [
    el("div", { class: "stack-row" }, [el("span", { class: "muted", text: "Stack" }), stackSelect]),
    anyOn ? null : el("p", { class: "undefended", text: "All layers off: this is the undefended assistant." }),
    ...toggles,
    separation ? el("div", { class: "defense mode-row" }, [
      el("span", { class: "defense-name", text: separation.name }),
      el("span", { class: `strength strength-${separation.strength}`, text: separation.strength }),
      el("span", { class: "modes" }, [mode(false, "Direct"), mode(true, "Separated")]),
      el("span", { class: "defense-summary", text: separation.summary }),
    ]) : null,
  ]);
}
