// Execuções de hoje por agente (dia no fuso do Rio): quantas rodou, quantas
// terminaram bem, quantas falharam e quando foi a última. Lê `agent tasks` de
// todos os agentes em segundo plano (a cada REFRESH ms, em lotes) e conta na
// hora quando a leitura rápida vê um agente terminar uma tarefa.

const TZ = "America/Sao_Paulo";
const dayOf = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ }); // AAAA-MM-DD
const OK = new Set(["completed", "succeeded", "done"]);
const BAD = new Set(["failed", "error"]);

export function createToday({ multica, refreshMs = 5 * 60_000, batch = 6, limit = 30, now = () => Date.now() }) {
  let day = dayOf(now());
  let byAgent = new Map(); // agentId → { runs, ok, failed, lastAt }
  let reading = null;

  const empty = () => ({ runs: 0, ok: 0, failed: 0, lastAt: null });

  /** Conta as execuções de hoje a partir da lista de runs de um agente. */
  function countRuns(list) {
    const c = empty();
    for (const r of list) {
      const at = r.created_at ?? r.dispatched_at;
      if (!at || dayOf(at) !== day) continue;
      c.runs++;
      if (OK.has(r.status)) c.ok++;
      else if (BAD.has(r.status)) c.failed++;
      const end = r.completed_at ?? at;
      if (!c.lastAt || end > c.lastAt) c.lastAt = end;
    }
    return c;
  }

  /** Relê todos os agentes (uma leitura por vez). */
  function refresh(agentIds) {
    if (reading) return reading;
    reading = (async () => {
      day = dayOf(now());
      const next = new Map();
      for (let i = 0; i < agentIds.length; i += batch) {
        await Promise.all(
          agentIds.slice(i, i + batch).map(async (id) => {
            try {
              const res = await multica(["agent", "tasks", id, "--limit", String(limit)]);
              const list = Array.isArray(res) ? res : (res.tasks ?? res.runs ?? []);
              const c = countRuns(list);
              if (c.runs) next.set(id, c);
            } catch {
              if (byAgent.has(id)) next.set(id, byAgent.get(id)); // mantém o que já sabia
            }
          }),
        );
      }
      byAgent = next;
    })().finally(() => (reading = null));
    return reading;
  }

  /** A leitura rápida viu o agente terminar: conta já, sem esperar a próxima releitura. */
  function finished(agentId) {
    if (dayOf(now()) !== day) {
      day = dayOf(now());
      byAgent = new Map();
    }
    const c = byAgent.get(agentId) ?? empty();
    byAgent.set(agentId, { ...c, runs: c.runs + 1, lastAt: new Date(now()).toISOString() });
  }

  /** Contagem de hoje do agente (zeros se não trabalhou). */
  function of(agentId) {
    if (dayOf(now()) !== day) return empty(); // virou o dia e ainda não releu
    return byAgent.get(agentId) ?? empty();
  }

  /** Começa a reler periodicamente; getIds devolve os agentes atuais. */
  function start(getIds) {
    const tick = () => {
      const ids = getIds();
      if (ids.length) refresh(ids).catch(() => {});
    };
    setTimeout(tick, 3000);
    return setInterval(tick, refreshMs);
  }

  return { refresh, finished, of, start, countRuns };
}
