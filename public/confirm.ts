/**
 * confirm.ts — the dialog a person answers when the tool server asks.
 *
 * With the permission layer on, reading a customer's staff notes needs a
 * person's confirmation — asked for by the TOOL SERVER, through MCP, so a
 * model cannot answer it. In the UI the person is you: the run streams a
 * `confirm` event, this dialog shows the request, and your answer goes
 * back through POST /api/confirm. Two minutes without an answer counts as
 * a decline on the server.
 *
 * ---------------------------------------------------------------------------
 * The backdrop click — read before changing
 * ---------------------------------------------------------------------------
 *
 * A click on the dimmed area outside the dialog declines. The obvious way
 * to detect that — `event.target === dialog` — also fires for clicks on
 * the dialog's own padding, because the padding belongs to the <dialog>
 * element itself. So the check compares the click's position with the
 * dialog's box instead: only a click OUTSIDE the box is a backdrop click.
 * Keyboard "clicks" (Enter on a button) report position 0,0, so they are
 * ignored here and handled by the buttons themselves.
 */

import { byId } from "./dom.js";

/** Shows the request and resolves with the person's answer. */
export function askPerson(message: string): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>("confirm-dialog");
  byId("confirm-message").textContent = message;

  return new Promise((resolve) => {
    const finish = (allow: boolean) => {
      dialog.removeEventListener("click", onBackdrop);
      byId("confirm-allow").onclick = null;
      byId("confirm-decline").onclick = null;
      dialog.close();
      resolve(allow);
    };
    const onBackdrop = (event: MouseEvent) => {
      if (event.clientX === 0 && event.clientY === 0) return;
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (outside) finish(false);
    };
    byId("confirm-allow").onclick = () => finish(true);
    byId("confirm-decline").onclick = () => finish(false);
    dialog.addEventListener("click", onBackdrop);
    dialog.addEventListener("cancel", () => finish(false), { once: true });
    dialog.showModal();
  });
}
