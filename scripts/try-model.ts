/**
 * try-model.ts — sends one raw request to the local model and prints both halves.
 *
 * Run it with:  npm run try-model
 *               npm run try-model -- "your own question"
 *               npm run try-model -- --model llama3.2:3b "your question"
 *
 * No tools, no pipeline, no defences: one POST to Ollama's /api/chat,
 * built by the same `buildRequest()` every part of the lab uses, printed
 * in full on the way out and on the way back. It is the smallest possible
 * look at the thing every later step wraps.
 *
 * The default question asks about the shop, and the model has never seen
 * the shop. Whatever it says about Transition Area Supply comes from its
 * weights: plausible, confident, invented. Only the tools can show it the
 * real data — and, as the rest of the lab demonstrates, whatever comes back
 * through those tools gets read with the same credulity.
 *
 * The footer reads the response the way the activity log will: model load
 * time (a cold start costs seconds), tokens in against the context window,
 * tokens out, and tokens per second — the local stand-in for a cost
 * column, because the cost is $0.
 */

import "dotenv/config";
import {
  ModelNotFoundError, OllamaUnreachableError, RemoteModelError, buildRequest, chat, ms, ollamaConfig, tokensPerSecond,
} from "../server/model/ollama.js";

const argv = process.argv.slice(2);
const modelFlag = argv.indexOf("--model");
const config = ollamaConfig();
const model = modelFlag >= 0 ? argv[modelFlag + 1] ?? config.model : config.model;
const words = argv.filter((_, i) => modelFlag < 0 || (i !== modelFlag && i !== modelFlag + 1));
const question = words.join(" ") ||
  "In two sentences: what is Transition Area Supply, and what is their policy on returning boots after 45 days?";

const request = buildRequest({
  model,
  messages: [
    { role: "system", content: "You are a helpful assistant. Be brief." },
    { role: "user", content: question },
  ],
});

console.log(`POST ${config.url}/api/chat\n`);
console.log("--- request ---");
console.log(JSON.stringify(request, null, 2));

try {
  const response = await chat(request);
  console.log("\n--- response ---");
  console.log(JSON.stringify(response, null, 2));

  const load = ms(response.load_duration);
  console.log("\n--- reading it ---");
  console.log(`reply           ${response.message.content}`);
  console.log(`model load      ${load} ms${load > 1000 ? "  (cold start — run again to compare)" : ""}`);
  console.log(`tokens in       ${response.prompt_eval_count ?? "?"}  (context window: ${request.options.num_ctx})`);
  console.log(`tokens out      ${response.eval_count ?? "?"}`);
  console.log(`speed           ${tokensPerSecond(response) ?? "?"} tokens/second`);
  console.log(`total           ${ms(response.total_duration)} ms`);
  console.log("cost            $0 — this ran on your machine");
  console.log("\nThe model has never seen Transition Area Supply. Anything specific it said above, it made up.");
} catch (error: unknown) {
  if (error instanceof OllamaUnreachableError || error instanceof ModelNotFoundError || error instanceof RemoteModelError) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
