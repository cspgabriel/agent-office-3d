// Gestão de issues pelo painel: tudo sobre uma issue numa leitura só (dados,
// comentários, execuções, linha do tempo e consumo) e as ações de gestão
// (atribuir, prioridade, status em lote, busca). Comentar, mudar status de
// uma issue, rodar de novo e cancelar execução já existem em actions.mjs.

const ID = /^[0-9a-f-]{8,40}$/i;
const KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/; // identificador (ex.: TASK-1452)
const STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);
const PRIORITIES = new Set(["none", "low", "medium", "high", "urgent"]);
const MAX_BULK = 50;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Menções `[@Nome](mention://agent/id)` viram "@Nome" para leitura. */
const plain = (s) => String(s ?? "").replace(/\[@([^\]]+)\]\(mention:\/\/[^)]+\)/g, "@$1");

export function createManage({ multica, redact }) {
  const text = (s, n) => redact(plain(s)).slice(0, n);
  const list = (res, key) => (Array.isArray(res) ? res : (res?.[key] ?? []));

  /** Tudo de uma issue para o painel de gestão. */
  async function detail(ref) {
    const [issue, comments, runs, timeline, usage] = await Promise.all([
      multica(["issue", "get", ref]),
      multica(["issue", "comment", "list", ref, "--compact"]).catch(() => []),
      multica(["issue", "runs", ref]).catch(() => []),
      multica(["issue", "timeline", ref]).catch(() => []),
      multica(["issue", "usage", ref]).catch(() => null),
    ]);
    return {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: text(issue.title, 300),
        description: text(issue.description, 6000),
        status: issue.status,
        priority: issue.priority,
        assigneeType: issue.assignee_type ?? null,
        assignee: issue.assignee_id ?? null,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        dueDate: issue.due_date ?? null,
      },
      comments: list(comments, "comments")
        .filter((c) => c.type !== "system")
        .slice(-40)
        .map((c) => ({ id: c.id, at: c.created_at, authorType: c.author_type, author: c.author_id, text: text(c.content, 4000) })),
      runs: list(runs, "runs")
        .slice(0, 20)
        .map((r) => ({
          id: r.id,
          agentId: r.agent_id,
          kind: r.kind,
          status: r.status,
          createdAt: r.created_at,
          startedAt: r.started_at ?? r.dispatched_at ?? null,
          completedAt: r.completed_at ?? null,
          error: text(r.failure_reason ?? (typeof r.error === "string" ? r.error : r.error?.message), 300) || null,
          trigger: text(r.trigger_summary, 200) || null,
        })),
      timeline: list(timeline, "timeline")
        .filter((e) => e.type === "activity")
        .slice(-30)
        .map((e) => ({ at: e.created_at, action: e.action, actor: text(e.actor_name ?? e.actor_type, 80), to: e.details?.to ? text(e.details.to, 60) : null })),
      usage: usage
        ? { runs: usage.task_count ?? 0, input: usage.total_input_tokens ?? 0, output: usage.total_output_tokens ?? 0, cacheRead: usage.total_cache_read_tokens ?? 0 }
        : null,
    };
  }

  async function assign(ref, body) {
    if (!body || !("agentId" in body)) throw bad("Informe o agente (ou null para tirar o responsável).");
    const { agentId } = body;
    if (agentId === null) return multica(["issue", "assign", ref, "--unassign"]);
    if (!ID.test(agentId ?? "")) throw bad("Agente inválido.");
    return multica(["issue", "assign", ref, "--to-id", agentId]);
  }

  async function priority(ref, p) {
    if (!PRIORITIES.has(p)) throw bad("Prioridade inválida.");
    return multica(["issue", "update", ref, "--priority", p]);
  }

  async function edit(ref, { title, dueDate }) {
    const args = ["issue", "update", ref];
    if (title !== undefined) {
      const t = String(title).trim();
      if (!t || t.length > 200) throw bad("Título vazio ou longo demais.");
      args.push("--title", t);
    }
    if (dueDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate ?? "")) throw bad("Prazo inválido (AAAA-MM-DD).");
      args.push("--due-date", dueDate);
    }
    if (args.length === 3) throw bad("Nada para alterar.");
    return multica(args);
  }

  /** Mesmo status para várias issues; devolve quais deram certo e quais falharam. */
  async function bulkStatus(ids, status) {
    if (!STATUSES.has(status)) throw bad("Status inválido.");
    if (!Array.isArray(ids)) throw bad("Nenhuma issue selecionada.");
    const refs = [...new Set(ids)].filter((x) => ID.test(x) || KEY.test(x));
    if (!refs.length) throw bad("Nenhuma issue selecionada.");
    if (refs.length > MAX_BULK) throw bad(`No máximo ${MAX_BULK} issues por vez.`);
    const ok = [], failed = [];
    for (let i = 0; i < refs.length; i += 5) {
      await Promise.all(
        refs.slice(i, i + 5).map((ref) =>
          multica(["issue", "status", ref, status], { json: false }).then(() => ok.push(ref), () => failed.push(ref)),
        ),
      );
    }
    return { ok, failed };
  }

  /** Busca em títulos, descrições e comentários. */
  async function search(q) {
    const query = String(q ?? "").trim().slice(0, 200);
    if (query.length < 2) throw bad("Digite pelo menos 2 letras.");
    if (query.startsWith("-")) throw bad("A busca não pode começar com “-”.");
    const res = await multica(["issue", "search", query, "--limit", "50", "--include-closed"]);
    return list(res, "issues").map((i) => ({
      id: i.id,
      identifier: i.identifier,
      title: text(i.title, 300),
      status: i.status,
      assignee: i.assignee_type === "agent" ? i.assignee_id : null,
      match: i.match_source ?? null,
      createdAt: i.created_at ?? null,
      activityAt: i.last_activity_at ?? i.updated_at ?? i.created_at,
    }));
  }

  /** Rotas /api/manage/*. Retorna true se tratou. */
  async function handle(req, res, path, url, { readJson, send }) {
    if (!path.startsWith("/api/manage/")) return false;
    const POST = req.method === "POST";
    let m;
    if ((m = /^\/api\/manage\/issues\/([^/]+)$/.exec(path)) && !POST) {
      if (!ID.test(m[1]) && !KEY.test(m[1])) throw bad("Issue inválida.");
      return send(res, 200, await detail(m[1])), true;
    }
    if ((m = /^\/api\/manage\/issues\/([^/]+)\/edit$/.exec(path)) && POST) {
      if (!ID.test(m[1]) && !KEY.test(m[1])) throw bad("Issue inválida.");
      await edit(m[1], await readJson(req));
      return send(res, 200, { ok: true }), true;
    }
    if ((m = /^\/api\/manage\/issues\/([^/]+)\/(assign|priority)$/.exec(path)) && POST) {
      if (!ID.test(m[1]) && !KEY.test(m[1])) throw bad("Issue inválida.");
      const body = await readJson(req);
      if (m[2] === "assign") await assign(m[1], body);
      else await priority(m[1], body.priority);
      return send(res, 200, { ok: true }), true;
    }
    if (path === "/api/manage/bulk-status" && POST) {
      const { ids, status } = await readJson(req);
      return send(res, 200, await bulkStatus(ids, status)), true;
    }
    if (path === "/api/manage/search" && !POST) return send(res, 200, { issues: await search(url.searchParams.get("q")) }), true;
    return false;
  }

  return { handle };
}
