// Histórico e ações sobre os agentes, só para quem fez login.
//
// Login: uma senha de administrador, guardada como hash scrypt em
// ADMIN_PASSWORD_HASH ("scrypt$<sal hex>$<hash hex>"). Sem essa variável,
// tudo aqui responde 403 e o painel continua só de leitura.
// Sessão: cookie HttpOnly + SameSite=Strict assinado com HMAC; toda escrita
// exige também o cabeçalho X-Painel (barra CSRF de formulários de fora).

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmin } from "./admin.mjs";

const SESSION_HOURS = Number(process.env.SESSION_HOURS ?? 168); // 7 dias
const STATUSES = new Set(["todo", "in_progress", "in_review", "done", "blocked", "backlog", "cancelled"]);
const FOOTER = "\n\n---\n_Enviado pelo painel Escritório de Agentes._";

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}

function checkPassword(password, stored) {
  const [kind, saltHex, hashHex] = String(stored ?? "").split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = scryptSync(String(password ?? ""), Buffer.from(saltHex, "hex"), want.length);
  return timingSafeEqual(want, got);
}

/** Segredos que costumam aparecer em saídas de ferramentas. */
function redactSecrets(text) {
  return String(text ?? "")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[segredo]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AKIA)[-_A-Za-z0-9]{10,}/g, "[segredo]")
    .replace(/((?:password|senha|secret|token|api[_-]?key|client_secret)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, "$1[segredo]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[segredo]");
}

export function createActions({ multica, redact, onChange, onStart = () => {}, onScheduleStart = () => {}, acks, looks, meetings = null, history = null, manage = null, demo = false }) {
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const secret = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
  const failures = new Map(); // ip → { count, until }

  const sign = (value) => createHmac("sha256", secret).update(value).digest("hex");
  const clean = (t) => redactSecrets(redact(t));

  function sessionOk(req) {
    const m = /(?:^|;\s*)painel=([^;]+)/.exec(req.headers.cookie ?? "");
    if (!m) return false;
    const [exp, mac] = decodeURIComponent(m[1]).split(".");
    if (!exp || !mac || Number(exp) < Date.now()) return false;
    const want = Buffer.from(sign(exp));
    const got = Buffer.from(mac);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  function cookie(req, value, maxAge) {
    const secure = req.headers["x-forwarded-proto"] === "https" || process.env.COOKIE_SECURE === "1";
    return `painel=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > 256 * 1024) throw Object.assign(new Error("corpo grande demais"), { status: 413 });
      chunks.push(c);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  }

  /** Roda a CLI com um arquivo temporário (descrição/comentário) e apaga depois. */
  async function withTempFile(content, fn) {
    const dir = await mkdtemp(join(tmpdir(), "painel-"));
    const file = join(dir, "texto.md");
    try {
      await writeFile(file, content, "utf8");
      return await fn(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const issueSummary = (i) => ({ id: i.id, identifier: i.identifier, title: clean(i.title), status: i.status, updatedAt: i.updated_at });

  async function activity(agentId) {
    const [runs, issues] = await Promise.all([
      multica(["agent", "tasks", agentId, "--limit", "15"]),
      multica(["issue", "list", "--assignee-id", agentId, "--limit", "20", "--sort", "created_at", "--direction", "desc",
        "--fields", "id,identifier,title,status,updated_at"]),
    ]);
    const list = issues.issues ?? [];
    const byId = new Map(list.map((i) => [i.id, i]));
    const runRows = await Promise.all(
      (Array.isArray(runs) ? runs : []).map(async (r) => {
        let issue = r.issue_id ? byId.get(r.issue_id) : null;
        if (r.issue_id && !issue) {
          issue = await multica(["issue", "get", r.issue_id]).catch(() => null);
        }
        return {
          id: r.id,
          status: r.status,
          kind: r.kind,
          issue: issue ? issueSummary(issue) : null,
          by: r.attribution?.initiator?.name ?? null,
          createdAt: r.created_at,
          startedAt: r.started_at,
          completedAt: r.completed_at,
          error: r.error ? clean(typeof r.error === "string" ? r.error : JSON.stringify(r.error)).slice(0, 400) : null,
          acked: acks?.has(r.id) ?? false,
        };
      }),
    );
    return { runs: runRows, issues: list.map(issueSummary) };
  }

  async function messages(runId) {
    const raw = await multica(["issue", "run-messages", runId]);
    return (Array.isArray(raw) ? raw : []).slice(-150).map((m) => {
      if (m.type === "text") return { type: "text", seq: m.seq, at: m.created_at, text: clean(m.content).slice(0, 4000) };
      if (m.type === "tool_use") {
        const input = m.input?.command ?? m.input?.description ?? JSON.stringify(m.input ?? {});
        return { type: "tool", seq: m.seq, at: m.created_at, tool: m.tool, text: clean(input).slice(0, 600) };
      }
      if (m.type === "tool_result") return { type: "result", seq: m.seq, at: m.created_at, text: clean(m.output).slice(0, 1200) };
      return { type: m.type, seq: m.seq, at: m.created_at, text: "" };
    });
  }

  async function schedule(id) {
    const [got, runs] = await Promise.all([multica(["autopilot", "get", id]), multica(["autopilot", "runs", id])]);
    const ap = got.autopilot ?? got;
    const rows = (runs.runs ?? []).slice(0, 12);
    const issues = await Promise.all(
      rows.map((r) => (r.issue_id ? multica(["issue", "get", r.issue_id]).catch(() => null) : null)),
    );
    return {
      description: clean(ap.description ?? "").slice(0, 3000),
      titleTemplate: clean(ap.issue_title_template ?? ""),
      runs: rows.map((r, i) => ({
        id: r.id,
        status: r.status,
        source: r.source,
        at: r.triggered_at ?? r.created_at,
        completedAt: r.completed_at,
        failure: r.failure_reason ? clean(r.failure_reason).slice(0, 300) : null,
        acked: acks?.has(r.id) ?? false,
        issue: issues[i] ? issueSummary(issues[i]) : null,
      })),
    };
  }

  const ID = /^[0-9a-f-]{8,40}$/i;
  const admin = createAdmin({ multica, clean, readJson, send, withTempFile, issueSummary, onChange, onStart, acks, looks });

  /** Retorna true se tratou a requisição. */
  // O servidor usa isto para trancar o site inteiro atrás do login.
  handle.sessionOk = sessionOk;
  handle.enabled = Boolean(passwordHash);
  return handle;

  async function handle(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith("/api/") || path === "/api/office") return false;
    try {
      // Demonstração: tudo aberto para ver; a CLI simulada recusa qualquer escrita.
      if (path === "/api/me") return send(res, 200, demo ? { enabled: true, auth: true, demo: true } : { enabled: Boolean(passwordHash), auth: sessionOk(req) }), true;

      if (path === "/api/login" && req.method === "POST") {
        if (!passwordHash) return send(res, 403, { error: "Login não configurado no servidor." }), true;
        const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
        const f = failures.get(ip);
        if (f?.until > Date.now()) return send(res, 429, { error: "Muitas tentativas. Tente de novo em alguns minutos." }), true;
        const { password } = await readJson(req);
        if (!checkPassword(password, passwordHash)) {
          const count = (f?.count ?? 0) + 1;
          failures.set(ip, { count, until: count >= 5 ? Date.now() + 15 * 60_000 : 0 });
          await new Promise((r) => setTimeout(r, 600));
          return send(res, 401, { error: "Senha incorreta." }), true;
        }
        failures.delete(ip);
        const exp = String(Date.now() + SESSION_HOURS * 3600_000);
        return send(res, 200, { auth: true }, { "set-cookie": cookie(req, `${exp}.${sign(exp)}`, SESSION_HOURS * 3600) }), true;
      }

      if (path === "/api/logout" && req.method === "POST") {
        return send(res, 200, { auth: false }, { "set-cookie": cookie(req, "", 0) }), true;
      }

      if (!demo && (!passwordHash || !sessionOk(req))) return send(res, 401, { error: "Faça login." }), true;
      if (req.method !== "GET" && req.headers["x-painel"] !== "1") return send(res, 403, { error: "Requisição recusada." }), true;

      let m;
      if ((m = /^\/api\/agents\/([^/]+)\/activity$/.exec(path)) && req.method === "GET") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        return send(res, 200, await activity(m[1])), true;
      }
      if ((m = /^\/api\/runs\/([^/]+)\/messages$/.exec(path)) && req.method === "GET") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        return send(res, 200, { messages: await messages(m[1]) }), true;
      }
      if ((m = /^\/api\/schedules\/([^/]+)$/.exec(path)) && req.method === "GET") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        return send(res, 200, await schedule(m[1])), true;
      }
      if ((m = /^\/api\/schedules\/([^/]+)\/trigger$/.exec(path)) && req.method === "POST") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        await multica(["autopilot", "trigger", m[1]]);
        onScheduleStart(m[1]);
        return send(res, 200, { ok: true }), true;
      }
      if ((m = /^\/api\/schedules\/([^/]+)\/status$/.exec(path)) && req.method === "POST") {
        const { status } = await readJson(req);
        if (!ID.test(m[1]) || !["active", "paused"].includes(status)) return send(res, 400, { error: "status inválido" }), true;
        await multica(["autopilot", "update", m[1], "--status", status]);
        return send(res, 200, { ok: true }), true;
      }
      if ((m = /^\/api\/agents\/([^/]+)\/task$/.exec(path)) && req.method === "POST") {
        const { title, prompt } = await readJson(req);
        if (!ID.test(m[1]) || !String(title ?? "").trim() || !String(prompt ?? "").trim()) {
          return send(res, 400, { error: "Informe título e instruções." }), true;
        }
        const issue = await withTempFile(String(prompt) + FOOTER, (file) =>
          multica(["issue", "create", "--title", String(title).slice(0, 200), "--description-file", file, "--allow-external-file",
            "--assignee-id", m[1], "--status", "todo"]),
        );
        onStart(m[1], `${issue.identifier ?? ""} ${String(title).slice(0, 80)}`.trim());
        return send(res, 200, { issue: issueSummary(issue) }), true;
      }
      if ((m = /^\/api\/issues\/([^/]+)\/comment$/.exec(path)) && req.method === "POST") {
        const { text, agentId, agentName } = await readJson(req);
        if (!ID.test(m[1]) || !String(text ?? "").trim()) return send(res, 400, { error: "Escreva a instrução." }), true;
        // A menção é o que acorda o agente: comentário sem menção não dispara run.
        const mention = agentId && ID.test(agentId) ? `[@${String(agentName ?? "agente").replace(/[[\]]/g, "")}](mention://agent/${agentId}) ` : "";
        await withTempFile(mention + String(text) + FOOTER, (file) =>
          multica(["issue", "comment", "add", m[1], "--content-file", file, "--allow-external-file"]),
        );
        if (mention) onStart(agentId, "Respondendo comentário");
        return send(res, 200, { ok: true }), true;
      }
      if ((m = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path)) && req.method === "POST") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        await multica(["issue", "cancel-task", m[1]]);
        return send(res, 200, { ok: true }), true;
      }
      if ((m = /^\/api\/issues\/([^/]+)\/rerun$/.exec(path)) && req.method === "POST") {
        if (!ID.test(m[1])) return send(res, 400, { error: "id inválido" }), true;
        await multica(["issue", "rerun", m[1]]);
        return send(res, 200, { ok: true }), true;
      }
      if ((m = /^\/api\/issues\/([^/]+)\/status$/.exec(path)) && req.method === "POST") {
        const { status } = await readJson(req);
        if (!ID.test(m[1]) || !STATUSES.has(status)) return send(res, 400, { error: "status inválido" }), true;
        await multica(["issue", "status", m[1], status]);
        return send(res, 200, { ok: true }), true;
      }
      if (meetings && (await meetings.handle(req, res, path, { readJson, send, withTempFile }))) return true;
      if (history && (await history.handle(req, res, path, url, { send }))) return true;
      if (manage && (await manage.handle(req, res, path, url, { readJson, send }))) return true;
      if (await admin(req, res, path)) return true;
      return send(res, 404, { error: "rota desconhecida" }), true;
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${req.method} ${path}: ${e.message}`);
      const detail = clean(String(e.stderr || e.message)).split("\n").filter(Boolean).slice(-2).join(" ");
      return send(res, e.status ?? 500, { error: `Falhou: ${detail || "erro no Multica"}` }), true;
    }
  };
}
