// The 3D board: a map of Romania laid out like a premium board game on a walnut table.
// Owns the three.js scene, camera controls, picking and every board animation.
import * as THREE from '../vendor/three.module.min.js';
import { CITIES, ROUTES, OUTLINE, CARPATHIANS, DANUBE, SEA } from './engine/map.js';
import { Rng } from './engine/rng.js';

export const CARD_HEX = { rosu: 0xd8453f, albastru: 0x2f6fd6, verde: 0x3aa35a, galben: 0xf0bf2c, negru: 0x2a2a30, alb: 0xf3efe6, gri: 0xa7abb0, loco: 0xb07cff };
export const PLAYER_HEX = [0xe8742c, 0x18a3a6];

const LAND_Y = 0.15;
const SLOT_Y = LAND_Y + 0.035;
const CITY_R = 0.3;

const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

export class Board {
  constructor(container, { onTap } = {}) {
    this.container = container;
    this.onTap = onTap || (() => {});
    this.clock = 0;
    this.tweens = [];
    this.particles = [];
    this.highlight = { routes: new Set(), cities: new Set() };
    this.trainMeshes = new Map(); // routeId -> [mesh]
    this.stationMeshes = new Map(); // city -> mesh
    this.labels = new Map();
    this.rng = new Rng(20260318);
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    this.renderer = r;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b120c);
    this.scene.fog = new THREE.Fog(0x1b120c, 38, 70);
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 200);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'labels';
    container.appendChild(this.labelLayer);

    this.buildLights();
    this.buildTable();
    this.buildBoard();
    this.buildLand();
    this.buildSea();
    this.buildDanube();
    this.buildRelief();
    this.buildCities();
    this.buildRoutes();
    this.initCamera();
    this.bindInput();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ materials & textures

  mat(color, o = {}) {
    this._mats ||= new Map();
    const key = color + JSON.stringify(o);
    if (!this._mats.has(key)) this._mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, flatShading: true, ...o }));
    return this._mats.get(key);
  }

  canvasTexture(w, h, draw, repeat) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    if (repeat) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
    }
    return t;
  }

  // ------------------------------------------------------------ scene building

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xfff1dc, 0x3a2416, 0.9));
    const key = new THREE.DirectionalLight(0xffe2bc, 2.4);
    key.position.set(-10, 22, 9);
    key.castShadow = true;
    const small = Math.min(innerWidth, innerHeight) < 700;
    key.shadow.mapSize.set(small ? 1536 : 2048, small ? 1536 : 2048);
    Object.assign(key.shadow.camera, { left: -15, right: 15, top: 12, bottom: -12, near: 5, far: 60 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9cc6ff, 0.35);
    rim.position.set(12, 8, -10);
    this.scene.add(rim);
    // warm pool of light on the table, like a lamp over the game
    const lamp = new THREE.PointLight(0xffc98a, 30, 40, 1.6);
    lamp.position.set(0, 14, 2);
    this.scene.add(lamp);
  }

  buildTable() {
    const wood = this.canvasTexture(1024, 1024, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#4a2e1c');
      grad.addColorStop(0.5, '#5a3822');
      grad.addColorStop(1, '#43291a');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      const rng = new Rng(7);
      for (let i = 0; i < 260; i++) {
        const y = rng.next() * h;
        g.strokeStyle = `rgba(${rng.next() > 0.5 ? '30,16,8' : '120,80,48'},${0.08 + rng.next() * 0.12})`;
        g.lineWidth = 1 + rng.next() * 3;
        g.beginPath();
        for (let x = 0; x <= w; x += 16) {
          const yy = y + Math.sin(x * 0.01 + i) * 6 + Math.sin(x * 0.043 + i * 3) * 2;
          if (x === 0) g.moveTo(x, yy);
          else g.lineTo(x, yy);
        }
        g.stroke();
      }
    }, 3);
    const table = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ map: wood, roughness: 0.55, metalness: 0.05 }));
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.62;
    table.receiveShadow = true;
    this.scene.add(table);
  }

  buildBoard() {
    const W = 25.5, H = 18.6;
    const paper = this.canvasTexture(2048, 1494, (g, w, h) => {
      g.fillStyle = '#e9dfc7';
      g.fillRect(0, 0, w, h);
      const rng = new Rng(11);
      for (let i = 0; i < 9000; i++) {
        g.fillStyle = `rgba(${rng.next() > 0.5 ? '120,95,60' : '255,250,235'},${rng.next() * 0.06})`;
        g.fillRect(rng.next() * w, rng.next() * h, 2 + rng.next() * 4, 2 + rng.next() * 4);
      }
      const v = g.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.7);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(90,60,30,0.28)');
      g.fillStyle = v;
      g.fillRect(0, 0, w, h);
      // double frame
      g.strokeStyle = '#7a5a34';
      g.lineWidth = 10;
      g.strokeRect(34, 34, w - 68, h - 68);
      g.lineWidth = 3;
      g.strokeRect(58, 58, w - 116, h - 116);
      // title cartouche
      g.fillStyle = '#7a5a34';
      g.font = '700 74px Georgia, "Times New Roman", serif';
      g.textAlign = 'left';
      g.fillText('MAGISTRALA', 110, 170);
      g.font = 'italic 34px Georgia, serif';
      g.fillText('Căile Ferate ale României · ediția de colecție', 112, 222);
      // compass rose
      const cx = w - 210, cy = h - 220;
      g.save();
      g.translate(cx, cy);
      g.strokeStyle = '#7a5a34';
      g.fillStyle = '#7a5a34';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(0, 0, 110, 0, Math.PI * 2);
      g.stroke();
      for (let k = 0; k < 4; k++) {
        g.rotate(Math.PI / 2);
        g.beginPath();
        g.moveTo(0, -130);
        g.lineTo(18, -18);
        g.lineTo(-18, -18);
        g.closePath();
        g.fill();
      }
      g.font = '700 40px Georgia, serif';
      g.textAlign = 'center';
      g.fillText('N', 0, -150 + (Math.PI * 0));
      g.restore();
      g.font = 'italic 40px Georgia, serif';
      g.fillStyle = 'rgba(122,90,52,0.55)';
      g.textAlign = 'center';
      g.fillText('Marea Neagră', w * 0.875, h * 0.6);
    });
    const side = new THREE.MeshStandardMaterial({ color: 0x2a3b2f, roughness: 0.6 });
    const geo = new THREE.BoxGeometry(W, 0.6, H);
    const top = new THREE.MeshStandardMaterial({ map: paper, roughness: 0.9 });
    const board = new THREE.Mesh(geo, [side, side, top, side, side, side]);
    board.position.y = -0.3;
    board.receiveShadow = true;
    board.castShadow = true;
    this.scene.add(board);
    this.boardSize = { W, H };
  }

  shapeFrom(points) {
    const s = new THREE.Shape();
    points.forEach((p, i) => (i ? s.lineTo(p.x, -p.z) : s.moveTo(p.x, -p.z)));
    s.closePath();
    return s;
  }

  buildLand() {
    const geo = new THREE.ExtrudeGeometry(this.shapeFrom(OUTLINE), { depth: LAND_Y - 0.04, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.08, bevelSegments: 3, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2);
    // painted terrain: plains green-ochre, a darker band along the Carpathian arc
    const tex = this.canvasTexture(1024, 768, (g, w, h) => {
      const toPx = (x, z) => [((x + 12) / 24) * w, ((z + 9) / 18) * h];
      g.fillStyle = '#bccb8a';
      g.fillRect(0, 0, w, h);
      const rng = new Rng(5);
      for (let i = 0; i < 3500; i++) {
        g.fillStyle = `rgba(${rng.next() > 0.5 ? '120,150,80' : '230,220,160'},${rng.next() * 0.12})`;
        g.beginPath();
        g.arc(rng.next() * w, rng.next() * h, 2 + rng.next() * 9, 0, Math.PI * 2);
        g.fill();
      }
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const arc = CARPATHIANS.slice(0, 15);
      for (const [width, color] of [[120, 'rgba(110,135,80,0.35)'], [70, 'rgba(95,115,70,0.4)']]) {
        g.strokeStyle = color;
        g.lineWidth = width;
        g.beginPath();
        arc.forEach((p, i) => (i ? g.lineTo(...toPx(p.x, p.z)) : g.moveTo(...toPx(p.x, p.z))));
        g.stroke();
      }
      // Danube plain and Bărăgan, sun-washed
      const plain = g.createRadialGradient(...toPx(3, 5), 10, ...toPx(3, 5), w * 0.3);
      plain.addColorStop(0, 'rgba(235,215,140,0.45)');
      plain.addColorStop(1, 'rgba(235,215,140,0)');
      g.fillStyle = plain;
      g.fillRect(0, 0, w, h);
    });
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // planar UVs from world xz
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) + 12) / 24;
      uv[i * 2 + 1] = 1 - (pos.getZ(i) + 9) / 18;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const land = new THREE.Mesh(geo, [new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }), new THREE.MeshStandardMaterial({ color: 0x8a6d47, roughness: 0.9 })]);
    land.receiveShadow = true;
    land.castShadow = true;
    this.scene.add(land);
    this.outline = OUTLINE;
  }

  buildSea() {
    this.waterUniforms = { uTime: { value: 0 } };
    const geo = new THREE.ShapeGeometry(this.shapeFrom(SEA));
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      vertexShader: /* glsl */`
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform float uTime; varying vec3 vW;
        void main() {
          float waves = sin(vW.x * 3.1 + uTime * 1.2) * sin(vW.z * 2.7 - uTime * 0.9);
          float coast = smoothstep(9.6, 8.4, vW.x - (vW.z - 5.2) * 0.12);
          vec3 deep = vec3(0.09, 0.33, 0.47), shallow = vec3(0.31, 0.62, 0.66);
          vec3 col = mix(deep, shallow, coast * 0.85) + waves * 0.025;
          col += smoothstep(0.96, 1.0, sin(vW.x * 7.0 + vW.z * 3.0 + uTime * 0.8) * sin(vW.z * 6.0 - uTime * 0.6)) * 0.08;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sea = new THREE.Mesh(geo, mat);
    sea.position.y = 0.012;
    this.scene.add(sea);
  }

  buildDanube() {
    const pts = DANUBE.map((p) => new THREE.Vector3(p.x, LAND_Y + 0.006, p.z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const N = 220;
    const verts = [];
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = curve.getPoint(t);
      const tan = curve.getTangent(t);
      const nx = -tan.z, nz = tan.x;
      const wdt = 0.07 + 0.09 * t; // widens toward the delta
      verts.push(p.x + nx * wdt, p.y, p.z + nz * wdt, p.x - nx * wdt, p.y, p.z - nz * wdt);
      if (i < N) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const river = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3b86b5, roughness: 0.3, metalness: 0.1, side: THREE.DoubleSide }));
    river.receiveShadow = true;
    this.scene.add(river);
  }

  insideLand(x, z) {
    let inside = false;
    const pts = this.outline;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  }

  clearOfNetwork(x, z, cityGap, routeGap) {
    for (const c of Object.values(CITIES)) if (Math.hypot(c.x - x, c.z - z) < cityGap) return false;
    for (const r of ROUTES) {
      const a = CITIES[r.a], b = CITIES[r.b];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(a.x + dx * t - x, a.z + dz * t - z) < routeGap) return false;
    }
    return true;
  }

  buildRelief() {
    const rng = this.rng;
    // mountains along the Carpathian arc and the Apuseni
    const peaks = [];
    const arcs = [CARPATHIANS.slice(0, 15), CARPATHIANS.slice(15)];
    for (const arc of arcs) {
      for (let i = 0; i < arc.length - 1; i++) {
        const a = arc[i], b = arc[i + 1];
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.32);
        for (let s = 0; s < steps; s++) {
          for (let k = 0; k < 2; k++) {
            const x = a.x + ((b.x - a.x) * s) / steps + (rng.next() - 0.5) * 0.9;
            const z = a.z + ((b.z - a.z) * s) / steps + (rng.next() - 0.5) * 0.9;
            if (this.insideLand(x, z) && this.clearOfNetwork(x, z, 0.55, 0.28)) peaks.push({ x, z, h: 0.28 + rng.next() * 0.42, r: 0.18 + rng.next() * 0.14 });
          }
        }
      }
    }
    const coneGeo = new THREE.ConeGeometry(1, 1, 5);
    coneGeo.translate(0, 0.5, 0);
    const rock = new THREE.InstancedMesh(coneGeo, this.mat(0x7f8a78), peaks.length);
    const snow = new THREE.InstancedMesh(coneGeo, this.mat(0xf6f7f4), peaks.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    peaks.forEach((p, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.next() * 6);
      m.compose(new THREE.Vector3(p.x, LAND_Y, p.z), q, new THREE.Vector3(p.r, p.h, p.r));
      rock.setMatrixAt(i, m);
      const snowy = p.h > 0.5;
      m.compose(new THREE.Vector3(p.x, LAND_Y + p.h * 0.62, p.z), q, new THREE.Vector3(snowy ? p.r * 0.4 : 0.0001, p.h * 0.38, snowy ? p.r * 0.4 : 0.0001));
      snow.setMatrixAt(i, m);
    });
    rock.castShadow = snow.castShadow = true;
    rock.receiveShadow = true;
    this.scene.add(rock, snow);

    // forests on the foothills
    const trees = [];
    for (let i = 0; i < 1400 && trees.length < 320; i++) {
      const base = CARPATHIANS[Math.floor(rng.next() * CARPATHIANS.length)];
      const x = base.x + (rng.next() - 0.5) * 2.6, z = base.z + (rng.next() - 0.5) * 2.6;
      if (this.insideLand(x, z) && this.clearOfNetwork(x, z, 0.45, 0.2) && !peaks.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + 0.06)) trees.push({ x, z, s: 0.07 + rng.next() * 0.06 });
    }
    const treeGeo = new THREE.ConeGeometry(1, 2.4, 6);
    treeGeo.translate(0, 1.2, 0);
    const forest = new THREE.InstancedMesh(treeGeo, this.mat(0x3f6b3a), trees.length);
    const color = new THREE.Color();
    trees.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, LAND_Y, t.z), q.identity(), new THREE.Vector3(t.s, t.s, t.s));
      forest.setMatrixAt(i, m);
      forest.setColorAt(i, color.setHSL(0.3 + rng.next() * 0.06, 0.38, 0.26 + rng.next() * 0.1));
    });
    forest.castShadow = true;
    this.scene.add(forest);
  }

  buildCities() {
    this.cityGroup = new THREE.Group();
    this.scene.add(this.cityGroup);
    this.cityPick = [];
    const plinthGeo = new THREE.CylinderGeometry(CITY_R, CITY_R + 0.04, 0.08, 20);
    const roofGeo = new THREE.ConeGeometry(0.075, 0.07, 4);
    roofGeo.rotateY(Math.PI / 4);
    for (const c of Object.values(CITIES)) {
      const g = new THREE.Group();
      g.position.set(c.x, LAND_Y, c.z);
      const plinth = new THREE.Mesh(plinthGeo, this.mat(0xe9dcc0, { flatShading: false, roughness: 0.6 }));
      plinth.position.y = 0.04;
      plinth.receiveShadow = true;
      plinth.castShadow = true;
      g.add(plinth);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(CITY_R + 0.01, 0.018, 6, 40), this.mat(0x8a6a3e, { flatShading: false }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.08;
      g.add(ring);
      const big = c.id === 'B';
      const count = big ? 6 : 3 + ((c.name.length * 7) % 3);
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2 + c.x;
        const d = big ? 0.14 + (k % 2) * 0.05 : 0.13;
        const h = 0.06 + ((k * 13 + c.name.length) % 5) * 0.025 + (big ? 0.06 : 0);
        const house = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), this.mat([0xf4ead8, 0xe8d5b5, 0xf1e1c4][k % 3]));
        house.position.set(Math.cos(a) * d, 0.08 + h / 2, Math.sin(a) * d);
        house.castShadow = true;
        house.receiveShadow = true;
        const roof = new THREE.Mesh(roofGeo, this.mat([0xb4553a, 0x9b4430, 0x6f6a66][k % 3]));
        roof.position.set(house.position.x, 0.08 + h + 0.035, house.position.z);
        roof.castShadow = true;
        g.add(house, roof);
      }
      if (big || c.id === 'CJ' || c.id === 'IS' || c.id === 'SB' || c.id === 'TM') {
        const spire = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.26, 6), this.mat(0x5b6f6a));
        spire.position.set(0, 0.08 + 0.2, 0);
        const tower = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.07), this.mat(0xf2e6cf));
        tower.position.set(0, 0.08 + 0.1, 0);
        tower.castShadow = spire.castShadow = true;
        g.add(tower, spire);
      }
      if (c.id === 'CT') {
        const lh = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.3, 8), this.mat(0xf6f1e6));
        lh.position.set(0.12, 0.23, 0.1);
        lh.castShadow = true;
        g.add(lh);
      }
      const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.5, 12), new THREE.MeshBasicMaterial({ visible: false }));
      pick.position.y = 0.2;
      pick.userData = { city: c.id };
      g.add(pick);
      this.cityPick.push(pick);
      this.cityGroup.add(g);

      const el = document.createElement('div');
      el.className = `city-label${big ? ' capital' : ''}`;
      el.textContent = c.name;
      this.labelLayer.appendChild(el);
      this.labels.set(c.id, el);
    }
    // beacons used to point out ticket destinations
    this.beacons = new Map();
  }

  routeCurve(r) {
    const a = CITIES[r.a], b = CITIES[r.b];
    const A = new THREE.Vector3(a.x, SLOT_Y, a.z), B = new THREE.Vector3(b.x, SLOT_Y, b.z);
    const mid = A.clone().lerp(B, 0.5);
    const dir = B.clone().sub(A);
    const perp = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    // bend around cities that sit on the straight line
    let bend = 0;
    for (const c of Object.values(CITIES)) {
      if (c.id === r.a || c.id === r.b) continue;
      const t = ((c.x - a.x) * dir.x + (c.z - a.z) * dir.z) / dir.lengthSq();
      if (t <= 0.05 || t >= 0.95) continue;
      const px = a.x + dir.x * t, pz = a.z + dir.z * t;
      const d = Math.hypot(px - c.x, pz - c.z);
      if (d < 0.55) bend = ((c.x - px) * perp.x + (c.z - pz) * perp.z > 0 ? -1 : 1) * (0.75 - d);
    }
    const ctrl = mid.add(perp.multiplyScalar(bend * 1.4));
    return new THREE.QuadraticBezierCurve3(A, ctrl, B);
  }

  buildRoutes() {
    this.routeData = new Map();
    this.routePick = [];
    const slotGeoCache = new Map();
    for (const r of ROUTES) {
      const curve = this.routeCurve(r);
      const total = curve.getLength();
      const usable = total - CITY_R * 2 - 0.08;
      const seg = usable / r.len;
      const slotLen = seg - 0.06;
      if (!slotGeoCache.has(slotLen.toFixed(3))) slotGeoCache.set(slotLen.toFixed(3), new THREE.BoxGeometry(slotLen, 0.05, 0.19));
      const geo = slotGeoCache.get(slotLen.toFixed(3));
      const slots = [];
      for (let k = 0; k < r.len; k++) {
        const dist = CITY_R + 0.04 + seg * (k + 0.5);
        const t = curve.getUtoTmapping(dist / total);
        const p = curve.getPoint(t);
        const tan = curve.getTangent(t);
        const angle = Math.atan2(-tan.z, tan.x);
        const color = CARD_HEX[r.color];
        const slot = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, emissive: 0x000000 }));
        slot.position.copy(p);
        slot.rotation.y = angle;
        slot.receiveShadow = true;
        slot.castShadow = true;
        const edge = new THREE.Mesh(geo, this.mat(0x3a2a18, { flatShading: false }));
        edge.scale.set(1.06, 0.6, 1.25);
        edge.position.y = -0.012;
        slot.add(edge);
        this.scene.add(slot);
        const pick = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
        pick.scale.set(1.05, 6, 2.6);
        pick.userData = { route: r.id };
        slot.add(pick);
        this.routePick.push(pick);
        slots.push({ mesh: slot, p, angle, len: slotLen });
      }
      this.routeData.set(r.id, { route: r, curve, slots });
    }
  }

  // ------------------------------------------------------------ camera

  initCamera() {
    this.cam = { x: 0, z: 0.4, dist: 30, tx: 0, tz: 0.4, tdist: 30, tilt: 0.95, homeX: 0, homeZ: 0.4 };
    this.insets = { top: 0, bottom: 0 };
  }

  /** Screen space covered by the HUD; the fitted map stays inside the rest. */
  setInsets(top, bottom) {
    const changed = Math.abs(top - this.insets.top) > 2 || Math.abs(bottom - this.insets.bottom) > 2;
    this.insets = { top, bottom };
    this.resize();
    if (changed) this.resetView();
  }

  placeCamera(camera, x, z, dist, tilt) {
    camera.position.set(x, Math.cos(tilt) * dist + LAND_Y, z + Math.sin(tilt) * dist);
    camera.lookAt(x, LAND_Y, z);
    camera.updateMatrixWorld();
  }

  /** Smallest distance that shows the whole country inside the free screen area. */
  fitView() {
    const corners = [[-10.3, -7.5], [10.6, -7.5], [-10.3, 7.4], [10.6, 7.4]];
    const free = this.h - this.insets.top - this.insets.bottom;
    const yTop = 1 - (2 * this.insets.top) / this.h, yBot = -1 + (2 * this.insets.bottom) / this.h;
    const yMid = (yTop + yBot) / 2, yHalf = (yTop - yBot) / 2;
    const cam = this.camera.clone();
    let lo = 4, hi = 160;
    let shift = 0;
    for (let it = 0; it < 40; it++) {
      const d = (lo + hi) / 2;
      this.placeCamera(cam, 0, 0, d, this.cam.tilt);
      const pts = corners.map(([x, z]) => new THREE.Vector3(x, LAND_Y, z).project(cam));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      const fitsX = pts.every((p) => Math.abs(p.x) < 0.97 && p.z > -1 && p.z < 1);
      const fitsY = maxY - minY < yHalf * 2 * 0.97;
      if (fitsX && fitsY) { hi = d; shift = (minY + maxY) / 2 - yMid; } else lo = d;
    }
    // shift the target so the map is centred in the free area
    this.placeCamera(cam, 0, 0, hi, this.cam.tilt);
    const a = new THREE.Vector3(0, LAND_Y, 0).project(cam);
    const b = new THREE.Vector3(0, LAND_Y, 1).project(cam);
    const dz = Math.abs(b.y - a.y) > 1e-6 ? shift / (b.y - a.y) : 0;
    return { dist: hi, z: dz, free };
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // portrait phones look more from above so the wide country is not squashed
    this.cam.tilt = w / h < 0.8 ? 0.42 : w / h < 1.2 ? 0.62 : 0.86;
    const fit = this.fitView();
    this.maxDist = fit.dist;
    this.cam.homeZ = fit.z;
    if (!this.sized) {
      this.cam.dist = this.cam.tdist = this.maxDist;
      this.cam.z = this.cam.tz = this.cam.homeZ;
      this.sized = true;
    }
    this.cam.tdist = Math.min(this.cam.tdist, this.maxDist);
    this.scene.fog.near = this.maxDist + 6;
    this.scene.fog.far = this.maxDist * 2.2 + 30;
  }

  resetView() {
    this.cam.tx = 0;
    this.cam.tz = this.cam.homeZ;
    this.cam.tdist = this.maxDist;
  }

  /** Smoothly bring a point (and optionally a zoom level) into view. */
  focus(x, z, dist) {
    this.cam.tx = x;
    this.cam.tz = z;
    if (dist) this.cam.tdist = Math.min(this.maxDist, dist);
  }

  focusRoute(id) {
    const r = ROUTES[id];
    const a = CITIES[r.a], b = CITIES[r.b];
    const span = Math.hypot(a.x - b.x, a.z - b.z);
    this.focus((a.x + b.x) / 2, (a.z + b.z) / 2 + 0.4, Math.max(9, Math.min(this.cam.dist, span * 3.2 + 7)));
  }

  groundAt(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray ||= new THREE.Raycaster();
    this.ray.setFromCamera(ndc, this.camera);
    const t = -(this.ray.ray.origin.y - LAND_Y) / this.ray.ray.direction.y;
    return this.ray.ray.origin.clone().addScaledVector(this.ray.ray.direction, t);
  }

  bindInput() {
    const el = this.renderer.domElement;
    const pts = new Map();
    let tap = null, pinch = null, lastTap = 0;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
        tap = null;
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.cam.tdist = Math.min(this.maxDist, Math.max(5.5, this.cam.tdist * (pinch.d / d)));
        pinch.d = d;
      } else if (pts.size === 1) {
        if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8) return;
        tap = null;
        const g0 = this.groundAt(prev.x, prev.y), g1 = this.groundAt(e.clientX, e.clientY);
        this.cam.tx -= g1.x - g0.x;
        this.cam.tz -= g1.z - g0.z;
        this.cam.x = this.cam.tx;
        this.cam.z = this.cam.tz;
        this.clampTarget();
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (tap && performance.now() - tap.t < 500) {
        const now = performance.now();
        if (now - lastTap < 300) {
          // double tap: zoom in, or back out when already close
          const g = this.groundAt(e.clientX, e.clientY);
          if (this.cam.tdist < this.maxDist * 0.6) this.resetView();
          else this.focus(g.x, g.z, this.maxDist * 0.45);
          lastTap = 0;
        } else {
          lastTap = now;
          this.onTap(this.pick(e.clientX, e.clientY));
        }
      }
      tap = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); tap = null; pinch = null; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cam.tdist = Math.min(this.maxDist, Math.max(5.5, this.cam.tdist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
  }

  clampTarget() {
    this.cam.tx = Math.max(-10, Math.min(10, this.cam.tx));
    this.cam.tz = Math.max(-7, Math.min(7.5, this.cam.tz));
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.ray ||= new THREE.Raycaster();
    this.ray.setFromCamera(ndc, this.camera);
    const city = this.ray.intersectObjects(this.cityPick)[0];
    if (city) return { city: city.object.userData.city };
    const route = this.ray.intersectObjects(this.routePick)[0];
    if (route) return { route: route.object.userData.route };
    // forgiving fallback: nearest route within 26px on screen
    let best = null, bestD = 26;
    for (const [id, d] of this.routeData) {
      for (const s of d.slots) {
        const v = s.p.clone().project(this.camera);
        const sx = ((v.x + 1) / 2) * rect.width + rect.left, sy = ((1 - v.y) / 2) * rect.height + rect.top;
        const dist = Math.hypot(sx - clientX, sy - clientY);
        if (dist < bestD) { bestD = dist; best = id; }
      }
    }
    return best !== null ? { route: best } : {};
  }

  // ------------------------------------------------------------ state sync

  setHighlight({ routes = [], cities = [] } = {}) {
    this.highlight = { routes: new Set(routes), cities: new Set(cities) };
  }

  setBeacons(cities) {
    for (const [id, b] of this.beacons) if (!cities.includes(id)) { this.scene.remove(b); this.beacons.delete(id); }
    for (const id of cities) {
      if (this.beacons.has(id)) continue;
      const c = CITIES[id];
      const geo = new THREE.CylinderGeometry(0.16, 0.3, 3.2, 20, 1, true);
      geo.translate(0, 1.6, 0);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd36e, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
      const beam = new THREE.Mesh(geo, mat);
      beam.position.set(c.x, LAND_Y, c.z);
      this.scene.add(beam);
      this.beacons.set(id, beam);
    }
  }

  /** Make the board match a view without animation (used on load and reconnect). */
  sync(view) {
    for (const [id, owner] of Object.entries(view.routes)) {
      const rid = Number(id);
      if (owner === null) {
        if (this.trainMeshes.has(rid)) {
          for (const m of this.trainMeshes.get(rid)) this.scene.remove(m);
          this.trainMeshes.delete(rid);
        }
      } else if (!this.trainMeshes.has(rid)) this.placeTrains(rid, owner, false);
    }
    for (const [city, m] of this.stationMeshes) if (view.stations[city] === undefined) { this.scene.remove(m); this.stationMeshes.delete(city); }
    for (const [city, owner] of Object.entries(view.stations)) if (!this.stationMeshes.has(city)) this.placeStation(city, owner, false);
  }

  // ------------------------------------------------------------ meshes for pieces

  carMesh(color, len) {
    // long slots carry a short coupled train instead of one stretched car
    const n = Math.max(1, Math.round(len / 0.5));
    if (n > 1) {
      const g = new THREE.Group();
      const each = len / n;
      for (let k = 0; k < n; k++) {
        const car = this.carMesh(color, each);
        car.position.x = -len / 2 + each * (k + 0.5);
        g.add(car);
      }
      return g;
    }
    const g = new THREE.Group();
    const L = Math.max(0.2, len * 0.86);
    const body = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, 0.15), this.mat(color, { roughness: 0.4, flatShading: false }));
    body.position.y = 0.1;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(L * 0.96, 0.025, 0.165), this.mat(new THREE.Color(color).multiplyScalar(0.7).getHex(), { flatShading: false }));
    roof.position.y = 0.172;
    const windows = new THREE.Mesh(new THREE.BoxGeometry(L * 0.78, 0.026, 0.152), this.mat(0x1d2b36, { roughness: 0.2, metalness: 0.3, flatShading: false }));
    windows.position.y = 0.12;
    g.add(body, roof, windows);
    const wheelGeo = this._wheelGeo ||= new THREE.CylinderGeometry(0.03, 0.03, 0.16, 10).rotateX(Math.PI / 2);
    for (const x of [-L * 0.32, L * 0.32]) {
      const w = new THREE.Mesh(wheelGeo, this.mat(0x222222));
      w.position.set(x, 0.035, 0);
      g.add(w);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  }

  locomotive(color) {
    const g = new THREE.Group();
    const boiler = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 14).rotateZ(Math.PI / 2), this.mat(0x2b2b30, { flatShading: false, metalness: 0.4, roughness: 0.35 }));
    boiler.position.set(0.04, 0.11, 0);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.16), this.mat(color, { flatShading: false, roughness: 0.4 }));
    cab.position.set(-0.13, 0.14, 0);
    const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.08, 10), this.mat(0x1a1a1a));
    chimney.position.set(0.13, 0.21, 0);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
    lamp.position.set(0.2, 0.12, 0);
    g.add(boiler, cab, chimney, lamp);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.userData.chimney = chimney;
    return g;
  }

  placeTrains(routeId, owner, animate = true, onCar) {
    const data = this.routeData.get(routeId);
    const color = PLAYER_HEX[owner];
    const cars = data.slots.map((s) => {
      const car = this.carMesh(color, s.len);
      car.position.copy(s.p);
      car.rotation.y = s.angle;
      this.scene.add(car);
      return car;
    });
    this.trainMeshes.set(routeId, cars);
    if (!animate) return Promise.resolve();
    cars.forEach((c) => c.scale.setScalar(0.0001));
    return Promise.all(cars.map((car, k) => {
      const s = data.slots[k];
      return this.tween(0.42, (p) => {
        const e = easeOutBack(p);
        car.scale.setScalar(Math.max(0.0001, e));
        car.position.y = s.p.y + (1 - easeOutCubic(p)) * 1.6;
        car.rotation.z = (1 - p) * 0.4;
      }, k * 0.09).then(() => {
        this.puff(s.p, 0xf1e6cf, 6);
        onCar?.(k);
      });
    })).then(() => this.runLocomotive(routeId, color));
  }

  runLocomotive(routeId, color) {
    if (this.reduced) return Promise.resolve();
    const { curve } = this.routeData.get(routeId);
    const loco = this.locomotive(color);
    loco.position.y = 0.06;
    this.scene.add(loco);
    const up = new THREE.Vector3();
    return this.tween(1.25, (p) => {
      const t = 0.04 + easeInOut(p) * 0.92;
      const pos = curve.getPoint(t);
      const tan = curve.getTangent(t);
      loco.position.set(pos.x, pos.y + 0.12, pos.z);
      loco.rotation.y = Math.atan2(-tan.z, tan.x);
      loco.scale.setScalar(Math.min(1, Math.min(p, 1 - p) * 8));
      if (Math.random() < 0.35) {
        loco.userData.chimney.getWorldPosition(up);
        this.smoke(up);
      }
    }).then(() => this.scene.remove(loco));
  }

  placeStation(city, owner, animate = true) {
    const c = CITIES[city];
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.16), this.mat(0xf6ecd8));
    base.position.y = 0.06;
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.0, 0.2, 0.1, 4).rotateY(Math.PI / 4), this.mat(PLAYER_HEX[owner]));
    roof.scale.set(1.3, 1, 0.85);
    roof.position.y = 0.17;
    const clock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.06), this.mat(0xf6ecd8));
    clock.position.set(0.1, 0.16, 0);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 4).rotateY(Math.PI / 4), this.mat(PLAYER_HEX[owner]));
    cap.position.set(0.1, 0.3, 0);
    const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.18, 4), this.mat(0x444444));
    flagPole.position.set(-0.11, 0.21, 0.05);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.045, 0.006), this.mat(PLAYER_HEX[owner]));
    flag.position.set(-0.07, 0.28, 0.05);
    g.add(base, roof, clock, cap, flagPole, flag);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.position.set(c.x - 0.2, LAND_Y + 0.08, c.z + 0.26);
    g.userData.flag = flag;
    this.scene.add(g);
    this.stationMeshes.set(city, g);
    if (!animate) return Promise.resolve();
    g.scale.setScalar(0.0001);
    return this.tween(0.6, (p) => g.scale.setScalar(Math.max(0.0001, easeOutBack(p)))).then(() => this.sparkle(g.position, PLAYER_HEX[owner]));
  }

  coins(city, owner) {
    const c = CITIES[city];
    const geo = this._coinGeo ||= new THREE.CylinderGeometry(0.06, 0.06, 0.015, 16);
    const mat = this.mat(0xf5c542, { metalness: 0.7, roughness: 0.25, flatShading: false });
    for (let k = 0; k < 8; k++) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(c.x, LAND_Y + 0.3, c.z);
      this.scene.add(m);
      const a = (k / 8) * Math.PI * 2;
      this.particles.push({ m, v: new THREE.Vector3(Math.cos(a) * 0.6, 2.2 + Math.random(), Math.sin(a) * 0.6), spin: 8 + Math.random() * 6, life: 0, max: 1.1, g: 5, keepOpaque: true });
    }
    this.sparkle(new THREE.Vector3(c.x, LAND_Y + 0.3, c.z), PLAYER_HEX[owner]);
  }

  // ------------------------------------------------------------ particles & tweens

  puff(pos, color = 0xf3ead8, n = 10) {
    const geo = this._puffGeo ||= new THREE.IcosahedronGeometry(0.05, 0);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, opacity: 0.85 }));
      const a = Math.random() * Math.PI * 2;
      m.position.copy(pos);
      this.scene.add(m);
      this.particles.push({ m, v: new THREE.Vector3(Math.cos(a) * 0.7, 0.4 + Math.random() * 0.4, Math.sin(a) * 0.7), life: 0, max: 0.6, g: 1, grow: 1.5 });
    }
  }

  smoke(pos) {
    const geo = this._puffGeo ||= new THREE.IcosahedronGeometry(0.05, 0);
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe9e4dc, roughness: 1, transparent: true, opacity: 0.8 }));
    m.position.copy(pos);
    this.scene.add(m);
    this.particles.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 0.1, 0.5, (Math.random() - 0.5) * 0.1), life: 0, max: 1.1, g: -0.1, grow: 3 });
  }

  sparkle(pos, color) {
    const geo = this._sparkGeo ||= new THREE.OctahedronGeometry(0.035, 0);
    for (let k = 0; k < 16; k++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true }));
      m.position.copy(pos);
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      this.particles.push({ m, v: new THREE.Vector3(Math.cos(a) * 0.8, 1.6 + Math.random() * 1.2, Math.sin(a) * 0.8), life: 0, max: 0.9, g: 3.5, spin: 6 });
    }
  }

  tween(dur, fn, delay = 0) {
    return new Promise((res) => this.tweens.push({ t0: this.clock + delay, dur, fn, res }));
  }

  wait(ms) { return this.tween(ms / 1000, () => {}); }

  // ------------------------------------------------------------ frame loop

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, raw);
    this.last = now;
    if (document.hidden) return;
    // animations follow real time even when frames are slow; physics stays stable
    this.clock += Math.min(0.25, raw);
    for (const tw of [...this.tweens]) {
      if (this.clock < tw.t0) continue;
      const p = Math.min(1, (this.clock - tw.t0) / tw.dur);
      tw.fn(p);
      if (p >= 1) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.res();
      }
    }
    this.waterUniforms.uTime.value = this.clock;

    // camera
    const c = this.cam;
    const k = 1 - Math.pow(0.002, dt);
    c.x += (c.tx - c.x) * k;
    c.z += (c.tz - c.z) * k;
    c.dist += (c.tdist - c.dist) * k;
    const tilt = c.tilt + (1 - c.dist / this.maxDist) * 0.25;
    this.placeCamera(this.camera, c.x, c.z, c.dist, tilt);

    // highlights
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 6);
    for (const [id, d] of this.routeData) {
      const on = this.highlight.routes.has(id);
      for (const s of d.slots) {
        s.mesh.material.emissive.setHex(on ? 0xffd36e : 0x000000);
        s.mesh.material.emissiveIntensity = on ? 0.25 + pulse * 0.45 : 0;
        s.mesh.position.y = s.p.y + (on ? 0.03 + pulse * 0.02 : 0);
      }
    }
    for (const b of this.beacons.values()) {
      b.material.opacity = 0.2 + pulse * 0.2;
      b.rotation.y += dt;
    }
    for (const st of this.stationMeshes.values()) st.userData.flag.rotation.y = Math.sin(this.clock * 3 + st.position.x) * 0.5;

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      const t = p.life / p.max;
      if (t >= 1) {
        this.scene.remove(p.m);
        if (!p.m.material.isMeshStandardMaterial || p.m.material.transparent) p.m.material.dispose?.();
        this.particles.splice(i, 1);
        continue;
      }
      p.v.y -= (p.g ?? 1) * dt;
      p.m.position.addScaledVector(p.v, dt);
      if (p.spin) p.m.rotation.x += p.spin * dt;
      if (p.grow) p.m.scale.setScalar(1 + t * p.grow);
      if (p.m.material.transparent && !p.keepOpaque) p.m.material.opacity = (1 - t) * 0.85;
    }

    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
  }

  updateLabels() {
    const v = new THREE.Vector3();
    const zoom = this.maxDist / this.cam.dist;
    const scale = Math.min(1.25, (this.w < 500 ? 0.66 : 0.82) + zoom * 0.16);
    for (const [id, el] of this.labels) {
      const c = CITIES[id];
      v.set(c.x, LAND_Y + 0.1, c.z + CITY_R + 0.12).project(this.camera);
      const x = ((v.x + 1) / 2) * this.w, y = ((1 - v.y) / 2) * this.h;
      el.style.transform = `translate(-50%, 0) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      el.classList.toggle('lit', this.highlight.cities.has(id));
    }
  }

  /** Screen position of the middle of a route (for HTML effects). */
  screenOfRoute(id) {
    const { slots } = this.routeData.get(id);
    const v = slots[Math.floor(slots.length / 2)].p.clone().project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** Screen position of a city (for HTML effects). */
  screenOf(cityId) {
    const c = CITIES[cityId];
    const v = new THREE.Vector3(c.x, LAND_Y + 0.3, c.z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
}
