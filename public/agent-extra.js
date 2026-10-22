// Abas extras do painel do agente (com login): Conversa, Chats e Configurar.
// Cada render devolve uma função de limpeza (timers, etc.).

import { HAIRS, OUTFITS, SKINS, hex } from "./looks.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = "America/Sao_Paulo";
const when = (iso) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const THINKING = [["", "Padrão do runtime"], ["off", "Desligado"], ["minimal", "Mínimo"], ["low", "Baixo"], ["medium", "Médio"], ["high", "Alto"], ["xhigh", "Muito alto"], ["max", "Máximo"]];

/** Markdown mínimo e seguro: escapa tudo e só então aplica negrito, código e quebras. */
function md(text) {
  return esc(text)
    .replace(/```([\s\S]*?)```/g, "<pre>$1</pre>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");
}

// ---------- Conversa pelo painel ----------

export function renderConversation(tb, { agent, api, flash }) {
  let timer = null;
  let alive = true;
  tb.innerHTML = `<p class="muted small">Fale com <b>${esc(agent.name)}</b> por aqui: cada mensagem vira um comentário na issue de conversa do agente, que acorda e responde. O fio fica salvo no Multica.</p>
    <div class="chat-log"><p class="muted">Carregando…</p></div>
    <form class="chat-send">
      <textarea rows="3" required placeholder="Escreva para o agente… (Ctrl+Enter envia)"></textarea>
      <div class="row"><span class="muted small chat-state"></span><button type="submit" class="primary">Enviar</button></div>
    </form>`;
  const log = tb.querySelector(".chat-log");
  const state = tb.querySelector(".chat-state");
  const form = tb.querySelector("form");
  const ta = form.querySelector("textarea");

  async function load() {
    try {
      const c = await api(`/api/agents/${agent.id}/conversation`);
      if (!alive) return;
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
      log.innerHTML = c.messages.length
        ? c.messages.map((m) => `<div class="msg ${m.role}"><div class="who">${m.role === "agent" ? `${esc(agent.emoji)} ${esc(agent.name)}` : "Você"} · ${when(m.at)}</div><div class="txt">${md(m.text)}</div></div>`).join("")
        : `<p class="muted">Nenhuma mensagem ainda. A primeira cria a conversa.</p>`;
      state.textContent = c.issue ? `${c.issue.identifier}${c.working ? " · ✍️ agente trabalhando…" : ""}` : "";
      if (atBottom || !log.dataset.seen) log.scrollTop = log.scrollHeight;
      log.dataset.seen = "1";
    } catch (e) {
      log.innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      await api(`/api/agents/${agent.id}/conversation`, { text: ta.value, agentName: agent.name });
      ta.value = "";
      flash("Mensagem enviada; o agente foi acordado.");
      await load();
    } catch (err) {
      flash(err.message, false);
    } finally {
      btn.disabled = false;
    }
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
  load();
  timer = setInterval(load, 8000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

// ---------- Chats do Multica (leitura) ----------

export function renderChats(tb, { agent, api }) {
  let alive = true;
  tb.innerHTML = `<p class="muted small">Conversas abertas no app do Multica com este agente. Aqui aparecem as respostas e os passos do agente; o app do Multica não deixa abrir chat novo por fora — para falar com ele pelo painel, use a aba <b>💬 Conversa</b>.</p><div class="chat-sessions"><p class="muted">Carregando…</p></div>`;
  const box = tb.querySelector(".chat-sessions");
  api(`/api/agents/${agent.id}/chats`)
    .then(({ sessions }) => {
      if (!alive) return;
      box.innerHTML = sessions.length
        ? sessions
            .map(
              (s) => `<div class="run"><div class="run-top"><b>💬 Chat${s.by ? ` com ${esc(s.by)}` : ""}</b><small class="muted">${s.runs.length} turno(s) · ${when(s.runs[0]?.at)}</small></div>
                ${s.runs.map((r) => `<div class="chat-turn"><button type="button" data-run="${r.id}">▼ ${when(r.at)} · ${esc(r.status)}</button><div class="turn-body" hidden></div></div>`).join("")}</div>`,
            )
            .join("")
        : `<p class="muted">Nenhum chat recente.</p>`;
    })
    .catch((e) => (box.innerHTML = `<p class="error">${esc(e.message)}</p>`));
  box.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-run]");
    if (!b) return;
    const out = b.nextElementSibling;
    out.hidden = !out.hidden;
    if (out.hidden || out.dataset.loaded) return;
    out.innerHTML = `<p class="muted">Carregando…</p>`;
    try {
      const { messages } = await api(`/api/runs/${b.dataset.run}/messages`);
      out.dataset.loaded = "1";
      // Respostas em destaque; os passos de ferramenta entre elas ficam recolhidos.
      const parts = [];
      let tools = [];
      const flush = () => {
        if (tools.length) parts.push(`<details class="tools"><summary>🔧 ${tools.length} passo(s)</summary>${tools.join("")}</details>`);
        tools = [];
      };
      for (const m of messages) {
        if (m.type === "text") {
          flush();
          parts.push(`<div class="msg agent"><div class="txt">${md(m.text)}</div></div>`);
        } else if (m.type === "tool") tools.push(`<div class="step tool">🔧 <b>${esc(m.tool)}</b> <code>${esc(m.text)}</code></div>`);
      }
      flush();
      out.innerHTML = parts.length ? parts.join("") : `<p class="muted">Sem mensagens registradas.</p>`;
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
  return () => (alive = false);
}

// ---------- Configurar ----------

export function renderConfig(tb, { agent, api, flash, onChanged }) {
  let alive = true;
  tb.innerHTML = `<p class="muted">Carregando configuração…</p>`;
  api(`/api/agents/${agent.id}/details`)
    .then((d) => alive && draw(d))
    .catch((e) => (tb.innerHTML = `<p class="error">${esc(e.message)}</p>`));

  function draw({ agent: a, runtimes, workspaceSkills }) {
    const rtOpts = (sel) =>
      runtimes
        .sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name))
        .map((r) => `<option value="${r.id}" ${r.id === sel ? "selected" : ""}>${r.online ? "🟢" : "⚫"} ${esc(r.name)}</option>`)
        .join("");
    const assigned = new Set(a.skills.map((s) => s.id));
    tb.innerHTML = `
      <form class="cfg">
        <div class="section-title">Identidade</div>
        <label>Nome<input name="name" maxlength="120" value="${esc(a.name)}" required /></label>
        <label>Descrição<textarea name="description" rows="2" maxlength="2000">${esc(a.description)}</textarea></label>
        <label>Instruções <small class="muted">(prompt de sistema do agente)</small><textarea name="instructions" rows="12" class="mono">${esc(a.instructions)}</textarea></label>
        <div class="section-title">Execução</div>
        <div class="grid2">
          <label>Runtime / máquina<select name="runtimeId">${rtOpts(a.runtimeId)}</select></label>
          <label>Modelo<input name="model" value="${esc(a.model)}" placeholder="padrão do runtime" /></label>
          <label>Raciocínio<select name="thinkingLevel">${THINKING.map(([v, l]) => `<option value="${v}" ${v === a.thinkingLevel ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Runs simultâneas<input name="maxConcurrent" type="number" min="1" max="50" value="${a.maxConcurrent ?? 1}" /></label>
          <label>Quem pode acionar<select name="permission">
            <option value="workspace" ${a.permissionMode !== "private" ? "selected" : ""}>Todo o workspace</option>
            <option value="private" ${a.permissionMode === "private" ? "selected" : ""}>Só o dono</option></select></label>
        </div>
        <button type="submit" class="primary wide">💾 Salvar alterações</button>
      </form>
      <form class="cfg-skills">
        <div class="section-title">Skills do workspace (${workspaceSkills.length})</div>
        ${workspaceSkills.length
          ? workspaceSkills.map((s) => `<label class="check"><input type="checkbox" value="${s.id}" ${assigned.has(s.id) ? "checked" : ""}/> <b>${esc(s.name)}</b><small class="muted">${esc(s.description)}</small></label>`).join("")
          : `<p class="muted">Nenhuma skill no workspace.</p>`}
        ${workspaceSkills.length ? `<button type="submit">Salvar skills</button>` : ""}
      </form>
      <div class="section-title">Segredos</div>
      <p class="muted small">Variáveis de ambiente: ${a.envKeys} · MCP: ${a.hasMcp ? "configurado" : "nenhum"}. Por segurança, segredos não passam pelo painel — edite no app do Multica.</p>
      <div class="section-title">Copiar agente</div>
      <form class="cfg-copy grid2">
        <label>Nome da cópia<input name="name" value="${esc(a.name)} (cópia)" maxlength="120" /></label>
        <label>Em qual runtime<select name="runtimeId">${rtOpts(a.runtimeId)}</select></label>
        <button type="submit">📄 Criar cópia</button>
      </form>
      <div class="section-title danger-title">Zona de risco</div>
      <button type="button" class="danger" data-act="archive">🗄️ Arquivar agente</button>
      <p class="muted small">Criado em ${when(a.createdAt)} · atualizado em ${when(a.updatedAt)}</p>`;

    const form = tb.querySelector("form.cfg");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = form.elements;
      const next = {
        name: f.name.value, description: f.description.value, instructions: f.instructions.value, model: f.model.value,
        thinkingLevel: f.thinkingLevel.value, maxConcurrent: Number(f.maxConcurrent.value), runtimeId: f.runtimeId.value, permission: f.permission.value,
      };
      const prev = {
        name: a.name, description: a.description, instructions: a.instructions, model: a.model, thinkingLevel: a.thinkingLevel,
        maxConcurrent: a.maxConcurrent, runtimeId: a.runtimeId, permission: a.permissionMode === "private" ? "private" : "workspace",
      };
      const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== prev[k]));
      if (!Object.keys(diff).length) return flash("Nada mudou.");
      if (diff.runtimeId && !confirm("Trocar o runtime muda a máquina onde o agente roda. Continuar?")) return;
      try {
        await api(`/api/agents/${a.id}/update`, diff);
        Object.assign(a, diff, diff.permission ? { permissionMode: diff.permission === "private" ? "private" : "public_to" } : {});
        flash("Agente atualizado.");
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector("form.cfg-skills")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ids = [...e.target.querySelectorAll("input:checked")].map((i) => i.value);
      try {
        await api(`/api/agents/${a.id}/skills`, { skillIds: ids });
        flash("Skills atualizadas.");
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector("form.cfg-copy").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      if (!confirm(`Criar uma cópia de "${a.name}"?`)) return;
      try {
        const c = await api(`/api/agents/${a.id}/copy`, { name: f.name.value, runtimeId: f.runtimeId.value === a.runtimeId ? "" : f.runtimeId.value });
        flash(`Cópia criada: ${c.name}`);
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
    });
    tb.querySelector('[data-act="archive"]').addEventListener("click", async () => {
      const typed = prompt(`Arquivar desativa "${a.name}". Para confirmar, digite o nome do agente:`);
      if (typed !== a.name) return typed !== null && flash("Nome não confere; nada foi arquivado.", false);
      try {
        await api(`/api/agents/${a.id}/archive`, {});
        flash("Agente arquivado.");
        onChanged({ archived: true });
      } catch (err) {
        flash(err.message, false);
      }
    });
  }
  return () => (alive = false);
}


// ---------- Visual (uniforme, pele, cabelo) ----------

const SWATCH = {
  liso: "linear-gradient(135deg,#8d9bb5,#c4cee0)", hotel: "#1b5fd1", social: "linear-gradient(90deg,#f4f6fb 45%,#1e3a8a 45% 55%,#f4f6fb 55%)",
  terno: "linear-gradient(90deg,#1f2430 40%,#f4f6fb 40% 60%,#1f2430 60%)", recepcao: "linear-gradient(#0b3d5c 30%,#f6b94a 30% 36%,#0b3d5c 36%)",
  chef: "#fafafa", esporte: "#6b7280", verao: "radial-gradient(circle at 30% 30%,#ef4444 12%,transparent 13%),radial-gradient(circle at 70% 60%,#22c55e 12%,transparent 13%),#fbbf24",
  flamengo: "repeating-linear-gradient(#c8102e 0 8px,#111 8px 16px)",
};

export function renderLook(tb, { agent, api, flash, onChanged }) {
  const cur = agent.look ?? {};
  let sel = { outfit: cur.outfit ?? "liso", skin: cur.skin, hair: cur.hair };
  const draw = () => {
    tb.innerHTML = `
      <div class="section-title">Uniforme</div>
      <div class="looks">${Object.entries(OUTFITS)
        .map(([k, o]) => `<button type="button" class="look ${sel.outfit === k ? "on" : ""}" data-outfit="${k}" title="${esc(o.label)}"><i style="background:${SWATCH[k]}"></i><span>${esc(o.label)}</span></button>`)
        .join("")}</div>
      <div class="section-title">Tom de pele</div>
      <div class="dots">${SKINS.map((c) => `<button type="button" class="dotpick ${sel.skin === c ? "on" : ""}" data-skin="${c}" style="background:${hex(c)}" aria-label="pele"></button>`).join("")}<button type="button" class="dotpick auto ${sel.skin == null ? "on" : ""}" data-skin="" title="automático">A</button></div>
      <div class="section-title">Cabelo</div>
      <div class="dots">${HAIRS.map((c) => `<button type="button" class="dotpick ${sel.hair === c ? "on" : ""}" data-hair="${c}" style="background:${hex(c)}" aria-label="cabelo"></button>`).join("")}<button type="button" class="dotpick auto ${sel.hair == null ? "on" : ""}" data-hair="" title="automático">A</button></div>
      <div class="row" style="margin-top:12px"><button type="button" data-reset>↺ Voltar ao padrão</button><button type="button" class="primary" data-save>💾 Salvar visual</button></div>
      <p class="muted small">O visual vale para todos que abrem o painel. Atualiza no escritório em segundos.</p>`;
  };
  tb.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.outfit) sel.outfit = b.dataset.outfit;
    else if ("skin" in b.dataset) sel.skin = b.dataset.skin ? Number(b.dataset.skin) : undefined;
    else if ("hair" in b.dataset) sel.hair = b.dataset.hair ? Number(b.dataset.hair) : undefined;
    else if ("save" in b.dataset || "reset" in b.dataset) {
      try {
        await api(`/api/agents/${agent.id}/look`, "reset" in b.dataset ? { reset: true } : sel);
        flash("reset" in b.dataset ? "Visual padrão restaurado." : "Visual salvo.");
        onChanged();
      } catch (err) {
        flash(err.message, false);
      }
      return;
    } else return;
    draw();
  });
  draw();
  return () => {};
}
