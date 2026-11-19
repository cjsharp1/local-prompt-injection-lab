/**
 * reveal.ts — makes hidden content visible, without ever rendering it.
 *
 * Several attacks hide their instruction where a person reading the email
 * would never see it: an HTML comment, a display:none block, white
 * one-pixel text, zero-width characters between letters. A model reading
 * the source sees all of it. "Reveal hidden content" in the Attack studio
 * shows the reader what the model sees.
 *
 * It works ON THE TEXT. The HTML is never rendered, parsed into the page
 * or given to the browser as markup — it is searched with regular
 * expressions, and the result is a list of plain-text segments, some
 * marked "hidden", which the studio draws with textContent. An attack
 * that is hostile to the lab's own page gets nowhere.
 *
 * What it finds:
 *   HTML comments                     <!-- … -->
 *   elements hidden by inline style   display:none, visibility:hidden,
 *                                     font-size:0/1px, white or near-
 *                                     white color (#fff, #ffffff, white)
 *   zero-width characters             U+200B–U+200D, U+2060, U+FEFF —
 *                                     shown as ⟨ZWSP⟩ and friends
 *   Markdown comments                 [//]: # (…)
 */

/** One stretch of text, and whether a reader of the rendered email would see it. */
export interface Segment {
  text: string;
  hidden: false | "comment" | "style" | "zero-width" | "markdown-comment";
}

const ZERO_WIDTH: Record<string, string> = {
  "​": "⟨ZWSP⟩", "‌": "⟨ZWNJ⟩", "‍": "⟨ZWJ⟩", "⁠": "⟨WJ⟩", "﻿": "⟨BOM⟩",
};

/** Inline styles that hide an element from a person while leaving its text in the source. */
const HIDING_STYLE = /style\s*=\s*"[^"]*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*[01](px)?\b|color\s*:\s*(#fff\b|#ffffff\b|white\b))[^"]*"/i;

/** Splits text into visible and hidden segments. Never throws; plain text comes back as one visible segment. */
export function reveal(text: string): Segment[] {
  // Each pattern marks a hidden span; everything between them is visible.
  const patterns: Array<[RegExp, Segment["hidden"]]> = [
    [/<!--[\s\S]*?-->/g, "comment"],
    [/<(\w+)\b[^>]*>[\s\S]*?<\/\1>/g, "style"],
    [/^\[\/\/\]: # \(.*\)$/gm, "markdown-comment"],
  ];
  const marks: Array<{ start: number; end: number; kind: Segment["hidden"] }> = [];
  for (const [pattern, kind] of patterns) {
    for (const m of text.matchAll(pattern)) {
      if (kind === "style" && !HIDING_STYLE.test(m[0].slice(0, m[0].indexOf(">") + 1))) continue;
      const start = m.index ?? 0;
      if (marks.some((x) => start < x.end && start + m[0].length > x.start)) continue;
      marks.push({ start, end: start + m[0].length, kind });
    }
  }
  marks.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let at = 0;
  const pushText = (chunk: string, hidden: Segment["hidden"]) => {
    // Zero-width characters are hidden wherever they are: split them out.
    const parts = chunk.split(/([​-‍⁠﻿]+)/);
    for (const part of parts) {
      if (part === "") continue;
      if (/^[​-‍⁠﻿]+$/.test(part)) {
        segments.push({ text: [...part].map((c) => ZERO_WIDTH[c] ?? "⟨?⟩").join(""), hidden: "zero-width" });
      } else {
        segments.push({ text: part, hidden });
      }
    }
  };
  for (const m of marks) {
    if (m.start > at) pushText(text.slice(at, m.start), false);
    pushText(text.slice(m.start, m.end), m.kind);
    at = m.end;
  }
  if (at < text.length) pushText(text.slice(at), false);
  return segments;
}

/** Whether a text hides anything at all. */
export function hasHidden(text: string): boolean {
  return reveal(text).some((s) => s.hidden !== false);
}
