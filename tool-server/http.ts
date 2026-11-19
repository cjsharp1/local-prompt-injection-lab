/**
 * http.ts — serves the tool MCP server over Streamable HTTP, on port 3301.
 *
 * Run it with:  npm run tool-server:http
 *
 * The lab does not need this — the app talks to the tool server over
 * stdio. This entry point exists so other MCP clients can connect to the
 * same six tools without starting the lab: MCP Inspector, for instance,
 * pointed at http://127.0.0.1:3301/mcp. Same factory, same data, same
 * permission rules; only the transport differs.
 *
 * ---------------------------------------------------------------------------
 * Four rules, each one load-bearing
 * ---------------------------------------------------------------------------
 *
 * 1. Bound to 127.0.0.1. Listening on every interface would put the tools
 *    — including send_email and the staff notes — on the local network.
 *
 * 2. Localhost Host and Origin checks on every request. Binding to
 *    127.0.0.1 is not enough on its own: a web page you visit can make
 *    your browser POST to a local port, and a DNS name can be made to
 *    resolve to 127.0.0.1. The SDK's own validators are used, because a
 *    hand-rolled one is easy to get subtly wrong (IPv6 brackets, port
 *    suffixes, a missing header).
 *
 * 3. `/mcp` is mounted BEFORE any body parser. The MCP adapter reads the
 *    raw request body itself; a parser like express.json() that ran first
 *    would drain the stream and leave it nothing. This server has no JSON
 *    routes, so there is no parser at all — but if one is ever added, it
 *    goes after /mcp.
 *
 * 4. `responseMode: "auto"`, not "json". "json" drops every message except
 *    the final response. These tools send nothing mid-call (their reports
 *    ride in the result's _meta), but "auto" keeps the protocol whole.
 *
 * Stateless: `createMcpHandler` calls the factory for every request. The
 * only state that survives between requests is at module level in the
 * tool server — the outbox and the confirmation key — which is why the
 * key cannot live inside the factory (mcp-server.ts explains).
 *
 * The human-confirmation round trip works over HTTP only for clients that
 * negotiate the 2026-07-28 protocol. A legacy (2025-era) HTTP connection
 * carries no client capabilities, so the server cannot ask for input and
 * the call fails closed — refused, never allowed. Measured in step 0.
 *
 * Unlike stdio.ts, stdout here is just a terminal, so console.log is fine.
 */

import "dotenv/config"; // read TOOL_SERVER_PORT from .env, if there is one
import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { DatabaseMissingError, openDatabase } from "./db.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./mcp-server.js";

const PORT = Number(process.env.TOOL_SERVER_PORT || 3301);
const HOST = "127.0.0.1";

// Fail at startup, with the fix, if the shop has not been seeded.
try {
  openDatabase();
} catch (error: unknown) {
  if (error instanceof DatabaseMissingError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const mcpHandler = createMcpHandler(createServer, {
  responseMode: "auto",
  onerror(error) {
    console.error(`[${SERVER_NAME}] handler error: ${error.message}`);
  },
});

const mcpNodeHandler = toNodeHandler(mcpHandler, {
  onerror(error) {
    console.error(`[${SERVER_NAME}] adapter error: ${error.message}`);
  },
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const app = express();

/**
 * The MCP endpoint. `app.all`, not `app.post`: Streamable HTTP also uses
 * GET (a standalone event stream) and DELETE (ending a session), and the
 * handler needs to see those to answer them correctly.
 */
app.all("/mcp", (req, res) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;

  const started = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} /mcp → ${res.statusCode} (${Date.now() - started} ms)`);
  });

  void mcpNodeHandler(req, res);
});

/** A plain answer for anyone who opens the port in a browser. */
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    `${SERVER_NAME} ${SERVER_VERSION}\n\n` +
      `This is an MCP server. Point an MCP client at http://${HOST}:${PORT}/mcp\n` +
      "There is nothing to see in a browser.\n",
  );
});

app.listen(PORT, HOST, (error?: Error) => {
  // Express 5 reports a failed listen (port already in use, say) by
  // passing the error to THIS callback — not by throwing. Ignore the
  // argument and the server announces itself, then exits silently.
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE"
      ? `Port ${PORT} is already in use — is another copy running? Stop it, or set TOOL_SERVER_PORT in .env.`
      : `Could not listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`${SERVER_NAME} ${SERVER_VERSION} — MCP over HTTP at http://${HOST}:${PORT}/mcp`);
  console.log("Shop data opened read-only. Localhost only.");
});
