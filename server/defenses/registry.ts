/**
 * registry.ts — the six defense layers, in pipeline order.
 *
 * The order matters, because the pipeline runs every enabled layer's hook
 * for a stage in this order (pipeline/stages.ts):
 *
 *   input   spotlighting fences the text first, then the classifier reads
 *           the FENCED text — the same text the assistant would see
 *   model   the hardened prompt adds its rules, then spotlighting adds its
 *           one sentence about the markers
 *   tool    the output filter checks the call in the app, then — across
 *           the MCP boundary — the tool server's permission rules
 *   output  the output filter checks the reply before delivery
 *
 * At a stage, the first BLOCK wins. Later layers still run and log, marked
 * "report only", so a reader can see that another layer would have caught
 * it too — and so no layer is credited with a block it did not make.
 *
 * Tool permissions and privilege separation are listed for completeness
 * (the defense panel shows all six); neither has hooks in the app, for the
 * reasons in their own files.
 */

import type { DefenseId } from "../../shared/types.js";
import { classifier } from "./classifier.js";
import { hardenedPrompt } from "./hardened-prompt.js";
import { outputFilter } from "./output-filter.js";
import { privilegeSeparation } from "./privilege-separation.js";
import { spotlighting } from "./spotlighting.js";
import { toolPermissions } from "./tool-permissions.js";
import type { DefenseLayer } from "./types.js";

/** Pipeline order for the input stage: fence, then classify. */
export const INPUT_ORDER: DefenseLayer[] = [spotlighting, classifier];

/** Pipeline order for the system prompt: rules, then the marker sentence. */
export const MODEL_ORDER: DefenseLayer[] = [hardenedPrompt, spotlighting];

/** The app-side tool and output stages: only the output filter acts in this process. */
export const TOOL_ORDER: DefenseLayer[] = [outputFilter];
export const OUTPUT_ORDER: DefenseLayer[] = [outputFilter];

/** All six, in the order the defense panel lists them. */
export const LAYERS: DefenseLayer[] = [hardenedPrompt, spotlighting, classifier, outputFilter, toolPermissions, privilegeSeparation];

export const LAYER_BY_ID: ReadonlyMap<DefenseId, DefenseLayer> = new Map(LAYERS.map((l) => [l.id, l]));
