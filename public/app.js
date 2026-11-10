import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/* ---------------------------------- state --------------------------------- */
let playerId = null;
let focusedOnce = false;
let cities = []; // last `state` snapshot, sorted by score desc
let myCity = null;
let stage = 0;
let ws = null;
let reconnectDelay = 1000;
let pingSentAt = 0;
const cityGroups = new Map(); // id -> {group, label, ring, buildings:[], level, flag, targetScale...}

/* --------------------------------- helpers -------------------------------- */
function hash(str) {
  let h = 2166136261;
  for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295; // 0..1
}
const $ = (id) => document.getElementById(id);
const banner = $("banner");

/* ----------------------------------- 3D ----------------------------------- */
const canvas = $("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8dd);
scene.fog = new THREE.Fog(0x87b8dd, 90, 220);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
camera.position.set(38, 34, 38);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 8;
controls.maxDistance = 160;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xd8ecff, 0x4a7a45, 0.9));
const sun = new THREE.DirectionalLight(0xfff2d0, 1.6);
sun.position.set(40, 55, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
sun.shadow.camera.far = 160;
scene.add(sun);

/* Shared geometry / materials (one instance each, reused everywhere). */
const GEO = {
  tile: new THREE.BoxGeometry(12, 0.4, 12),
  manor: new THREE.BoxGeometry(3.4, 2.2, 3.4),
  roof: new THREE.ConeGeometry(2.9, 1.8, 4),
  hall: new THREE.BoxGeometry(2.2, 1.6, 2.2),
  tower: new THREE.CylinderGeometry(0.9, 1.1, 3.2, 8),
  trunk: new THREE.CylinderGeometry(0.16, 0.22, 1.1, 6),
  tree: new THREE.ConeGeometry(0.85, 1.9, 7),
  flagPole: new THREE.CylinderGeometry(0.05, 0.05, 1.6, 5),
  flag: new THREE.PlaneGeometry(1.0, 0.6),
  ring: new THREE.RingGeometry(4.6, 5.2, 40),
  cloud: new THREE.SphereGeometry(1, 10, 8),
  plaza: new THREE.CylinderGeometry(6, 6, 0.35, 32),
  fountain: new THREE.CylinderGeometry(1.6, 1.9, 1.0, 12),
};
const MAT = {
  wall: new THREE.MeshStandardMaterial({ color: 0xf3e5c8, roughness: 0.9 }),
  roof: new THREE.MeshStandardMaterial({ color: 0xb5502f, roughness: 0.85, flatShading: true }),
  roofBlue: new THREE.MeshStandardMaterial({ color: 0x3a6ea8, roughness: 0.85, flatShading: true }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x6e4a2f, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 1, flatShading: true }),
  plaza: new THREE.MeshStandardMaterial({ color: 0xcbbfa5, roughness: 1 }),
  cloud: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.92 }),
  ring: new THREE.MeshStandardMaterial({ color: 0xf2b544, emissive: 0x996600, side: THREE.DoubleSide }),
};
const tileMats = [0x77a95a, 0x82b266, 0x6fa356, 0x8cb96b].map(
  (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 1 })
);
function flagMat(id) {
  const hues = [0xd64541, 0x2471a3, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085];
  return new THREE.MeshStandardMaterial({ color: hues[Math.floor(hash(id) * hues.length)], side: THREE.DoubleSide });
}
function shadowed(mesh) { mesh.castShadow = true; mesh.receiveShadow = true; return mesh; }

/* Ground + center plaza + clouds */
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x5d8f4c, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const plaza = shadowed(new THREE.Mesh(GEO.plaza, MAT.plaza));
plaza.position.set(13, 0.18, 0); // decorative, beside your city (you only see your own)
scene.add(plaza);
const fountain = shadowed(new THREE.Mesh(GEO.fountain, new THREE.MeshStandardMaterial({ color: 0x9fc7e8, roughness: 0.4 })));
fountain.position.set(13, 0.6, 0);
scene.add(fountain);

const clouds = [];
for (let i = 0; i < 7; i++) {
  const g = new THREE.Group();
  const n = 3 + Math.floor(hash("c" + i) * 3);
  for (let j = 0; j < n; j++) {
    const s = shadowed(new THREE.Mesh(GEO.cloud, MAT.cloud));
    s.scale.setScalar(2 + hash(`c${i}${j}`) * 2.5);
    s.position.set(j * 2.2 - n, hash(`y${i}${j}`), hash(`z${i}${j}`) * 1.5);
    g.add(s);
  }
  g.position.set((hash("x" + i) - 0.5) * 150, 26 + hash("h" + i) * 10, (hash("w" + i) - 0.5) * 150);
  g.userData.speed = 0.4 + hash("s" + i) * 0.5;
  clouds.push(g);
  scene.add(g);
}

function makeLabel(city) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 64;
  const tex = new THREE.CanvasTexture(c);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  spr.scale.set(7, 1.75, 1);
  spr.renderOrder = 10;
  return { spr, canvas: c, tex };
}
function drawLabel(entry, city) {
  const { canvas, tex } = entry.label;
  const g = canvas.getContext("2d");
  g.clearRect(0, 0, 256, 64);
  g.fillStyle = city.id === playerId ? "rgba(242,181,68,0.95)" : "rgba(10,14,20,0.75)";
  g.beginPath(); g.roundRect(8, 10, 240, 44, 10); g.fill();
  g.fillStyle = city.id === playerId ? "#1a1405" : "#eef2f7";
  g.font = "bold 22px ui-sans-serif, system-ui";
  g.textAlign = "center";
  g.fillText(`${city.name}  Lv${city.level}`, 128, 40);
  tex.needsUpdate = true;
}

/* Building ring positions around the manor (up to 11 extra halls). */
const HALL_SPOTS = [
  [4.2, 0, 0], [-4.2, 0, 0], [0, 0, 4.2], [0, 0, -4.2],
  [3.6, 0, 3.6], [-3.6, 0, 3.6], [3.6, 0, -3.6], [-3.6, 0, -3.6],
  [4.6, 0, 1.8], [-4.6, 0, -1.8], [1.8, 0, -4.6], [-1.8, 0, 4.6],
];

function buildCityGroup(city, index, cols) {
  const group = new THREE.Group();
  // Skip the center cell so the plaza/fountain stays visible in overview.
  const totalCells = cols * cols;
  const center = Math.floor(totalCells / 2);
  const cell = index < center ? index : index + 1;
  const r = Math.floor(cell / cols), c = cell % cols;
  const spacing = 15;
  const w = cols * spacing;
  group.position.set(c * spacing - w / 2 + spacing / 2, 0, r * spacing - w / 2 + spacing / 2);

  const tile = shadowed(new THREE.Mesh(GEO.tile, tileMats[Math.floor(hash(city.id) * tileMats.length)]));
  tile.position.y = 0.2;
  group.add(tile);

  // Manor (always present) + roof + flag.
  const manor = shadowed(new THREE.Mesh(GEO.manor, MAT.wall));
  manor.position.y = 1.5;
  group.add(manor);
  const roof = shadowed(new THREE.Mesh(GEO.roof, MAT.roof));
  roof.position.y = 3.5;
  roof.rotation.y = Math.PI / 4;
  group.add(roof);
  const pole = new THREE.Mesh(GEO.flagPole, MAT.trunk);
  pole.position.set(1.9, 5.0, 0);
  group.add(pole);
  const flag = new THREE.Mesh(GEO.flag, flagMat(city.id));
  flag.position.set(2.45, 5.4, 0);
  flag.rotation.y = Math.PI / 4;
  group.add(flag);

  // Trees — fixed per city (seeded by id, so they don't jump around).
  for (let t = 0; t < 3; t++) {
    const tree = new THREE.Group();
    const trunk = shadowed(new THREE.Mesh(GEO.trunk, MAT.trunk));
    trunk.position.y = 0.55;
    const leaf = shadowed(new THREE.Mesh(GEO.tree, MAT.leaf));
    leaf.position.y = 1.9;
    tree.add(trunk, leaf);
    const spots = [[-4.6, -4.6], [4.6, -4.6], [-4.6, 4.6], [4.6, 4.6]];
    const [sx, sz] = spots[t % spots.length];
    tree.position.set(sx + (hash(city.id + "tx" + t) - 0.5) * 1.4, 0.4, sz + (hash(city.id + "tz" + t) - 0.5) * 1.4);
    tree.scale.setScalar(0.8 + hash(city.id + "ts" + t) * 0.6);
    group.add(tree);
  }

  const ring = new THREE.Mesh(GEO.ring, MAT.ring);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.45;
  ring.visible = city.id === playerId;
  group.add(ring);

  const label = makeLabel(city);
  label.spr.position.y = 7.2;
  group.add(label.spr);

  const entry = { group, label, ring, flag, level: 0, buildings: [] };
  drawLabel(entry, city);
  syncBuildings(entry, city);
  return entry;
}

function syncBuildings(entry, city) {
  const want = Math.min(city.buildings.length - 1, HALL_SPOTS.length); // minus manor
  while (entry.buildings.length < want) {
    const i = entry.buildings.length;
    const [x, , z] = HALL_SPOTS[i];
    const b = new THREE.Group();
    const isTower = i % 3 === 2;
    const base = shadowed(new THREE.Mesh(isTower ? GEO.tower : GEO.hall, i % 2 ? MAT.wall : MAT.wall));
    base.position.y = isTower ? 1.9 : 1.0;
    const roof = shadowed(new THREE.Mesh(isTower ? GEO.tower : GEO.roof, i % 2 ? MAT.roofBlue : MAT.roof));
    roof.position.y = isTower ? 3.9 : 2.6;
    if (!isTower) roof.rotation.y = Math.PI / 4;
    roof.scale.setScalar(isTower ? 0.7 : 0.85);
    b.add(base, roof);
    b.position.set(x, 0.4, z);
    b.scale.setScalar(0.01); // pop-in animation target is 1
    entry.group.add(b);
    entry.buildings.push(b);
  }
  while (entry.buildings.length > want) {
    const b = entry.buildings.pop();
    entry.group.remove(b);
  }
  drawLabel(entry, city);
}

/* Reconcile 3D scene with the latest server snapshot.
   Privacy rule: a human can ONLY see their own city — other cities are
   never rendered, even though the server tracks them for rank/count. */
function reconcile() {
  const mine = cities.find((c) => c.id === playerId);
  for (const [id, entry] of cityGroups) {
    if (!mine || id !== mine.id) {
      scene.remove(entry.group);
      entry.label.tex.dispose();
      cityGroups.delete(id);
    }
  }
  if (!mine) return;
  let entry = cityGroups.get(mine.id);
  if (!entry) {
    entry = buildCityGroup(mine, 0, 1);
    entry.group.position.set(0, 0, 0); // your city lives at the center of your view
    cityGroups.set(mine.id, entry);
    scene.add(entry.group);
  } else {
    syncBuildings(entry, mine);
  }
  entry.level = mine.level;
}

/* ------------------------------------ UI ---------------------------------- */
function renderUI() {
  $("stage").textContent = stage;
  $("players").textContent = cities.length;
  $("realm-count").textContent = cities.length;
  const rank = cities.findIndex((c) => c.id === playerId);
  $("my-rank").textContent = rank >= 0 ? `#${rank + 1} of ${cities.length}` : "—";
  if (myCity) {
    $("my-name").textContent = myCity.name;
    $("my-level").textContent = myCity.level;
    $("my-score").textContent = myCity.score;
    $("my-buildings").textContent = myCity.buildings.join(", ");
    const goal = myCity.level * 100;
    $("my-progress").style.width = Math.min(100, (myCity.score % goal) / goal * 100) + "%";
  }
}

/* --------------------------------- WebSocket ------------------------------ */
function setStatus(on, text) {
  const el = $("status");
  el.className = "status " + (on ? "on" : "off");
  el.textContent = text;
}
function connect() {
  setStatus(false, "connecting…");
  banner.classList.remove("hidden");
  banner.textContent = "Connecting to the realm…";
  ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 1000;
    setStatus(true, "connected");
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "welcome") {
      playerId = m.playerId;
      myCity = m.city;
      banner.classList.add("hidden");
    } else if (m.type === "state") {
      cities = m.cities;
      stage = m.stage;
      myCity = cities.find((c) => c.id === playerId) || myCity;
      reconcile();
      if (playerId && !focusedOnce) { focusedOnce = true; focusOn(playerId); }
      renderUI();
    } else if (m.type === "stage") {
      stage = m.stage;
      const choice = m.decisions[playerId];
      if (choice) $("my-decision").textContent = `Stage ${m.stage}: your city grew — "${choice}".`;
      renderUI();
    } else if (m.type === "decided") {
      myCity = m.city;
      $("my-decision").textContent = `Your city grew: "${m.choice}" (+${m.gained})`;
      renderUI();
    } else if (m.type === "pong") {
      $("latency").textContent = `· ${Math.round(performance.now() - pingSentAt)}ms`;
    }
  };
  ws.onclose = () => {
    playerId = null;
    if (intentionalQuit) {
      setStatus(false, "abandoned");
      banner.classList.remove("hidden");
      banner.innerHTML = `Your city was destroyed.<br/><br/><button id="btn-rejoin">🏰 Build a new city</button>`;
      $("btn-rejoin").onclick = () => location.reload();
      return;
    }
    setStatus(false, "disconnected — retrying…");
    banner.classList.remove("hidden");
    banner.textContent = "Disconnected. Your city was destroyed — rejoining…";
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  };
  ws.onerror = () => ws.close();
}
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    pingSentAt = performance.now();
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 5000);

/* --------------------------------- camera --------------------------------- */
let focusTarget = null;
let camTarget = null;
function focusOn(id) {
  const entry = cityGroups.get(id);
  if (!entry) return;
  focusTarget = entry.group.position.clone();
  camTarget = focusTarget.clone().add(new THREE.Vector3(17, 15, 17));
}
/* Quit = the human's only choice. Abandon closes the socket on purpose:
   the server destroys the city, and we do NOT auto-reconnect. */
let intentionalQuit = false;
$("btn-quit").onclick = () => {
  intentionalQuit = true;
  ws?.close();
};

/* QR invite — humans join by scanning (venue display / print / share). */
const joinUrl = location.origin + location.pathname;
$("qr-url").textContent = joinUrl;
$("qr-img").src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(joinUrl);
$("btn-qr").onclick = () => $("qr-panel").classList.toggle("hidden");

/* ----------------------------------- loop --------------------------------- */
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const t = clock.getElapsedTime();
  for (const c of clouds) {
    c.position.x += c.userData.speed * 0.02;
    if (c.position.x > 110) c.position.x = -110;
  }
  for (const entry of cityGroups.values()) {
    entry.flag.rotation.y = Math.PI / 4 + Math.sin(t * 3 + entry.group.position.x) * 0.3;
    for (const b of entry.buildings) {
      if (b.scale.x < 1) b.scale.setScalar(Math.min(1, b.scale.x + 0.04));
    }
  }
  if (focusTarget) {
    controls.target.lerp(focusTarget, 0.06);
    if (camTarget) camera.position.lerp(camTarget, 0.06);
    if (controls.target.distanceTo(focusTarget) < 0.1) { focusTarget = null; camTarget = null; }
  }
  controls.update();
  renderer.render(scene, camera);
}
tick();
connect();
