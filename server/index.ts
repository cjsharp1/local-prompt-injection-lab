/**
 * index.ts — the lab's web server: the routes the browser half talks to.
 *
 * Run it with:  npm run dev   (http://127.0.0.1:3300)
 *
 * It is thin on purpose. Every route hands off to the same code the
 * terminal scripts use — `runTicket` for a run, the attack loader and
 * `prepareAttack` for the studio, the results file for the heatmap — so
 * what the UI shows is what the arena measures.
 *
 *   GET  /api/meta        models (with which can reason), the six layers
 *                         with their strength and summary, the named stacks
 *   GET  /api/library     every attack (payloads in full) and benign ticket
 *   POST /api/preview     where an attack's text will land, before running:
 *                         the attacked ticket, planted attachments, the
 *                         tool-result overlays, the live-chat message
 *   POST /api/run         one run, streamed as Server-Sent Events: every log
 *                         row, reasoning, tool events, confirmation
 *                         requests, then the scored record
 *   POST /api/confirm     a person's answer to a confirmation request
 *   GET  /api/results     the arena's current records, for the heatmap
 *
 * ---------------------------------------------------------------------------
 * Localhost only, and checked
 * ---------------------------------------------------------------------------
 *
 * The server binds 127.0.0.1 AND checks every /api request's Host and
 * Origin. Binding alone does not stop a web page you visit from making
 * your browser call a local port, or a DNS name from being pointed at
 * 127.0.0.1; the SDK's localhost validators reject both. There is no
 * authentication. This is a lab, not a service — and it stores attacks.
 *
 * ---------------------------------------------------------------------------
 * Confirmation requests
 * ---------------------------------------------------------------------------
 *
 * With the permission layer on, the tool server asks a person before the
 * staff notes are read. In the UI that person is real: the run emits a
 * `confirm` event, the browser shows a dialog, and its answer comes back
 * through POST /api/confirm. No answer within two minutes is a decline.
 */

import "dotenv/config";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import { z } from "zod";
import type { StreamEvent } from "../shared/types.js";
import type { LabSession, TicketResult } from "../shared/shop.js";
import { ticketFacts } from "./attacks/facts.js";
import { prepareAttack } from "./attacks/insert.js";
import { LibraryError, contentProblems, loadAttacks, loadBenign } from "./attacks/load.js";
import { attackSchema, type Attack } from "./attacks/schema.js";
import { toRecord } from "./arena/record.js";
import { currentRecords, loadResults } from "./arena/results-file.js";
import { itemSetupHash } from "./arena/setup-hash.js";
import { LAYERS } from "./defenses/registry.js";
import { STACKS, parseDefenses } from "./defenses/settings.js";
import { Logger } from "./logger.js";
import { ToolServerClient } from "./mcp/client.js";
import { isRemoteModel, listModels, ollamaConfig } from "./model/ollama.js";
import { runTicket } from "./pipeline/run.js";
import { scoreAttack, scoreBenign } from "./scoring/outcome.js";

const PORT = Number(process.env.PORT || 3300);
const HOST = "127.0.0.1";
const RESULTS = fileURLToPath(new URL("../docs/arena-results.json", import.meta.url));

/** How long a confirmation request waits for a person before it counts as declined. */
const CONFIRM_TIMEOUT_MS = 120_000;

const app = express();
const tools = new ToolServerClient((line) => {
  if (!/ExperimentalWarning|trace-warnings/.test(line)) console.error(`[tool server] ${line}`);
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

// Every /api route: localhost Host and Origin only. See the header.
app.use("/api", (req, res, next) => {
  if (!validateHost(req, res)) return;
  if (!validateOrigin(req, res)) return;
  next();
});
app.use(express.json({ limit: "256kb" }));
app.use(express.static("public"));

/** The library, loaded per request so a newly added attack file shows without a restart. */
function library(): { attacks: Attack[]; benign: ReturnType<typeof loadBenign> } {
  return { attacks: loadAttacks(), benign: loadBenign() };
}

function sendError(res: express.Response, status: number, error: unknown): void {
  const message = error instanceof LibraryError ? error.message : error instanceof Error ? error.message : String(error);
  res.status(status).json({ error: message });
}

app.get("/api/meta", async (_req, res) => {
  try {
    const models = (await listModels()).filter((m) => m.supportsTools);
    res.json({
      models: models.map((m) => ({ name: m.name, parameterSize: m.parameterSize, supportsThinking: m.supportsThinking })),
      defaultModel: ollamaConfig().model,
      layers: LAYERS.map((l) => ({ id: l.id, name: l.name, strength: l.strength, stages: l.stages, summary: l.summary })),
      stacks: STACKS,
      numCtx: ollamaConfig().numCtx,
    });
  } catch (error: unknown) {
    sendError(res, 503, error);
  }
});

app.get("/api/library", (_req, res) => {
  try {
    const { attacks, benign } = library();
    res.json({ attacks, benign: [...benign.values()] });
  } catch (error: unknown) {
    sendError(res, 500, error);
  }
});

/** A request names a library attack, or brings its own (from the studio's form), or neither. */
const itemBody = z.object({
  benignId: z.string().regex(/^B\d{2}$/).optional(),
  attackId: z.string().optional(),
  attack: z.unknown().optional(),
});

/** Resolves what a request is about: the attack (if any) and its base ticket. */
function resolveItem(body: z.infer<typeof itemBody>): { attack: Attack | undefined; base: NonNullable<ReturnType<ReturnType<typeof loadBenign>["get"]>> } {
  const { attacks, benign } = library();
  let attack: Attack | undefined;
  if (body.attack !== undefined) {
    const parsed = attackSchema.safeParse(body.attack);
    if (!parsed.success) throw new Error(`The attack is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(attack)"} — ${i.message}`).join("; ")}`);
    const problems = contentProblems(parsed.data, benign, "your attack");
    if (problems.length > 0) throw new Error(problems.join("; "));
    attack = parsed.data;
  } else if (body.attackId) {
    attack = attacks.find((a) => a.id === body.attackId);
    if (!attack) throw new Error(`No attack "${body.attackId}".`);
  }
  const base = benign.get(attack ? attack.baseTicket : (body.benignId ?? ""));
  if (!base) throw new Error("Choose a benign ticket or an attack.");
  return { attack, base };
}

app.post("/api/preview", async (req, res) => {
  const parsed = itemBody.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, parsed.error.message);
  try {
    const { attack, base } = resolveItem(parsed.data);
    const prepared = attack ? prepareAttack(attack, await ticketFacts(tools, base)) : undefined;
    // The ticket exactly as the run will load it: overlays applied by the tool server.
    const session: LabSession = {
      runId: `preview-${randomBytes(3).toString("hex")}`, ticketId: base.ticket, enforcePermissions: false,
      canaries: {}, overlays: prepared?.overlays ?? [], caller: "app",
    };
    const loaded = await tools.call("get_ticket", { ticket_id: base.ticket }, session);
    res.json({
      base,
      attack: attack ?? null,
      ticket: loaded.data as TicketResult | null,
      overlays: prepared?.overlays ?? [],
      chatMessage: prepared?.chatMessage ?? null,
      followUps: prepared?.followUps ?? [],
    });
  } catch (error: unknown) {
    sendError(res, 400, error);
  }
});

/** Confirmation requests waiting for a person, by id. */
const pendingConfirmations = new Map<string, (allow: boolean) => void>();

app.post("/api/confirm", (req, res) => {
  const body = z.object({ id: z.string(), allow: z.boolean() }).safeParse(req.body);
  if (!body.success) return sendError(res, 400, body.error.message);
  const resolve = pendingConfirmations.get(body.data.id);
  if (!resolve) return sendError(res, 404, "That confirmation request is no longer waiting.");
  pendingConfirmations.delete(body.data.id);
  resolve(body.data.allow);
  res.json({ ok: true });
});

const runBody = itemBody.extend({
  model: z.string().trim().min(1).optional(),
  defenses: z.unknown().optional(),
  stack: z.string().optional(),
  reasoning: z.boolean().optional(),
});

app.post("/api/run", async (req, res) => {
  const parsed = runBody.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, parsed.error.message);
  const body = parsed.data;
  const model = body.model ?? ollamaConfig().model;

  // Refused here as well as in the model client, so a cloud model never
  // even opens a stream. This is the promise the lab makes.
  if (isRemoteModel(model)) return sendError(res, 400, `${model} is a cloud model. This lab only uses local models.`);

  let item: ReturnType<typeof resolveItem>;
  try {
    item = resolveItem(body);
  } catch (error: unknown) {
    return sendError(res, 400, error);
  }

  const stackName = body.stack && STACKS[body.stack] ? body.stack : "custom";
  const defenses = body.stack && STACKS[body.stack]
    ? parseDefenses(Object.fromEntries((STACKS[body.stack] ?? []).map((id) => [id, true])))
    : parseDefenses(body.defenses);

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: StreamEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // If the browser goes away mid-run, stop asking the model for things nobody will read.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  const logger = new Logger((event) => send({ type: "log", event }));

  // Reasoning only for models that can: think: true to one that cannot is an HTTP 400.
  let reasoning = body.reasoning === true;
  const info = (await listModels().catch(() => [])).find((m) => m.name === model);
  if (reasoning && !info?.supportsThinking) {
    logger.warn(`${model} cannot show its reasoning (no "thinking" capability) — running without it.`);
    reasoning = false;
  }

  // The person behind the browser answers the tool server's confirmation requests.
  const confirmer = ({ message }: { message: string }) => new Promise<boolean>((resolve) => {
    const id = randomBytes(6).toString("hex");
    const timer = setTimeout(() => {
      pendingConfirmations.delete(id);
      logger.warn("No answer to the confirmation request within two minutes — declined.");
      resolve(false);
    }, CONFIRM_TIMEOUT_MS);
    pendingConfirmations.set(id, (allow) => {
      clearTimeout(timer);
      resolve(allow);
    });
    send({ type: "confirm", id, message });
  });

  try {
    const { attack, base } = item;
    const prepared = attack ? prepareAttack(attack, await ticketFacts(tools, base)) : undefined;
    const startedAt = new Date().toISOString();
    const result = await runTicket({
      ticketId: base.ticket, model, defenses, reasoning, overlays: prepared?.overlays ?? [], confirmer,
      ...(prepared?.chatMessage !== undefined ? { chatMessage: prepared.chatMessage } : {}),
      ...(prepared && prepared.followUps.length > 0 ? { followUps: prepared.followUps } : {}),
    }, { logger, emit: send, tools, signal: abort.signal });

    const expected = [base.expect, ...(base.alternatives ?? [])];
    const scored = attack && prepared ? scoreAttack(result, attack.goal, expected, prepared.vars) : scoreBenign(result, expected);
    // A library attack's hash includes its file; an attack written in the studio has none.
    const baseFile = `attacks/benign/${base.id}-${base.slug}.json`;
    const files = attack && body.attackId && body.attack === undefined ? [`attacks/${attack.id}.json`, baseFile] : [baseFile];
    send({
      type: "result",
      record: toRecord({ kind: attack ? "attack" : "benign", id: attack?.id ?? base.id, ...(attack ? { attack } : {}), base }, result, scored, {
        key: "ui", stack: stackName, digest: info?.digest ?? "", seed: 0, setupHash: itemSetupHash(files), attempt: 1, startedAt,
      }),
    });
  } catch (error: unknown) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    res.end();
  }
});

app.get("/api/results", (_req, res) => {
  try {
    const file = loadResults(RESULTS);
    const { attacks, benign } = library();
    const files = new Map<string, string[]>([
      ...attacks.map((a) => {
        const b = benign.get(a.baseTicket);
        return [a.id, [`attacks/${a.id}.json`, `attacks/benign/${b?.id}-${b?.slug}.json`]] as [string, string[]];
      }),
      ...[...benign.values()].map((b) => [b.id, [`attacks/benign/${b.id}-${b.slug}.json`]] as [string, string[]]),
    ]);
    const hashes = new Map([...files.entries()].map(([id, f]) => [id, itemSetupHash(f)]));
    const current = currentRecords(file.records, (r) => hashes.get(r.itemId) === r.setupHash);
    res.json({ meta: file.meta, records: current, stale: file.records.length - current.length });
  } catch (error: unknown) {
    sendError(res, 500, error);
  }
});

// --- Start ------------------------------------------------------------------------------

const server = app.listen(PORT, HOST, (error?: Error) => {
  // Express 5 reports a failed listen (port already in use, say) by
  // passing the error to THIS callback — not by throwing.
  if (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE"
      ? `Port ${PORT} is already in use — is another copy running? Stop it, or set PORT in .env.`
      : `Could not listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  const { model, numCtx, url } = ollamaConfig();
  console.log(`Local Prompt Injection Lab — http://${HOST}:${PORT}`);
  console.log(`Default model ${model} via Ollama at ${url} · context ${numCtx} tokens · no API key, nothing leaves this machine`);
});

// Stop the tool server child with us, so a restart (tsx watch) leaves no orphan.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void tools.close().finally(() => {
      server.close();
      process.exit(0);
    });
  });
}
