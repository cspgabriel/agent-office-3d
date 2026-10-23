// O que um agente está fazendo agora, quando pode ser mais de uma coisa:
// chats (💬), tarefas/issues (📋), agendadas (⏰) e o que está na fila (🕓).

const ICON = { chat: "💬", autopilot: "⏰", schedule: "⏰" };

/** Ícone de uma execução em andamento. */
export const workIcon = (w) => (w.queued ? "🕓" : ICON[w.kind] ?? (w.kind === "starting" ? "▶️" : "📋"));

/** Texto curto de uma execução: "TASK-12 · título" ou "Chat com Ana". */
export function workTitle(w) {
  if (w.issue) return `${w.issue.identifier} · ${w.issue.title}`;
  return w.label ?? (w.kind === "chat" ? "Chat" : (w.kind ?? "execução"));
}

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
