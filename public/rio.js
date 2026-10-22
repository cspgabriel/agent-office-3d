// Cenário do Rio em volta da torre: céu que segue a hora do Rio (amanhecer,
// dia, pôr do sol, noite com estrelas), baía com ondas e veleiros, Pão de
// Açúcar com bondinho, Corcovado com o Cristo, prédios que acendem à
// noite, Av. Atlântica, calçadão de Copacabana, areia e coqueiros.
//
// Coordenadas: a torre fica na origem e a fachada olha para +z (praia e
// mar). Atrás (-z) ficam a baía, o Pão de Açúcar (direita) e o Corcovado
// (esquerda).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const lerp = THREE.MathUtils.lerp;
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
const place = (mesh, x, y, z) => (mesh.position.set(x, y, z), mesh);

// Paleta por hora do dia. city = luzes da cidade (0 a 1).
const KEYS = [
  { h: 0, top: 0x060a1a, hor: 0x16244a, sun: 0, hemi: 0.5, city: 1 },
  { h: 5, top: 0x0a1330, hor: 0x2b3560, sun: 0, hemi: 0.5, city: 1 },
  { h: 6.2, top: 0x4d72aa, hor: 0xffa66e, sun: 0.7, hemi: 0.8, city: 0.5 },
  { h: 7.8, top: 0x4f97df, hor: 0xd3ebff, sun: 1.7, hemi: 1.15, city: 0 },
  { h: 16.3, top: 0x4f97df, hor: 0xd3ebff, sun: 1.7, hemi: 1.15, city: 0 },
  { h: 17.6, top: 0x40609e, hor: 0xff8c4a, sun: 1.1, hemi: 0.95, city: 0.3 },
  { h: 18.6, top: 0x2a3060, hor: 0xd8704f, sun: 0.35, hemi: 0.8, city: 0.85 },
  { h: 19.4, top: 0x0b1434, hor: 0x2e2d5c, sun: 0, hemi: 0.5, city: 1 },
  { h: 24, top: 0x060a1a, hor: 0x16244a, sun: 0, hemi: 0.5, city: 1 },
];

function palette(hour) {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= hour) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const k = THREE.MathUtils.clamp((hour - a.h) / (b.h - a.h), 0, 1);
  return {
    top: new THREE.Color(a.top).lerp(new THREE.Color(b.top), k),
    hor: new THREE.Color(a.hor).lerp(new THREE.Color(b.hor), k),
    sun: lerp(a.sun, b.sun, k),
    hemi: lerp(a.hemi, b.hemi, k),
    city: lerp(a.city, b.city, k),
  };
}

/** Hora atual no Rio, com fração (ex.: 18.5 = 18h30). */
export function rioHour(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "numeric", minute: "numeric", hour12: false })
    .formatToParts(date)
    .reduce((o, p) => ((o[p.type] = p.value), o), {});
  return (Number(parts.hour) % 24) + Number(parts.minute) / 60;
}

function canvasTexture(w, h, draw, repeat) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(...repeat);
  }
  t.anisotropy = 4;
  return t;
}

/** Fachada de prédio: vidro com janelas; o emissiveMap acende algumas à noite. */
function windowTextures(cols, rows, litRatio, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const lit = [];
  for (let i = 0; i < cols * rows; i++) lit.push(rnd() < litRatio);
  const draw = (emissive) => (x, w, h) => {
    x.fillStyle = emissive ? "#000" : "#7f9fb8";
    x.fillRect(0, 0, w, h);
    const cw = w / cols, ch = h / rows;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const on = lit[r * cols + c];
        x.fillStyle = emissive ? (on ? "#ffd89a" : "#000") : on ? "#cfe6f7" : "#a6c6df";
        x.fillRect(c * cw + cw * 0.12, r * ch + ch * 0.18, cw * 0.76, ch * 0.62);
      }
  };
  return { map: canvasTexture(256, 256, draw(false)), emissiveMap: canvasTexture(256, 256, draw(true)) };
}

/**
 * Morro liso: esfera achatada com relevo suave (soma de senos, sem picos).
 * peak > 0 afina o topo (Corcovado); 0 deixa em forma de domo (Pão de Açúcar).
 */
function rockyBlob(rx, ry, rz, color, _detail = 2, rough = 0.12, seed = 3, peak = 0) {
  const g = new THREE.SphereGeometry(1, 48, 32);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 + seed * 0.7) + Math.sin((x + z) * 5.3 + seed * 1.3) * 0.4;
    const f = 1 + n * rough * 0.5;
    if (y > 0 && peak) {
      const taper = 1 - Math.pow(y, 1.5) * peak;
      x *= taper;
      z *= taper;
    }
    p.setXYZ(i, x * rx * f, y * ry * (1 + n * rough * 0.2), z * rz * f);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat(color, { roughness: 0.95 }));
}

function palm() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, 7, 6), mat(0x8d6e4f));
  trunk.position.y = 3.5;
  trunk.rotation.z = 0.08;
  g.add(trunk);
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 3.4), mat(0x3e8a3a));
    leaf.position.set(0.3, 7, 0);
    leaf.rotation.set(-0.45, (i / 7) * Math.PI * 2, 0);
    leaf.translateZ(1.5);
    g.add(leaf);
  }
  return g;
}

function sailboat(color) {
  const g = new THREE.Group();
  g.add(place(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 5), mat(color)), 0, 0.3, 0));
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 6), mat(0xdddddd));
  mast.position.y = 3.5;
  g.add(mast);
  const sail = new THREE.BufferGeometry();
  sail.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.9, 0.2, 0, 6.3, 0.2, 0, 0.9, 2.6], 3));
  sail.computeVertexNormals();
  g.add(new THREE.Mesh(sail, mat(0xfafafa, { side: THREE.DoubleSide })));
  return g;
}

export function createRio(scene, { hemi, sun, ambient }) {
  const root = new THREE.Group();
  scene.add(root);
  const cityMats = []; // materiais que acendem à noite: [material, intensidade máxima]

  // Céu: cúpula com degradê + brilho do sol, e estrelas.
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color() },
      hor: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunGlow: { value: 1 },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; uniform float sunGlow; varying vec3 vDir;
      void main(){ float h = clamp(vDir.y, 0.0, 1.0); vec3 c = mix(hor, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += vec3(1.0,0.85,0.6) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.35) * sunGlow;
        gl_FragColor = vec4(c, 1.0); }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), skyMat);
  root.add(sky);
  const starGeo = new THREE.BufferGeometry();
  const starPos = [];
  for (let i = 0; i < 900; i++) {
    const t = Math.random() * Math.PI * 2, p = Math.acos(Math.random() * 0.9);
    starPos.push(1600 * Math.sin(p) * Math.cos(t), 1600 * Math.cos(p), 1600 * Math.sin(p) * Math.sin(t));
  }
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, fog: false });
  root.add(new THREE.Points(starGeo, starMat));

  // Mar: ondas em low-poly (flatShading dispensa recalcular normais).
  const seaGeo = new THREE.PlaneGeometry(3600, 3600, 110, 110);
  seaGeo.rotateX(-Math.PI / 2);
  const seaMat = mat(0x1a86d0, { roughness: 0.22, metalness: 0.2, flatShading: true });
  const sea = new THREE.Mesh(seaGeo, seaMat);
  sea.position.y = -1.4;
  sea.receiveShadow = true;
  root.add(sea);
  const seaBase = Float32Array.from(seaGeo.attributes.position.array);

  // Terreno da orla: do fundo (-z) até a areia (+z).
  const land = new THREE.Mesh(new THREE.BoxGeometry(620, 2, 260), mat(0x86b85f));
  land.position.set(0, -1, -47.5);
  land.receiveShadow = true;
  root.add(land);
  const strip = (w, d, z, m, y = 0.02) => {
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, d), m);
    s.position.set(0, y, z);
    s.receiveShadow = true;
    root.add(s);
    return s;
  };
  // Árvores do parque (instanciadas).
  const treeSpots = [];
  let ts = 29;
  const trnd = () => ((ts = (ts * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 420; i++) {
    const x = -300 + trnd() * 600, z = -172 + trnd() * 204;
    treeSpots.push([x, z, 0.8 + trnd() * 0.7]);
  }
  const crowns = new THREE.InstancedMesh(new THREE.SphereGeometry(3, 12, 9), mat(0x3f9a46, { roughness: 0.85 }), treeSpots.length);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.5, 4, 5), mat(0x6d4c41), treeSpots.length);
  const tm = new THREE.Matrix4();
  const hidden = new THREE.Vector3(0, -50, 0);
  const zero = new THREE.Vector3(0.0001, 0.0001, 0.0001);
  let masks = [];
  const masked = (x, z, pad = 4) => masks.some((r) => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad);
  function placeTrees() {
    treeSpots.forEach(([x, z, k], i) => {
      const off = masked(x, z);
      crowns.setMatrixAt(i, tm.compose(off ? hidden : new THREE.Vector3(x, 5.5 * k, z), new THREE.Quaternion(), off ? zero : new THREE.Vector3(k, k, k)));
      trunks.setMatrixAt(i, tm.compose(off ? hidden : new THREE.Vector3(x, 2 * k, z), new THREE.Quaternion(), off ? zero : new THREE.Vector3(k, k, k)));
    });
    crowns.instanceMatrix.needsUpdate = trunks.instanceMatrix.needsUpdate = true;
  }
  placeTrees();
  root.add(crowns, trunks);

  // Av. Atlântica, calçadão de ondas e areia.
  strip(620, 12, 45, mat(0x34383e));
  for (let x = -300; x < 300; x += 8) {
    const dash = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.04, 0.3), mat(0xf2f2f2));
    dash.position.set(x, 0.1, 45);
    root.add(dash);
  }
  const waves = canvasTexture(
    512,
    128,
    (x, w, h) => {
      x.fillStyle = "#f4f1ea";
      x.fillRect(0, 0, w, h);
      x.strokeStyle = "#1c1c1c";
      x.lineWidth = 20;
      for (let row = -1; row < 3; row++) {
        x.beginPath();
        for (let px = 0; px <= w; px += 4) x.lineTo(px, row * 64 + 32 + Math.sin((px / w) * Math.PI * 4) * 22);
        x.stroke();
      }
    },
    [60, 2],
  );
  strip(620, 9, 55.5, new THREE.MeshStandardMaterial({ map: waves, roughness: 0.9 }), 0.05);
  const sand = new THREE.Mesh(new THREE.BoxGeometry(620, 2, 26), mat(0xe8d3a2));
  sand.position.set(0, -1.1, 72);
  sand.rotation.x = 0.05;
  sand.receiveShadow = true;
  root.add(sand);
  const palmSpots = [];
  const palmMeshes = [];
  for (let x = -290; x < 300; x += 14) {
    const p = palm();
    palmMeshes.push(p);
    palmSpots.push({ x: x + (Math.abs(x) % 3), z: 60.5 });
    p.position.set(x + (Math.abs(x) % 3), 0, 60.5);
    root.add(p);
  }
  const lampMat = mat(0xfff1c4, { emissive: 0xffd27a, emissiveIntensity: 0 });
  cityMats.push([lampMat, 1.6]);
  for (let x = -296; x < 300; x += 22) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6), mat(0x37474f));
    pole.position.set(x, 3, 51.5);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), lampMat);
    bulb.position.set(x, 6.1, 51.5);
    root.add(pole, bulb);
  }
  // Espuma na beira-mar (pulsa com as ondas).
  const foamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, depthWrite: false });
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(620, 2.4), foamMat);
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(0, -0.55, 85);
  root.add(foam);

  // Carros na Av. Atlântica, nos dois sentidos, com faróis à noite.
  const headMat = mat(0xffffff, { emissive: 0xfff2c0, emissiveIntensity: 0 });
  const tailMat = mat(0x550000, { emissive: 0xff2020, emissiveIntensity: 0 });
  cityMats.push([headMat, 2], [tailMat, 1.5]);
  const carColors = [0xd32f2f, 0xf5f5f5, 0x1e88e5, 0x212121, 0xfbc02d, 0x9e9e9e, 0x2e7d32, 0x6a1b9a];
  const cars = Array.from({ length: 12 }, (_, i) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.1, 1.9), mat(carColors[i % carColors.length], { roughness: 0.35, metalness: 0.4 }));
    body.position.y = 0.75;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.8, 1.7), mat(0x1b2633, { roughness: 0.2, metalness: 0.6 }));
    cabin.position.set(-0.2, 1.65, 0);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 1.5), headMat);
    head.position.set(2.12, 0.8, 0);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 1.5), tailMat);
    tail.position.set(-2.12, 0.8, 0);
    g.add(body, cabin, head, tail);
    const dir = i % 2 ? 1 : -1;
    g.rotation.y = dir > 0 ? 0 : Math.PI;
    root.add(g);
    return { g, dir, x: -300 + ((i * 53) % 600), speed: 9 + (i % 4) * 2.5, z: dir > 0 ? 47.5 : 42.5 };
  });
  // Ônibus (o "frescão" amarelo e o azul do BRT).
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(10, 2.6, 2.4), mat(i % 2 ? 0xfbc02d : 0x1565c0, { roughness: 0.4, metalness: 0.3 }));
    body.position.y = 1.6;
    const win = new THREE.Mesh(new THREE.BoxGeometry(9, 0.8, 2.45), mat(0x1b2633, { roughness: 0.2, metalness: 0.6 }));
    win.position.y = 2.2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 1.9), headMat);
    head.position.set(5.02, 0.9, 0);
    g.add(body, win, head);
    const dir = i % 2 ? 1 : -1;
    g.rotation.y = dir > 0 ? 0 : Math.PI;
    root.add(g);
    cars.push({ g, dir, x: -250 + i * 150, speed: 7, z: dir > 0 ? 47.5 : 42.5 });
  }

  // Guarda-sóis na areia.
  const umbrellaColors = [0xe53935, 0xfdd835, 0x1e88e5, 0x43a047, 0xfb8c00];
  for (let i = 0; i < 26; i++) {
    const x = -240 + i * 19 + ((i * 7) % 6);
    const top = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.8, 8), mat(umbrellaColors[i % 5]));
    top.position.set(x, 2.6, 68 + (i % 3) * 2.5);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4), mat(0xffffff));
    stick.position.set(x, 1.2, 68 + (i % 3) * 2.5);
    root.add(top, stick);
  }

  // ---------- Vida na orla ----------
  // Pedestres e corredores no calçadão (instanciados: corpo + cabeça), ciclistas na
  // ciclovia, quiosques que acendem à noite, vôlei na areia, ônibus, navio e gaivotas.
  const wrap = (x) => ((((x + 310) % 620) + 620) % 620) - 310;
  const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac];
  const SHIRT = [0xffffff, 0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0x212121, 0xfb8c00, 0x8e24aa, 0x00acc1, 0xf06292];
  const WALKERS = 90;
  const walkerBody = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.26, 0.3, 1.15, 8), mat(0xffffff), WALKERS);
  const walkerHead = new THREE.InstancedMesh(new THREE.SphereGeometry(0.21, 10, 8), mat(0xffffff), WALKERS);
  const walkerLegs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.7, 0.2), mat(0x37474f), WALKERS);
  const walkers = Array.from({ length: WALKERS }, (_, i) => {
    const jog = i % 9 === 0;
    const w = { x0: -300 + ((i * 97) % 600), z: 52.3 + ((i * 37) % 70) / 10, dir: i % 2 ? 1 : -1, speed: jog ? 3.4 : 1 + ((i * 13) % 9) / 10, jog, phase: i * 1.7 };
    const c = new THREE.Color();
    walkerBody.setColorAt(i, c.setHex(SHIRT[i % SHIRT.length]));
    walkerHead.setColorAt(i, c.setHex(SKIN[(i * 3) % SKIN.length]));
    return w;
  });
  for (const m of [walkerBody, walkerHead, walkerLegs]) {
    m.castShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(m);
  }
  const lifeM = new THREE.Matrix4();
  function tickWalkers(t) {
    walkers.forEach((w, i) => {
      const x = wrap(w.x0 + w.dir * w.speed * t);
      const bob = Math.abs(Math.sin(t * (w.jog ? 9 : 5) + w.phase)) * (w.jog ? 0.12 : 0.05);
      walkerLegs.setMatrixAt(i, lifeM.makeTranslation(x, 0.35 + bob, w.z));
      walkerBody.setMatrixAt(i, lifeM.makeTranslation(x, 1.25 + bob, w.z));
      walkerHead.setMatrixAt(i, lifeM.makeTranslation(x, 2.05 + bob, w.z));
    });
    walkerBody.instanceMatrix.needsUpdate = walkerHead.instanceMatrix.needsUpdate = walkerLegs.instanceMatrix.needsUpdate = true;
  }

  // Ciclistas na ciclovia (entre a avenida e o calçadão).
  const bikes = Array.from({ length: 8 }, (_, i) => {
    const g = new THREE.Group();
    const wheelGeo = new THREE.TorusGeometry(0.42, 0.06, 6, 16);
    const wheelMat = mat(0x222222);
    for (const dx of [-0.6, 0.6]) {
      const wh = new THREE.Mesh(wheelGeo, wheelMat);
      wh.position.set(dx, 0.45, 0);
      g.add(wh);
    }
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.08), mat([0xff7043, 0x26a69a, 0xffffff, 0x5c6bc0][i % 4]));
    frame.position.y = 0.75;
    const rider = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.9, 8), mat(SHIRT[(i * 3) % SHIRT.length]));
    rider.position.set(-0.1, 1.35, 0);
    rider.rotation.z = -0.25;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), mat(SKIN[i % SKIN.length]));
    head.position.set(0.05, 1.95, 0);
    g.add(frame, rider, head);
    const dir = i % 2 ? 1 : -1;
    g.rotation.y = dir > 0 ? 0 : Math.PI;
    root.add(g);
    return { g, dir, x0: -300 + ((i * 131) % 600), speed: 5 + (i % 3), z: dir > 0 ? 50.9 : 50.1 };
  });

  // Quiosques da orla (telhado colorido, luz à noite).
  const kioskLight = mat(0xfff3cf, { emissive: 0xffc56b, emissiveIntensity: 0 });
  cityMats.push([kioskLight, 1.4]);
  for (let i = 0; i < 12; i++) {
    const x = -260 + i * 46 + 7;
    if (Math.abs(x) < 30) continue; // deixa a frente da torre livre
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 2.2, 6), mat(0xf5f0e6));
    base.position.set(x, 1.1, 59);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 1.2, 6), mat([0x00897b, 0xe53935, 0x1e88e5, 0xfbc02d][i % 4]));
    roof.position.set(x, 2.9, 59);
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(1.72, 1.72, 0.25, 6), kioskLight);
    glow.position.set(x, 2.15, 59);
    root.add(base, roof, glow);
    for (const [dx, dz] of [[-3, 1.5], [3, 1.5]]) {
      const tbl = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.9, 10), mat(0xffffff));
      tbl.position.set(x + dx, 0.45, 59 + dz);
      const umb = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.4, 8), mat(0xfafafa));
      umb.position.set(x + dx, 2.2, 59 + dz);
      root.add(tbl, umb);
    }
  }

  // Vôlei de praia: redes e jogadores pulando.
  const players = [];
  for (const nx of [-150, -70, 70, 150]) {
    for (const dz of [-0.5, 0.5]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6), mat(0xffffff));
      pole.position.set(nx, 0.8, 74 + dz * 8);
      root.add(pole);
    }
    const net = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 8), mat(0x263238, { transparent: true, opacity: 0.7 }));
    net.position.set(nx, 1.7, 74);
    root.add(net);
    for (let k = 0; k < 4; k++) {
      const pl = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.1, 8), mat(SHIRT[(k + nx) & 7]));
      body.position.y = 1.0;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), mat(SKIN[k % SKIN.length]));
      head.position.y = 1.8;
      pl.add(body, head);
      pl.position.set(nx + (k < 2 ? -3 : 3), -0.2, 71.5 + (k % 2) * 5);
      root.add(pl);
      players.push({ g: pl, phase: k * 1.3 + nx });
    }
  }
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mat(0xfff59d));
  root.add(ball);

  // Navio cargueiro cruzando o mar ao longe.
  const ship = new THREE.Group();
  {
    const hull = new THREE.Mesh(new THREE.BoxGeometry(46, 5, 9), mat(0x263238));
    hull.position.y = 1;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(44, 0.6, 8.6), mat(0xb71c1c));
    deck.position.y = 3.7;
    ship.add(hull, deck);
    const cc = [0xe53935, 0x1e88e5, 0xfbc02d, 0x43a047, 0xffffff];
    for (let i = 0; i < 9; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.6, 7.6), mat(cc[i % cc.length]));
      c.position.set(-16 + i * 3.8, 5.3, 0);
      ship.add(c);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 8), mat(0xf5f5f5));
    bridge.position.set(19, 6.5, 0);
    ship.add(bridge);
    root.add(ship);
  }

  // Gaivotas: bandos voando em círculo sobre o mar e a areia.
  const gulls = [];
  const gullMat = mat(0xfafafa);
  for (let f = 0; f < 4; f++) {
    for (let k = 0; k < 6; k++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.25), gullMat);
      const wl = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.05, 1.3), gullMat);
      const wr = wl.clone();
      wl.position.z = -0.65;
      wr.position.z = 0.65;
      g.add(body, wl, wr);
      root.add(g);
      gulls.push({ g, wl, wr, cx: -120 + f * 80, cz: 95 + (f % 2) * 40, r: 30 + k * 2.5, h: 26 + f * 5 + k * 0.8, speed: 0.12 + f * 0.02, phase: k * 0.35 });
    }
  }

  function tickLife(t) {
    tickWalkers(t);
    for (const b of bikes) b.g.position.set(wrap(b.x0 + b.dir * b.speed * t), 0, b.z);
    for (const p of players) p.g.position.y = -0.2 + Math.max(0, Math.sin(t * 2.2 + p.phase)) * 0.7;
    const bt = (t * 0.45) % 1;
    const court = [-150, -70, 70, 150][Math.floor(t * 0.45) % 4];
    ball.position.set(court + (bt - 0.5) * 6, 2.5 + Math.sin(bt * Math.PI) * 4, 74);
    ship.position.set(((t * 1.6) % 1400) - 700, -1, 330);
    for (const g of gulls) {
      const a = g.phase + t * g.speed;
      g.g.position.set(g.cx + Math.cos(a) * g.r, g.h + Math.sin(t * 0.7 + g.phase) * 1.5, g.cz + Math.sin(a) * g.r * 0.6);
      g.g.rotation.y = -a;
      const flap = Math.sin(t * 7 + g.phase * 5) * 0.5;
      g.wl.rotation.x = flap;
      g.wr.rotation.x = -flap;
    }
  }

  // Prédios da cidade (instanciados), longe da torre.
  const win = windowTextures(6, 10, 0.45, 7);
  const bMat = new THREE.MeshStandardMaterial({ map: win.map, emissiveMap: win.emissiveMap, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6, metalness: 0.2 });
  cityMats.push([bMat, 1.1]);
  const spots = [];
  let s = 11;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400 && spots.length < 260; i++) {
    const x = -290 + rnd() * 580, z = -172 + rnd() * 206;
    if (Math.abs(x) < 95) continue; // vista livre da torre para a baía e para o mar
    if (spots.some((p) => Math.abs(p.x - x) < 12 && Math.abs(p.z - z) < 12)) continue;
    spots.push({ x, z, w: 7 + rnd() * 6, d: 7 + rnd() * 6, h: 8 + rnd() * (Math.abs(x) > 180 ? 34 : 20) });
  }
  const city = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bMat, spots.length);
  const m4 = new THREE.Matrix4();
  function placeCity() {
    spots.forEach((p, i) => {
      const off = masked(p.x, p.z, 10);
      city.setMatrixAt(i, m4.compose(off ? hidden : new THREE.Vector3(p.x, p.h / 2, p.z), new THREE.Quaternion(), off ? zero : new THREE.Vector3(p.w, p.h, p.d)));
    });
    city.instanceMatrix.needsUpdate = true;
  }
  placeCity();
  city.castShadow = false;
  city.receiveShadow = true;
  root.add(city);

  // ---------- Cidade e vegetação com modelos prontos (Kenney, CC0) ----------
  // Instanciados por modelo: centenas de prédios/árvores com poucas chamadas de desenho.
  // Enquanto carregam (ou se falharem), ficam os blocos e as copas simples acima.
  const kitSets = []; // { meshes: [{ im, local }], items: [{ x, z, s, r, pad }] }
  const kitLoader = new GLTFLoader();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  function makeSet(scene, items) {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene);
    const base = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    const meshes = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const im = new THREE.InstancedMesh(o.geometry, o.material, items.length);
      im.castShadow = false;
      im.receiveShadow = true;
      meshes.push({ im, local: base.clone().multiply(o.matrixWorld) });
      root.add(im);
    });
    const set = { meshes, items };
    kitSets.push(set);
    placeSet(set);
    return set;
  }
  function placeSet(set) {
    set.items.forEach((it, i) => {
      const off = masked(it.x, it.z, it.pad);
      tmpQ.setFromAxisAngle(up, it.r);
      const place = tmpM.compose(off ? hidden : new THREE.Vector3(it.x, 0, it.z), tmpQ, off ? zero : new THREE.Vector3(it.s, it.s, it.s));
      for (const m of set.meshes) m.im.setMatrixAt(i, place.clone().multiply(m.local));
    });
    for (const m of set.meshes) m.im.instanceMatrix.needsUpdate = true;
  }
  const loadKit = (url) => new Promise((ok) => kitLoader.load(url, (g) => ok(g.scene), undefined, () => ok(null)));
  (async () => {
    // Prédios: cada posição da cidade ganha um modelo (mais altos longe da orla).
    const LOW = ["a", "b", "c", "d", "e", "h", "k"];
    const MID = ["f", "g", "i", "j", "l", "n"];
    const TALL = ["m", "skyscraper-a", "skyscraper-b", "skyscraper-c", "skyscraper-d", "skyscraper-e"];
    const names = [...LOW, ...MID, ...TALL];
    const scenes = await Promise.all(names.map((n) => loadKit(`/models/city/building-${n}.glb`)));
    if (scenes.some(Boolean)) {
      const groups = new Map();
      let r2 = 97;
      const rnd2 = () => ((r2 = (r2 * 16807) % 2147483647) / 2147483647);
      for (const p of spots) {
        const pool = p.z > 10 ? LOW : Math.abs(p.x) > 170 ? [...MID, ...TALL, ...TALL] : [...LOW, ...MID];
        const n = pool[Math.floor(rnd2() * pool.length)];
        if (!scenes[names.indexOf(n)]) continue;
        if (!groups.has(n)) groups.set(n, []);
        groups.get(n).push({ x: p.x, z: p.z, s: 8.5 + rnd2() * 2.5, r: Math.floor(rnd2() * 4) * (Math.PI / 2), pad: 10 });
      }
      for (const [n, items] of groups) makeSet(scenes[names.indexOf(n)], items);
      city.visible = false;
      // À noite as janelas (claras no colormap) acendem.
      for (const sc of scenes)
        sc?.traverse((o) => {
          if (!o.isMesh || o.material.userData.lit) return;
          o.material.userData.lit = true;
          o.material.emissive = new THREE.Color(0xffe2a8);
          o.material.emissiveMap = o.material.map;
          o.material.emissiveIntensity = 0;
          o.material.needsUpdate = true;
          cityMats.push([o.material, 0.5]);
        });
      current = applyTime(fixedHour ?? rioHour());
    }
    // Árvores do parque e coqueiros da orla.
    const TREES = ["tree_oak", "tree_detailed", "tree_default", "tree_fat"];
    const tScenes = await Promise.all(TREES.map((n) => loadKit(`/models/nature/${n}.glb`)));
    if (tScenes.some(Boolean)) {
      const byType = TREES.map(() => []);
      treeSpots.forEach(([x, z, k], i) => byType[i % TREES.length].push({ x, z, s: 6 + k * 3, r: (i * 1.7) % 6.28, pad: 4 }));
      TREES.forEach((n, i) => tScenes[i] && makeSet(tScenes[i], byType[i]));
      crowns.visible = trunks.visible = false;
    }
    const bush = await loadKit("/models/nature/plant_bushLarge.glb");
    if (bush) {
      const items = [];
      for (let x = -296; x < 300; x += 7) items.push({ x: x + 2, z: 49.8, s: 7, r: x, pad: 0 });
      makeSet(bush, items);
    }
    const palmK = await loadKit("/models/nature/tree_palmDetailedTall.glb");
    if (palmK) {
      makeSet(palmK, palmSpots.map((p, i) => ({ x: p.x, z: p.z, s: 6.5 + (i % 3), r: i * 0.9, pad: 0 })));
      for (const p of palmMeshes) p.visible = false;
    }
  })();

  // Pão de Açúcar e Morro da Urca, do outro lado da baía (atrás, à direita).
  const sugar = rockyBlob(40, 120, 46, 0x847868, 3, 0.05, 5, 0.25);
  sugar.position.set(95, -8, -380);
  sugar.rotation.z = -0.12;
  const sugarGreen = rockyBlob(70, 26, 64, 0x3f7a3a, 2, 0.15, 9);
  sugarGreen.position.set(95, -6, -380);
  const urca = rockyBlob(46, 56, 42, 0x5f8048, 2, 0.12, 13, 0.2);
  urca.position.set(30, -6, -320);
  root.add(sugar, sugarGreen, urca);
  // Bondinho: Praia Vermelha → Urca → Pão de Açúcar.
  const stations = [new THREE.Vector3(-10, 4, -176), new THREE.Vector3(30, 48, -320), new THREE.Vector3(92, 110, -380)];
  const cableMat = new THREE.LineBasicMaterial({ color: 0x222222 });
  root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(stations), cableMat));
  const cabinMat = mat(0xd84315, { emissive: 0xff7043, emissiveIntensity: 0 });
  cityMats.push([cabinMat, 1.2]);
  const cabins = [0, 1].map((leg) => {
    const c = new THREE.Mesh(new THREE.BoxGeometry(3, 2.4, 3), cabinMat);
    c.userData.leg = leg;
    root.add(c);
    return c;
  });

  // Corcovado com o Cristo Redentor (atrás, à esquerda).
  const corcovado = rockyBlob(125, 200, 110, 0x2f6b34, 2, 0.12, 21, 0.82);
  corcovado.position.set(-330, -10, -620);
  root.add(corcovado);
  const christMat = mat(0xf2efe6, { emissive: 0xfff3d6, emissiveIntensity: 0 });
  cityMats.push([christMat, 0.9]);
  const christ = new THREE.Group();
  christ.add(place(new THREE.Mesh(new THREE.BoxGeometry(6, 6, 6), christMat), 0, 3, 0));
  christ.add(place(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 3, 20, 8), christMat), 0, 16, 0));
  christ.add(place(new THREE.Mesh(new THREE.BoxGeometry(24, 2.2, 2.2), christMat), 0, 23, 0));
  christ.add(place(new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 10), christMat), 0, 27.5, 0));
  christ.position.set(-330, 186, -620);
  christ.scale.setScalar(1.7);
  christ.rotation.y = 0.5;
  root.add(christ);

  // Morros ao redor: Dois Irmãos, Niterói do outro lado da baía.
  for (const [x, z, rx, ry, color, seed] of [
    [-520, -180, 70, 120, 0x356b38, 31],
    [-470, -120, 50, 95, 0x3b743c, 37],
    [-650, -360, 140, 160, 0x30613a, 41],
    [420, -620, 220, 90, 0x3d6d48, 43],
    [80, -720, 260, 70, 0x45714f, 47],
    [-200, -760, 240, 110, 0x3a6847, 53],
    [560, -300, 120, 70, 0x47784d, 59],
  ]) {
    const hill = rockyBlob(rx, ry, rx * 0.9, color, 2, 0.18, seed, 0.35);
    hill.position.set(x, -10, z);
    root.add(hill);
  }

  // Veleiros na baía e no mar da frente.
  const boats = [
    { r: 120, cx: 0, cz: -290, speed: 0.02, phase: 0, color: 0xffffff },
    { r: 80, cx: 60, cz: -260, speed: -0.03, phase: 2, color: 0x0b3d5c },
    { r: 160, cx: -40, cz: 160, speed: 0.015, phase: 1, color: 0xc62828 },
    { r: 110, cx: 120, cz: 190, speed: -0.02, phase: 4, color: 0xffffff },
    { r: 60, cx: -150, cz: -260, speed: 0.035, phase: 3, color: 0xf9a825 },
  ].map((b) => {
    const g = sailboat(b.color);
    root.add(g);
    return { ...b, g };
  });

  // Nuvens que andam devagar.
  const cloudMat = mat(0xffffff, { roughness: 1, transparent: true, opacity: 0.92 });
  const clouds = [];
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(10 + (k % 3) * 4, 1), cloudMat);
      puff.position.set(k * 12 - 24, (k % 2) * 5, (k % 3) * 6);
      puff.scale.y = 0.6;
      c.add(puff);
    }
    c.position.set(-900 + i * 140, 170 + (i % 4) * 25, -500 + ((i * 97) % 700));
    root.add(c);
    clouds.push(c);
  }

  let fixedHour = null;
  const fog = new THREE.Fog(0xd3ebff, 500, 2400);
  scene.fog = fog;

  function applyTime(hour) {
    const p = palette(hour);
    skyMat.uniforms.top.value.copy(p.top);
    skyMat.uniforms.hor.value.copy(p.hor);
    fog.color.copy(p.hor).lerp(p.top, 0.25);
    // Sol nasce no leste (+x), passa alto e se põe a oeste (-x).
    const day = THREE.MathUtils.clamp((hour - 6) / 12, -0.1, 1.1);
    const az = day * Math.PI;
    const el = Math.sin(Math.max(0.04, Math.min(Math.PI - 0.04, az))) * 1.05;
    const dir = new THREE.Vector3(Math.cos(az), Math.max(0.15, el), -0.35).normalize();
    const night = p.sun < 0.05;
    skyMat.uniforms.sunDir.value.copy(night ? new THREE.Vector3(-0.4, 0.6, -0.6) : dir);
    skyMat.uniforms.sunGlow.value = night ? 0.15 : 1;
    sun.userData.dir = night ? new THREE.Vector3(-0.4, 0.8, 0.5).normalize() : dir;
    sun.intensity = night ? 0.35 : p.sun;
    sun.color.set(night ? 0x9fb4ff : el < 0.35 ? 0xffb27a : 0xfff4e0);
    hemi.intensity = p.hemi;
    hemi.color.copy(p.top).lerp(new THREE.Color(0xffffff), 0.6);
    ambient.intensity = 0.15 + p.city * 0.45; // luzes do escritório à noite
    starMat.opacity = p.city * 0.9;
    seaMat.color.set(0x1a86d0).lerp(new THREE.Color(0x0b2038), p.city * 0.85);
    cloudMat.color.copy(p.hor).lerp(new THREE.Color(0xffffff), 0.55 - p.city * 0.3);
    for (const [m, max] of cityMats) m.emissiveIntensity = p.city * max;
    return p;
  }

  let lastHourCheck = -1;
  let current = applyTime(rioHour());

  return {
    root,
    cityMats,
    windowTextures,
    /** Tira árvores e prédios da cidade de dentro dos retângulos {x0,x1,z0,z1} (onde ficam os nossos prédios). */
    setMasks(rects) {
      masks = rects;
      placeTrees();
      placeCity();
      for (const set of kitSets) placeSet(set);
    },
    /** null = hora real do Rio; número = hora fixa (prévia). */
    setHour(h) {
      fixedHour = h;
      current = applyTime(h ?? rioHour());
    },
    get hour() {
      return fixedHour ?? rioHour();
    },
    /** Reaplica a hora (ex.: depois de criar materiais novos que acendem à noite). */
    refresh() {
      current = applyTime(fixedHour ?? rioHour());
    },
    get palette() {
      return current;
    },
    tick(t) {
      tickLife(t);
      foamMat.opacity = 0.35 + 0.3 * Math.sin(t * 0.9);
      foam.position.z = 85 + Math.sin(t * 0.9) * 0.8;
      for (const c of cars) {
        c.x += c.dir * c.speed * 0.016;
        if (c.x > 310) c.x = -310;
        if (c.x < -310) c.x = 310;
        c.g.position.set(c.x, 0, c.z);
      }
      // Hora real: recalcula a cada ~20 s.
      if (fixedHour == null && t - lastHourCheck > 20) {
        lastHourCheck = t;
        current = applyTime(rioHour());
      }
      const pos = seaGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = seaBase[i * 3], z = seaBase[i * 3 + 2];
        pos.setY(i, Math.sin(x * 0.02 + t * 0.9) * 0.6 + Math.cos(z * 0.025 + t * 0.7) * 0.5);
      }
      pos.needsUpdate = true;
      for (const b of boats) {
        const a = b.phase + t * b.speed;
        b.g.position.set(b.cx + Math.cos(a) * b.r, -1.1 + Math.sin(t * 1.3 + b.phase) * 0.25, b.cz + Math.sin(a) * b.r * 0.6);
        b.g.rotation.y = -a + (b.speed > 0 ? Math.PI : 0);
        b.g.rotation.z = Math.sin(t * 0.9 + b.phase) * 0.06;
      }
      for (const c of clouds) {
        c.position.x += 0.04;
        if (c.position.x > 1000) c.position.x = -1000;
      }
      // Bondinho: cada cabine vai e volta no seu trecho.
      for (const c of cabins) {
        const [a, b] = c.userData.leg === 0 ? [stations[0], stations[1]] : [stations[1], stations[2]];
        const k = (Math.sin(t * 0.12 + c.userData.leg * 1.7) + 1) / 2;
        c.position.lerpVectors(a, b, k).y -= 2.5;
      }
    },
  };
}
