// Unit tests for the scaffolder's text surgery: node --test scripts/new-app.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMarkers,
  evalExpr,
  pruneMigration,
  resolveModules,
} from "./new-app.mjs";

const sel = (...ids) => new Set(["core", ...ids]);

test("expressions: and, or, not", () => {
  assert.equal(evalExpr("ai", sel("ai"), "t"), true);
  assert.equal(evalExpr("ai,agent", sel("ai"), "t"), false);
  assert.equal(evalExpr("agent|ai", sel("ai"), "t"), true);
  assert.equal(evalExpr("!ai", sel(), "t"), true);
  assert.throws(() => evalExpr("nope", sel(), "t"), /unknown module/);
});

test("inline and block markers, any comment style, nested", () => {
  const src = [
    "keep",
    "drop me // @module:sms",
    "kept // @module:ai",
    "# @module:ai",
    "in ai",
    "  <!-- @module:sms -->",
    "  in ai and sms",
    "  <!-- @end -->",
    "# @end",
    "{/* @module:agent */}",
    "<Agent />",
    "{/* @end */}",
    "tail",
  ].join("\n");
  assert.equal(
    applyMarkers(src, sel("ai"), "t").text,
    ["keep", "kept", "in ai", "tail"].join("\n"),
  );
});

test("unbalanced markers are an error", () => {
  assert.throws(
    () => applyMarkers("// @module:ai\nx", sel(), "t"),
    /never closed/,
  );
  assert.throws(
    () => applyMarkers("x\n// @end", sel(), "t"),
    /without an open/,
  );
});

test("migrations lose exactly the statements naming removed tables", () => {
  const sql = [
    "-- CreateTable",
    'CREATE TABLE "a" (',
    '    "id" TEXT NOT NULL',
    ");",
    "",
    "-- CreateTable",
    'CREATE TABLE "b" ("id" TEXT);',
    "",
    "-- AddForeignKey",
    'ALTER TABLE "b" ADD CONSTRAINT "b_fkey" FOREIGN KEY ("id") REFERENCES "a"("id");',
    "",
  ].join("\n");
  const out = pruneMigration(sql, ["b"], "t");
  assert.match(out, /CREATE TABLE "a"/);
  assert.doesNotMatch(out, /"b"/);
  assert.throws(() => pruneMigration('$$ "b" $$', ["b"], "t"), /\$\$/);
});

test("dependencies come along; --without drops what needs it", () => {
  const { selected } = resolveModules({ profile: "web", withIds: ["agent"] });
  assert.ok(selected.has("ai"));
  const r = resolveModules({ profile: "full", withoutIds: ["ai"] });
  for (const id of ["ai", "agent", "rag", "evals", "glasses"])
    assert.ok(!r.selected.has(id), id);
  assert.ok(r.selected.has("mobile"));
});
