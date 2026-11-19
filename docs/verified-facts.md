# Verified facts (step 0)

Checked on 2026-11-19 against installed packages, live runs and the
running Ollama server, not memory. Probe scripts were throwaway and
lived outside this repository. Every fact below is marked:

- **confirmed** — matches what PLAN.md assumed;
- **changed** — differs from the plan, which has been corrected;
- **pending** — can only be checked at a later step.

Machine: Windows 11, Node 24.4.1, 32 GB RAM, NVIDIA RTX A1000 laptop
GPU (4 GB VRAM). Ollama 0.40.16 with `OLLAMA_NO_CLOUD=1` set.

---

## Packages (npm, today)

| Package | Version |
|---|---|
| `@modelcontextprotocol/server` | 2.4.0 |
| `@modelcontextprotocol/client` | 2.4.0 |
| `@modelcontextprotocol/node` | 2.1.2 |
| `express` | 5.3.0 |
| `zod` | 4.6.7 |
| `dotenv` | 18.0.10 |
| `tsx` | 4.23.15 |
| `typescript` | 7.0.2 |
| `@types/node` (24 line) | 24.19.2 |
| `@types/express` | 5.0.6 |

**Confirmed.** Use `@types/node@^24` to match the Node target, not the
latest major.

---

## MCP: the session `_meta` (PLAN §3.3)

| Fact | Finding | Status |
|---|---|---|
| Client side | `client.callTool({ name, arguments, _meta: { "lab/session": {...} } })` is accepted by the 2.4 client | confirmed |
| Server side | The handler reads it as `ctx.mcpReq._meta["lab/session"]`, intact, as sent | **confirmed, run** |
| Transports | Identical over **stdio** and **Streamable HTTP**, in both the 2025-11-25 (legacy) and 2026-07-28 eras | confirmed |
| Who can write it | Only the MCP client, which is the app. The model produces tool arguments; it has no path to `_meta` | design, holds by construction |

---

## MCP: human confirmation (PLAN §7.5)

### What works

A tool returns `inputRequired({ inputRequests: { confirm:
inputRequired.elicit({ message, requestedSchema }) } })`. The 2.4
client fulfils that through its `elicitation/create` handler
(registered with `setRequestHandler`; the client must declare
`capabilities.elicitation.form`). It then **retries the call
automatically**, and `client.callTool()` returns only the final result.
The tool reads the answer with `acceptedContent(ctx.mcpReq.inputResponses,
"confirm", schema)`.

| Transport · era | Accept | Decline |
|---|---|---|
| stdio · 2026-07-28 (`versionNegotiation: "auto"`) | tool runs | tool refuses (`isError`) |
| stdio · 2025-11-25 (legacy, the client's **default**) | tool runs; the SDK turns it into a legacy server→client `elicitation/create` request | tool refuses |
| HTTP · 2026-07-28 | tool runs | tool refuses |
| HTTP · 2025-11-25 | **fails closed**: "Cannot request input 'confirm' (elicitation/create): the client on this 2025-era connection did not declare the required capability" (per-request legacy HTTP serving has no client capabilities), `isError: true` | same |

**Changed: the client's default era is legacy.** `versionNegotiation`
defaults to `'legacy'` in the 2.4 client. The app's client sets
`versionNegotiation: { mode: "auto" }`, so it negotiates 2026-07-28
over stdio. MCP Inspector or another client on a legacy HTTP connection
gets a refusal, never a silent pass. That is the right failure
direction.

### Finding: an unprompted confirmation is accepted by the SDK's example pattern

**This changes the plan.** A client can put `inputResponses: { confirm:
{ action: "accept", content: { confirm: true } } }` on the **first**
call, without being asked. The pattern in the SDK's own documentation
(`acceptedContent(...)` checked first) accepts it, and the tool runs
with no human involved. This was confirmed over both stdio and HTTP.

In this lab the client is the app, which is trusted, so this is not
exploitable by the model. But a hard layer should not depend on every
client behaving. **The fix, run and confirmed:**

- Every confirmation request carries a `requestState` minted with the
  SDK's HMAC helper:
  `createRequestStateCodec({ key: randomBytes(32), ttlSeconds: 300 })`,
  with the payload `{ tool, runId, args-hash }`.
- The server verifies it through
  `new McpServer(info, { requestState: { verify: codec.verify } })`.
- The tool accepts a confirmation **only** when the verified state
  names this tool and these arguments.

| Attempt | Result |
|---|---|
| Normal flow, human accepts | runs |
| Normal flow, human declines | refused |
| Forged unprompted `inputResponses` | **ignored**: the tool asks the human anyway, and the human's answer decides |
| Forged or tampered `requestState` | rejected at the SDK seam: `-32602 "Invalid or expired requestState"` |
| A confirmation for C-007 replayed onto a call for C-008 | not accepted: the bound arguments differ |

The key is per process, which is fine because one stdio child serves
every round of a call. Over HTTP (`tool-server:http`), each request
builds a fresh server from the factory, so the key must live at module
level, not inside `createServer()`.

The SDK's documentation is explicit: `inputResponses` and
`requestState` "MUST be treated as attacker-controlled input". The
seam's documentation says the same of `requestState`.

---

## Ollama: measured live on this machine

| Fact | Finding | Status |
|---|---|---|
| **`format` + `tools` in one request** | qwen3.5:4b: **0 of 3** made a tool call; it wrote a JSON "I'm checking that for you" reply instead. llama3.2:3b: 2 of 3 still called the tool, but **1 of 3 invented** "No shipping information found for order TA-20412" without looking. Inconsistent, so the structured reply stays a separate request with tools removed | confirmed (invariant) |
| **`think: true` on llama3.2:3b** | **HTTP 400** `{"error":"\"llama3.2:3b\" does not support thinking"}`. The server must never send `think: true` to a model without the `thinking` capability. `think: false` is accepted | **changed**: the plan assumed it was ignored |
| `think` on qwen3.5:4b | `think: true` → 914 characters of reasoning, 41.9 s for "What is 17 + 25?". `think: false` → no reasoning field | confirmed |
| Capabilities (`/api/tags`) | qwen3.5:4b `["completion","vision","tools","thinking"]`; llama3.2:3b `["completion","tools"]` | confirmed |
| Digests (for the results header) | llama3.2:3b `a80c4f17acd5…` (Q4_K_M, 2.02 GB file); qwen3.5:4b `d8b0f5e9760c…` (Q4_K_M, 3.32 GB file). Full digests are in `/api/tags` and the arena records them per run | confirmed |
| **Two models at once** | Alternating calls: **only one model is ever loaded**, and each swap reloads it: qwen **7.3–7.8 s**, llama **5.3–5.4 s**. Loaded: qwen 3.9 GB (1.9 GB in VRAM), llama 3.4 GB (2.3 GB in VRAM), both at 8,192 context | confirmed (decision 3: every role uses the run's one model). **Added:** the arena orders its matrix **model-outermost**, so it swaps once per model, not once per run |
| llama3.2:3b chat template | `{{- if and $.Tools $last }}` inside the user-message branch: tool definitions are rendered only into the **last** message, and only when it is a user message | confirmed: this is why the ticket goes into the first user message (PLAN §4.2) |
| Dropped history past `num_ctx` | Not re-measured. The previous measurement on this machine and Ollama version (whole messages silently dropped, system prompt kept) stands; the loop's detector carries over | pending (re-checked when step 5's loop runs a long ticket) |

### Early timing (one realistic ticket, three requests)

A ~1.6–1.8k-token prompt (policy, ticket text, six tool definitions):
request 1 → tool call, a canned tool result, request 2 → draft,
request 3 → structured reply. Warm model, two seeds each.

| | Run 1 | Run 2 |
|---|---|---|
| llama3.2:3b | 13.4 s (format request 7.5 s) | 10.9 s |
| qwen3.5:4b | 39.2 s (format request 20.0 s) | 25.9 s (format request 16.1 s) |

These are faster than PLAN §9.3's per-run estimates (~30 s and ~55 s
for stacks with no extra model calls). Real runs will make more
requests: extra lookups, attachments, retries. So the plan's estimate
is **kept** until step 11 measures the real pipeline. The
structured-reply request is the slowest single request for qwen,
because it generates the whole reply text at ~10 tokens/s.

**Seen in passing:** both models sometimes called `get_ticket` first
even though the ticket was already in the prompt (2 of 4 runs). It
costs one request. The tool description will say the ticket is already
provided; the effect is measured, not assumed.

---

## First runs through the pipeline (step 5)

Observations, not measurements. The model eval (step 13) and the arena
measure these properly.

| Run | What happened |
|---|---|
| B01 · qwen3.5:4b · no defences | Called `lookup_order` first. Correct order, status and refund. Three requests, 35.7 s (6.4 s of it a cold model load). The app delivered the reply to the customer |
| B02 · llama3.2:3b · no defences | Called **`get_ticket`** first, which is redundant because the ticket was already in its prompt. With a tool result now last, its chat template stopped rendering the tool definitions: request 2's prompt fell from **1,038 to 504 tokens**. It **never looked up the order**. Its reply invented a **$149.99** refund (the real line is $64.95) and the status "shipped" (real: delivered). It listed `read_attachment`, `searched_help` and `looked_up_order` as actions taken, none of which happened |

The llama run shows the risk PLAN §12 predicted, in its sharpest form.
Because of its template, **llama3.2:3b effectively gets one tool call
per turn**: whatever it calls first is the only call that can see the
tool list. When that first call is the redundant `get_ticket`, the task
fails before any attack is involved. This matters for the experiment's
design, and was raised as a decision rather than tuned silently. **Decision
14:** the model is not offered `get_ticket`; the app already gives it the
ticket. Re-run with that change: llama3.2:3b's first call was
`lookup_order`, and B02 came back exactly right (TA-20417, delivered,
$64.95).

## Corrections made to PLAN.md

- **§3.3:** the `_meta` session record is confirmed over both
  transports; the "to verify" note is replaced.
- **§7.5:** the confirmation uses `inputRequired` (confirmed); the app
  pins `versionNegotiation: "auto"`; every confirmation is bound to its
  call by an HMAC `requestState`; legacy HTTP fails closed; the fallback
  design is no longer needed.
- **§4.1 (`get_internal_notes`):** the confirmation is bound to the
  tool and its arguments.
- **§9.4:** the matrix runs model-outermost (swap cost measured).
- **§9.3:** early timing recorded; the estimate is kept until step 11.
- **§12:** risks updated (swap cost confirmed; `think` returns 400 on
  models without the capability; the forged-confirmation finding).
