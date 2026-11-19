/**
 * results.ts — the arena heatmap: attack success by category and stack, beside the benign cost.
 *
 * One table per model. Rows are the defence stacks; columns are the
 * attack categories, each cell coloured by how often attacks in that
 * category succeeded under that stack. The last column is the BENIGN
 * success rate — how often legitimate tickets were still handled — drawn
 * as a bar right beside the attack numbers, so a stack that "wins" by
 * blocking everything is visibly a stack that also blocks the shop's
 * work. Errors are excluded from both rates, and counted separately.
 *
 * Clicking a cell lists its runs: item, seed, outcome, and the evidence.
 *
 * Read from GET /api/results — the arena's current records only (records
 * from an earlier setup are stale and left out). Before the arena has
 * run, the panel says so rather than showing an empty grid.
 */

import { byId, el } from "./dom.js";
import type { RunRecord } from "./types.js";

const STACK_ORDER = ["none", "prompt", "spotlight", "classifier", "output-filter", "tool-permissions", "privilege-separation", "soft", "all-but-separation", "everything"];

/** A red-to-green cell colour for an attack success share: high is bad. */
function heat(share: number): string {
  return `color-mix(in srgb, var(--bad) ${Math.round(share * 85)}%, var(--surface))`;
}

function listRuns(runs: RunRecord[], title: string): void {
  byId("results-detail").replaceChildren(
    el("div", { class: "results-detail-title", text: title }),
    el("ul", {}, runs.map((r) => {
      const o = r.outcome;
      const extra = o.kind === "blocked" || o.kind === "falsely-blocked" ? ` by ${o.layer} (${o.stage})` : "";
      return el("li", { text: `${r.itemId} · seed ${r.seed} · ${o.kind}${extra}${r.evidence?.where[0] ? ` · ${r.evidence.where[0]}` : ""}` });
    })),
  );
}

export async function renderResults(): Promise<void> {
  const target = byId("results-view");
  let data: { records: RunRecord[]; stale: number; meta: { updatedAt: string } };
  try {
    const response = await fetch("/api/results");
    data = await response.json() as typeof data;
  } catch {
    target.replaceChildren(el("p", { class: "muted", text: "Could not load the results." }));
    return;
  }
  if (data.records.length === 0) {
    target.replaceChildren(el("p", { class: "muted", text: "No arena results yet. Run `npm run arena` (an overnight run) or `npm run arena -- --quick` to try it." }));
    return;
  }

  const models = [...new Set(data.records.map((r) => r.model))].sort();
  const tables = models.map((model) => {
    const mine = data.records.filter((r) => r.model === model);
    const stacks = STACK_ORDER.filter((s) => mine.some((r) => r.stack === s));
    const categories = [...new Set(mine.filter((r) => r.itemKind === "attack").map((r) => r.category ?? "?"))].sort();
    const head = el("tr", {}, [el("th", { text: "Stack" }), ...categories.map((c) => el("th", { text: c })), el("th", { text: "Benign success" })]);
    const rows = stacks.map((stack) => {
      const cells = categories.map((category) => {
        const runs = mine.filter((r) => r.stack === stack && r.category === category && r.outcome.kind !== "error");
        const hits = runs.filter((r) => r.outcome.kind === "succeeded").length;
        const td = el("td", {
          class: "heat",
          text: runs.length === 0 ? "—" : `${Math.round((100 * hits) / runs.length)}%`,
          title: `${hits} of ${runs.length} attacks succeeded`,
        });
        if (runs.length > 0) {
          td.style.background = heat(hits / runs.length);
          td.addEventListener("click", () => listRuns(runs, `${model} · ${stack} · ${category}`));
        }
        return td;
      });
      const benign = mine.filter((r) => r.stack === stack && r.itemKind === "benign" && r.outcome.kind !== "error");
      const done = benign.filter((r) => r.outcome.kind === "completed").length;
      const share = benign.length === 0 ? 0 : done / benign.length;
      const bar = el("td", { class: "benign-cell", title: `${done} of ${benign.length} benign tickets completed` }, [
        el("span", { class: "benign-bar" }),
        el("span", { text: benign.length === 0 ? "—" : `${Math.round(share * 100)}%` }),
      ]);
      (bar.firstChild as HTMLElement).style.width = `${Math.round(share * 100)}%`;
      bar.addEventListener("click", () => listRuns(benign, `${model} · ${stack} · benign tickets`));
      return el("tr", {}, [el("th", { text: stack }), ...cells, bar]);
    });
    return el("div", { class: "results-model" }, [
      el("h3", { text: model }),
      el("table", { class: "heatmap" }, [el("thead", {}, [head]), el("tbody", {}, rows)]),
    ]);
  });

  target.replaceChildren(
    el("p", { class: "muted", text: `${data.records.length} runs · updated ${data.meta.updatedAt.slice(0, 16).replace("T", " ")}${data.stale > 0 ? ` · ${data.stale} stale records left out` : ""}. Cells: attacks that succeeded (darker is worse). Errors are in neither rate.` }),
    ...tables,
    el("div", { attrs: { id: "results-detail" } }),
  );
}
