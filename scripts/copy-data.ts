/**
 * copy-data.ts — copies the shop database into dist/ after a build.
 *
 * Run by `npm run build`, after both TypeScript compiles.
 *
 * tsc compiles .ts files and nothing else, so a build leaves dist/ with
 * the tool server's JavaScript but no data for it to read. The tool server
 * finds its database relative to its own file (`../data/shop.db`, see
 * tool-server/db.ts) — from dist/tool-server/ that means dist/data/. This
 * script puts a copy there, so the built tool server works without being
 * pointed anywhere.
 *
 * A missing database is reported, not fatal: a build on a fresh clone, or
 * in CI, may reasonably happen before `npm run seed`. The built server
 * will then say exactly what to run when it starts.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const FROM = join(ROOT, "data");
const TO = join(ROOT, "dist", "data");

/**
 * Whether a path exists as a file.
 *
 * Distinguishes "not there" from "there but broken": ENOENT returns
 * false, anything else is rethrown, so a permissions problem is not
 * swallowed by a check meant to handle absence.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function main(): Promise<void> {
  await mkdir(TO, { recursive: true });

  // schema.sql travels too: it is the readable copy of the structure, and
  // a dist/ folder handed to someone else should still explain itself.
  for (const name of ["shop.db", "schema.sql"]) {
    const from = join(FROM, name);
    if (await isFile(from)) {
      await cp(from, join(TO, name));
      console.log(`Copied data/${name} → dist/data/${name}`);
    } else if (name === "shop.db") {
      console.log("No data/shop.db to copy — run `npm run seed`, then build again.");
    }
  }
}

await main();
