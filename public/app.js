// Escritório de Agentes — cabeçalho, barra lateral (agentes e agendadas),
// visões (escritório 3D, lista, agenda) e painéis de detalhe.
import { createAgentPanel } from "./agent-panel.js";
import { createOffice } from "./office3d.js";
import { createScheduleDrawer, renderAgenda, renderScheduleList } from "./schedules.js";
import { api } from "./agent-panel.js";
import { createFeed, createPalette, readHash, writeHash } from "./extras.js";
import { createMeetings } from "./meetings.js";
import { createHistory } from "./history.js";
import { createIssueDrawer } from "./manage.js";
import { activeWork, workIcon, workSummary, workTitle } from "./work.js";

const STATES = {
  working: { label: "Trabalhando" },
  blocked: { label: "Bloqueado" },
  idle: { label: "Ocioso" },
  offline: { label: "Offline" },
};
const SCHED_FILTERS = [["all", "Todas"], ["active", "Ativas"], ["paused", "Pausadas"]];

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let data = null;
let selectedId = null;
let side = "agents";
let filter = "all";
let schedFilter = "all";
let query = "";
let view = "3d";

function taskLabel(agent) {
  const sum = workSummary(agent);
  if (sum.text) return `${sum.text} — ${activeWork(agent).map(workTitle).join(" | ")}`;
  const w = agent.work?.[0];
  if (w?.issue) return `${w.issue.identifier} · ${w.issue.title}`;
  if (w?.label) return w.label;
  if (agent.state === "blocked" && agent.blocked[0]) return `${agent.blocked[0].identifier} bloqueada`;
  return "";
}

/** "há 12 min" → "12 min" de execução. */
function elapsed(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function toast(msg, ok = true) {
  const t = document.createElement("div");
  t.className = `toast ${ok ? "" : "bad"}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

const office = createOffice($("#scene"), {
  onSelect: (id) => select(id, true),
  onSelectSchedule: (id) => selectSchedule(id),
  onBoard: () => setView("agenda"),
  onConf: () => meetings.open({ list: (data?.meetings ?? []).length > 0 }),
  onSpot: (info) => openSpotMenu(info),
});
let unified = false;

// ---------- relógio do Rio e hora da cena ----------
function tickClock() {
  const h = office.hour;
  const live = $("#clock-mode").value === "live";
  const now = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
  $("#clock-time").textContent = live ? `Rio ${now}` : `Prévia ${String(Math.floor(h)).padStart(2, "0")}h`;
  $("#clock-icon").textContent = h >= 19.3 || h < 5.5 ? "🌙" : h < 7.5 ? "🌅" : h < 17.2 ? "☀️" : "🌇";
}
$("#clock-mode").addEventListener("change", (e) => {
  office.setHour(e.target.value === "live" ? null : Number(e.target.value));
  tickClock();
});
const urlHour = new URLSearchParams(location.search).get("hora");
if (urlHour != null && !Number.isNaN(Number(urlHour))) {
  const h = Number(urlHour);
  office.setHour(h);
  const sel = $("#clock-mode");
  if (![...sel.options].some((o) => Number(o.value) === h)) sel.add(new Option(`${urlHour}h`, String(h)));
  sel.value = [...sel.options].find((o) => Number(o.value) === h).value;
}
setInterval(tickClock, 15_000);
tickClock();

function syncModeButton() {
  for (const b of document.querySelectorAll("#scene-mode button")) b.setAttribute("aria-pressed", String(b.dataset.mode === office.mode));
  $("#scene-mode").hidden = view !== "3d";
}
$("#scene-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  office.setMode(b.dataset.mode);
  syncModeButton();
});

// Os filtros da barra lateral valem também para o escritório 3D.
let filterTimer = null;
function applyOfficeFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (!data) return;
    const narrowed = filter !== "all" || query;
    office.setFilter(narrowed ? new Set(data.agents.filter(visible).map((a) => a.id)) : null, unified);
  }, 250);
}

// ---------- visões ----------
function setView(v) {
  view = v;
  for (const b of document.querySelectorAll("#views button")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
  $("#scene").hidden = v !== "3d";
  office.setPaused(v !== "3d");
  $("#legend").hidden = v !== "3d";
  $("#grid2d").hidden = v !== "2d";
  $("#agenda").hidden = v !== "agenda";
  $("#history").hidden = v !== "history";
  if (v === "history") historyView.load();
  if (v === "agenda" && side !== "schedules") setSide("schedules");
  syncModeButton();
  renderMain();
}
$("#views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});

function setSide(s) {
  side = s;
  for (const b of document.querySelectorAll(".side-tabs button")) b.setAttribute("aria-selected", String(b.dataset.side === s));
  $("#agent-list").hidden = s !== "agents";
  $("#schedule-list").hidden = s !== "schedules";
  $("#search").placeholder = s === "agents" ? "Buscar agente ou issue…" : "Buscar tarefa ou agente…";
  renderSide();
}
document.querySelector(".side-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-side]");
  if (b) setSide(b.dataset.side);
});

// ---------- barra lateral ----------
function visible(a) {
  if (filter !== "all" && a.state !== filter) return false;
  if (!query) return true;
  const hay = [a.name, a.machine, a.provider, a.squad, taskLabel(a), ...a.blocked.map((b) => b.identifier)].join(" ").toLowerCase();
  return hay.includes(query);
}

function renderStats() {
  const count = (s) => data.agents.filter((a) => a.state === s).length;
  $("#stats").innerHTML = Object.entries(STATES)
    .map(([k, v]) => `<button type="button" class="chip" data-chip="${k}" title="Filtrar: ${v.label}"><span class="dot ${k}"></span><b>${count(k)}</b> ${v.label.toLowerCase()}</button>`)
    .join("") +
    // Quantos já trabalharam hoje e o total de execuções do dia.
    (() => {
      const worked = data.agents.filter((a) => a.today?.runs);
      const runs = worked.reduce((t, a) => t + a.today.runs, 0);
      return worked.length ? `<span class="chip" title="Agentes que já executaram algo hoje · execuções do dia">⚡ <b>${worked.length}</b> trabalharam hoje · ${runs} execuções</span>` : "";
    })();
  $("#count-agents").textContent = data.agents.length;
  $("#count-schedules").textContent = data.schedules?.length ?? 0;
  $("#updated").textContent = `Atualizado às ${new Date(data.updatedAt).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo" })}`;
}
$("#stats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-chip]");
  if (!b) return;
  setSide("agents");
  filter = filter === b.dataset.chip ? "all" : b.dataset.chip;
  renderSide();
  applyOfficeFilter();
});

function renderFilters() {
  const opts = side === "agents" ? [["all", "Todos"], ...Object.entries(STATES).map(([k, v]) => [k, v.label])] : SCHED_FILTERS;
  const cur = side === "agents" ? filter : schedFilter;
  const extra = side === "agents"
    ? `<button type="button" class="toggle" data-unified aria-pressed="${unified}" title="Junta os agentes filtrados num open-space só">🏢 Escritório único</button>`
    : `<button type="button" class="primary small-btn" data-new-sched>➕ Nova tarefa agendada</button>`;
  const cnt = (k) =>
    side === "agents"
      ? k === "all" ? data.agents.length : data.agents.filter((a) => a.state === k).length
      : k === "all" ? data.schedules.length : data.schedules.filter((s) => s.status === k).length;
  $("#filters").innerHTML = opts.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${cur === k}">${l} <span class="fc">${cnt(k)}</span></button>`).join("") + extra;
}

function renderSide() {
  if (!data) return;
  renderFilters();
  if (side === "schedules") {
    renderScheduleList($("#schedule-list"), { data, query, filter: schedFilter, selectedId: sched.id });
    return;
  }
  const groups = data.machines
    .map((m) => ({ m, agents: data.agents.filter((a) => a.machine === m.name && visible(a)) }))
    .filter((g) => g.agents.length);
  $("#agent-list").innerHTML = groups.length
    ? groups
        .map(
          ({ m, agents }) =>
            `<li class="machine"><span class="dot ${m.online ? "working" : "offline"}"></span>💻 ${esc(m.name)}<span class="count">${agents.length}</span></li>` +
            agents
              .map(
                (a) => `<li class="agent ${a.id === selectedId ? "selected" : ""}" data-id="${a.id}">
                  <span class="avatar">${esc(a.emoji)}<i class="dot ${a.state}"></i></span>
                  <span class="name">${esc(a.name)}<small>${a.state === "working" && a.work?.[0]?.startedAt ? `⏱ ${elapsed(a.work[0].startedAt)} · ` : ""}${esc(taskLabel(a) || `${STATES[a.state].label} · ${a.provider}`)}${a.today?.runs ? `<span class="today-chip ${a.today.failed ? "bad" : ""}" title="Execuções hoje: ${a.today.ok} concluída(s), ${a.today.failed} com falha">⚡${a.today.runs} hoje</span>` : ""}</small></span></li>`,
              )
              .join(""),
        )
        .join("")
    : `<li class="empty">Nenhum agente encontrado.</li>`;
}

function renderMain() {
  if (!data) return;
  if (view === "2d") {
    const groups = data.machines
      .map((m) => ({ m, agents: data.agents.filter((a) => a.machine === m.name && visible(a)) }))
      .filter((g) => g.agents.length);
    $("#grid2d").innerHTML = groups
      .map(
        ({ m, agents }) =>
          `<h2><span class="dot ${m.online ? "working" : "offline"}"></span>💻 ${esc(m.name)} <small>${agents.length} agentes</small></h2><div class="cards">` +
          agents
            .map(
              (a) => `<div class="card ${a.state} ${a.id === selectedId ? "selected" : ""}" data-id="${a.id}">
                <div class="card-top"><span class="emoji">${esc(a.emoji)}</span><b>${esc(a.name)}</b></div>
                ${a.squad ? `<div class="task">👥 ${esc(a.squad)}${a.leader ? " (líder)" : ""}</div>` : ""}
                <div class="task"><span class="dot ${a.state}"></span> ${esc(STATES[a.state].label)}${taskLabel(a) ? ` · ${esc(taskLabel(a))}` : ""}</div></div>`,
            )
            .join("") +
          "</div>",
      )
      .join("");
  } else if (view === "agenda") {
    renderAgenda($("#agenda"), { data, selectedId: sched.id });
  }
}

// ---------- painéis ----------
const panel = createAgentPanel($("#detail"), {
  getAgent: (id) => data?.agents.find((a) => a.id === id),
  onClose: () => select(null),
  onAuthChange: (auth) => {
    const b = $("#auth");
    b.hidden = !auth.enabled;
    b.textContent = auth.auth ? "🔓 Sair" : "🔐 Entrar";
    sched?.authChanged();
    if (view === "history") historyView?.load();
  },
  onChanged: (_id, info) => {
    if (info?.archived) select(null);
    refreshNow();
  },
  onMeet: (id, pair) => meetings.open({ agents: [id], pair }),
});

// Reuniões de agentes (e conversa entre dois agentes).
const meetings = createMeetings({
  getData: () => data,
  getAuth: () => panel.auth,
  login: () => panel.login(),
  toast,
  onChanged: () => refreshNow(),
  onAgent: (id) => {
    setSide("agents");
    if (view !== "3d") setView("3d");
    select(id, true);
  },
});
// Histórico: execuções, agendadas que rodaram e issues por ordem de atividade.
const historyView = createHistory($("#history"), {
  getData: () => data,
  getAuth: () => panel.auth,
  login: () => panel.login(),
  toast,
  onAgent: (id) => {
    setSide("agents");
    setView("3d");
    select(id, true);
  },
  onSchedule: (id) => selectSchedule(id),
  onIssue: (id) => issueDrawer.open(id),
  onRun: (r) => issueDrawer.openRun(r),
});
// Painel de gestão de issue/execução (abre por cima de qualquer visão).
const issueDrawer = createIssueDrawer($("#issue-detail"), {
  getData: () => data,
  toast,
  onAgent: (id) => {
    issueDrawer.close();
    setSide("agents");
    setView("3d");
    select(id, true);
  },
  onChanged: () => refreshNow(),
});
// Tema do cenário (⚙️): premium (padrão), orla clássica ou minimalista.
$("#theme").value = office.theme;
$("#theme").onchange = (e) => {
  office.setTheme(e.target.value);
  toast(`Cenário: ${e.target.selectedOptions[0].textContent}`);
};
$("#meet-btn").onclick = () => meetings.open({ list: (data?.meetings ?? []).length > 0 });

const sched = createScheduleDrawer($("#sched-detail"), {
  getData: () => data,
  getAuth: () => panel.auth,
  login: () => panel.login(),
  onClose: () => selectSchedule(null),
  onAgent: (id) => {
    selectSchedule(null);
    setSide("agents");
    if (view === "agenda") setView("3d");
    select(id, true);
  },
  toast,
  onChanged: () => refreshNow(),
});

function createSchedule() {
  if (!panel.auth.auth) return panel.login();
  selectedId = null;
  office.setSelected(null);
  panel.show(null);
  sched.create();
}
panel.init();

$("#auth").addEventListener("click", async () => {
  const me = await fetch("/api/me").then((r) => r.json());
  if (me.auth) {
    if (!confirm("Sair do painel?")) return;
    await panel.logout();
    location.reload();
  } else panel.login();
});

function select(id, fly = false) {
  selectedId = id;
  writeHash({ agent: id, building: office.campus.mode !== "sede" ? campusValue() : null, view });
  if (id) selectSchedule(null);
  office.setSelected(id);
  panel.show(id);
  renderSide();
  if (view === "2d") renderMain();
  if (id && fly && view === "3d") {
    office.focus(id);
    syncModeButton();
  }
}

function selectSchedule(id) {
  writeHash({ sched: id, view });
  if (id) {
    selectedId = null;
    office.setSelected(null);
    panel.show(null);
  }
  sched.show(id);
  renderSide();
  if (view === "agenda") renderMain();
}


$("#agent-list").addEventListener("click", (e) => {
  const li = e.target.closest(".agent");
  if (li) select(li.dataset.id, true);
});
$("#schedule-list").addEventListener("click", (e) => {
  const li = e.target.closest("[data-sched]");
  if (!li) return;
  selectSchedule(li.dataset.sched);
  if (view === "3d") {
    office.focusSchedule(li.dataset.sched);
    syncModeButton();
  }
});
$("#agenda").addEventListener("click", (e) => {
  if (e.target.closest("[data-new-sched]")) return createSchedule();
  const row = e.target.closest(".arow[data-sched]");
  if (row) selectSchedule(row.dataset.sched);
});
$("#grid2d").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (card) select(card.dataset.id);
});
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.hasAttribute("data-new-sched")) return createSchedule();
  if (b.hasAttribute("data-unified")) {
    unified = !unified;
    renderSide();
    applyOfficeFilter();
    if (view === "3d" && office.mode !== "interior") {
      office.setMode("interior");
      syncModeButton();
    }
    return;
  }
  if (side === "agents") filter = b.dataset.f;
  else schedFilter = b.dataset.f;
  renderSide();
  applyOfficeFilter();
  if (view === "2d") renderMain();
});
$("#search").addEventListener("input", (e) => {
  query = e.target.value.trim().toLowerCase();
  renderSide();
  applyOfficeFilter();
  if (view === "2d") renderMain();
});

// ---------- dados ----------
let refreshTimer = null;
/** Depois de uma ação: o servidor já releu o Multica; busca o snapshot novo agora. */
function refreshNow() {
  setTimeout(refresh, 400);
}
async function refresh() {
  clearTimeout(refreshTimer);
  let wait = 20;
  try {
    const res = await fetch("/api/office", { cache: "no-store" });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    wait = json.pollSeconds;
    apply(json);
  } catch (e) {
    $("#error").hidden = false;
    $("#error").textContent = `Sem dados do Multica: ${e.message}`;
  }
  // Com o tempo real ligado, a consulta periódica é só uma rede de segurança.
  refreshTimer = setTimeout(refresh, (live ? 60 : wait) * 1000);
}
// Tempo real: o servidor avisa assim que um agente começa ou termina.
let live = false;
function connectLive() {
  if (!window.EventSource) return;
  const es = new EventSource("/api/events");
  es.onopen = () => (live = true);
  es.onmessage = (ev) => {
    try {
      const json = JSON.parse(ev.data);
      if (!json.error) apply(json);
    } catch {}
  };
  es.onerror = () => {
    live = false;
    // Sessão expirada: para de tentar (a próxima consulta mostra o login).
    if (es.readyState === EventSource.CLOSED) setTimeout(connectLive, 10_000);
  };
}
function apply(json) {
  data = json;
  data.schedules ??= [];
  $("#error").hidden = true;
  office.update(data);
  office.setSchedules(data.schedules);
  renderCampusOptions();
  const unread = feed.onData(data);
  $("#feed-count").hidden = !unread || !$("#feed").hidden;
  $("#feed-count").textContent = unread;
  applyHashOnce();
  applyOfficeFilter();
  renderStats();
  renderWorkingNow();
  renderSide();
  renderMain();
  panel.refresh();
  sched.refresh();
  meetings.refresh();
  const nm = (data.meetings ?? []).length;
  $("#meet-count").hidden = !nm;
  $("#meet-count").textContent = nm;
}
syncModeButton();
refresh();
connectLive();


// ---------- prédios (sede, bairro, um prédio por máquina/runtime) ----------
function campusValue() {
  const c = office.campus;
  return c.mode === "sede" ? "sede" : c.mode === "bairro" ? `bairro:${c.groupBy}` : `um:${c.groupBy}:${c.key}`;
}
function renderCampusOptions() {
  const sel = $("#campus");
  const count = (fn) => data.agents.filter(fn).length;
  const machines = [...new Set(data.agents.map((a) => a.machine))].sort();
  const runtimes = [...new Set(data.agents.map((a) => `${a.machine} · ${a.provider}`))].sort();
  const html =
    `<option value="sede">Sede · todos (${data.agents.length})</option>` +
    `<option value="bairro:machine">🏙️ Bairro · um prédio por máquina</option>` +
    `<option value="bairro:runtime">🏙️ Bairro · um prédio por runtime</option>` +
    `<optgroup label="Só o prédio da máquina">${machines.map((m) => `<option value="um:machine:${esc(m)}">💻 ${esc(m)} (${count((a) => a.machine === m)})</option>`).join("")}</optgroup>` +
    `<optgroup label="Só o prédio do runtime">${runtimes.map((r) => `<option value="um:runtime:${esc(r)}">⚙️ ${esc(r.replace(/^(.*) · (.*)$/, "$2 · $1"))} (${count((a) => `${a.machine} · ${a.provider}` === r)})</option>`).join("")}</optgroup>`;
  if (sel.dataset.html !== html) {
    sel.innerHTML = html;
    sel.dataset.html = html;
  }
  sel.value = campusValue();
}
function setCampusValue(v) {
  const [mode, groupBy, ...rest] = v.split(":");
  if (mode === "sede") office.setCampus({ mode: "sede", key: null });
  else if (mode === "bairro") office.setCampus({ mode: "bairro", groupBy, key: null });
  else office.setCampus({ mode: "um", groupBy, key: rest.join(":") });
  if (view !== "3d") setView("3d");
  if (office.mode === "facade" && mode === "um") office.setMode("interior");
  syncModeButton();
  writeHash({ building: mode === "sede" ? null : v, view });
}
$("#campus").addEventListener("change", (e) => setCampusValue(e.target.value));

// ---------- qualidade ----------
$("#quality").value = office.quality;
$("#quality").addEventListener("change", (e) => office.setQuality(e.target.value));
$("#avatar-style").value = localStorage.getItem("painel-avatar") === "robo" ? "robo" : "pessoa";
$("#avatar-style").addEventListener("change", (e) => {
  localStorage.setItem("painel-avatar", e.target.value);
  location.reload(); // recria os avatares no estilo escolhido
});

// ---------- feed ao vivo ----------
const feed = createFeed($("#feed"), {
  onAgent: (id) => {
    setSide("agents");
    if (view === "agenda") setView("3d");
    select(id, true);
  },
  onSchedule: (id) => selectSchedule(id),
  toast,
});
$("#feed-btn").addEventListener("click", () => {
  feed.toggle();
  $("#feed-count").hidden = true;
});

// ---------- busca rápida ----------
const palette = createPalette({
  getData: () => data,
  getBuildings: () => {
    if (!data) return [];
    const machines = [...new Set(data.agents.map((a) => a.machine))];
    return [
      { key: "sede", name: "Sede · todos" },
      { key: "bairro:machine", name: "Bairro por máquina" },
      { key: "bairro:runtime", name: "Bairro por runtime" },
      ...machines.map((m) => ({ key: `um:machine:${m}`, name: `Prédio de ${m}` })),
    ];
  },
  onAgent: (id) => {
    setSide("agents");
    if (view === "agenda") setView("3d");
    select(id, true);
  },
  onSchedule: (id) => {
    selectSchedule(id);
    if (view === "3d") office.focusSchedule(id);
  },
  onBuilding: (k) => setCampusValue(k),
  actions: [
    { label: "🏙️ Ver a orla (fachada)", run: () => (setView("3d"), office.setMode("facade"), syncModeButton()) },
    { label: "🏢 Entrar no escritório", run: () => (setView("3d"), office.setMode("interior"), syncModeButton()) },
    { label: "😴 Dormitório das agendadas (3D)", run: () => (setView("3d"), office.focusDorm(), syncModeButton()) },
    { label: "📅 Abrir a Agenda", run: () => setView("agenda") },
    { label: "☰ Abrir a Lista", run: () => setView("2d") },
    { label: "➕ Nova tarefa agendada", run: () => createSchedule() },
    { label: "📰 Abrir o feed ao vivo", run: () => feed.open() },
    { label: "🌙 Ver à noite", run: () => (($("#clock-mode").value = "21"), $("#clock-mode").dispatchEvent(new Event("change"))) },
    { label: "☀️ Hora real do Rio", run: () => (($("#clock-mode").value = "live"), $("#clock-mode").dispatchEvent(new Event("change"))) },
  ],
});
$("#palette-btn").addEventListener("click", () => palette.open());

// ---------- arquivar todas as falhas (Agenda) ----------
document.addEventListener("click", async (e) => {
  if (!e.target.closest("[data-ack-all]")) return;
  if (!panel.auth.auth) return panel.login();
  const fails = data.schedules.filter((s) => s.lastRun?.status === "failed" && !s.lastRun.acked);
  if (!fails.length) return toast("Nenhuma falha pendente.");
  if (!confirm(`Arquivar ${fails.length} falha(s) pendente(s)? Elas saem das pendências do painel (nada muda no Multica).`)) return;
  try {
    for (const s of fails) await api("/api/acks", { id: s.lastRun.id, ack: true });
    toast(`${fails.length} falha(s) arquivada(s).`);
    refreshNow();
  } catch (err) {
    toast(err.message, false);
  }
});

// ---------- atalhos ----------
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return palette.open();
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open]")) return;
  const k = e.key.toLowerCase();
  if (k === "/") return e.preventDefault(), $("#search").focus();
  if (k === "escape") return select(null), selectSchedule(null);
  if (k === "1") return setView("3d");
  if (k === "2") return setView("2d");
  if (k === "3") return setView("agenda");
  if (["o", "e"].includes(k)) {
    setView("3d");
    office.setMode({ o: "facade", e: "interior" }[k]);
    return syncModeButton();
  }
  if (k === "f") return feed.toggle();
  if (k === "?") return toast("Atalhos: Ctrl+K busca · / buscar · 1 3D · 2 Lista · 3 Agenda · O orla · E escritório · F feed · Esc fechar");
});

// ---------- link direto (#a=agente, #s=agendada, #p=prédio, #v=visão) ----------
let hashApplied = false;
function applyHashOnce() {
  if (hashApplied) return;
  hashApplied = true;
  const h = readHash();
  if (h.building) setCampusValue(h.building);
  if (h.view && ["2d", "agenda", "history"].includes(h.view)) setView(h.view);
  if (h.agent && data.agents.some((a) => a.id === h.agent)) {
    office.setMode("interior");
    syncModeButton();
    setTimeout(() => select(h.agent, true), 600);
  } else if (h.sched && data.schedules.some((s) => s.id === h.sched)) {
    setTimeout(() => {
      selectSchedule(h.sched);
      if (view === "3d") office.focusSchedule(h.sched);
      syncModeButton();
    }, 600);
  }
}


// ---------- painel "Trabalhando agora": todos os nomes legíveis, mesmo com muitos bots ----------
let wnCollapsed = localStorage.getItem("painel-wn") === "0";
function renderWorkingNow() {
  const el = $("#working-now");
  if (!data) return;
  const list = data.agents.filter((a) => a.state === "working").sort((a, b) => a.machine.localeCompare(b.machine) || a.name.localeCompare(b.name));
  el.hidden = view !== "3d" || !list.length;
  el.innerHTML =
    `<button type="button" class="wn-head" data-wn-toggle>▶️ Trabalhando agora <b>${list.length}</b><span>${wnCollapsed ? "▸" : "▾"}</span></button>` +
    (wnCollapsed
      ? ""
      : `<ul>${list
          .map((a) => {
            const sum = workSummary(a);
            const tasks = activeWork(a).map((w) => `<small class="task">${sum.n > 1 ? `${workIcon(w)} ` : ""}${esc(workTitle(w))}</small>`).join("");
            return `<li data-id="${a.id}" class="${a.id === selectedId ? "sel" : ""}"><span class="em">${esc(a.emoji)}</span><span class="tx"><b>${esc(a.name)}${sum.n > 1 ? ` <span class="mult">×${sum.n}</span>` : ""}</b><small>💻 ${esc(a.machine)} · ${esc(a.provider)}${sum.text ? ` · ${esc(sum.text)}` : ""}</small>${tasks}</span></li>`;
          })
          .join("")}</ul>`);
}
$("#working-now").addEventListener("click", (e) => {
  if (e.target.closest("[data-wn-toggle]")) {
    wnCollapsed = !wnCollapsed;
    localStorage.setItem("painel-wn", wnCollapsed ? "0" : "1");
    return renderWorkingNow();
  }
  const li = e.target.closest("li[data-id]");
  if (li) select(li.dataset.id, true);
});
$("#working-now").addEventListener("mouseover", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li) office.highlight(li.dataset.id);
});
$("#working-now").addEventListener("mouseleave", () => office.highlight(null));
document.querySelector("#views").addEventListener("click", () => setTimeout(renderWorkingNow, 0));


// ---------- menu ao clicar numa mesa, cadeira ou espaço ----------
const spotMenu = document.createElement("div");
spotMenu.className = "spot-menu";
spotMenu.hidden = true;
document.body.appendChild(spotMenu);
const STATE_TXT = { working: "trabalhando", idle: "na copa (ocioso)", blocked: "bloqueado", offline: "offline" };

function openSpotMenu({ agentId, x, y }) {
  if (!data) return;
  const owner = agentId ? data.agents.find((a) => a.id === agentId) : null;
  const opts = data.agents
    .slice()
    .sort((a, b) => (a.state === "offline") - (b.state === "offline") || a.name.localeCompare(b.name))
    .map((a) => `<option value="${a.id}" ${a.id === agentId ? "selected" : ""}>${esc(a.emoji)} ${esc(a.name)} · ${esc(a.machine)}${a.state === "offline" ? " (offline)" : ""}</option>`)
    .join("");
  spotMenu.innerHTML = `
    <button type="button" class="sm-close" aria-label="Fechar">✕</button>
    ${owner
      ? `<div class="sm-title">🪑 Mesa de <b>${esc(owner.emoji)} ${esc(owner.name)}</b></div>
         <div class="sm-sub">💻 ${esc(owner.machine)} · ${esc(owner.provider)} · ${STATE_TXT[owner.state]}</div>
         <div class="sm-actions">
           <button type="button" class="primary" data-sm="new" data-id="${owner.id}">➕ Nova tarefa</button>
           <button type="button" data-sm="chat" data-id="${owner.id}">💬 Conversar</button>
           <button type="button" data-sm="activity" data-id="${owner.id}">📜 Atividade</button>
         </div>
         <div class="sm-sep">ou iniciar outro agente aqui</div>`
      : `<div class="sm-title">✨ Iniciar um agente</div><div class="sm-sub">Escolha quem vai trabalhar e o que fazer.</div>`}
    <select class="sm-pick" aria-label="Agente">${opts}</select>
    <div class="sm-actions">
      <button type="button" class="primary" data-sm="new">➕ Nova tarefa</button>
      <button type="button" data-sm="chat">💬 Conversar</button>
      <button type="button" data-sm="activity">👤 Ver agente</button>
    </div>`;
  spotMenu.hidden = false;
  const r = spotMenu.getBoundingClientRect();
  spotMenu.style.left = `${Math.min(x + 8, innerWidth - r.width - 10)}px`;
  spotMenu.style.top = `${Math.min(y + 8, innerHeight - r.height - 10)}px`;
}

spotMenu.addEventListener("click", (e) => {
  if (e.target.closest(".sm-close")) return (spotMenu.hidden = true);
  const b = e.target.closest("[data-sm]");
  if (!b) return;
  const id = b.dataset.id ?? spotMenu.querySelector(".sm-pick").value;
  spotMenu.hidden = true;
  setSide("agents");
  select(id, true);
  if (b.dataset.sm !== "activity") {
    if (!panel.auth.auth) return panel.login();
    panel.showTab(id, b.dataset.sm);
  }
});
document.addEventListener("keydown", (e) => e.key === "Escape" && (spotMenu.hidden = true));
document.addEventListener("pointerdown", (e) => {
  if (!spotMenu.hidden && !spotMenu.contains(e.target) && e.target.tagName !== "CANVAS") spotMenu.hidden = true;
});
