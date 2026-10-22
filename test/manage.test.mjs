import { test } from "node:test";
import assert from "node:assert/strict";
import { createManage } from "../manage.mjs";

// CLI falsa: registra as chamadas e responde por comando.
function fakeCli(responses = {}) {
  const calls = [];
  const multica = async (args) => {
    calls.push(args.join(" "));
    const key = args.slice(0, 2).join(" ");
    const r = responses[key];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(args) : (r ?? {});
  };
  return { multica, calls };
}
const redact = (s) => String(s ?? "").replace(/\S+@\S+/g, "(email)");
const ISSUE = "01a1622c-3a17-7af5-9556-c8ec07e77598";
const AGENT = "f40c9802-344b-4efd-8dc2-fc049424c89f";

async function call(m, method, path, body) {
  const out = {};
  const send = (_r, code, b) => Object.assign(out, { code, body: b });
  const url = new URL(`http://x${path}`);
  const handled = await m.handle({ method }, {}, url.pathname, url, { readJson: async () => body ?? {}, send });
  return { handled, ...out };
}

test("detalhe junta issue, comentários, execuções, linha do tempo e consumo; menções e e-mails ficam legíveis/ocultos", async () => {
  const { multica } = fakeCli({
    "issue get": { id: ISSUE, identifier: "TASK-1452", title: "Reunião", description: "falar com joao@hotel.com", status: "in_progress", priority: "none", assignee_type: "agent", assignee_id: AGENT },
    "issue comment": [{ id: "c1", type: "comment", author_type: "member", content: "[@Zoho CRM](mention://agent/abc) olá", created_at: "2026-10-22T05:53:48Z" }, { id: "c2", type: "system", content: "x" }],
    "issue runs": [{ id: "r1", agent_id: AGENT, status: "failed", failure_reason: "out of credits", created_at: "2026-10-22T06:00:00Z" }],
    "issue timeline": [{ type: "activity", action: "created", actor_name: "Ana", created_at: "2026-10-22T05:53:48Z" }, { type: "comment" }],
    "issue usage": { task_count: 9, total_input_tokens: 10, total_output_tokens: 2, total_cache_read_tokens: 5 },
  });
  const r = await call(createManage({ multica, redact }), "GET", "/api/manage/issues/TASK-1452");
  assert.equal(r.code, 200);
  assert.equal(r.body.issue.identifier, "TASK-1452");
  assert.equal(r.body.issue.description, "falar com (email)");
  assert.deepEqual(r.body.comments.map((c) => c.text), ["@Zoho CRM olá"]);
  assert.equal(r.body.runs[0].error, "out of credits");
  assert.deepEqual(r.body.timeline, [{ at: "2026-10-22T05:53:48Z", action: "created", actor: "Ana", to: null }]);
  assert.deepEqual(r.body.usage, { runs: 9, input: 10, output: 2, cacheRead: 5 });
});

test("detalhe tolera falha nas partes secundárias", async () => {
  const { multica } = fakeCli({ "issue get": { id: ISSUE, identifier: "TASK-1" }, "issue comment": new Error("x"), "issue runs": new Error("x"), "issue timeline": new Error("x"), "issue usage": new Error("x") });
  const r = await call(createManage({ multica, redact }), "GET", `/api/manage/issues/${ISSUE}`);
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.comments, r.body.runs, r.body.usage], [[], [], null]);
});

test("atribuir a agente, tirar atribuição só quando pedido e recusar id inválido", async () => {
  const { multica, calls } = fakeCli();
  const m = createManage({ multica, redact });
  await call(m, "POST", `/api/manage/issues/${ISSUE}/assign`, { agentId: AGENT });
  await call(m, "POST", `/api/manage/issues/${ISSUE}/assign`, { agentId: null });
  assert.deepEqual(calls, [`issue assign ${ISSUE} --to-id ${AGENT}`, `issue assign ${ISSUE} --unassign`]);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/assign`, { agentId: "x; rm -rf" }), /Agente inválido/);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/assign`, {}), /Informe o agente/);
  assert.equal(calls.length, 2);
});

test("editar título e prazo, recusando valores inválidos", async () => {
  const { multica, calls } = fakeCli();
  const m = createManage({ multica, redact });
  await call(m, "POST", `/api/manage/issues/${ISSUE}/edit`, { title: " Novo título ", dueDate: "2026-11-01" });
  assert.deepEqual(calls, [`issue update ${ISSUE} --title Novo título --due-date 2026-11-01`]);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/edit`, { dueDate: "" }), /Prazo inválido/);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/edit`, { dueDate: "amanhã" }), /Prazo inválido/);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/edit`, { title: "  " }), /Título vazio/);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/edit`, {}), /Nada para alterar/);
});

test("prioridade só aceita valores conhecidos", async () => {
  const { multica, calls } = fakeCli();
  const m = createManage({ multica, redact });
  await call(m, "POST", `/api/manage/issues/${ISSUE}/priority`, { priority: "high" });
  assert.deepEqual(calls, [`issue update ${ISSUE} --priority high`]);
  await assert.rejects(call(m, "POST", `/api/manage/issues/${ISSUE}/priority`, { priority: "máxima" }), /Prioridade inválida/);
});

test("status em lote: separa sucessos e falhas, ignora ids inválidos e limita a 50", async () => {
  const { multica, calls } = fakeCli({ "issue status": (args) => { if (args[2] === "TASK-2") throw new Error("não"); return ""; } });
  const m = createManage({ multica, redact });
  const r = await call(m, "POST", "/api/manage/bulk-status", { ids: ["TASK-1", "TASK-2", "TASK-1", "lixo"], status: "done" });
  assert.deepEqual(r.body, { ok: ["TASK-1"], failed: ["TASK-2"] });
  assert.equal(calls.length, 2);
  await assert.rejects(call(m, "POST", "/api/manage/bulk-status", { ids: ["TASK-1"], status: "feito" }), /Status inválido/);
  await assert.rejects(call(m, "POST", "/api/manage/bulk-status", { ids: 7, status: "done" }), /Nenhuma issue/);
  await assert.rejects(call(m, "POST", "/api/manage/bulk-status", { ids: Array.from({ length: 51 }, (_, i) => `TASK-${i + 1}`), status: "done" }), /No máximo 50/);
});

test("busca exige 2 letras e inclui concluídas", async () => {
  const { multica, calls } = fakeCli({ "issue search": { issues: [{ id: ISSUE, identifier: "TASK-9", title: "a", status: "done", assignee_type: "agent", assignee_id: AGENT, match_source: "comment" }] } });
  const m = createManage({ multica, redact });
  const r = await call(m, "GET", "/api/manage/search?q=zoho");
  assert.equal(r.body.issues[0].match, "comment");
  assert.match(calls[0], /--include-closed/);
  await assert.rejects(call(m, "GET", "/api/manage/search?q=z"), /2 letras/);
  await assert.rejects(call(m, "GET", "/api/manage/search?q=--help"), /não pode começar/);
  assert.equal(calls.length, 1);
});

test("rotas de fora não são tratadas", async () => {
  const { multica } = fakeCli();
  const r = await call(createManage({ multica, redact }), "GET", "/api/office");
  assert.equal(r.handled, false);
});
