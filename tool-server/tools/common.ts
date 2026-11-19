/**
 * common.ts — pieces several tools share: lenient ids, money, text caps.
 *
 * Sits beside types.ts at the bottom of the tool graph: definitions import
 * from here, and this file imports nothing from definitions/ or the
 * registry, so no cycle can form.
 *
 * ---------------------------------------------------------------------------
 * Lenient arguments
 * ---------------------------------------------------------------------------
 *
 * Clients do not always send what the schema asks for. A customer writes
 * "ta 20431"; a small model copies it as-is; MCP Inspector's CLI turns
 * `order_id=20431` into the NUMBER 20431. Rejecting those is technically
 * correct and practically useless — it costs a retry a small model may
 * not manage, and in this lab a failed lookup would look like a model
 * failing the task when it was the tool being fussy.
 *
 * So ids are tidied BEFORE validation, with `z.preprocess`, which leaves
 * the advertised JSON Schema unchanged: clients are still told the right
 * format, they are just not punished for an unambiguous near miss. A value
 * that does not tidy into the format is passed through untouched, to fail
 * with a message saying what the format is.
 *
 * ---------------------------------------------------------------------------
 * Text caps
 * ---------------------------------------------------------------------------
 *
 * Untrusted text reaches the model verbatim (see types.ts for why), but
 * each free-text field is capped so one oversized attachment cannot push
 * the rest of the turn out of the context window — where Ollama would
 * drop it silently. The cap is stated in the text, so a truncation is
 * visible to the model and to anyone reading the log.
 */

import { z } from "zod";

/** The most characters of one free-text field a model is shown. */
export const MAX_FIELD_CHARS = 2000;

/** Cuts text to MAX_FIELD_CHARS and says how much was left out. */
export function capped(text: string): string {
  if (text.length <= MAX_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_FIELD_CHARS)}\n[… ${text.length - MAX_FIELD_CHARS} more characters not shown]`;
}

/**
 * Tidies an id to `PREFIX-digits`, padding the digits to `width`.
 *
 * "ta 20431", "TA20431", "20431" and 20431 all become "TA-20431";
 * "t1002" becomes "T-1002"; "c7" becomes "C-007". Anything that is not
 * an optional prefix plus digits comes back trimmed and unchanged.
 */
export function tidyId(raw: unknown, prefix: string, width: number): unknown {
  if (typeof raw !== "string" && typeof raw !== "number") return raw;
  const text = String(raw).trim();
  const match = new RegExp(`^(?:${prefix})?[\\s#-]*(\\d{1,${width}})$`, "i").exec(text);
  return match?.[1] ? `${prefix}-${match[1].padStart(width, "0")}` : text;
}

/** An id argument: tidied, then checked against its format. */
export function idSchema(prefix: string, width: number, example: string) {
  return z.preprocess(
    (v) => tidyId(v, prefix, width),
    z.string().regex(new RegExp(`^${prefix}-\\d{${width}}$`), `Use an id like ${example}.`),
  );
}

/** Accepts "3" for 3. */
export function lenientNumber<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (v) => (typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : v),
    schema,
  );
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 6495 → "$64.95". The only place cents become dollars. */
export function money(cents: number): string {
  return dollars.format(cents / 100);
}

/** Adds overlay text to a base string, as the overlay's position says. */
export function placed(base: string, text: string, position: "append" | "prepend" | "replace", separator: string): string {
  if (position === "replace") return text;
  if (base === "") return text;
  return position === "append" ? `${base}${separator}${text}` : `${text}${separator}${base}`;
}

/**
 * Normalises an email address for comparison: trimmed and lower-cased.
 * Nothing cleverer — a lookalike such as `exampIe.com` (capital I) must
 * stay different, which is the point of comparing strictly.
 */
export function normaliseEmail(address: string): string {
  return address.trim().toLowerCase();
}
