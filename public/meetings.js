// Reuniões de agentes: escolher participantes (com sugestão pela pauta),
// criar a reunião e acompanhar/encerrar as que estão abertas.

import { api } from "./agent-panel.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STOP = new Set(
  "para com sem uma umas uns como mais menos sobre entre pelo pela pelos pelas este esta isso essa esse aqui todo toda todos todas fazer criar ver que qual quais quando onde porque cada dos das nos nas the and for agente agentes tarefa tarefas reuniao conversa multica copy".split(" "),
);
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));

/**
 * Sugestão de participantes: palavras da pauta que aparecem no nome e na descrição
 * de cada agente (nome pesa mais). Quem está desligado fica de fora.
 */
export function suggestAgents(agents, text, limit = 4) {
  const terms = new Set(words(text));
  if (!terms.size) return [];
  return agents
    .filter((a) => a.state !== "offline")
    .map((a) => {
      const name = new Set(words(a.name));
      const desc = new Set(words(a.description));
      let score = 0;
      for (const t of terms) {
        if (name.has(t)) score += 3;
        else if ([...name].some((w) => w.startsWith(t.slice(0, 5)))) score += 2;
        if (desc.has(t)) score += 1;
        else if ([...desc].some((w) => w.length > 5 && w.startsWith(t.slice(0, 5)))) score += 0.5;
      }
      return { a, score };
    })
    .filter((x) => x.score >= 1)
    .sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name))
    .slice(0, limit)
    .map((x) => x.a);
}

export function createMeetings({ getData, getAuth, login, toast, onChanged, onAgent }) {
  const dlg = document.createElement("dialog");
  dlg.className = "meet-dlg";
  document.body.appendChild(dlg);
  let picked = []; // ids, na ordem (o primeiro coordena)
  let mode = "new";
  let filterText = "";

  const agents = () => (getData()?.agents ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const byId = (id) => getData()?.agents.find((a) => a.id === id);
  const names = (ids) => Object.fromEntries(ids.map((id) => [id, byId(id)?.name ?? "agente"]));

  function open(opts = {}) {
    if (!getAuth().auth) return login();
    mode = opts.list ? "list" : "new";
    picked = [...new Set(opts.agents ?? [])];
    filterText = "";
    dlg.innerHTML = "";
    render(opts);
    if (!dlg.open) dlg.showModal();
  }

  function render(opts = {}) {
    if (mode === "list") return renderList();
    const title = dlg.querySelector("[name=title]")?.value ?? opts.title ?? "";
    const prompt = dlg.querySelector("[name=prompt]")?.value ?? opts.prompt ?? "";
    const pair = picked.length === 2 && opts.pair;
    dlg.innerHTML = `
      <form method="dialog" class="meet-form">
        <header><h2>${opts.pair ? "🗣️ Conversa entre agentes" : "🤝 Nova reunião de agentes"}</h2>
          <button type="button" class="ghost" data-x="list">📋 Reuniões abertas (${(getData()?.meetings ?? []).length})</button>
          <button type="button" class="close" data-x="close" aria-label="Fechar">✕</button></header>
        <label>Assunto<input name="title" maxlength="120" required placeholder="Ex.: Campanha de verão dos hotéis" value="${esc(title)}" /></label>
        <label>Pauta / o que vocês devem resolver juntos<textarea name="prompt" rows="4" required placeholder="Descreva a tarefa. Cada agente contribui com a sua especialidade e o coordenador consolida.">${esc(prompt)}</textarea></label>
        <div class="meet-pick-head">
          <b>Participantes <small>(${picked.length}/10 · o 1º coordena)</small></b>
          <button type="button" data-x="suggest" title="Sugere agentes pelas palavras do assunto e da pauta">✨ Sugerir pela pauta</button>
        </div>
        <div class="meet-chosen">${picked.length ? picked.map((id, i) => {
          const a = byId(id);
          return `<span class="chip-ag ${i === 0 ? "lead" : ""}">${i === 0 ? "👑 " : ""}${esc(a?.emoji ?? "")} ${esc(a?.name ?? id)}
            ${i ? `<button type="button" data-lead="${id}" title="Tornar coordenador">👑</button>` : ""}<button type="button" data-rm="${id}" title="Tirar">✕</button></span>`;
        }).join("") : `<small class="muted">Clique nos agentes abaixo (ou use ✨ Sugerir).</small>`}</div>
        <input class="meet-search" placeholder="🔎 Buscar agente…" value="${esc(filterText)}" />
        <ul class="meet-list">${listItems()}</ul>
        <footer>
          <small class="muted">${pair ? "Os dois conversam no mesmo tópico; o primeiro coordena." : "Cria uma issue com a pauta para o coordenador e chama os demais por menção, no mesmo tópico."}</small>
          <button type="submit" class="primary" ${picked.length < 2 ? "disabled" : ""}>🤝 Iniciar ${opts.pair ? "conversa" : "reunião"}</button>
        </footer>
      </form>`;
    dlg.querySelector(".meet-search").oninput = (e) => {
      filterText = e.target.value;
      dlg.querySelector(".meet-list").innerHTML = listItems();
    };
    dlg.querySelector("form").onsubmit = (e) => {
      e.preventDefault();
      submit(opts);
    };
    dlg.dataset.pair = opts.pair ? "1" : "";
  }

  function listItems() {
    const q = norm(filterText);
    return agents()
      .filter((a) => !q || norm(a.name).includes(q) || norm(a.description).includes(q))
      .map((a) => `<li class="${picked.includes(a.id) ? "on" : ""} ${a.state}" data-pick="${a.id}">
        <span class="dot ${a.state}"></span><span class="em">${esc(a.emoji)}</span>
        <span class="nm">${esc(a.name)}<small>${esc(a.machine)} · ${esc(a.provider)}${a.state === "working" ? " · trabalhando" : a.state === "offline" ? " · desligado" : ""}</small></span>
        <span class="ck">${picked.includes(a.id) ? "✓" : "+"}</span></li>`)
      .join("");
  }

  function renderList() {
    const list = getData()?.meetings ?? [];
    dlg.innerHTML = `
      <div class="meet-form">
        <header><h2>📋 Reuniões abertas</h2>
          <button type="button" class="ghost" data-x="new">🤝 Nova reunião</button>
          <button type="button" class="close" data-x="close" aria-label="Fechar">✕</button></header>
        ${list.length ? list.map((m) => `
          <div class="meet-card">
            <div><b>${esc(m.identifier ?? "")}</b> ${esc(m.title)} <small class="muted">· ${esc(m.status)}</small></div>
            <div class="meet-people">${m.agents.map((id) => {
              const a = byId(id);
              return `<button type="button" class="chip-ag ${id === m.coordinator ? "lead" : ""} ${a?.state ?? ""}" data-agent="${id}">${id === m.coordinator ? "👑 " : ""}${esc(a?.emoji ?? "")} ${esc(a?.name ?? "?")}</button>`;
            }).join("")}</div>
            <div class="meet-msg"><input placeholder="Mensagem para todos os participantes…" data-msg="${m.id}" />
              <button type="button" data-send="${m.id}">📨 Enviar</button>
              <button type="button" class="primary" data-end="${m.id}">✅ Encerrar</button></div>
          </div>`).join("") : `<p class="muted">Nenhuma reunião aberta. Crie uma em “🤝 Nova reunião”.</p>`}
      </div>`;
  }

  async function submit(opts) {
    const title = dlg.querySelector("[name=title]").value.trim();
    const prompt = dlg.querySelector("[name=prompt]").value.trim();
    if (picked.length < 2 || !title || !prompt) return toast("Preencha assunto, pauta e pelo menos 2 agentes.", false);
    const btn = dlg.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "⏳ Chamando os agentes…";
    try {
      const { meeting } = await api("/api/meetings", { title, prompt, agents: picked.map((id) => ({ id, name: byId(id)?.name })) });
      toast(`${meeting.identifier ?? "Reunião"} criada: ${picked.length} agentes a caminho da sala de reunião.`);
      dlg.close();
      onChanged();
    } catch (e) {
      toast(`Não deu: ${e.message}`, false);
      btn.disabled = false;
      btn.textContent = opts.pair ? "🤝 Iniciar conversa" : "🤝 Iniciar reunião";
    }
  }

  dlg.addEventListener("click", async (e) => {
    const t = e.target.closest("button, li");
    if (!t) {
      if (e.target === dlg) dlg.close(); // clique fora
      return;
    }
    const d = t.dataset;
    if (d.x === "close") return dlg.close();
    if (d.x === "list") return (mode = "list"), renderList();
    if (d.x === "new") return (mode = "new"), render({});
    if (d.x === "suggest") {
      const text = `${dlg.querySelector("[name=title]").value} ${dlg.querySelector("[name=prompt]").value}`;
      const sug = suggestAgents(agents().filter((a) => !picked.includes(a.id)), text, Math.max(0, Math.min(4, 10 - picked.length)));
      if (!sug.length) return toast("Nenhum agente combina com essas palavras. Escreva mais sobre a pauta ou escolha manualmente.", false);
      picked.push(...sug.map((a) => a.id));
      toast(`Sugeridos: ${sug.map((a) => a.name).join(", ")}`);
      return render({ pair: dlg.dataset.pair === "1" });
    }
    if (d.pick) {
      const i = picked.indexOf(d.pick);
      if (i >= 0) picked.splice(i, 1);
      else if (picked.length < 10) picked.push(d.pick);
      return render({ pair: dlg.dataset.pair === "1" });
    }
    if (d.rm) return picked.splice(picked.indexOf(d.rm), 1), render({ pair: dlg.dataset.pair === "1" });
    if (d.lead) return (picked = [d.lead, ...picked.filter((x) => x !== d.lead)]), render({ pair: dlg.dataset.pair === "1" });
    if (d.agent) return dlg.close(), onAgent(d.agent);
    if (d.send) {
      const input = dlg.querySelector(`[data-msg="${d.send}"]`);
      if (!input.value.trim()) return input.focus();
      const m = (getData()?.meetings ?? []).find((x) => x.id === d.send);
      t.disabled = true;
      try {
        await api(`/api/meetings/${d.send}/message`, { text: input.value, names: names(m?.agents ?? []) });
        input.value = "";
        toast("Mensagem enviada para todos os participantes.");
        onChanged();
      } catch (err) {
        toast(`Não deu: ${err.message}`, false);
      }
      t.disabled = false;
      return;
    }
    if (d.end) {
      if (!confirm("Encerrar a reunião? A issue vai para concluída e os agentes voltam aos seus lugares.")) return;
      try {
        await api(`/api/meetings/${d.end}/end`, {});
        toast("Reunião encerrada.");
        onChanged();
        setTimeout(renderList, 600);
      } catch (err) {
        toast(`Não deu: ${err.message}`, false);
      }
    }
  });

  return {
    open,
    /** Mantém a lista aberta em dia com os dados novos. */
    refresh() {
      const typing = dlg.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
      if (dlg.open && mode === "list" && !typing) renderList();
    },
  };
}
