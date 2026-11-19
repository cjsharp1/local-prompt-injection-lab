/**
 * tool-format.ts — turns an MCP tool definition into an Ollama one.
 *
 * The tool server advertises its tools over MCP: a name, a description
 * and a JSON Schema for the arguments. Ollama wants the same three things
 * in a slightly different envelope:
 *
 *   MCP     { name, description, inputSchema, outputSchema, title, … }
 *   Ollama  { type: "function", function: { name, description, parameters } }
 *
 * Both sides speak JSON Schema, so this is close to a passthrough — which
 * is itself worth noticing. The model never learns that a tool came from
 * an MCP server, a separate process, or anywhere at all. It sees a list of
 * functions. Where the function runs is entirely this app's business.
 *
 * What is left behind, deliberately:
 *
 *   outputSchema  The model never sees structured results (it reads each
 *                 tool's text), so describing their shape would spend
 *                 context on something it cannot use.
 *   title         A display name for humans; the model calls by `name`.
 *   $schema       The JSON Schema dialect URL. Noise to a model, and every
 *                 token counts in an 8K context window.
 *
 * The schema is DEEP-COPIED before `$schema` is removed. The MCP client
 * hands back the same objects on every listTools call; deleting a key in
 * place would edit the cached original, and the change would surface
 * somewhere unrelated much later.
 */

import type { OllamaTool } from "../model/ollama.js";

/** The parts of an MCP tool definition this needs. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function toOllamaTool(tool: McpToolDefinition): OllamaTool {
  const parameters = structuredClone(tool.inputSchema);
  delete parameters.$schema;

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters,
    },
  };
}
