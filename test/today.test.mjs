import { test } from "node:test";
import assert from "node:assert/strict";
import { createToday } from "../today.mjs";

// 22/10/2026 15:00 no Rio (18:00 UTC).
const NOW = Date.parse("2026-10-22T18:00:00Z");

test("conta só as execuções de hoje no fuso do Rio, separando concluídas e falhas", async () => {
  const runs = {
    a: [
      { status: "completed", created_at: "2026-10-22T12:00:00Z", completed_at: "2026-10-22T12:05:00Z" },
      { status: "failed", created_at: "2026-10-22T03:30:00Z" }, // 00:30 no Rio: hoje
      { status: "completed", created_at: "2026-10-22T02:30:00Z" }, // 23:30 do dia 21 no Rio: ontem
      { status: "running", created_at: "2026-10-22T17:59:00Z" },
    ],
    b: [{ status: "completed", created_at: "2026-10-20T12:00:00Z" }],
  };
  const t = createToday({ multica: async (args) => runs[args[2]] ?? [], now: () => NOW });
  await t.refresh(["a", "b", "c"]);
  assert.deepEqual(t.of("a"), { runs: 3, ok: 1, failed: 1, lastAt: "2026-10-22T17:59:00Z" });
  assert.deepEqual(t.of("b"), { runs: 0, ok: 0, failed: 0, lastAt: null });
});

test("terminar uma tarefa soma na hora; falha de leitura mantém o que já sabia", async () => {
  let fail = false;
  const t = createToday({
    multica: async () => {
      if (fail) throw new Error("cli fora");
      return [{ status: "completed", created_at: "2026-10-22T12:00:00Z" }];
    },
    now: () => NOW,
  });
  await t.refresh(["a"]);
  t.finished("a");
  t.finished("z");
  assert.equal(t.of("a").runs, 2);
  assert.equal(t.of("z").runs, 1);
  fail = true;
  await t.refresh(["a"]);
  assert.equal(t.of("a").runs, 2);
});

test("vira o dia: zera", async () => {
  let now = NOW;
  const t = createToday({ multica: async () => [{ status: "completed", created_at: "2026-10-22T12:00:00Z" }], now: () => now });
  await t.refresh(["a"]);
  assert.equal(t.of("a").runs, 1);
  now = Date.parse("2026-10-23T04:00:00Z"); // 01:00 do dia 23 no Rio
  assert.equal(t.of("a").runs, 0);
});
