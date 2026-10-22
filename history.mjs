// Histórico: últimas execuções dos agentes, execuções das tarefas agendadas e
// todas as issues em ordem de atividade. Lido sob demanda (só quando alguém
// abre a aba) e guardado em cache por 1–2 minutos para não pesar na CLI.

const short = (v, n = 280) => {
  if (v == null) return null;
  const s = typeof v === "string" ? v : (v.message ?? v.error ?? JSON.stringify(v));
  return String(s).replace(/\s+/g, " ").trim().slice(0, n) || null;
};

export function createHistory({ multica, redact, getSnapshot }) {
  const cache = new Map(); // chave → { at, value, pending }

  let lastAccess = 0;
  /**
   * Cache por ttl ms; chamadas simultâneas esperam a mesma leitura. Vencido, devolve o
   * valor guardado na hora e relê em segundo plano (só espera quem ainda não tem nada).
   */
  async function memo(key, ttl, fn, fresh = false) {
    const hit = cache.get(key);
    if (hit?.pending && !("value" in hit)) return hit.pending;
    if (hit && "value" in hit && !fresh && (Date.now() - hit.at < ttl || hit.pending)) {
      if (!hit.pending && Date.now() - hit.at >= ttl) refresh(key, fn);
      return hit.value;
    }
    if (hit && "value" in hit && !fresh) {
      refresh(key, fn);
      return hit.value;
    }
    return refresh(key, fn);
  }
  function refresh(key, fn) {
    const hit = cache.get(key);
    if (hit?.pending) return hit.pending;
    const pending = fn((partial) => {
      // Resultado parcial (ex.: agentes mais ativos primeiro) já serve quem está esperando.
      const cur = cache.get(key);
      cache.set(key, { ...cur, at: Date.now(), value: partial });
    })
      .then((value) => (cache.set(key, { at: Date.now(), value }), value))
      .catch((e) => {
        const cur = cache.get(key);
        if (cur && "value" in cur) cache.set(key, { at: cur.at, value: cur.value });
        else cache.delete(key);
        throw e;
      });
    cache.set(key, { ...hit, pending });
    return pending;
  }

  /** Lotes de n chamadas por vez (a CLI é um processo por chamada). */
  async function batched(items, n, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map((x) => fn(x).catch(() => [])))));
    return out;
  }

  const FIELDS = "id,identifier,title,status,priority,assignee_type,assignee_id,created_at,updated_at,last_activity_at";
  async function issues(fresh, pages = 3) {
    return memo(pages === 3 ? "issues" : `issues:${pages}`, 60_000, async () => {
      const all = [];
      for (let page = 0; page < pages; page++) {
        const res = await multica(["issue", "list", "--limit", "100", "--offset", String(page * 100), "--sort", "created_at", "--direction", "desc", "--fields", FIELDS]);
        all.push(...(res.issues ?? []));
        if (!res.has_more) break;
      }
      return all
        .map((i) => ({
          id: i.id,
          identifier: i.identifier,
          title: redact(i.title),
          status: i.status,
          priority: i.priority,
          assignee: i.assignee_type === "agent" ? i.assignee_id : null,
          assigneeType: i.assignee_type ?? null,
          createdAt: i.created_at,
          activityAt: i.last_activity_at ?? i.updated_at ?? i.created_at,
        }))
        .sort((a, b) => String(b.activityAt).localeCompare(String(a.activityAt)));
    }, fresh);
  }

  async function runs(fresh) {
    const hit = cache.get("runs");
    // Primeira leitura: devolve assim que os agentes mais ativos chegarem.
    if (!fresh && !(hit && "value" in hit)) {
      let first, fail;
      const ready = new Promise((r, j) => ((first = r), (fail = j)));
      memo("runs", 120_000, (partial) => readRuns((v) => (partial(v), first(v)))).then(first, fail);
      return ready;
    }
    return memo("runs", 120_000, (partial) => readRuns(partial), fresh);
  }

  const notReady = () => Object.assign(new Error("O painel ainda está carregando os dados do Multica. Tente de novo em alguns segundos."), { status: 503 });

  async function readRuns(partial = () => {}) {
    if (!getSnapshot()) throw notReady();
    {
      // Ordem: quem está trabalhando, depois por atividade recente nas issues, depois o resto.
      const snap = getSnapshot()?.agents ?? [];
      const recent = new Map();
      for (const i of await issues().catch(() => [])) if (i.assignee && !recent.has(i.assignee)) recent.set(i.assignee, i.activityAt);
      const agents = snap
        .map((a) => ({ id: a.id, w: a.state === "working" ? "9" : (recent.get(a.id) ?? "0") }))
        .sort((a, b) => b.w.localeCompare(a.w))
        .map((a) => a.id);
      const fetchOne = async (id) => {
        const res = await multica(["agent", "tasks", id, "--limit", "6"]);
        return (Array.isArray(res) ? res : (res.tasks ?? res.runs ?? [])).map((r) => ({
          id: r.id,
          agentId: r.agent_id ?? id,
          kind: r.kind,
          status: r.status,
          createdAt: r.created_at,
          startedAt: r.dispatched_at ?? r.started_at ?? null,
          completedAt: r.completed_at ?? null,
          error: redact(short(r.error)),
          issueId: r.issue_id ?? null,
          by: r.attribution?.initiator?.name ?? null,
        }));
      };
      const byIssue = new Map((await issues().catch(() => [])).map((i) => [i.id, i]));
      const finish = (lists) => lists
        .flat()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 250)
        .map((r) => {
          const i = r.issueId && byIssue.get(r.issueId);
          return i ? { ...r, issue: { identifier: i.identifier, title: i.title, status: i.status } } : r;
        });
      const head = await batched(agents.slice(0, 24), 8, fetchOne);
      partial(finish(head));
      const rest = await batched(agents.slice(24), 6, fetchOne);
      return finish([...head, ...rest]);
    }
  }

  async function scheduleRuns(fresh) {
    return memo("schedules", 120_000, async () => {
      if (!getSnapshot()) throw notReady();
      const scheds = getSnapshot()?.schedules ?? [];
      const lists = await batched(scheds, 8, async (s) => {
        const res = await multica(["autopilot", "runs", s.id, "--limit", "8"]);
        return (res.runs ?? []).map((r) => ({
          id: r.id,
          scheduleId: s.id,
          title: s.title,
          agentId: s.agentId,
          status: r.status,
          source: r.source,
          at: r.triggered_at ?? r.created_at,
          completedAt: r.completed_at ?? null,
          failure: redact(short(r.failure_reason)),
          issueId: r.issue_id ?? null,
        }));
      });
      return lists.flat().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
    }, fresh);
  }

  /** Rotas /api/history/*. Retorna true se tratou. */
  async function handle(req, res, path, url, { send }) {
    if (req.method !== "GET" || !path.startsWith("/api/history/")) return false;
    const fresh = url.searchParams.get("refresh") === "1";
    lastAccess = Date.now();
    const kind = path.slice("/api/history/".length);
    if (kind === "issues") {
      const pages = Math.min(20, Math.max(3, Number(url.searchParams.get("pages")) || 3));
      const list = await issues(fresh, pages);
      return send(res, 200, { issues: list, more: list.length >= pages * 100 }), true;
    }
    if (kind === "runs") return send(res, 200, { runs: await runs(fresh) }), true;
    if (kind === "schedules") return send(res, 200, { runs: await scheduleRuns(fresh) }), true;
    return false;
  }

  // Enquanto alguém usa o Histórico (últimos 20 min), mantém execuções e agendadas aquecidas.
  setInterval(() => {
    if (Date.now() - lastAccess > 20 * 60_000) return;
    runs().catch(() => {});
    scheduleRuns().catch(() => {});
  }, 150_000).unref();

  /** Lê tudo uma vez em segundo plano (chamado quando o painel termina de carregar). */
  function warm() {
    issues()
      .then(() => scheduleRuns())
      .then(() => runs())
      .catch(() => {});
  }

  return { handle, warm };
}
