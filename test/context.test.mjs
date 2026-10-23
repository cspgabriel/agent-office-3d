import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, plain, firstSentence } from "../context.mjs";

test("about = primeira fala do agente; now = última fala", () => {
  const r = summarize([
    { seq: 3, type: "text", content: "Pronto: **rótulo** publicado nas duas instalações. Detalhes abaixo." },
    { seq: 1, type: "text", content: "Vou mostrar no rótulo quantas atividades cada agente tem.\n\nDepois testo." },
    { seq: 2, type: "tool_use", tool: "Bash", input: { command: "npm test" } },
  ]);
  assert.equal(r.about, "Vou mostrar no rótulo quantas atividades cada agente tem.");
  assert.equal(r.now, "Pronto: rótulo publicado nas duas instalações.");
});

test("now = ferramenta em uso quando é a última coisa", () => {
  const r = summarize([
    { seq: 1, type: "text", content: "Vou rodar os testes." },
    { seq: 2, type: "tool_use", tool: "Bash", input: { command: "npm   test" } },
    { seq: 3, type: "tool_result", output: "ok" },
  ]);
  assert.equal(r.now, "🔧 Bash: npm test");
});

test("sem mensagens úteis: vazio; markdown, links, imagens e menções viram texto", () => {
  assert.deepEqual(summarize([]), { about: "", now: "" });
  assert.deepEqual(summarize(null), { about: "", now: "" });
  assert.equal(plain("Veja [o site](https://x.y) e ![img](a.png) com [@Ana](mention://agent/1) `npm`"), "Veja o site e com @Ana npm");
});

test("prefere a fala de planejamento a um status curto; ferramenta sem caminhos internos", () => {
  const r = summarize([
    { seq: 1, type: "text", content: "Servidor pronto." },
    { seq: 2, type: "text", content: "Vou ajustar o rótulo para mostrar o contexto real da tarefa." },
    { seq: 3, type: "tool_use", tool: "Read", input: { file_path: String.raw`C:\Users\x\work\repo\public\app.js` } },
  ]);
  assert.equal(r.about, "Vou ajustar o rótulo para mostrar o contexto real da tarefa.");
  assert.equal(r.now, "🔧 Read: app.js");
  const b = summarize([{ seq: 1, type: "tool_use", tool: "Bash", input: { command: 'cd "/c/Users/x/multica/workdir/repo" && npm test', description: "Rodar os testes" } }]);
  assert.equal(b.now, "🔧 Bash: Rodar os testes");
  const c = summarize([{ seq: 1, type: "tool_use", tool: "Bash", input: { command: "node /home/u/app/tools/build.mjs --out /home/u/app/dist\nsegunda linha" } }]);
  assert.equal(c.now, "🔧 Bash: node build.mjs --out dist");
});

test("frase curta demais continua no texto", () => {
  const r = summarize([{ seq: 1, type: "text", content: "Servidor pronto. Agora a parte visual: o rótulo mostra o assunto real." }]);
  assert.equal(r.about, "Servidor pronto. Agora a parte visual: o rótulo mostra o assunto real.");
});

test("frase longa é cortada com reticências", () => {
  const s = firstSentence("a".repeat(300), 50);
  assert.equal(s.length, 50);
  assert.ok(s.endsWith("…"));
});
