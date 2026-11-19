# CLAUDE.md

> **Draft**, written with PLAN.md before any code exists. Commands,
> paths and "things that bite" are provisional until the build steps
> that create them. Update this file as each step lands.

Guidance for Claude Code when working in this repository.

## What this project is

A teaching lab for prompt injection, fully local. A small support
assistant for an invented outdoor gear shop reads customer tickets
through six simulated MCP tools. A static library of attacks is
inserted into those tickets, attachments and tool results, and six
switchable defence layers stand in the way. Code scores every run and
reports two numbers side by side: how often attacks succeed, and how
often legitimate tickets still get handled. The models are small local
models through Ollama. There is no API key, and nothing leaves the
machine.

People read this code to learn from it, which changes what "good"
means here: **the explanation is part of the deliverable, not
decoration on top of it.** A terse, clever rewrite makes this codebase
worse even when the code is objectively better.

The lab's promise: **if something happens and the UI doesn't show it,
that is a bug.**

It is standalone. Do not mention or link other projects in code,
comments or docs.

## The comment convention

Every `.ts` file opens with a block comment that names the file and
explains what it does, why it exists and what it teaches. Enforced by:

```bash
npm run audit-comments
```

It checks a header exists, names its file and is long enough to be an
explanation. For files in `server/defenses/`, it also checks that the
header names every attack whose `targets` include that layer. It cannot
judge quality; that part is on you.

Every defence file's header says four things:

- what the layer does;
- why it helps;
- how it fails;
- which library attacks are aimed at it.

Inline comments explain **why**, and especially the trap. When a
comment records a bug that was hit, do not delete it because the code
looks obvious; the comment is why it looks obvious. When behaviour
changes, update the comment in the same edit.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | App on 3300 (compiles the browser half first) |
| `npm run typecheck` | **Both** halves |
| `npm run audit-comments` | Every file has a header; defence headers name their attacks |
| `npm test` | node:test: scorers, normalisation, attack schema, insertion |
| `npm run seed` | Rebuild `data/shop.db` (stop the app first on Windows) |
| `npm run check-env` | Each dependency checked separately, with the fix |
| `npm run try-model` | One raw request to the model, printed in full |
| `npm run try-tools` | Every tool over MCP, no model, error and permission paths included. Run after any tool change |
| `npm run attack -- <id> --stack <name>` | One attack (or `--benign B01`) through the whole pipeline, in the terminal (`--model`, `--reasoning`, `--verbose`, `--confirm ask`) |
| `npm run arena` | The full matrix → `docs/arena-results.*` (long: an overnight run; resumable; `--quick` ≈ 10 min) |
| `npm run model-eval` | The benign suite × both models → `docs/model-eval.*` |
| `npm run tool-server:http` | The tool server over HTTP on 3301, for MCP Inspector |

Before finishing any change, run `npm run typecheck`,
`npm run audit-comments` and `npm test`. Also run `npm run try-tools`
if a tool changed.

## Architecture

- **`tool-server/`**: the MCP server, a **separate process** and the
  only code that reads the shop data.
  - Tools follow `types.ts` → `definitions/` → `registry.ts`, in that
    dependency order. `types.ts` imports nothing; if the registry holds
    the interface, two tools make a cycle.
  - Layer 5 (tool permissions) lives **here**, in `permissions.ts`,
    not in `server/`.
  - It keeps one in-memory outbox per run.
- **`server/`**: the app.
  - `pipeline/run.ts` is the entry point for one ticket turn.
    `direct.ts` and `separated.ts` are the two pipeline shapes.
  - `agent/loop.ts` is the tool loop. `agent/reply.ts` makes the
    structured-reply request.
  - `defenses/` holds one file per layer behind one interface
    (`types.ts`).
  - `scoring/` is code that decides outcomes.
  - `mcp/client.ts` spawns the tool server (`tsx` in dev, `dist/` after
    build; it picks by its own file extension).
  - The pipeline takes a `Logger` and an `emit` function, never an HTTP
    response, so `attack.ts`, `arena.ts` and `model-eval.ts` run the
    same code as the UI.
- **`attacks/`**: the library, one JSON file per attack, validated by
  `server/attacks/schema.ts`. `attacks/benign/` holds the benign
  tickets' expectations. Data, not code: adding an attack must never
  need an engine change.
- **`public/`**: the browser half, compiled in place. The client
  tsconfig keeps `"types": []`, and the browser imports only types from
  `shared/`.
- **`shared/`**: types both halves agree on, with no runtime code.

### How the tool server knows what is allowed

The model writes tool **arguments**. Only the app writes the MCP
request's **`_meta`** (`lab/session`: run id, ticket id, enforcement
flag, canaries, overlays). The tool server derives the
customer from the ticket id and its own data. Never take the customer,
the recipient allowlist or a permission from a model-written argument.
That separation is what makes layer 5 hard.

## Invariants (changing one is a decision, not a refactor)

- **No API key, ever, and no outbound calls** except to the local
  Ollama server. Cloud models (`:cloud`, `-cloud`, any `remote_*`
  field) are refused by name in `ollama.ts` and `index.ts`.
- **Every tool is simulated.** `send_email` writes to the run's outbox
  and never opens a socket. No real addresses: the shop is
  `transitionarea.example`, attackers use other `*.example` domains.
- **Scoring is code, never a model.** No LLM judges anything that
  reaches a results file.
- **Prompts, attacks, expectations and scorers are fixed before a run
  and never tuned afterwards** to improve a result. The arena's library
  hash marks old records stale when any of them change. Do not work
  around it.
- **Defences are switchable, labelled soft, medium or hard, and never
  described as guarantees unless they are one.** Only layers 5 and 6
  are hard, and each states its scope limit.
- **Every defence decision is logged**, including `pass`, at level
  `defense`, naming the layer and the stage.
- **Permissions are enforced in the tool server, not the prompt**, and
  never derived from model-written arguments.
- **The output filter stays weaker than the scorer.** The filter is a
  realistic substring check; the scorer normalises and decodes. The gap
  is how the lab shows a filter being bypassed. Do not "fix" the filter
  to match the scorer.
- **`textContent`, never `innerHTML`**, for anything from a model, an
  attack, a tool or the shop data. The attack library is deliberately
  hostile input. HTML emails are shown as source text, and "reveal
  hidden content" works on that text, never by rendering it.
- **Canaries never appear in a payload or the seed's values**, only as
  placeholders the tool server fills per run. A leak must always be
  the model's doing.
- **Every request sends `think`, `stream: false` and `num_ctx`**
  (`buildRequest` in `ollama.ts`). `think` is false unless Show
  reasoning is on and the model has the `thinking` capability. Always
  send it explicitly, because leaving it out lets a thinking model
  think.
- **The structured reply is a separate request.** `format` alongside
  `tools` stops tool calling entirely. Do not "optimise" them into one
  request.
- **In privilege-separation mode, the model that can call tools never
  receives raw untrusted text.** Tool results reach it only through
  each tool's `trustedFields` projection, defined in code.
- **Every server binds 127.0.0.1 and checks Host and Origin.**
- **`stdio.ts` never writes to stdout.** stdout is the protocol there.
- **The MCP serving entry points take a factory**, not a server
  instance. Hooks reach it by closure.
- **Never hide a failure.** Blocks, errors, retries, text-written tool
  calls and dropped history are logged and visible, and errors are
  never counted as attack success or failure.

## Things that bite

Verified facts live in `docs/verified-facts.md`; read it before
trusting a remembered API shape. Carried over from earlier measurement,
to re-confirm in step 0:

- **llama3.2:3b's chat template renders tool definitions only into the
  last message, and only if it is a user message.**
  - This is why the ticket goes into the first user message, not a
    pre-filled tool result.
  - After a tool result, llama can't see the tools. A forbidden action
    it never attempts may mean it couldn't, not that it resisted.
  - It effectively gets one useful tool call per turn, which is why the
    model is not offered `get_ticket` (decision 14, `APP_ONLY_TOOLS` in
    `pipeline/direct.ts`): a redundant first call failed the task in
    step 5.
  - Don't infer dropped history from a shrinking `prompt_eval_count`.
- **qwen3.5:4b thinks by default.** Always send `think`.
- **Ollama silently drops whole messages** past `num_ctx`, keeping the
  system prompt. Watch the dropped-history flag, especially on tickets
  with attachments.
- **Small models write tool calls as text.** It's detected by a
  heuristic, labelled as one, and never executed.
- **The two models can't share a 4 GB GPU.** Every role (classifier,
  quarantine, main loop) uses the run's one model; a swap costs a
  6–10 s cold load.
- `node:sqlite` does not bind `?1` positionally; use `:named` params.
- `StdioClientTransport` is in `@modelcontextprotocol/client/stdio`.
- **Confirmations use `inputRequired(...)`**, and the 2.4 client
  fulfils and retries them inside `callTool()`.
  - The client's default era is **legacy**, so `mcp/client.ts` pins
    `versionNegotiation: { mode: "auto" }`. On legacy HTTP the server
    can't ask for input, and the tool fails closed.
  - **A client can send an "accepted" answer unprompted**, and the SDK's
    example pattern accepts it. Every confirmation is bound to its tool
    and arguments by an HMAC `requestState` (`createRequestStateCodec`,
    verified in `ServerOptions.requestState.verify`). Never accept
    `inputResponses` without a verified state.
- **`think: true` to a model without the `thinking` capability is
  HTTP 400** (llama3.2:3b). Check capabilities first.
- **Ollama keeps one model loaded on this GPU**; a swap is a 5–8 s
  reload. The arena runs model-outermost.
- Express 5 passes a failed `listen()` to the callback; check the
  error.
- Tool wording is prompt text: how a tool result describes withheld
  data becomes how the model describes it to the customer.

## Documentation to keep in sync

Changing tools, layers, attacks, routes, scripts or counts means
updating, in the same change:

- `README.md`: tools, defences and their bypasses, scripts, layout;
- `index.html`: fact strip and tables (measure counts; do not
  estimate);
- `PLAN.md` §4, §6.2 and §7.2;
- the `scripts/try-tools.ts` cases;
- `attacks/README.md` if the schema changes.

`docs/model-eval.md` and `docs/arena-results.md` are generated. Re-run
the script rather than editing their numbers.

## GitHub Pages

`index.html` at the repo root is the project overview, served by Pages
from `main`. It is a complete HTML document (doctype, `<html lang>`,
`<meta charset="utf-8">`) and self-contained. Without the doctype,
Pages renders it in quirks mode; without the charset, em-dashes become
mojibake.

`docs/build-plan.html` is the plan as a historical record. Leave its
contents as they were when written.

Commits: plain imperative, descriptive, no prefixes.
