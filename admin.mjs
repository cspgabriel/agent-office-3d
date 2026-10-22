// Administração pelo painel (só com login): editar agentes, skills, copiar,
// arquivar; conversa com o agente; chats do Multica; criar, editar e excluir
// tarefas agendadas e seus horários.
//
// Toda escrita passa pela CLI `multica`. Campos aceitos são uma lista
// fechada; segredos (env, MCP) não são lidos nem escritos por aqui.

const ID = /^[0-9a-f-]{8,40}$/i;
const THINKING = new Set(["", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CHAT_TITLE = "💬 Conversa pelo painel";
const FOOTER = "\n\n---\n_Enviado pelo painel Escritório de Agentes._";

export function createAdmin({ multica, clean, readJson, send, withTempFile, issueSummary, onChange, onStart = () => {}, acks, looks }) {
  const changed = () => Promise.resolve(onChange?.()).catch(() => {});
  const ok = (res, body = { ok: true }) => send(res, 200, body);
  const bad = (res, msg) => send(res, 400, { error: msg });

  // ---------- agentes ----------

  async function details(id) {
    const [a, runtimes, skills] = await Promise.all([
      multica(["agent", "get", id]),
      multica(["runtime", "list"]),
      multica(["skill", "list"]).catch(() => []),
    ]);
    const rts = Array.isArray(runtimes) ? runtimes : (runtimes.runtimes ?? []);
    const sk = Array.isArray(skills) ? skills : (skills.skills ?? []);
    return {
      agent: {
        id: a.id,
        name: a.name,
        description: a.description ?? "",
        instructions: a.instructions ?? "", // texto cru: só o administrador logado vê, para poder editar
        model: a.model ?? "",
        thinkingLevel: a.thinking_level ?? "",
        maxConcurrent: a.max_concurrent_tasks,
        permissionMode: a.permission_mode,
        visibility: a.visibility,
        runtimeId: a.runtime_id,
        status: a.status,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
        hasCustomEnv: Boolean(a.has_custom_env),
        envKeys: a.custom_env_key_count ?? 0,
        hasMcp: Boolean(a.mcp_config) || Boolean(a.mcp_config_redacted && a.mcp_config !== null),
        skills: (a.skills ?? []).map((s) => ({ id: s.id, name: s.name, enabled: s.enabled !== false })),
        starters: (a.conversation_starters ?? []).map((c) => ({ label: c.label, prompt: c.prompt })),
      },
      runtimes: rts.map((r) => ({ id: r.id, name: r.name, provider: r.provider, online: r.status === "online" })),
      workspaceSkills: sk.map((s) => ({ id: s.id, name: s.name, description: clean(s.description ?? "").slice(0, 200) })),
    };
  }

  async function updateAgent(id, body) {
    const args = ["agent", "update", id];
    const str = (k, flag, max) => {
      if (body[k] === undefined) return;
      const v = String(body[k]);
      if (v.length > max) throw Object.assign(new Error(`${k} grande demais`), { status: 400 });
      args.push(flag, v);
    };
    str("name", "--name", 120);
    str("description", "--description", 2000);
    str("instructions", "--instructions", 120_000);
    str("model", "--model", 120);
    if (body.thinkingLevel !== undefined) {
      if (!THINKING.has(body.thinkingLevel)) throw Object.assign(new Error("nível de raciocínio inválido"), { status: 400 });
      args.push("--thinking-level", body.thinkingLevel);
    }
    if (body.maxConcurrent !== undefined) {
      const n = Number(body.maxConcurrent);
      if (!Number.isInteger(n) || n < 1 || n > 50) throw Object.assign(new Error("concorrência deve ser de 1 a 50"), { status: 400 });
      args.push("--max-concurrent-tasks", String(n));
    }
    if (body.runtimeId !== undefined) {
      if (!ID.test(body.runtimeId)) throw Object.assign(new Error("runtime inválido"), { status: 400 });
      args.push("--runtime-id", body.runtimeId);
    }
    if (body.permission !== undefined) {
      if (body.permission === "workspace") args.push("--permission-mode", "public_to", "--public-to-workspace");
      else if (body.permission === "private") args.push("--permission-mode", "private");
      else throw Object.assign(new Error("permissão inválida"), { status: 400 });
    }
    if (args.length === 3) throw Object.assign(new Error("nada para salvar"), { status: 400 });
    await multica(args);
  }

  // ---------- conversa pelo painel (issue com comentários) ----------

  async function conversationIssue(agentId) {
    const res = await multica(["issue", "list", "--assignee-id", agentId, "--limit", "50", "--sort", "created_at", "--direction", "desc",
      "--fields", "id,identifier,title,status"]);
    return (res.issues ?? []).find((i) => i.title.startsWith(CHAT_TITLE) && i.status !== "cancelled") ?? null;
  }

  async function conversation(agentId) {
    const issue = await conversationIssue(agentId);
    if (!issue) return { issue: null, messages: [] };
    const [full, comments] = await Promise.all([
      multica(["issue", "get", issue.id]),
      multica(["issue", "comment", "list", issue.id, "--recent", "40"]),
    ]);
    const list = Array.isArray(comments) ? comments : (comments.comments ?? []);
    const strip = (t) => String(t ?? "").replace(/\[@[^\]]*\]\(mention:\/\/[^)]+\)\s*/g, "").replace(FOOTER, "").replace(/\n\n---\n_Enviado pelo painel[^_]*_\.?/g, "");
    const messages = [
      { role: "user", at: full.created_at, text: clean(strip(full.description)).slice(0, 8000) },
      ...list
        .filter((c) => c.type !== "system")
        .map((c) => ({ role: c.author_type === "agent" ? "agent" : "user", at: c.created_at, text: clean(strip(c.content)).slice(0, 8000) })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const runs = await multica(["issue", "runs", issue.id, "--active"]).catch(() => []);
    return { issue: issueSummary(full), messages, working: (Array.isArray(runs) ? runs : (runs.runs ?? [])).length > 0 };
  }

  async function sendMessage(agentId, agentName, text) {
    const issue = await conversationIssue(agentId);
    if (!issue) {
      // A primeira mensagem vira a descrição; atribuir ao agente já inicia a run.
      const created = await withTempFile(text + FOOTER, (file) =>
        multica(["issue", "create", "--title", `${CHAT_TITLE} — ${agentName}`.slice(0, 200), "--description-file", file,
          "--allow-external-file", "--assignee-id", agentId, "--status", "todo"]),
      );
      return issueSummary(created);
    }
    if (issue.status === "done" || issue.status === "in_review") await multica(["issue", "status", issue.id, "in_progress"]).catch(() => {});
    const mention = `[@${String(agentName).replace(/[[\]]/g, "")}](mention://agent/${agentId}) `;
    await withTempFile(mention + text + FOOTER, (file) => multica(["issue", "comment", "add", issue.id, "--content-file", file, "--allow-external-file"]));
    return issueSummary(issue);
  }

  // ---------- chats do Multica (só leitura: as respostas do agente) ----------

  async function chats(agentId) {
    const runs = await multica(["agent", "tasks", agentId, "--limit", "60"]);
    const sessions = new Map();
    for (const r of Array.isArray(runs) ? runs : []) {
      if (r.kind !== "chat") continue;
      const key = r.chat_session_id || r.id;
      const s = sessions.get(key) ?? { id: key, by: r.attribution?.initiator?.name ?? null, runs: [] };
      s.runs.push({ id: r.id, status: r.status, at: r.created_at, completedAt: r.completed_at });
      sessions.set(key, s);
    }
    return { sessions: [...sessions.values()].slice(0, 15) };
  }

  // ---------- tarefas agendadas ----------

  function cronOk(cron) {
    return /^[\d*/,\-]+(\s+[\d*/,\-]+){4}$/.test(String(cron ?? "").trim());
  }

  async function scheduleTriggers(id) {
    const res = await multica(["autopilot", "trigger-list", id]);
    return (res.triggers ?? []).map((t) => ({ id: t.id, kind: t.kind, cron: t.cron_expression, tz: t.timezone, enabled: t.enabled, nextRunAt: t.next_run_at }));
  }

  async function createSchedule(b) {
    if (!String(b.title ?? "").trim()) throw Object.assign(new Error("Informe o título."), { status: 400 });
    if (!ID.test(b.agentId ?? "")) throw Object.assign(new Error("Escolha o agente."), { status: 400 });
    if (!["create_issue", "run_only"].includes(b.mode)) throw Object.assign(new Error("Modo inválido."), { status: 400 });
    if (b.cron && !cronOk(b.cron)) throw Object.assign(new Error("Cron inválido (use 5 campos, ex.: 0 9 * * 1-5)."), { status: 400 });
    const args = ["autopilot", "create", "--title", String(b.title).slice(0, 200), "--agent", b.agentId, "--mode", b.mode,
      "--description", String(b.description ?? "").slice(0, 20000)];
    if (b.mode === "create_issue" && b.titleTemplate) args.push("--issue-title-template", String(b.titleTemplate).slice(0, 200));
    const created = await multica(args);
    const ap = created.autopilot ?? created;
    if (b.cron) await multica(["autopilot", "trigger-add", ap.id, "--kind", "schedule", "--cron", b.cron.trim(), "--timezone", b.tz || "America/Sao_Paulo"]);
    return { id: ap.id };
  }

  async function updateSchedule(id, b) {
    const args = ["autopilot", "update", id];
    if (b.title !== undefined) args.push("--title", String(b.title).slice(0, 200));
    if (b.description !== undefined) args.push("--description", String(b.description).slice(0, 20000));
    if (b.agentId !== undefined) {
      if (!ID.test(b.agentId)) throw Object.assign(new Error("agente inválido"), { status: 400 });
      args.push("--agent", b.agentId);
    }
    if (b.mode !== undefined) {
      if (!["create_issue", "run_only"].includes(b.mode)) throw Object.assign(new Error("modo inválido"), { status: 400 });
      args.push("--mode", b.mode);
    }
    if (b.titleTemplate !== undefined) args.push("--issue-title-template", String(b.titleTemplate).slice(0, 200));
    if (args.length > 3) await multica(args);
  }

  /** Retorna true se tratou a rota (o chamador já validou login e CSRF). */
  return async function handle(req, res, path) {
    let m;
    const POST = req.method === "POST";

    if ((m = /^\/api\/agents\/([^/]+)\/details$/.exec(path)) && !POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      return ok(res, await details(m[1])), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/update$/.exec(path)) && POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      await updateAgent(m[1], await readJson(req));
      await changed();
      return ok(res), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/skills$/.exec(path)) && POST) {
      const { skillIds } = await readJson(req);
      if (!ID.test(m[1]) || !Array.isArray(skillIds) || !skillIds.every((s) => ID.test(s))) return bad(res, "skills inválidas"), true;
      await multica(["agent", "skills", "set", m[1], "--skill-ids", skillIds.join(",")]);
      return ok(res), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/(archive|restore)$/.exec(path)) && POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      await multica(["agent", m[2], m[1]]);
      await changed();
      return ok(res), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/copy$/.exec(path)) && POST) {
      const { name, runtimeId } = await readJson(req);
      if (!ID.test(m[1]) || (runtimeId && !ID.test(runtimeId))) return bad(res, "dados inválidos"), true;
      const args = ["agent", "copy", m[1]];
      if (name) args.push("--name", String(name).slice(0, 120));
      if (runtimeId) args.push("--runtime-id", runtimeId, "--model", "");
      const copy = await multica(args);
      await changed();
      return ok(res, { id: copy.id, name: copy.name }), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/conversation$/.exec(path))) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      if (!POST) return ok(res, await conversation(m[1])), true;
      const { text, agentName } = await readJson(req);
      if (!String(text ?? "").trim()) return bad(res, "Escreva a mensagem."), true;
      const issue = await sendMessage(m[1], agentName ?? "agente", String(text).slice(0, 20000));
      onStart(m[1], "💬 Conversa pelo painel");
      return ok(res, { issue }), true;
    }
    if ((m = /^\/api\/agents\/([^/]+)\/chats$/.exec(path)) && !POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      return ok(res, await chats(m[1])), true;
    }

    // Visual do agente no escritório (uniforme, pele, cabelo).
    if ((m = /^\/api\/agents\/([^/]+)\/look$/.exec(path)) && POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      const b = await readJson(req);
      const OUT = ["liso", "hotel", "social", "terno", "recepcao", "chef", "esporte", "verao", "flamengo"];
      const color = (v) => (Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : undefined);
      if (b.reset) await looks.set(m[1], null);
      else {
        if (!OUT.includes(b.outfit)) return bad(res, "uniforme inválido"), true;
        await looks.set(m[1], { outfit: b.outfit, skin: color(b.skin), hair: color(b.hair) });
      }
      await changed();
      return ok(res), true;
    }

    // Arquivar (ou desarquivar) uma falha: tira a pendência do painel.
    if (path === "/api/acks" && POST) {
      const { id, ack } = await readJson(req);
      if (!ID.test(id ?? "")) return bad(res, "id inválido"), true;
      await acks.set(id, ack !== false);
      await changed();
      return ok(res), true;
    }

    if (path === "/api/schedules" && POST) {
      const out = await createSchedule(await readJson(req));
      await changed();
      return ok(res, out), true;
    }
    if ((m = /^\/api\/schedules\/([^/]+)\/update$/.exec(path)) && POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      await updateSchedule(m[1], await readJson(req));
      await changed();
      return ok(res), true;
    }
    if ((m = /^\/api\/schedules\/([^/]+)\/delete$/.exec(path)) && POST) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      await multica(["autopilot", "delete", m[1]], { json: false });
      await changed();
      return ok(res), true;
    }
    if ((m = /^\/api\/schedules\/([^/]+)\/triggers$/.exec(path))) {
      if (!ID.test(m[1])) return bad(res, "id inválido"), true;
      if (!POST) return ok(res, { triggers: await scheduleTriggers(m[1]) }), true;
      const { cron, tz } = await readJson(req);
      if (!cronOk(cron)) return bad(res, "Cron inválido (5 campos, ex.: 0 9 * * 1-5)."), true;
      await multica(["autopilot", "trigger-add", m[1], "--kind", "schedule", "--cron", cron.trim(), "--timezone", tz || "America/Sao_Paulo"]);
      await changed();
      return ok(res), true;
    }
    if ((m = /^\/api\/schedules\/([^/]+)\/triggers\/([^/]+)(\/delete)?$/.exec(path)) && POST) {
      if (!ID.test(m[1]) || !ID.test(m[2])) return bad(res, "id inválido"), true;
      if (m[3]) await multica(["autopilot", "trigger-delete", m[1], m[2]], { json: false });
      else {
        const { cron, tz, enabled } = await readJson(req);
        const args = ["autopilot", "trigger-update", m[1], m[2]];
        if (cron !== undefined) {
          if (!cronOk(cron)) return bad(res, "Cron inválido."), true;
          args.push("--cron", cron.trim());
        }
        if (tz) args.push("--timezone", tz);
        if (enabled !== undefined) args.push(`--enabled=${Boolean(enabled)}`);
        await multica(args);
      }
      await changed();
      return ok(res), true;
    }
    return false;
  };
}
