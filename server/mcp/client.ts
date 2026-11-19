/**
 * client.ts — the app's connection to the tool server, over MCP and stdio.
 *
 * The app never reads the shop's data. It starts the tool server as a
 * CHILD PROCESS and speaks MCP to it over the child's stdin and stdout:
 * list the tools, call one, read the result. Everything the assistant
 * learns about the shop — and every permission check — happens on the
 * other side of that process boundary.
 *
 * ---------------------------------------------------------------------------
 * What this client adds to every call
 * ---------------------------------------------------------------------------
 *
 * The run's `LabSession`, under `_meta["lab/session"]`: the open ticket,
 * whether the permission layer is on, the canary values, the attack
 * overlays, and who is calling (the model's request, or the app itself).
 * The model chooses tool ARGUMENTS; this file — the app — is the only
 * thing that writes `_meta`. That separation is what lets the tool server
 * enforce "email only the ticket's customer" against a fact the model
 * cannot touch.
 *
 * And it unpacks what comes back beside each result: the SQL that ran,
 * the overlays that landed, the permission verdict, the run's outbox.
 *
 * ---------------------------------------------------------------------------
 * Human confirmation
 * ---------------------------------------------------------------------------
 *
 * With the permission layer on, get_internal_notes makes the tool server
 * ask for a person's confirmation (MCP's input-required round trip). The
 * SDK client fulfils that through the `elicitation/create` handler
 * registered here, then retries the call with the answer — all inside one
 * `callTool()`. The handler asks whatever `Confirmer` the current run
 * set: a real dialog in the UI, a prompt in the terminal, a scripted
 * "decline" in the arena. The default, with no confirmer, is decline.
 *
 * Two settings make that work (both measured in step 0, see
 * docs/verified-facts.md):
 *
 *   versionNegotiation "auto"   The 2.4 client defaults to the legacy
 *                               2025 protocol. "auto" negotiates
 *                               2026-07-28, where input-required is native.
 *   capabilities.elicitation    The tool server can only ask for input a
 *                               client says it can provide.
 *
 * Runs are sequential, so one confirmer at a time is enough: a run sets
 * it at the start and the next run replaces it.
 *
 * ---------------------------------------------------------------------------
 * Which command to spawn, and the child's stderr
 * ---------------------------------------------------------------------------
 *
 * Under `npm run dev` this file runs as TypeScript through tsx; after
 * `npm run build` it runs as JavaScript from dist/. The tool server has to
 * be started the same way, and this file's own extension says which world
 * we are in: `../../tool-server/stdio` + that extension is the right file
 * either way. `process.execPath` (the running Node) rather than "node",
 * "npx" or "tsx", because spawning those by name on Windows needs a shell.
 *
 * Over stdio the child's stdout is the protocol and its stderr is its only
 * voice. A missing database, a crash — they arrive on stderr, and each
 * line is handed to `onStderr`, which the app turns into a log row.
 *
 * Connected lazily, on first use, and kept. If the child exits, the next
 * call starts a new one.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import type { LabSession, OutboxEntry, PermissionVerdict, QueryReport } from "../../shared/shop.js";
import type { McpToolDefinition } from "../agent/tool-format.js";

/** How this app identifies itself in the MCP handshake. */
const CLIENT_NAME = "local-prompt-injection-lab";
const CLIENT_VERSION = "0.1.0";

/** Decides a confirmation request from the tool server. True means "allow". */
export type Confirmer = (request: { message: string }) => Promise<boolean>;

/** What one tool call produced, unpacked from the MCP result. */
export interface ToolCallOutcome {
  /** The text content: exactly what the model will read. */
  text: string;
  isError: boolean;
  /** The structured result for the UI and the scorer; null on error. */
  data: unknown;
  /** The SQL the tool server reported. */
  queries: QueryReport[];
  /** Ids of the attack overlays that landed in this result. */
  overlays: string[];
  /** Layer 5's verdict on the call (absent only if the server sent none, e.g. a malformed session). */
  permission: PermissionVerdict | undefined;
  /** The run's outbox as of this call. */
  outbox: OutboxEntry[];
  /** Whether a person was asked to confirm during this call, and what they said. */
  confirmation: "confirmed" | "declined" | undefined;
  elapsedMs: number;
}

/** The tool server could not be started or reached. */
export class ToolServerUnavailableError extends Error {
  override name = "ToolServerUnavailableError";
}

/** The command that starts the tool server, matching how THIS file is running. */
export function toolServerCommand(): { command: string; args: string[] } {
  const built = import.meta.url.endsWith(".js");
  const entry = fileURLToPath(new URL(`../../tool-server/stdio.${built ? "js" : "ts"}`, import.meta.url));
  return { command: process.execPath, args: built ? [entry] : ["--import", "tsx", entry] };
}

/** The first text block of an MCP result. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
      return String((block as { text?: unknown }).text ?? "");
    }
  }
  return "";
}

export class ToolServerClient {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private toolList: McpToolDefinition[] | undefined;
  /** The last thing the tool server said on stderr — the likeliest reason for a failure. */
  private lastStderr = "";
  /** Who decides confirmation requests for the current run. */
  private confirmer: Confirmer | undefined;
  /** What the confirmer said during the call in progress. */
  private lastConfirmation: "confirmed" | "declined" | undefined;

  constructor(private readonly onStderr: (line: string) => void = () => {}) {}

  /** Sets who answers the tool server's confirmation requests, for the next calls. */
  setConfirmer(confirmer: Confirmer | undefined): void {
    this.confirmer = confirmer;
  }

  /** Connects if needed. Concurrent callers share one attempt. */
  private async connection(): Promise<Client> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const { command, args } = toolServerCommand();
    const transport = new StdioClientTransport({ command, args, stderr: "pipe" });

    (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.lastStderr = line.trim();
        this.onStderr(line.trim());
      }
    });

    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: "auto" } },
    );

    // The tool server asks; the run's confirmer answers. No confirmer
    // means decline — the safe direction for a request to read staff notes.
    client.setRequestHandler("elicitation/create", async (request) => {
      const message = String((request.params as { message?: unknown }).message ?? "");
      const allowed = this.confirmer ? await this.confirmer({ message }) : false;
      this.lastConfirmation = allowed ? "confirmed" : "declined";
      return allowed ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });

    client.onclose = () => {
      // The child exited or the pipe broke. Forget it; the next call starts a fresh one.
      this.client = undefined;
      this.toolList = undefined;
    };

    try {
      await client.connect(transport);
    } catch (error: unknown) {
      const reason = this.lastStderr || (error instanceof Error ? error.message : String(error));
      throw new ToolServerUnavailableError(`The tool server did not start: ${reason}`);
    }
    this.client = client;
    return client;
  }

  /** The tool server's tools, as advertised. Cached for the connection's life. */
  async tools(): Promise<McpToolDefinition[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connection();
    const { tools } = await client.listTools();
    this.toolList = tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
    return this.toolList;
  }

  /** Calls one tool with the run's session attached, and unpacks the result. */
  async call(name: string, args: Record<string, unknown>, session: LabSession): Promise<ToolCallOutcome> {
    const client = await this.connection();
    const started = Date.now();
    this.lastConfirmation = undefined;
    const result = await client.callTool({ name, arguments: args, _meta: { "lab/session": session } });
    const isError = result.isError === true;
    const meta = (result._meta ?? {}) as Record<string, unknown>;

    return {
      text: textOf(result.content),
      isError,
      data: isError ? null : (result.structuredContent ?? null),
      queries: Array.isArray(meta["lab/queries"]) ? (meta["lab/queries"] as QueryReport[]) : [],
      overlays: Array.isArray(meta["lab/overlays"]) ? (meta["lab/overlays"] as string[]) : [],
      permission: meta["lab/permission"] as PermissionVerdict | undefined,
      outbox: Array.isArray(meta["lab/outbox"]) ? (meta["lab/outbox"] as OutboxEntry[]) : [],
      confirmation: this.lastConfirmation,
      elapsedMs: Date.now() - started,
    };
  }

  /** Stops the tool server. */
  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}
