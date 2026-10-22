// Visual de cada agente: uniforme (camisa), calça, tom de pele e cabelo.
// A escolha fica no servidor (data/looks.json), então todos veem igual.
import * as THREE from "three";

export const OUTFITS = {
  liso: { label: "Camisa lisa (cor do agente)", pants: null },
  hotel: { label: "Polo Agent Office", pants: 0x1f2933 },
  social: { label: "Social com gravata", pants: 0x24324a },
  terno: { label: "Terno executivo", pants: 0x1a1d24 },
  recepcao: { label: "Uniforme de recepção", pants: 0x111827 },
  chef: { label: "Dólmã de chef", pants: 0x2b2b2b },
  esporte: { label: "Moletom esportivo", pants: 0x4b5563 },
  verao: { label: "Camisa florida (verão)", pants: 0xd6c7a1 },
  flamengo: { label: "Camisa do Flamengo", pants: 0x111111 },
};
export const SKINS = [0xf1c9a5, 0xffdbac, 0xe0ac69, 0xd9a066, 0xc68642, 0x8d5524];
export const HAIRS = [0x0f0f0f, 0x2b1b0e, 0x4a2c17, 0x8b5a2b, 0xb98b5b, 0xe5c07b, 0x6e6e6e, 0xb03a2e];
export const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

const cache = new Map();
/** Textura da camisa (canvas 64×128; o topo do canvas é a parte de cima do tronco). */
export function outfitTexture(kind, baseColor) {
  const key = `${kind}:${baseColor.getHexString()}`;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const x = c.getContext("2d");
  const base = `#${baseColor.getHexString()}`;
  const fill = (col, y0 = 0, h = 128) => ((x.fillStyle = col), x.fillRect(0, y0, 64, h));
  switch (kind) {
    case "flamengo":
      for (let i = 0; i < 8; i++) fill(i % 2 ? "#111111" : "#c8102e", i * 16, 16);
      break;
    case "hotel":
      fill("#1b5fd1");
      fill("#ffffff", 22, 4);
      x.fillStyle = "#ffffff";
      x.fillRect(40, 44, 10, 8); // logo no peito
      break;
    case "social":
      fill("#f4f6fb");
      x.fillStyle = "#1e3a8a";
      x.beginPath();
      x.moveTo(29, 24); x.lineTo(35, 24); x.lineTo(37, 80); x.lineTo(32, 88); x.lineTo(27, 80);
      x.fill();
      break;
    case "terno":
      fill("#1f2430");
      x.fillStyle = "#f4f6fb";
      x.beginPath();
      x.moveTo(24, 24); x.lineTo(40, 24); x.lineTo(32, 64);
      x.fill();
      x.fillStyle = "#8b1d2c";
      x.fillRect(30, 26, 4, 30);
      break;
    case "recepcao":
      fill("#0b3d5c");
      fill("#f6b94a", 26, 3);
      x.fillStyle = "#f6b94a";
      for (const y of [44, 60, 76]) x.fillRect(31, y, 3, 3);
      break;
    case "chef":
      fill("#fafafa");
      x.fillStyle = "#bdbdbd";
      for (const y of [40, 56, 72]) for (const xx of [24, 38]) x.fillRect(xx, y, 3, 3);
      break;
    case "esporte":
      fill("#6b7280");
      fill("#4b5563", 90, 38);
      x.fillStyle = "#e5e7eb";
      x.fillRect(29, 20, 2, 26);
      x.fillRect(34, 20, 2, 26);
      break;
    case "verao": {
      fill("#fbbf24");
      const cols = ["#ef4444", "#22c55e", "#ec4899", "#ffffff"];
      for (let i = 0; i < 36; i++) {
        x.fillStyle = cols[i % cols.length];
        x.beginPath();
        x.arc((i * 37) % 64, (i * 53) % 128, 4, 0, Math.PI * 2);
        x.fill();
      }
      break;
    }
    default:
      fill(base);
      fill("rgba(0,0,0,.12)", 22, 3); // gola
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Cor dos braços (mangas) para combinar com a camisa. */
export function sleeveColor(kind, baseColor) {
  return {
    flamengo: 0xc8102e, hotel: 0x1b5fd1, social: 0xf4f6fb, terno: 0x1f2430, recepcao: 0x0b3d5c,
    chef: 0xfafafa, esporte: 0x6b7280, verao: 0xfbbf24,
  }[kind] ?? baseColor.getHex();
}
