// Modo demonstração (DEMO=1): uma CLI `multica` simulada, com agentes fictícios
// que começam e terminam tarefas sozinhos, tarefas agendadas, pendências e uma
// reunião. Permite ver o escritório sem ter um workspace Multica.
// Só leitura: qualquer comando de escrita responde com erro.

const NOW = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const uid = (n, prefix = "d") => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const MACHINES = [
  { id: uid(1, "b"), name: "Claude (Studio-Mac)", provider: "claude", status: "online" },
  { id: uid(2, "b"), name: "Codex (Linux-Server)", provider: "codex", status: "online" },
  { id: uid(3, "b"), name: "OpenCode (Office-PC)", provider: "opencode", status: "online" },
  { id: uid(4, "b"), name: "Claude (Old-Laptop)", provider: "claude", status: "offline" },
];
const ROSTER = [
  ["🦊", "Social Media Curator", "Plans and drafts Instagram and LinkedIn posts."],
  ["🐝", "Paid Ads Analyst", "Reviews Google and Meta Ads campaigns daily."],
  ["🦁", "News Editor", "Writes and publishes news posts to the website."],
  ["🐳", "Member Engagement", "Daily report on member engagement and newsletters."],
  ["🦉", "SharePoint Librarian", "Organizes documents and shared folders."],
  ["🔥", "CRM & Campaigns", "Keeps contacts and email campaigns in sync."],
  ["🌈", "Email Digest", "Summarizes the inbox every morning."],
  ["⚡", "Market Share Analyst", "Consolidates occupancy and market data."],
  ["🐯", "Workspace Migration", "Moves files and mailboxes between platforms."],
  ["🍀", "Personal Assistant", "General assistant for the team lead."],
  ["🚀", "Destination Promoter", "Writes travel guides and destination pages."],
  ["🎯", "Lead Prospector", "Finds and qualifies new leads every week."],
  ["🧭", "SEO Auditor", "Audits the website for SEO issues."],
  ["📊", "Data Reporter", "Builds weekly dashboards from spreadsheets."],
  ["🛎️", "Front Desk Bot", "Answers common questions from customers."],
  ["🧑‍⚖️", "Legal Watcher", "Monitors new regulations and deadlines."],
  ["🎨", "Designer", "Creates banners and social media art."],
  ["📰", "Clipping Collector", "Collects press mentions every day."],
  ["🐙", "Code Reviewer", "Reviews pull requests on the main repo."],
  ["🦄", "Prototype Builder", "Builds quick prototypes for new ideas."],
  ["🌊", "Weather Reporter", "Daily weather bulletin for the region."],
  ["🧪", "QA Tester", "Runs smoke tests on the website and apps."],
  ["🐼", "Translator", "Translates posts and pages to English and Spanish."],
  ["🦜", "WhatsApp Groups Monitor", "Summarizes group conversations."],
  ["🐢", "Archive Keeper", "Backs up and tidies old files."],
  ["🦋", "Newsletter Writer", "Drafts the weekly newsletter."],
  ["🐺", "Security Sentinel", "Checks logins, certificates and domains."],
  ["🦩", "Events Planner", "Tracks the events calendar and invitations."],
];
const TASKS = [
  "Weekly newsletter draft", "Instagram carousel: summer campaign", "Google Ads budget review", "Publish news: tourism numbers",
  "Clean up CRM duplicates", "SEO audit of the homepage", "Monthly occupancy report", "Translate destination guide",
  "Fix broken links on the blog", "Prepare event invitations", "Daily press clipping", "Review pull request #42",
];

/** Reuniões abertas no começo da demonstração (uma de 4 agentes e uma conversa a dois). */
export function demoMeetings() {
  const at = new Date().toISOString();
  const a = (i) => uid(100 + i, "a");
  return [
    { id: uid(900, "f"), identifier: "DEMO-200", title: "Summer campaign kickoff", agents: [a(0), a(1), a(16), a(25)], coordinator: a(0), createdAt: at, status: "in_progress" },
    { id: uid(901, "f"), identifier: "DEMO-201", title: "SEO × News Editor", agents: [a(12), a(2)], coordinator: a(12), createdAt: at, status: "in_progress" },
  ];
}

export function createDemoCli() {
  const start = NOW();
  const agents = ROSTER.map(([emoji, name, description], i) => ({
    id: uid(100 + i, "a"),
    name,
    description,
    avatar_url: `emoji:${emoji}`,
    runtime_id: MACHINES[i % MACHINES.length].id,
    archived_at: null,
  }));
  // Quem está trabalhando muda a cada ~60 s (determinístico pelo relógio).
  const workingAt = (t) => {
    const slot = Math.floor((t - start) / 60_000);
    const set = new Set();
    for (let k = 0; k < 6; k++) set.add(agents[(slot * 7 + k * 5) % agents.length].id);
    return set;
  };
  const blockedIds = new Set([agents[3].id, agents[17].id]);
  const issues = TASKS.map((title, i) => ({
    id: uid(200 + i, "c"),
    identifier: `DEMO-${101 + i}`,
    title,
    description: `Demo issue: ${title}.`,
    status: ["done", "in_progress", "in_review", "todo", "done", "blocked", "done", "in_progress", "done", "todo", "done", "done"][i],
    priority: ["none", "high", "medium", "low"][i % 4],
    assignee_type: "agent",
    assignee_id: agents[(i * 3) % agents.length].id,
    created_at: iso(start - (i + 1) * 3_600_000),
    updated_at: iso(start - i * 1_200_000),
    last_activity_at: iso(start - i * 1_200_000),
  }));
  const autopilots = Array.from({ length: 10 }, (_, i) => ({
    id: uid(300 + i, "e"),
    title: ["Morning email digest", "Daily press clipping", "Weekly newsletter", "Ads budget check", "Weather bulletin", "Lead prospecting", "Backup old files", "SEO weekly audit", "Member engagement report", "Events calendar sync"][i],
    assignee_type: "agent",
    assignee_id: agents[(i * 4 + 6) % agents.length].id,
    status: i === 9 ? "paused" : "active",
    execution_mode: "create_issue",
  }));
  const nextRun = (i) => iso(start + (i + 1) * 47 * 60_000);
  const runsOf = (agentId, n = 4) =>
    Array.from({ length: n }, (_, k) => {
      const t = NOW() - (k + 1) * 2_700_000 - (parseInt(agentId.slice(-3), 10) % 7) * 600_000;
      const issue = issues[(parseInt(agentId.slice(-3), 10) + k) % issues.length];
      return {
        id: `${agentId.slice(0, 20)}${String(k).padStart(4, "0")}${agentId.slice(-12, -4)}`.replace(/^a/, "e"),
        agent_id: agentId,
        kind: k === 2 ? "chat" : "direct",
        status: k === 1 && agentId.endsWith("5") ? "failed" : "completed",
        error: k === 1 && agentId.endsWith("5") ? "Demo: the tool timed out." : null,
        created_at: iso(t),
        dispatched_at: iso(t + 2_000),
        completed_at: iso(t + 240_000 + k * 60_000),
        issue_id: k === 2 ? null : issue.id,
        attribution: { initiator: { name: "Demo User" } },
      };
    });

  return async function multica(args) {
    const [a, b, c] = args;
    const working = workingAt(NOW());
    if (a === "agent" && b === "list") {
      return agents.map((ag) => ({ ...ag, status: working.has(ag.id) ? "working" : "idle" }));
    }
    if (a === "runtime" && b === "list") return MACHINES;
    if (a === "squad") return [];
    if (a === "agent" && b === "tasks") {
      const list = runsOf(c);
      if (working.has(c)) {
        const issue = issues[parseInt(c.slice(-3), 10) % issues.length];
        list.unshift({ id: `${c.slice(0, 30)}aaaa`, agent_id: c, kind: "direct", status: "running", created_at: iso(NOW() - 90_000), dispatched_at: iso(NOW() - 88_000), issue_id: issue.id });
      }
      return list;
    }
    if (a === "issue" && b === "list") {
      const status = args[args.indexOf("--status") + 1];
      if (args.includes("--status") && status === "blocked") {
        return { issues: [...blockedIds].map((id, k) => ({ id: uid(400 + k, "c"), identifier: `DEMO-9${k}`, title: k ? "Waiting for login approval" : "Missing API key", assignee_type: "agent", assignee_id: id })) };
      }
      return { issues: args.includes("--status") ? issues.filter((i) => i.status === status) : issues, has_more: false };
    }
    if (a === "issue" && b === "get") return issues.find((i) => i.id === c || i.identifier === c) ?? { ...issues[1], id: c, identifier: "DEMO-200", status: "in_progress" };
    if (a === "issue" && b === "comment") return [{ id: "c1", type: "comment", author_type: "member", content: "Demo comment: please start with the summary.", created_at: iso(start - 600_000) }];
    if (a === "issue" && b === "runs") return runsOf(agents[0].id, 2);
    if (a === "issue" && b === "timeline") return [{ type: "activity", action: "created", actor_name: "Demo User", created_at: iso(start - 3_600_000) }];
    if (a === "issue" && b === "usage") return { task_count: 2, total_input_tokens: 12000, total_output_tokens: 900, total_cache_read_tokens: 40000 };
    if (a === "issue" && b === "search") return { issues: issues.filter((i) => i.title.toLowerCase().includes(String(c).toLowerCase())) };
    if (a === "issue" && b === "run-messages") {
      return [
        { type: "text", seq: 1, created_at: iso(NOW() - 60_000), content: "Reading the issue and planning the work." },
        { type: "tool_use", seq: 2, created_at: iso(NOW() - 50_000), tool: "Bash", input: { command: "ls reports/" } },
        { type: "tool_result", seq: 3, created_at: iso(NOW() - 49_000), output: "weekly.csv  monthly.csv" },
        { type: "text", seq: 4, created_at: iso(NOW() - 30_000), content: "Done: report updated and summary posted." },
      ];
    }
    if (a === "autopilot" && b === "list") {
      return { autopilots: autopilots.map((p, i) => ({ ...p, next_run_at: p.status === "active" ? nextRun(i) : null, last_run_at: iso(start - (i + 1) * 3_000_000) })) };
    }
    if (a === "autopilot" && b === "trigger-list") {
      const i = autopilots.findIndex((p) => p.id === c);
      return { triggers: [{ kind: "schedule", enabled: true, cron_expression: `${(i * 7) % 60} ${7 + (i % 10)} * * *`, timezone: "America/Sao_Paulo", next_run_at: nextRun(i) }] };
    }
    if (a === "autopilot" && b === "runs") {
      const i = autopilots.findIndex((p) => p.id === c);
      return {
        runs: Array.from({ length: 4 }, (_, k) => ({
          id: `${c.slice(0, 26)}${k}${c.slice(-9)}`,
          status: k === 0 && i === 2 ? "failed" : "completed",
          failure_reason: k === 0 && i === 2 ? "Demo: mailbox quota exceeded." : null,
          source: k === 3 ? "manual" : "schedule",
          triggered_at: iso(start - (k + 1) * 86_400_000 + i * 600_000),
          completed_at: iso(start - (k + 1) * 86_400_000 + i * 600_000 + 300_000),
          issue_id: issues[(i + k) % issues.length].id,
        })),
      };
    }
    throw Object.assign(new Error("Modo demonstração: ações que alteram dados estão desligadas."), { status: 403, stderr: "" });
  };
}
