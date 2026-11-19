/**
 * dom.ts — the only way this UI makes elements: `el()`, with textContent.
 *
 * Every piece of text on screen in this lab may be hostile. Attack
 * payloads, model replies, tool results, the shop's own data with an
 * attack planted in it — all of it is rendered through `el(…, { text })`,
 * which sets `textContent`. Nothing anywhere in public/ uses innerHTML, so
 * an HTML-email attack is shown as its source, never rendered, and a
 * payload that says <script> is just eleven characters.
 *
 * That is one of the lab's invariants (CLAUDE.md). This file is how it is
 * kept: there is no helper here that would let a caller do otherwise.
 */

/** A child: a node, a string (becomes a text node), or nothing. */
export type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Creates an element with text and children — never via innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replaces a node's children, skipping the empty ones — so panels can write `cond ? el(…) : null`. */
export function fill(target: HTMLElement, children: Child[]): void {
  target.replaceChildren(...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false));
}

/** Looks up a required element by id, failing loudly if index.html changed. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html has no #${id}`);
  return node as T;
}

/** "14:05:09" — for log rows. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour12: false });
}

/** "$64.95" from dollars, or "none". */
export function dollars(amount: number | null): string {
  return amount === null ? "none" : `$${amount.toFixed(2)}`;
}
