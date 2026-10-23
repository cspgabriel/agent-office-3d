// O que um agente está fazendo agora, quando pode ser mais de uma coisa:
// chats (💬), tarefas/issues (📋), agendadas (⏰) e o que está na fila (🕓).

const ICON = { chat: "💬", autopilot: "⏰", schedule: "⏰" };

/** Ícone de uma execução em andamento. */
export const workIcon = (w) => (w.queued ? "🕓" : ICON[w.kind] ?? (w.kind === "starting" ? "▶️" : "📋"));

/**
 * Texto curto de uma execução: "TASK-12 · título" (issue) ou, num chat, do que se
 * trata ("Vou publicar a matéria…", a primeira fala do agente) em vez de "Chat com Ana".
 */
export function workTitle(w) {
  if (w.issue) return `${w.issue.identifier} · ${w.issue.title}`;
  return w.about || w.label || (w.kind === "chat" ? "Chat" : (w.kind ?? "execução"));
}

/** Dica completa (tooltip): projeto, pedido, quem pediu e o que está fazendo agora. */
export function workHint(w) {
  return [
    w.issue?.project ? `Projeto: ${w.issue.project}` : "",
    w.issue ? `${w.issue.identifier} · ${w.issue.title}` : "",
    w.about ? `Pedido: ${w.about}` : "",
    w.by ? `Por: ${w.by}` : "",
    w.now ? `Agora: ${w.now}` : "",
    "Clique para ver os detalhes",
  ].filter(Boolean).join(" · ");
}

/** Atributos para abrir o detalhe ao clicar (issue → painel da issue; chat → passos da execução). */
export const workAttrs = (w, agentId, esc) =>
  `data-wrun="${esc(w.id ?? "")}" data-wissue="${esc(w.issue?.id ?? "")}" data-wagent="${esc(agentId)}" title="${esc(workHint(w))}"`;

/** Só as execuções rodando (sem as da fila). */
export const activeWork = (agent) => (agent.work ?? []).filter((w) => !w.queued);

/**
 * Resumo para o rótulo: { n, text } — n = execuções rodando ao mesmo tempo;
 * text = "💬2 · 📋1 · 🕓1 na fila" (vazio se é só uma coisa e nada na fila).
 */
export function workSummary(agent) {
  const work = agent.work ?? [];
  const active = work.filter((w) => !w.queued);
  const queued = work.length - active.length;
  const groups = new Map();
  for (const w of active) groups.set(workIcon(w), (groups.get(workIcon(w)) ?? 0) + 1);
  const parts = [...groups].map(([icon, n]) => `${icon}${n}`);
  if (queued) parts.push(`🕓${queued} na fila`);
  return { n: active.length, queued, text: active.length > 1 || queued ? parts.join(" · ") : "" };
}
