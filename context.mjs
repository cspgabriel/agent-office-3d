// Contexto legível de uma execução a partir das mensagens dela:
// - about: a primeira fala do agente (em geral ele reformula o pedido: "Vou…");
// - now: o que ele está fazendo agora (última fala ou última ferramenta usada).

const ABOUT_MAX = 160;
const NOW_MAX = 120;

/** Markdown/menções → texto corrido de uma linha. */
export function plain(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // imagens
    .replace(/\[@([^\]]+)\]\(mention:\/\/[^)]+\)/g, "@$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/[*_`>#|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Primeira frase, cortada em max caracteres (com reticências). */
export function firstSentence(text, max) {
  const t = plain(text);
  if (!t) return "";
  const m = /^(.{12,}?[.!?:])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const TOOL_MAX = 70;
/** Caminhos absolutos viram só o nome do arquivo (sem pastas internas). */
const shortPaths = (s) => String(s ?? "").replace(/(?:[A-Za-z]:)?(?:[\\/][^\s"'`<>|;&\\/]+){2,}[\\/]?/g, (p) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p);

/** Ferramenta em uma linha: a descrição dela, ou o arquivo, ou o começo do comando. */
function toolLine(m) {
  const i = m.input ?? {};
  let what = i.description ?? (i.file_path || i.path ? shortPaths(i.file_path ?? i.path) : null) ?? i.query ?? i.pattern ?? i.url ?? i.command ?? "";
  what = plain(shortPaths(String(what).split("\n")[0]));
  if (what.length > TOOL_MAX) what = `${what.slice(0, TOOL_MAX - 1).trimEnd()}…`;
  return `${m.tool ?? "ferramenta"}${what ? `: ${what}` : ""}`;
}

/** Fala que descreve o trabalho: planejamento ("Vou…", "Plano…") ou a primeira com conteúdo. */
const PLAN = /^(vou|vamos|plano|objetivo|entendi|i'll|i will|let me|i'm going|going to|primeiro)/i;
function pickAbout(texts) {
  // Frase muito curta ("Servidor pronto.") não diz do que se trata: continua no texto.
  const firsts = texts.slice(0, 6).map((m) => {
    const one = firstSentence(m.content, ABOUT_MAX);
    if (one.length >= 40) return one;
    const all = plain(m.content);
    return all.length > ABOUT_MAX ? `${all.slice(0, ABOUT_MAX - 1).trimEnd()}…` : all;
  });
  return firsts.find((s) => PLAN.test(s)) ?? firsts.find((s) => s.length >= 40) ?? firsts[0] ?? "";
}

/**
 * Resumo a partir das mensagens cruas de `issue run-messages`.
 * Retorna { about, now } (strings vazias se não houver nada útil).
 */
export function summarize(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const texts = list.filter((m) => m.type === "text" && plain(m.content));
  const about = pickAbout(texts);
  const last = list.filter((m) => m.type === "text" || m.type === "tool_use").at(-1);
  let now = "";
  if (last?.type === "tool_use") now = `🔧 ${toolLine(last)}`;
  else if (last && firstSentence(last.content, ABOUT_MAX) !== about) now = firstSentence(last.content, NOW_MAX);
  if (now.length > NOW_MAX) now = `${now.slice(0, NOW_MAX - 1)}…`;
  return { about, now };
}
