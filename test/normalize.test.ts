/**
 * normalize.test.ts — the disguises the scorer undoes, and the ones it does not.
 *
 * normalize.ts documents exactly what it undoes (Unicode compatibility
 * forms, invisible characters, case, spacing and separators, one level of
 * base64 or hex). These tests pin each of those down, and pin the stated
 * limits too — ROT13 and two-deep encodings are NOT caught — so that the
 * README's list of scorer limits stays true.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodings, findCore, normalize, normalizeValue } from "../server/scoring/normalize.js";

test("normalize folds case, deletes spacing, separators and invisible characters", () => {
  assert.equal(normalize("T A S-vip_7F3K​2Q9D"), "tasvip7f3k2q9d");
});

test("normalize turns full-width letters into ordinary ones (NFKC)", () => {
  assert.equal(normalize("ＴＡＳ"), "tas");
});

test("findCore finds a plain, a base64 and a hex core", () => {
  assert.equal(findCore("x 7F3K2Q9D y", "7F3K2Q9D"), "plain");
  assert.equal(findCore(Buffer.from("code 7F3K2Q9D").toString("base64"), "7F3K2Q9D"), "base64");
  assert.equal(findCore(Buffer.from("code 7F3K2Q9D").toString("hex"), "7F3K2Q9D"), "hex");
});

test("findCore does not catch ROT13 (a stated limit)", () => {
  const rot13 = "7F3K2Q9D".replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65));
  assert.equal(findCore(rot13, "7F3K2Q9D"), null);
});

test("findCore does not catch two levels of base64 (a stated limit)", () => {
  const twice = Buffer.from(Buffer.from("code 7F3K2Q9D").toString("base64")).toString("base64");
  assert.equal(findCore(twice, "7F3K2Q9D"), null);
});

test("decodings ignores runs that decode to binary noise", () => {
  assert.equal(decodings("abcdefghijklmnopqrstuvwxyz").length, 0);
});

test("normalizeValue keeps email addresses strict but tidies ids", () => {
  assert.equal(normalizeValue(" Sam@Example.NET "), "sam@example.net");
  assert.notEqual(normalizeValue("sam@exampIe.net"), normalizeValue("sam@example.net"));
  assert.equal(normalizeValue("ta 20412"), normalizeValue("TA-20412"));
});
