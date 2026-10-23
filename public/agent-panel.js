import { renderChats, renderConfig, renderConversation, renderLook } from "./agent-extra.js";

// Painel do agente: resumo público e, depois do login, histórico de runs
// (com os passos de cada uma), issues atribuídas e ações.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const RUN_STATUS = {
  running: "▶️ rodando",
  dispatched: "📤 enviada",
  queued: "⏳ na fila",
  completed: "✅ concluída",
  failed: "❌ falhou",
  cancelled: "⏹ cancelada",
};
const ISSUE_STATUS = {
  todo: "A fazer",
  in_progress: "Em andamento",
  in_review: "Em revisão",
  blocked: "Bloqueada",
  done: "Concluída",
  backlog: "Backlog",
  cancelled: "Cancelada",
};
const STATE_LABEL = { working: "Trabalhando", blocked: "Bloqueado", idle: "Ocioso", offline: "Offline" };

function ago(iso) {
  if (!iso) return "";
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} d`;
}
function duration(a, b) {
  if (!a) return "";
  const s = Math.round(((b ? new Date(b) : Date.now()) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}

export async function api(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json", "x-painel": "1" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status });
  return json;
}

export function createAgentPanel(el, { getAgent, onClose, onAuthChange, onChanged = () => {}, onMeet = () => {} }) {
  let cleanup = () => {};
  let agentId = null;
  let tab = "activity";
  let auth = { enabled: false, auth: false };
  let activity = null;
  let poller = null;
  const openRuns = new Set();

  el.innerHTML = `<button class="close" type="button" aria-label="Fechar">✕</button><div class="head"></div><div class="body"></div>`;
  const head = el.querySelector(".head");
  const body = el.querySelector(".body");
  el.querySelector(".close").onclick = () => onClose();
  head.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    if (handleFailAction(b)) return;
    if (b.dataset.act === "meet" || b.dataset.act === "talk") return onMeet(agentId, b.dataset.act === "talk");
    if (b.dataset.act === "rerun" && confirm(`Rodar ${b.dataset.label} de novo com este agente?`)) {
      actRaw(() => api(`/api/issues/${b.dataset.issue}/rerun`, {}), `${b.dataset.label} reenfileirada.`);
    }
  });

  function renderHead() {
    const a = getAgent(agentId);
    if (!a) return;
    head.innerHTML = `
      <h2><span>${esc(a.emoji)}</span>${esc(a.name)}</h2>
      <div class="meta"><span class="dot ${a.state}"></span> ${STATE_LABEL[a.state]} · 💻 ${esc(a.machine)} · ${esc(a.provider)}${a.squad ? ` · 👥 ${esc(a.squad)}${a.leader ? " (líder)" : ""}` : ""}</div>
      <div class="meta">${a.today?.runs ? `⚡ <b>${a.today.runs}</b> execuç${a.today.runs > 1 ? "ões" : "ão"} hoje · ✅ ${a.today.ok}${a.today.failed ? ` · ❌ ${a.today.failed}` : ""}${a.today.lastAt ? ` · última ${new Date(a.today.lastAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}` : ""}` : "Ainda não executou nada hoje"}${a.review ? ` · 👀 ${a.review} em revisão` : ""}</div>
      ${auth.auth ? `<div class="head-actions">
        <button type="button" data-act="talk" title="Abre uma conversa entre este agente e outro, no mesmo tópico">🗣️ Conversar com outro agente</button>
        <button type="button" data-act="meet" title="Reunião com vários agentes para uma mesma tarefa">🤝 Chamar para reunião</button></div>` : ""}
      ${a.work.length ? `<div class="section-title">Agora${a.work.length > 1 ? ` · ${a.work.filter((w) => !w.queued).length} ao mesmo tempo` : ""}</div>${a.work.map((w) => `<div class="item">${w.queued ? "🕓" : w.kind === "chat" ? "💬" : w.kind === "autopilot" ? "⏰" : "📋"} ${w.issue ? `<b>${esc(w.issue.identifier)}</b> ${esc(w.issue.title)}` : esc(w.label ?? w.kind)} <small>· ${w.queued ? "na fila" : ago(w.startedAt)}</small></div>`).join("")}` : ""}
      ${a.blocked.length ? `<div class="section-title">🚧 Pendências (${a.blocked.length} bloqueada${a.blocked.length > 1 ? "s" : ""})</div>${a.blocked
        .map((b) => `<div class="item pend"><div><b>${esc(b.identifier)}</b> ${esc(b.title)}</div>${auth.auth && b.id ? `<div class="run-actions">
            <button type="button" class="primary" data-act="issue-status" data-status="done" data-issue="${b.id}" data-label="${esc(b.identifier)}">✅ Concluir</button>
            <button type="button" data-act="issue-status" data-status="todo" data-issue="${b.id}" data-label="${esc(b.identifier)}">↩️ Voltar para a fila</button>
            <button type="button" data-act="rerun" data-issue="${b.id}" data-label="${esc(b.identifier)}">🔁 Rodar de novo</button>
            <button type="button" class="danger" data-act="issue-status" data-status="cancelled" data-issue="${b.id}" data-label="${esc(b.identifier)}">🚫 Cancelar</button></div>` : ""}</div>`)
        .join("")}` : ""}
      ${a.description ? `<p class="desc">${esc(a.description)}</p>` : ""}`;
  }

  /** Botões para uma execução que falhou: resolver a issue ou arquivar a falha. */
  function failActions(runId, issue, acked) {
    const iss = issue
      ? `<button type="button" class="primary" data-act="issue-status" data-status="done" data-issue="${issue.id}" data-label="${esc(issue.identifier)}">✅ Concluir issue</button>
         <button type="button" class="danger" data-act="issue-status" data-status="cancelled" data-issue="${issue.id}" data-label="${esc(issue.identifier)}">🚫 Cancelar issue</button>`
      : "";
    return `${iss}<button type="button" data-act="ack" data-run="${runId}" data-ack="${acked ? "0" : "1"}">${acked ? "↩️ Desarquivar falha" : "📦 Arquivar falha"}</button>`;
  }

  const STATUS_MSG = { done: "concluída", cancelled: "cancelada", todo: "voltou para a fila", in_progress: "em andamento" };
  /** Trata os botões de falha/pendência (no cabeçalho ou no corpo). Retorna true se tratou. */
  function handleFailAction(b) {
    const { act: kind, run, issue, label, status } = b.dataset;
    if (kind === "issue-status") {
      const verb = { done: "Concluir", cancelled: "Cancelar", todo: "Voltar para a fila" }[status] ?? status;
      if (!confirm(`${verb} ${label}?`)) return true;
      actRaw(() => api(`/api/issues/${issue}/status`, { status }), `${label} ${STATUS_MSG[status] ?? status}.`);
      return true;
    }
    if (kind === "ack") {
      const on = b.dataset.ack === "1";
      actRaw(() => api("/api/acks", { id: run, ack: on }), on ? "Falha arquivada: saiu das pendências." : "Falha desarquivada.");
      return true;
    }
    return false;
  }

  function renderBody() {
    clearInterval(poller);
    cleanup();
    cleanup = () => {};
    if (!auth.enabled) {
      body.innerHTML = `<p class="muted">Histórico e ações estão desligados neste servidor (sem senha de administrador configurada).</p>`;
      return;
    }
    if (!auth.auth) {
      body.innerHTML = `<button type="button" class="primary wide" data-act="login">🔐 Entrar para ver histórico e ações</button>`;
      return;
    }
    body.innerHTML = `
      <div class="tabs" role="tablist">
        ${[["activity", "📜 Atividade"], ["chat", "💬 Conversa"], ["chats", "🗨️ Chats"], ["issues", "📋 Issues"], ["new", "➕ Tarefa"], ["look", "👕 Visual"], ["config", "⚙️ Configurar"]]
          .map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}</button>`)
          .join("")}
      </div>
      <div class="tab-body"></div>`;
    const tb = body.querySelector(".tab-body");
    if (tab === "new") return renderNew(tb);
    const extra = { chat: renderConversation, chats: renderChats, config: renderConfig, look: renderLook }[tab];
    if (extra) {
      const a = getAgent(agentId);
      cleanup = extra(tb, { agent: a, api, flash, onChanged: (info) => onChanged(agentId, info) }) ?? (() => {});
      return;
    }
    if (!activity) {
      tb.innerHTML = `<p class="muted">Carregando…</p>`;
      loadActivity();
      return;
    }
    if (activity.error) {
      tb.innerHTML = `<p class="error">${esc(activity.error)}</p><button type="button" data-act="reload">Tentar de novo</button>`;
      return;
    }
    if (tab === "activity") renderActivity(tb);
    else renderIssues(tb);
  }

  function renderActivity(tb) {
    const runs = activity.runs;
    tb.innerHTML =
      `<div class="toolbar"><small class="muted">Últimas ${runs.length} runs</small><button type="button" data-act="reload">↻ Atualizar</button></div>` +
      (runs.length
        ? runs
            .map((r) => {
              const live = ["running", "dispatched", "queued"].includes(r.status);
              const what = r.issue ? `<b>${esc(r.issue.identifier)}</b> ${esc(r.issue.title)}` : r.kind === "chat" ? `Chat${r.by ? ` com ${esc(r.by)}` : ""}` : esc(r.kind);
              const failed = r.status === "failed";
              return `<div class="run ${live ? "live" : ""} ${failed ? (r.acked ? "acked" : "failed") : ""}" data-run="${r.id}">
                <div class="run-top"><span class="pill">${RUN_STATUS[r.status] ?? esc(r.status)}${failed && r.acked ? " · 📦 arquivada" : ""}</span><small class="muted">${ago(r.createdAt)} · ${duration(r.startedAt, r.completedAt)}</small></div>
                <div class="run-what">${what}</div>
                ${r.error ? `<div class="error small">${esc(r.error)}</div>` : ""}
                <div class="run-actions">
                  <button type="button" data-act="steps" data-run="${r.id}">${openRuns.has(r.id) ? "▲ Esconder passos" : "▼ Ver passos"}</button>
                  ${live ? `<button type="button" class="danger" data-act="cancel" data-run="${r.id}">⏹ Cancelar</button>` : ""}
                  ${r.issue && !live ? `<button type="button" data-act="rerun" data-issue="${r.issue.id}" data-label="${esc(r.issue.identifier)}">🔁 Rodar de novo</button>` : ""}
                  ${failed ? failActions(r.id, r.issue, r.acked) : ""}
                </div>
                <div class="steps" ${openRuns.has(r.id) ? "" : "hidden"}></div>
              </div>`;
            })
            .join("")
        : `<p class="muted">Nenhuma run recente.</p>`);
    for (const id of openRuns) loadSteps(id);
    // Enquanto houver run ao vivo aberta, atualiza os passos a cada 6 s.
    if (runs.some((r) => openRuns.has(r.id) && ["running", "dispatched", "queued"].includes(r.status))) {
      poller = setInterval(() => {
        for (const id of openRuns) loadSteps(id);
      }, 6000);
    }
  }

  async function loadSteps(runId) {
    const box = body.querySelector(`.run[data-run="${runId}"] .steps`);
    if (!box) return;
    if (!box.innerHTML) box.innerHTML = `<p class="muted">Carregando passos…</p>`;
    try {
      const { messages } = await api(`/api/runs/${runId}/messages`);
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
      box.innerHTML = messages.length
        ? messages
            .map((m) =>
              m.type === "text"
                ? `<div class="step text">💬 ${esc(m.text)}</div>`
                : m.type === "tool"
                  ? `<div class="step tool">🔧 <b>${esc(m.tool)}</b> <code>${esc(m.text)}</code></div>`
                  : m.type === "result"
                    ? `<details class="step result"><summary>↳ resultado</summary><pre>${esc(m.text)}</pre></details>`
                    : "",
            )
            .join("")
        : `<p class="muted">Sem passos registrados (chats nem sempre guardam mensagens).</p>`;
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  function renderIssues(tb) {
    const issues = activity.issues;
    tb.innerHTML =
      `<div class="toolbar"><small class="muted">Issues atribuídas (${issues.length} mais recentes)</small><button type="button" data-act="reload">↻ Atualizar</button></div>` +
      (issues.length
        ? issues
            .map(
              (i) => `<div class="issue" data-issue="${i.id}">
                <div><b>${esc(i.identifier)}</b> ${esc(i.title)}</div>
                <div class="issue-actions">
                  <select data-act="status" data-issue="${i.id}" data-label="${esc(i.identifier)}" aria-label="Status de ${esc(i.identifier)}">
                    ${Object.entries(ISSUE_STATUS).map(([k, l]) => `<option value="${k}" ${k === i.status ? "selected" : ""}>${l}</option>`).join("")}
                  </select>
                  <button type="button" data-act="instruct" data-issue="${i.id}">💬 Instruir</button>
                  <button type="button" data-act="rerun" data-issue="${i.id}" data-label="${esc(i.identifier)}">🔁 Rodar de novo</button>
                </div>
                <form class="instruct" data-issue="${i.id}" hidden>
                  <textarea required rows="3" placeholder="O que o agente deve fazer nesta issue?"></textarea>
                  <button type="submit" class="primary">Enviar ao agente</button>
                </form>
              </div>`,
            )
            .join("")
        : `<p class="muted">Nenhuma issue atribuída.</p>`);
  }

  function renderNew(tb) {
    const a = getAgent(agentId);
    tb.innerHTML = `<form class="new-task">
        <label>Título<input name="title" required maxlength="200" placeholder="Ex.: Relatório semanal de leads" /></label>
        <label>Instruções<textarea name="prompt" required rows="7" placeholder="Descreva a tarefa para ${esc(a?.name ?? "o agente")}…"></textarea></label>
        <button type="submit" class="primary wide">🚀 Criar tarefa e iniciar</button>
        <p class="muted small">Cria uma issue atribuída ao agente; a run começa na hora.</p>
        <div class="result"></div>
      </form>`;
  }

  async function loadActivity() {
    const id = agentId;
    if (!id) return;
    try {
      const a = await api(`/api/agents/${id}/activity`);
      if (id !== agentId) return;
      activity = a;
    } catch (e) {
      if (e.status === 401) {
        auth.auth = false;
        onAuthChange(auth);
      }
      activity = { error: e.message };
    }
    renderBody();
  }

  function flash(msg, ok = true) {
    const t = document.createElement("div");
    t.className = `toast ${ok ? "" : "bad"}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function act(fn, okMsg) {
    return actRaw(fn, okMsg);
  }

  async function actRaw(fn, okMsg) {
    try {
      await fn();
      flash(okMsg);
      activity = null;
      renderBody();
      onChanged(agentId);
    } catch (e) {
      flash(e.message, false);
    }
  }

  body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act], [data-tab]");
    if (!b || b.tagName === "SELECT") return;
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      return renderBody();
    }
    const { act: kind, run, issue, label } = b.dataset;
    if (kind === "login") return login();
    if (handleFailAction(b)) return;
    if (kind === "reload") {
      activity = null;
      return renderBody();
    }
    if (kind === "steps") {
      if (openRuns.has(run)) openRuns.delete(run);
      else openRuns.add(run);
      return renderActivity(body.querySelector(".tab-body"));
    }
    if (kind === "cancel" && confirm("Cancelar esta run? O agente é interrompido na hora.")) {
      return act(() => api(`/api/runs/${run}/cancel`, {}), "Run cancelada.");
    }
    if (kind === "rerun" && confirm(`Rodar ${label} de novo com este agente?`)) {
      return act(() => api(`/api/issues/${issue}/rerun`, {}), `${label} reenfileirada.`);
    }
    if (kind === "instruct") {
      const f = body.querySelector(`form.instruct[data-issue="${issue}"]`);
      f.hidden = !f.hidden;
      if (!f.hidden) f.querySelector("textarea").focus();
    }
  });

  body.addEventListener("change", (e) => {
    const s = e.target.closest('select[data-act="status"]');
    if (!s) return;
    const prev = activity.issues.find((i) => i.id === s.dataset.issue)?.status;
    if (!confirm(`Mudar ${s.dataset.label} para "${ISSUE_STATUS[s.value]}"?`)) {
      s.value = prev;
      return;
    }
    act(() => api(`/api/issues/${s.dataset.issue}/status`, { status: s.value }), `${s.dataset.label}: ${ISSUE_STATUS[s.value]}.`);
  });

  body.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (f.classList.contains("new-task")) {
        const { issue } = await api(`/api/agents/${agentId}/task`, { title: f.elements.title.value, prompt: f.elements.prompt.value });
        f.querySelector(".result").innerHTML = `<p class="ok">✅ Criada <b>${esc(issue.identifier)}</b>. O agente já recebeu a tarefa.</p>`;
        f.reset();
        activity = null;
      } else if (f.classList.contains("instruct")) {
        const a = getAgent(agentId);
        await api(`/api/issues/${f.dataset.issue}/comment`, { text: f.querySelector("textarea").value, agentId, agentName: a?.name });
        flash("Instrução enviada; o agente foi acordado.");
        f.reset();
        f.hidden = true;
      }
    } catch (err) {
      flash(err.message, false);
    } finally {
      btn.disabled = false;
    }
  });

  async function login() {
    const dlg = document.createElement("dialog");
    dlg.className = "login";
    dlg.innerHTML = `<form method="dialog">
        <h3>🔐 Entrar no painel</h3>
        <input type="password" name="password" autocomplete="current-password" required placeholder="Senha de administrador" />
        <p class="error small" hidden></p>
        <div class="row"><button value="cancel" formnovalidate type="submit">Cancelar</button><button class="primary" value="ok" type="submit">Entrar</button></div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    const form = dlg.querySelector("form");
    form.addEventListener("submit", async (e) => {
      if (e.submitter?.value !== "ok") return dlg.close();
      e.preventDefault();
      try {
        await api("/api/login", { password: form.password.value });
        auth = await api("/api/me");
        onAuthChange(auth);
        dlg.close();
        activity = null;
        if (agentId) renderBody();
      } catch (err) {
        const p = form.querySelector(".error");
        p.hidden = false;
        p.textContent = err.message;
      }
    });
    dlg.addEventListener("close", () => dlg.remove());
  }

  return {
    async init() {
      auth = await api("/api/me").catch(() => ({ enabled: false, auth: false }));
      onAuthChange(auth);
      return auth;
    },
    login,
    get auth() {
      return auth;
    },
    async logout() {
      await api("/api/logout", {}).catch(() => {});
      auth = { ...auth, auth: false };
      onAuthChange(auth);
      if (agentId) renderBody();
    },
    /** Abre o painel do agente já numa aba (ex.: "new", "chat"). */
    showTab(id, t) {
      this.show(id);
      if (!id) return;
      tab = t;
      renderBody();
    },
    show(id) {
      if (id !== agentId) {
        agentId = id;
        activity = null;
        openRuns.clear();
        tab = "activity";
      }
      el.hidden = !id;
      if (!id) {
        cleanup();
        cleanup = () => {};
        return clearInterval(poller);
      }
      renderHead();
      renderBody();
    },
    /** A cada atualização do escritório: só o resumo, para não apagar formulários. */
    refresh() {
      if (agentId) renderHead();
    },
  };
}
