/**
 * stdio.ts — serves the tool MCP server over standard input and output.
 *
 * This is how the lab talks to its tools: the app spawns this file as a
 * child process and speaks MCP over its stdin and stdout. The process
 * boundary is real — the app cannot read the shop's data, and cannot get
 * past the permission layer, except by asking this process, over the
 * protocol, for one of six tools.
 *
 * You can also run it by hand for MCP Inspector:
 *
 *   npx @modelcontextprotocol/inspector npx tsx tool-server/stdio.ts
 *
 * (Inspector sends no lab session, so the permission layer treats it as
 * the strictest case: only the public help search works. See session.ts.)
 *
 * ---------------------------------------------------------------------------
 * The one rule: never write to stdout
 * ---------------------------------------------------------------------------
 *
 * Over stdio, stdout IS the protocol connection. Every byte on it must be
 * a JSON-RPC message. A single stray `console.log` — a debug line, a
 * startup banner — corrupts the stream, and the client sees a parse error
 * with no hint of where it came from.
 *
 * So everything human-readable goes to stderr: the startup line, errors,
 * the node:sqlite ExperimentalWarning (Node puts that on stderr already).
 * The app captures this process's stderr and shows it in its activity
 * log, which is how a missing database becomes a readable message rather
 * than a silent failure.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DatabaseMissingError, openDatabase } from "./db.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./mcp-server.js";

// Open the database before serving anything, so a missing file stops the
// process at once with the fix in the message — rather than starting
// cleanly and failing on the first tool call, further from the cause.
try {
  openDatabase();
} catch (error: unknown) {
  if (error instanceof DatabaseMissingError) {
    console.error(`[${SERVER_NAME}] ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const handle = serveStdio(createServer, {
  // Failures that belong to no particular request — a malformed frame, a
  // transport error. There is nowhere to return them to, so: stderr.
  onerror(error) {
    console.error(`[${SERVER_NAME}] ${error.message}`);
  },
});

console.error(
  `[${SERVER_NAME} ${SERVER_VERSION}] serving six tools over stdio; shop data opened read-only. ` +
    "Protocol on stdout; diagnostics here on stderr.",
);

// Close the transport cleanly when the parent stops us, so an in-flight
// response is not cut off half-written.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
