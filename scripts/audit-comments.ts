/**
 * audit-comments.ts — checks every source file explains itself.
 *
 * Run it with:  npm run audit-comments
 *
 * The rule this project sets itself is that every file opens with a
 * plain-language overview: what it does, why it exists, and which
 * concept it teaches. Across a few dozen files that is not something
 * anyone can verify by remembering.
 *
 * So this walks the tree and checks. It is deliberately crude — it
 * cannot tell a good explanation from a bad one, only a present one
 * from an absent one, and it has no opinion about prose. What it
 * catches is the file that got written in a hurry and never got its
 * header, which is the realistic failure.
 *
 * Three things make a header count:
 *
 *   1. The file opens with a block comment, before any code.
 *   2. It names the file, so a reader who arrived from a stack trace
 *      knows they are in the right place.
 *   3. It is long enough to be an explanation rather than a label.
 *      "utils.ts — utilities" passes a naive check and tells nobody
 *      anything.
 *
 * It is written first, before any other source file, so that no file
 * in the project ever exists unchecked.
 *
 * One check is specific to this lab: each defence layer's file in
 * server/defenses/ must NAME, in its header, every attack in attacks/
 * whose `targets` include that layer. A defence's documentation is
 * supposed to point at its own failures; this keeps that true as attacks
 * are added.
 */

import { readFileSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

/** The project root, derived from this file rather than from cwd. */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Directories never worth auditing. */
const SKIP = new Set(["node_modules", "dist", ".git", ".claude"]);

/**
 * Directories that hold hand-written TypeScript, relative to the root.
 *
 * Named here rather than inline in main() so that adding a directory to
 * the project is a one-line change in an obvious place. A new folder of
 * source files that nobody adds to this list is a folder the audit
 * silently ignores — the trap is that nothing fails, so nobody notices.
 *
 * tool-server/ is listed separately from server/ because it IS separate:
 * a different process, spawned by the app — and the one that enforces
 * the hard permission layer. It is easy to forget for exactly that
 * reason. test/ is listed because the scorer tests decide what counts
 * as an attack succeeding; they need explaining as much as the scorers.
 */
const AUDITED = ["server", "tool-server", "public", "scripts", "shared", "test"];

/**
 * How many characters of comment count as an explanation.
 *
 * Judged by eye against the shortest header that is genuinely useful.
 * Below this you get a label, not an overview.
 */
const MIN_HEADER_CHARS = 120;

/** Defence layer files, by the layer id an attack's `targets` would use. */
const DEFENSE_FILES: Record<string, string> = {
  "hardened-prompt": "server/defenses/hardened-prompt.ts",
  "spotlighting": "server/defenses/spotlighting.ts",
  "classifier": "server/defenses/classifier.ts",
  "output-filter": "server/defenses/output-filter.ts",
  "tool-permissions": "server/defenses/tool-permissions.ts",
  "privilege-separation": "server/defenses/privilege-separation.ts",
};

/**
 * Each defence file's header must name every attack aimed at it. Returns
 * one message per missing name. An attack file that does not parse is
 * left to the attack loader to report.
 */
function defenseHeaderGaps(): string[] {
  const gaps: string[] = [];
  let files: string[];
  try {
    files = readdirSync(join(ROOT, "attacks")).filter((f) => f.endsWith(".json"));
  } catch {
    return gaps;
  }
  for (const file of files) {
    let attack: { id?: unknown; targets?: unknown };
    try {
      attack = JSON.parse(readFileSync(join(ROOT, "attacks", file), "utf8")) as typeof attack;
    } catch {
      continue;
    }
    if (typeof attack.id !== "string" || !Array.isArray(attack.targets)) continue;
    for (const layer of attack.targets) {
      const path = DEFENSE_FILES[String(layer)];
      if (!path) continue;
      let header = "";
      try {
        header = openingComment(readFileSync(join(ROOT, path), "utf8")) ?? "";
      } catch {
        continue;
      }
      if (!header.includes(attack.id)) gaps.push(`${path} — header does not name "${attack.id}", which targets ${String(layer)}`);
    }
  }
  return gaps;
}

/** What the audit found about one file. */
interface Finding {
  path: string;
  ok: boolean;
  reason: string;
  headerChars: number;
}

/** Every .ts file under a directory, recursively. */
async function findSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await findSources(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(full);
    }
  }

  return found;
}

/**
 * Reads the opening block comment, if the file starts with one.
 *
 * Returns null when the first non-blank line is anything else — an
 * import, a type, a line comment. A file whose explanation sits below
 * its imports is not self-describing to someone who opened it and
 * read the first screen.
 */
function openingComment(source: string): string | null {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("/*")) return null;

  const end = trimmed.indexOf("*/");
  if (end === -1) return null;

  return trimmed.slice(0, end + 2);
}

/** Judges one file. */
function audit(path: string): Finding {
  const source = readFileSync(path, "utf8");
  const relativePath = relative(ROOT, path).replace(/\\/g, "/");
  const comment = openingComment(source);

  if (!comment) {
    return {
      path: relativePath,
      ok: false,
      reason: "no block comment before the first line of code",
      headerChars: 0,
    };
  }

  // The prose, without the comment furniture, so the length check
  // measures explanation rather than asterisks.
  const prose = comment
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*/, "").trim())
    .join(" ")
    .trim();

  const name = basename(path);
  if (!comment.includes(name)) {
    return {
      path: relativePath,
      ok: false,
      reason: `header does not name the file ("${name}")`,
      headerChars: prose.length,
    };
  }

  if (prose.length < MIN_HEADER_CHARS) {
    return {
      path: relativePath,
      ok: false,
      reason: `header is ${prose.length} chars — a label, not an overview`,
      headerChars: prose.length,
    };
  }

  return {
    path: relativePath,
    ok: true,
    reason: "",
    headerChars: prose.length,
  };
}

/**
 * Lists the sources under one audited directory, tolerating absence.
 *
 * Early in the build some of these directories do not exist yet, and a
 * missing public/ should not crash the check that the files already
 * written are documented. Any error other than "not found" is still
 * thrown — a permissions problem is worth hearing about.
 */
async function sourcesIn(directory: string): Promise<string[]> {
  try {
    return await findSources(join(ROOT, directory));
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const found = await Promise.all(AUDITED.map(sourcesIn));
  const files = found.flat().sort();

  const findings = files.map(audit);
  const misses = findings.filter((finding) => !finding.ok);

  console.log(`\nChecked ${findings.length} TypeScript files.\n`);

  const gaps = defenseHeaderGaps();
  if (gaps.length > 0) {
    console.log("Defence headers that do not name the attacks aimed at them:\n");
    for (const gap of gaps) console.log(`  ${gap}`);
    console.log("");
    process.exitCode = 1;
  }

  // Nothing to report on, and nothing to celebrate either. Without this
  // the "every file passes" message below prints for an empty project,
  // and reduce() on an empty array throws.
  if (findings.length === 0) {
    console.log("No TypeScript files found yet.\n");
    return;
  }

  if (misses.length === 0) {
    const shortest = findings.reduce((a, b) =>
      a.headerChars < b.headerChars ? a : b,
    );
    console.log("Every file opens with a header comment that names it");
    console.log("and explains it.\n");
    console.log(
      `Shortest header: ${shortest.path} (${shortest.headerChars} chars)\n`,
    );
    return;
  }

  console.log(`${misses.length} file(s) need a header:\n`);
  for (const miss of misses) {
    console.log(`  ${miss.path}`);
    console.log(`    ${miss.reason}\n`);
  }

  // A non-zero exit so this can gate a build later if that is ever
  // wanted. Nothing does that today.
  process.exitCode = 1;
}

await main();
