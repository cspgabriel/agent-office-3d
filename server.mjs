// Escritório de Agentes — servidor local.
// Lê o workspace Multica pela CLI (`multica ... --output json`) a cada
// POLL_SECONDS e serve um snapshot sanitizado em /api/office, mais o
// frontend estático de ./public. Sem dependências: só Node 20+.
//
// Sem login, só expõe nome, avatar, descrição, status, máquina e a issue
// atual de cada agente. Histórico e ações ficam em actions.mjs, atrás de
// login. Instruções, env, MCP e skills nunca saem do servidor.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createActions, hashPassword } from "./actions.mjs";
import { createMeetings } from "./meetings.mjs";
import { createHistory } from "./history.mjs";
import { createManage } from "./manage.mjs";
import { createDemoCli, demoMeetings } from "./demo.mjs";

// `node server.mjs --hash-password 'senha'` imprime o valor de ADMIN_PASSWORD_HASH.
if (process.argv[2] === "--hash-password") {
  console.log(hashPassword(process.argv[3] ?? ""));
  process.exit(0);
}

const PORT = Number(process.env.PORT ?? 3050);
const HOST = process.env.HOST ?? "127.0.0.1";
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 30);
// Leitura leve (só `agent list`) para o status mudar em segundos, não em meio minuto.
const FAST_SECONDS = Number(process.env.FAST_SECONDS ?? 2);
const MULTICA = process.env.MULTICA_BIN ?? "multica";
// DEMO=1: agentes fictícios de uma CLI simulada (para conhecer o painel sem um workspace Multica).
const DEMO = process.env.DEMO === "1";
const demoCli = DEMO ? createDemoCli() : null;
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
// Marca configurável: cada instalação define nome e logo (BRAND_NAME, BRAND_LOGO).
const BRAND_NAME = process.env.BRAND_NAME ?? "";
const BRAND_LOGO = process.env.BRAND_LOGO ?? "";
function brand(body, file) {
  if (!BRAND_NAME && !BRAND_LOGO) return body;
  if (!/\.(html|js)$/.test(file)) return body;
  let s = body.toString("utf8");
  if (BRAND_NAME) s = s.replaceAll("Agent Office", BRAND_NAME).replaceAll("AGENT OFFICE", BRAND_NAME.toUpperCase());
  if (BRAND_LOGO) s = s.replaceAll("/brand/logo.svg", BRAND_LOGO);
  return Buffer.from(s, "utf8");
}
const LOGIN_PAGE = fileURLToPath(new URL("./login.html", import.meta.url));
const ROBOTS = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const LOOK_FILE = process.env.LOOK_FILE ?? fileURLToPath(new URL("./data/looks.json", import.meta.url));
// Visual (uniforme, pele, cabelo) por agente, escolhido no painel.
const looks = {
  map: {}, // cada instalação guarda o seu em data/looks.json
  async load() {
    try {
      this.map = JSON.parse(await readFile(LOOK_FILE, "utf8"));
    } catch {}
  },
  get(id) {
    return this.map[id] ?? null;
  },
  async set(id, look) {
    if (look) this.map[id] = look;
    else delete this.map[id];
    await mkdir(dirname(LOOK_FILE), { recursive: true });
    await writeFile(LOOK_FILE, JSON.stringify(this.map, null, 1));
  },
};
const MEETING_FILE = process.env.MEETING_FILE ?? fileURLToPath(new URL("./data/meetings.json", import.meta.url));
const ACK_FILE = process.env.ACK_FILE ?? fileURLToPath(new URL("./data/acks.json", import.meta.url));

// Falhas "arquivadas" pelo painel. O Multica não tem como arquivar uma run,
// então o painel guarda quais falhas já foram vistas/tratadas.
const acks = {
  ids: new Map(), // id da run → { at }
  async load() {
    try {
      const raw = JSON.parse(await readFile(ACK_FILE, "utf8"));
      this.ids = new Map(Object.entries(raw.runs ?? {}));
    } catch {}
  },
  has(id) {
    return this.ids.has(id);
  },
  async set(id, on) {
    if (on) this.ids.set(id, { at: new Date().toISOString() });
    else this.ids.delete(id);
    await mkdir(dirname(ACK_FILE), { recursive: true });
    await writeFile(ACK_FILE, JSON.stringify({ runs: Object.fromEntries(this.ids) }, null, 1));
  },
};

/** Roda a CLI. Alguns comandos (delete) não aceitam --output: passe { json: false }. */
function multica(args, { json = true } = {}) {
  if (DEMO) return demoCli(args);
  return new Promise((resolve, reject) => {
    execFile(
      MULTICA,
      [...(process.env.MULTICA_WORKSPACE_ID ? ["--workspace-id", process.env.MULTICA_WORKSPACE_ID] : []), ...(json ? [...args, "--output", "json"] : args)],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stderr }));
        if (!json) return resolve(stdout);
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`JSON inválido de multica ${args.join(" ")}: ${e.message}`));
        }
      },
    );
  });
}

// "Claude (Studio-Mac)" → "Studio-Mac"
function machineOf(runtime) {
  const m = /\(([^)]+)\)\s*$/.exec(runtime?.name ?? "");
  return m ? m[1] : runtime?.custom_name || runtime?.name || "Sem máquina";
}

// O painel pode ficar público: e-mails e telefones citados em títulos de
// issues ou descrições viram "f***@dominio" e "(telefone)".
function redact(text) {
  return String(text ?? "")
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2")
    .replace(/(?:\+?55[\s-]?)?\(?\b\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}\b/g, "(telefone)");
}

function emojiOf(avatarUrl) {
  return avatarUrl?.startsWith("emoji:") ? avatarUrl.slice(6) : "🤖";
}

const issueCache = new Map(); // id → { at, issue }
async function issueById(id) {
  const hit = issueCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.issue;
  const full = await multica(["issue", "get", id]);
  const issue = { identifier: full.identifier, title: redact(full.title), status: full.status };
  issueCache.set(id, { at: Date.now(), issue });
  return issue;
}

async function currentWork(agentId) {
  const runs = await multica(["agent", "tasks", agentId, "--limit", "5"]);
  const list = Array.isArray(runs) ? runs : (runs.tasks ?? runs.runs ?? []);
  const running = list.filter((r) => r.status === "running" || r.status === "dispatched");
  return Promise.all(
    running.map(async (r) => {
      const base = { kind: r.kind, startedAt: r.started_at ?? r.created_at };
      if (r.issue_id) {
        try {
          return { ...base, issue: await issueById(r.issue_id) };
        } catch {
          return base;
        }
      }
      const who = r.attribution?.initiator?.name;
      return { ...base, label: r.kind === "chat" ? `Chat${who ? ` com ${who}` : ""}` : r.kind };
    }),
  );
}

let squadCache = { at: 0, byAgent: new Map() };
/** agente → nome do squad (cache de 5 min; squads mudam pouco). */
async function squadsByAgent() {
  if (Date.now() - squadCache.at < 5 * 60_000) return squadCache.byAgent;
  const squads = await multica(["squad", "list"]);
  const byAgent = new Map();
  for (const sq of squads.filter((q) => !q.archived_at)) {
    const members = await multica(["squad", "member", "list", sq.id]);
    for (const m of members) {
      if (m.member_type === "agent" && !byAgent.has(m.member_id)) {
        byAgent.set(m.member_id, { name: sq.name, leader: m.role === "leader" });
      }
    }
  }
  squadCache = { at: Date.now(), byAgent };
  return byAgent;
}

const triggerCache = new Map(); // autopilot → { at, triggers }
/** Crons das tarefas agendadas (cache de 10 min; mudam pouco). */
async function triggersOf(id) {
  const hit = triggerCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.triggers;
  const res = await multica(["autopilot", "trigger-list", id]);
  const triggers = (res.triggers ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({ kind: t.kind, cron: t.cron_expression ?? null, tz: t.timezone ?? null, nextRunAt: t.next_run_at ?? null }));
  triggerCache.set(id, { at: Date.now(), triggers });
  return triggers;
}

const lastRunCache = new Map(); // autopilot → { at, last }
/** Última execução (para colorir os quiosques); cache de 5 min. */
async function lastRunOf(id) {
  const hit = lastRunCache.get(id);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.last;
  const res = await multica(["autopilot", "runs", id]);
  const r = (res.runs ?? [])[0];
  const last = r ? { id: r.id, status: r.status, at: r.triggered_at ?? r.created_at } : null;
  lastRunCache.set(id, { at: Date.now(), last });
  return last;
}

async function buildSchedules() {
  const res = await multica(["autopilot", "list"]);
  const list = res.autopilots ?? [];
  const out = [];
  // Em lotes de 6 para não abrir 35 processos da CLI de uma vez.
  for (let i = 0; i < list.length; i += 6) {
    const batch = list.slice(i, i + 6);
    const [triggers, lasts] = await Promise.all([
      Promise.all(batch.map((a) => triggersOf(a.id).catch(() => []))),
      Promise.all(batch.map((a) => lastRunOf(a.id).catch(() => null))),
    ]);
    batch.forEach((a, k) =>
      out.push({
        id: a.id,
        title: redact(a.title),
        agentId: a.assignee_type === "agent" ? a.assignee_id : null,
        status: a.status,
        mode: a.execution_mode,
        nextRunAt: a.next_run_at,
        lastRunAt: a.last_run_at,
        triggers: triggers[k],
        lastRun: lasts[k] ? { ...lasts[k], acked: acks.has(lasts[k].id) } : null,
      }),
    );
  }
  return out.sort((a, b) => (a.nextRunAt ?? "9").localeCompare(b.nextRunAt ?? "9"));
}

async function buildSnapshot() {
  const [agents, runtimesRaw, blockedRaw, squads, , schedules] = await Promise.all([
    multica(["agent", "list"]),
    multica(["runtime", "list"]),
    multica(["issue", "list", "--status", "blocked", "--limit", "100", "--fields", "id,identifier,title,assignee_type,assignee_id"]),
    squadsByAgent().catch(() => new Map()),
    meetings.refresh().catch(() => {}),
    buildSchedules().catch((e) => {
      console.error(`agendadas: ${e.message}`);
      return snapshot?.schedules ?? [];
    }),
  ]);
  const runtimes = Array.isArray(runtimesRaw) ? runtimesRaw : (runtimesRaw.runtimes ?? []);
  const runtimeById = new Map(runtimes.map((r) => [r.id, r]));
  const blocked = (blockedRaw.issues ?? []).filter((i) => i.assignee_type === "agent");

  const active = agents.filter((a) => !a.archived_at);
  const work = new Map(
    await Promise.all(
      active
        .filter((a) => a.status === "working")
        .map(async (a) => [a.id, await currentWork(a.id).catch(() => [])]),
    ),
  );

  const machines = new Map();
  for (const rt of runtimes) {
    const name = machineOf(rt);
    const m = machines.get(name) ?? { name, online: false, providers: [] };
    m.online ||= rt.status === "online";
    m.providers.push({ provider: rt.provider, online: rt.status === "online" });
    machines.set(name, m);
  }

  const out = active.map((a) => {
    const rt = runtimeById.get(a.runtime_id);
    const myBlocked = blocked
      .filter((i) => i.assignee_id === a.id)
      .map(({ id, identifier, title }) => ({ id, identifier, title: redact(title) }));
    const online = rt?.status === "online";
    let state = "idle";
    if (a.status === "working") state = "working";
    else if (myBlocked.length) state = "blocked";
    else if (!online) state = "offline";
    return {
      id: a.id,
      name: a.name,
      emoji: emojiOf(a.avatar_url),
      description: redact(a.description),
      state,
      provider: rt?.provider ?? "?",
      machine: machineOf(rt),
      squad: squads.get(a.id)?.name ?? null,
      look: looks.get(a.id),
      leader: squads.get(a.id)?.leader ?? false,
      work: work.get(a.id) ?? [],
      blocked: myBlocked,
    };
  });

  return {
    updatedAt: new Date().toISOString(),
    pollSeconds: POLL_SECONDS,
    fastSeconds: FAST_SECONDS,
    machines: [...machines.values()].filter((m) => out.some((a) => a.machine === m.name)),
    agents: out,
    schedules,
  };
}

let snapshot = null;
let lastError = null;
let pollTimer = null;
let polling = null;
async function poll() {
  clearTimeout(pollTimer);
  // Uma leitura completa por vez; chamadas extras esperam a que já está rodando.
  if (polling) return polling;
  polling = (async () => {
    const startedAt = Date.now();
    try {
      const next = await buildSnapshot();
      // A leitura rápida pode ter visto uma mudança depois que esta começou: vale a mais nova.
      const cur = new Map((snapshot?.agents ?? []).map((a) => [a.id, a]));
      next.agents = next.agents.map((a) =>
        (changedAt.get(a.id) ?? 0) > startedAt && cur.has(a.id) ? { ...a, state: cur.get(a.id).state, work: cur.get(a.id).work } : a,
      );
      // Quem o painel acabou de acionar continua "chegando à mesa" até o Multica confirmar.
      applyStarting(next.agents);
      const firstLoad = !snapshot;
      snapshot = next;
      lastError = null;
      // Primeira leitura pronta: aquece o Histórico para abrir sem espera.
      if (firstLoad) setTimeout(() => history.warm(), 5000);
      broadcast();
    } catch (e) {
      lastError = e.message;
      console.error(`[${new Date().toISOString()}] falha ao ler Multica: ${e.message}`);
    }
  })();
  await polling;
  polling = null;
  pollTimer = setTimeout(poll, POLL_SECONDS * 1000);
}

const changedAt = new Map(); // agentId → quando a leitura rápida viu o status mudar

// ---------- tempo real ----------
// Navegadores ficam conectados em /api/events (SSE) e recebem o snapshot assim que muda.
const clients = new Set();
function officeBody() {
  return snapshot
    ? { ...snapshot, meetings: meetings.active(), agents: snapshot.agents.map((ag) => ({ ...ag, look: looks.get(ag.id) })) }
    : { error: lastError ?? "carregando" };
}
let lastSent = "";
function broadcast() {
  if (!snapshot) return;
  const { updatedAt, ...rest } = officeBody();
  const sig = JSON.stringify(rest);
  if (sig === lastSent) return;
  lastSent = sig;
  const msg = `data: ${JSON.stringify({ updatedAt, ...rest })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

// Acionado pelo painel: mostra o agente trabalhando na hora (até 90 s sem confirmação).
const starting = new Map(); // agentId → { at, until, label }
function applyStarting(agents) {
  const now = Date.now();
  for (const a of agents) {
    const s = starting.get(a.id);
    if (!s) continue;
    if (s.until < now || (a.state === "working" && a.work.length && a.work[0].kind !== "starting")) {
      starting.delete(a.id);
      continue;
    }
    if (a.state !== "working" || !a.work.length) {
      a.state = "working";
      a.work = [{ kind: "starting", label: s.label, startedAt: new Date(s.at).toISOString() }];
    }
  }
}
let fastTimer = null;
let boostUntil = 0;
function markStarting(agentId, label = "Iniciando…") {
  if (!agentId) return;
  starting.set(agentId, { at: Date.now(), until: Date.now() + 90_000, label });
  if (snapshot) {
    snapshot = { ...snapshot, agents: snapshot.agents.map((a) => ({ ...a })) };
    applyStarting(snapshot.agents);
    broadcast();
  }
  boostUntil = Date.now() + 60_000;
  clearTimeout(fastTimer);
  fastTimer = setTimeout(fastPoll, 1000);
}

// Leitura rápida: `agent list` (~1-2 s). Quando alguém muda de status, busca só a tarefa dele.
async function fastPoll() {
  clearTimeout(fastTimer);
  try {
    if (snapshot) {
      const list = await multica(["agent", "list"]);
      const byId = new Map(list.filter((a) => !a.archived_at).map((a) => [a.id, a]));
      // Agente novo ou arquivado: a leitura completa resolve.
      if (byId.size !== snapshot.agents.length || snapshot.agents.some((a) => !byId.has(a.id))) {
        if (!polling) poll();
      } else {
        // 1º avisa a mudança de status; 2º completa com a tarefa (mais uma chamada à CLI).
        const needWork = [];
        const agents = snapshot.agents.map((a) => {
          const working = byId.get(a.id).status === "working";
          const confirmed = a.state === "working" && a.work.length > 0 && a.work[0].kind !== "starting";
          if (working !== (a.state === "working")) changedAt.set(a.id, Date.now());
          if (working) {
            if (!confirmed) needWork.push(a.id);
            return a.state === "working" ? a : { ...a, state: "working", work: [] };
          }
          if (a.state !== "working") return a;
          // Parou: volta ao estado de base (pendência > desligado > ocioso).
          const offline = snapshot.machines.find((m) => m.name === a.machine)?.online === false;
          return { ...a, state: a.blocked.length ? "blocked" : offline ? "offline" : "idle", work: [] };
        });
        applyStarting(agents);
        snapshot = { ...snapshot, agents, updatedAt: new Date().toISOString() };
        broadcast();
        if (needWork.length) {
          const works = new Map(await Promise.all(needWork.map(async (id) => [id, await currentWork(id).catch(() => [])])));
          snapshot = {
            ...snapshot,
            agents: snapshot.agents.map((a) => (works.get(a.id)?.length && a.state === "working" ? { ...a, work: works.get(a.id) } : a)),
          };
          applyStarting(snapshot.agents);
          broadcast();
        }
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] leitura rápida: ${e.message}`);
  }
  // Logo depois de uma ação pelo painel lê a cada 1,5 s; no resto do tempo, FAST_SECONDS.
  fastTimer = setTimeout(fastPoll, Date.now() < boostUntil ? 1500 : FAST_SECONDS * 1000);
}

// Depois de uma escrita pelo painel: esquece os caches e relê o Multica já.
function refreshNow() {
  triggerCache.clear();
  lastRunCache.clear();
  squadCache.at = 0;
  boostUntil = Date.now() + 30_000;
  return poll();
}
function onStart(agentId, label) {
  markStarting(agentId, label);
}
// Disparo de tarefa agendada: o agente vem do snapshot.
function onScheduleStart(scheduleId) {
  const s = snapshot?.schedules.find((x) => x.id === scheduleId);
  if (s?.agentId) markStarting(s.agentId, `⏰ ${s.title}`);
}
const meetings = createMeetings({ multica, file: MEETING_FILE, onStart, onChange: refreshNow, initial: DEMO ? demoMeetings() : [] });
await meetings.load();
const history = createHistory({ multica, redact, getSnapshot: () => snapshot });
const handleActions = createActions({ multica, redact, onChange: refreshNow, onStart, onScheduleStart, acks, looks, meetings, history, manage: createManage({ multica, redact }), demo: DEMO });
await looks.load();
await acks.load();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".txt": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  // Nada deste site deve aparecer em buscadores.
  res.setHeader("X-Robots-Tag", ROBOTS);
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("User-agent: *\nDisallow: /\n");
  }
  // Site inteiro atrás de senha: sem sessão, só a tela de login e as rotas de login.
  if (handleActions.enabled && !handleActions.sessionOk(req)) {
    if (["/api/login", "/api/me", "/api/logout"].includes(url.pathname)) {
      if (await handleActions(req, res, url)) return;
    }
    if (url.pathname.startsWith("/brand/") && /\.(png|jpg|svg)$/.test(url.pathname)) {
      try {
        const body = await readFile(join(PUBLIC_DIR, normalize(url.pathname.slice(1))));
        res.writeHead(200, { "content-type": TYPES[extname(url.pathname)], "cache-control": "public, max-age=86400" });
        return res.end(body);
      } catch {
        return res.writeHead(404).end();
      }
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "Faça login." }));
    }
    if (/\.(js|css|png|jpg|svg|json|map|glb)$/.test(url.pathname)) return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(brand(await readFile(LOGIN_PAGE), "login.html"));
  }
  if (url.pathname === "/login") {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  if (url.pathname === "/api/office") {
    res.writeHead(snapshot ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    // O visual vem do arquivo na hora (não espera a próxima leitura do Multica).
    return res.end(JSON.stringify(officeBody()));
  }
  if (url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    if (snapshot) res.write(`data: ${JSON.stringify(officeBody())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (await handleActions(req, res, url)) return;
  const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (rel.startsWith("..")) return res.writeHead(400).end();
  try {
    const body = brand(await readFile(join(PUBLIC_DIR, rel)), rel);
    const longCache = /^(models|brand)[\\/]/.test(rel);
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": longCache ? "private, max-age=604800" : "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404).end("não encontrado");
  }
}).listen(PORT, HOST, () => {
  console.log(`Escritório de Agentes em http://${HOST}:${PORT} (status a cada ${FAST_SECONDS}s, completo a cada ${POLL_SECONDS}s)${DEMO ? " · MODO DEMONSTRAÇÃO" : ""}`);
  poll().then(() => fastPoll());
});
