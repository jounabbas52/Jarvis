// Human head mesh for the HUD avatar. Port of Mark LIV's core/avatar_mesh.py.
//
// The face is **real measured human geometry** — MediaPipe's canonical face
// model (./faceModel.ts, Apache-2.0, 468 vertices / 898 triangles), which
// carries actual eyelids, nostrils, lips and cheekbones. Everything a formula
// cannot give you comes from there.
//
// What is still generated here, around that face:
//   * the cranium — the model is an open mask, so its 36-vertex border is swept
//     back and up over a skull-shaped ellipsoid and closed at the occiput;
//   * a tapering neck stub that fades out instead of needing shoulders;
//   * vertex normals, jaw-rig weights, a thinned wireframe, and the landmark
//     index rings (eyes, brows, lips) the renderer animates.
//
// Coordinate system after normalisation (head-local, right-handed):
//     +x → viewer's right      +y → up      +z → out of the face
//     y = +1.0 crown,  y = -1.0 chin,  eyes land on y ≈ 0.

import { FACE_TRIS, FACE_VERTS } from './faceModel';

type V3 = [number, number, number];

// Cranium shape, in the model's own units (chin ≈ -9.4, forehead ≈ +8.3).
// Tuned so that brow→crown is ~0.36 of the head's height, which is the real
// proportion; a taller cranium immediately reads as a long face.
const SKULL_C: V3 = [0.0, 2.0, -1.0]; // centre of the cranial ellipsoid
const SKULL_R: V3 = [8.4, 12.4, 8.2]; // its radii
const SKULL_POLE: V3 = [0.0, 0.42, -1.0]; // direction of the occiput, where the sweep closes
const SKULL_RINGS = 6;
const SKULL_BLEND = 1.7; // how fast the sweep leaves the face border
const SKULL_BULGE = 1.04;

const NECK_RINGS = 9;
const NECK_SEGS = 14;
const NECK_Z = -1.6; // the neck tube's axis, in model units
const WIRE_STRIDE = 3; // keep every n-th edge; the surface carries the form

// MediaPipe landmark rings. Verified against the geometry at build time — see
// `checkLandmarks` — so a wrong index can never silently animate the cheek.
export const LANDMARKS = {
  eye_l: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eye_r: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  brow_l: [70, 63, 105, 66, 107],
  brow_r: [300, 293, 334, 296, 336],
  lips_out: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  lips_in: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
} as const;
export type LandmarkKey = keyof typeof LANDMARKS;

// Jaw rig, in normalised units. The pivot sits between the ears, which is where
// a real mandible hinges.
export const JAW_PIVOT: V3 = [0.0, 0.06, -0.34];
// Radians of drop at full amplitude (~6.6°). Speech barely moves a real jaw,
// and a talking head is watched at HUD size where a small, precise mouth reads
// better than a large one; the lip rig carries most of the articulation.
export const JAW_MAX = 0.115;

export interface HeadMesh {
  /** xyz per vertex, normalised. */
  verts: Float32Array;
  normals: Float32Array;
  /** Three vertex indices per triangle. */
  faces: Int32Array;
  /** Two vertex indices per wire edge (every WIRE_STRIDE-th unique edge). */
  edges: Int32Array;
  /** 1 = head facet, 0 = neck facet (neck draws first). */
  faceGroup: Float32Array;
  jaw: Float32Array;
  brow: Float32Array;
  lips: Float32Array;
  lipCentre: V3;
  fade: Float32Array;
  landmarks: Record<LandmarkKey, readonly number[]>;
  nFace: number;
  nHead: number;
  /** Crown, bottom of the neck. */
  span: [number, number];
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Ordered ring of vertices along the open border of a triangle mesh. */
function boundaryLoop(faces: number[][]): number[] {
  // Insertion-ordered like Python's Counter/defaultdict, so the loop starts on
  // the same vertex as Mark's and the generated indices line up with it.
  const seen = new Map<string, [number, number, number]>();
  for (const [a, b, c] of faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const lo = Math.min(p, q);
      const hi = Math.max(p, q);
      const k = `${lo},${hi}`;
      const e = seen.get(k);
      if (e) e[2]++;
      else seen.set(k, [lo, hi, 1]);
    }
  }
  const border = Array.from(seen.values()).filter((e) => e[2] === 1);
  const adj = new Map<number, number[]>();
  const push = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of border) {
    push(a, b);
    push(b, a);
  }
  const start = border[0][0];
  const loop = [start];
  let prev: number | null = null;
  let cur = start;
  for (;;) {
    const nxt = (adj.get(cur) ?? []).filter((v) => v !== prev);
    if (!nxt.length || nxt[0] === start) break;
    prev = cur;
    cur = nxt[0];
    loop.push(cur);
  }
  return loop;
}

function norm3(v: V3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function slerp(a: V3, b: V3, t: number): V3 {
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const om = Math.acos(dot);
  const so = Math.sin(om);
  let out: V3;
  if (so < 1e-6) {
    out = [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
  } else {
    const ka = Math.sin((1 - t) * om) / so;
    const kb = Math.sin(t * om) / so;
    out = [ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2]];
  }
  const n = Math.max(norm3(out), 1e-9);
  return [out[0] / n, out[1] / n, out[2] / n];
}

function ellR(d: V3): number {
  return 1 / Math.sqrt((d[0] / SKULL_R[0]) ** 2 + (d[1] / SKULL_R[1]) ** 2 + (d[2] / SKULL_R[2]) ** 2);
}

/** Sweep the mask's open border back over a skull and close it at the occiput. */
function addCranium(verts: V3[], faces: number[][]): void {
  let loop = boundaryLoop(faces);

  // Orient the loop so the generated triangles wind the same way as the face's.
  let cx = 0;
  let cy = 0;
  for (const i of loop) {
    cx += verts[i][0];
    cy += verts[i][1];
  }
  cx /= loop.length;
  cy /= loop.length;
  const ang = loop.map((i) => Math.atan2(verts[i][1] - cy, verts[i][0] - cx));
  let turn = 0; // sum of np.diff(np.unwrap(ang))
  for (let i = 1; i < ang.length; i++) {
    let d = ang[i] - ang[i - 1];
    const dd = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(d) >= Math.PI) d = dd === -Math.PI && d > 0 ? Math.PI : dd;
    turn += d;
  }
  if (turn < 0) loop = loop.slice().reverse();

  const n = loop.length;
  const C = SKULL_C;
  const pl = norm3(SKULL_POLE);
  const pole: V3 = [SKULL_POLE[0] / pl, SKULL_POLE[1] / pl, SKULL_POLE[2] / pl];
  let chinY = Infinity;
  for (const v of verts) chinY = Math.min(chinY, v[1]);

  const rimR: number[] = [];
  const rimD: V3[] = [];
  for (const i of loop) {
    const r: V3 = [verts[i][0] - C[0], verts[i][1] - C[1], verts[i][2] - C[2]];
    const l = norm3(r);
    rimR.push(l);
    rimD.push([r[0] / l, r[1] / l, r[2] / l]);
  }

  let prevIdx = loop;
  for (let s = 1; s <= SKULL_RINGS; s++) {
    const t = s / SKULL_RINGS;
    const w = (1 - t) ** SKULL_BLEND; // meets the rim exactly at t = 0
    const base = verts.length;
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      let p: V3;
      if (s === SKULL_RINGS) {
        const r = ellR(pole);
        p = [C[0] + pole[0] * r, C[1] + pole[1] * r, C[2] + pole[2] * r];
      } else {
        const d = slerp(pole, rimD[i], 1 - t);
        // A skull is fuller than the border it springs from; peak it mid-sweep.
        const r = ellR(d) * (1 + (SKULL_BULGE - 1) * Math.sin(Math.PI * t) ** 0.8);
        const rad = w * rimR[i] + (1 - w) * r;
        p = [C[0] + d[0] * rad, C[1] + d[1] * rad, C[2] + d[2] * rad];
        // Never dip below the chin: the sweep passing under the jaw would hang a
        // lip of geometry below the face. Clamped vertices are also drawn in
        // towards the neck axis, so the underside closes as a small floor.
        if (p[1] < chinY) {
          p[1] = chinY;
          p[0] *= 0.55;
          p[2] = NECK_Z + (p[2] - NECK_Z) * 0.55;
        }
      }
      verts.push(p);
      idx.push(base + i);
    }
    for (let i = 0; i < n; i++) {
      const a0 = prevIdx[i];
      const b0 = prevIdx[(i + 1) % n];
      const a1 = idx[i];
      const b1 = idx[(i + 1) % n];
      faces.push([a0, a1, b1]);
      faces.push([a0, b1, b0]);
    }
    prevIdx = idx;
  }
}

/** A tapering tube dropped from inside the jaw; it fades out, so no shoulders. */
function addNeck(verts: V3[], faces: number[][]): number[] {
  // Short, and flaring hard at the bottom: a straight vertical tube reads as a
  // pedestal, whereas a neck that widens into the top of the shoulders reads as
  // a bust.
  const base = verts.length;
  const ds: number[] = [];
  for (let i = 0; i < NECK_RINGS; i++) {
    const y = -5.5 + ((-13.0 + 5.5) * i) / (NECK_RINGS - 1);
    const d = (y + 5.5) / -7.5;
    ds.push(d);
    const rx = 4.6 * (1 + 0.52 * d ** 1.9);
    const rz = 4.1 * (1 + 0.38 * d ** 1.9);
    for (let j = 0; j < NECK_SEGS; j++) {
      const ph = (2 * Math.PI * j) / NECK_SEGS;
      verts.push([rx * Math.cos(ph), y, NECK_Z + rz * Math.sin(ph)]);
    }
  }
  const at = (i: number, j: number) => base + i * NECK_SEGS + j;
  for (let i = 0; i < NECK_RINGS - 1; i++) {
    for (let j = 0; j < NECK_SEGS; j++) {
      const a = at(i, j);
      const b = at(i, (j + 1) % NECK_SEGS);
      const c = at(i + 1, (j + 1) % NECK_SEGS);
      const e = at(i + 1, j);
      faces.push([a, b, c]);
      faces.push([a, c, e]);
    }
  }
  // Enough rings that the fade steps stay small: each quad splits into one
  // triangle with two top vertices and one with two bottom vertices, so a steep
  // per-vertex fade gradient grows a sawtooth edge.
  const fade = new Array<number>(base).fill(1);
  for (let i = 0; i < NECK_RINGS; i++) {
    const f = 1 - 0.72 * clamp(ds[i], 0, 1) ** 1.5;
    for (let j = 0; j < NECK_SEGS; j++) fade.push(f);
  }
  return fade;
}

/** Fail loudly at build time if a landmark ring is not where it should be. */
function checkLandmarks(verts: V3[]): void {
  const mean = (ids: readonly number[]): V3 => {
    const m: V3 = [0, 0, 0];
    for (const i of ids) for (let k = 0; k < 3; k++) m[k] += verts[i][k];
    return [m[0] / ids.length, m[1] / ids.length, m[2] / ids.length];
  };
  const pairs: Array<[LandmarkKey, LandmarkKey]> = [
    ['eye_l', 'eye_r'],
    ['brow_l', 'brow_r'],
  ];
  for (const [l, r] of pairs) {
    const cl = mean(LANDMARKS[l]);
    const cr = mean(LANDMARKS[r]);
    if (!(cl[0] < 0 && 0 < cr[0])) throw new Error(`${l}/${r} are not on opposite sides`);
    if (!(Math.abs(cl[1] - cr[1]) < 0.5)) throw new Error(`${l}/${r} are at different heights`);
  }
  const eyeY = mean(LANDMARKS.eye_l)[1];
  const browY = mean(LANDMARKS.brow_l)[1];
  const lips = mean(LANDMARKS.lips_out);
  if (!(browY > eyeY)) throw new Error('brow is not above the eye');
  if (!(lips[1] < eyeY)) throw new Error('lips are not below the eyes');
  if (!(Math.abs(lips[0]) < 0.5)) throw new Error('lips are not centred');
}

/** Assemble the full head. Called once; `getHeadMesh()` caches the result. */
export function buildHead(): HeadMesh {
  const verts: V3[] = [];
  for (let i = 0; i < FACE_VERTS.length; i += 3) verts.push([FACE_VERTS[i], FACE_VERTS[i + 1], FACE_VERTS[i + 2]]);
  const faces: number[][] = [];
  for (let i = 0; i < FACE_TRIS.length; i += 3) faces.push([FACE_TRIS[i], FACE_TRIS[i + 1], FACE_TRIS[i + 2]]);
  checkLandmarks(verts);

  const nFace = verts.length;
  addCranium(verts, faces);
  const nHead = verts.length;
  const fade = addNeck(verts, faces);
  const N = verts.length;

  // ── normalise: crown → +1, chin → -1, eyes land on y ≈ 0 ─────────────────
  let crown = -Infinity;
  let chin = Infinity;
  for (let i = 0; i < nHead; i++) {
    crown = Math.max(crown, verts[i][1]);
    chin = Math.min(chin, verts[i][1]);
  }
  const scale = 2 / (crown - chin);
  const cY = (crown + chin) * 0.5;
  const V = new Float32Array(N * 3);
  const Vd = new Float64Array(N * 3); // full precision for the derived weights
  for (let i = 0; i < N; i++) {
    Vd[i * 3] = verts[i][0] * scale;
    Vd[i * 3 + 1] = (verts[i][1] - cY) * scale;
    Vd[i * 3 + 2] = verts[i][2] * scale;
  }
  V.set(Vd);
  const X = (i: number) => Vd[i * 3];
  const Y = (i: number) => Vd[i * 3 + 1];
  const Z = (i: number) => Vd[i * 3 + 2];

  // Outward reference, per part: the head is star-shaped about its own centre,
  // while the neck is a tube whose outward direction is radial in x/z only.
  // A single "away from the centroid" rule flips at random down the neck.
  let headMeanY = 0;
  for (let i = 0; i < nHead; i++) headMeanY += Y(i);
  headMeanY /= nHead;
  const nrm = new Float64Array(N * 3);
  for (const [a, b, c] of faces) {
    const ux = X(b) - X(a), uy = Y(b) - Y(a), uz = Z(b) - Z(a);
    const vx = X(c) - X(a), vy = Y(c) - Y(a), vz = Z(c) - Z(a);
    // Unnormalised cross product: its length carries the area — the weighting.
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      nrm[k * 3] += fx;
      nrm[k * 3 + 1] += fy;
      nrm[k * 3 + 2] += fz;
    }
  }
  const normals = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    const l = Math.max(Math.hypot(nx, ny, nz), 1e-9);
    nx /= l;
    ny /= l;
    nz /= l;
    let ox: number, oy: number, oz: number;
    if (i < nHead) {
      ox = X(i);
      oy = Y(i) - headMeanY;
      oz = Z(i);
    } else {
      ox = X(i);
      oy = 0;
      oz = Z(i) - NECK_Z * scale;
    }
    const s = nx * ox + ny * oy + nz * oz < 0 ? -1 : 1;
    normals[i * 3] = nx * s;
    normals[i * 3 + 1] = ny * s;
    normals[i * 3 + 2] = nz * s;
  }

  const meanOf = (ids: readonly number[]): V3 => {
    const m: V3 = [0, 0, 0];
    for (const i of ids) {
      m[0] += X(i);
      m[1] += Y(i);
      m[2] += Z(i);
    }
    return [m[0] / ids.length, m[1] / ids.length, m[2] / ids.length];
  };

  // ── jaw rig ───────────────────────────────────────────────────────────────
  // Everything below the mouth swings on the mandible, tapering to nothing at
  // the ears and around the back so the nape and the neck stay put.
  const mouthY = meanOf(LANDMARKS.lips_out)[1];
  let chinY = Infinity;
  for (let i = 0; i < nHead; i++) chinY = Math.min(chinY, Y(i));
  const jaw = new Float32Array(N);
  for (let i = 0; i < nHead; i++) {
    const j = clamp((mouthY - Y(i)) / (mouthY - chinY), 0, 1) ** 0.8;
    jaw[i] = j * clamp(0.3 + 0.85 * (Z(i) / 0.55), 0, 1);
  }
  // (the neck never moves: jaw stays 0 past nHead)
  LANDMARKS.lips_in.slice(0, 10).forEach((i) => (jaw[i] = 1.0)); // lower inner lip leads
  LANDMARKS.lips_out.slice(0, 10).forEach((i) => (jaw[i] = 0.95));

  // ── brow rig ──────────────────────────────────────────────────────────────
  // Raising the brows displaces the actual surface rather than sliding a drawn
  // line over it, so the brow ridge relights as it lifts.
  const browY = meanOf([...LANDMARKS.brow_l, ...LANDMARKS.brow_r])[1];
  const brow = new Float32Array(N);
  for (let i = 0; i < nHead; i++) {
    brow[i] =
      Math.exp(-(((Y(i) - browY) / 0.115) ** 2)) *
      clamp(Z(i) / 0.35, 0, 1) * // front of the face only
      Math.exp(-((X(i) / 0.42) ** 2)); // fades out past the temples
  }

  // ── lip rig ───────────────────────────────────────────────────────────────
  // Vowels are not just "how far open" — /i/ spreads the lips wide, /u/ purses
  // them forward. This weight lets the renderer widen or round the mouth region
  // as a whole, so the surrounding skin follows instead of tearing away.
  const lipC = meanOf(LANDMARKS.lips_out);
  const lips = new Float32Array(N);
  for (let i = 0; i < nHead; i++) {
    lips[i] =
      Math.exp(-(((Y(i) - lipC[1]) / 0.155) ** 2)) *
      Math.exp(-((X(i) / 0.3) ** 2)) *
      clamp(Z(i) / 0.4, 0, 1);
  }

  // Unique edges sorted lexicographically (np.unique), every WIRE_STRIDE-th kept.
  const edgeSet = new Set<number>();
  for (const [a, b, c] of faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edgeSet.add(Math.min(p, q) * 65536 + Math.max(p, q));
  }
  const allEdges = Array.from(edgeSet).sort((m, n) => m - n);
  const kept: number[] = [];
  for (let i = 0; i < allEdges.length; i += WIRE_STRIDE) kept.push(allEdges[i]);
  const edges = new Int32Array(kept.length * 2);
  kept.forEach((e, i) => {
    edges[i * 2] = Math.floor(e / 65536);
    edges[i * 2 + 1] = e % 65536;
  });

  // Neck and head interpenetrate, and a painter's sort by triangle depth
  // interleaves them into a torn edge. Grouping fixes it: the neck is always
  // behind the head where they overlap, so draw every neck facet first.
  const F = new Int32Array(faces.length * 3);
  const faceGroup = new Float32Array(faces.length);
  faces.forEach(([a, b, c], i) => {
    F[i * 3] = a;
    F[i * 3 + 1] = b;
    F[i * 3 + 2] = c;
    faceGroup[i] = a >= nHead && b >= nHead && c >= nHead ? 0 : 1;
  });

  let bottom = Infinity;
  for (let i = 0; i < N; i++) bottom = Math.min(bottom, Y(i));

  return {
    verts: V,
    normals,
    faces: F,
    edges,
    faceGroup,
    jaw,
    brow,
    lips,
    lipCentre: lipC,
    fade: Float32Array.from(fade),
    landmarks: LANDMARKS,
    nFace,
    nHead,
    span: [1.0, bottom],
  };
}

let cache: HeadMesh | null = null;

/** Process-wide cached mesh — every canvas shares the same arrays. */
export function getHeadMesh(): HeadMesh {
  if (!cache) cache = buildHead();
  return cache;
}
