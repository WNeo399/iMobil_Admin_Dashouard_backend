/*!
 * iMobile 3D exploded-view viewer — ES module, hand-written, no build step.
 *
 * Shared by the Embed Ordering widget (./v1.js, the "3D view" of a model) and
 * the dashboard's Embed Ordering → 3D Diagrams page (preview + part picking).
 * Three.js comes from ../vendor/three-0.180.0.js (a trimmed, pre-built bundle).
 *
 *   import { createViewer, webglAvailable } from ".../viewer3d.js";
 *   const v = createViewer(hostElement, { accent: "#0b7fd4", onSelect, onHover, onExploded });
 *   const { parts } = await v.load(glbArrayBuffer);   // [{ code, label }]
 *   v.select("QBA01"); v.select(""); v.setExploded(0.5); v.reset(); v.dispose();
 *
 * What a model file must look like (any source — the S24 file follows it):
 *   - one node per part, carrying glTF extras { code, label } — or, without
 *     extras, named "<CODE>_<Label>" under the scene's root node;
 *   - optional extras.assembled [x,y,z] (the part's assembled position) and
 *     extras.explode [x,y,z] (how far it moves when fully separated). Without
 *     them an "Explode" animation is read instead, and failing that the parts
 *     are spread along Z automatically;
 *   - the phone face in X/Y, +Z towards the back cover. Any unit — the camera
 *     and all distances follow the model's own size;
 *   - optional extras.view "front" for parts best seen from the screen side.
 */
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  HemisphereLight,
  DirectionalLight,
  PMREMGenerator,
  Box3,
  Sphere,
  Vector2,
  Vector3,
  Matrix4,
  Raycaster,
  MathUtils,
  Color,
  Mesh,
  ACESFilmicToneMapping,
  GLTFLoader,
  OrbitControls,
  RoomEnvironment,
  mergeGeometries,
} from "../vendor/three-0.180.0.js";

export const VIEWER_VERSION = 1;

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (e) {
    return false;
  }
}

const VIEW_DIR = new Vector3(0.27, 0.19, 0.31).normalize(); // over the right shoulder of the back cover
const START = 0.8; // separation after loading (0 assembled … 1 fully exploded)
const noop = () => {};

function vec3(a) {
  return Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === "number" && isFinite(n)) ? new Vector3(a[0], a[1], a[2]) : null;
}
function str(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

// The part nodes of a loaded scene: nodes with extras.code (the top-most
// ones), else "<CODE>_<Label>" children of the root wrapper.
function findParts(root) {
  const found = [];
  (function walk(o) {
    const code = o.userData && typeof o.userData.code === "string" ? str(o.userData.code, 40) : "";
    if (code && o !== root) {
      found.push({ node: o, code, label: str(o.userData.label, 120) || code });
      return;
    }
    o.children.forEach(walk);
  })(root);
  if (found.length) return found;
  let top = root;
  while (top.children.length === 1 && top.children[0].children.length) top = top.children[0];
  top.children.forEach((o) => {
    const m = String(o.name || "").match(/^([A-Za-z0-9-]{2,40})_(.+)$/);
    if (m) found.push({ node: o, code: m[1], label: m[2].replace(/_/g, " ").trim() || m[1] });
  });
  return found;
}

// Merge each part's meshes that share a material (one draw call per
// material instead of hundreds of small meshes). Anything unusual is left
// exactly as it was.
function signature(g) {
  if (Object.keys(g.morphAttributes || {}).length) return null;
  const keys = Object.keys(g.attributes).sort();
  const sig = [];
  for (const k of keys) {
    const a = g.attributes[k];
    if (!a || a.isInterleavedBufferAttribute || !a.array) return null;
    sig.push(k + ":" + a.itemSize + ":" + (a.normalized ? 1 : 0) + ":" + a.array.constructor.name);
  }
  return (g.index ? "i|" : "n|") + sig.join(",");
}
function mergePart(node) {
  node.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(node.matrixWorld).invert();
  const groups = new Map();
  node.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || Array.isArray(o.material) || !o.geometry) return;
    if (o.matrixWorld.determinant() <= 0) return; // mirrored: merging would flip its faces
    const sig = signature(o.geometry);
    if (!sig) return;
    const k = o.material.uuid + "|" + sig;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  });
  let merged = 0;
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const geos = meshes.map((m) => m.geometry.clone().applyMatrix4(new Matrix4().multiplyMatrices(inv, m.matrixWorld)));
    let g = null;
    try {
      g = mergeGeometries(geos, false);
    } catch (e) {
      g = null;
    }
    geos.forEach((x) => x.dispose());
    if (!g) continue;
    const one = new Mesh(g, meshes[0].material);
    one.name = node.name + "_merged";
    node.add(one);
    meshes.forEach((m) => {
      m.parent.remove(m);
      m.geometry.dispose();
    });
    merged += meshes.length - 1;
  }
  return merged;
}

export function createViewer(host, opts) {
  opts = opts || {};
  const onSelect = opts.onSelect || noop;
  const onHover = opts.onHover || noop;
  const onExploded = opts.onExploded || noop;
  const accent = new Color(opts.accent || "#0b7fd4");
  const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // throws when WebGL isn't available — the caller shows its own message
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;outline:none";
  canvas.setAttribute("aria-label", opts.label || "3D model — drag to turn, scroll or pinch to zoom");
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.001, 10);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = opts.pan !== false;

  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04);
  scene.environment = env.texture;
  room.dispose();
  pmrem.dispose();
  scene.add(new HemisphereLight(0xe0f0ff, 0x40536b, 2));
  const key = new DirectionalLight(0xffffff, 3);
  key.position.set(1, 2, 3);
  scene.add(key);

  let model = null; // gltf.scene
  let parts = []; // { code, label, node, assembled, explode, pull, face, mats: [{ m, emissive, intensity }] }
  const partOf = new Map(); // node → part
  let R = 0.1; // model radius (fully exploded)
  let center = new Vector3();
  let pullDist = 0.16;
  let current = 0;
  let target = START;
  let focus = null;
  let hover = null;
  let framing = false;
  let disposed = false;
  let raf = 0;
  let last = 0;
  const faces = {};

  const box = new Box3();
  const sphere = new Sphere();
  const goCenter = new Vector3();
  const goCam = new Vector3();

  // ── the frame loop runs only while something moves ──
  function kick() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }
  function placeParts() {
    for (const p of parts) {
      p.node.position.copy(p.assembled).addScaledVector(p.explode, current);
      p.node.position.x += p.pull;
    }
  }
  function frame(now) {
    raf = 0;
    if (disposed) return;
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
    last = now;
    const blend = reduced ? 1 : 1 - Math.exp(-8 * dt);
    let moving = false;
    if (Math.abs(current - target) > 1e-4) {
      current = MathUtils.lerp(current, target, blend);
      moving = true;
    } else current = target;
    for (const p of parts) {
      const want = p === focus ? pullDist : 0;
      if (Math.abs(p.pull - want) > R * 1e-4) {
        p.pull = MathUtils.lerp(p.pull, want, blend);
        moving = true;
      } else p.pull = want;
    }
    placeParts();
    if (framing) {
      if (focus) {
        focus.node.updateWorldMatrix(true, true);
        box.setFromObject(focus.node);
        box.getBoundingSphere(sphere);
        goCenter.copy(sphere.center);
        const half = Math.min(MathUtils.degToRad(camera.fov / 2), Math.atan(Math.tan(MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
        const dist = Math.max(R * 0.06, (sphere.radius / Math.sin(half)) * 1.3);
        goCam.set(0.2, 0.12, faceSign(focus)).normalize().multiplyScalar(dist).add(goCenter);
        controls.minDistance = Math.max(R * 0.02, sphere.radius * 1.1);
      } else {
        goCenter.copy(center);
        goCam.copy(VIEW_DIR).multiplyScalar(homeDistance()).add(center);
        controls.minDistance = R * 0.5;
      }
      controls.target.lerp(goCenter, blend);
      camera.position.lerp(goCam, blend);
      if (camera.position.distanceTo(goCam) < R * 2e-4 && controls.target.distanceTo(goCenter) < R * 2e-4 && !moving) framing = false;
      else moving = true;
    }
    if (controls.update()) moving = true;
    renderer.render(scene, camera);
    if (moving) kick();
    else last = 0;
  }
  // A picked part is looked at from the back (the side a repairer sees with
  // the back cover off) unless it is set to "front" — the screen, the front
  // camera. Set per part on the dashboard, or extras.view in the file.
  function faceSign(p) {
    return (faces[p.code] || p.face) === "front" ? -1 : 1;
  }
  function homeDistance() {
    const half = Math.min(MathUtils.degToRad(camera.fov / 2), Math.atan(Math.tan(MathUtils.degToRad(camera.fov / 2)) * camera.aspect));
    return (R / Math.sin(half)) * 1.02;
  }

  // ── size ──
  function resize() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    kick();
  }
  const ro = window.ResizeObserver ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(host);
  else window.addEventListener("resize", resize);
  resize();

  // ── highlight (each part has its own copies of its materials) ──
  function paint(p) {
    if (!p) return;
    const on = p === focus ? 0.22 : p === hover ? 0.14 : 0;
    for (const x of p.mats) {
      if (!x.m.emissive) continue;
      if (on) {
        x.m.emissive.copy(p === focus ? accent : x.hoverColor);
        x.m.emissiveIntensity = on;
      } else {
        x.m.emissive.copy(x.emissive);
        x.m.emissiveIntensity = x.intensity;
      }
    }
  }
  const HOVER = new Color(0x9fb8d0);
  function ownMaterials(p) {
    const copies = new Map();
    p.node.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const one = (m) => {
        if (!copies.has(m.uuid)) {
          const c = m.clone();
          copies.set(m.uuid, c);
          p.mats.push({ m: c, emissive: c.emissive ? c.emissive.clone() : null, intensity: c.emissiveIntensity, hoverColor: HOVER });
        }
        return copies.get(m.uuid);
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
  }

  // ── picking ──
  const ray = new Raycaster();
  const ndc = new Vector2();
  function pick(clientX, clientY) {
    if (!model) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(model, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !partOf.has(o)) o = o.parent;
      if (o) return partOf.get(o);
    }
    return null;
  }
  let down = null;
  function onDown(e) {
    down = { x: e.clientX, y: e.clientY, id: e.pointerId, t: Date.now() };
  }
  function onUp(e) {
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = Date.now() - down.t < 700;
    down = null;
    if (moved > 6 || !quick) return;
    const p = pick(e.clientX, e.clientY);
    if (p) {
      select(p.code);
      onSelect(p.code);
    } else if (focus) {
      select("");
      onSelect("");
    }
  }
  let hoverRaf = 0;
  let hoverAt = null;
  function onMove(e) {
    if (e.pointerType && e.pointerType !== "mouse") return;
    if (e.buttons) {
      setHover(null);
      return;
    }
    hoverAt = { x: e.clientX, y: e.clientY };
    if (!hoverRaf) {
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        if (!hoverAt || disposed) return;
        setHover(pick(hoverAt.x, hoverAt.y), hoverAt);
      });
    }
  }
  function onLeave() {
    hoverAt = null;
    setHover(null);
  }
  function setHover(p, at) {
    if (p !== hover) {
      const was = hover;
      hover = p;
      paint(was);
      paint(hover);
      canvas.style.cursor = hover ? "pointer" : "";
      kick();
    }
    onHover(hover ? { code: hover.code, label: hover.label } : null, at || null);
  }
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  const stopFraming = () => {
    framing = false;
  };
  controls.addEventListener("start", stopFraming);
  controls.addEventListener("change", kick);

  // ── loading ──
  function load(buffer) {
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer, "", (gltf) => {
        try {
          if (disposed) return reject(new Error("closed"));
          resolve(setup(gltf));
        } catch (e) {
          reject(e);
        }
      }, (e) => reject(e instanceof Error ? e : new Error("The 3D file couldn't be read")));
    });
  }

  function setup(gltf) {
    const root = gltf.scene;
    const found = findParts(root);
    if (!found.length) throw new Error("No parts found in this 3D file");
    const seen = new Set();
    const clip = (gltf.animations || []).find((a) => /explode/i.test(a.name)) || (gltf.animations || [])[0] || null;
    const trackOf = (node) => (clip ? clip.tracks.find((t) => t.name === node.name + ".position") : null);
    parts = [];
    for (const f of found) {
      if (seen.has(f.code)) continue;
      seen.add(f.code);
      const ud = f.node.userData || {};
      const track = trackOf(f.node);
      let assembled = vec3(ud.assembled);
      let explode = vec3(ud.explode);
      if (track && track.values.length >= 6) {
        const v = track.values;
        const a = new Vector3(v[0], v[1], v[2]);
        const b = new Vector3(v[v.length - 3], v[v.length - 2], v[v.length - 1]);
        if (!assembled) assembled = a;
        if (!explode) explode = b.sub(a);
      }
      parts.push({
        code: f.code,
        label: f.label,
        node: f.node,
        assembled: assembled || f.node.position.clone(),
        explode: explode, // filled in below when missing
        pull: 0,
        face: ud.view === "front" || ud.view === "back" ? ud.view : "",
        mats: [],
      });
    }
    // assembled size: the pull distance and the automatic spread follow it
    for (const p of parts) p.node.position.copy(p.assembled);
    root.updateWorldMatrix(true, true);
    const assembledBox = new Box3().setFromObject(root);
    const size = assembledBox.getSize(new Vector3());
    const mid = assembledBox.getCenter(new Vector3());
    const auto = parts.filter((p) => !p.explode);
    if (auto.length) {
      // no explode data: spread the parts along Z in their stacking order
      const zOf = (p) => new Box3().setFromObject(p.node).getCenter(new Vector3()).z;
      const step = Math.max(size.x, size.y, size.z) * 0.08;
      auto.sort((a, b) => zOf(a) - zOf(b)).forEach((p, i) => {
        p.explode = new Vector3(0, 0, (i - (auto.length - 1) / 2) * step);
      });
    }
    pullDist = Math.max(size.x, 1e-6) * 2.3;

    for (const p of parts) {
      partOf.set(p.node, p);
      ownMaterials(p);
      mergePart(p.node);
    }

    // fully exploded bounds: the camera's home view fits them all
    for (const p of parts) p.node.position.copy(p.assembled).add(p.explode);
    root.updateWorldMatrix(true, true);
    new Box3().setFromObject(root).getBoundingSphere(sphere);
    R = Math.max(sphere.radius, 1e-6);
    center.copy(mid);

    camera.near = R / 200;
    camera.far = R * 60;
    camera.updateProjectionMatrix();
    controls.minDistance = R * 0.5;
    controls.maxDistance = R * 7;
    key.position.set(R * 4, R * 8, R * 12);
    controls.target.copy(center);
    camera.position.copy(VIEW_DIR).multiplyScalar(homeDistance()).add(center);

    current = reduced ? START : 0;
    target = START;
    placeParts();
    model = root;
    scene.add(root);
    onExploded(target);
    kick();
    return { parts: parts.map((p) => ({ code: p.code, label: p.label })), explodeSource: auto.length ? (auto.length === parts.length ? "auto" : "mixed") : "file" };
  }

  // ── what the page can do ──
  function select(code) {
    const p = parts.find((x) => x.code === code) || null;
    const was = focus;
    focus = p;
    paint(was);
    paint(focus);
    if (focus) {
      target = 1;
      onExploded(target);
    }
    framing = true;
    kick();
  }
  function setExploded(t) {
    t = MathUtils.clamp(Number(t) || 0, 0, 1);
    if (focus) {
      const was = focus;
      focus = null;
      paint(was);
      framing = true;
      onSelect("");
    }
    target = t;
    kick();
  }
  function reset() {
    const was = focus;
    focus = null;
    paint(was);
    if (was) onSelect("");
    target = START;
    onExploded(target);
    framing = true;
    kick();
  }
  function setPartOptions(map) {
    Object.keys(map || {}).forEach((code) => {
      const f = map[code] && map[code].face;
      if (f === "front" || f === "back") faces[code] = f;
      else delete faces[code];
    });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    if (ro) ro.disconnect();
    else window.removeEventListener("resize", resize);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    controls.removeEventListener("start", stopFraming);
    controls.removeEventListener("change", kick);
    controls.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach((m) => {
        Object.keys(m).forEach((k) => {
          if (m[k] && m[k].isTexture) m[k].dispose();
        });
        m.dispose();
      });
    });
    env.dispose();
    renderer.dispose();
    canvas.remove();
    parts = [];
    model = null;
  }

  return {
    load,
    select,
    setExploded,
    reset,
    setPartOptions,
    resize,
    dispose,
    get selected() {
      return focus ? focus.code : "";
    },
    get exploded() {
      return target;
    },
    // draw calls / triangles of the last frame (checking a model's weight)
    get stats() {
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
  };
}
