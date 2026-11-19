/**
 * setup-hash.ts — a fingerprint of everything fixed before an arena run.
 *
 * The lab's rule: prompts, attacks, expectations and scorers are fixed
 * BEFORE a run and never tuned afterwards to make a result look better.
 * This file is how the rule is enforced rather than merely stated.
 *
 * Every arena record carries a hash of the files that decide what a run
 * means:
 *
 *   shared     the prompts (base, hardened, spotlighting's note, the
 *              classifier's, the quarantined reader's, the reply
 *              instruction), every defence layer, the pipeline shapes and
 *              projection, the tool definitions (a tool's description is
 *              prompt text), the tool server's permission rules, and the
 *              scorer
 *   per item   the attack file, and its base ticket's expectation
 *
 * Change any of them — reword a tool description, adjust a scoring rule,
 * "improve" an attack — and the hash changes. Earlier records then no
 * longer match: the arena reruns those cells, and the report counts the
 * old records as STALE instead of quietly mixing two different experiments
 * into one table.
 *
 * Line endings are normalised before hashing, so a Windows checkout and a
 * Linux checkout of the same commit give the same hash.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/** Folders whose every .ts file is part of the fixed setup. */
const SHARED_DIRS = ["server/defenses", "server/scoring", "server/pipeline", "server/agent", "tool-server/tools/definitions"];

/** Single files that are part of it too. */
const SHARED_FILES = ["tool-server/permissions.ts", "tool-server/tools/common.ts"];

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8").replace(/\r\n/g, "\n");
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

let sharedCache: string | undefined;

/** The hash of every shared file, computed once per process. */
export function sharedSetupHash(): string {
  if (sharedCache) return sharedCache;
  const files = [
    ...SHARED_DIRS.flatMap((dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".ts")).sort().map((f) => `${dir}/${f}`)),
    ...SHARED_FILES,
  ];
  sharedCache = sha(files.map((f) => `${f}\n${read(f)}`).join("\n\u0000\n"));
  return sharedCache;
}

/** The setup hash for one item: the shared hash, plus its own files. 16 hex characters is plenty. */
export function itemSetupHash(itemFiles: string[]): string {
  return sha([sharedSetupHash(), ...itemFiles.map((f) => `${f}\n${read(f)}`)].join("\n\u0000\n")).slice(0, 16);
}
