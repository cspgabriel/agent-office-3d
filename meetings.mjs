// Reuniões de agentes: uma issue com a pauta, atribuída ao coordenador; os
// demais participantes são chamados por menção num comentário, então todos
// trabalham no mesmo tópico. O painel guarda quem está em cada reunião
// (data/meetings.json) para levar os bonecos à sala de reunião.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ID = /^[0-9a-f-]{8,40}$/i;
const FOOTER = "\n\n---\n_Enviado pelo painel Escritório de Agentes._";
const MAX_AGENTS = 10;
const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export function createMeetings({ multica, file, onStart = () => {}, onChange = () => {}, initial = [] }) {
  let list = []; // { id, identifier, title, agents: [ids], coordinator, createdAt, status }

  async function load() {
    try {
      list = JSON.parse(await readFile(file, "utf8")).meetings ?? [];
    } catch {
      list = initial.map((m) => ({ ...m })); // sem arquivo ainda (ex.: demonstração)
    }
  }
  async function save() {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ meetings: list }, null, 1));
  }

  const mention = (id, name) => `[@${String(name ?? "agente").replace(/[[\]]/g, "")}](mention://agent/${id})`;

  /** Reuniões abertas (para o snapshot do escritório). */
  function active() {
    return list
      .filter((m) => OPEN.has(m.status))
      .map(({ id, identifier, title, agents, coordinator, createdAt, status }) => ({ id, identifier, title, agents, coordinator, createdAt, status }));
  }

  /** Atualiza o status das reuniões abertas; fecha as concluídas e as com mais de 2 dias. */
  async function refresh() {
    let dirty = false;
    for (const m of list.filter((x) => OPEN.has(x.status))) {
      try {
        const issue = await multica(["issue", "get", m.id]);
        if (issue.status !== m.status) {
          m.status = issue.status;
          dirty = true;
        }
      } catch {}
      if (OPEN.has(m.status) && Date.now() - new Date(m.createdAt) > 2 * 86400_000) {
        m.status = "expired";
        dirty = true;
      }
    }
    // Guarda só as 50 mais recentes.
    if (list.length > 50) {
      list = list.slice(-50);
      dirty = true;
    }
    if (dirty) await save();
  }

  async function create({ title, prompt, agents }, withTempFile) {
    const people = (agents ?? []).filter((a) => ID.test(a?.id ?? "")).slice(0, MAX_AGENTS);
    if (people.length < 2) throw Object.assign(new Error("Escolha pelo menos 2 agentes."), { status: 400 });
    if (!String(title ?? "").trim() || !String(prompt ?? "").trim()) throw Object.assign(new Error("Informe o assunto e a pauta."), { status: 400 });
    const [lead, ...rest] = people;
    // Na descrição, só os nomes: quem acorda os participantes é a menção no comentário (uma run por agente).
    const roster = people.map((a, i) => `- **${String(a.name ?? "agente")}**${i === 0 ? " — coordena e consolida a resposta final" : ""}`).join("\n");
    const body =
      `${String(prompt).trim()}\n\n## Reunião de agentes\n${roster}\n\n` +
      `**Como funciona:** cada participante contribui neste mesmo tópico com a sua especialidade (comentários curtos e objetivos, ` +
      `citando o que já foi dito pelos colegas). O coordenador organiza a discussão, resolve divergências e publica a conclusão.` +
      FOOTER;
    const issue = await withTempFile(body, (f) =>
      multica(["issue", "create", "--title", `🤝 Reunião: ${String(title).trim()}`.slice(0, 200), "--description-file", f, "--allow-external-file",
        "--assignee-id", lead.id, "--status", "todo"]),
    );
    // A menção é o que acorda os demais participantes no mesmo tópico.
    const call = `${rest.map((a) => mention(a.id, a.name)).join(" ")} vocês foram chamados para esta reunião com ${mention(lead.id, lead.name)} (coordenação). ` +
      `Leiam a pauta acima e contribuam aqui com a sua parte.${FOOTER}`;
    await withTempFile(call, (f) => multica(["issue", "comment", "add", issue.id, "--content-file", f, "--allow-external-file"])).catch(() => {});
    const m = {
      id: issue.id,
      identifier: issue.identifier,
      title: String(title).trim().slice(0, 120),
      agents: people.map((a) => a.id),
      coordinator: lead.id,
      createdAt: new Date().toISOString(),
      status: "todo",
    };
    list.push(m);
    await save();
    for (const a of people) onStart(a.id, `🤝 ${m.title}`);
    await onChange();
    return m;
  }

  async function message(id, text, names, withTempFile) {
    const m = list.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    if (!String(text ?? "").trim()) throw Object.assign(new Error("Escreva a mensagem."), { status: 400 });
    const tags = m.agents.map((a) => mention(a, names?.[a])).join(" ");
    await withTempFile(`${tags} ${String(text).trim()}${FOOTER}`, (f) =>
      multica(["issue", "comment", "add", m.id, "--content-file", f, "--allow-external-file"]),
    );
    if (!OPEN.has(m.status) || m.status === "in_review") {
      await multica(["issue", "status", m.id, "in_progress"]).catch(() => {});
      m.status = "in_progress";
      await save();
    }
    for (const a of m.agents) onStart(a, `🤝 ${m.title}`);
    await onChange();
  }

  async function end(id) {
    const m = list.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error("Reunião não encontrada."), { status: 404 });
    await multica(["issue", "status", m.id, "done"]).catch(() => {});
    m.status = "done";
    await save();
    await onChange();
  }

  /** Rotas /api/meetings*. Retorna true se tratou. */
  async function handle(req, res, path, { readJson, send, withTempFile }) {
    let mm;
    if (path === "/api/meetings" && req.method === "GET") return send(res, 200, { meetings: active() }), true;
    if (path === "/api/meetings" && req.method === "POST") {
      const m = await create(await readJson(req), withTempFile);
      return send(res, 200, { meeting: m }), true;
    }
    if ((mm = /^\/api\/meetings\/([^/]+)\/(message|end)$/.exec(path)) && req.method === "POST") {
      if (!ID.test(mm[1])) return send(res, 400, { error: "id inválido" }), true;
      if (mm[2] === "end") await end(mm[1]);
      else {
        const { text, names } = await readJson(req);
        await message(mm[1], text, names, withTempFile);
      }
      return send(res, 200, { ok: true }), true;
    }
    return false;
  }

  return { load, refresh, active, handle };
}
