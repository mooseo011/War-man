'use strict';
/*
 * FRONTLINES — fictional war simulator
 *
 * Core guarantee: every border on the map is ONE persistent object. It is
 * extracted once at world generation as a polyline of shared vertex objects.
 * Country territory polygons reference those same vertex objects, so when a
 * war pushes the border's vertices around, the territory deforms with it.
 * The border object is never rebuilt or replaced — it is still before the
 * war, fluctuates during the war, and freezes (wherever it ended up) after.
 */

/* ================= constants ================= */
const W = 1280, H = 800;          // world size in world units
const CELL = 16;                  // base grid cell size
const COLS = Math.round(W / CELL), ROWS = Math.round(H / CELL);
const VW = COLS + 1, VH = ROWS + 1;

const DT_DAYS = 0.05;             // sim-days per step
const STEPS_PER_SEC = 40;         // at 1x speed => 2 days/sec
const MAX_PUSH = 1.2;             // max border advance, px per day
const INF_SIGMA = 2.0 * CELL;     // influence falloff of a division
const DIV_STR = 100;              // strength of a fresh division
const MEN_PER_STR = 120;          // flavor: men per strength point
const MAX_SEG = 1.85 * CELL;      // border segment stretch limit
const MIN_SEG = 0.22 * CELL;
const CAPITULATE_AT = 0.45;       // side gives up below this area ratio
const ARMISTICE_DAY = 420;

const SIDE_NAMES = { red: 'Crimson Pact', blue: 'Azure League' };
const SIDE_COLORS = { red: '#e0443a', blue: '#3f74e8' };

const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';

/* ================= rng & noise ================= */
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function makeNoise(rng) {
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const lat = (ix, iy) => perm[(perm[ix & 255] + iy) & 255] / 255;
  const sm = t => t * t * (3 - 2 * t);
  function noise2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const a = lat(ix, iy), b = lat(ix + 1, iy), c = lat(ix, iy + 1), d = lat(ix + 1, iy + 1);
    const u = sm(fx), v = sm(fy);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct) {
    let s = 0, amp = 1, f = 1, norm = 0;
    for (let o = 0; o < (oct || 5); o++) { s += noise2(x * f, y * f) * amp; norm += amp; amp *= 0.5; f *= 2; }
    return s / norm;
  }
  return { noise2, fbm };
}

/* ================= names ================= */
const NAME_A = ['Vel', 'Kor', 'Ash', 'Bel', 'Dra', 'Ther', 'Mar', 'Os', 'Cal', 'Nor',
  'Vor', 'Eri', 'Zan', 'Hal', 'Quor', 'Ist', 'Pel', 'Gra', 'Tyr', 'Lus', 'Or', 'Sev'];
const NAME_B = ['do', 'ra', 've', 'mi', 'ka', 'lo', 'sa', 'ti', 'ru', 'ne', 'ga', 'ze', ''];
const NAME_C = ['ria', 'land', 'mark', 'via', 'stan', 'dor', 'heim', 'gard', 'onia',
  'ova', 'aria', 'ium', 'esse', 'ique', 'thia', 'wick'];
function makeName(rng, used) {
  for (let tries = 0; tries < 80; tries++) {
    const n = NAME_A[(rng() * NAME_A.length) | 0]
      + NAME_B[(rng() * NAME_B.length) | 0]
      + NAME_C[(rng() * NAME_C.length) | 0];
    if (!used.has(n)) { used.add(n); return n; }
  }
  return 'Terra' + ((rng() * 999) | 0);
}

/* ================= small geometry helpers ================= */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const vid = (vx, vy) => vy * VW + vx;

function loopsArea(loops, verts) {
  let s = 0;
  for (const lp of loops) {
    for (let i = 0; i < lp.length; i++) {
      const p = verts[lp[i]], q = verts[lp[(i + 1) % lp.length]];
      s += p.x * q.y - q.x * p.y;
    }
  }
  return Math.abs(s) / 2;
}

function pointInLoops(loops, verts, x, y) {
  let wn = 0;
  for (const lp of loops) {
    for (let i = 0; i < lp.length; i++) {
      const p = verts[lp[i]], q = verts[lp[(i + 1) % lp.length]];
      const cr = (q.x - p.x) * (y - p.y) - (x - p.x) * (q.y - p.y);
      if (p.y <= y) { if (q.y > y && cr > 0) wn++; }
      else { if (q.y <= y && cr < 0) wn--; }
    }
  }
  return wn !== 0;
}

/* ================= world generation ================= */
function generateWorld(seedStr) {
  const seed = hashStr(seedStr);
  const rng = mulberry32(seed);
  const noise = makeNoise(rng);

  /* --- vertices: jittered grid, shared by cells, countries and borders --- */
  const verts = new Array(VW * VH);
  for (let vy = 0; vy < VH; vy++) {
    for (let vx = 0; vx < VW; vx++) {
      let x = vx * CELL, y = vy * CELL;
      if (vx > 0 && vx < COLS && vy > 0 && vy < ROWS) {
        const jx = (noise.fbm(vx * 0.23 + 41.7, vy * 0.23 + 7.3, 4) - 0.5) * 1.5 + (rng() - 0.5) * 0.78;
        const jy = (noise.fbm(vx * 0.23 + 3.1, vy * 0.23 + 93.2, 4) - 0.5) * 1.5 + (rng() - 0.5) * 0.78;
        x += clamp(jx, -0.46, 0.46) * CELL;
        y += clamp(jy, -0.46, 0.46) * CELL;
      }
      verts[vid(vx, vy)] = { x, y, pinned: false };
    }
  }

  /* --- landmass from fbm noise --- */
  const owner = new Int16Array(COLS * ROWS).fill(-1);
  const land = new Uint8Array(COLS * ROWS);
  const elev = new Float32Array(COLS * ROWS);
  const ox = rng() * 90, oy = rng() * 90;
  const aspect = W / H;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const u = (i + 0.5) / COLS, v = (j + 0.5) / ROWS;
      let e = noise.fbm(ox + u * 5.2 * aspect / 1.6, oy + v * 5.2 / 1.6, 5);
      const edge = Math.min(u, 1 - u, v, 1 - v) * 2; // 0 at map edge
      e -= Math.max(0, 1 - edge / 0.30) * 0.34;
      elev[j * COLS + i] = e;
    }
  }
  const sorted = Array.from(elev).sort((a, b) => a - b);
  const seaLevel = sorted[Math.floor(sorted.length * 0.55)];
  for (let k = 0; k < COLS * ROWS; k++) land[k] = elev[k] > seaLevel ? 1 : 0;

  /* --- clean up: drop small islands, fill small lakes --- */
  const compOf = new Int32Array(COLS * ROWS).fill(-1);
  const comps = []; // {cells:[], landish, touchesEdge}
  const stack = [];
  for (let k = 0; k < COLS * ROWS; k++) {
    if (compOf[k] !== -1) continue;
    const isLand = land[k];
    const cells = [];
    let touchesEdge = false;
    compOf[k] = comps.length; stack.push(k);
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const ci = c % COLS, cj = (c / COLS) | 0;
      if (ci === 0 || cj === 0 || ci === COLS - 1 || cj === ROWS - 1) touchesEdge = true;
      const nbs = [c - 1, c + 1, c - COLS, c + COLS];
      const oks = [ci > 0, ci < COLS - 1, cj > 0, cj < ROWS - 1];
      for (let q = 0; q < 4; q++) {
        if (oks[q] && compOf[nbs[q]] === -1 && land[nbs[q]] === isLand) {
          compOf[nbs[q]] = comps.length; stack.push(nbs[q]);
        }
      }
    }
    comps.push({ cells, isLand, touchesEdge });
  }
  for (const cp of comps) {
    if (cp.isLand && cp.cells.length < 30) for (const c of cp.cells) land[c] = 0;       // sink islets
    if (!cp.isLand && !cp.touchesEdge && cp.cells.length < 26) for (const c of cp.cells) land[c] = 1; // fill ponds
  }

  /* --- grow countries over land (multi-source randomized dijkstra) --- */
  const landCells = [];
  for (let k = 0; k < COLS * ROWS; k++) if (land[k]) landCells.push(k);
  const nCountries = clamp(Math.round(landCells.length / 165), 6, 16);

  // farthest-point seeding
  const seeds = [landCells[(rng() * landCells.length) | 0]];
  const cdist = (a, b) => {
    const ax = a % COLS, ay = (a / COLS) | 0, bx = b % COLS, by = (b / COLS) | 0;
    return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
  };
  while (seeds.length < nCountries) {
    let best = -1, bestD = -1;
    for (let t = 0; t < 220; t++) {
      const cand = landCells[(rng() * landCells.length) | 0];
      let d = Infinity;
      for (const s of seeds) d = Math.min(d, cdist(cand, s));
      d *= 0.7 + rng() * 0.6;
      if (d > bestD) { bestD = d; best = cand; }
    }
    seeds.push(best);
  }

  const cellCost = new Float32Array(COLS * ROWS);
  for (let k = 0; k < COLS * ROWS; k++) cellCost[k] = 0.4 + rng() * 1.3;
  const dist = new Float32Array(COLS * ROWS).fill(Infinity);
  // tiny binary heap
  const hp = []; // [cost, cell, country]
  const hpush = (it) => {
    hp.push(it); let i = hp.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (hp[p][0] <= hp[i][0]) break; const t = hp[p]; hp[p] = hp[i]; hp[i] = t; i = p; }
  };
  const hpop = () => {
    const top = hp[0], last = hp.pop();
    if (hp.length) {
      hp[0] = last; let i = 0;
      for (;;) {
        let m = i; const l = 2 * i + 1, r = l + 1;
        if (l < hp.length && hp[l][0] < hp[m][0]) m = l;
        if (r < hp.length && hp[r][0] < hp[m][0]) m = r;
        if (m === i) break; const t = hp[m]; hp[m] = hp[i]; hp[i] = t; i = m;
      }
    }
    return top;
  };
  seeds.forEach((s, ci) => { dist[s] = 0; hpush([0, s, ci]); });
  while (hp.length) {
    const [d, c, co] = hpop();
    if (d > dist[c]) continue;
    if (owner[c] !== -1) continue;
    owner[c] = co;
    const ci = c % COLS, cj = (c / COLS) | 0;
    const nbs = [c - 1, c + 1, c - COLS, c + COLS];
    const oks = [ci > 0, ci < COLS - 1, cj > 0, cj < ROWS - 1];
    for (let q = 0; q < 4; q++) {
      if (oks[q] && land[nbs[q]] && owner[nbs[q]] === -1) {
        const nd = d + cellCost[nbs[q]];
        if (nd < dist[nbs[q]]) { dist[nbs[q]] = nd; hpush([nd, nbs[q], co]); }
      }
    }
  }
  // unreached land (separate islands without seed) -> own countries
  let nextId = nCountries;
  for (let k = 0; k < COLS * ROWS; k++) {
    if (land[k] && owner[k] === -1) {
      const id = nextId++;
      stack.push(k); owner[k] = id;
      while (stack.length) {
        const c = stack.pop();
        const ci = c % COLS, cj = (c / COLS) | 0;
        const nbs = [c - 1, c + 1, c - COLS, c + COLS];
        const oks = [ci > 0, ci < COLS - 1, cj > 0, cj < ROWS - 1];
        for (let q = 0; q < 4; q++) {
          if (oks[q] && land[nbs[q]] && owner[nbs[q]] === -1) { owner[nbs[q]] = id; stack.push(nbs[q]); }
        }
      }
    }
  }

  /* --- merge runt countries into their biggest land neighbor --- */
  for (let pass = 0; pass < 4; pass++) {
    const counts = new Map();
    for (let k = 0; k < COLS * ROWS; k++) if (owner[k] >= 0) counts.set(owner[k], (counts.get(owner[k]) || 0) + 1);
    let merged = false;
    for (const [id, n] of counts) {
      if (n >= 24) continue;
      const shared = new Map();
      for (let k = 0; k < COLS * ROWS; k++) {
        if (owner[k] !== id) continue;
        const ci = k % COLS, cj = (k / COLS) | 0;
        const nbs = [k - 1, k + 1, k - COLS, k + COLS];
        const oks = [ci > 0, ci < COLS - 1, cj > 0, cj < ROWS - 1];
        for (let q = 0; q < 4; q++) {
          if (oks[q] && owner[nbs[q]] >= 0 && owner[nbs[q]] !== id)
            shared.set(owner[nbs[q]], (shared.get(owner[nbs[q]]) || 0) + 1);
        }
      }
      let bestNb = -1, bestSh = 0;
      for (const [nb, sh] of shared) if (sh > bestSh) { bestSh = sh; bestNb = nb; }
      if (bestNb >= 0) {
        for (let k = 0; k < COLS * ROWS; k++) if (owner[k] === id) owner[k] = bestNb;
        merged = true;
      }
    }
    if (!merged) break;
  }

  /* --- relabel to compact ids --- */
  const remap = new Map();
  for (let k = 0; k < COLS * ROWS; k++) {
    if (owner[k] >= 0) {
      if (!remap.has(owner[k])) remap.set(owner[k], remap.size);
      owner[k] = remap.get(owner[k]);
    }
  }
  const nFinal = remap.size;

  /* --- boundary edges --- */
  // global undirected edge set: key -> {v1,v2,a,b} with a<b (ocean/void = -1)
  const edgeMap = new Map();
  const ekey = (a, b) => a < b ? a * VW * VH + b : b * VW * VH + a;
  const ownerAtCell = (i, j) => (i < 0 || j < 0 || i >= COLS || j >= ROWS) ? -1 : owner[j * COLS + i];
  const dirEdgesByCountry = Array.from({ length: nFinal }, () => []);

  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const o = owner[j * COLS + i];
      if (o < 0) continue;
      const v00 = vid(i, j), v10 = vid(i + 1, j), v11 = vid(i + 1, j + 1), v01 = vid(i, j + 1);
      const sides = [
        [ownerAtCell(i, j - 1), v00, v10],  // top, clockwise on screen
        [ownerAtCell(i + 1, j), v10, v11],  // right
        [ownerAtCell(i, j + 1), v11, v01],  // bottom
        [ownerAtCell(i - 1, j), v01, v00],  // left
      ];
      for (const [nb, f, t] of sides) {
        if (nb === o) continue;
        dirEdgesByCountry[o].push({ f, t });
        const k = ekey(f, t);
        if (!edgeMap.has(k)) {
          edgeMap.set(k, { v1: f, v2: t, a: Math.min(o, nb), b: Math.max(o, nb) });
        }
      }
    }
  }

  const deg = new Uint8Array(VW * VH);
  for (const e of edgeMap.values()) { deg[e.v1]++; deg[e.v2]++; }
  for (let v = 0; v < VW * VH; v++) {
    const vx = v % VW, vy = (v / VW) | 0;
    if (deg[v] >= 3 || vx === 0 || vy === 0 || vx === COLS || vy === ROWS) verts[v].pinned = true;
  }

  /* --- border objects: persistent polylines per country pair --- */
  const pairGroups = new Map(); // 'a_b' -> [{v1,v2}...]
  for (const e of edgeMap.values()) {
    const pk = e.a + '_' + e.b;
    if (!pairGroups.has(pk)) pairGroups.set(pk, []);
    pairGroups.get(pk).push(e);
  }
  const borders = [];
  let borderId = 0;
  for (const [pk, edges] of pairGroups) {
    const [a, b] = pk.split('_').map(Number);
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.v1)) adj.set(e.v1, []);
      if (!adj.has(e.v2)) adj.set(e.v2, []);
      adj.get(e.v1).push(e.v2);
      adj.get(e.v2).push(e.v1);
    }
    const usedE = new Set();
    const isNode = v => deg[v] !== 2;
    const mkBorder = (chain, closed) => borders.push({
      id: borderId++, a, b, verts: chain, closed, isFront: false,
    });
    for (const [v, nbs] of adj) {
      if (!isNode(v)) continue;
      for (const nb of nbs) {
        if (usedE.has(ekey(v, nb))) continue;
        usedE.add(ekey(v, nb));
        const chain = [v];
        let prev = v, cur = nb;
        for (;;) {
          chain.push(cur);
          if (isNode(cur)) break;
          const ns = adj.get(cur).filter(x => x !== prev || adj.get(cur).length === 1);
          let nxt = -1;
          for (const cand of ns) { if (!usedE.has(ekey(cur, cand))) { nxt = cand; break; } }
          if (nxt === -1) break;
          usedE.add(ekey(cur, nxt));
          prev = cur; cur = nxt;
        }
        mkBorder(chain, false);
      }
    }
    // closed rings (enclaves / island coasts) with no junction on them
    for (const e of edges) {
      if (usedE.has(ekey(e.v1, e.v2))) continue;
      usedE.add(ekey(e.v1, e.v2));
      const chain = [e.v1];
      let prev = e.v1, cur = e.v2;
      while (cur !== e.v1) {
        chain.push(cur);
        const ns = adj.get(cur).filter(x => x !== prev);
        const nxt = ns[0];
        usedE.add(ekey(cur, nxt));
        prev = cur; cur = nxt;
      }
      mkBorder(chain, true);
    }
  }

  /* --- country outlines: loops referencing the SAME vertex objects --- */
  function buildLoops(dirEdges) {
    const out = new Map();
    dirEdges.forEach((e, i) => {
      if (!out.has(e.f)) out.set(e.f, []);
      out.get(e.f).push(i);
    });
    const used = new Uint8Array(dirEdges.length);
    const loops = [];
    for (let s = 0; s < dirEdges.length; s++) {
      if (used[s]) continue;
      let e = dirEdges[s];
      used[s] = 1;
      const loop = [e.f];
      let guard = dirEdges.length + 8;
      while (e.t !== loop[0] && guard-- > 0) {
        loop.push(e.t);
        const cands = (out.get(e.t) || []).filter(i => !used[i]);
        if (!cands.length) break;
        let best = -1, bestAng = -Infinity;
        const vf = verts[e.f], vt = verts[e.t];
        const inx = vt.x - vf.x, iny = vt.y - vf.y;
        for (const ci of cands) {
          const c = dirEdges[ci], vv = verts[c.t];
          const oxx = vv.x - vt.x, oyy = vv.y - vt.y;
          let ang = Math.atan2(inx * oyy - iny * oxx, inx * oxx + iny * oyy);
          if (c.t === e.f && cands.length > 1) ang = -Infinity; // avoid u-turn
          if (ang > bestAng) { bestAng = ang; best = ci; }
        }
        e = dirEdges[best]; used[best] = 1;
      }
      loops.push(loop);
    }
    return loops;
  }

  /* --- country records --- */
  const usedNames = new Set();
  const countries = [];
  const counts = new Array(nFinal).fill(0);
  for (let k = 0; k < COLS * ROWS; k++) if (owner[k] >= 0) counts[owner[k]]++;
  for (let id = 0; id < nFinal; id++) {
    const hue = (id * 137.508 + rng() * 18) % 360;
    countries.push({
      id,
      name: makeName(rng, usedNames),
      color: `hsl(${hue.toFixed(1)}, ${(38 + rng() * 14).toFixed(0)}%, ${(58 + rng() * 10).toFixed(0)}%)`,
      cellCount: counts[id],
      loops: buildLoops(dirEdgesByCountry[id]),
      capital: null,
      area: 0,
      _path: null,
    });
  }
  for (const c of countries) c.area = loopsArea(c.loops, verts);

  const world = {
    seedStr, rng, verts, owner, land, borders, countries,
    simRng: mulberry32(seed ^ 0x9e3779b9),
  };
  for (const c of countries) computeCapital(world, c.id);
  return world;
}

function computeCapital(world, cid) {
  const { owner } = world;
  const c = world.countries[cid];
  // multi-source BFS from boundary cells inward; capital = deepest cell
  const d = new Int16Array(COLS * ROWS).fill(-1);
  const q = [];
  for (let k = 0; k < COLS * ROWS; k++) {
    if (owner[k] !== cid) continue;
    const ci = k % COLS, cj = (k / COLS) | 0;
    const nbs = [
      ci > 0 ? owner[k - 1] : -1, ci < COLS - 1 ? owner[k + 1] : -1,
      cj > 0 ? owner[k - COLS] : -1, cj < ROWS - 1 ? owner[k + COLS] : -1,
    ];
    if (nbs.some(n => n !== cid)) { d[k] = 0; q.push(k); }
  }
  let best = -1, bestD = -1, head = 0;
  while (head < q.length) {
    const k = q[head++];
    if (d[k] > bestD) { bestD = d[k]; best = k; }
    const ci = k % COLS, cj = (k / COLS) | 0;
    const nbs = [k - 1, k + 1, k - COLS, k + COLS];
    const oks = [ci > 0, ci < COLS - 1, cj > 0, cj < ROWS - 1];
    for (let i = 0; i < 4; i++) {
      if (oks[i] && owner[nbs[i]] === cid && d[nbs[i]] === -1) { d[nbs[i]] = d[k] + 1; q.push(nbs[i]); }
    }
  }
  if (best === -1) { c.capital = null; return; }
  const ci = best % COLS, cj = (best / COLS) | 0;
  c.capital = { x: (ci + 0.5) * CELL, y: (cj + 0.5) * CELL };
}

/* ================= state ================= */
const state = {
  world: null,
  phase: 'pick',          // 'pick' | 'war'
  alleg: new Map(),       // countryId -> 'red' | 'blue'
  war: null,
  lastWar: null,
  speed: 1,
  hoverCid: -1,
  fading: [],             // dead division ghosts
  geoDirty: true,
  log: [],
};

let ui = null; // DOM handles, set in init(); null when headless

function log(msg) {
  state.log.push(msg);
  if (ui) {
    const li = document.createElement('li');
    li.textContent = msg;
    ui.log.prepend(li);
    while (ui.log.children.length > 40) ui.log.lastChild.remove();
  }
}

function banner(title, sub) {
  if (!ui) return;
  ui.bannerTitle.textContent = title;
  ui.bannerSub.textContent = sub || '';
  ui.banner.classList.remove('hidden');
  clearTimeout(ui._bannerT);
  ui._bannerT = setTimeout(() => ui.banner.classList.add('hidden'), 6000);
}

function sideOf(cid) { return state.alleg.get(cid) || null; }

function cellOwnerAt(x, y) {
  const ci = clamp(Math.floor(x / CELL), 0, COLS - 1);
  const cj = clamp(Math.floor(y / CELL), 0, ROWS - 1);
  return state.world.owner[cj * COLS + ci];
}

function newWorld(seedStr) {
  const s = seedStr || ('terra-' + Math.random().toString(36).slice(2, 8));
  state.world = generateWorld(s);
  state.phase = 'pick';
  state.alleg.clear();
  state.war = null;
  state.lastWar = null;
  state.fading = [];
  state.geoDirty = true;
  state.log = [];
  if (ui) {
    ui.log.innerHTML = '';
    ui.seed.textContent = s;
    ui.warCard.classList.add('hidden');
    ui.day.textContent = '\u2014';
    refreshSetupUI();
  }
  log(`A new world: ${state.world.countries.length} nations rise.`);
  return state.world;
}

/* ================= side selection ================= */
function toggleAlleg(cid) {
  if (state.phase === 'war') return;
  if (cid < 0 || !state.world.countries[cid] || state.world.countries[cid].cellCount === 0) return;
  const cur = sideOf(cid);
  if (!cur) state.alleg.set(cid, 'red');
  else if (cur === 'red') state.alleg.set(cid, 'blue');
  else state.alleg.delete(cid);
  state.geoDirty = true;
  refreshSetupUI();
}

function computeFronts() {
  const fronts = [];
  for (const b of state.world.borders) {
    if (b.a < 0 || b.b < 0) continue;
    const sa = sideOf(b.a), sb = sideOf(b.b);
    if (sa && sb && sa !== sb) fronts.push(b);
  }
  return fronts;
}

function canStartWar() {
  let red = 0, blue = 0;
  for (const s of state.alleg.values()) { if (s === 'red') red++; else blue++; }
  if (red === 0 || blue === 0) return { ok: false, why: 'Both alliances need at least one nation.' };
  if (computeFronts().length === 0) return { ok: false, why: 'The chosen alliances share no land border \u2014 no front can form.' };
  return { ok: true, why: '' };
}

function refreshSetupUI() {
  if (!ui) return;
  const chips = { red: [], blue: [] };
  for (const [cid, s] of state.alleg) chips[s].push(state.world.countries[cid].name);
  for (const s of ['red', 'blue']) {
    const el = s === 'red' ? ui.chipsRed : ui.chipsBlue;
    el.innerHTML = chips[s].length
      ? chips[s].map(n => `<span class="chip">${n}</span>`).join('')
      : '<span class="empty">&mdash; none &mdash;</span>';
  }
  const chk = canStartWar();
  ui.btnWar.disabled = !chk.ok || state.phase === 'war';
  const someSelected = state.alleg.size > 0;
  ui.warn.classList.toggle('hidden', chk.ok || !someSelected);
  ui.warn.textContent = chk.why;
}

/* ================= war setup ================= */
function frontDir(border, k, outv) {
  // unit vector pointing from country a's side into country b's side at vertex k
  const vs = border.verts, n = vs.length;
  let kp, kn;
  if (border.closed) { kp = (k - 1 + n) % n; kn = (k + 1) % n; }
  else { kp = Math.max(0, k - 1); kn = Math.min(n - 1, k + 1); }
  const p = state.world.verts[vs[kp]], q = state.world.verts[vs[kn]];
  const tx = q.x - p.x, ty = q.y - p.y;
  const len = Math.hypot(tx, ty);
  if (len < 1e-6) { outv.x = 0; outv.y = 0; return outv; }
  // "left" of travel direction
  let lx = -ty / len, ly = tx / len;
  if (border.leftIsA) { lx = -lx; ly = -ly; }
  outv.x = lx; outv.y = ly;
  return outv;
}

function orientBorder(border) {
  // majority vote: which side of the polyline does country `a` lie on?
  const vs = border.verts;
  let votes = 0;
  const n = vs.length;
  for (let k = 0; k < n; k++) {
    let kp, kn;
    if (border.closed) { kp = (k - 1 + n) % n; kn = (k + 1) % n; }
    else { kp = Math.max(0, k - 1); kn = Math.min(n - 1, k + 1); }
    const p = state.world.verts[vs[kp]], q = state.world.verts[vs[kn]];
    const tx = q.x - p.x, ty = q.y - p.y;
    const len = Math.hypot(tx, ty);
    if (len < 1e-6) continue;
    const lx = -ty / len, ly = tx / len;
    const v = state.world.verts[vs[k]];
    const o = cellOwnerAt(v.x + lx * 0.5 * CELL, v.y + ly * 0.5 * CELL);
    if (o === border.a) votes++;
    else if (o === border.b) votes--;
  }
  border.leftIsA = votes > 0;
}

function spawnDivision(war, country, atFront) {
  const rng = state.world.simRng;
  if (!war.targets.length) return null;
  const t = war.targets[(rng() * war.targets.length) | 0];
  const side = sideOf(country.id);
  let x, y;
  if (atFront && t) {
    const v = state.world.verts[t.border.verts[t.k]];
    x = v.x + (rng() - 0.5) * 30; y = v.y + (rng() - 0.5) * 30;
  } else {
    const cap = country.capital || { x: W / 2, y: H / 2 };
    x = cap.x + (rng() - 0.5) * 24; y = cap.y + (rng() - 0.5) * 24;
  }
  const d = {
    cid: country.id, side, x, y,
    str: DIV_STR,
    border: t.border, k: t.k,
    speed: 12 + rng() * 5,
    engaged: false,
    rtTimer: 2 + rng() * 8,
  };
  war.divisions.push(d);
  return d;
}

function startWar() {
  const chk = canStartWar();
  if (!chk.ok || state.phase === 'war') return false;
  const fronts = computeFronts();
  const war = {
    day: 0,
    fronts,
    divisions: [],
    targets: [],
    checkT: 0.5,
    uiT: 0,
    sides: {
      red: { ids: [], area0: 0, cas: 0, exhausted: false },
      blue: { ids: [], area0: 0, cas: 0, exhausted: false },
    },
  };
  for (const b of fronts) {
    b.isFront = true;
    orientBorder(b);
    const n = b.verts.length;
    b._infA = new Float32Array(n);
    b._infB = new Float32Array(n);
    b._contest = new Float32Array(n);
    b._dx = new Float32Array(n);
    b._dy = new Float32Array(n);
    b._px = new Float32Array(n);
    b._py = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (!state.world.verts[b.verts[k]].pinned) war.targets.push({ border: b, k });
    }
  }
  for (const [cid, s] of state.alleg) {
    const c = state.world.countries[cid];
    war.sides[s].ids.push(cid);
    war.sides[s].area0 += loopsArea(c.loops, state.world.verts);
    const nDiv = clamp(Math.round(c.cellCount / 12), 3, 26);
    c._pool = Math.round(nDiv * DIV_STR * 1.15);
    c._spawnT = 1 + state.world.simRng() * 3;
    c._spawnInt = clamp(620 / Math.max(1, c.cellCount), 3, 14);
    for (let i = 0; i < nDiv; i++) spawnDivision(war, c, i < nDiv * 0.6);
  }
  state.war = war;
  state.phase = 'war';
  state.geoDirty = true;
  const names = s => war.sides[s].ids.map(id => state.world.countries[id].name).join(', ');
  log(`WAR! ${SIDE_NAMES.red} (${names('red')}) vs ${SIDE_NAMES.blue} (${names('blue')}).`);
  banner('WAR DECLARED', `${names('red')}  \u2694  ${names('blue')}`);
  if (ui) {
    ui.warCard.classList.remove('hidden');
    ui.btnWar.disabled = true;
  }
  return true;
}

/* ================= simulation step ================= */
const _tmpDir = { x: 0, y: 0 };

function stepSim() {
  const war = state.war;
  if (!war) return;
  const world = state.world;
  const verts = world.verts;
  const rng = world.simRng;
  war.day += DT_DAYS;

  /* -- reset influence -- */
  for (const b of war.fronts) { b._infA.fill(0); b._infB.fill(0); }

  /* -- divisions: move & project influence -- */
  for (const d of war.divisions) {
    const b = d.border;
    const n = b.verts.length;
    const v = verts[b.verts[d.k]];
    frontDir(b, d.k, _tmpDir);
    const amA = d.side === sideOf(b.a);
    const sign = amA ? -1 : 1;
    const sx = v.x + _tmpDir.x * sign * 9;
    const sy = v.y + _tmpDir.y * sign * 9;
    const dx = sx - d.x, dy = sy - d.y;
    const dd = Math.hypot(dx, dy);
    if (dd > 2) {
      const step = Math.min(dd, d.speed * DT_DAYS);
      d.x += dx / dd * step; d.y += dy / dd * step;
    }
    d.engaged = dd < 14;

    if (dd < 90) {
      const inf = amA ? b._infA : b._infB;
      for (let off = -4; off <= 4; off++) {
        let k = d.k + off;
        if (b.closed) k = (k + n) % n;
        else { if (k < 0 || k >= n) continue; }
        const vk = verts[b.verts[k]];
        const ddx = vk.x - d.x, ddy = vk.y - d.y;
        const w = Math.exp(-(ddx * ddx + ddy * ddy) / (2 * INF_SIGMA * INF_SIGMA));
        inf[k] += d.str * w;
      }
    }

    /* re-deploy / wander along the front */
    d.rtTimer -= DT_DAYS;
    if (d.rtTimer <= 0) {
      d.rtTimer = 4 + rng() * 8;
      if (rng() < 0.65 && war.targets.length) {
        let best = null, bestScore = -Infinity;
        for (let t = 0; t < 6; t++) {
          const cand = war.targets[(rng() * war.targets.length) | 0];
          const ca = d.side === sideOf(cand.border.a);
          const enemy = ca ? cand.border._infB[cand.k] : cand.border._infA[cand.k];
          const own = ca ? cand.border._infA[cand.k] : cand.border._infB[cand.k];
          const score = enemy - own * 0.6 + rng() * 45;
          if (score > bestScore) { bestScore = score; best = cand; }
        }
        if (best) { d.border = best.border; d.k = best.k; }
      } else if (d.engaged) {
        // shuffle a few vertices sideways: divisions probe along the line
        const shift = ((rng() * 5) | 0) - 2;
        let nk = d.k + shift;
        if (b.closed) nk = (nk + n) % n; else nk = clamp(nk, 0, n - 1);
        if (!verts[b.verts[nk]].pinned) d.k = nk;
      }
    }
  }

  /* -- border vertices: push, fluctuate, constrain -- */
  for (const b of war.fronts) {
    const vs = b.verts, n = vs.length;
    for (let k = 0; k < n; k++) {
      const v = verts[vs[k]];
      b._px[k] = v.x; b._py[k] = v.y;
      b._dx[k] = 0; b._dy[k] = 0;
      if (v.pinned) { b._contest[k] = 0; continue; }
      const iA = b._infA[k], iB = b._infB[k];
      b._contest[k] = Math.min(iA, iB);
      const dom = (iA - iB) / (iA + iB + 60);
      frontDir(b, k, _tmpDir);
      const contested = Math.min(1, b._contest[k] / 140);
      const fluct = 0.35 + 2.6 * contested;            // tremble of the line
      const push = MAX_PUSH * dom + (rng() * 2 - 1) * fluct;
      b._dx[k] = _tmpDir.x * push * DT_DAYS;
      b._dy[k] = _tmpDir.y * push * DT_DAYS;
    }
    // blur the displacement field along the chain so neighbours move together
    for (let pass = 0; pass < 2; pass++) {
      let pdx = b._dx[0], pdy = b._dy[0];
      for (let k = 1; k < n - 1; k++) {
        const cx = b._dx[k], cy = b._dy[k];
        b._dx[k] = pdx * 0.22 + cx * 0.56 + b._dx[k + 1] * 0.22;
        b._dy[k] = pdy * 0.22 + cy * 0.56 + b._dy[k + 1] * 0.22;
        pdx = cx; pdy = cy;
      }
    }
    for (let k = 0; k < n; k++) {
      const v = verts[vs[k]];
      if (v.pinned) continue;
      v.x += b._dx[k]; v.y += b._dy[k];
    }
    /* spike removal: relax only sharply folded vertices */
    for (let k = 0; k < n; k++) {
      const v = verts[vs[k]];
      if (v.pinned) continue;
      let kp, kn;
      if (b.closed) { kp = (k - 1 + n) % n; kn = (k + 1) % n; }
      else { if (k === 0 || k === n - 1) continue; kp = k - 1; kn = k + 1; }
      const a = verts[vs[kp]], c = verts[vs[kn]];
      const ax = a.x - v.x, ay = a.y - v.y, cx = c.x - v.x, cy = c.y - v.y;
      const la = Math.hypot(ax, ay), lc = Math.hypot(cx, cy);
      if (la < 1e-6 || lc < 1e-6) continue;
      const cos = (ax * cx + ay * cy) / (la * lc);
      if (cos > 0.25) { // sharper than ~75 deg: fold forming
        v.x = v.x * 0.55 + (a.x + c.x) / 2 * 0.45;
        v.y = v.y * 0.55 + (a.y + c.y) / 2 * 0.45;
      } else if (b._contest[k] > 40) {
        // heavy fighting churns and slightly evens the line
        v.x = v.x * 0.985 + (a.x + c.x) / 2 * 0.015;
        v.y = v.y * 0.985 + (a.y + c.y) / 2 * 0.015;
      }
    }
    /* stretch constraint */
    const last = b.closed ? n : n - 1;
    for (let k = 0; k < last; k++) {
      const v1 = verts[vs[k]], v2 = verts[vs[(k + 1) % n]];
      const dx = v2.x - v1.x, dy = v2.y - v1.y;
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-6) continue;
      let corr = 0;
      if (dl > MAX_SEG) corr = (dl - MAX_SEG) / dl;
      else if (dl < MIN_SEG) corr = (dl - MIN_SEG) / dl;
      if (corr !== 0) {
        const m1 = v1.pinned ? 0 : (v2.pinned ? 1 : 0.5);
        const m2 = v2.pinned ? 0 : (v1.pinned ? 1 : 0.5);
        v1.x += dx * corr * m1; v1.y += dy * corr * m1;
        v2.x -= dx * corr * m2; v2.y -= dy * corr * m2;
      }
    }
    /* keep vertices inside the two countries trading territory */
    for (let k = 0; k < n; k++) {
      const v = verts[vs[k]];
      if (v.pinned) continue;
      const o = cellOwnerAt(v.x, v.y);
      if (o !== b.a && o !== b.b) { v.x = b._px[k]; v.y = b._py[k]; }
      if (!isFinite(v.x) || !isFinite(v.y)) { v.x = b._px[k]; v.y = b._py[k]; }
    }
  }

  /* -- combat casualties -- */
  for (let i = war.divisions.length - 1; i >= 0; i--) {
    const d = war.divisions[i];
    const b = d.border;
    const amA = d.side === sideOf(b.a);
    const enemy = amA ? b._infB[d.k] : b._infA[d.k];
    const own = amA ? b._infA[d.k] : b._infB[d.k];
    if (enemy > 0.5) {
      const dmg = 7 * enemy / (enemy + own + 40) * DT_DAYS;
      d.str -= dmg;
      war.sides[d.side].cas += dmg * MEN_PER_STR;
      if (d.str <= 0) {
        war.divisions.splice(i, 1);
        state.fading.push({ x: d.x, y: d.y, side: d.side, t0: nowMs() });
      }
    }
  }

  /* -- reinforcements -- */
  for (const sKey of ['red', 'blue']) {
    const s = war.sides[sKey];
    for (const cid of s.ids) {
      const c = state.world.countries[cid];
      if (c._pool < DIV_STR) {
        if (!s.exhausted && totalPool(s) < DIV_STR) {
          s.exhausted = true;
          log(`${SIDE_NAMES[sKey]} reserves are exhausted.`);
        }
        continue;
      }
      c._spawnT -= DT_DAYS;
      if (c._spawnT <= 0) {
        c._spawnT = c._spawnInt;
        c._pool -= DIV_STR;
        spawnDivision(war, c, false);
      }
    }
  }

  /* -- end conditions (checked every half day) -- */
  war.checkT -= DT_DAYS;
  if (war.checkT <= 0) {
    war.checkT = 0.5;
    for (const sKey of ['red', 'blue']) {
      const s = war.sides[sKey];
      let area = 0;
      for (const cid of s.ids) area += loopsArea(state.world.countries[cid].loops, verts);
      s.areaNow = area;
      s.ratio = area / Math.max(1, s.area0);
    }
    const divCount = { red: 0, blue: 0 };
    for (const d of war.divisions) divCount[d.side]++;
    for (const sKey of ['red', 'blue']) {
      const s = war.sides[sKey];
      if (s.ratio < CAPITULATE_AT) return endWar(sKey, 'capitulation');
      if (divCount[sKey] === 0 && totalPool(s) < DIV_STR) return endWar(sKey, 'collapse');
    }
    if (war.day >= ARMISTICE_DAY) return endWar(null, 'armistice');
  }

  state.geoDirty = true;
}

function totalPool(side) {
  let p = 0;
  for (const cid of side.ids) p += state.world.countries[cid]._pool || 0;
  return p;
}

function nowMs() { return HAS_DOM ? performance.now() : Date.now(); }

/* ================= war end & territory resync ================= */
function endWar(loser, kind) {
  const war = state.war;
  const world = state.world;
  const warring = new Set([...war.sides.red.ids, ...war.sides.blue.ids]);

  // the border objects simply stop fluctuating — they keep their new shape
  for (const b of war.fronts) b.isFront = false;

  /* re-sync the coarse cell grid with the deformed polygons (for future wars/clicks) */
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of war.fronts) {
    for (const vi of b.verts) {
      const v = world.verts[vi];
      if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
    }
  }
  const i0 = clamp(Math.floor(minX / CELL) - 2, 0, COLS - 1);
  const i1 = clamp(Math.ceil(maxX / CELL) + 2, 0, COLS - 1);
  const j0 = clamp(Math.floor(minY / CELL) - 2, 0, ROWS - 1);
  const j1 = clamp(Math.ceil(maxY / CELL) + 2, 0, ROWS - 1);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const k = j * COLS + i;
      if (!warring.has(world.owner[k])) continue;
      const cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL;
      if (pointInLoops(world.countries[world.owner[k]].loops, world.verts, cx, cy)) continue;
      for (const cid of warring) {
        if (cid === world.owner[k]) continue;
        if (pointInLoops(world.countries[cid].loops, world.verts, cx, cy)) { world.owner[k] = cid; break; }
      }
    }
  }
  const counts = new Array(world.countries.length).fill(0);
  for (let k = 0; k < COLS * ROWS; k++) if (world.owner[k] >= 0) counts[world.owner[k]]++;
  for (const cid of warring) {
    const c = world.countries[cid];
    c.cellCount = counts[cid];
    c.area = loopsArea(c.loops, world.verts);
    computeCapital(world, cid);
  }

  /* summary */
  for (const sKey of ['red', 'blue']) {
    const s = war.sides[sKey];
    let area = 0;
    for (const cid of s.ids) area += loopsArea(world.countries[cid].loops, world.verts);
    s.areaNow = area;
    s.ratio = area / Math.max(1, s.area0);
  }
  const day = Math.floor(war.day);
  const winner = loser === 'red' ? 'blue' : (loser === 'blue' ? 'red' : null);
  let title, sub;
  if (kind === 'armistice') {
    title = 'ARMISTICE';
    sub = `The guns fall silent in stalemate \u2014 day ${day}.`;
    log(`Day ${day}: armistice. The war ends without a victor.`);
  } else {
    title = `${SIDE_NAMES[winner].toUpperCase()} VICTORIOUS`;
    sub = kind === 'collapse'
      ? `${SIDE_NAMES[loser]}'s armies are annihilated \u2014 day ${day}.`
      : `${SIDE_NAMES[loser]} capitulates \u2014 day ${day}.`;
    log(`Day ${day}: ${SIDE_NAMES[loser]} ${kind === 'collapse' ? 'collapses' : 'capitulates'}. ${SIDE_NAMES[winner]} wins the war.`);
  }
  const cas = war.sides.red.cas + war.sides.blue.cas;
  log(`The war cost ${fmtMen(cas)} lives. Borders settle along the new front.`);
  banner(title, sub);

  for (const d of war.divisions) state.fading.push({ x: d.x, y: d.y, side: d.side, t0: nowMs() });
  war.divisions = [];
  war.over = true;
  war.result = { loser, winner, kind, day };

  state.lastWar = war;
  state.war = null;
  state.phase = 'pick';
  state.alleg.clear();
  state.geoDirty = true;
  if (ui) { refreshSetupUI(); updateWarCard(war); }
  return war.result;
}

function fmtMen(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return Math.round(n).toString();
}

/* ================= rendering ================= */
let canvas = null, ctx = null, viewScale = 1;

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const pad = 28;
  const fit = Math.min((wrap.clientWidth - pad) / W, (wrap.clientHeight - pad) / H);
  const dpr = window.devicePixelRatio || 1;
  viewScale = fit;
  canvas.style.width = (W * fit) + 'px';
  canvas.style.height = (H * fit) + 'px';
  canvas.width = Math.round(W * fit * dpr);
  canvas.height = Math.round(H * fit * dpr);
}

function countryPath(c, verts) {
  const p = new Path2D();
  for (const lp of c.loops) {
    const v0 = verts[lp[0]];
    p.moveTo(v0.x, v0.y);
    for (let i = 1; i < lp.length; i++) {
      const v = verts[lp[i]];
      p.lineTo(v.x, v.y);
    }
    p.closePath();
  }
  return p;
}

function render(tSec) {
  const world = state.world;
  const verts = world.verts;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, 0, 0);

  /* ocean */
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#10293f');
  g.addColorStop(1, '#0b1d30');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  /* countries */
  for (const c of world.countries) {
    if (c.cellCount === 0 && c.area < 4 * CELL * CELL) continue;
    if (state.geoDirty || !c._path) c._path = countryPath(c, verts);
    ctx.fillStyle = c.color;
    ctx.fill(c._path, 'nonzero');
    const s = sideOf(c.id);
    if (s) {
      ctx.fillStyle = s === 'red' ? 'rgba(224,68,58,.38)' : 'rgba(63,116,232,.38)';
      ctx.fill(c._path, 'nonzero');
      ctx.strokeStyle = SIDE_COLORS[s];
      ctx.lineWidth = 2.4;
      ctx.stroke(c._path);
    }
    if (c.id === state.hoverCid && state.phase !== 'war') {
      ctx.fillStyle = 'rgba(255,255,255,.10)';
      ctx.fill(c._path, 'nonzero');
    }
  }
  state.geoDirty = false;

  /* borders — each one persistent object, stroked every frame */
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const b of world.borders) {
    ctx.beginPath();
    const v0 = verts[b.verts[0]];
    ctx.moveTo(v0.x, v0.y);
    for (let i = 1; i < b.verts.length; i++) {
      const v = verts[b.verts[i]];
      ctx.lineTo(v.x, v.y);
    }
    if (b.closed) ctx.closePath();
    if (b.isFront) {
      ctx.strokeStyle = 'rgba(255,64,44,.95)';
      ctx.lineWidth = 2.1 + Math.sin(tSec * 7 + b.id * 1.7) * 0.5;
      ctx.shadowColor = '#ff3b2d';
      ctx.shadowBlur = 9;
      ctx.stroke();
      ctx.shadowBlur = 0;
    } else if (b.a < 0 || b.b < 0) {
      ctx.strokeStyle = 'rgba(7,18,32,.85)';
      ctx.lineWidth = 2.2;
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(22,26,36,.72)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  /* battle flashes along contested stretches of the front */
  if (state.war) {
    for (const b of state.war.fronts) {
      for (let k = 0; k < b.verts.length; k++) {
        const c = b._contest[k];
        if (c > 8 && Math.random() < Math.min(0.4, c / 320)) {
          const v = verts[b.verts[k]];
          const r = 1 + Math.random() * 2.6;
          ctx.fillStyle = Math.random() < 0.5 ? 'rgba(255,205,92,.85)' : 'rgba(255,240,220,.9)';
          ctx.beginPath();
          ctx.arc(v.x + (Math.random() - 0.5) * 8, v.y + (Math.random() - 0.5) * 8, r, 0, 7);
          ctx.fill();
        }
      }
    }
  }

  /* divisions */
  if (state.war) {
    for (const d of state.war.divisions) drawDivision(d.x, d.y, d.side, d.str / DIV_STR, 1);
  }
  const tNow = nowMs();
  state.fading = state.fading.filter(f => tNow - f.t0 < 1500);
  for (const f of state.fading) {
    drawDivision(f.x, f.y, f.side, 0.4, 1 - (tNow - f.t0) / 1500);
  }

  /* capitals & labels */
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 10.5px ui-sans-serif, system-ui, sans-serif';
  for (const c of world.countries) {
    if (!c.capital || c.cellCount < 10) continue;
    ctx.fillStyle = 'rgba(15,18,26,.8)';
    ctx.beginPath();
    ctx.arc(c.capital.x, c.capital.y - 11, 2.1, 0, 7);
    ctx.fill();
    ctx.strokeStyle = 'rgba(10,14,22,.78)';
    ctx.lineWidth = 3;
    ctx.strokeText(c.name, c.capital.x, c.capital.y);
    ctx.fillStyle = 'rgba(243,246,252,.95)';
    ctx.fillText(c.name, c.capital.x, c.capital.y);
  }
}

function drawDivision(x, y, side, hp, alpha) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = SIDE_COLORS[side];
  ctx.strokeStyle = 'rgba(8,10,16,.8)';
  ctx.lineWidth = 0.9;
  const w = 8, h = 5.4;
  ctx.beginPath();
  ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();
  ctx.stroke();
  // NATO infantry cross
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(x - w / 2, y - h / 2); ctx.lineTo(x + w / 2, y + h / 2);
  ctx.moveTo(x + w / 2, y - h / 2); ctx.lineTo(x - w / 2, y + h / 2);
  ctx.stroke();
  // strength bar
  if (hp < 0.98) {
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(x - w / 2, y - h / 2 - 2.4, w, 1.5);
    ctx.fillStyle = hp > 0.5 ? '#7ed07e' : '#e6c352';
    ctx.fillRect(x - w / 2, y - h / 2 - 2.4, w * clamp(hp, 0, 1), 1.5);
  }
  ctx.globalAlpha = 1;
}

/* ================= war card UI ================= */
function updateWarCard(war) {
  if (!ui || !war) return;
  const divCount = { red: 0, blue: 0 };
  for (const d of war.divisions) divCount[d.side]++;
  for (const sKey of ['red', 'blue']) {
    const s = war.sides[sKey];
    const ratio = s.ratio !== undefined ? s.ratio : 1;
    ui[sKey].terr.textContent = Math.round(ratio * 100) + '%';
    ui[sKey].bar.style.width = clamp(ratio * 80, 2, 100) + '%';
    ui[sKey].div.textContent = divCount[sKey];
    ui[sKey].pool.textContent = fmtMen(totalPool(s) * MEN_PER_STR);
    ui[sKey].cas.textContent = fmtMen(s.cas);
  }
}

/* ================= main loop & input (browser only) ================= */
function init() {
  canvas = document.getElementById('map');
  ctx = canvas.getContext('2d');
  ui = {
    seed: document.getElementById('seed'),
    log: document.getElementById('log'),
    banner: document.getElementById('banner'),
    bannerTitle: document.getElementById('banner-title'),
    bannerSub: document.getElementById('banner-sub'),
    tooltip: document.getElementById('tooltip'),
    chipsRed: document.getElementById('chips-red'),
    chipsBlue: document.getElementById('chips-blue'),
    btnWar: document.getElementById('btn-war'),
    btnNew: document.getElementById('btn-new'),
    warn: document.getElementById('warn'),
    warCard: document.getElementById('war-card'),
    day: document.getElementById('day'),
    red: {
      terr: document.getElementById('st-red-terr'), bar: document.getElementById('bar-red-terr'),
      div: document.getElementById('st-red-div'), pool: document.getElementById('st-red-pool'),
      cas: document.getElementById('st-red-cas'),
    },
    blue: {
      terr: document.getElementById('st-blue-terr'), bar: document.getElementById('bar-blue-terr'),
      div: document.getElementById('st-blue-div'), pool: document.getElementById('st-blue-pool'),
      cas: document.getElementById('st-blue-cas'),
    },
  };

  newWorld();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / viewScale, y: (e.clientY - r.top) / viewScale };
  };

  canvas.addEventListener('click', (e) => {
    if (state.phase === 'war') return;
    const p = toWorld(e);
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return;
    toggleAlleg(cellOwnerAt(p.x, p.y));
  });

  canvas.addEventListener('mousemove', (e) => {
    const p = toWorld(e);
    const cid = (p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H) ? cellOwnerAt(p.x, p.y) : -1;
    if (cid !== state.hoverCid) { state.hoverCid = cid; state.geoDirty = true; }
    if (cid >= 0) {
      const c = state.world.countries[cid];
      const s = sideOf(cid);
      const status = state.phase === 'war' && s ? `${SIDE_NAMES[s]} \u2014 at war`
        : s ? SIDE_NAMES[s] : 'Neutral';
      ui.tooltip.innerHTML =
        `<div class="tt-name">${c.name}</div>` +
        `<div class="tt-dim">${status}</div>` +
        `<div class="tt-dim">${fmtMen(c.cellCount * 2400)} km&sup2;</div>`;
      ui.tooltip.classList.remove('hidden');
      ui.tooltip.style.left = (e.clientX + 14) + 'px';
      ui.tooltip.style.top = (e.clientY + 14) + 'px';
    } else {
      ui.tooltip.classList.add('hidden');
    }
  });
  canvas.addEventListener('mouseleave', () => {
    state.hoverCid = -1; state.geoDirty = true;
    ui.tooltip.classList.add('hidden');
  });

  ui.btnNew.addEventListener('click', () => { if (state.phase !== 'war') newWorld(); });
  ui.btnWar.addEventListener('click', () => startWar());

  document.querySelectorAll('#speeds .spd').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#speeds .spd').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.speed = parseFloat(btn.dataset.speed);
    });
  });

  /* main loop */
  let last = performance.now(), acc = 0, uiTimer = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (state.war && state.speed > 0) {
      acc += dt * state.speed * STEPS_PER_SEC;
      let n = Math.min(600, Math.floor(acc));
      acc -= Math.floor(acc);
      while (n-- > 0 && state.war) stepSim();
    }
    uiTimer -= dt;
    if (uiTimer <= 0) {
      uiTimer = 0.25;
      const w = state.war || state.lastWar;
      if (w) {
        ui.day.textContent = Math.floor(w.day);
        updateWarCard(w);
      }
    }
    render(now / 1000);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ================= entry ================= */
const API = {
  W, H, CELL, COLS, ROWS, DT_DAYS,
  state, generateWorld, newWorld, toggleAlleg, canStartWar, startWar, stepSim,
  computeFronts, loopsArea, pointInLoops, sideOf,
};
if (HAS_DOM) {
  window.__game = API; // for automated testing
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
