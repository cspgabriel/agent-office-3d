// Painel de gestão de uma issue (ou de uma execução avulsa, como um chat):
// dados, status, prioridade, responsável, comentários, execuções com os passos,
// linha do tempo e consumo — e as ações (comentar chamando o agente, rodar de
// novo, cancelar execução, concluir/cancelar a issue).

import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = { timeZone: "America/Sao_Paulo" };
const when = (d) => (d ? new Date(d).toLocaleString("pt-BR", { ...TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const dur = (a, b) => {
  if (!a || !b) return "";
  const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n ?? 0));
export const STATUS = { backlog: "Backlog", todo: "A fazer", in_progress: "Em andamento", in_review: "Em revisão", blocked: "Bloqueada", done: "Concluída", cancelled: "Cancelada" };
const PRIORITY = { none: "Sem prioridade", low: "Baixa", medium: "Média", high: "Alta", urgent: "Urgente" };
const LIVE = new Set(["queued", "dispatched", "running", "waiting_local_directory", "pending"]);
const RUN_LABEL = { completed: "✅ Concluída", failed: "❌ Falhou", cancelled: "⏹ Cancelada", running: "⏳ Rodando", dispatched: "⏳ Iniciando", queued: "🕓 Na fila" };
const ACTION = { created: "criou", status_changed: "mudou o status", assignee_changed: "mudou o responsável", priority_changed: "mudou a prioridade", title_changed: "mudou o título", description_changed: "editou a descrição" };

export function createIssueDrawer(el, { getData, toast, onAgent, onChanged = () => {} }) {
  let ref = null; // id ou identificador da issue aberta
  let run = null; // execução avulsa aberta (sem issue)
  let detail = null;
  let tab = "comments";
  const openSteps = new Map(); // runId → passos

  const agents = () => (getData()?.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const agentOf = (id) => getData()?.agents.find((a) => a.id === id);
  const agentName = (id) => {
    const a = agentOf(id);
    return a ? `${a.emoji} ${a.name}` : "agente";
  };

  async function open(issueRef) {
    ref = issueRef;
    run = null;
    detail = null;
    openSteps.clear();
    el.hidden = false;
    render();
    let d;
    try {
      d = await api(`/api/manage/issues/${encodeURIComponent(issueRef)}`);
    } catch (e) {
      d = { error: e.message };
    }
    if (ref !== issueRef || el.hidden) return; // outra issue foi aberta (ou o painel fechou) enquanto carregava
    detail = d;
    render();
  }

  /** Execução sem issue (ex.: chat): mostra os passos direto. */
  async function openRun(r) {
    ref = null;
    run = r;
    detail = null;
    el.hidden = false;
    render();
    await loadSteps(r.id);
    if (run === r) render();
  }

  function close() {
    el.hidden = true;
    ref = run = detail = null;
  }

  async function loadSteps(runId) {
    try {
      openSteps.set(runId, (await api(`/api/runs/${encodeURIComponent(runId)}/messages`)).messages ?? []);
    } catch (e) {
      openSteps.set(runId, [{ type: "error", text: e.message }]);
    }
  }

  const steps = (runId) => {
    const list = openSteps.get(runId);
    if (!list) return `<p class="muted">⏳ Carregando passos…</p>`;
    if (!list.length) return `<p class="muted">Sem passos registrados.</p>`;
    return `<div class="m-steps">${list
      .map((m) =>
        m.type === "text" ? `<div class="m-step text">${esc(m.text)}</div>`
        : m.type === "tool" ? `<div class="m-step tool">🔧 <b>${esc(m.tool)}</b> <code>${esc(m.text)}</code></div>`
        : m.type === "result" ? `<div class="m-step result">${esc(m.text)}</div>`
        : m.type === "error" ? `<div class="m-step err">${esc(m.text)}</div>` : "")
      .join("")}</div>`;
  };

  function render() {
    if (run) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="Fechar">✕</button>
        <div class="m-head"><h2>${run.kind === "chat" ? "💬 Chat" : "▶️ Execução"} · ${esc(agentName(run.agentId))}</h2>
          <div class="muted">${esc(when(run.createdAt))}${run.by ? ` · por ${esc(run.by)}` : ""} · ${esc(RUN_LABEL[run.status] ?? run.status)}</div>
          ${run.about ? `<div class="m-ctx"><b>📝 Do que se trata</b>${esc(run.about)}</div>` : ""}
          ${run.now ? `<div class="m-ctx"><b>✍️ Agora</b>${esc(run.now)}</div>` : ""}
          <p class="muted small">Chats do Multica são só leitura aqui (a CLI não responde em chats de outras pessoas). Para continuar, use “💬 Conversa” no painel do agente.</p>
          <div class="m-actions">${LIVE.has(run.status) ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(run.id)}">⏹ Cancelar execução</button>` : ""}
            <button type="button" data-m="agent" data-agent="${esc(run.agentId)}">Abrir agente</button>
            <button type="button" data-m="run-reload">↻ Atualizar passos</button></div></div>
        <div class="m-body">${steps(run.id)}</div>`;
      return;
    }
    if (!detail) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="Fechar">✕</button><p class="muted">⏳ Carregando ${esc(ref)}…</p>`;
      return;
    }
    if (detail.error) {
      el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="Fechar">✕</button><p class="error">Não deu para abrir: ${esc(detail.error)}</p>`;
      return;
    }
    const { issue: i, comments, runs, timeline, usage } = detail;
    const live = runs.find((r) => LIVE.has(r.status));
    const opts = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
    const assigneeOpts =
      `<option value="">— sem responsável —</option>` +
      (i.assigneeType && i.assigneeType !== "agent" ? `<option value="__keep" selected>👤 membro/squad (atual)</option>` : "") +
      agents().map((a) => `<option value="${esc(a.id)}" ${a.id === i.assignee ? "selected" : ""}>${esc(a.emoji)} ${esc(a.name)}</option>`).join("");
    const tabs = [["comments", `💬 Comentários (${comments.length})`], ["runs", `⏱️ Execuções (${runs.length})`], ["timeline", "🕓 Linha do tempo"], ["desc", "📄 Descrição"]];
    let body = "";
    if (tab === "comments") {
      body = (comments.length
        ? comments.map((c) => `<div class="m-comment ${c.authorType === "agent" ? "agent" : "member"}"><div class="m-meta">${c.authorType === "agent" ? esc(agentName(c.author)) : "👤 membro"} · ${esc(when(c.at))}</div><div class="m-text">${esc(c.text)}</div></div>`).join("")
        : `<p class="muted">Sem comentários.</p>`) +
        `<div class="m-reply"><textarea name="text" rows="3" placeholder="Escreva um comentário ou instrução…"></textarea>
          <label class="m-check"><input type="checkbox" name="wake" ${i.assignee ? "checked" : ""} ${i.assignee ? "" : "disabled"} /> chamar ${i.assignee ? esc(agentName(i.assignee)) : "o responsável"} (menção acorda o agente)</label>
          <button type="button" class="primary" data-m="comment">💬 Comentar</button></div>`;
    } else if (tab === "runs") {
      body = runs.length
        ? runs.map((r) => `<div class="m-run"><div class="m-run-head">
            <span>${esc(RUN_LABEL[r.status] ?? r.status)}</span><b>${esc(agentName(r.agentId))}</b>
            <small class="muted">${esc(when(r.createdAt))}${r.completedAt ? ` · ${dur(r.startedAt ?? r.createdAt, r.completedAt)}` : ""}</small></div>
            ${r.trigger ? `<small class="muted">${esc(r.trigger)}</small>` : ""}
            ${r.error ? `<small class="h-err">${esc(r.error)}</small>` : ""}
            <div class="m-actions"><button type="button" data-m="steps" data-run="${esc(r.id)}">${openSteps.has(r.id) ? "▲ Esconder passos" : "▼ Ver passos"}</button>
              ${LIVE.has(r.status) ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(r.id)}">⏹ Cancelar</button>` : ""}</div>
            ${openSteps.has(r.id) ? steps(r.id) : ""}</div>`).join("")
        : `<p class="muted">Nenhuma execução.</p>`;
    } else if (tab === "timeline") {
      body = timeline.length
        ? `<ul class="m-timeline">${timeline.map((e) => `<li><small>${esc(when(e.at))}</small> <b>${esc(e.actor)}</b> ${esc(ACTION[e.action] ?? e.action)}${e.to ? ` → ${esc(STATUS[e.to] ?? e.to)}` : ""}</li>`).join("")}</ul>`
        : `<p class="muted">Sem eventos.</p>`;
    } else body = `<div class="m-desc">${esc(i.description) || '<span class="muted">Sem descrição.</span>'}</div>`;

    el.innerHTML = `<button class="close" type="button" data-m="close" aria-label="Fechar">✕</button>
      <div class="m-head">
        <h2><span class="m-id">${esc(i.identifier)}</span> ${esc(i.title)} <button type="button" class="m-edit" data-m="title" title="Editar título">✏️</button></h2>
        <div class="muted small">criada ${esc(when(i.createdAt))} · atualizada ${esc(when(i.updatedAt))}${usage ? ` · ${usage.runs} execuções · ${fmtK(usage.input + usage.cacheRead)} tokens lidos, ${fmtK(usage.output)} escritos` : ""}</div>
        <div class="m-fields">
          <label>Status<select data-m="status">${opts(STATUS, i.status)}</select></label>
          <label>Prioridade<select data-m="priority">${opts(PRIORITY, i.priority)}</select></label>
          <label>Responsável<select data-m="assign">${assigneeOpts}</select></label>
          <label>Prazo<input type="date" data-m="due" value="${esc((i.dueDate ?? "").slice(0, 10))}" /></label>
        </div>
        <div class="m-actions">
          ${i.assigneeType === "agent" ? `<button type="button" data-m="rerun">🔁 Rodar de novo</button>` : ""}
          ${live ? `<button type="button" class="danger" data-m="cancel-run" data-run="${esc(live.id)}">⏹ Cancelar execução em andamento</button>` : ""}
          ${i.status !== "done" ? `<button type="button" class="primary" data-m="set" data-status="done">✅ Concluir</button>` : ""}
          ${i.status !== "cancelled" ? `<button type="button" class="danger" data-m="set" data-status="cancelled">🚫 Cancelar issue</button>` : ""}
          ${i.assignee && agentOf(i.assignee) ? `<button type="button" data-m="agent" data-agent="${esc(i.assignee)}">Abrir agente</button>` : ""}
          <button type="button" data-m="reload">↻</button>
        </div>
      </div>
      <div class="m-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
      <div class="m-body">${body}</div>`;
  }

  /** Executa uma ação, avisa e recarrega o detalhe. */
  async function act(fn, ok) {
    try {
      await fn();
      toast(ok);
      onChanged();
      if (ref && !el.hidden) await open(ref);
    } catch (e) {
      toast(`Não deu: ${e.message}`, false);
      if (ref) render();
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.m === "close") return close();
    if (d.tab) return (tab = d.tab), render();
    if (d.m === "reload") return ref && open(ref);
    if (d.m === "run-reload" && run) {
      openSteps.delete(run.id);
      render();
      await loadSteps(run.id);
      return render();
    }
    if (d.m === "comment") return comment();
    if (d.m === "title") {
      const t = prompt("Novo título:", detail.issue.title);
      if (t == null || !t.trim() || t.trim() === detail.issue.title) return;
      return act(() => api(`/api/manage/issues/${detail.issue.id}/edit`, { title: t.trim() }), "Título atualizado.");
    }
    if (d.m === "agent") return onAgent(d.agent);
    if (d.m === "steps") {
      if (openSteps.has(d.run)) openSteps.delete(d.run);
      else {
        openSteps.set(d.run, undefined); // aberto, carregando
        render();
        await loadSteps(d.run);
      }
      return render();
    }
    const id = detail?.issue?.id;
    if (d.m === "cancel-run" && confirm("Cancelar esta execução? O agente é interrompido.")) {
      return act(() => api(`/api/runs/${encodeURIComponent(d.run)}/cancel`, {}), "Execução cancelada.").then(() => run && openRun({ ...run, status: "cancelled" }));
    }
    if (d.m === "rerun" && confirm(`Rodar ${detail.issue.identifier} de novo com ${agentName(detail.issue.assignee)}?`)) {
      return act(() => api(`/api/issues/${id}/rerun`, {}), "Reenfileirada.");
    }
    if (d.m === "set" && confirm(`${d.status === "done" ? "Concluir" : "Cancelar"} ${detail.issue.identifier}?`)) {
      return act(() => api(`/api/issues/${id}/status`, { status: d.status }), d.status === "done" ? "Issue concluída." : "Issue cancelada.");
    }
  });

  el.addEventListener("change", (e) => {
    const s = e.target.closest("select[data-m], input[data-m]");
    if (!s || !detail?.issue) return;
    if (s.dataset.m === "due" && !s.value) return toast("Para remover o prazo, use o Multica.", false), render();
    if (s.dataset.m === "due") return act(() => api(`/api/manage/issues/${detail.issue.id}/edit`, { dueDate: s.value }), s.value ? `Prazo: ${s.value.split("-").reverse().join("/")}.` : "Prazo removido.");
    const id = detail.issue.id;
    if (s.dataset.m === "status") {
      if (["done", "cancelled"].includes(s.value) && !confirm(`Mudar ${detail.issue.identifier} para “${STATUS[s.value]}”?`)) return render();
      return act(() => api(`/api/issues/${id}/status`, { status: s.value }), `Status: ${STATUS[s.value]}.`);
    }
    if (s.dataset.m === "priority") return act(() => api(`/api/manage/issues/${id}/priority`, { priority: s.value }), `Prioridade: ${PRIORITY[s.value]}.`);
    if (s.dataset.m === "assign" && s.value !== "__keep") {
      const label = s.value ? agentName(s.value) : "ninguém";
      if (!confirm(`Atribuir ${detail.issue.identifier} a ${label}?${s.value ? " Isso pode iniciar uma execução." : ""}`)) return render();
      return act(() => api(`/api/manage/issues/${id}/assign`, { agentId: s.value || null }), `Atribuída a ${label}.`);
    }
  });

  function comment() {
    const box = el.querySelector(".m-reply textarea");
    const text = box.value.trim();
    if (!text) return box.focus();
    const i = detail.issue;
    const wake = el.querySelector(".m-reply [name=wake]")?.checked && i.assignee;
    act(() => api(`/api/issues/${i.id}/comment`, { text, ...(wake ? { agentId: i.assignee, agentName: agentOf(i.assignee)?.name ?? "agente" } : {}) }), wake ? "Comentário enviado e agente chamado." : "Comentário enviado.");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.hidden && !e.target.closest?.("textarea, input")) close();
  });

  return { open, openRun, close };
}
