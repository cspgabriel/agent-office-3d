import { test } from "node:test";
import assert from "node:assert/strict";
import { workSummary, workTitle, workIcon } from "../public/work.js";

test("uma execução só: sem resumo", () => {
  assert.deepEqual(workSummary({ work: [{ kind: "direct", issue: { identifier: "T-1", title: "a" } }] }), { n: 1, queued: 0, text: "" });
});

test("várias ao mesmo tempo: conta por tipo e a fila à parte", () => {
  const a = { work: [{ kind: "chat", label: "Chat com Ana" }, { kind: "chat" }, { kind: "direct", issue: { identifier: "T-2", title: "b" } }, { kind: "autopilot" }, { kind: "direct", queued: true }] };
  assert.deepEqual(workSummary(a), { n: 4, queued: 1, text: "💬2 · 📋1 · ⏰1 · 🕓1 na fila" });
});

test("títulos e ícones", () => {
  assert.equal(workTitle({ issue: { identifier: "T-3", title: "Relatório" } }), "T-3 · Relatório");
  assert.equal(workTitle({ kind: "chat", label: "Chat com Ana" }), "Chat com Ana");
  assert.equal(workIcon({ kind: "chat" }), "💬");
  assert.equal(workIcon({ kind: "direct", queued: true }), "🕓");
  assert.deepEqual(workSummary({}), { n: 0, queued: 0, text: "" });
});
