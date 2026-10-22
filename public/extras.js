// Funções de apoio: feed ao vivo (o que mudou entre atualizações), busca
// rápida (Ctrl+K), links diretos (#a=, #s=, #p=) e atalhos de teclado.

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hm = (d = new Date()) => d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

// ---------- feed ao vivo ----------

export function createFeed(el, { onAgent, onSchedule, toast }) {
  let prev = null;
  const events = [];
  let unread = 0;
  el.innerHTML = `<div class="feed-head"><b>📰 Ao vivo</b><span class="muted small">mudanças desde que você abriu</span><button type="button" class="feed-close" aria-label="Fechar">✕</button></div><ul class="feed-list"></ul>`;
  const list = el.querySelector(".feed-list");
  el.querySelector(".feed-close").onclick = () => (el.hidden = true);
  list.addEventListener("click", (e) => {
    const li = e.target.closest("[data-a], [data-s]");
    if (li?.dataset.a) onAgent(li.dataset.a);
    else if (li?.dataset.s) onSchedule(li.dataset.s);
  });

  function push(ev, notify) {
    events.unshift({ ...ev, at: new Date() });
    events.length = Math.min(events.length, 60);
    unread++;
    if (notify) toast(ev.text, ev.kind !== "bad");
  }

  function render() {
    list.innerHTML = events.length
      ? events.map((e) => `<li class="ev ${e.kind}" ${e.a ? `data-a="${e.a}"` : ""} ${e.s ? `data-s="${e.s}"` : ""}><span class="t">${hm(e.at)}</span>${esc(e.text)}</li>`).join("")
      : `<li class="muted small">Nada mudou ainda. Os eventos aparecem aqui a cada atualização (20 s).</li>`;
  }

  return {
    onData(data) {
      const cur = {
        agents: new Map(data.agents.map((a) => [a.id, a])),
        sched: new Map(data.schedules.map((s) => [s.id, s])),
      };
      if (prev) {
        for (const a of data.agents) {
          const b = prev.agents.get(a.id);
          if (!b) {
            push({ kind: "info", a: a.id, text: `➕ Novo agente: ${a.emoji} ${a.name}` });
            continue;
          }
          const task = a.work?.[0]?.issue?.identifier ?? a.work?.[0]?.label ?? "";
          if (a.state !== b.state) {
            const txt = {
              working: `▶️ ${a.emoji} ${a.name} começou${task ? ` ${task}` : ""} (💻 ${a.machine})`,
              idle: b.state === "working" ? `✅ ${a.emoji} ${a.name} terminou e foi para a copa` : `☕ ${a.emoji} ${a.name} ficou ocioso`,
              blocked: `⛔ ${a.emoji} ${a.name} bloqueou (${a.blocked[0]?.identifier ?? "pendência"})`,
              offline: `💤 ${a.emoji} ${a.name} ficou offline (${a.machine})`,
            }[a.state];
            push({ kind: a.state === "blocked" ? "bad" : a.state === "working" ? "good" : "info", a: a.id, text: txt }, a.state === "working" || a.state === "blocked");
          } else if (a.state === "working") {
            const prevTask = b.work?.[0]?.issue?.identifier ?? b.work?.[0]?.label ?? "";
            if (task && task !== prevTask) push({ kind: "good", a: a.id, text: `🔄 ${a.emoji} ${a.name} passou para ${task}` });
          }
        }
        for (const id of prev.agents.keys()) if (!cur.agents.has(id)) push({ kind: "info", text: `🗄️ ${prev.agents.get(id).name} saiu do escritório` });
        for (const s of data.schedules) {
          const b = prev.sched.get(s.id);
          if (!b || !s.lastRun || s.lastRun.id === b.lastRun?.id) continue;
          const bad = s.lastRun.status === "failed";
          push({ kind: bad ? "bad" : "good", s: s.id, text: `${bad ? "❌" : "⏰"} ${s.title}: ${bad ? "falhou" : "executou"}` }, bad);
        }
      }
      prev = cur;
      render();
      return unread;
    },
    open() {
      el.hidden = false;
      unread = 0;
      render();
    },
    toggle() {
      if (el.hidden) this.open();
      else el.hidden = true;
    },
    get unread() {
      return unread;
    },
  };
}

// ---------- busca rápida (Ctrl+K) ----------

export function createPalette({ getData, getBuildings, onAgent, onSchedule, onBuilding, actions }) {
  const dlg = document.createElement("dialog");
  dlg.className = "palette";
  dlg.innerHTML = `<input type="search" placeholder="Buscar agente, tarefa agendada, prédio ou ação…" /><ul></ul><div class="muted small hint">↑↓ para escolher · Enter abre · Esc fecha</div>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector("input");
  const ul = dlg.querySelector("ul");
  let items = [];
  let sel = 0;

  function all() {
    const d = getData();
    if (!d) return [];
    return [
      ...actions.map((a) => ({ type: "Ação", label: a.label, run: a.run })),
      ...getBuildings().map((b) => ({ type: "Prédio", label: `🏢 ${b.name}`, run: () => onBuilding(b.key) })),
      ...d.agents.map((a) => ({ type: "Agente", label: `${a.emoji} ${a.name}`, sub: `${a.machine} · ${a.provider}${a.work?.[0]?.issue ? ` · ${a.work[0].issue.identifier}` : ""}`, run: () => onAgent(a.id) })),
      ...d.schedules.map((s) => ({ type: "Agendada", label: `⏰ ${s.title}`, sub: s.status === "active" ? "ativa" : "pausada", run: () => onSchedule(s.id) })),
    ];
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    items = all().filter((it) => !q || `${it.label} ${it.sub ?? ""} ${it.type}`.toLowerCase().includes(q)).slice(0, 40);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    ul.innerHTML = items.length
      ? items.map((it, i) => `<li class="${i === sel ? "sel" : ""}" data-i="${i}"><span class="type">${it.type}</span><span class="lbl">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span></li>`).join("")
      : `<li class="muted">Nada encontrado.</li>`;
    ul.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  }

  function go(i) {
    const it = items[i];
    if (!it) return;
    dlg.close();
    it.run();
  }

  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") (sel = Math.min(items.length - 1, sel + 1)), render(), e.preventDefault();
    else if (e.key === "ArrowUp") (sel = Math.max(0, sel - 1)), render(), e.preventDefault();
    else if (e.key === "Enter") go(sel);
    else if (e.key === "Escape") dlg.close();
  });
  ul.addEventListener("click", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) go(Number(li.dataset.i));
  });
  dlg.addEventListener("click", (e) => e.target === dlg && dlg.close());

  return {
    open() {
      input.value = "";
      sel = 0;
      render();
      dlg.showModal();
      input.focus();
    },
  };
}

// ---------- links diretos ----------

export function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { agent: h.get("a"), sched: h.get("s"), building: h.get("p"), view: h.get("v") };
}

export function writeHash(state) {
  const h = new URLSearchParams();
  if (state.agent) h.set("a", state.agent);
  if (state.sched) h.set("s", state.sched);
  if (state.building) h.set("p", state.building);
  if (state.view && state.view !== "3d") h.set("v", state.view);
  const next = h.toString() ? `#${h}` : " ";
  if (location.hash !== next.trim()) history.replaceState(null, "", next === " " ? location.pathname + location.search : next);
}
