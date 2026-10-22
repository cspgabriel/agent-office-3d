// Histórico: o que já rodou e o que foi feito.
// - Execuções: últimas runs de todos os agentes (tarefas, chats, agendadas).
// - Agendadas: execuções das tarefas agendadas (autopilots), com falhas em destaque.
// - Issues: todas as tarefas em ordem de atividade (a mais recente primeiro), por dia.

import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = { timeZone: "America/Sao_Paulo" };
const hm = (d) => new Date(d).toLocaleTimeString("pt-BR", { ...TZ, hour: "2-digit", minute: "2-digit" });
const dayKey = (d) => new Date(d).toLocaleDateString("pt-BR", { ...TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function dayLabel(d) {
  const k = dayKey(d);
  if (k === dayKey(Date.now())) return "Hoje";
  if (k === dayKey(Date.now() - 86400_000)) return "Ontem";
  return new Date(d).toLocaleDateString("pt-BR", { ...TZ, weekday: "long", day: "2-digit", month: "long" });
}
function dur(a, b) {
  if (!a || !b) return "";
  const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
}
const RUN_ST = {
  completed: ["✅", "ok", "Concluída"],
  succeeded: ["✅", "ok", "Concluída"],
  done: ["✅", "ok", "Concluída"],
  failed: ["❌", "bad", "Falhou"],
  error: ["❌", "bad", "Falhou"],
  cancelled: ["⏹", "muted", "Cancelada"],
  canceled: ["⏹", "muted", "Cancelada"],
  running: ["⏳", "live", "Rodando"],
  dispatched: ["⏳", "live", "Iniciando"],
  queued: ["🕓", "muted", "Na fila"],
  pending: ["🕓", "muted", "Na fila"],
  skipped: ["⏭", "muted", "Pulada"],
};
const ISSUE_ST = {
  backlog: ["Backlog", "muted"], todo: ["A fazer", "muted"], in_progress: ["Em andamento", "live"], in_review: ["Em revisão", "warn"],
  blocked: ["Bloqueada", "bad"], done: ["Concluída", "ok"], cancelled: ["Cancelada", "muted"],
};
const KIND = { direct: "Tarefa", chat: "Chat", autopilot: "Agendada", mention: "Menção", comment: "Comentário" };

export function createHistory(el, { getData, getAuth, login, onAgent, onSchedule, onIssue, onRun, toast }) {
  let tab = "runs";
  let filter = "all";
  let q = "";
  const selected = new Set(); // issues marcadas para ação em lote
  let found = null; // resultado da busca no servidor (títulos, descrições e comentários)
  const source = (t) => (t === "chats" ? "runs" : t); // a aba Chats usa as execuções
  let issuePages = 3; // páginas de 100 issues (as mais recentes primeiro)
  const loaded = {}; // tab → { at, items }
  let loading = false;

  const agentOf = (id) => getData()?.agents.find((a) => a.id === id);
  const who = (id) => {
    const a = agentOf(id);
    return a ? `<button type="button" class="h-agent" data-agent="${esc(a.id)}">${esc(a.emoji)} ${esc(a.name)}</button>` : `<span class="muted">—</span>`;
  };

  async function load(fresh = false) {
    if (!getAuth().auth) {
      el.innerHTML = `<div class="h-empty"><p>O histórico mostra execuções e issues do Multica — entre para ver.</p><button type="button" class="primary" data-h="login">🔐 Entrar</button></div>`;
      return;
    }
    const key = source(tab);
    if (loaded[key] && !fresh) return render();
    loading = true;
    render();
    const path = { runs: "/api/history/runs", schedules: "/api/history/schedules", issues: "/api/history/issues" }[key];
    try {
      const qs = new URLSearchParams();
      if (fresh) qs.set("refresh", "1");
      if (key === "issues" && issuePages > 3) qs.set("pages", String(issuePages));
      const res = await api(`${path}${qs.size ? `?${qs}` : ""}`);
      loaded[key] = { at: Date.now(), items: res.runs ?? res.issues ?? [], more: Boolean(res.more) };
    } catch (e) {
      loaded[key] = { at: Date.now(), items: [], error: e.message };
    }
    loading = false;
    render();
  }

  function head(items) {
    const tabs = [
      ["runs", "⏱️ Execuções"],
      ["chats", "💬 Chats"],
      ["schedules", "⏰ Agendadas"],
      ["issues", "📋 Issues"],
    ];
    const chips =
      tab === "issues"
        ? [["all", "Todas"], ["done", "Concluídas"], ["in_progress", "Em andamento"], ["in_review", "Em revisão"], ["todo", "A fazer"], ["blocked", "Bloqueadas"], ["cancelled", "Canceladas"]]
        : [["all", "Todas"], ["ok", "Concluídas"], ["bad", "Falhas"], ["live", "Rodando"]];
    return `
      <div class="h-top">
        <div class="h-tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" aria-pressed="${tab === k}">${l}</button>`).join("")}</div>
        <input class="h-search" placeholder="${tab === "issues" ? "🔎 Filtrar… (Enter busca também em descrições e comentários)" : "🔎 Filtrar por agente, issue ou título…"}" value="${esc(q)}" />
        <button type="button" data-h="reload" title="Ler de novo do Multica">↻ Atualizar</button>
      </div>
      ${summary(items)}
      <div class="h-chips">${chips.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l}</button>`).join("")}
        ${loaded[source(tab)]?.at ? `<small class="muted">lido às ${hm(loaded[source(tab)].at)} · clique numa linha para gerenciar</small>` : ""}</div>
      ${tab === "issues" && selected.size ? `<div class="h-bulk"><b>${selected.size} selecionada${selected.size > 1 ? "s" : ""}</b>
        <select class="h-bulk-status">${Object.entries(ISSUE_ST).map(([k, [l]]) => `<option value="${k}" ${k === "done" ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <button type="button" class="primary" data-h="bulk">Aplicar status</button><button type="button" data-h="unselect">Limpar seleção</button></div>` : ""}
      ${found ? `<div class="h-found">🔎 ${found.loading ? "Buscando" : `${found.items.length} resultado${found.items.length === 1 ? "" : "s"}`} para “${esc(found.q)}” em títulos, descrições e comentários <button type="button" data-h="unfind">✕ limpar</button></div>` : ""}`;
  }

  /** Cartões de resumo (últimas 24 h) e alerta de falta de créditos. */
  function summary(items) {
    if (!items?.length) return "";
    const since = Date.now() - 86400_000;
    if (tab === "issues") {
      const done = items.filter((i) => i.status === "done" && new Date(i.activityAt) > since).length;
      const open = items.filter((i) => ["todo", "in_progress", "in_review", "backlog"].includes(i.status)).length;
      const blocked = items.filter((i) => i.status === "blocked").length;
      const created = items.filter((i) => new Date(i.createdAt) > since).length;
      return `<div class="h-cards">${card("✅", done, "concluídas em 24 h")}${card("🆕", created, "criadas em 24 h")}${card("🔄", open, "abertas")}${card("⛔", blocked, "bloqueadas", blocked ? "bad" : "")}</div>`;
    }
    const at = (r) => r.createdAt ?? r.at;
    const day = items.filter((r) => new Date(at(r)) > since);
    const ok = day.filter((r) => RUN_ST[r.status]?.[1] === "ok").length;
    const bad = day.filter((r) => RUN_ST[r.status]?.[1] === "bad").length;
    const live = items.filter((r) => RUN_ST[r.status]?.[1] === "live").length;
    const rate = ok + bad ? Math.round((ok / (ok + bad)) * 100) : null;
    const credits = items.slice(0, 40).some((r) => /out of credits|sem cr[eé]dito/i.test(r.failure ?? r.error ?? ""));
    return `${credits ? `<div class="h-alert">⚠️ Execuções recentes falharam com <b>“workspace is out of credits”</b>: o workspace do Multica está sem créditos. Peça ao dono do workspace para recarregar — até lá, tarefas e agendadas não rodam.</div>` : ""}
      <div class="h-cards">${card("▶️", day.length, "execuções em 24 h")}${card("✅", ok, "concluídas")}${card("❌", bad, "falharam", bad ? "bad" : "")}${card("📈", rate == null ? "—" : `${rate}%`, "taxa de sucesso")}${card("⏳", live, "rodando agora")}</div>`;
  }
  const card = (icon, n, label, cls = "") => `<div class="h-card ${cls}"><span>${icon}</span><b>${n}</b><small>${label}</small></div>`;

  function match(text) {
    return !q || text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").includes(q.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""));
  }

  function rowsRuns(items) {
    return items
      .filter((r) => filter === "all" || RUN_ST[r.status]?.[1] === filter)
      .filter((r) => match(`${agentOf(r.agentId)?.name ?? ""} ${r.issue?.identifier ?? ""} ${r.issue?.title ?? ""} ${r.by ?? ""} ${r.error ?? ""}`))
      .map((r) => {
        const [ic, cls, label] = RUN_ST[r.status] ?? ["•", "muted", r.status];
        const what = r.issue ? `<b>${esc(r.issue.identifier)}</b> ${esc(r.issue.title)}` : esc(r.kind === "chat" ? `Chat${r.by ? ` com ${r.by}` : ""}` : (KIND[r.kind] ?? r.kind));
        return {
          at: r.createdAt,
          html: `<div class="h-row clickable" data-st="${cls}" ${r.issueId ? `data-open-issue="${esc(r.issueId)}"` : `data-open-run="${esc(r.id)}"`}>
            <span class="h-time">${hm(r.createdAt)}</span>
            <span class="h-st ${cls}" title="${esc(label)}">${ic} ${esc(label)}</span>
            <span class="h-what">${what}<small>${esc(KIND[r.kind] ?? r.kind ?? "")}${r.by ? ` · por ${esc(r.by)}` : ""}${r.completedAt ? ` · ${dur(r.startedAt ?? r.createdAt, r.completedAt)}` : ""}</small>
              ${r.error ? `<small class="h-err">${esc(r.error)}</small>` : ""}</span>
            ${who(r.agentId)}
          </div>`,
        };
      });
  }

  function rowsSchedules(items) {
    return items
      .filter((r) => filter === "all" || RUN_ST[r.status]?.[1] === filter)
      .filter((r) => match(`${r.title} ${agentOf(r.agentId)?.name ?? ""} ${r.failure ?? ""}`))
      .map((r) => {
        const [ic, cls, label] = RUN_ST[r.status] ?? ["•", "muted", r.status];
        return {
          at: r.at,
          html: `<div class="h-row ${r.issueId ? "clickable" : ""}" data-st="${cls}" ${r.issueId ? `data-open-issue="${esc(r.issueId)}"` : ""}>
            <span class="h-time">${hm(r.at)}</span>
            <span class="h-st ${cls}">${ic} ${esc(label)}</span>
            <span class="h-what"><button type="button" class="h-link" data-sched="${esc(r.scheduleId)}">⏰ ${esc(r.title)}</button>
              <small>${r.source === "manual" ? "disparo manual" : r.source === "schedule" ? "pelo horário" : esc(r.source ?? "")}${r.completedAt ? ` · ${dur(r.at, r.completedAt)}` : ""}</small>
              ${r.failure ? `<small class="h-err">${esc(r.failure)}</small>` : ""}</span>
            ${who(r.agentId)}
          </div>`,
        };
      });
  }

  function rowsIssues(items) {
    return items
      .filter((i) => filter === "all" || i.status === filter)
      .filter((i) => match(`${i.identifier} ${i.title} ${agentOf(i.assignee)?.name ?? ""}`))
      .map((i) => {
        const [label, cls] = ISSUE_ST[i.status] ?? [i.status, "muted"];
        return {
          at: i.activityAt,
          html: `<div class="h-row clickable ${selected.has(i.id) ? "sel" : ""}" data-open-issue="${esc(i.id)}">
            <span class="h-time"><input type="checkbox" class="h-sel" data-sel="${esc(i.id)}" ${selected.has(i.id) ? "checked" : ""} aria-label="Selecionar ${esc(i.identifier)}" /> ${hm(i.activityAt)}</span>
            <span class="h-st ${cls}">${esc(label)}</span>
            <span class="h-what"><b>${esc(i.identifier)}</b> ${esc(i.title)}<small>${i.createdAt ? `criada ${esc(dayKey(i.createdAt))} ${hm(i.createdAt)}` : ""}${i.match ? ` · achada no ${i.match === "comment" ? "comentário" : i.match === "description" ? "descrição" : "título"}` : ""}</small></span>
            ${i.assignee ? who(i.assignee) : `<span class="muted">${i.assigneeType === "member" ? "👤 membro" : "—"}</span>`}
          </div>`,
        };
      });
  }

  function render() {
    const st = tab === "issues" && found ? { at: Date.now(), items: found.items } : loaded[source(tab)];
    const items = (st?.items ?? []).filter((r) => tab !== "chats" || r.kind === "chat");
    let body;
    if (loading && !st) body = `<p class="muted">⏳ Lendo do Multica… (a primeira leitura das execuções pode levar ~20 s)</p>`;
    else if (st?.error) body = `<p class="error">Não deu para ler: ${esc(st.error)}</p>`;
    else {
      const rows = tab === "runs" || tab === "chats" ? rowsRuns(items) : tab === "schedules" ? rowsSchedules(items) : rowsIssues(items);
      if (!rows.length) body = `<p class="muted">Nada encontrado com esse filtro.</p>`;
      else {
        // Agrupa por dia: Hoje, Ontem, …
        let last = "";
        body = rows
          .slice(0, 400)
          .map((r) => {
            const k = dayKey(r.at);
            const h = k !== last ? `<h3 class="h-day">${esc(dayLabel(r.at))}</h3>` : "";
            last = k;
            return h + r.html;
          })
          .join("");
      }
    }
    const more = tab === "issues" && !found && loaded.issues?.more
      ? `<button type="button" class="wide" data-h="more">⬇️ Carregar mais 200 issues antigas (agora ${items.length})</button>` : "";
    el.innerHTML = `<div class="h-wrap">${head(items)}${loading && st ? `<p class="muted">⏳ Atualizando…</p>` : ""}<div class="h-list">${body}</div>${more}</div>`;
  }

  el.addEventListener("click", async (e) => {
    const sel = e.target.closest(".h-sel");
    if (sel) {
      if (sel.checked) selected.add(sel.dataset.sel);
      else selected.delete(sel.dataset.sel);
      return render();
    }
    const b = e.target.closest("button");
    if (!b) {
      const row = e.target.closest("[data-open-issue], [data-open-run]");
      if (row?.dataset.openIssue) return onIssue(row.dataset.openIssue);
      if (row?.dataset.openRun) {
        const r = (loaded.runs?.items ?? []).find((x) => x.id === row.dataset.openRun);
        if (r) return onRun(r);
      }
      return;
    }
    if (b.dataset.h === "unselect") return selected.clear(), render();
    if (b.dataset.h === "more") {
      issuePages = Math.min(20, issuePages + 2);
      b.disabled = true;
      b.textContent = "⏳ Carregando…";
      return load(true);
    }
    if (b.dataset.h === "unfind") return (found = null), render();
    if (b.dataset.h === "bulk") {
      const status = el.querySelector(".h-bulk-status").value;
      if (!confirm(`Mudar ${selected.size} issue(s) para “${ISSUE_ST[status][0]}”?`)) return;
      b.disabled = true;
      try {
        const r = await api("/api/manage/bulk-status", { ids: [...selected], status });
        toast(`${r.ok.length} atualizada(s)${r.failed.length ? `, ${r.failed.length} falharam` : ""}.`, !r.failed.length);
        selected.clear();
        found = null;
      } catch (err) {
        toast(`Não deu: ${err.message}`, false);
      }
      return load(true);
    }
    if (b.dataset.h === "login") return login();
    if (b.dataset.h === "reload") return load(true);
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      filter = "all";
      found = null;
      return load();
    }
    if (b.dataset.f) {
      filter = b.dataset.f;
      return render();
    }
    if (b.dataset.agent) return onAgent(b.dataset.agent);
    if (b.dataset.sched) return onSchedule(b.dataset.sched);
  });
  el.addEventListener("input", (e) => {
    if (!e.target.classList.contains("h-search")) return;
    q = e.target.value.trim();
    const pos = e.target.selectionStart;
    render();
    const inp = el.querySelector(".h-search");
    inp.focus();
    inp.setSelectionRange(pos, pos);
  });

  // Enter na aba Issues: busca no servidor (inclui descrições, comentários e concluídas).
  el.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !e.target.classList.contains("h-search") || tab !== "issues") return;
    const text = e.target.value.trim();
    if (text.length < 2) return;
    found = { q: text, items: [], loading: true };
    q = "";
    render();
    try {
      found = { q: text, items: (await api(`/api/manage/search?q=${encodeURIComponent(text)}`)).issues };
    } catch (err) {
      found = null;
      toast(`Busca falhou: ${err.message}`, false);
    }
    render();
  });

  return { load, render };
}
