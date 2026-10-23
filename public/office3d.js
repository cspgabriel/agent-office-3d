// Cena 3D do escritório: prédio com fachada, rua e jardim; por dentro, uma
// sala de trabalho por máquina (mesas em ilhas por squad), a copa para quem
// está ocioso, a sala de pendências para os bloqueados e a sala dos
// desligados. Só quem está trabalhando senta na cadeira da própria mesa; os
// avatares andam de um lugar a outro quando o estado muda.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { createRio } from "./rio.js";
import { activeWork, workAttrs, workIcon, workSummary, workTitle } from "./work.js";
import { OUTFITS, outfitTexture, sleeveColor } from "./looks.js";
import { kit, kitHeight, loading as modelsLoading, makeRobot } from "./models.js";

// Logo oficial para os letreiros (carrega junto com os modelos).
const LOGO = new Image();
const logoLoaded = new Promise((ok) => {
  LOGO.onload = ok;
  LOGO.onerror = ok;
});
LOGO.src = "/brand/logo.svg";

const SEAT_DX = 1.8; // distância entre cadeiras vizinhas na bancada
const SIDE_N = 6; // lugares de cada lado da bancada
const BENCH_N = SIDE_N * 2;
const BENCH_DZ = 5.6; // profundidade de cada bancada com as cadeiras e a passagem
const WALL_H = 5.2;
const MARGIN = 2.5;
const CORRIDOR = 4.5;
const SET = 3.8; // um "canto de conversa" da copa: 4 lugares
const WALK_SPEED = 5;
const ELEV = 26; // o escritório é a cobertura de uma torre na orla
const ROBOT_CLIP = { desk: "Sitting", meet: "Sitting", sofa: "Sitting", sleep: "Death", meeting: "No", chat: "Idle" };

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra });
const glass = () =>
  new THREE.MeshStandardMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.22, roughness: 0.1, metalness: 0.1, depthWrite: false });

function box(w, h, d, material, { cast = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}
function at(obj, x, y, z) {
  obj.position.set(x, y, z);
  return obj;
}
const counters = []; // elementos com data-zone / data-room das etiquetas atuais
function label(html, className, x, y, z) {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  counters.push(...el.querySelectorAll("[data-zone], [data-room], [data-room-names]"));
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  o.userData.isLabel = true;
  return o;
}
function hueOf(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return (h % 360) / 360;
}
function taskLabel(agent) {
  const w = agent.work?.[0];
  if (w?.issue) return `${w.issue.identifier} · ${w.issue.title}`;
  return w?.label ?? "";
}

// ---------------- Planta ----------------

/**
 * Área de trabalho: bancadas coletivas (workstations) de 12 lugares, 6 de cada lado.
 * Cresce de bancada em bancada; quem começa a trabalhar senta no primeiro lugar livre,
 * sempre ao lado de quem já está lá.
 */
function planRoom(machine, agents) {
  const benches = Math.max(1, Math.ceil(agents.length / BENCH_N));
  const len = SIDE_N * SEAT_DX + 1.2;
  return { machine, agents, benches, len, w: len + 5, d: benches * BENCH_DZ + 2.4 };
}

function shelf(items, maxW, gap) {
  let x = 0, z = 0, rowD = 0, w = 0;
  for (const it of items) {
    if (x > 0 && x + it.w > maxW) {
      x = 0;
      z += rowD + gap;
      rowD = 0;
    }
    it.x = x;
    it.z = z;
    x += it.w + gap;
    rowD = Math.max(rowD, it.d);
    w = Math.max(w, x - gap);
  }
  return { w, d: z + rowD };
}

const CONF_MAX = 6; // salas de reunião simultâneas por prédio
const CONF_CAP = 10; // lugares na sala de reunião (4 de cada lado + 2 cabeceiras)
const DORM_MAX = 12; // camas no dormitório das tarefas agendadas
const BED_DX = 2.6;
const BED_DZ = 3.6;

/** Ocioso que já executou algo hoje (vai para o Descanso). */
export const workedToday = (a) => (a.today?.runs ?? 0) > 0;

/** Copa/Descanso: cantos de conversa de 4 lugares; cresce de 8 em 8 pessoas. */
function loungePlan(kind, n) {
  const sets = Math.max(2, Math.ceil((Math.ceil(Math.max(n, 1) / 8) * 8) / 4));
  const lc = Math.ceil(Math.sqrt(sets * 1.4));
  return { kind, sets, cols: lc, w: lc * SET + 2, d: Math.ceil(sets / lc) * SET + 4.5 };
}

function plan(data, compact = false, dormN = 0, confN = 1) {
  const total = data.agents.length;
  const blocked = data.agents.filter((a) => a.state === "blocked").length;
  const offline = data.agents.filter((a) => a.state === "offline").length;

  // Mesas só para quem está trabalhando agora, agrupadas por máquina (ilhas).
  // Ociosos ficam na copa; assim não sobra um mar de mesas vazias.
  const rooms = [planRoom({ name: "Trabalhando agora", online: true }, data.agents.filter((a) => a.state === "working"))];
  const work = { w: 0, d: 0 }; // a área de trabalho agora fica na fileira das salas

  // A copa comporta todos os agentes, então não muda de tamanho quando
  // alguém para de trabalhar.
  const lounge = loungePlan("lounge", data.agents.filter((a) => a.state === "idle" && !workedToday(a)).length);
  const rest = loungePlan("rest", data.agents.filter((a) => a.state === "idle" && workedToday(a)).length);
  const meetCap = compact ? Math.max(4, Math.ceil(blocked / 4) * 4) : Math.max(8, Math.ceil(blocked / 8) * 8);
  const meeting = { kind: "meeting", cap: meetCap, w: Math.max(10, (meetCap / 2) * 1.5 + 4), d: 9 };
  const sCols = compact ? 3 : 6;
  const offCap = compact ? Math.max(3, Math.ceil(offline / 3) * 3) : Math.max(12, Math.ceil(offline / 6) * 6);
  const sleep = { kind: "offline", cap: offCap, cols: sCols, w: sCols * 1.8 + 2.5, d: Math.ceil(offCap / sCols) * 1.8 + 3 };
  const reception = compact ? { kind: "reception", w: 7, d: 7 } : { kind: "reception", w: 13, d: 10 };
  const dCols = Math.min(4, Math.max(1, dormN));
  const dorm = dormN ? { kind: "dorm", n: dormN, cols: dCols, w: dCols * BED_DX + 2.5, d: Math.ceil(dormN / dCols) * BED_DZ + 3 } : null;
  const confs = Array.from({ length: Math.min(CONF_MAX, Math.max(1, confN)) }, () => ({ kind: "conf", cap: CONF_CAP, w: 12, d: 9 }));
  const front = [lounge, rest, rooms[0], ...confs, reception, meeting, sleep, ...(dorm ? [dorm] : [])];
  const frontRow = shelf(front, 999, 2);

  const W = Math.max(work.w, frontRow.w) + MARGIN * 2;
  const frontZ = MARGIN + 2.5; // faixa de circulação atrás das salas
  const frontD = Math.max(...front.map((f) => f.d));
  const D = frontZ + frontD + MARGIN;
  const extra = (W - MARGIN * 2 - frontRow.w) / (front.length - 1 || 1);
  front.forEach((f, i) => {
    f.x += MARGIN + extra * i;
    f.z = frontZ + (frontD - f.d);
  });
  return { W, D, rooms, lounge, rest, meeting, sleep, reception, dorm, confs, conf: confs[0], corridorZ: MARGIN + 1.2 };
}

// ---------------- Mobília ----------------

/** Uma bancada: tampo contínuo, divisória central, estrutura e luminária linear. */
function buildBench(len) {
  const g = new THREE.Group();
  const TOP = 0.97;
  g.add(at(box(len, 0.05, 2.0, mat(0xf6f4ef, { roughness: 0.35 })), 0, TOP, 0)); // tampo
  g.add(at(box(len + 0.02, 0.05, 2.02, mat(0xb07a4c, { roughness: 0.5 }), { cast: false }), 0, TOP - 0.05, 0)); // borda de carvalho
  const steel = mat(0x2a2e36, { roughness: 0.4, metalness: 0.6 });
  for (const x of [-len / 2 + 0.12, len / 2 - 0.12]) g.add(at(box(0.08, TOP - 0.05, 1.7, steel), x, (TOP - 0.05) / 2, 0)); // pés laterais
  g.add(at(box(len - 0.3, 0.08, 0.14, steel), 0, 0.55, 0)); // calha de cabos
  // Divisória acústica de feltro com acabamento de alumínio.
  g.add(at(box(len - 0.3, 0.36, 0.05, mat(0x5e7d6c, { roughness: 0.95 })), 0, TOP + 0.2, 0));
  g.add(at(box(len - 0.3, 0.025, 0.07, mat(0xc9ccd2, { metalness: 0.7, roughness: 0.3 })), 0, TOP + 0.39, 0));
  // Luminária linear pendente.
  const led = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3d6, emissiveIntensity: 1.4 });
  g.add(at(box(len * 0.8, 0.07, 0.22, mat(0x1d2027, { metalness: 0.5 })), 0, 3.3, 0));
  g.add(at(box(len * 0.78, 0.02, 0.16, led, { cast: false }), 0, 3.26, 0));
  for (const x of [-len * 0.35, len * 0.35]) g.add(at(box(0.02, 1.7, 0.02, steel, { cast: false }), x, 4.2, 0));
  // Plantinhas nas pontas da divisória.
  for (const [x, k] of [[-len / 2 + 0.3, 1], [len / 2 - 0.3, 2]]) {
    const pl = kit("plantSmall" + k, 0.32);
    if (pl) g.add(at(pl, x, TOP, 0));
  }
  return g;
}

/** Um lugar da bancada: monitor (tela viva), teclado, caneca e cadeira. Origem = meio do tampo deste lado. */
function buildSeat() {
  const g = new THREE.Group();
  const TOP = 1.0;
  const dark = mat(0x1c1f26, { roughness: 0.35, metalness: 0.3 });
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 160;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const screenMat = mat(0x0b0d12, { emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0, roughness: 0.2 });
  g.add(at(box(1.0, 0.6, 0.035, dark), 0, 1.5, -0.3));
  g.add(at(new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.54), screenMat), 0, 1.5, -0.28));
  g.add(at(box(0.05, 0.42, 0.05, dark), 0, 1.2, -0.34));
  g.add(at(box(0.32, 0.02, 0.22, dark), 0, TOP + 0.01, -0.3));
  const kb = kit("computerKeyboard", 0.8);
  g.add(kb ? at(kb, 0, TOP - 0.03, 0.12) : at(box(0.8, 0.03, 0.25, mat(0x2b2f38)), 0, TOP + 0.01, 0.12));
  if (Math.random() < 0.5) g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.13, 10), mat(0xffffff)), 0.6, TOP + 0.07, 0.2));
  g.add(at(kit("chairDesk", 0.95, Math.PI) ?? officeChair(), 0, -0.1, 1.05));
  return { g, screenMat, canvas, tex };
}

/** Tela do monitor: issue em andamento e "código" rolando. */
function drawScreen(d, agent) {
  const x = d.canvas.getContext("2d");
  x.fillStyle = "#07121c";
  x.fillRect(0, 0, 256, 160);
  x.fillStyle = "#2ecc71";
  x.font = "bold 26px ui-monospace, monospace";
  const w = agent.work?.[0];
  const n = activeWork(agent).length;
  x.fillText(`${w?.issue?.identifier ?? (w?.label?.startsWith("Chat") ? "💬 chat" : "▶ run")}${n > 1 ? `  ×${n}` : ""}`, 12, 34);
  const colors = ["#7fb3ff", "#c3e88d", "#ffcb6b", "#f78c6c", "#89ddff"];
  let seed = hueOf(agent.id) * 1000;
  for (let i = 0; i < 8; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    x.fillStyle = colors[i % colors.length];
    x.fillRect(12 + (i % 3) * 14, 52 + i * 13, 40 + (seed / 233280) * 170, 6);
  }
  d.tex.needsUpdate = true;
}

function sofa(color) {
  const k = kit(color === 0x9e9e9e ? "loungeSofa" : "loungeDesignSofa", 2.5);
  if (k) return k;
  const g = new THREE.Group();
  g.add(at(box(2.4, 0.45, 0.9, mat(color)), 0, 0.3, 0));
  g.add(at(box(2.4, 0.7, 0.25, mat(color)), 0, 0.75, 0.42));
  g.add(at(box(0.25, 0.6, 0.9, mat(color)), -1.2, 0.5, 0));
  g.add(at(box(0.25, 0.6, 0.9, mat(color)), 1.2, 0.5, 0));
  return g;
}

const texCache = new Map();
/** Textura desenhada em canvas, repetida (cache por nome). */
function floorTex(kind, rx, rz) {
  const key = `${kind}:${rx}:${rz}`;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d");
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  if (kind === "wood") {
    for (let i = 0; i < 8; i++) {
      const tone = 150 + rnd() * 40;
      x.fillStyle = `rgb(${tone + 40},${tone - 10},${tone - 60})`;
      x.fillRect(0, i * 32, 256, 32);
      x.fillStyle = "rgba(60,30,10,.35)";
      x.fillRect(0, i * 32, 256, 2);
      x.fillRect(((i * 97) % 256), i * 32, 2, 32);
      for (let k = 0; k < 6; k++) {
        x.fillStyle = "rgba(90,50,20,.12)";
        x.fillRect(rnd() * 256, i * 32 + 4 + rnd() * 24, 30 + rnd() * 60, 1.5);
      }
    }
  } else if (kind === "teak") {
    // Deque de teca: tábuas longas e quentes com juntas escuras.
    for (let i = 0; i < 8; i++) {
      const tone = 120 + rnd() * 30;
      x.fillStyle = `rgb(${tone + 70},${tone + 8},${tone - 50})`;
      x.fillRect(0, i * 32, 256, 32);
      x.fillStyle = "rgba(40,18,6,.55)";
      x.fillRect(0, i * 32, 256, 3);
      x.fillRect(((i * 113) % 256), i * 32, 3, 32);
      for (let k = 0; k < 8; k++) {
        x.fillStyle = "rgba(70,30,10,.16)";
        x.fillRect(rnd() * 256, i * 32 + 5 + rnd() * 22, 40 + rnd() * 70, 1.5);
      }
    }
  } else if (kind === "marble") {
    x.fillStyle = "#f3f1ec";
    x.fillRect(0, 0, 256, 256);
    x.strokeStyle = "rgba(150,145,140,.35)";
    for (let k = 0; k < 7; k++) {
      x.lineWidth = 0.6 + rnd() * 1.4;
      x.beginPath();
      let px = rnd() * 256, py = rnd() * 256;
      x.moveTo(px, py);
      for (let j = 0; j < 6; j++) x.lineTo((px += (rnd() - 0.3) * 60), (py += (rnd() - 0.5) * 50));
      x.stroke();
    }
    x.fillStyle = "rgba(200,195,188,.6)";
    x.fillRect(0, 127, 256, 2);
    x.fillRect(127, 0, 2, 256);
  } else if (kind === "stone") {
    // Placas de pedra clara do terraço.
    x.fillStyle = "#d9d3c7";
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2; i++)
      for (let j = 0; j < 4; j++) {
        const v = 214 + rnd() * 18;
        x.fillStyle = `rgb(${v},${v - 6},${v - 16})`;
        x.fillRect(i * 128 + 2, j * 64 + 2, 124, 60);
      }
  } else if (kind === "tile") {
    x.fillStyle = "#ece7dd";
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const v = 228 + rnd() * 14;
        x.fillStyle = `rgb(${v},${v - 4},${v - 12})`;
        x.fillRect(i * 64 + 1, j * 64 + 1, 62, 62);
      }
  } else {
    // carpete: cor base + pontilhado
    const base = { blue: [64, 82, 118], red: [150, 62, 62], navy: [40, 46, 78], gray: [96, 104, 120], slate: [58, 63, 72], wine: [128, 40, 48], midnight: [30, 36, 64] }[kind] ?? [90, 90, 90];
    x.fillStyle = `rgb(${base.join(",")})`;
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const d = (rnd() - 0.5) * 26;
      x.fillStyle = `rgb(${base.map((v) => Math.max(0, Math.min(255, v + d))).join(",")})`;
      x.fillRect(rnd() * 256, rnd() * 256, 2, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, rz);
  t.anisotropy = 8;
  texCache.set(key, t);
  return t;
}
const floorMat = (kind, w, d, scale = 4) => new THREE.MeshStandardMaterial({ map: floorTex(kind, Math.max(1, Math.round(w / scale)), Math.max(1, Math.round(d / scale))), roughness: kind === "tile" || kind === "marble" ? 0.4 : kind === "stone" ? 0.7 : 0.85 });

/**
 * Temas do cenário. "premium" (padrão) segue a referência: deque de teca na copa,
 * ardósia escura nas áreas de trabalho, mármore na recepção e muito verde.
 * "classico" é o visual original; "minimal" esconde a cidade (mais leve).
 */
export const THEMES = {
  premium: { label: "🌴 Cobertura premium", deck: "stone", work: "slate", workOff: "slate", copa: "teak", reception: "marble", conf: "teak", pend: "wine", off: "midnight", dorm: "midnight", lush: true, city: true },
  classico: { label: "🏙️ Orla clássica", deck: "tile", work: "blue", workOff: "gray", copa: "wood", reception: "tile", conf: "wood", pend: "red", off: "navy", dorm: "navy", lush: false, city: true },
  minimal: { label: "⚪ Minimalista (leve)", deck: "tile", work: "slate", workOff: "slate", copa: "wood", reception: "marble", conf: "wood", pend: "red", off: "navy", dorm: "navy", lush: false, city: false },
};
let THEME = THEMES.premium;

const LEAF = [0x2f8f3a, 0x3ea34a, 0x4cb35a, 0x2b7a34, 0x5fbf62];
/** Vaso com folhagem cheia (várias esferas em tons de verde). */
function plant(scale = 1) {
  const k = kit("pottedPlant", 0.62 * scale);
  if (k) return k;
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.24, 0.55, 16), mat(0xf4f1ea, { roughness: 0.4 }));
  pot.castShadow = true;
  g.add(at(pot, 0, 0.28, 0));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 16), mat(0x4e342e)), 0, 0.54, 0));
  const n = 5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26 + (i % 2) * 0.06, 14, 10), mat(LEAF[i % LEAF.length], { roughness: 0.75 }));
    leaf.castShadow = true;
    g.add(at(leaf, Math.cos(a) * 0.2, 0.85 + (i % 3) * 0.12, Math.sin(a) * 0.2));
  }
  g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), mat(LEAF[2])), 0, 1.15, 0));
  g.scale.setScalar(scale);
  return g;
}

/** Árvore de copa arredondada (cachos de esferas). */
function tree() {
  const g = new THREE.Group();
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 2.4, 8), mat(0x6d4c41)), 0, 1.2, 0));
  for (const [x, y, z, r, c] of [[0, 3.2, 0, 1.3, 1], [0.8, 2.8, 0.3, 0.95, 0], [-0.7, 2.9, -0.2, 1, 3], [0.1, 3.9, 0.1, 0.9, 4], [-0.2, 2.7, 0.8, 0.85, 2]]) {
    const crown = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat(LEAF[c], { roughness: 0.8 }));
    crown.castShadow = true;
    g.add(at(crown, x, y, z));
  }
  return g;
}

/** Cadeira de escritório giratória (assento, encosto, coluna e base em estrela). */
function officeChair(color = 0x23272f) {
  const g = new THREE.Group();
  const m = mat(color, { roughness: 0.6 });
  const metal = mat(0x8a929c, { metalness: 0.7, roughness: 0.35 });
  g.add(at(box(0.78, 0.12, 0.74, m), 0, 0.58, 0));
  const back = box(0.74, 0.78, 0.1, m);
  back.rotation.x = -0.12;
  g.add(at(back, 0, 1.03, 0.36));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8), metal), 0, 0.33, 0));
  for (let i = 0; i < 5; i++) {
    const leg = box(0.42, 0.05, 0.07, metal);
    leg.rotation.y = (i / 5) * Math.PI * 2;
    leg.position.set(Math.cos((i / 5) * Math.PI * 2) * 0.2, 0.09, -Math.sin((i / 5) * Math.PI * 2) * 0.2);
    g.add(leg);
    g.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), m), Math.cos((i / 5) * Math.PI * 2) * 0.4, 0.05, -Math.sin((i / 5) * Math.PI * 2) * 0.4));
  }
  for (const s of [-1, 1]) g.add(at(box(0.06, 0.06, 0.5, m), s * 0.4, 0.8, 0.02));
  return g;
}

function lamp() {
  const g = new THREE.Group();
  g.add(at(box(0.15, 4, 0.15, mat(0x37474f)), 0, 2, 0));
  g.add(at(box(1, 0.12, 0.3, mat(0x37474f)), -0.4, 4, 0));
  g.add(at(box(0.5, 0.1, 0.3, mat(0xfff3c4, { emissive: 0xfff3c4, emissiveIntensity: 0.6 })), -0.7, 3.92, 0));
  return g;
}

function signTexture(lines) {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const x = c.getContext("2d");
  const grad = x.createLinearGradient(0, 0, 1024, 256);
  grad.addColorStop(0, "#1b5fd1");
  grad.addColorStop(1, "#2d8cf0");
  x.fillStyle = grad;
  x.fillRect(0, 0, 1024, 256);
  let left = 0;
  if (LOGO.complete && LOGO.naturalWidth) {
    x.drawImage(LOGO, 24, 24, 208, 208);
    left = 232;
  }
  const cx = left + (1024 - left) / 2;
  x.fillStyle = "#ffffff";
  x.textAlign = "center";
  x.font = `bold ${lines[0].length > 14 ? 92 : 116}px system-ui, sans-serif`;
  x.fillText(lines[0], cx, 135, 1024 - left - 40);
  x.font = "46px system-ui, sans-serif";
  x.fillStyle = "#dbeafe";
  x.fillText(lines[1], cx, 212, 1024 - left - 40);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------- Avatares ----------------

// Camisa rubro-negra (listras horizontais vermelho e preto) para todos os bonecos.
let rubroNegra = null;
function camisaFla() {
  if (rubroNegra) return rubroNegra;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const x = c.getContext("2d");
  const faixas = 8;
  for (let i = 0; i < faixas; i++) {
    x.fillStyle = i % 2 ? "#111111" : "#c8102e";
    x.fillRect(0, (i * 128) / faixas, 64, 128 / faixas);
  }
  rubroNegra = new THREE.CanvasTexture(c);
  rubroNegra.colorSpace = THREE.SRGBColorSpace;
  rubroNegra.wrapS = rubroNegra.wrapT = THREE.RepeatWrapping;
  return rubroNegra;
}

function buildAvatar(agent) {
  const h = hueOf(agent.name);
  const color = new THREE.Color().setHSL(h, 0.55, 0.55);
  // Visual escolhido no painel (look) ou padrão: camisa lisa na cor do agente.
  const look = agent.look ?? {};
  const outfit = OUTFITS[look.outfit] ? look.outfit : "liso";
  const bodyMat = mat(0xffffff, { roughness: 0.75, map: outfitTexture(outfit, color) });
  const sleeveMat = mat(sleeveColor(outfit, color), { roughness: 0.75 });
  const SKIN = [0xf1c9a5, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xd9a066];
  const HAIR = [0x2b1b0e, 0x4a2c17, 0x0f0f0f, 0x8b5a2b, 0xb98b5b, 0x6e6e6e];
  const PANTS = [0x2f3b52, 0x3e2f24, 0x1f2933, 0x4b5563, 0x24324a];
  const pick = (arr, k) => arr[Math.floor(((h * 997 + k) % 1) * arr.length) % arr.length];
  const skinMat = mat(look.skin ?? pick(SKIN, 0.13), { roughness: 0.6 });
  const legMat = mat(OUTFITS[outfit].pants ?? pick(PANTS, 0.37));
  const hairMat = mat(look.hair ?? pick(HAIR, 0.71), { roughness: 0.9 });
  const shoeMat = mat(0x1a1a1a, { roughness: 0.5 });
  const g = new THREE.Group();
  const person = new THREE.Group();
  g.add(person);
  const limb = (w, h, m, px, py) => {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, 0);
    pivot.add(at(box(w, h, w, m), 0, -h / 2, 0));
    person.add(pivot);
    return pivot;
  };
  const legL = limb(0.18, 0.72, legMat, -0.14, 0.75);
  const legR = limb(0.18, 0.72, legMat, 0.14, 0.75);
  for (const leg of [legL, legR]) leg.add(at(box(0.2, 0.1, 0.34, shoeMat), 0, -0.74, -0.07));
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 4, 12), bodyMat);
  body.castShadow = true;
  person.add(at(body, 0, 1.12, 0));
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 24, 18), skinMat);
  head.scale.setScalar(1.35); // proporção "chibi", como na referência
  head.castShadow = true;
  person.add(at(head, 0, 1.86, 0));
  // Cabelo (meia esfera), olhos e pescoço.
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.285, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), hairMat);
  hair.rotation.x = 0.25;
  head.add(hair);
  const eyeMat = mat(0x111111, { roughness: 0.3 });
  for (const ex of [-0.09, 0.09]) head.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), eyeMat), ex, 0.03, -0.24));
  person.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 0.12, 10), skinMat), 0, 1.53, 0));
  const armL = limb(0.13, 0.58, sleeveMat, -0.4, 1.42);
  const armR = limb(0.13, 0.58, sleeveMat, 0.4, 1.42);
  for (const arm of [armL, armR]) arm.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), skinMat), 0, -0.62, 0));

  const tagEl = document.createElement("div");
  tagEl.className = "tag";
  const tag = new CSS2DObject(tagEl);
  tag.userData.isLabel = true;
  g.add(tag);

  g.userData.agentId = agent.id;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x8d9bb5, transparent: true, opacity: 0.55, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 32), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  g.add(ring);
  g.userData.ring = ring;
  // Padrão: pessoas. Robôs só se escolhidos no seletor "Avatar".
  const robot = localStorage.getItem("painel-avatar") === "robo" ? makeRobot(outfit === "flamengo" ? new THREE.Color(0xc8102e) : color) : null;
  if (robot) {
    person.visible = false;
    g.add(robot.scene);
    robot.play("Idle", 0);
  }
  return {
    g, person, legL, legR, armL, armR, head, body, tag, tagEl, bodyMat, color: robot ? color : new THREE.Color(0xffffff), robot,
    pos: new THREE.Vector3(), path: [], spot: null, placed: false,
  };
}

/** Pose parada no lugar: sentado na mesa, no sofá, dormindo ou em pé. */
/**
 * Balão de quem trabalha. Uma coisa só: nome + PC + issue. Mais de uma ao mesmo
 * tempo: "×3" junto do nome, "💬2 · 📋1" e a lista do que é cada uma.
 */
function workBubble(a) {
  const sum = workSummary(a);
  const active = activeWork(a);
  const one = active[0];
  const multi = sum.n > 1 || sum.queued;
  const list = multi
    ? `<span class="wl">${active.slice(0, 3).map((w) => `<i ${workAttrs(w, a.id, esc)}>${workIcon(w)} ${esc(workTitle(w))}</i>`).join("")}${active.length > 3 ? `<i>+${active.length - 3} mais</i>` : ""}</span>`
    : one
      ? `<span class="wl one"><i ${workAttrs(one, a.id, esc)}>${one.issue ? `${esc(one.issue.project ? `${one.issue.project} · ` : "")}${esc(one.issue.title)}` : esc(workTitle(one))}</i>${one.now ? `<i class="now">✍️ ${esc(one.now)}</i>` : ""}</span>`
      : "";
  return `<div class="bubble ${multi ? "multi" : ""}"><b><i class="be">${esc(a.emoji)}</i>${esc(a.name)}${sum.n > 1 ? `<span class="mult" title="${sum.n} execuções ao mesmo tempo">×${sum.n}</span>` : ""}</b>` +
    `<span class="pc">💻 ${esc(a.machine)}${multi ? ` · ${esc(sum.text)}` : one?.issue ? ` · ${esc(one.issue.identifier)}` : one?.kind === "chat" ? " · 💬 chat" : ""}${a.today?.runs ? ` · ⚡${a.today.runs} hoje` : ""}</span>${list}</div>`;
}

/** "⚡3 hoje · 👀1" para o rótulo de quem já trabalhou hoje. */
function todayBadge(a) {
  const t = a.today;
  if (!t?.runs) return "";
  const parts = [`⚡${t.runs}${t.failed ? ` (${t.failed}❌)` : ""}`];
  if (a.review) parts.push(`👀${a.review}`);
  return `<span class="td">${parts.join(" · ")}</span>`;
}

function pose(av, kind, t, seed) {
  const sit = kind === "desk" || kind === "sofa" || kind === "sleep" || kind === "meet";
  av.legL.rotation.x = av.legR.rotation.x = sit ? Math.PI / 2 : 0;
  av.person.position.y = sit ? (kind === "sleep" ? -0.3 : -0.12) : 0;
  av.person.rotation.x = kind === "sleep" ? 0.35 : kind === "sofa" ? -0.12 : 0;
  av.head.rotation.x = 0;
  if (kind === "meet") {
    // Braços na mesa; quem está com a palavra gesticula e mexe a cabeça.
    if (av.talking) {
      av.armL.rotation.x = 1.0 + Math.sin(t * 5 + seed) * 0.35;
      av.armR.rotation.x = 1.3 + Math.sin(t * 6.5 + seed) * 0.5;
      av.head.rotation.x = Math.sin(t * 4) * 0.08;
    } else av.armL.rotation.x = av.armR.rotation.x = 0.95;
  } else if (kind === "desk") {
    const k = Math.sin(t * 16 + seed) * 0.12;
    av.armL.rotation.x = 1.15 + k;
    av.armR.rotation.x = 1.15 - k;
    av.person.position.y += Math.abs(Math.sin(t * 2 + seed)) * 0.02;
  } else if (kind === "meeting") {
    av.armL.rotation.x = av.armR.rotation.x = 0.5;
    av.armL.rotation.z = -0.5;
    av.armR.rotation.z = 0.5;
    av.person.rotation.x = 0.08;
  } else if (kind === "chat") {
    av.armL.rotation.x = 0.15 + Math.sin(t * 1.5 + seed) * 0.15;
    av.armR.rotation.x = Math.sin(t * 3 + seed) > 0.7 ? 1.2 : 0.1; // gesticula às vezes
    av.person.rotation.z = Math.sin(t * 0.8 + seed) * 0.03;
  } else {
    av.armL.rotation.x = av.armR.rotation.x = kind === "sleep" ? 0.9 : 0.2;
  }
  if (kind !== "meeting") av.armL.rotation.z = av.armR.rotation.z = 0;
  av.head.rotation.y = 0;
  if (av.greetUntil && t < av.greetUntil) {
    av.armR.rotation.x = 2.7;
    av.armR.rotation.z = 0.35 * Math.sin(t * 12);
    av.head.rotation.y = av.greetTurn ?? 0;
  }
}

function walkPose(av, t, seed) {
  const k = Math.sin(t * 9 + seed) * 0.6;
  av.legL.rotation.x = k;
  av.legR.rotation.x = -k;
  av.armL.rotation.x = -k * 0.7;
  av.armR.rotation.x = k * 0.7;
  av.armL.rotation.z = av.armR.rotation.z = 0;
  av.person.position.y = Math.abs(Math.cos(t * 9 + seed)) * 0.06;
  av.person.rotation.set(0, 0, 0);
}

// ---------------- Cena ----------------

const UNIFIED = "Escritório único";
const ANNEX_GAP = 26; // distância entre a torre e a Central de Agendamentos
const POD = 4.6; // espaço de cada quiosque de tarefa agendada

export function createOffice(host, { onWork = () => {}, onSelect, onSelectSchedule = () => {}, onSpot = () => {}, onBoard = () => {}, onConf = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const css = new CSS2DRenderer();
  Object.assign(css.domElement.style, { position: "absolute", inset: "0", pointerEvents: "none" });
  host.appendChild(css.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 4000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.08;
  controls.minDistance = 5;
  controls.maxDistance = 520;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const hemi = new THREE.HemisphereLight(0xe8f2ff, 0x6b7a5a, 1.2);
  const ambient = new THREE.AmbientLight(0xfff1dc, 0.2);
  scene.add(hemi, ambient);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const rio = createRio(scene, { hemi, sun, ambient });
  // Reflexos realistas no vidro e no metal (mapa de ambiente).
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  // Bloom: luzes da cidade, letreiros e monitores brilham (qualidade alta).
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.2, 0.45, 0.93);
  const gtao = new GTAOPass(scene, camera, 256, 256);
  gtao.blendIntensity = 0.75;
  gtao.updateGtaoMaterial({ radius: 1.2, distanceExponent: 1.5, thickness: 1.5, scale: 1 });
  composer.addPass(gtao);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let quality = localStorage.getItem("painel-qualidade") ?? "alta";
  function applyQuality() {
    const high = quality === "alta";
    renderer.setPixelRatio(high ? Math.min(devicePixelRatio, 2) : 1);
    sun.shadow.mapSize.set(high ? 4096 : 2048, high ? 4096 : 2048);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    bloom.enabled = high;
    gtao.enabled = high;
    resize?.();
  }
  let shadowSpan = 60;
  let themeName = THEMES[localStorage.getItem("painel-tema")] ? localStorage.getItem("painel-tema") : "premium";
  THEME = THEMES[themeName];
  host.dataset.theme = themeName;
  rio.root.visible = THEME.city;
  if (!THEME.city) scene.background = new THREE.Color(0x16202f);

  let site = null; // andar do escritório do primeiro prédio (compatibilidade)
  let tower = null; // torre e térreo do primeiro prédio
  let sites = []; // um por prédio: { key, name, p, ox, oz, group, tower }
  let campus = { mode: "sede", key: null, groupBy: "machine" }; // sede | bairro | um
  let bounds = { x0: -40, x1: 40, z0: -30, z1: 30 };
  let focusKey = null; // prédio em foco na vista "Escritório" do bairro
  let boards = [];
  let confBoards = []; // telões das salas de reunião // painéis de tarefas agendadas (recepção e área de trabalho)
  let schedules = [];
  let dormBeds = []; // camas do dormitório: { bed, blanket, head, clock, el, idx }
  let lastDorm = 0;
  let dormCenter = null;
  function focusDorm() {
    if (!dormCenter) return;
    mode = "interior";
    applyMode();
    fly(dormCenter.clone(), dormCenter.clone().add(new THREE.Vector3(2, 9, 10)));
  }
  let filterIds = null; // Set de ids visíveis (filtros da barra lateral) ou null = todos
  let unified = false; // true = todos os visíveis num open-space só
  let vis = null; // { agents, machines } que a planta usa
  let annex = null; // Central de Agendamentos: { group, x0, w, d, pods }
  let annexKey = "";
  let reframe = false; // o filtro mudou a planta: reenquadra a câmera
  let layout = null;
  let mode = "facade";
  const avatars = new Map();
  const seatOf = new Map(); // agente → índice da cadeira na bancada (estável entre atualizações)
  const walls = { exterior: [], roof: [] };
  let data = null;
  let selectedId = null;
  let flight = null;

  /** Monta todos os prédios lado a lado (fileiras na orla) e liga cada um ao seu grupo. */
  function buildAll(groups) {
    for (const s of sites) {
      s.group.traverse((o) => o.userData.isLabel && o.element.remove());
      scene.remove(s.group, s.tower);
    }
    sites = [];
    counters.length = 0;
    walls.exterior = [];
    walls.roof = [];
    boards = [];
    confBoards = [];
    const dormN = Math.min(DORM_MAX, (data?.schedules ?? []).filter((s) => s.status === "active").length);
    dormBeds = [];
    const plans = groups.map((g, i) => ({ g, p: plan(g.vis, g.compact, i === 0 ? dormN : 0, meetingsOf(g.vis).length) }));
    // Fileiras: até ~300 de largura; a de trás fica mais para o fundo.
    const GAP = 24, MAXW = groups.length > 1 ? 300 : 1e9;
    const rows = [];
    let row = [], w = 0;
    for (const it of plans) {
      if (row.length && w + it.p.W > MAXW) {
        rows.push(row);
        row = [];
        w = 0;
      }
      row.push(it);
      w += it.p.W + GAP;
    }
    if (row.length) rows.push(row);
    let zFront = 0;
    for (const r of rows) {
      const total = r.reduce((s, it) => s + it.p.W, 0) + GAP * (r.length - 1);
      const depth = Math.max(...r.map((it) => it.p.D));
      let x = -total / 2;
      for (const it of r) {
        it.ox = x + it.p.W / 2;
        it.oz = zFront - depth / 2 + (depth - it.p.D) / 2;
        x += it.p.W + GAP;
      }
      zFront -= depth + 34;
    }
    // A primeira fileira fica com a frente em z = D/2 como a sede.
    const shift = rows[0] ? Math.max(...rows[0].map((it) => it.p.D)) / 2 : 0;
    for (const it of plans) it.oz += shift;
    plans.forEach((it, i) => {
      const before = counters.length;
      buildSite(it.p, { ox: it.ox, oz: it.oz, name: it.g.name, count: it.g.vis.agents.length, main: i === 0 });
      for (const el of counters.slice(before)) el.dataset.site = it.g.key;
      site.userData.siteKey = it.g.key;
      sites.push({ key: it.g.key, name: it.g.name ?? "Sede", p: it.p, ox: it.ox, oz: it.oz, group: site, tower });
    });
    layout = sites[0]?.p ?? plan({ agents: [], machines: [] });
    bounds = sites.length
      ? {
          x0: Math.min(...sites.map((s) => s.ox - s.p.W / 2)), x1: Math.max(...sites.map((s) => s.ox + s.p.W / 2)),
          z0: Math.min(...sites.map((s) => s.oz - s.p.D / 2)), z1: Math.max(...sites.map((s) => s.oz + s.p.D / 2)),
        }
      : { x0: -40, x1: 40, z0: -30, z1: 30 };
    if (focusKey && !sites.some((s) => s.key === focusKey)) focusKey = null;
    // Sombra cobrindo todos os prédios.
    shadowSpan = Math.max(bounds.x1 - bounds.x0 + 80, bounds.z1 - bounds.z0) * 0.6 + 25;
    sun.target.position.set((bounds.x0 + bounds.x1) / 2, ELEV * 0.6, (bounds.z0 + bounds.z1) / 2);
    Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, near: 1, far: shadowSpan * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    annexKey = "";
    buildAnnex();
    rio.setMasks([
      ...sites.map((s) => ({ x0: s.ox - s.p.W / 2 - 12, x1: s.ox + s.p.W / 2 + 12, z0: s.oz - s.p.D / 2 - 6, z1: s.oz + s.p.D / 2 + 16 })),
      ...(annex ? [{ x0: annex.x0 - 4, x1: annex.x0 + annex.w + 6, z0: -annex.d / 2 - 6, z1: annex.d / 2 + 16 }] : []),
    ]);
    rio.refresh();
    applyMode();
  }

  function buildSite(p, { ox = 0, oz = 0, name = null, count = 0, main = true } = {}) {
    site = new THREE.Group();
    site.position.set(ox - p.W / 2, ELEV, oz - p.D / 2);
    site.userData.siteOffset = { ox, oz };
    scene.add(site);
    const add = (o) => (site.add(o), o);
    const trim = mat(0x0b3d5c);
    // Letreiro com brilho próprio (emissiveMap = a arte), legível de dia e de noite.
    const brandSign = (w, h) => {
      const tex = signTexture(name ? [name.length > 18 ? `${name.slice(0, 17)}…` : name, `${count} agente${count === 1 ? "" : "s"} · Agent Office`] : ["Agent Office", "Escritório de Agentes"]);
      return new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.4), [
        trim, trim, trim, trim,
        new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55 }),
        trim,
      ]);
    };

    // Torre de vidro até a cobertura, com térreo de pilotis na orla.
    tower = new THREE.Group();
    tower.position.set(ox - p.W / 2, 0, oz - p.D / 2);
    scene.add(tower);
    const front = rio.windowTextures(Math.round(p.W / 3.2), 7, 0.55, 17);
    const side = rio.windowTextures(Math.round(p.D / 3.2), 7, 0.55, 23);
    const facadeMat = (t) =>
      new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.35, metalness: 0.1 });
    const fm = facadeMat(front), sm = facadeMat(side);
    rio.cityMats.push([fm, 1.1], [sm, 1.1]);
    const shaftH = ELEV - 5;
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(p.W, shaftH, p.D), [sm, sm, mat(0x8d969e), mat(0x8d969e), fm, fm]);
    shaft.position.set(p.W / 2, 5 + shaftH / 2, p.D / 2);
    shaft.castShadow = shaft.receiveShadow = true;
    tower.add(shaft);
    tower.add(at(box(p.W - 8, 5, p.D - 8, glass(), { cast: false }), p.W / 2, 2.5, p.D / 2)); // lobby
    for (let x = 4; x <= p.W - 4; x += 9) for (const z of [4, p.D - 4]) tower.add(at(box(0.9, 5, 0.9, mat(0xe9e5dc)), x, 2.5, z));
    tower.add(at(box(20, 0.4, 8, trim), p.W / 2, 5.2, p.D + 3));
    tower.add(at(brandSign(14, 2.6), p.W / 2, 6.9, p.D + 0.4));
    tower.add(at(box(p.W + 40, 0.15, 14, mat(0xd8d2c4), { cast: false }), p.W / 2, 0.05, p.D + 7)); // praça
    tower.add(at(plant(2.4), p.W / 2 - 14, 0.1, p.D + 6), at(plant(2.4), p.W / 2 + 14, 0.1, p.D + 6));

    // Piso da cobertura e paredes-cortina de vidro: vista de 360°.
    add(at(box(p.W + 1, 0.6, p.D + 1, floorMat(THEME.deck, p.W + 1, p.D + 1, 3), { cast: false }), p.W / 2, -0.2, p.D / 2));
    if (THEME.lush) {
      // Tema premium: canteiros e palmeiras em vaso por toda a borda do terraço.
      for (let x = 7.5; x < p.W - 4; x += 9) add(at(plant(1.5), x, 0.1, 1.0));
      for (let z = 10.5; z < p.D - 4; z += 9) {
        add(at(plant(1.5), 0.9, 0.1, z));
        add(at(plant(1.5), p.W - 0.9, 0.1, z));
      }
      for (let x = 2; x < p.W - 1; x += 6) add(at(plant(1.3), x, 0.1, p.D - 0.45));
      for (const [x, z] of [[1.3, 1.3], [p.W - 1.3, 1.3], [1.3, p.D - 1.3], [p.W - 1.3, p.D - 1.3]]) add(at(plant(2.6), x, 0.1, z));
    }
    // Floreiras ao longo do vidro, como num terraço.
    for (let x = 3; x < p.W - 2; x += 9) add(at(plant(2), x, 0.1, 1.1));
    for (let z = 6; z < p.D - 6; z += 9) {
      add(at(plant(1.9), 1.1, 0.1, z));
      add(at(plant(1.9), p.W - 1.1, 0.1, z));
    }
    const curtain = glass();
    curtain.opacity = 0.1;
    const mullion = mat(0x2b3440, { metalness: 0.6, roughness: 0.4 });
    const wall = (x1, z1, x2, z2, facade) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const grp = new THREE.Group();
      grp.position.set((x1 + x2) / 2, 0, (z1 + z2) / 2);
      grp.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      grp.add(at(box(len, WALL_H, 0.1, curtain, { cast: false }), 0, WALL_H / 2, 0));
      grp.add(at(box(len + 0.4, 0.45, 0.45, trim), 0, WALL_H, 0));
      grp.add(at(box(len, 0.35, 0.3, mullion), 0, 0.2, 0));
      const n = Math.max(1, Math.round(len / 3.2));
      for (let i = 0; i <= n; i++) grp.add(at(box(0.14, WALL_H, 0.18, mullion, { cast: false }), -len / 2 + (i * len) / n, WALL_H / 2, 0));
      add(grp);
      if (facade) walls.exterior.push(grp);
      return grp;
    };
    wall(0, 0, p.W, 0, false); // fundos: baía, Pão de Açúcar e Cristo
    wall(0, 0, 0, p.D, false); // lateral esquerda
    wall(p.W, 0, p.W, p.D, true); // lateral direita
    wall(0, p.D, p.W, p.D, true); // fachada para a praia

    // Cobertura (só na vista da fachada): laje, letreiro e heliponto.
    const roof = new THREE.Group();
    roof.add(at(box(p.W + 1.2, 0.5, p.D + 1.2, mat(0x9aa3ad)), p.W / 2, WALL_H + 0.25, p.D / 2));
    roof.add(at(brandSign(24, 5), p.W / 2, WALL_H + 3.2, p.D - 0.4));
    const padTex = document.createElement("canvas");
    padTex.width = padTex.height = 256;
    const pc = padTex.getContext("2d");
    pc.fillStyle = "#3a4048";
    pc.fillRect(0, 0, 256, 256);
    pc.strokeStyle = "#ffd54f";
    pc.lineWidth = 10;
    pc.beginPath();
    pc.arc(128, 128, 110, 0, Math.PI * 2);
    pc.stroke();
    pc.fillStyle = "#ffffff";
    pc.font = "bold 150px sans-serif";
    pc.textAlign = "center";
    pc.textBaseline = "middle";
    pc.fillText("H", 128, 138);
    const padMap = new THREE.CanvasTexture(padTex);
    padMap.colorSpace = THREE.SRGBColorSpace;
    roof.add(at(new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 0.2, 32), new THREE.MeshStandardMaterial({ map: padMap })), p.W * 0.25, WALL_H + 0.6, p.D * 0.4));
    for (let i = 0; i < Math.max(2, Math.floor(p.W / 18)); i++) roof.add(at(box(2.2, 1.2, 1.6, mat(0xc7ccd1)), p.W * 0.55 + i * 8, WALL_H + 1, 5));
    add(roof);
    walls.roof.push(roof);

    // Corredor.
    add(at(box(p.W - 1, 0.03, CORRIDOR - 1, mat(0xbfb8aa), { cast: false }), p.W / 2, 0.12, p.corridorZ));

    // Salas de trabalho, uma por máquina.
    for (const r of p.rooms) {
      const g = new THREE.Group();
      g.position.set(r.x, 0, r.z);
      add(g);
      const on = r.machine.online;
      g.add(at(box(r.w, 0.06, r.d, floorMat(on ? THEME.work : THEME.workOff, r.w, r.d), { cast: false }), r.w / 2, 0.13, r.d / 2));
      if (THEME.lush) g.add(at(plant(1.6), r.w - 0.8, 0.1, r.d - 0.8), at(plant(1.6), 0.8, 0.1, r.d - 0.8));
      g.add(at(plant(1.1), 0.7, 0.1, 0.7), at(plant(1.1), r.w - 0.7, 0.1, 0.7));
      const gm = glass();
      for (const [w, d, x, z] of [[r.w, 0.08, r.w / 2, 0], [0.08, r.d, 0, r.d / 2], [0.08, r.d, r.w, r.d / 2]]) g.add(at(box(w, 2.4, d, gm, { cast: false }), x, 1.3, z));
      // Frente de vidro com porta no meio.
      const half = (r.w - 2.2) / 2;
      g.add(at(box(half, 2.4, 0.08, gm, { cast: false }), half / 2, 1.3, r.d));
      g.add(at(box(half, 2.4, 0.08, gm, { cast: false }), r.w - half / 2, 1.3, r.d));
      g.add(label(`💻 Trabalhando agora · <span data-zone="working">0</span>`, "room-label work", r.w / 2, 0.3, r.d + 0.3));
      // Telão das tarefas agendadas na parede do fundo, de frente para as bancadas.
      if (main) {
        const b = makeBoard(Math.min(10.5, r.len - 1), 4.5);
        g.add(at(b.mesh, r.w / 2, 2.85, 0.35));
        boards.push(b);
      }
      // Tapete sob as bancadas e lugares numerados na ordem em que são ocupados:
      // primeiro o lado de lá (de frente para a câmera), depois o de cá.
      r.seats = [];
      const wx = (x) => ox - p.W / 2 + r.x + x;
      const wz = (z) => oz - p.D / 2 + r.z + z;
      for (let b = 0; b < r.benches; b++) {
        const bx = r.w / 2, bz = 1.2 + b * BENCH_DZ + BENCH_DZ / 2;
        g.add(at(box(r.len + 1.6, 0.02, 4.9, mat(0x34495e, { roughness: 1 }), { cast: false }), bx, 0.17, bz));
        g.add(at(buildBench(r.len), bx, 0.1, bz));
        for (const side of [-1, 1]) {
          for (let c = 0; c < SIDE_N; c++) {
            const x = bx - ((SIDE_N - 1) * SEAT_DX) / 2 + c * SEAT_DX;
            const seat = buildSeat();
            const ez = bz + side * 0.5; // meio do tampo deste lado
            seat.g.rotation.y = side < 0 ? Math.PI : 0;
            g.add(at(seat.g, x, 0.1, ez));
            const st = {
              ...seat, bench: b, side, col: c, owner: null, list: r.seats,
              rot: side < 0 ? Math.PI : 0,
              pos: new THREE.Vector3(wx(x), ELEV + 0.1, wz(ez + side * 1.0)),
              // Do lado de cá, contorna a bancada pela ponta mais próxima.
              via: [
                new THREE.Vector3(wx(c < SIDE_N / 2 ? bx - r.len / 2 - 0.9 : bx + r.len / 2 + 0.9), ELEV + 0.1, wz(ez + side * 1.9)),
                new THREE.Vector3(wx(x), ELEV + 0.1, wz(ez + side * 1.9)),
              ],
            };
            const doorIn = Object.assign(new THREE.Vector3(wx(r.w / 2), ELEV + 0.1, wz(r.d - 0.6)), { door: true });
            st.entry = [
              new THREE.Vector3(wx(r.w / 2), ELEV + 0.1, wz(r.d + 0.8)),
              doorIn,
              new THREE.Vector3(st.via[0].x, ELEV + 0.1, doorIn.z),
              ...st.via,
            ];
            seat.g.userData.isDesk = true;
            seat.g.userData.seat = st;
            r.seats.push(st);
          }
        }
      }
    }

    // Copa: cantos de conversa alternando sofás e mesas altas.
    // Copa (quem ainda não trabalhou hoje) e Descanso (quem já voltou de alguma tarefa hoje).
    for (const [L, title, cls, colors] of [
      [p.lounge, `☕ Copa · ainda não trabalharam hoje (<span data-zone="fresh">0</span>)`, "", [0x3f6e8c, 0x8c5a3f]],
      [p.rest, `🛋️ Descanso · já trabalharam hoje (<span data-zone="rest">0</span>)<span data-zone="review" data-prefix=" · 👀 " data-suffix=" em revisão"></span>`, "rest", [0x6d5a8c, 0x4f7a6a]],
    ]) {
      const lg = add(new THREE.Group());
      lg.position.set(L.x, 0, L.z);
      lg.add(at(box(L.w, 0.06, L.d, floorMat(THEME.copa, L.w, L.d, 3), { cast: false }), L.w / 2, 0.13, L.d / 2));
      for (let z = 2.5; z < L.d - 1.5; z += 3.5) lg.add(at(plant(1.7), 0.7, 0.1, z), at(plant(1.7), L.w - 0.7, 0.1, z));
      const bar = L.kind === "lounge" && kit("kitchenBar", 2);
      if (L.kind !== "lounge") {
        // Descanso: estante, luminárias e tapete; sem cozinha.
        lg.add(at(kit("bookcaseOpen", 1.4) ?? new THREE.Group(), 1.1, 0.1, 0.5), at(kit("bookcaseOpen", 1.4) ?? new THREE.Group(), L.w - 1.1, 0.1, 0.5));
        lg.add(at(kit("lampSquareFloor", 0.3) ?? new THREE.Group(), L.w / 2, 0.1, 0.6));
        lg.add(at(box(L.w - 2.4, 0.02, L.d - 3, mat(0x7b6a8f, { roughness: 1 }), { cast: false }), L.w / 2, 0.16, L.d / 2 + 0.3));
      } else if (bar) {
        const n = Math.max(1, Math.floor((L.w - 6) / 2));
        for (let i = 0; i < n; i++) lg.add(at(kit("kitchenBar", 2), 3 + i * 2, 0.1, 0.6));
        lg.add(at(kit("kitchenCoffeeMachine", 0.75) ?? new THREE.Group(), 3, 0.1 + kitHeight("kitchenBar", 2), 0.6));
        lg.add(at(kit("kitchenFridgeLarge", 1.6) ?? new THREE.Group(), L.w - 1.6, 0.1, 0.7));
        lg.add(at(kit("bookcaseOpen", 1.4) ?? new THREE.Group(), 1.1, 0.1, 0.5));
      } else {
        lg.add(at(box(L.w - 2, 1, 0.8, mat(0xf4f1ea)), L.w / 2, 0.6, 0.6)); // balcão
        lg.add(at(box(0.7, 0.9, 0.5, mat(0x263238)), 2, 1.55, 0.6)); // máquina de café
        lg.add(at(box(1.2, 2.2, 0.9, mat(0xdfe6ea)), L.w - 1.4, 1.2, 0.6)); // geladeira
      }
      lg.add(at(plant(1.2), 0.8, 0.1, L.d - 0.8), at(plant(1.2), L.w - 0.8, 0.1, L.d - 0.8));
      lg.add(label(title, `zone-label ${cls}`, L.w / 2, 0.3, L.d + 0.3));
      L.spots = [];
      for (let s = 0; s < L.sets; s++) {
        const cx = 1 + (s % L.cols) * SET + SET / 2;
        const cz = 2 + Math.floor(s / L.cols) * SET + SET / 2;
        const sofaSet = s % 2 === 0;
        if (sofaSet) {
          lg.add(at(box(1.4, 0.4, 0.8, mat(0x5d4037)), cx, 0.3, cz));
          for (const side of [-1, 1]) {
            const so = sofa(side < 0 ? colors[0] : colors[1]);
            so.position.set(cx, 0.1, cz + side * 1.35);
            so.rotation.y = side < 0 ? Math.PI : 0;
            lg.add(so);
          }
          for (const [ox, side] of [[-0.6, -1], [0.6, -1], [-0.6, 1], [0.6, 1]]) {
            L.spots.push({ x: L.x + cx + ox, z: L.z + cz + side * 1.25, rot: side < 0 ? Math.PI : 0, kind: "sofa" });
          }
        } else {
          const table = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 20), mat(0xf4f1ea));
          const kt = kit("tableRound", 1.3);
          if (kt) lg.add(at(kt, cx, 0.1, cz), at(kit("rugRound", 3.2) ?? new THREE.Group(), cx, 0.12, cz));
          else lg.add(at(table, cx, 1.15, cz), at(box(0.1, 1.1, 0.1, mat(0x37474f)), cx, 0.6, cz));
          for (const [ox, oz] of [[0, -1.05], [1.05, 0], [0, 1.05], [-1.05, 0]]) {
            L.spots.push({ x: L.x + cx + ox, z: L.z + cz + oz, rot: Math.atan2(ox, oz), kind: "chat" });
          }
        }
      }
    }

    // Recepção.
    const R = p.reception;
    const rg = add(new THREE.Group());
    rg.position.set(R.x, 0, R.z);
    rg.add(at(box(R.w, 0.06, R.d, floorMat(THEME.reception, R.w, R.d, 2), { cast: false }), R.w / 2, 0.13, R.d / 2));
    rg.add(at(box(5, 1.1, 1, mat(0x0b3d5c)), R.w / 2, 0.65, R.d / 2 - 1));
    if (main) {
      const b = makeBoard(8.6, 4.5);
      rg.add(at(b.mesh, R.w / 2, 2.85, 0.3));
      boards.push(b);
      drawBoard();
    }
    rg.add(at(plant(1.4), 1, 0.1, 1), at(plant(1.4), R.w - 1, 0.1, 1));
    rg.add(at(sofa(0x9e9e9e), 2.2, 0.1, R.d - 2.2));
    rg.add(label("🛎️ Recepção", "zone-label", R.w / 2, 0.3, R.d + 0.3));

    // Sala de pendências (bloqueados) em volta da mesa.
    // Sala de reunião: mesa oval de madeira, cadeiras em volta e telão com a pauta.
    // Uma sala por reunião aberta (no mínimo uma): conversas diferentes não se misturam.
    for (const [ci, C] of p.confs.entries()) {
      const cg = add(new THREE.Group());
      cg.position.set(C.x, 0, C.z);
      cg.add(at(box(C.w, 0.06, C.d, floorMat(THEME.conf, C.w, C.d, 2), { cast: false }), C.w / 2, 0.13, C.d / 2));
      cg.add(at(box(C.w - 1.2, 0.02, C.d - 2.4, mat(0x6d5a4b, { roughness: 1 }), { cast: false }), C.w / 2, 0.17, C.d / 2 + 0.4)); // tapete
      {
        const gm = glass();
        for (const [w, d, x, z] of [[C.w, 0.08, C.w / 2, 0], [0.08, C.d, 0, C.d / 2], [0.08, C.d, C.w, C.d / 2]]) cg.add(at(box(w, 2.4, d, gm, { cast: false }), x, 1.3, z));
        const half = (C.w - 2.2) / 2;
        cg.add(at(box(half, 2.4, 0.08, gm, { cast: false }), half / 2, 1.3, C.d));
        cg.add(at(box(half, 2.4, 0.08, gm, { cast: false }), C.w - half / 2, 1.3, C.d));
      }
      const tcx = C.w / 2, tcz = C.d / 2 + 0.4;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.08, 48), mat(0x8d6748, { roughness: 0.35 }));
      top.scale.set(3.7, 1, 1.25);
      top.castShadow = true;
      cg.add(at(top, tcx, 1.0, tcz));
      for (const dx of [-2, 2]) cg.add(at(box(0.25, 0.95, 0.9, mat(0x2a2e36, { metalness: 0.5 })), tcx + dx, 0.5, tcz));
      for (const dx of [-1.6, 0, 1.6]) cg.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 12), mat(0x263238)), tcx + dx, 1.13, tcz)); // microfones/hub
      cg.add(at(plant(1.2), 0.8, 0.1, C.d - 0.8), at(plant(1.2), C.w - 0.8, 0.1, C.d - 0.8));
      C.board = makeBoard(5.6, 3.15);
      cg.add(at(C.board.mesh, tcx, 2.35, 0.3));
      C.board.sig = "";
      C.board.mesh.userData.isBoard = false;
      C.board.mesh.userData.isConf = true;
      confBoards.push(C.board);
      cg.add(label(`🤝 Sala de reunião${p.confs.length > 1 ? ` ${ci + 1}` : ""}`, "zone-label conf", C.w / 2, 0.3, C.d + 0.3));
      const W0 = (x, z) => new THREE.Vector3(ox - p.W / 2 + C.x + x, ELEV + 0.1, oz - p.D / 2 + C.z + z);
      const confEntry = [W0(C.w / 2, C.d + 0.8), W0(C.w / 2, C.d - 0.6)];
      C.spots = [];
      const seat = (x, z, rot) => {
        cg.add(at(kit("chairDesk", 0.95, rot + Math.PI) ?? officeChair(), x, 0, z));
        C.spots.push({ x: C.x + x, z: C.z + z, rot, kind: "meet", entry: confEntry });
      };
      for (let c = 0; c < 4; c++) {
        seat(tcx - 2.4 + c * 1.6, tcz - 1.75, Math.PI); // lado de lá, de frente para a câmera
        seat(tcx - 2.4 + c * 1.6, tcz + 1.75, 0);
      }
      seat(tcx - 4.4, tcz, -Math.PI / 2);
      seat(tcx + 4.4, tcz, Math.PI / 2);
    }

    const M = p.meeting;
    const mg = add(new THREE.Group());
    mg.position.set(M.x, 0, M.z);
    mg.add(at(box(M.w, 0.06, M.d, floorMat(THEME.pend, M.w, M.d), { cast: false }), M.w / 2, 0.13, M.d / 2));
    mg.add(at(plant(1.1), 0.7, 0.1, 0.7), at(plant(1.1), M.w - 0.7, 0.1, 0.7));
    const gm = glass();
    for (const [w, d, x, z] of [[M.w, 0.08, M.w / 2, 0], [0.08, M.d, 0, M.d / 2], [0.08, M.d, M.w, M.d / 2]]) mg.add(at(box(w, 2.4, d, gm, { cast: false }), x, 1.3, z));
    const tableLen = (M.cap / 2) * 1.5;
    mg.add(at(box(tableLen, 0.1, 2, mat(0x4e342e)), M.w / 2, 1.0, M.d / 2));
    mg.add(at(box(tableLen * 0.8, 0.95, 0.3, mat(0x3e2723)), M.w / 2, 0.5, M.d / 2));
    mg.add(at(box(3.5, 2, 0.1, mat(0xffffff, { emissive: 0x330000, emissiveIntensity: 0.4 })), M.w / 2, 2.2, 0.2)); // quadro
    mg.add(label(`🚧 Pendências · bloqueados (<span data-zone="blocked">0</span>)`, "zone-label blocked", M.w / 2, 0.3, M.d + 0.3));
    M.spots = [];
    for (let i = 0; i < M.cap; i++) {
      const side = i % 2 ? 1 : -1;
      const col = Math.floor(i / 2);
      M.spots.push({ x: M.x + M.w / 2 - tableLen / 2 + 0.75 + col * 1.5, z: M.z + M.d / 2 + side * 1.6, rot: side < 0 ? Math.PI : 0, kind: "meeting" });
    }

    // Desligados: pufes numa sala escura.
    const S = p.sleep;
    const sg = add(new THREE.Group());
    sg.position.set(S.x, 0, S.z);
    sg.add(at(box(S.w, 0.06, S.d, floorMat(THEME.off, S.w, S.d), { cast: false }), S.w / 2, 0.13, S.d / 2));
    sg.add(label(`💤 Desligados · máquina offline (<span data-zone="offline">0</span>)`, "zone-label offline", S.w / 2, 0.3, S.d + 0.3));
    S.spots = [];
    for (let i = 0; i < S.cap; i++) {
      const x = 1.6 + (i % S.cols) * 1.8, z = 1.6 + Math.floor(i / S.cols) * 1.8;
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), mat(0x5e548e));
      puff.scale.y = 0.55;
      sg.add(at(puff, x, 0.35, z));
      S.spots.push({ x: S.x + x, z: S.z + z + 0.1, rot: Math.PI, kind: "sleep" });
    }

    // Dormitório das tarefas agendadas: cada agente dormindo numa cama, com um
    // despertador e um balão mostrando a próxima execução.
    if (p.dorm) {
      const Dm = p.dorm;
      const dg = add(new THREE.Group());
      dg.position.set(Dm.x, 0, Dm.z);
      dg.add(at(box(Dm.w, 0.06, Dm.d, floorMat(THEME.dorm, Dm.w, Dm.d), { cast: false }), Dm.w / 2, 0.13, Dm.d / 2));
      const gm = glass();
      for (const [w, d, x, z] of [[Dm.w, 0.08, Dm.w / 2, 0], [0.08, Dm.d, 0, Dm.d / 2], [0.08, Dm.d, Dm.w, Dm.d / 2]]) dg.add(at(box(w, 2.4, d, gm, { cast: false }), x, 1.3, z));
      // luz noturna (abajur azul) e tapete
      dg.add(at(kit("rugRectangle", Dm.w - 1.5) ?? new THREE.Group(), Dm.w / 2, 0.14, Dm.d / 2));
      const dl = label(`😴 Dormitório · tarefas agendadas (${Dm.n})`, "zone-label dorm", Dm.w / 2, 0.3, Dm.d + 0.3);
      dl.element.title = "Aproximar do dormitório";
      dl.element.addEventListener("click", () => focusDorm());
      dg.add(dl);
      dormCenter = new THREE.Vector3(ox - p.W / 2 + Dm.x + Dm.w / 2, ELEV, oz - p.D / 2 + Dm.z + Dm.d / 2);
      for (let i = 0; i < Dm.n; i++) {
        const bx = 1.25 + (i % Dm.cols) * BED_DX + BED_DX / 2, bz = 1.4 + Math.floor(i / Dm.cols) * BED_DZ;
        const bed = new THREE.Group();
        bed.position.set(bx, 0.1, bz);
        const kb = kit("bedSingle", 1.5);
        if (kb) bed.add(kb);
        else {
          bed.add(at(box(1.4, 0.45, 2.6, mat(0x8d6e63)), 0, 0.25, 0));
          bed.add(at(box(1.3, 0.2, 2.4, mat(0xf4f1ea)), 0, 0.55, 0));
        }
        // quem dorme: cobertor na cor do agente, cabeça no travesseiro
        const blanket = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.22, 1.6), mat(0x8d9bb5, { roughness: 0.9 }));
        bed.add(at(blanket, 0, 0.72, 0.35));
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 18, 14), mat(0xf1c9a5, { roughness: 0.6 }));
        bed.add(at(head, 0, 0.82, -0.75));
        const hair = new THREE.Mesh(new THREE.SphereGeometry(0.285, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), mat(0x2b1b0e));
        hair.rotation.x = -1.3;
        bed.add(at(hair, 0, 0.82, -0.78));
        // criado-mudo com despertador
        const night = kit("sideTable", 0.55);
        bed.add(at(night ?? box(0.5, 0.5, 0.5, mat(0xa07850)), 0.95, 0, -1.05));
        const clock = new THREE.Group();
        const face = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 20), mat(0xd32f2f, { roughness: 0.4 }));
        face.rotation.x = Math.PI / 2;
        clock.add(face);
        clock.add(at(new THREE.Mesh(new THREE.CircleGeometry(0.13, 20), mat(0xffffff, { emissive: 0xffffff, emissiveIntensity: 0.4 })), 0, 0, 0.051));
        for (const s of [-1, 1]) clock.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffc107, { metalness: 0.6, roughness: 0.3 })), s * 0.11, 0.16, 0));
        clock.position.set(0.95, 0.72, -1.05);
        bed.add(clock);
        // balão com a próxima execução
        const el = document.createElement("div");
        el.className = "alarm";
        const tag = new CSS2DObject(el);
        tag.userData.isLabel = true;
        tag.position.set(0.95, 1.35, -1.05);
        bed.add(tag);
        el.addEventListener("click", () => bed.userData.schedId && onSelectSchedule(bed.userData.schedId));
        dg.add(bed);
        dormBeds.push({ bed, blanket, head, clock, el, idx: i });
      }
      updateDorm();
    }

    // Árvores na praça da torre (o resto da orla vem de rio.js).
    for (let z = 6; z < p.D; z += 12) tower.add(at(tree(), -10, 0, z));

    // Nome do prédio sobre a fachada, visível de dentro também.
    if (name) {
      const bl = label(`🏢 ${esc(name)} · ${count} agente${count === 1 ? "" : "s"}`, "zone-label building", p.W / 2, WALL_H + 1.5, p.D + 0.6);
      bl.element.title = "Entrar neste prédio";
      bl.element.addEventListener("click", () => {
        const key = site && sites.find((s) => s.name === name)?.key;
        if (key) {
          focusKey = key;
          host.classList.remove("overview");
          setMode("interior");
        }
      });
      site.add(bl);
    }
  }

  // ---------- Central de Agendamentos (prédio anexo) ----------

  function wrap(x, text, maxW, maxLines) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (x.measureText(t).width > maxW && cur) {
        lines.push(cur);
        cur = w;
        if (lines.length === maxLines) break;
      } else cur = t;
    }
    if (lines.length < maxLines && cur) lines.push(cur);
    if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) lines[maxLines - 1] = `${lines[maxLines - 1].replace(/.{2}$/, "")}…`;
    return lines;
  }

  function podColor(s) {
    if (s.status !== "active") return "#7b8496";
    if (s.lastRun?.status === "failed" && !s.lastRun.acked) return "#ef5350";
    return "#2ec4b6";
  }

  function drawPod(pod, s) {
    const x = pod.canvas.getContext("2d");
    const { width: w, height: h } = pod.canvas;
    x.fillStyle = "#081627";
    x.fillRect(0, 0, w, h);
    x.fillStyle = podColor(s);
    x.fillRect(0, 0, w, 10);
    const agent = data?.agents.find((a) => a.id === s.agentId);
    x.font = "54px system-ui, sans-serif";
    x.fillText(agent?.emoji ?? "🤖", 20, 76);
    x.fillStyle = "#ffffff";
    x.font = "bold 30px system-ui, sans-serif";
    wrap(x, s.title, w - 110, 2).forEach((l, i) => x.fillText(l, 92, 52 + i * 34));
    x.fillStyle = "#8fb3d1";
    x.font = "22px system-ui, sans-serif";
    x.fillText((agent?.name ?? "—").slice(0, 40), 22, 150);
    const next = s.status === "active" && s.nextRunAt
      ? new Date(s.nextRunAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "pausada";
    x.fillStyle = podColor(s);
    x.font = "bold 30px ui-monospace, monospace";
    x.fillText(s.status === "active" ? `⏰ ${next}` : "⏸ pausada", 22, 200);
    if (s.lastRun) {
      x.fillStyle = s.lastRun.status === "failed" && !s.lastRun.acked ? "#ff8a80" : "#7ee2a8";
      x.font = "20px system-ui, sans-serif";
      x.fillText(`última: ${s.lastRun.status === "failed" ? (s.lastRun.acked ? "falhou (arquivada)" : "falhou") : s.lastRun.status === "completed" ? "ok" : s.lastRun.status}`, 22, 236);
    }
    pod.tex.needsUpdate = true;
  }

  // Prédio da Central de Agendamentos removido a pedido (2026-10-21): as agendadas
  // seguem na aba "Agendadas", na Agenda e na TV da recepção.
  const SHOW_ANNEX = false;
  function buildAnnex() {
    if (!layout || !SHOW_ANNEX) return;
    const list = schedules;
    const key = JSON.stringify([bounds.x1, list.map((s) => [s.id, s.status, s.nextRunAt, s.lastRun?.status, s.lastRun?.acked, s.agentId, s.title])]);
    if (key === annexKey) return;
    const sameShape = annex && annex.x0 === bounds.x1 + ANNEX_GAP && annex.pods.length === list.length && annex.pods.every((p, i) => p.id === list[i].id);
    annexKey = key;
    if (sameShape) {
      annex.pods.forEach((p, i) => {
        p.sched = list[i];
        drawPod(p, list[i]);
        p.ringMat.color.set(podColor(list[i]));
      });
      return;
    }
    if (annex) {
      annex.group.traverse((o) => o.userData.isLabel && o.element.remove());
      scene.remove(annex.group);
      walls.exterior = walls.exterior.filter((w) => !w.userData.annex);
      walls.roof = walls.roof.filter((w) => !w.userData.annex);
    }
    const n = Math.max(1, list.length);
    const cols = Math.ceil(Math.sqrt(n * 1.3));
    const rows = Math.ceil(n / cols);
    const w = cols * POD + 6, d = rows * POD + 8;
    const x0 = bounds.x1 + ANNEX_GAP;
    const g = new THREE.Group();
    g.position.set(x0, 0, -d / 2);
    scene.add(g);
    const trim = mat(0x0b3d5c);
    const tex = rio.windowTextures(Math.max(2, Math.round(w / 3.2)), 7, 0.5, 31);
    const fm = new THREE.MeshStandardMaterial({ map: tex.map, emissiveMap: tex.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.35, metalness: 0.1 });
    rio.cityMats.push([fm, 1.1]);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(w, ELEV - 5, d), [fm, fm, mat(0x8d969e), mat(0x8d969e), fm, fm]);
    shaft.position.set(w / 2, 5 + (ELEV - 5) / 2, d / 2);
    shaft.castShadow = shaft.receiveShadow = true;
    g.add(shaft);
    g.add(at(box(w - 6, 5, d - 6, glass(), { cast: false }), w / 2, 2.5, d / 2));
    for (let x = 3; x <= w - 3; x += 8) for (const z of [3, d - 3]) g.add(at(box(0.9, 5, 0.9, mat(0xe9e5dc)), x, 2.5, z));
    // Andar da Central, na mesma altura da cobertura, com passarela de vidro.
    const floorY = ELEV;
    g.add(at(box(w + 1, 0.6, d + 1, mat(0x1d2a40), { cast: false }), w / 2, floorY - 0.2, d / 2));
    const bridge = new THREE.Group();
    bridge.add(at(box(ANNEX_GAP, 0.4, 5, mat(0xd9d4c8)), 0, 0, 0));
    bridge.add(at(box(ANNEX_GAP, 3, 0.1, glass(), { cast: false }), 0, 1.6, 2.5), at(box(ANNEX_GAP, 3, 0.1, glass(), { cast: false }), 0, 1.6, -2.5));
    bridge.add(at(box(ANNEX_GAP, 0.25, 5.2, trim), 0, 3.2, 0));
    bridge.position.set(-ANNEX_GAP / 2, floorY, d / 2);
    g.add(bridge);
    const curtain = glass();
    curtain.opacity = 0.1;
    const wallSeg = (x1, z1, x2, z2, facade) => {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const ws = new THREE.Group();
      ws.position.set((x1 + x2) / 2, floorY, (z1 + z2) / 2);
      ws.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      ws.add(at(box(len, WALL_H, 0.1, curtain, { cast: false }), 0, WALL_H / 2, 0));
      ws.add(at(box(len + 0.4, 0.45, 0.45, trim), 0, WALL_H, 0));
      const k = Math.max(1, Math.round(len / 3.2));
      for (let i = 0; i <= k; i++) ws.add(at(box(0.14, WALL_H, 0.18, mat(0x2b3440), { cast: false }), -len / 2 + (i * len) / k, WALL_H / 2, 0));
      ws.userData.annex = true;
      g.add(ws);
      if (facade) walls.exterior.push(ws);
    };
    wallSeg(0, 0, w, 0, false);
    wallSeg(w, 0, w, d, true);
    wallSeg(0, d, w, d, true);
    wallSeg(0, 0, 0, d / 2 - 2.6, false);
    wallSeg(0, d / 2 + 2.6, 0, d, false);
    const roof = new THREE.Group();
    roof.userData.annex = true;
    roof.add(at(box(w + 1.2, 0.5, d + 1.2, mat(0x9aa3ad)), w / 2, floorY + WALL_H + 0.25, d / 2));
    const signTex = signTexture(["⏰ Central", "Tarefas agendadas"]);
    roof.add(at(new THREE.Mesh(new THREE.BoxGeometry(Math.min(w - 2, 18), 4, 0.4), [trim, trim, trim, trim,
      new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.55 }), trim]), w / 2, floorY + WALL_H + 2.8, d - 0.4));
    g.add(roof);
    walls.roof.push(roof);
    g.add(label(`⏰ Central de Agendamentos · ${list.length} tarefas`, "zone-label annex", w / 2, floorY + 0.3, d + 0.4));

    // Quiosques: tela com a tarefa, holograma do agente e anel de status.
    const pods = list.map((s, i) => {
      const pg = new THREE.Group();
      pg.userData.schedId = s.id;
      pg.position.set(3 + (i % cols) * POD + POD / 2, floorY, 4 + Math.floor(i / cols) * POD + POD / 2);
      pg.add(at(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.2, 28), mat(0x24324c)), 0, 0.1, 0));
      const ringMat = new THREE.MeshBasicMaterial({ color: podColor(s), transparent: true, opacity: 0.85 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.08, 8, 40), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.24;
      pg.add(ring);
      pg.add(at(box(0.25, 1.6, 0.25, mat(0x37474f)), 0, 0.95, -0.6));
      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = 256;
      const ptex = new THREE.CanvasTexture(canvas);
      ptex.colorSpace = THREE.SRGBColorSpace;
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshBasicMaterial({ map: ptex, toneMapped: false, side: THREE.DoubleSide }));
      screen.position.set(0, 2.4, -0.6);
      screen.rotation.x = -0.25;
      pg.add(screen);
      const agent = data?.agents.find((a) => a.id === s.agentId);
      const holo = new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(hueOf(agent?.name ?? s.title), 0.6, 0.6), transparent: true, opacity: 0.55,
        emissive: new THREE.Color().setHSL(hueOf(agent?.name ?? s.title), 0.7, 0.35), emissiveIntensity: 0.8,
      });
      const fig = new THREE.Group();
      fig.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.45, 4, 10), holo), 0, 0.75, 0));
      fig.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), holo), 0, 1.3, 0));
      fig.position.set(0.9, 0.2, 0.5);
      fig.rotation.y = -0.5;
      pg.add(fig);
      g.add(pg);
      const pod = { id: s.id, sched: s, group: pg, canvas, tex: ptex, ring, ringMat, fig };
      drawPod(pod, s);
      return pod;
    });
    annex = { group: g, x0, w, d, pods };
    // Sombra cobrindo as duas torres.
    const right = x0 + w;
    shadowSpan = Math.max(right + layout.W / 2, layout.D) * 0.62 + 25;
    sun.target.position.set((right - layout.W / 2) / 2, ELEV * 0.6, 0);
    Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan, far: shadowSpan * 6 });
    sun.shadow.camera.updateProjectionMatrix();
    rio.refresh();
    applyMode();
  }

  function applyMode() {
    const inside = mode !== "facade";
    for (const w of walls.exterior) w.visible = !inside;
    for (const r of walls.roof) r.visible = !inside;
    scene.traverse((o) => {
      if (o.userData.isLabel) o.visible = inside;
    });
  }

  function cameraFor(m) {
    const { W, D } = layout;
    const size = Math.max(W, D);
    const fit = (s) => (s / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.min(1, camera.aspect);
    const left = bounds.x0;
    const front = bounds.z1;
    if (m === "facade") {
      // Do mar, olhando os prédios com o Pão de Açúcar e o Cristo ao fundo.
      const right = annex ? annex.x0 + annex.w : bounds.x1;
      const cx = (left + right) / 2;
      const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      const dist = ((right - left) * 0.62) / Math.tan(hfov / 2);
      const depth = bounds.z1 - bounds.z0;
      return { target: new THREE.Vector3(cx, ELEV * 0.8, (bounds.z0 + bounds.z1) / 2), cam: new THREE.Vector3(cx + (right - left) * 0.18, ELEV * 0.45 + 4 + depth * 0.25, front + dist * 1.15) };
    }
    if (m === "interior" && sites.length > 1) {
      const fs = sites.find((s) => s.key === focusKey);
      if (fs) {
        const dist = fit(Math.max(fs.p.W, fs.p.D));
        return { target: new THREE.Vector3(fs.ox, ELEV, fs.oz - 6), cam: new THREE.Vector3(fs.ox, ELEV + dist * 0.5, fs.oz + dist * 0.86) };
      }
      const cx = (bounds.x0 + bounds.x1) / 2, cz = (bounds.z0 + bounds.z1) / 2;
      const dist = fit(Math.max(bounds.x1 - bounds.x0, (bounds.z1 - bounds.z0) * 1.3));
      return { target: new THREE.Vector3(cx, ELEV, cz), cam: new THREE.Vector3(cx, ELEV + dist * 0.7, cz + dist * 0.75) };
    }
    if (m === "annex" && annex) {
      const cx = annex.x0 + annex.w / 2;
      const dist = fit(Math.max(annex.w, annex.d) * 1.15);
      return { target: new THREE.Vector3(cx, ELEV, 0), cam: new THREE.Vector3(cx, ELEV + dist * 0.62, dist * 0.82) };
    }
    const dist = (size / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.min(1, camera.aspect);
    // Um pouco mais baixo que vista de cima, para a baía aparecer no horizonte.
    const s0 = sites[0] ?? { ox: 0, oz: 0 };
    // Mais perto e mais de cima: dá para ver quem trabalha e ler os balões.
    const hfovI = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
    const d2 = Math.max((W * 0.56) / Math.tan(hfovI / 2), dist * 0.5);
    return { target: new THREE.Vector3(s0.ox, ELEV, s0.oz), cam: new THREE.Vector3(s0.ox, ELEV + d2 * 0.86, s0.oz + d2 * 0.5) };
  }

  function fly(target, cam) {
    flight = { from: controls.target.clone(), to: target, camFrom: camera.position.clone(), camTo: cam, t: 0 };
  }

  function setMode(m, animate = true) {
    mode = m;
    applyMode();
    if (!layout) return;
    const v = cameraFor(m);
    if (animate) fly(v.target, v.cam);
    else {
      controls.target.copy(v.target);
      camera.position.copy(v.cam);
    }
  }

  const groupKey = (a) => (campus.groupBy === "runtime" ? `${a.machine} · ${a.provider}` : a.machine);
  const groupName = (k) => (campus.groupBy === "runtime" ? k.replace(/^(.*) · (.*)$/, "$2 · $1") : k);

  /** Prédios a montar: a sede (todos), um por máquina/runtime (bairro) ou só um. */
  function groupsOf(d) {
    const base = viewOf(d);
    if (campus.mode === "sede") return [{ key: "sede", name: null, vis: base, compact: false }];
    const keys = campus.mode === "um" ? [campus.key] : [...new Set(base.agents.map(groupKey))];
    return keys
      .map((k) => {
        const agents = base.agents.filter((a) => groupKey(a) === k);
        const machines = unified ? base.machines : d.machines.filter((m) => agents.some((a) => a.machine === m.name));
        return { key: k, name: groupName(k), vis: { agents, machines }, compact: campus.mode === "bairro" };
      })
      .filter((g) => g.vis.agents.length || campus.mode === "um")
      .sort((a, b) => b.vis.agents.length - a.vis.agents.length);
  }

  /** Agentes que entram na planta: os do filtro, por máquina ou num escritório único. */
  function viewOf(d) {
    const agents = d.agents.filter((a) => !filterIds || filterIds.has(a.id));
    if (unified) return { agents: agents.map((a) => ({ ...a, machine: UNIFIED })), machines: [{ name: UNIFIED, online: true }] };
    return { agents, machines: d.machines };
  }

  /** Clique no rótulo: num item de trabalho abre o detalhe dele; no resto, o agente. */
  function tagClick(e, agentId) {
    const it = e.target.closest?.("[data-wrun]");
    if (it && (it.dataset.wrun || it.dataset.wissue)) {
      e.stopPropagation();
      return onWork({ runId: it.dataset.wrun, issueId: it.dataset.wissue, agentId });
    }
    onSelect(agentId);
  }

  /** Reuniões abertas com pelo menos um participante nesta visão (até CONF_MAX salas). */
  function meetingsOf(vis) {
    const ids = new Set(vis.agents.map((a) => a.id));
    return (data?.meetings ?? []).filter((m) => m.agents.some((id) => ids.has(id))).slice(0, 50);
  }

  /** Para onde cada agente vai, conforme o estado. */
  function assignSpots() {
    const out = new Map();
    for (const s of sites) for (const C of s.p.confs ?? []) {
      C.meeting = null;
      for (const sp of C.spots ?? []) sp.taken = false;
    }
    const groups = groupsOf(data);
    for (const s of sites) {
      const g = groups.find((x) => x.key === s.key);
      if (!g) continue;
      const cz = s.oz - s.p.D / 2 + s.p.corridorZ;
      const x0 = s.ox - s.p.W / 2, z0 = s.oz - s.p.D / 2;
      const lane = z0 + s.p.D - 1.3; // faixa livre entre as salas e a borda da frente
      const R = s.p.reception;
      const lobby = new THREE.Vector3(x0 + R.x + R.w / 2, ELEV + 0.1, z0 + R.z + R.d - 1.2);
      const toWorld = (sp) => ({ ...sp, cz, lane, lobby, pos: new THREE.Vector3(x0 + sp.x, ELEV + 0.1, z0 + sp.z) });
      // Cada reunião na sua própria sala (a partir da 7ª, dividem a última).
      const inMeeting = new Set();
      meetingsOf(g.vis).forEach((m, mi) => {
        const C = s.p.confs[Math.min(mi, s.p.confs.length - 1)];
        C.meeting = m;
        let ci = C.spots.findIndex((sp) => !sp.taken);
        const people = m.agents.map((id) => g.vis.agents.find((a) => a.id === id)).filter((a) => a && a.state !== "offline" && !inMeeting.has(a.id));
        people.forEach((a, k) => {
          if (ci < 0 || !C.spots[ci]) return;
          C.spots[ci].taken = true;
          out.set(a.id, { ...toWorld(C.spots[ci]), meeting: m.id, talkIdx: k, talkN: people.length });
          ci++;
          inMeeting.add(a.id);
        });
      });
      const by = (state) =>
        g.vis.agents
          .filter((a) => a.state === state && !inMeeting.has(a.id))
          .sort((a, b) => (a.squad ?? "~").localeCompare(b.squad ?? "~") || a.name.localeCompare(b.name));
      // Quem já tem cadeira fica nela; quem chega senta no primeiro lugar livre (ao lado dos outros).
      const seats = s.p.rooms[0].seats ?? [];
      for (const st of seats) st.owner = null;
      const arriving = [];
      const working = by("working").sort((a, b) => String(a.work?.[0]?.startedAt ?? "~").localeCompare(String(b.work?.[0]?.startedAt ?? "~")) || a.name.localeCompare(b.name));
      for (const a of working) {
        const i = seatOf.get(a.id);
        if (i !== undefined && seats[i] && !seats[i].owner) seats[i].owner = a.id;
        else arriving.push(a);
      }
      for (const a of arriving) {
        const i = seats.findIndex((st) => !st.owner);
        if (i < 0) break;
        seats[i].owner = a.id;
        seatOf.set(a.id, i);
      }
      for (const st of seats) if (st.owner) out.set(st.owner, { pos: st.pos.clone(), rot: st.rot, kind: "desk", cz, lane, lobby, seat: st, entry: st.entry });
      const idle = by("idle");
      idle.filter((a) => !workedToday(a)).forEach((a, i) => s.p.lounge.spots[i] && out.set(a.id, toWorld(s.p.lounge.spots[i])));
      idle.filter(workedToday).forEach((a, i) => s.p.rest.spots[i] && out.set(a.id, toWorld(s.p.rest.spots[i])));
      by("blocked").forEach((a, i) => s.p.meeting.spots[i] && out.set(a.id, toWorld(s.p.meeting.spots[i])));
      by("offline").forEach((a, i) => s.p.sleep.spots[i] && out.set(a.id, toWorld(s.p.sleep.spots[i])));
    }
    for (const id of seatOf.keys()) if (out.get(id)?.kind !== "desk") seatOf.delete(id);
    return out;
  }

  let modelsOk = false;
  let pending = null;
  Promise.all([modelsLoading, logoLoaded]).then(() => {
    modelsOk = true;
    if (pending) update(pending);
  });

  function update(next) {
    if (!modelsOk) {
      pending = next;
      return;
    }
    data = next;
    vis = viewOf(data);
    const groups = groupsOf(data);
    const key = JSON.stringify([
      campus,
      groups.map((g) => [g.key, g.vis.agents.map((a) => a.id)]),
      vis.agents.map((a) => [a.id, a.machine, a.squad]),
      groups.map((g) => Math.max(1, Math.ceil(g.vis.agents.filter((a) => a.state === "working").length / BENCH_N))),
      vis.machines.map((m) => [m.name, m.online]),
      Math.ceil(vis.agents.filter((a) => a.state === "blocked").length / 8),
      Math.ceil(vis.agents.filter((a) => a.state === "offline").length / 6),
      Math.ceil(vis.agents.filter((a) => a.state === "idle" && !workedToday(a)).length / 8),
      Math.ceil(vis.agents.filter((a) => a.state === "idle" && workedToday(a)).length / 8),
      Math.min(DORM_MAX, (data.schedules ?? []).filter((s) => s.status === "active").length),
      groups.map((g) => Math.min(CONF_MAX, Math.max(1, meetingsOf(g.vis).length))),
    ]);
    const first = !layout;
    if (key !== update.key) {
      update.key = key;
      buildAll(groups);
      // Planta nova: cada avatar vai direto para o novo lugar (sem atravessar paredes que já não existem).
      for (const av of avatars.values()) {
        av.placed = false;
        av.path = [];
      }
      if (first) setMode(mode, false);
      else if (reframe) setMode(mode === "facade" ? "interior" : mode);
      reframe = false;
    }
    // Avatares: cria os novos, remove os que saíram.
    const ids = new Set(data.agents.map((a) => a.id));
    for (const [id, av] of avatars) {
      if (!ids.has(id)) {
        av.tagEl.remove();
        scene.remove(av.g);
        avatars.delete(id);
      }
    }
    const spots = assignSpots();
    for (const a of data.agents) {
      let av = avatars.get(a.id);
      const lookSig = JSON.stringify(a.look ?? null);
      if (av && av.lookSig !== lookSig) {
        av.tagEl.remove();
        scene.remove(av.g);
        const keep = { pos: av.pos.clone(), spot: av.spot, placed: av.placed, lastState: av.lastState };
        av = buildAvatar(a);
        Object.assign(av, keep);
        av.tagEl.addEventListener("click", (e) => tagClick(e, a.id));
        avatars.set(a.id, av);
        scene.add(av.g);
      }
      if (!av) {
        av = buildAvatar(a);
        av.tagEl.addEventListener("click", (e) => tagClick(e, a.id));
        avatars.set(a.id, av);
        scene.add(av.g);
      }
      av.lookSig = lookSig;
      av.agent = a;
      // Mudou de estado enquanto estava fora da planta (filtro): entra a pé quando aparecer.
      const changed = (av.lastState !== undefined && av.lastState !== a.state) || av.walkIn === a.state;
      av.lastState = a.state;
      const spot = spots.get(a.id);
      if (!spot) {
        // Fora do filtro: some da cena até voltar a aparecer.
        if (changed) av.walkIn = a.state;
        av.spot = null;
        av.placed = false;
        av.path = [];
        continue;
      }
      const moved = !av.spot || av.spot.pos.distanceTo(spot.pos) > 0.01;
      const from = av.spot;
      av.spot = spot;
      if (!av.placed) {
        av.placed = true;
        av.walkIn = null;
        if (changed && spot.lobby) {
          // Mudou de estado sem ter de onde vir (planta nova, ou estava fora do filtro): sai do lobby e vai a pé.
          av.pos.copy(spot.lobby);
          av.path = route(null, spot, av.pos);
        } else {
          av.pos.copy(spot.pos);
          av.path = [];
        }
      } else if (moved && spot.lane !== undefined) {
        av.path = route(from, spot, av.pos);
      } else if (moved) {
        av.pos.copy(spot.pos);
      }
      const offline = a.state === "offline";
      av.bodyMat.color.copy(offline ? new THREE.Color(0x777b85) : av.color);
      // Quem trabalha mostra nome e PC; a tarefa fica na lista e no detalhe.
      const html =
        (a.state === "working"
          ? workBubble(a)
          : "") +
        `<div class="em">${a.state === "blocked" ? "⛔" : offline ? "💤" : esc(a.emoji)}</div>` +
        (a.state === "working"
          ? ""
          : `<div class="nm">${esc(a.emoji)} ${esc(a.name)}${a.state === "blocked" ? ` · ${a.blocked.length} bloqueada(s)` : ""}${todayBadge(a)}</div>`);
      if (av.tagEl.dataset.html !== html) {
        av.tagEl.innerHTML = html;
        av.tagEl.dataset.html = html;
      }
      av.tagEl.classList.toggle("selected", a.id === selectedId);
      av.tagEl.classList.toggle("dim", offline);
      av.tagEl.classList.toggle("small", a.state === "idle" || offline);
    }
    drawConf();
    // Monitores acesos só para quem está na mesa trabalhando.
    const byId = new Map(data.agents.map((a) => [a.id, a]));
    for (const s of sites) {
      for (const d of s.p.rooms[0].seats ?? []) {
        const a = d.owner && byId.get(d.owner);
        const on = a?.state === "working";
        const sig = on ? a.id + JSON.stringify(a.work?.[0] ?? null) : "off";
        if (d.sig !== sig) {
          d.sig = sig;
          if (on) drawScreen(d, a);
          d.screenMat.emissiveIntensity = on ? 1.1 : 0;
        }
      }
    }
    const byKey = new Map(groupsOf(data).map((g) => [g.key, g.vis.agents]));
    for (const el of counters) {
      const agents = byKey.get(el.dataset.site) ?? vis.agents;
      if (el.dataset.roomNames !== undefined) {
        const w = agents.filter((a) => a.machine === el.dataset.roomNames && a.state === "working");
        el.textContent = w.length ? ` · ${w.slice(0, 3).map((a) => `${a.emoji} ${a.name.length > 18 ? a.name.slice(0, 17) + "…" : a.name}`).join(", ")}${w.length > 3 ? ` +${w.length - 3}` : ""}` : "";
        continue;
      }
      if (["fresh", "rest", "review"].includes(el.dataset.zone)) {
        const idle = agents.filter((a) => a.state === "idle");
        const n = el.dataset.zone === "fresh" ? idle.filter((a) => !workedToday(a)).length
          : el.dataset.zone === "rest" ? idle.filter(workedToday).length
          : idle.filter(workedToday).reduce((t, a) => t + (a.review ?? 0), 0);
        el.textContent = el.dataset.prefix ? (n ? `${el.dataset.prefix}${n}${el.dataset.suffix ?? ""}` : "") : n;
        continue;
      }
      el.textContent = el.dataset.zone
        ? agents.filter((a) => a.state === el.dataset.zone).length
        : agents.filter((a) => a.machine === el.dataset.room && a.state === "working").length;
    }
    host.classList.toggle("overview", sites.length > 1 && !focusKey);
    applyMode();
  }

  function focus(id) {
    const av = avatars.get(id);
    if (!av) return;
    if (mode !== "interior") {
      mode = "interior";
      applyMode();
    }
    const p = av.pos.clone();
    const offset = new THREE.Vector3(6, 10, 12);
    fly(p, p.clone().add(offset));
  }

  let hlId = null;
  /** Destaca um agente (hover na lista "Trabalhando agora"): etiqueta à frente de tudo. */
  function highlight(id) {
    hlId = id;
    for (const [aid, av] of avatars) av.tagEl.classList.toggle("hl", aid === id);
    declutter();
  }

  function setSelected(id) {
    selectedId = id;
    for (const [aid, av] of avatars) av.tagEl.classList.toggle("selected", aid === id);
  }

  /** Distribui as próximas tarefas agendadas nas camas e atualiza os balões ("em 23 min"). */
  function updateDorm() {
    if (!dormBeds.length) return;
    const next = schedules
      .filter((s) => s.status === "active" && s.nextRunAt)
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, dormBeds.length);
    const now = Date.now();
    const SKIN = [0xf1c9a5, 0xffdbac, 0xe0ac69, 0xd9a066, 0xc68642, 0x8d5524];
    for (const b of dormBeds) {
      const s = next[b.idx];
      b.bed.visible = Boolean(s);
      b.bed.userData.schedId = s?.id ?? null;
      if (!s) continue;
      const ag = data?.agents.find((a) => a.id === s.agentId);
      const h = hueOf(ag?.name ?? s.title);
      b.blanket.material.color.setHSL(h, 0.5, 0.55);
      b.head.material.color.setHex(ag?.look?.skin ?? SKIN[Math.floor(h * 997) % SKIN.length]);
      const when = new Date(s.nextRunAt);
      const mins = Math.round((when - now) / 60000);
      const rel = mins <= 0 ? "agora" : mins < 60 ? `em ${mins} min` : mins < 1440 ? `em ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ""}` : `em ${Math.round(mins / 1440)} d`;
      const hm = when.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", ...(mins < 1440 ? {} : { day: "2-digit", month: "2-digit" }), hour: "2-digit", minute: "2-digit" });
      const soon = mins <= 15;
      b.soon = soon;
      const html = `<div class="al-time ${soon ? "soon" : ""}">⏰ ${esc(hm)} · ${esc(rel)}</div><div class="al-title">${esc(s.title)}</div><div class="al-who">💤 ${esc(ag ? `${ag.emoji} ${ag.name}` : "—")}</div>`;
      if (b.el.dataset.html !== html) {
        b.el.innerHTML = html;
        b.el.dataset.html = html;
      }
    }
  }

  // TV da recepção com as próximas tarefas agendadas.
  /** Telão (w × h em metros) com moldura fina; a resolução acompanha o tamanho. */
  function makeBoard(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * 160);
    canvas.height = Math.round(h * 160);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const g = new THREE.Group();
    g.add(box(w + 0.3, h + 0.3, 0.2, mat(0x111418, { metalness: 0.4, roughness: 0.35 })));
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    screen.position.z = 0.11;
    g.add(screen);
    g.userData.isBoard = true;
    return { mesh: g, canvas, tex };
  }

  /** Telões das salas de reunião: cada um mostra a reunião da sua sala (ou "sala livre"). */
  function drawConf() {
    for (const s of sites) for (const C of s.p.confs ?? []) if (C.board) drawConfBoard(C.board, C.meeting, s.p.confs);
  }

  function drawConfBoard(board, m, confs) {
    const names = new Map((data?.agents ?? []).map((a) => [a.id, a]));
    const sig = JSON.stringify(m ? [m.id, m.title, m.agents, m.status, m.agents.map((id) => names.get(id)?.name)] : null);
    if (sig === board.sig) return;
    board.sig = sig;
    const x = board.canvas.getContext("2d");
    const { width: w, height: h } = board.canvas;
    const u = h / 504;
    const grad = x.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, "#1d2b45");
    grad.addColorStop(1, "#0b1324");
    x.fillStyle = grad;
    x.fillRect(0, 0, w, h);
    x.textBaseline = "middle";
    if (!m) {
      x.fillStyle = "#f6b94a";
      x.font = `bold ${54 * u}px system-ui, sans-serif`;
      x.fillText("🤝 Sala livre", 40 * u, 110 * u);
      x.fillStyle = "#9cc4e4";
      x.font = `${34 * u}px system-ui, sans-serif`;
      x.fillText("Use “🤝 Reunião” no topo para chamar", 40 * u, 220 * u);
      x.fillText("vários agentes para a mesma tarefa.", 40 * u, 270 * u);
    } else {
      x.fillStyle = "#f6b94a";
      x.font = `bold ${36 * u}px system-ui, sans-serif`;
      x.fillText("🔴 Reunião em andamento", 40 * u, 60 * u);
      x.fillStyle = "#ffffff";
      x.font = `bold ${50 * u}px system-ui, sans-serif`;
      const full = `${m.identifier ? m.identifier + " · " : ""}${m.title}`;
      let t = full;
      while (t.length > 3 && x.measureText(t).width > w - 80 * u) t = t.slice(0, -2);
      x.fillText(t === full ? t : t + "…", 40 * u, 140 * u);
      x.font = `${32 * u}px system-ui, sans-serif`;
      m.agents.slice(0, 8).forEach((id, i) => {
        const a = names.get(id);
        x.fillStyle = id === m.coordinator ? "#f6b94a" : "#cfe3f5";
        const col = i % 2, row = Math.floor(i / 2);
        let n = `${id === m.coordinator ? "👑 " : ""}${a?.emoji ?? ""} ${a?.name ?? "?"}`;
        while (n.length > 3 && x.measureText(n).width > w / 2 - 60 * u) n = n.slice(0, -2);
        x.fillText(n, 40 * u + col * (w / 2), 220 * u + row * 62 * u);
      });
    }
    x.textBaseline = "alphabetic";
    board.tex.needsUpdate = true;
  }

  function drawBoard() {
    for (const b of boards) drawOne(b);
  }

  /** Próximas execuções: horário grande, título e agente; destaca o que roda em menos de 1 h. */
  function drawOne(board) {
    const x = board.canvas.getContext("2d");
    const { width: w, height: h } = board.canvas;
    const u = h / 720; // escala das letras
    const pad = 40 * u;
    const grad = x.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#0b2a45");
    grad.addColorStop(1, "#06131f");
    x.fillStyle = grad;
    x.fillRect(0, 0, w, h);
    x.fillStyle = "#ffd54f";
    x.font = `bold ${56 * u}px system-ui, sans-serif`;
    x.textBaseline = "middle";
    x.fillText("⏰ Próximas tarefas agendadas", pad, 62 * u);
    x.fillStyle = "#8fb3d1";
    x.font = `${36 * u}px system-ui, sans-serif`;
    const now = new Date().toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });
    x.textAlign = "right";
    x.fillText(`Rio · ${now}`, w - pad, 62 * u);
    x.textAlign = "left";
    const names = new Map((data?.agents ?? []).map((a) => [a.id, `${a.emoji} ${a.name}`]));
    const ROWS = 6;
    const rowH = (h - 130 * u) / ROWS;
    const next = schedules.filter((s) => s.status === "active" && s.nextRunAt).slice(0, ROWS);
    const tz = { timeZone: "America/Sao_Paulo" };
    const todayStr = new Date().toLocaleDateString("pt-BR", { ...tz, day: "2-digit", month: "2-digit" });
    const fit = (str, max) => {
      if (x.measureText(str).width <= max) return str;
      while (str.length > 1 && x.measureText(str + "…").width > max) str = str.slice(0, -1);
      return str + "…";
    };
    next.forEach((s, i) => {
      const top = 115 * u + i * rowH;
      const when = new Date(s.nextRunAt);
      const day = when.toLocaleDateString("pt-BR", { ...tz, day: "2-digit", month: "2-digit" });
      const hm = when.toLocaleTimeString("pt-BR", { ...tz, hour: "2-digit", minute: "2-digit" });
      const soon = when - Date.now() < 60 * 60_000;
      x.fillStyle = soon ? "rgba(255,213,79,0.16)" : i % 2 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.08)";
      x.fillRect(pad * 0.6, top + 4 * u, w - pad * 1.2, rowH - 8 * u);
      const mid = top + rowH / 2;
      x.fillStyle = soon ? "#ffd54f" : "#7ee2a8";
      x.font = `bold ${52 * u}px ui-monospace, monospace`;
      x.fillText(hm, pad, mid - (day === todayStr ? 0 : 12 * u));
      const timeW = 190 * u;
      if (day !== todayStr) {
        x.fillStyle = "#8fb3d1";
        x.font = `${24 * u}px system-ui, sans-serif`;
        x.fillText(day, pad, mid + 28 * u);
      }
      const tx = pad + timeW;
      x.fillStyle = "#ffffff";
      x.font = `600 ${40 * u}px system-ui, sans-serif`;
      x.fillText(fit(s.title, w - tx - pad), tx, mid - 18 * u);
      x.fillStyle = "#9cc4e4";
      x.font = `${30 * u}px system-ui, sans-serif`;
      x.fillText(fit(names.get(s.agentId) ?? "", w - tx - pad), tx, mid + 22 * u);
    });
    if (!next.length) {
      x.fillStyle = "#8fb3d1";
      x.font = `${40 * u}px system-ui, sans-serif`;
      x.fillText("Nenhuma tarefa agendada ativa.", pad, 200 * u);
    }
    x.textBaseline = "alphabetic";
    board.tex.needsUpdate = true;
  }
  // O relógio e o destaque de "menos de 1 h" mudam sem novos dados.
  setInterval(drawBoard, 30_000);

  const raycaster = new THREE.Raycaster();
  // Clique = soltar o mouse quase no mesmo lugar (arrastar gira a câmera, não clica).
  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
  renderer.domElement.addEventListener("click", (e) => {
    if (mode !== "interior") return;
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6) return;
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const targets = [...avatars.values()].map((a) => a.g);
    for (const s of sites) targets.push(s.group);
    if (annex) targets.push(annex.group);
    for (const hit of raycaster.intersectObjects(targets, true)) {
      let o = hit.object;
      while (o && !o.userData.agentId && !o.userData.schedId && !o.userData.isDesk && !o.userData.isBoard && !o.userData.isConf) o = o.parent;
      if (o?.userData.isConf) return onConf();
      // Telão: abre a agenda completa, com letra de tela.
      if (o?.userData.isBoard) return onBoard();
      if (o?.userData.schedId) return onSelectSchedule(o.userData.schedId);
      // Mesa/cadeira: menu de ações da mesa (dono + escolher outro agente).
      if (o?.userData.isDesk) return onSpot({ agentId: o.userData.seat?.owner ?? o.userData.agentId ?? null, x: e.clientX, y: e.clientY });
      if (o) return onSelect(o.userData.agentId);
      // vidro/piso sem dono: continua procurando algo atrás
    }
    // Piso, sofá, copa…: menu para escolher um agente.
    onSpot({ agentId: null, x: e.clientX, y: e.clientY });
  });

  function resize() {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    css.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();
  applyQuality();

  // Etiquetas: as mais importantes ficam; as que colidiriam somem (voltam ao passar o mouse
  // no agente ou ao aproximar a câmera, quando passam a caber).
  let lastDeclutter = 0;
  const PRIORITY = [
    [".tag.hl", 120], [".tag.selected", 100], [".zone-label", 90], [".zone-label.building", 95], [".room-label", 80],
    [".tag:has(.bubble)", 70], [".alarm", 65], [".squad-label", 50], [".tag", 20],
  ];
  const firstName = (n) => String(n ?? "").split(/[\s—–-]+/)[0];
  const hello = () => {
    const h = Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));
    return h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite";
  };
  /** Balão + aceno por ~3 s; turnTo = para onde virar a cabeça (sentado). */
  function say(who, text, turnTo, t) {
    who.greetUntil = t + 3.2;
    who.greetTurn = 0;
    if (turnTo && who.spot) {
      const d = turnTo.clone().sub(who.pos).applyAxisAngle(new THREE.Vector3(0, 1, 0), -who.spot.rot);
      who.greetTurn = Math.max(-0.9, Math.min(0.9, Math.atan2(-d.x, -d.z)));
    }
    who.tagEl.dataset.greet = text;
    who.tagEl.classList.add("greet");
  }
  const seatedAt = (list, exceptId) =>
    list
      .filter((o) => o.owner && o.owner !== exceptId)
      .map((o) => avatars.get(o.owner))
      .filter((n) => n && !n.path.length && n.spot?.seat);

  /** Entrou na área de trabalho: os colegas mais próximos acenam. */
  function greetRoom(av, t) {
    const seated = seatedAt(av.spot.seat.list, av.agent?.id)
      .sort((x, y) => x.pos.distanceToSquared(av.pos) - y.pos.distanceToSquared(av.pos))
      .slice(0, 3);
    if (!seated.length) return;
    const hi = hello();
    say(av, seated.length > 1 ? `👋 ${hi}, pessoal!` : `👋 ${hi}, ${firstName(seated[0].agent?.name)}!`, null, t);
    seated.forEach((n, i) => say(n, i ? "👋" : `👋 ${hi}, ${firstName(av.agent?.name)}!`, av.pos, t));
  }

  /** Sentou: cumprimenta os vizinhos de lado (e o da frente), que respondem. */
  function greet(av, t) {
    const st = av.spot.seat;
    const near = seatedAt(
      st.list.filter((o) => o.bench === st.bench && ((o.side === st.side && Math.abs(o.col - st.col) === 1) || (o.side !== st.side && o.col === st.col))),
      av.agent?.id,
    );
    if (!near.length) return;
    say(av, `👋 Oi, ${firstName(near[0].agent?.name)}!`, near[0].pos, t);
    near.forEach((n, i) => say(n, i ? "👋" : `👋 Olá, ${firstName(av.agent?.name)}!`, av.pos, t));
  }

  /**
   * Caminho entre dois lugares: sai pela entrada do lugar atual (ex.: porta da área de trabalho),
   * anda pela faixa da frente do andar (à vista da câmera) e entra pelo caminho do destino.
   */
  function route(from, to, start) {
    const V = (x, z) => new THREE.Vector3(x, ELEV + 0.1, z);
    const copy = (v) => Object.assign(v.clone(), { door: v.door });
    const exit = from?.entry && from.lane === to.lane ? [...from.entry].reverse() : [];
    const entry = to.entry ?? [];
    const sx = (exit[exit.length - 1] ?? start).x;
    const ex = (entry[0] ?? to.pos).x;
    return [...exit.map(copy), V(sx, to.lane), V(ex, to.lane), ...entry.map(copy), to.pos.clone()];
  }

  function declutter() {
    const els = [...css.domElement.querySelectorAll(".tag, .zone-label, .room-label, .squad-label, .alarm")].filter((e) => e.style.display !== "none" && e.offsetParent !== null);
    const items = els.map((e) => {
      let pr = 10;
      for (const [sel, v] of PRIORITY) if (e.matches(sel)) pr = Math.max(pr, v);
      const r = e.getBoundingClientRect(); // opacidade não muda o layout: mede sem tirar a classe
      return { e, pr, r, z: Number(e.style.zIndex) || 0 };
    });
    items.sort((a, b) => b.pr - a.pr || b.z - a.z);
    const placed = [];
    for (const it of items) {
      const { r } = it;
      if (!r.width) continue;
      const hit = placed.some((p) => r.left < p.right - 2 && r.right > p.left + 2 && r.top < p.bottom - 2 && r.bottom > p.top + 2);
      // Rótulo de agente fica sempre visível; só as placas de sala/alarme cedem espaço.
      const hide = hit && !it.e.classList.contains("tag") && !it.e.matches(":hover");
      if (it.e.classList.contains("occl") !== hide) it.e.classList.toggle("occl", hide);
      if (!hide) placed.push(r);
    }
  }

  const clock = new THREE.Clock();
  let last = 0;
  let paused = false; // visão 3D escondida (Lista, Agenda, Histórico): não desenha
  renderer.setAnimationLoop(() => {
    if (paused) return;
    const t = clock.getElapsedTime();
    const dt = Math.min(0.1, t - last);
    last = t;
    if (flight) {
      flight.t = Math.min(1, flight.t + dt * 1.2);
      const k = 1 - (1 - flight.t) ** 3;
      controls.target.lerpVectors(flight.from, flight.to, k);
      camera.position.lerpVectors(flight.camFrom, flight.camTo, k);
      if (flight.t >= 1) flight = null;
    }
    controls.update();
    const camDist = camera.position.distanceTo(controls.target);
    host.classList.toggle("far", camDist > 55);
    host.classList.toggle("very-far", camDist > 110);
    rio.tick(t);
    if (dormBeds.length) {
      if (t - lastDorm > 15) {
        lastDorm = t;
        updateDorm();
      }
      for (const b of dormBeds) {
        b.clock.rotation.z = b.soon ? Math.sin(t * 40) * 0.25 : 0;
        b.head.position.y = 0.82 + Math.sin(t * 1.2 + b.idx) * 0.015; // respiração
      }
    }
    scene.environmentIntensity = 0.12 + (1 - rio.palette.city) * 0.33;
    // Quiosques: anel pulsa quando a próxima execução está a menos de 30 min.
    if (annex) {
      const now = Date.now();
      for (const p of annex.pods) {
        const due = p.sched.status === "active" && p.sched.nextRunAt && new Date(p.sched.nextRunAt) - now < 30 * 60_000;
        const k = due ? 1 + 0.18 * Math.sin(t * 4) : 1;
        p.ring.scale.set(k, k, k);
        p.fig.rotation.y += dt * 0.5;
      }
    }
    if (sun.userData.dir) sun.position.copy(sun.target.position).addScaledVector(sun.userData.dir, shadowSpan * 2.5);
    let seed = 0;
    for (const av of avatars.values()) {
      seed += 1.7;
      if (!av.spot) {
        av.g.visible = false;
        continue;
      }
      av.g.visible = true;
      if (av.greetUntil && t > av.greetUntil) {
        av.greetUntil = 0;
        av.tagEl.classList.remove("greet");
      }
      if (av.path.length) {
        if (av.talking) {
          av.talking = false;
          av.tagEl.classList.remove("talk");
        }
        const next = av.path[0];
        const dir = next.clone().sub(av.pos);
        const dist = dir.length();
        const step = WALK_SPEED * dt;
        if (dist <= step) {
          av.pos.copy(next);
          av.path.shift();
          if (next.door && av.spot.seat && av.agent?.state === "working") greetRoom(av, t);
          if (!av.path.length && av.spot.seat) greet(av, t);
        } else {
          av.pos.addScaledVector(dir.normalize(), step);
          av.g.rotation.y = Math.atan2(-dir.x, -dir.z);
        }
        if (av.robot) av.robot.play("Walking");
        else {
          walkPose(av, t, seed);
          if (av.greetUntil) {
            av.armR.rotation.x = 2.7;
            av.armR.rotation.z = 0.35 * Math.sin(t * 12);
          }
        }
      } else {
        av.g.rotation.y = av.spot.rot;
        const talking = av.spot.kind === "meet" && av.spot.talkN > 1 && Math.floor(t / 3) % av.spot.talkN === av.spot.talkIdx;
        if (talking !== Boolean(av.talking)) {
          av.talking = talking;
          av.tagEl.classList.toggle("talk", talking);
        }
        if (av.robot) av.robot.play(av.greetUntil ? "Wave" : (ROBOT_CLIP[av.spot.kind] ?? "Idle"));
        else pose(av, av.spot.kind, t, seed);
      }
      if (av.robot) {
        // Sentado: o robô "senta" no chão; sobe até o assento da cadeira/sofá.
        const seated = !av.path.length && ["desk", "sofa", "meet"].includes(av.spot.kind);
        av.robot.scene.position.y = seated ? 0.42 : 0;
        av.robot.scene.position.z = seated ? 0.12 : 0;
        // Longe da câmera (ou fora do filtro), anima em passos maiores: mesma aparência, menos CPU.
        av.mixAcc = (av.mixAcc ?? 0) + dt;
        const far = av.g.position.distanceToSquared(camera.position) > 90 * 90;
        if (!far || av.mixAcc > 0.2) {
          av.robot.mixer.update(av.mixAcc * (0.85 + (seed % 3) * 0.1));
          av.mixAcc = 0;
        }
      }
      av.g.position.copy(av.pos);
      // Anel de status: verde pulsando (trabalhando), vermelho (bloqueado), cinza (ocioso/offline).
      const ring = av.g.userData.ring;
      if (ring && av.agent) {
        const st = av.agent.state;
        ring.material.color.setHex(st === "working" ? 0x2ecc71 : st === "blocked" ? 0xef5350 : st === "offline" ? 0x4a5468 : 0x8d9bb5);
        const k = st === "working" ? 1 + 0.15 * Math.sin(t * 4 + seed) : st === "blocked" ? 1 + 0.1 * Math.sin(t * 8 + seed) : 1;
        ring.scale.set(k, k, k);
        ring.material.opacity = st === "offline" ? 0.25 : st === "working" ? 0.75 : 0.45;
        ring.visible = !(av.path.length === 0 && av.spot?.kind === "desk"); // na mesa, a cadeira já marca
      }
      const sitting = !av.path.length && ["desk", "sofa", "sleep", "meet"].includes(av.spot.kind);
      av.tag.position.set(0, av.robot ? (sitting ? 2.5 : 2.4) : sitting ? 2.3 : 2.6, 0);
    }
    if (t - lastDeclutter > 0.25) {
      lastDeclutter = t;
      declutter();
    }
    if (bloom.enabled) {
      bloom.strength = 0.1 + rio.palette.city * 0.28;
      composer.render();
    } else renderer.render(scene, camera);
    css.render(scene, camera);
  });

  return {
    update,
    focus,
    setSelected,
    setMode,
    highlight,
    focusDorm,
    setSchedules(list) {
      schedules = list ?? [];
      drawBoard();
      updateDorm();
      buildAnnex();
    },
    /** Prédios: { mode: "sede" | "bairro" | "um", key, groupBy: "machine" | "runtime" }. */
    setCampus(next) {
      campus = { ...campus, ...next };
      reframe = true;
      focusKey = campus.mode === "um" ? campus.key : null;
      if (data) update(data);
    },
    get campus() {
      return campus;
    },
    get buildings() {
      return sites.map((s) => ({ key: s.key, name: s.name }));
    },
    focusBuilding(key) {
      focusKey = key;
      host.classList.toggle("overview", sites.length > 1 && !focusKey);
      setMode("interior");
    },
    /** Troca o tema do cenário (premium, classico, minimal) e remonta o andar. */
    setTheme(name) {
      THEME = THEMES[name] ?? THEMES.premium;
      themeName = THEMES[name] ? name : "premium";
      localStorage.setItem("painel-tema", themeName);
      rio.root.visible = THEME.city;
      scene.background = THEME.city ? null : new THREE.Color(0x16202f);
      host.dataset.theme = themeName;
      update.key = null;
      if (data) update(data);
    },
    get theme() {
      return themeName;
    },
    /** Pausa o desenho enquanto a cena não está visível (economiza CPU/GPU). */
    setPaused(on) {
      paused = Boolean(on);
      if (!paused) last = clock.getElapsedTime(); // sem salto de animação ao voltar
    },
    setQuality(q) {
      quality = q;
      localStorage.setItem("painel-qualidade", q);
      applyQuality();
    },
    get quality() {
      return quality;
    },
    /** ids = Set de agentes visíveis (ou null); single = escritório único. */
    setFilter(ids, single) {
      filterIds = ids;
      unified = Boolean(single);
      reframe = true;
      if (data) update(data);
    },
    focusSchedule(id) {
      const pod = annex?.pods.find((p) => p.id === id);
      if (!pod) return;
      mode = "annex";
      applyMode();
      const p = pod.group.getWorldPosition(new THREE.Vector3());
      fly(p, p.clone().add(new THREE.Vector3(5, 9, 11)));
    },
    /** null = hora real do Rio; número = prévia (ex.: 19 para ver à noite). */
    setHour(h) {
      rio.setHour(h);
    },
    get hour() {
      return rio.hour;
    },
    get mode() {
      return mode;
    },
  };
}
