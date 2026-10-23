import * as THREE from "three";
import { scene, manager, clock } from "./world";
import { cursorHoverObjects } from "../app";

export const animatedHoverObjects = [];

/* =====================================================================
   BREAKABLE TEXT SYSTEM
   - Vector text (simpleText, floatingLabel, createText3D, skills list)
     is built from one mesh per letter. When the ball rolls over a word
     the letters burst out, hang in the air, then fly back together.
   - Image text (createTextOnPlane, allSkillsSection) is cut into small
     tiles that shatter outward from the ball and fly back (GPU shader).
   ===================================================================== */

const BREAK_DURATION = 1.8; // seconds: burst (0.3) + hang (0.5) + return (1.0)
const RIPPLE_SPEED = 0.05; // seconds of delay per unit of distance (image text)
const TILE_SIZE = 0.9; // size of image-text tiles in world units

export const breakableTexts = []; // letter-based words
const breakablePlanes = []; // tile-based image text

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// 0 = assembled, 1 = fully scattered
function breakAmount(t) {
  if (t < 0.3) return easeOutCubic(t / 0.3);
  if (t < 0.8) return 1;
  return 1 - easeInOutCubic(Math.min((t - 0.8) / 1.0, 1));
}

// load the font once and share it
let fontPromise = null;
function withFont(callback) {
  if (!fontPromise) {
    fontPromise = new Promise((resolve, reject) => {
      new THREE.FontLoader().load(
        "../src/jsm/Roboto_Regular.json",
        resolve,
        undefined,
        reject
      );
    });
  }
  fontPromise.then(callback);
}

/* ---------------------------------------------------------------------
   Builds a word out of separate letter meshes.
   o = {
     x, y, z      position of the word
     size         font size
     flat         true = lies on the ground, false = stands upright
     center       true = centre the word on x
     color        base colour (hex)
     flash        colour the letters turn while scattered (hex)
     extrude      null for flat shapes, or TextGeometry options for 3D letters
     hitUrl       if set, an invisible clickable plane is added (links)
     bob          if true the word floats up and down
   }
--------------------------------------------------------------------- */
function buildBreakableText(font, message, o) {
  const size = o.size;
  const flat = o.flat !== false;
  const center = o.center !== false;
  const extrude = o.extrude || null;
  const baseColor = new THREE.Color(o.color !== undefined ? o.color : 0xffffff);
  const flashColor = new THREE.Color(o.flash !== undefined ? o.flash : 0xff6b35);

  const data = font.data;
  const scale = data && data.resolution ? size / data.resolution : null;
  const lineHeight = scale
    ? (data.boundingBox.yMax - data.boundingBox.yMin + data.underlineThickness) * scale
    : size * 1.4;
  const advanceOf = (ch) => {
    if (scale) {
      const g = data.glyphs[ch] || data.glyphs["?"];
      if (g) return g.ha * scale;
    }
    return size * 0.6;
  };

  const group = new THREE.Group();
  group.position.set(o.x, o.y, o.z);
  if (flat) group.rotation.x = -Math.PI * 0.5; // lie flat like the other ground text

  const mats = extrude
    ? [
        new THREE.MeshBasicMaterial({ color: baseColor }), // front
        new THREE.MeshPhongMaterial({ color: baseColor }), // side
      ]
    : [
        new THREE.MeshBasicMaterial({
          color: baseColor,
          transparent: true,
          opacity: 1,
          side: THREE.DoubleSide,
        }),
      ];

  const letters = [];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  message.split("\n").forEach((line, lineIndex) => {
    let offsetX = 0;
    const offsetY = -lineIndex * lineHeight;

    Array.from(line).forEach((ch) => {
      const advance = advanceOf(ch);

      if (ch.trim() !== "") {
        let geo = null;
        if (extrude) {
          geo = new THREE.TextBufferGeometry(
            ch,
            Object.assign({ font: font, size: size }, extrude)
          );
        } else {
          const shapes = font.generateShapes(ch, size);
          if (shapes.length) geo = new THREE.ShapeBufferGeometry(shapes);
        }

        if (geo) {
          geo.computeBoundingBox();
          const bb = geo.boundingBox;
          if (isFinite(bb.min.x)) {
            const cx = (bb.min.x + bb.max.x) / 2;
            const cy = (bb.min.y + bb.max.y) / 2;
            const cz = (bb.min.z + bb.max.z) / 2;
            geo.translate(-cx, -cy, -cz); // pivot in the letter centre

            const mesh = new THREE.Mesh(geo, extrude ? mats : mats[0]);
            mesh.renderOrder = 2;
            if (extrude) {
              mesh.castShadow = true;
              mesh.receiveShadow = true;
            }
            group.add(mesh);

            const home = new THREE.Vector3(offsetX + cx, offsetY + cy, cz);

            // scatter direction: flat text flies UP (local z) and sideways,
            // upright text flies up and toward the camera
            const dir = flat
              ? new THREE.Vector3(
                  (Math.random() - 0.5) * 7,
                  (Math.random() - 0.5) * 5,
                  3 + Math.random() * 4
                )
              : new THREE.Vector3(
                  (Math.random() - 0.5) * 7,
                  1 + Math.random() * 4,
                  1 + Math.random() * 5
                );

            letters.push({
              mesh,
              home,
              dir,
              spin: new THREE.Vector3(
                (Math.random() - 0.5) * Math.PI * 4,
                (Math.random() - 0.5) * Math.PI * 4,
                (Math.random() - 0.5) * Math.PI * 4
              ),
              wobble: Math.random() * Math.PI * 2,
            });

            minX = Math.min(minX, offsetX + bb.min.x);
            maxX = Math.max(maxX, offsetX + bb.max.x);
            minY = Math.min(minY, offsetY + bb.min.y);
            maxY = Math.max(maxY, offsetY + bb.max.y);
          }
        }
      }
      offsetX += advance;
    });
  });

  if (!letters.length) return null;

  // centre the whole block on x (same maths the old simpleText used)
  const shift = center ? -0.5 * (maxX - minX) : 0;
  letters.forEach((l) => {
    l.home.x += shift;
    l.mesh.position.copy(l.home);
  });

  scene.add(group);

  const inkCenterX = shift + (minX + maxX) / 2;
  const inkCenterY = (minY + maxY) / 2;
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;

  // area (on the ground) where the ball triggers the break
  const item = {
    group,
    mats,
    letters,
    baseColor,
    flashColor,
    centerX: o.x + inkCenterX,
    centerZ: flat ? o.z - inkCenterY : o.z,
    halfW: halfW + 1.5,
    halfD: flat ? halfH + 2.5 : 3.5,
    state: "idle",
    startTime: 0,
    armed: true,
  };
  breakableTexts.push(item);

  // clickable link area for floating labels
  if (o.hitUrl) {
    const hit = new THREE.Mesh(
      new THREE.PlaneBufferGeometry(halfW * 2 + 1, halfH * 2 + 2),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hit.position.set(o.x + inkCenterX, o.y + inkCenterY, o.z);
    hit.userData = { URL: o.hitUrl };
    scene.add(hit);
    cursorHoverObjects.push(hit);
  }

  if (o.bob) {
    animatedHoverObjects.push({
      mesh: group,
      originalY: o.y,
      amplitude: 0.25 + Math.random() * 0.25,
      speed: 1 + Math.random() * 1,
      phase: Math.random() * Math.PI * 2,
    });
  }

  return item;
}

/* ---------------------------------------------------------------------
   Image text -> tiles that shatter (one draw call, animated on the GPU)
--------------------------------------------------------------------- */
function createShatterPlane(o) {
  const width = o.width;
  const height = o.height;
  const b = Object.assign({ x0: 0, x1: 1, y0: 0, y1: 1 }, o.bounds || {});
  const x0 = Math.max(0, b.x0 - 0.01);
  const x1 = Math.min(1, b.x1 + 0.01);
  const y0 = Math.max(0, b.y0 - 0.01);
  const y1 = Math.min(1, b.y1 + 0.01);

  const cols = Math.max(1, Math.round(((x1 - x0) * width) / TILE_SIZE));
  const rows = Math.max(1, Math.round(((y1 - y0) * height) / TILE_SIZE));

  const pos = [],
    uvs = [],
    nor = [],
    ctr = [],
    rnd = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fx0 = x0 + ((x1 - x0) * c) / cols;
      const fx1 = x0 + ((x1 - x0) * (c + 1)) / cols;
      const fy0 = y0 + ((y1 - y0) * r) / rows;
      const fy1 = y0 + ((y1 - y0) * (r + 1)) / rows;

      const lx0 = (fx0 - 0.5) * width;
      const lx1 = (fx1 - 0.5) * width;
      const ly0 = (0.5 - fy0) * height; // top
      const ly1 = (0.5 - fy1) * height; // bottom

      const TL = [lx0, ly0, fx0, 1 - fy0];
      const BL = [lx0, ly1, fx0, 1 - fy1];
      const BR = [lx1, ly1, fx1, 1 - fy1];
      const TR = [lx1, ly0, fx1, 1 - fy0];

      const cx = (lx0 + lx1) / 2;
      const cy = (ly0 + ly1) / 2;
      const r1 = Math.random(),
        r2 = Math.random(),
        r3 = Math.random();

      [TL, BL, TR, BL, BR, TR].forEach((v) => {
        pos.push(v[0], v[1], 0);
        uvs.push(v[2], v[3]);
        nor.push(0, 0, 1);
        ctr.push(cx, cy, 0);
        rnd.push(r1, r2, r3);
      });
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("aCenter", new THREE.Float32BufferAttribute(ctr, 3));
  geometry.setAttribute("aRand", new THREE.Float32BufferAttribute(rnd, 3));

  const uT = { value: 1e4 }; // seconds since the break started (huge = idle)
  const uBall = { value: new THREE.Vector2() }; // ball position in plane space

  const material = o.material;
  material.side = THREE.DoubleSide;
  material.onBeforeCompile = function (shader) {
    shader.uniforms.uT = uT;
    shader.uniforms.uBall = uBall;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec3 aCenter;
attribute vec3 aRand;
uniform float uT;
uniform vec2 uBall;
varying float vAmt;

float easeOut(float t) { return 1.0 - pow(1.0 - t, 3.0); }
float easeInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; }
float breakAmt(float t) {
  if (t <= 0.0) return 0.0;
  if (t < 0.3) return easeOut(t / 0.3);
  if (t < 0.8) return 1.0;
  if (t < 1.8) return 1.0 - easeInOut((t - 0.8) / 1.0);
  return 0.0;
}
mat3 rotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
mat3 rotZ(float a) { float c = cos(a); float s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }`
      )
      .replace(
        "#include <begin_vertex>",
        `float tileDist = length(aCenter.xy - uBall);
float amt = breakAmt(uT - tileDist * ${RIPPLE_SPEED.toFixed(3)});
vAmt = amt;
vec3 rel = position - aCenter;
vec3 transformed = aCenter + rotX(aRand.x * 6.2831 * amt) * rotZ(aRand.y * 6.2831 * amt) * rel;
transformed += vec3((aRand.x - 0.5) * 8.0, (aRand.y - 0.5) * 8.0, 3.0 + aRand.z * 8.0) * amt;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying float vAmt;\nvoid main() {")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.42, 0.21), vAmt * 0.8);`
      );
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(o.x, o.y, o.z);
  mesh.rotation.x = -Math.PI * 0.5;
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  mesh.userData = { URL: o.url || null };
  scene.add(mesh);

  if (o.url) cursorHoverObjects.push(mesh);
  if (o.bob) {
    animatedHoverObjects.push({
      mesh: mesh,
      originalY: o.y,
      amplitude: 0.2,
      speed: 1.5,
      phase: 0,
      bobOnly: true,
    });
  }

  // area where the ball triggers the shatter
  const lxMin = (x0 - 0.5) * width;
  const lxMax = (x1 - 0.5) * width;
  const lyTop = (0.5 - y0) * height;
  const lyBottom = (0.5 - y1) * height;
  const pad = 1.5;

  breakablePlanes.push({
    px: o.x,
    pz: o.z,
    uT,
    uBall,
    xMin: o.x + lxMin - pad,
    xMax: o.x + lxMax + pad,
    zMin: o.z - lyTop - pad,
    zMax: o.z - lyBottom + pad,
    endTime:
      BREAK_DURATION +
      RIPPLE_SPEED * Math.hypot(lxMax - lxMin, lyTop - lyBottom),
    state: "idle",
    startTime: 0,
    armed: true,
  });
}

/* ---------------------------------------------------------------------
   Call every frame from app.js: updateBreakableTexts(ball.position, time)
--------------------------------------------------------------------- */
export function updateBreakableTexts(ballPos, time) {
  // ---- letter based words ----
  breakableTexts.forEach((item) => {
    const near =
      Math.abs(ballPos.x - item.centerX) < item.halfW &&
      Math.abs(ballPos.z - item.centerZ) < item.halfD;

    if (item.state === "idle") {
      if (near && item.armed) {
        item.state = "breaking";
        item.startTime = time;
        item.armed = false; // ball must leave before it can break again
      } else if (!near) {
        item.armed = true;
      }
    }

    if (item.state !== "breaking") return;

    const t = time - item.startTime;

    if (t >= BREAK_DURATION) {
      item.letters.forEach((l) => {
        l.mesh.position.copy(l.home);
        l.mesh.rotation.set(0, 0, 0);
      });
      item.mats.forEach((m) => m.color.copy(item.baseColor));
      item.state = "idle";
      return;
    }

    const amount = breakAmount(t);
    item.letters.forEach((l) => {
      l.mesh.position.set(
        l.home.x + l.dir.x * amount,
        l.home.y + l.dir.y * amount,
        l.home.z + l.dir.z * amount + Math.sin(time * 6 + l.wobble) * 0.3 * amount
      );
      l.mesh.rotation.set(
        l.spin.x * amount,
        l.spin.y * amount,
        l.spin.z * amount
      );
    });
    item.mats.forEach((m) =>
      m.color.copy(item.baseColor).lerp(item.flashColor, amount)
    );
  });

  // ---- image text (tiles) ----
  breakablePlanes.forEach((item) => {
    const near =
      ballPos.x > item.xMin &&
      ballPos.x < item.xMax &&
      ballPos.z > item.zMin &&
      ballPos.z < item.zMax;

    if (item.state === "idle") {
      if (near && item.armed) {
        item.state = "breaking";
        item.startTime = time;
        item.armed = false;
        // ball position in the plane's own (x, y) space
        item.uBall.value.set(ballPos.x - item.px, -(ballPos.z - item.pz));
      } else if (!near) {
        item.armed = true;
      }
    }

    if (item.state === "breaking") {
      const t = time - item.startTime;
      if (t >= item.endTime) {
        item.uT.value = 1e4;
        item.state = "idle";
      } else {
        item.uT.value = t;
      }
    }
  });
}

/* =====================================================================
   PUBLIC TEXT FUNCTIONS (same names / arguments used by app.js)
   ===================================================================== */

// flat white text on the ground (PROJECTS, SKILLS, TIMELINE, instructions)
export function simpleText(x, y, z, inputText, fontSize) {
  withFont(function (font) {
    buildBreakableText(font, inputText, {
      x: x,
      y: y,
      z: z,
      size: fontSize,
      flat: true,
      center: true,
      color: 0xffffff,
      flash: 0xff6b35,
    });
  });
}

// floating, clickable labels above the link boxes
export function floatingLabel(x, y, z, inputMessage, urlLink = null) {
  withFont(function (font) {
    buildBreakableText(font, inputMessage, {
      x: x,
      y: y,
      z: z,
      size: 1,
      flat: false,
      center: true,
      color: 0xffffff,
      flash: 0xff6b35,
      hitUrl: urlLink,
      bob: true,
    });
  });
}

// 3D extruded upright text ("Sohaib Syed", "SOFTWARE ENGINEER")
export function createText3D(message, x, y, z, size, color, flash, extrude) {
  withFont(function (font) {
    buildBreakableText(font, message, {
      x: x,
      y: y,
      z: z,
      size: size,
      flat: false,
      center: false,
      color: color,
      flash: flash,
      extrude: extrude,
    });
  });
}

// skill names (flat, one per icon)
export function createSkillsList(x, startY, z, skills) {
  const loader = new THREE.TextureLoader(manager);

  withFont(function (font) {
    const skillsPerRow = 4;
    const rowSpacing = 11; // distance between rows on z axis
    const colSpacing = 11; // distance between columns on x axis

    skills.forEach((skill, index) => {
      const row = Math.floor(index / skillsPerRow);
      const col = index % skillsPerRow;
      const skillX = x + col * colSpacing;
      const skillZ = z + row * rowSpacing;

      // --- icon (static, flat on ground) ---
      const iconSize = 3;
      const iconMat = new THREE.MeshBasicMaterial({
        map: loader.load(skill.icon),
        transparent: true,
      });
      const iconMesh = new THREE.Mesh(
        new THREE.PlaneBufferGeometry(iconSize, iconSize),
        iconMat
      );
      iconMesh.position.set(skillX, startY + 0.05, skillZ);
      iconMesh.rotation.x = -Math.PI * 0.5;
      iconMesh.renderOrder = 2;
      scene.add(iconMesh);

      // --- name, just in front of the icon ---
      buildBreakableText(font, skill.name, {
        x: skillX,
        y: startY + 0.02,
        z: skillZ + 2.7,
        size: 1.1,
        flat: true,
        center: true,
        color: 0xffffff,
        flash: 0xff6b35,
      });
    });
  });
}

// timeline picture (image text that bobs and opens a link) -> shatters
export function allSkillsSection(
  x,
  y,
  z,
  xScale,
  zScale,
  boxTexture,
  URLLink = null,
  bounds = null
) {
  const loader = new THREE.TextureLoader(manager);
  const texture = loader.load(boxTexture);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.encoding = THREE.sRGBEncoding;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
  });
  material.depthWrite = true;
  material.depthTest = true;

  createShatterPlane({
    x: x,
    y: y,
    z: z,
    width: xScale,
    height: zScale,
    material: material,
    bounds: bounds,
    url: URLLink,
    bob: true,
  });
}

// project description text pictures -> shatter
export function createTextOnPlane(
  x,
  y,
  z,
  inputText,
  size1,
  size2,
  bounds = null
) {
  const loader = new THREE.TextureLoader(manager);
  const activitiesTexture = loader.load(inputText);
  activitiesTexture.magFilter = THREE.NearestFilter;
  activitiesTexture.minFilter = THREE.LinearFilter;
  const material = new THREE.MeshBasicMaterial({
    alphaMap: activitiesTexture,
    transparent: true,
  });
  material.depthWrite = true;
  material.depthTest = true;

  createShatterPlane({
    x: x,
    y: y,
    z: z,
    width: size1,
    height: size2,
    material: material,
    bounds: bounds,
  });
}