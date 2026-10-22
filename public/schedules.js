// Tarefas agendadas (autopilots do Multica): lista lateral, agenda das
// próximas 24 h e painel de cada tarefa com histórico e ações.
import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TZ = "America/Sao_Paulo";
const TZ_OFFSET_MIN = { "America/Sao_Paulo": -180, UTC: 0, "Etc/UTC": 0 }; // Brasil sem horário de verão desde 2019
const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const RUN_STATUS = { issue_created: "📝 issue criada", completed: "✅ concluída", failed: "❌ falhou", running: "▶️ rodando", queued: "⏳ na fila", skipped: "⏭ pulada", cancelled: "⏹ cancelada" };

// ---------- cron ----------

function parseField(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = Number(stepStr ?? 1);
    let [a, b] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (b === undefined) b = stepStr ? max : a;
    for (let v = a; v <= b; v += step) out.add(v === 7 && max === 6 ? 0 : v);
  }
  return out;
}

/** Aceita o prefixo "TZ=America/Sao_Paulo 0 18 * * 1,5". */
function splitTz(expr) {
  const m = /^(?:CRON_)?TZ=(\S+)\s+(.*)$/.exec(String(expr ?? "").trim());
  return m ? { tz: m[1], cron: m[2] } : { tz: null, cron: String(expr ?? "").trim() };
}

function parseCron(expr) {
  const f = splitTz(expr).cron.split(/\s+/);
  if (f.length !== 5) return null;
  try {
    return { min: parseField(f[0], 0, 59), hour: parseField(f[1], 0, 23), dom: parseField(f[2], 1, 31), mon: parseField(f[3], 1, 12), dow: parseField(f[4], 0, 6), raw: f };
  } catch {
    return null;
  }
}

const two = (n) => String(n).padStart(2, "0");

/** "0 9 * * 1-5" → "Dias úteis às 09:00". */
export function cronText(expr) {
  const c = parseCron(expr);
  if (!c) return expr ?? "";
  const [m, h, dom, , dow] = c.raw;
  if (m.startsWith("*/") && h === "*") return `A cada ${m.slice(2)} min`;
  if (m.startsWith("*/")) return `A cada ${m.slice(2)} min, das ${two(Math.min(...c.hour))}h às ${two(Math.max(...c.hour))}h`;
  if (h === "*") return m === "0" ? "De hora em hora" : `De hora em hora (min ${two(m)})`;
  if (h.startsWith("*/")) return `A cada ${h.slice(2)} h`;
  const hours = [...c.hour].sort((a, b) => a - b);
  const mins = [...c.min].sort((a, b) => a - b);
  const times = hours.length > 4 ? `das ${two(hours[0])}h às ${two(hours.at(-1))}h (${hours.length}×)` : hours.flatMap((hh) => mins.map((mm) => `${two(hh)}:${two(mm)}`)).join(" e ");
  let days = "Todo dia";
  if (dom !== "*") days = c.dom.size > 1 ? `Dias ${[...c.dom].sort((a, b) => a - b).join(" e ")} de cada mês` : `Dia ${dom} de cada mês`;
  else if (dow === "1-5") days = "Dias úteis";
  else if (dow !== "*") days = [...c.dow].sort().map((d) => DOW[d]).join(", ").replace(/^./, (s) => s.toUpperCase());
  return `${days} às ${times}`;
}

/** Execuções do cron entre agora e +horas (em instantes UTC). */
export function occurrences(expr, tz, fromMs, hours) {
  const c = parseCron(expr);
  if (!c) return [];
  const off = (TZ_OFFSET_MIN[splitTz(expr).tz ?? tz ?? TZ] ?? -180) * 60_000;
  const out = [];
  const start = Math.ceil(fromMs / 60_000) * 60_000;
  for (let t = start; t < fromMs + hours * 3600_000 && out.length < 200; t += 60_000) {
    const d = new Date(t + off); // campos em hora local via getUTC*
    if (!c.min.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours())) continue;
    if (!c.mon.has(d.getUTCMonth() + 1)) continue;
    const domOk = c.dom.has(d.getUTCDate()), dowOk = c.dow.has(d.getUTCDay());
    const domAny = c.raw[2] === "*", dowAny = c.raw[4] === "*";
    if (domAny && dowAny ? true : domAny ? dowOk : dowAny ? domOk : domOk || dowOk) out.push(t);
  }
  return out;
}

function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const fmt = (o) => d.toLocaleString("pt-BR", { timeZone: TZ, ...o });
  const day = (x) => x.toLocaleDateString("pt-BR", { timeZone: TZ });
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  const hm = fmt({ hour: "2-digit", minute: "2-digit" });
  if (day(d) === day(today)) return `hoje ${hm}`;
  if (day(d) === day(tomorrow)) return `amanhã ${hm}`;
  if (d < today && day(d) === day(new Date(Date.now() - 86400_000))) return `ontem ${hm}`;
  return `${fmt({ day: "2-digit", month: "2-digit" })} ${hm}`;
}

function cadence(s) {
  const t = s.triggers.filter((x) => x.kind === "schedule" && x.cron);
  if (t.length) return t.map((x) => cronText(x.cron)).join(" + ");
  return s.triggers.some((x) => x.kind === "webhook") ? "Por webhook" : "Manual";
}

// ---------- lista lateral ----------

export function renderScheduleList(el, { data, query, filter, selectedId }) {
  const agents = new Map(data.agents.map((a) => [a.id, a]));
  const list = data.schedules.filter((s) => {
    if (filter !== "all" && s.status !== filter) return false;
    if (!query) return true;
    return [s.title, agents.get(s.agentId)?.name, cadence(s)].join(" ").toLowerCase().includes(query);
  });
  el.innerHTML = list.length
    ? list
        .map((s) => {
          const a = agents.get(s.agentId);
          return `<li class="sched ${s.id === selectedId ? "selected" : ""} ${s.status}" data-sched="${s.id}">
            <span class="when">${s.status === "paused" ? "⏸ pausada" : esc(when(s.nextRunAt))}</span>
            <span class="name">${s.lastRun?.status === "failed" && !s.lastRun.acked ? `<i class="fail-dot" title="Última execução falhou"></i>` : ""}${esc(s.title)}<small>${a ? `${esc(a.emoji)} ${esc(a.name)} · ` : ""}${esc(cadence(s))}</small></span></li>`;
        })
        .join("")
    : `<li class="empty">Nenhuma tarefa encontrada.</li>`;
}

// ---------- agenda (visão principal) ----------

export function renderAgenda(el, { data, selectedId }) {
  const agents = new Map(data.agents.map((a) => [a.id, a]));
  const now = Date.now();
  const H = 24;
  const rows = data.schedules.map((s) => {
    const occ = s.status === "active"
      ? s.triggers.filter((t) => t.cron).flatMap((t) => occurrences(t.cron, t.tz, now, H))
      : [];
    return { s, occ: occ.sort((a, b) => a - b) };
  });
  const active = data.schedules.filter((s) => s.status === "active");
  const fails = data.schedules.filter((s) => s.lastRun?.status === "failed" && !s.lastRun.acked).length;
  const in24 = rows.reduce((n, r) => n + r.occ.length, 0);
  const next = rows.filter((r) => r.occ.length).sort((a, b) => a.occ[0] - b.occ[0])[0];
  const startHour = new Date(now).toLocaleString("pt-BR", { timeZone: TZ, hour: "2-digit" });
  const hourMarks = Array.from({ length: H / 3 + 1 }, (_, i) => {
    const t = now + i * 3 * 3600_000;
    return `<span style="left:${(i * 3 * 100) / H}%">${new Date(t).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit" })}h</span>`;
  }).join("");

  const row = ({ s, occ }) => {
    const a = agents.get(s.agentId);
    const ticks = occ
      .map((t) => `<i style="left:${((t - now) / (H * 3600_000)) * 100}%" title="${new Date(t).toLocaleString("pt-BR", { timeZone: TZ })}"></i>`)
      .join("");
    return `<div class="arow ${s.status} ${s.id === selectedId ? "selected" : ""}" data-sched="${s.id}">
      <div class="atitle"><b>${s.lastRun?.status === "failed" && !s.lastRun.acked ? `<i class="fail-dot" title="Última execução falhou"></i>` : ""}${esc(s.title)}</b><small>${a ? `${esc(a.emoji)} ${esc(a.name)}` : "—"} · ${esc(cadence(s))}</small></div>
      <div class="anext">${s.status === "paused" ? `<span class="badge paused">pausada</span>` : esc(when(s.nextRunAt))}</div>
      <div class="atrack">${ticks}</div>
    </div>`;
  };
  const sorted = rows.sort((a, b) => (a.s.status === b.s.status ? (a.occ[0] ?? 9e15) - (b.occ[0] ?? 9e15) : a.s.status === "active" ? -1 : 1));
  el.innerHTML = `
    <div class="agenda-top"><h2>📅 Agenda das próximas 24 horas</h2><div class="row">${fails ? `<button type="button" data-ack-all>📦 Arquivar todas as falhas (${fails})</button>` : ""}<button type="button" class="primary" data-new-sched>➕ Nova tarefa agendada</button></div></div>
    <div class="agenda-head">
      <div class="kpi"><b>${active.length}</b><span>tarefas ativas</span></div>
      <div class="kpi"><b>${data.schedules.length - active.length}</b><span>pausadas</span></div>
      <div class="kpi ${fails ? "bad" : ""}"><b>${fails}</b><span>falhas pendentes</span></div>
      <div class="kpi"><b>${in24}</b><span>execuções nas próximas 24 h</span></div>
      <div class="kpi wide"><b>${next ? new Date(next.occ[0]).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }) : "—"}</b><span>${next ? `próxima: ${esc(next.s.title)}` : "nenhuma nas próximas 24 h"}</span></div>
    </div>
    <div class="agenda-grid">
      <div class="arow header"><div class="atitle">Tarefa · agente · frequência</div><div class="anext">Próxima</div><div class="atrack scale">${hourMarks}<em style="left:0" title="agora (${startHour}h)"></em></div></div>
      ${sorted.map(row).join("")}
    </div>
    <p class="muted small">Horários de Brasília (Rio). Cada traço é uma execução prevista nas próximas 24 h.</p>`;
}

// ---------- painel da tarefa ----------

export function createScheduleDrawer(el, { getData, getAuth, login, onClose, onAgent, toast, onChanged = () => {} }) {
  let id = null; // id da tarefa, ou "new" para criar
  let detail = null;
  let editing = false;
  let triggers = null;

  const agentOptions = (sel) =>
    (getData()?.agents ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => `<option value="${a.id}" ${a.id === sel ? "selected" : ""}>${esc(a.emoji)} ${esc(a.name)} · ${esc(a.machine)}</option>`)
      .join("");
  const CRON_HELP = `<small class="muted">Cron de 5 campos em horário do Rio. Ex.: <code>0 9 * * 1-5</code> (dias úteis 9h), <code>*/30 7-23 * * *</code> (a cada 30 min), <code>0 8 1 * *</code> (dia 1, 8h).</small>`;

  function renderCreate() {
    el.hidden = false;
    el.innerHTML = `<button class="close" type="button" aria-label="Fechar">✕</button>
      <div class="eyebrow">⏰ Nova tarefa agendada</div><h2>Criar tarefa agendada</h2>
      <form class="sched-form">
        <label>Título<input name="title" required maxlength="200" placeholder="Ex.: Relatório semanal de leads" /></label>
        <label>Agente responsável<select name="agentId" required>${agentOptions()}</select></label>
        <label>Instruções para o agente<textarea name="description" rows="7" required placeholder="O que o agente deve fazer a cada execução"></textarea></label>
        <div class="grid2">
          <label>Modo<select name="mode"><option value="create_issue">Criar uma issue por execução</option><option value="run_only">Só executar (sem issue)</option></select></label>
          <label>Título das issues<input name="titleTemplate" placeholder="Relatório {{date}}" /></label>
        </div>
        <label>Quando (cron)<input name="cron" class="mono" placeholder="0 9 * * 1-5" /></label>
        <div class="cron-preview muted small"></div>
        ${CRON_HELP}
        <button type="submit" class="primary wide">⏰ Criar tarefa agendada</button>
      </form>`;
    el.querySelector(".close").onclick = onClose;
    const form = el.querySelector("form");
    const preview = el.querySelector(".cron-preview");
    form.elements.cron.addEventListener("input", (e) => (preview.textContent = e.target.value.trim() ? `→ ${cronText(e.target.value)}` : ""));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const out = await api("/api/schedules", {
          title: f.title.value, agentId: f.agentId.value, description: f.description.value, mode: f.mode.value,
          titleTemplate: f.titleTemplate.value, cron: f.cron.value.trim(), tz: TZ,
        });
        toast("Tarefa agendada criada.");
        onChanged();
        id = out.id;
        detail = null;
        editing = false;
        render();
        load();
      } catch (err) {
        toast(err.message, false);
        btn.disabled = false;
      }
    });
  }

  function renderEdit(s) {
    const trig = triggers
      ? triggers.length
        ? triggers
            .map((t) => `<form class="trig" data-trig="${t.id}">
              ${t.kind === "schedule"
                ? `<input name="cron" class="mono" value="${esc(t.cron ?? "")}" /><span class="muted small">${esc(cronText(t.cron))}</span>`
                : `<span>${esc(t.kind)}</span>`}
              <label class="check inline"><input type="checkbox" name="enabled" ${t.enabled ? "checked" : ""}/> ativo</label>
              <button type="submit">Salvar</button><button type="button" class="danger" data-act="trig-del">Excluir</button></form>`)
            .join("")
        : `<p class="muted">Sem horários: a tarefa só roda manualmente.</p>`
      : `<p class="muted">Carregando horários…</p>`;
    return `
      <form class="sched-form sched-edit">
        <label>Título<input name="title" required maxlength="200" value="${esc(s.title)}" /></label>
        <label>Agente responsável<select name="agentId">${agentOptions(s.agentId)}</select></label>
        <label>Instruções para o agente<textarea name="description" rows="8">${esc(detail?.description ?? "")}</textarea></label>
        <div class="grid2">
          <label>Modo<select name="mode"><option value="create_issue" ${s.mode === "create_issue" ? "selected" : ""}>Criar uma issue por execução</option><option value="run_only" ${s.mode === "run_only" ? "selected" : ""}>Só executar (sem issue)</option></select></label>
          <label>Título das issues<input name="titleTemplate" value="${esc(detail?.titleTemplate ?? "")}" /></label>
        </div>
        <div class="row"><button type="button" data-act="cancel-edit">Cancelar</button><button type="submit" class="primary">💾 Salvar</button></div>
      </form>
      <div class="section-title">Horários</div>
      ${trig}
      <form class="trig-add"><input name="cron" class="mono" placeholder="novo cron, ex.: 0 9 * * 1-5" required /><button type="submit">➕ Adicionar horário</button></form>
      ${CRON_HELP}
      <div class="section-title danger-title">Zona de risco</div>
      <button type="button" class="danger" data-act="delete">🗑️ Excluir tarefa agendada</button>`;
  }

  function render() {
    if (id === "new") return renderCreate();
    const data = getData();
    const s = data?.schedules.find((x) => x.id === id);
    if (!s) return void (el.hidden = true);
    el.hidden = false;
    const a = data.agents.find((x) => x.id === s.agentId);
    const auth = getAuth();
    const trig = s.triggers.map((t) => (t.cron ? `<code>${esc(t.cron)}</code> ${esc(t.tz ?? "")}` : esc(t.kind))).join("<br>");
    let body;
    if (!auth.enabled) body = `<p class="muted">Histórico e ações estão desligados neste servidor.</p>`;
    else if (!auth.auth) body = `<button type="button" class="primary wide" data-act="login">🔐 Entrar para ver histórico e ações</button>`;
    else if (!detail) body = `<p class="muted">Carregando…</p>`;
    else if (detail.error) body = `<p class="error">${esc(detail.error)}</p>`;
    else if (editing) body = renderEdit(s);
    else
      body = `
        <div class="run-actions">
          <button type="button" class="primary" data-act="trigger">▶ Rodar agora</button>
          ${s.status === "active" ? `<button type="button" data-act="pause">⏸ Pausar</button>` : `<button type="button" data-act="resume">▶ Retomar</button>`}
          <button type="button" data-act="edit">✏️ Editar</button>
        </div>
        ${detail.description ? `<div class="section-title">Instruções</div><div class="desc-box">${esc(detail.description)}</div>` : ""}
        <div class="section-title">Histórico de execuções</div>
        ${detail.runs.length
          ? detail.runs
              .map((r) => `<div class="run ${r.status === "failed" ? (r.acked ? "acked" : "failed") : ""}"><div class="run-top"><span class="pill">${RUN_STATUS[r.status] ?? esc(r.status)}${r.status === "failed" && r.acked ? " · 📦 arquivada" : ""}</span><small class="muted">${esc(when(r.at))} · ${esc(r.source)}</small></div>
                ${r.issue ? `<div class="run-what"><b>${esc(r.issue.identifier)}</b> ${esc(r.issue.title)} <span class="muted small">(${esc(r.issue.status)})</span></div>` : ""}
                ${r.failure ? `<div class="error small">${esc(r.failure)}</div>` : ""}
                ${r.status === "failed" ? `<div class="run-actions">
                  <button type="button" data-act="trigger">🔁 Rodar de novo</button>
                  ${r.issue && !["done", "cancelled"].includes(r.issue.status) ? `<button type="button" class="primary" data-act="issue-done" data-issue="${r.issue.id}" data-label="${esc(r.issue.identifier)}">✅ Concluir issue</button>
                  <button type="button" class="danger" data-act="issue-cancel" data-issue="${r.issue.id}" data-label="${esc(r.issue.identifier)}">🚫 Cancelar issue</button>` : ""}
                  <button type="button" data-act="ack" data-run="${r.id}" data-ack="${r.acked ? "0" : "1"}">${r.acked ? "↩️ Desarquivar falha" : "📦 Arquivar falha"}</button>
                </div>` : ""}</div>`)
              .join("")
          : `<p class="muted">Ainda não rodou.</p>`}`;
    el.innerHTML = `<button class="close" type="button" aria-label="Fechar">✕</button>
      <div class="eyebrow">⏰ Tarefa agendada</div>
      <h2>${esc(s.title)}</h2>
      <div class="meta"><span class="badge ${s.status}">${s.status === "active" ? "ativa" : "pausada"}</span> · ${s.mode === "create_issue" ? "cria uma issue a cada execução" : "só executa (sem issue)"}</div>
      <dl class="facts">
        <dt>Responsável</dt><dd>${a ? `<a href="#" data-act="agent">${esc(a.emoji)} ${esc(a.name)}</a> <small class="muted">💻 ${esc(a.machine)}</small>` : "—"}</dd>
        <dt>Frequência</dt><dd>${esc(cadence(s))}<br><small class="muted">${trig}</small></dd>
        <dt>Próxima</dt><dd>${s.status === "active" ? esc(when(s.nextRunAt)) : "—"}</dd>
        <dt>Última</dt><dd>${esc(when(s.lastRunAt))}${s.lastRun ? ` · ${RUN_STATUS[s.lastRun.status] ?? esc(s.lastRun.status)}` : ""}</dd>
      </dl>
      ${body}`;
    el.querySelector(".close").onclick = onClose;
  }

  async function load() {
    const want = id;
    try {
      const d = await api(`/api/schedules/${want}`);
      if (want === id) detail = d;
    } catch (e) {
      if (want === id) detail = { error: e.message };
    }
    render();
  }

  async function loadTriggers() {
    try {
      triggers = (await api(`/api/schedules/${id}/triggers`)).triggers;
    } catch (e) {
      triggers = [];
      toast(e.message, false);
    }
    render();
  }

  async function run(fn, msg) {
    try {
      await fn();
      toast(msg);
      onChanged();
      return true;
    } catch (err) {
      toast(err.message, false);
      return false;
    }
  }

  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || id === "new") return;
    e.preventDefault();
    const s = getData()?.schedules.find((x) => x.id === id);
    const act = b.dataset.act;
    if (act === "login") return login();
    if (act === "agent") return onAgent(s.agentId);
    if (act === "edit") {
      editing = true;
      triggers = null;
      render();
      return loadTriggers();
    }
    if (act === "cancel-edit") {
      editing = false;
      return render();
    }
    if (act === "ack") {
      const on = b.dataset.ack === "1";
      if (await run(() => api("/api/acks", { id: b.dataset.run, ack: on }), on ? "Falha arquivada: saiu das pendências." : "Falha desarquivada.")) {
        detail = null;
        render();
        load();
      }
      return;
    }
    if (act === "issue-done" || act === "issue-cancel") {
      const status = act === "issue-done" ? "done" : "cancelled";
      if (!confirm(`${status === "done" ? "Concluir" : "Cancelar"} ${b.dataset.label}?`)) return;
      if (await run(() => api(`/api/issues/${b.dataset.issue}/status`, { status }), `${b.dataset.label} ${status === "done" ? "concluída" : "cancelada"}.`)) {
        detail = null;
        render();
        load();
      }
      return;
    }
    if (act === "trig-del") {
      const tid = b.closest("form").dataset.trig;
      if (!confirm("Excluir este horário?")) return;
      if (await run(() => api(`/api/schedules/${id}/triggers/${tid}/delete`, {}), "Horário excluído.")) loadTriggers();
      return;
    }
    if (act === "delete") {
      const typed = prompt(`Excluir apaga a tarefa "${s.title}" e seus horários. Para confirmar, digite EXCLUIR:`);
      if (typed !== "EXCLUIR") return typed !== null && toast("Confirmação não confere; nada foi excluído.", false);
      if (await run(() => api(`/api/schedules/${id}/delete`, {}), "Tarefa agendada excluída.")) onClose();
      return;
    }
    const ask = { trigger: `Rodar "${s.title}" agora?`, pause: `Pausar "${s.title}"? Ela para de rodar até ser retomada.`, resume: `Retomar "${s.title}"?` }[act];
    if (!ask || !confirm(ask)) return;
    b.disabled = true;
    const okRun = await run(
      () => (act === "trigger" ? api(`/api/schedules/${id}/trigger`, {}) : api(`/api/schedules/${id}/status`, { status: act === "pause" ? "paused" : "active" })),
      act === "trigger" ? "Execução disparada; o agente vai começar." : act === "pause" ? "Tarefa pausada." : "Tarefa retomada.",
    );
    if (okRun && act !== "trigger") s.status = act === "pause" ? "paused" : "active";
    detail = null;
    render();
    load();
  });

  el.addEventListener("submit", async (e) => {
    if (id === "new") return;
    e.preventDefault();
    const f = e.target;
    if (f.classList.contains("sched-edit")) {
      const s = getData()?.schedules.find((x) => x.id === id);
      const v = f.elements;
      const body = {};
      if (v.title.value !== s.title) body.title = v.title.value;
      if (v.agentId.value !== s.agentId) body.agentId = v.agentId.value;
      if (v.mode.value !== s.mode) body.mode = v.mode.value;
      if (v.description.value !== (detail?.description ?? "")) body.description = v.description.value;
      if (v.titleTemplate.value !== (detail?.titleTemplate ?? "")) body.titleTemplate = v.titleTemplate.value;
      if (!Object.keys(body).length) return toast("Nada mudou.");
      if (await run(() => api(`/api/schedules/${id}/update`, body), "Tarefa atualizada.")) {
        Object.assign(s, body.title ? { title: body.title } : {}, body.agentId ? { agentId: body.agentId } : {}, body.mode ? { mode: body.mode } : {});
        editing = false;
        detail = null;
        render();
        load();
      }
    } else if (f.classList.contains("trig")) {
      const body = { enabled: f.elements.enabled.checked };
      if (f.elements.cron) body.cron = f.elements.cron.value.trim();
      if (await run(() => api(`/api/schedules/${id}/triggers/${f.dataset.trig}`, { ...body, tz: TZ }), "Horário salvo.")) loadTriggers();
    } else if (f.classList.contains("trig-add")) {
      if (await run(() => api(`/api/schedules/${id}/triggers`, { cron: f.elements.cron.value.trim(), tz: TZ }), "Horário adicionado.")) loadTriggers();
    }
  });

  return {
    show(next) {
      if (next !== id) {
        detail = null;
        editing = false;
        triggers = null;
      }
      id = next;
      if (!id) return void (el.hidden = true);
      render();
      if (id !== "new" && getAuth().auth && !detail) load();
    },
    create() {
      this.show("new");
    },
    refresh() {
      if (id && id !== "new" && !editing) render();
    },
    authChanged() {
      detail = null;
      if (id && id !== "new") {
        render();
        if (getAuth().auth) load();
      }
    },
    get id() {
      return id;
    },
  };
}
