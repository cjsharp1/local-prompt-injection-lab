/**
 * ollama.ts — talks to the local model server, with plain fetch.
 *
 * Two calls: `chat()` sends a conversation (optionally with tools, or with
 * a JSON output format) to POST /api/chat; `listModels()` reads GET
 * /api/tags. That is the whole of the model side of this lab — the
 * assistant, the input classifier and the quarantined reader all go
 * through `chat()`, with the same model, because on a 4 GB GPU only one
 * model stays loaded and a switch costs a 5–8 second reload (measured).
 *
 * ---------------------------------------------------------------------------
 * No SDK, on purpose
 * ---------------------------------------------------------------------------
 *
 * Ollama has client libraries. This file does not use one, because the
 * point of the activity log is to show the request and response exactly
 * as they cross the wire — and a library's own types and defaults sit
 * between you and that. Here, the object logged is the object sent.
 *
 * ---------------------------------------------------------------------------
 * Three settings on every request, and why
 * ---------------------------------------------------------------------------
 *
 * Every request goes through `buildRequest()`, so these cannot be
 * forgotten on one call site:
 *
 *   think          OFF unless the user switches on "Show reasoning".
 *                  Qwen 3.5 "thinks" by default — measured on this
 *                  machine, "What is 17 + 25?" took 914 characters of
 *                  reasoning and 42 seconds. So it is opt-in, per request,
 *                  and only for models whose /api/tags capabilities include
 *                  "thinking" (`supportsThinking`). That check is not
 *                  optional: sending `think: true` to llama3.2:3b is an
 *                  HTTP 400 ("does not support thinking"). Sending
 *                  `think: false` explicitly matters too: leaving it out
 *                  lets a thinking model think anyway.
 *
 *   stream: false  One JSON response per request. Streaming alongside tool
 *                  calls works, but it complicates the log for little gain
 *                  at these speeds. Listed as future work.
 *
 *   num_ctx        The context window, sent explicitly. Ollama's default
 *                  is 4096 tokens on most laptops, and when a conversation
 *                  outgrows the window Ollama SILENTLY DROPS whole older
 *                  messages — keeping the system prompt and the newest
 *                  message, reporting no error. A dropped message can be a
 *                  tool result — or the attack itself. The agent loop
 *                  watches prompt_eval_count to catch it.
 *
 * ---------------------------------------------------------------------------
 * Local models only
 * ---------------------------------------------------------------------------
 *
 * Ollama can also run "cloud" models — named with a ":cloud" suffix —
 * which send the conversation to ollama.com. Picking one would quietly
 * break this lab's promise that nothing leaves the machine — not the
 * tickets, not the attack payloads, not the planted secrets. So
 * `listModels()` leaves them out, and `chat()` refuses one by name before
 * any request is made. That holds even if Ollama's own local-only switch
 * (OLLAMA_NO_CLOUD) is off, because that switch is outside this repo.
 */

// --- Wire types: what Ollama sends and receives ---------------------------------

/** A tool call the model asked for. `id` and `index` are present in practice. */
export interface OllamaToolCall {
  id?: string;
  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
}

/** One message in the conversation. */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  /** On a "tool" message: which tool produced this result. */
  tool_name?: string;
  /** The model's reasoning, present only when the request set think: true. */
  thinking?: string;
}

/** A tool, described the way Ollama wants it: a JSON Schema function. */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Exactly what goes over the wire to POST /api/chat. */
export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  /** A JSON Schema the reply must match. Suppresses tool calls — see reply-format.ts. */
  format?: Record<string, unknown>;
  think: boolean;
  stream: false;
  options: {
    num_ctx: number;
    temperature?: number;
    seed?: number;
  };
}

/** What POST /api/chat returns when stream is false. Durations in nanoseconds. */
export interface ChatResponse {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

/** A locally installed model, as the picker, health check and results header need it. */
export interface LocalModel {
  name: string;
  /**
   * The model file's content digest. Recorded with every arena result: a
   * re-pulled model with the same name can behave differently, and the
   * digest is what says whether two results came from the same weights.
   */
  digest: string;
  parameterSize: string;
  quantization: string;
  sizeBytes: number;
  /** e.g. ["completion", "tools", "thinking"] — from /api/tags. */
  capabilities: string[];
  supportsTools: boolean;
  /** Whether `think: true` may be sent. False means it would be an HTTP 400. */
  supportsThinking: boolean;
}

/**
 * The two models this lab compares. Both are measured in the model eval
 * and the arena; MODEL in .env picks which one the UI starts with.
 */
export const COMPARED_MODELS = ["qwen3.5:4b", "llama3.2:3b"] as const;

// --- Errors, each a class so callers match on type, not message text -------------

/** Nothing is listening at OLLAMA_URL — Ollama is not running. */
export class OllamaUnreachableError extends Error {
  override name = "OllamaUnreachableError";
  constructor(public readonly url: string) {
    super(`Cannot reach Ollama at ${url}. Is it running? Start the Ollama app, or run \`ollama serve\`.`);
  }
}

/** The named model is not installed. */
export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";
  constructor(public readonly model: string) {
    super(`The model "${model}" is not installed. Run:  ollama pull ${model}`);
  }
}

/** A cloud model was requested — refused before anything is sent. */
export class RemoteModelError extends Error {
  override name = "RemoteModelError";
  constructor(public readonly model: string) {
    super(
      `"${model}" is a cloud model: it runs on ollama.com, so the conversation — ` +
      "with every ticket, attack payload and planted secret in it — would leave this machine. This lab only uses local models.",
    );
  }
}

/** Ollama answered with an HTTP error not covered above. */
export class OllamaHttpError extends Error {
  override name = "OllamaHttpError";
  constructor(public readonly status: number, public readonly body: string) {
    super(`Ollama returned HTTP ${status}: ${body}`);
  }
}

// --- Configuration ----------------------------------------------------------------

/** Settings from .env, with the same defaults as .env.example. */
export function ollamaConfig(): { url: string; model: string; numCtx: number } {
  return {
    url: (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: process.env.MODEL || "qwen3.5:4b",
    numCtx: Number(process.env.NUM_CTX || 8192),
  };
}

/**
 * Whether a model runs remotely rather than here.
 *
 * Ollama names cloud models with a ":cloud" suffix (some older tags used
 * "-cloud"). A `remote_*` field on a /api/tags entry is treated as remote
 * too — it could not be observed on this project's machine, which has
 * cloud disabled, so the check errs towards refusing.
 */
export function isRemoteModel(name: string, entry?: Record<string, unknown>): boolean {
  if (/[:-]cloud$/i.test(name)) return true;
  return entry !== undefined && Object.keys(entry).some((k) => k.startsWith("remote_") && entry[k]);
}

// --- Calls ------------------------------------------------------------------------

/**
 * fetch, with "nothing is listening" turned into OllamaUnreachableError.
 *
 * Node's fetch throws a TypeError ("fetch failed") whose `cause` carries
 * the socket error — ECONNREFUSED when Ollama is not running. Matched on
 * the error class and the cause's code, never on the message text.
 */
async function ollamaFetch(path: string, init?: RequestInit): Promise<Response> {
  const { url } = ollamaConfig();
  try {
    return await fetch(`${url}${path}`, init);
  } catch (error: unknown) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (error instanceof TypeError && (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND")) {
      throw new OllamaUnreachableError(url);
    }
    throw error;
  }
}

/**
 * Builds a request with the three fixed settings. Callers supply only what
 * varies: the model, the messages, and tools OR a format.
 */
export function buildRequest(parts: {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  format?: Record<string, unknown>;
  temperature?: number;
  seed?: number;
  /** Let the model reason before answering. Off unless asked for. */
  think?: boolean;
}): ChatRequest {
  const { numCtx } = ollamaConfig();
  return {
    model: parts.model,
    messages: parts.messages,
    ...(parts.tools ? { tools: parts.tools } : {}),
    ...(parts.format ? { format: parts.format } : {}),
    think: parts.think === true,
    stream: false,
    options: {
      num_ctx: numCtx,
      ...(parts.temperature !== undefined ? { temperature: parts.temperature } : {}),
      ...(parts.seed !== undefined ? { seed: parts.seed } : {}),
    },
  };
}

/** Sends one chat request and returns Ollama's response, unaltered. */
export async function chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
  if (isRemoteModel(request.model)) throw new RemoteModelError(request.model);

  const response = await ollamaFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const body = await response.text();
    // Ollama answers 404 with {"error":"model 'x' not found"} for a model
    // that is not pulled. The status code is the stable signal; the body
    // is kept for the log.
    if (response.status === 404) throw new ModelNotFoundError(request.model);
    throw new OllamaHttpError(response.status, body);
  }
  return (await response.json()) as ChatResponse;
}

/** Installed models, local ones only. */
export async function listModels(): Promise<LocalModel[]> {
  const response = await ollamaFetch("/api/tags");
  if (!response.ok) throw new OllamaHttpError(response.status, await response.text());

  const body = (await response.json()) as { models?: Array<Record<string, unknown>> };
  return (body.models ?? [])
    .filter((m) => !isRemoteModel(String(m.name ?? ""), m))
    .map((m) => {
      const details = (m.details ?? {}) as Record<string, unknown>;
      const capabilities = Array.isArray(m.capabilities) ? m.capabilities.map(String) : [];
      return {
        name: String(m.name ?? ""),
        parameterSize: String(details.parameter_size ?? ""),
        quantization: String(details.quantization_level ?? ""),
        digest: String(m.digest ?? ""),
        sizeBytes: Number(m.size ?? 0),
        capabilities,
        supportsTools: capabilities.includes("tools"),
        supportsThinking: capabilities.includes("thinking"),
      };
    });
}

/** The Ollama server's version, or throws OllamaUnreachableError. */
export async function ollamaVersion(): Promise<string> {
  const response = await ollamaFetch("/api/version");
  if (!response.ok) throw new OllamaHttpError(response.status, await response.text());
  return String(((await response.json()) as { version?: unknown }).version ?? "unknown");
}

// --- Reading a response -------------------------------------------------------------

/** Generation speed: the local stand-in for a cost column. Null if not reported. */
export function tokensPerSecond(response: ChatResponse): number | null {
  if (!response.eval_count || !response.eval_duration) return null;
  return Math.round((response.eval_count / response.eval_duration) * 1e9 * 10) / 10;
}

/** Nanoseconds to whole milliseconds. */
export function ms(nanoseconds: number | undefined): number {
  return Math.round((nanoseconds ?? 0) / 1e6);
}
