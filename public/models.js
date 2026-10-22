// Modelos 3D prontos, servidos pelo próprio painel (/models):
// - móveis: Kenney Furniture Kit (CC0, kenney.nl)
// - avatar: RobotExpressive de Tomás Laulhé / Quaternius (CC0), com animações
// Se algum arquivo falhar, a cena continua com as peças geométricas antigas.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";

const FURNITURE = [
  "desk", "chairDesk", "computerKeyboard", "laptop", "loungeSofa", "loungeDesignSofa", "loungeChair", "tableCoffee",
  "tableRound", "tableGlass", "pottedPlant", "plantSmall1", "plantSmall2", "plantSmall3", "kitchenCoffeeMachine",
  "kitchenBar", "kitchenFridgeLarge", "stoolBar", "rugRectangle", "rugRound", "bookcaseOpen", "lampSquareFloor",
  "televisionModern", "trashcan", "sideTable", "bedSingle", "coatRackStanding", "speaker",
];

const store = new Map(); // nome → Object3D normalizado (base no chão, centralizado em x/z)
let robot = null; // { scene, clips }
export let ready = false;

const loader = new GLTFLoader();
const load = (url) => new Promise((ok, fail) => loader.load(url, ok, undefined, fail));

/** Deixa o modelo com a base em y=0 e o centro em x=z=0, sem escala. */
function normalize(root) {
  const wrap = new THREE.Group();
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.set(-c.x, -box.min.y, -c.z);
  wrap.add(root);
  wrap.userData.size = box.getSize(new THREE.Vector3());
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return wrap;
}

export const loading = (async () => {
  const tasks = FURNITURE.map(async (n) => {
    try {
      store.set(n, normalize((await load(`/models/${n}.glb`)).scene));
    } catch (e) {
      console.warn("modelo", n, e.message);
    }
  });
  tasks.push(
    load("/models/robot.glb")
      .then((g) => (robot = { scene: g.scene, clips: g.animations }))
      .catch((e) => console.warn("robô", e.message)),
  );
  await Promise.all(tasks);
  ready = true;
})();

/**
 * Cópia de um móvel com largura (eixo x) = width. rotY gira em volta do centro.
 * Retorna null se o modelo não carregou (o chamador usa a peça antiga).
 */
export function kit(name, width, rotY = 0) {
  const base = store.get(name);
  if (!base) return null;
  const g = base.clone(true);
  g.scale.setScalar(width / base.userData.size.x);
  g.rotation.y = rotY;
  const holder = new THREE.Group();
  holder.add(g);
  return holder;
}

/** Altura (em unidades da cena) de um móvel escalado para a largura dada. */
export function kitHeight(name, width) {
  const base = store.get(name);
  return base ? (base.userData.size.y * width) / base.userData.size.x : 0;
}

const ROBOT_SCALE = 0.4; // 4,8 de altura no arquivo → ~1,9 na cena

/** Robô animado com a cor do agente no corpo. */
export function makeRobot(color) {
  if (!robot) return null;
  const scene = SkeletonUtils.clone(robot.scene);
  scene.scale.setScalar(ROBOT_SCALE);
  scene.rotation.y = Math.PI; // o modelo olha para +z; nossos avatares olham para -z
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false;
    if (o.material?.name === "Main") {
      o.material = o.material.clone();
      o.material.color.copy(color);
      o.material.roughness = 0.45;
      o.material.metalness = 0.15;
    }
  });
  const mixer = new THREE.AnimationMixer(scene);
  const actions = Object.fromEntries(robot.clips.map((c) => [c.name, mixer.clipAction(c)]));
  let current = null;
  return {
    scene,
    mixer,
    /** Troca a animação com transição suave. */
    play(name, fade = 0.35) {
      const next = actions[name] ?? actions.Idle;
      if (!next || next === current) return;
      next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      if (["Sitting", "Death"].includes(name)) {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      }
      current?.fadeOut(fade);
      current = next;
    },
    setTint(c) {
      scene.traverse((o) => o.isMesh && o.material?.name === "Main" && o.material.color.copy(c));
    },
  };
}
