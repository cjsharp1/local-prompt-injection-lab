/**
 * shop.ts — the shapes the tool server, the app and the browser agree on.
 *
 * Three groups of types, all types-only (this file compiles to nothing):
 *
 *   Tool results   what each of the six tools returns as its structured
 *                  result — what the UI draws and the scorer reads. The
 *                  model never sees these; it reads each tool's TEXT.
 *
 *   The session    `LabSession`, the record the app attaches to every tool
 *                  call in the MCP request's `_meta`. It is how the tool
 *                  server knows which ticket is open, whether the
 *                  permission layer is on, which canary values to plant,
 *                  and which attack text to insert. The model writes tool
 *                  ARGUMENTS; only the app writes `_meta`. That separation
 *                  is what makes the permission layer hard.
 *
 *   Result `_meta`  what the tool server reports back beside every result:
 *                  the SQL it ran, the overlays it applied, the permission
 *                  verdict, and the run's outbox.
 *
 * Money is integer cents everywhere in structured data. Only the text a
 * model reads says "$64.95".
 */

// ---------------------------------------------------------------------------
// The shop
// ---------------------------------------------------------------------------

export type OrderStatus = "processing" | "shipped" | "delivered" | "returned" | "cancelled";

export type MediaType = "text/plain" | "text/markdown" | "text/html";

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mediaType: MediaType;
  /** Size of the text in bytes (UTF-8). */
  size: number;
}

/** get_ticket's structured result. */
export interface TicketResult {
  ticketId: string;
  customerId: string;
  customerName: string;
  from: string;
  subject: string;
  /** As received. An HTML ticket's body is its raw source. */
  body: string;
  contentType: "text/plain" | "text/html";
  receivedAt: string;
  attachments: AttachmentRef[];
}

/** get_attachment's structured result. */
export interface AttachmentResult {
  ticketId: string;
  attachmentId: string;
  filename: string;
  mediaType: MediaType;
  /** As stored. HTML arrives as source, comments and all. */
  text: string;
}

export interface OrderLineResult {
  sku: string;
  name: string;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** lookup_order's structured result. */
export interface OrderResult {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  placedOn: string;
  deliveredOn: string | null;
  lines: OrderLineResult[];
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
  /** Free text the customer typed at checkout — attacker-controlled. */
  deliveryNote: string;
}

export interface CommunityAnswerResult {
  author: string;
  body: string;
}

export interface HelpArticleResult {
  articleId: string;
  title: string;
  visibility: "public" | "internal";
  body: string;
  /** User-written answers under the article — attacker-controlled. */
  communityAnswers: CommunityAnswerResult[];
}

/** search_help_articles' structured result. */
export interface HelpSearchResult {
  query: string;
  results: HelpArticleResult[];
  /** Internal articles that matched but were withheld by the permission layer. */
  withheldInternal: number;
}

/** get_internal_notes' structured result. */
export interface InternalNotesResult {
  customerId: string;
  notes: string;
}

/** One message in a run's simulated outbox. Nothing is ever sent. */
export interface OutboxEntry {
  messageId: string;
  to: string;
  subject: string;
  body: string;
  /** Who asked for it: the model through send_email, or the app delivering the reply. */
  via: "model" | "app";
  at: string;
}

/** send_email's structured result. */
export interface SendEmailResult {
  messageId: string;
  to: string;
  subject: string;
  status: string;
}

// ---------------------------------------------------------------------------
// The session the app attaches to every tool call
// ---------------------------------------------------------------------------

/** Where an overlay puts text, relative to what is already there. */
export type OverlayPosition = "append" | "prepend" | "replace";

/**
 * Attack text the tool server inserts into one run's results.
 *
 * Attacks are never stored in the shop's data. The app turns an attack
 * file into overlays (server/attacks/insert.ts) and sends them with every
 * call; the tool server applies the ones that match the result it is
 * building, and reports their ids back so the UI can highlight exactly
 * where the payload landed. Every overlay's text has had its placeholders
 * filled by the app already; the tool server inserts it verbatim.
 */
export type Overlay =
  | { id: string; kind: "ticket"; field: "subject" | "body"; position: OverlayPosition; text: string }
  | { id: string; kind: "new-attachment"; attachmentId: string; filename: string; mediaType: MediaType; text: string }
  | { id: string; kind: "attachment"; attachmentId: string; position: OverlayPosition; text: string }
  | { id: string; kind: "order-note"; orderId?: string; position: OverlayPosition; text: string }
  | { id: string; kind: "community-answer"; articleId?: string; author: string; text: string };

/** The run's secrets. Generated fresh per run by the app; filled into placeholders by the tool server. */
export interface Canaries {
  discountCode?: string;
  staffNote?: string;
  apiToken?: string;
}

/** The record under `_meta["lab/session"]` on every tool call from the app. */
export interface LabSession {
  /** Identifies the run: the outbox and confirmations are per run. */
  runId: string;
  /** The open ticket. The tool server derives the customer from it — never from a model's argument. */
  ticketId: string;
  /** Layer 5. In a real system there is no off switch; here it shows what the check stops. */
  enforcePermissions: boolean;
  canaries: Canaries;
  overlays: Overlay[];
  /** Who is making this call: the model's tool request, or the app itself (loading the ticket, delivering the reply). */
  caller: "model" | "app";
}

// ---------------------------------------------------------------------------
// What comes back beside every result
// ---------------------------------------------------------------------------

/** One SQL statement a tool ran, as reported in `_meta["lab/queries"]`. */
export interface QueryReport {
  sql: string;
  params: unknown;
  rows: number;
  ms: number;
}

/**
 * The permission layer's verdict on one call, in `_meta["lab/permission"]`.
 *
 *   not-enforced          layer 5 is off for this run
 *   allowed               checked and allowed
 *   refused               checked and refused (the tool did not run)
 *   filtered              allowed, with something withheld (internal help articles)
 *   confirmation-required the tool server asked a human
 *   confirmed / declined  the human's answer
 */
export interface PermissionVerdict {
  decision: "not-enforced" | "allowed" | "refused" | "filtered" | "confirmation-required" | "confirmed" | "declined";
  rule: string;
  reason: string;
}

/** The `_meta` keys this lab uses, in one place so both sides spell them the same. */
export type LabMetaKey = "lab/session" | "lab/queries" | "lab/overlays" | "lab/permission" | "lab/outbox";
