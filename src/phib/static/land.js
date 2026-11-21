// Land: a level's cells grown by rules (syntax.js's land lines, under a
// `gen` or an `endless`), each from the seed and where the cell is alone,
// so land can be grown in any order, a chunk at a time, forever, and comes
// out the same each time. And the window of an endless level: the chunks
// round Phibber that run, following him, keeping what changed in the land
// he leaves.
//
// What covers a cell first wins: a place's blueprint, then its square's
// site, then the layers, each layer's first rule that holds. A blueprint
// cell with anything in it is the blueprint's (a layer left blank is that
// layer's first value); a cell blank in every layer is left to the land.
//
// Expressions see x, y, seed, width and height (for a gen), the registers,
// every field and zone at the cell by name (and a field as a function,
// wet(x, y)), each band's name as its number, and in a river's value
// `flow`, the way along it. rand() is the cell's own stream; a rule's
// chance and a pick roll dice of their own, so adding a rule doesn't move
// another's. In sites, x and y are the square's middle, and sx, sy the
// square.

import { blob, hash, lattice, vnoise } from "./noise.js";
import { defaultOf, evalT, fit, hash32, intern, layerLegends, match, pattern, rot, template, WorldError } from "./terms.js";

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const DIR = ["N", "E", "S", "W"];
const floorDiv = (a, b) => Math.floor(a / b);

const salt = (name) => {
  let h = 0;
  for (const c of name) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return h;
};

// Whether an expression reads anything (so its value isn't one value for
// every cell).
const reads = (e) => !!e && typeof e === "object" && (e.t === "var" || e.t === "call" || Object.values(e).some((v) => (Array.isArray(v) ? v.some(reads) : reads(v))));

// A blueprint's four turns: { w, h, cells: [null | values per layer] },
// turned a quarter clockwise each time, values and all.
function blueprintTurns(w, bp, legends) {
  const L = w.L;
  if (L < 2) throw new WorldError(`blueprint ${bp.name}: a blueprint is drawn a grid a layer, in a world of layers`, bp.line);
  const blank = w.cellTypes.map((ty) => intern(w, defaultOf(w, ty)));
  const grids = bp.rows.map((r) => {
    if (r.length !== L) throw new WorldError(`blueprint ${bp.name}: a row is ${L} grids side by side, one a layer (${w.cell})`, bp.line);
    return r.map((g) => [...g]);
  });
  const h = grids.length;
  const wd = Math.max(...grids.flat().map((g) => g.length));
  let T = { w: wd, h, cells: [] };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < wd; x++) {
      const chs = grids[y].map((g) => g[x] ?? " ");
      if (chs.every((c) => c === " ")) {
        T.cells.push(null);
        continue;
      }
      T.cells.push(
        chs.map((c, l) => {
          if (c === " ") return blank[l];
          const v = legends[l].get(c);
          if (!v) throw new WorldError(`blueprint ${bp.name}: its ${w.layers[l]} '${c}' has no legend`, bp.line);
          return v;
        }),
      );
    }
  }
  const out = [T];
  for (let t = 1; t < 4; t++) {
    // A quarter turn clockwise: (x, y) goes to (h - 1 - y, x).
    const R = { w: T.h, h: T.w, cells: [] };
    for (let y = 0; y < R.h; y++) {
      for (let x = 0; x < R.w; x++) {
        const c = T.cells[(T.h - 1 - x) * T.w + y];
        R.cells.push(c && c.map((v) => intern(w, rot(w, v, 1))));
      }
    }
    out.push(R);
    T = R;
  }
  return out;
}

// The land of a level, made ready: { cell(x, y) } gives a cell's values,
// one a layer. `spec` is the land (gen.land or endless.land, its defines
// already filled in); `base` is what its expressions see everywhere.
export function compileLand(w, spec, { seed = 0, regs = {}, blueprints = {}, size = null } = {}) {
  const L = w.L;
  const blank = w.cellTypes.map((ty) => intern(w, defaultOf(w, ty)));
  const base = { ...regs, seed };
  if (size) Object.assign(base, { width: size[0], height: size[1] });
  for (const z of spec.zones) z.bands.forEach(([b], k) => (base[b] = k));
  const val = (e, env) => evalT(w, e, env, 0);

  // Fields: smooth noise, salted by name unless given a seed.
  const fields = spec.fields.map((f) => {
    const s = f.seed != null ? val(f.seed, base) | 0 : (Math.imul(seed | 0, 7919) + salt(f.name)) | 0;
    const scale = val(f.scale, base);
    const fn = f.noise === "lattice" ? lattice(s, scale) : f.noise === "blob" ? (x, y) => blob(x, y, scale, s) : (x, y) => vnoise(x, y, scale, s);
    return { name: f.name, fn, scale: f.noise === "lattice" ? null : scale };
  });
  const field = Object.fromEntries(fields.map((f) => [f.name, f]));

  // What expressions call: the fields, rand() and the cell so far.
  let cur = null; // { x, y, n, vals }
  const fns = {
    rand: () => hash32(cur.x, cur.y, seed, 0x51ed + cur.n++),
    ground: (x, y) => (cur && x === cur.x && y === cur.y ? cur.vals[0] : null),
    item: (x, y) => (cur && x === cur.x && y === cur.y ? cur.vals[L - 1] : null),
  };
  for (const f of fields) fns[f.name] = f.fn;

  // The env at a spot: the fields and zones there.
  const at = (x, y, extra) => {
    const env = Object.create(base);
    env.x = x;
    env.y = y;
    if (extra) Object.assign(env, extra);
    for (const f of fields) env[f.name] = f.fn(x, y);
    for (const z of spec.zones) {
      const v = val(z.by, env);
      let k = 0;
      for (let i = 1; i < z.bands.length; i++) if (v >= z.bands[i][1]) k = i;
      env[z.name] = k;
    }
    return env;
  };

  // A value, checked as its layer's: one value made once if it reads
  // nothing, or worked out for each cell.
  const valueOf = (e, l, line) => {
    const t = template(w, e, line, w.cellTypes[l]);
    const one = (env) => intern(w, fit(w, w.cellTypes[l], val(t, env), `land, line ${line}`));
    if (reads(t)) return one;
    const v = one(base);
    return () => v;
  };
  const layerOf = (name, line) => {
    const l = w.layers.findIndex((n) => n.toLowerCase() === name.toLowerCase());
    if (l < 0) throw new WorldError(`a layer is one of ${w.layers.join(", ")}, not ${name}`, line);
    return l;
  };
  const zoneOf = (name, line) => {
    const z = spec.zones.find((x) => x.name === name);
    if (!z) throw new WorldError(`a pick is by ${name}, which isn't a zone`, line);
    return z;
  };

  // Rules, ready: each { test(env, x, y) -> what it writes or "nothing", or null }.
  let ruleNo = 0;
  const rules = (list, make) =>
    list.map((r) => {
      const n = ++ruleNo;
      const where = r.where;
      const chance = r.chance;
      const roll = (x, y, k) => hash32(x, y, seed ^ 0x2545f491, n * 8 + k);
      let pick = null;
      if (r.pick) {
        const z = r.pick.by != null ? zoneOf(r.pick.by, r.line) : null;
        pick = r.pick.rows.map((row) => {
          let band = null;
          if (z) {
            band = z.bands.findIndex(([b]) => b === row.band);
            if (band < 0) throw new WorldError(`a pick by ${z.name} has a row ${row.band}, which isn't one of its bands`, r.line);
          }
          let cum = 0;
          return { band, entries: row.entries.map(([v, p]) => ({ v: v === "nothing" ? "nothing" : make(v, r.line), upTo: (cum += p) / 100 })) };
        });
      }
      const along = r.along;
      if (along && !field[along.field]) throw new WorldError(`a river runs along ${along.field}, which isn't a field`, r.line);
      const v = r.pick ? null : r.v === "nothing" ? "nothing" : make(r.v, r.line);
      return (env, x, y) => {
        if (where && !val(where, env)) return null;
        if (chance != null && roll(x, y, 0) >= chance / 100) return null;
        if (pick) {
          const p = roll(x, y, 1);
          for (const row of pick) {
            if (row.band != null && row.band !== env[r.pick.by]) continue;
            for (const e of row.entries) if (p < e.upTo) return e.v;
          }
          return null;
        }
        if (along) {
          const F = field[along.field];
          const lv = val(along.at, env);
          const wd = val(along.width, env);
          const f = F.fn(x, y) - lv;
          // Smooth noise climbs no faster than about 2.3 / scale a cell: a
          // cell farther than that from the line can't be on it.
          if (F.scale && Math.abs(f) * F.scale >= wd * 2) return null;
          const gx = F.fn(x + 1, y) - F.fn(x - 1, y);
          const gy = F.fn(x, y + 1) - F.fn(x, y - 1);
          const slope = Math.hypot(gx, gy);
          if (!(Math.abs(f) * 4 < wd * slope)) return null;
          // Along the line, across the slope: mostly one way (p), else the
          // other (s), whichever keeps the next cell on the river, so a raft
          // rides on.
          const steep = Math.abs(gy) > Math.abs(gx);
          const p = steep ? (gy < 0 ? 1 : 3) : gx > 0 ? 2 : 0;
          const s = steep ? (gx > 0 ? 2 : 0) : gy < 0 ? 1 : 3;
          const next = F.fn(x + DX[p], y + DY[p]) - lv;
          env.flow = DIR[Math.abs(next) * 4 < wd * slope ? p : s];
        }
        return v;
      };
    });

  // Blueprints, the game's and the level's.
  const legends = layerLegends(w);
  const turnsOf = new Map();
  const bpTurns = (name, line) => {
    if (!turnsOf.has(name)) {
      const bp = blueprints[name];
      if (!bp) throw new WorldError(`the land lays ${name}, but there's no blueprint ${name}`, line);
      turnsOf.set(name, blueprintTurns(w, bp, legends));
    }
    return turnsOf.get(name);
  };

  const places = spec.places.map((p) => {
    const t = p.turns != null ? (((val(p.turns, base) | 0) % 4) + 4) % 4 : 0;
    return { x: val(p.x, base), y: val(p.y, base), T: bpTurns(p.bp, p.line)[t] };
  });

  // Sites: a square's blueprint, where it lies and how it's turned.
  const S = spec.sites;
  let siteRules = null;
  const squares = new Map();
  if (S) {
    siteRules = rules(S.rules, (name, line) => (bpTurns(name, line), name));
  }
  const square = (sx, sy) => {
    const k = `${sx},${sy}`;
    let q = squares.get(k);
    if (q !== undefined) return q;
    q = null;
    const cx = Math.floor(sx * S.size + S.size / 2);
    const cy = Math.floor(sy * S.size + S.size / 2);
    cur = { x: sx, y: sy, n: 1 << 20, vals: blank };
    const env = at(cx, cy, { sx, sy });
    let name = null;
    for (const r of siteRules) {
      const got = r(env, sx, sy);
      if (got != null) {
        name = got;
        break;
      }
    }
    if (name && name !== "nothing") {
      const h = (k2) => hash32(sx, sy, seed ^ 0x7f4a7c15, k2);
      const t = Math.floor(h(1) * 4);
      const T = bpTurns(name)[t];
      const room = (n) => Math.max(1, S.size - 2 * S.margin - n + 1);
      q = { T, x: sx * S.size + S.margin + Math.floor(h(2) * room(T.w)), y: sy * S.size + S.margin + Math.floor(h(3) * room(T.h)) };
    }
    squares.set(k, q);
    if (squares.size > 4096) squares.clear();
    return q;
  };
  const fromBp = (q, x, y) => {
    const bx = x - q.x;
    const by = y - q.y;
    if (bx < 0 || by < 0 || bx >= q.T.w || by >= q.T.h) return null;
    return q.T.cells[by * q.T.w + bx];
  };

  // Layers: each writes its own layer, where its `on` holds.
  const layers = spec.layers.map((Ly) => {
    const l = layerOf(Ly.layer, Ly.line);
    const on = Ly.on && pattern(w, Ly.on, Ly.line, w.cellTypes[0]);
    return { l, on, rules: rules(Ly.rules, (e, line) => valueOf(e, l, line)) };
  });

  // One cell: its values, one a layer.
  function cell(x, y) {
    for (const p of places) {
      const c = fromBp(p, x, y);
      if (c) return c;
    }
    if (S) {
      const q = square(floorDiv(x, S.size), floorDiv(y, S.size));
      const c = q && fromBp(q, x, y);
      if (c) return c;
    }
    const vals = [...blank];
    if (!layers.length) return vals;
    cur = { x, y, n: 0, vals };
    const env = at(x, y);
    for (const Ly of layers) {
      if (Ly.on && !match(w, Ly.on, vals[0], 0, {})) continue;
      for (const r of Ly.rules) {
        const got = r(env, x, y);
        if (got == null) continue;
        if (got !== "nothing") vals[Ly.l] = got(env);
        break;
      }
    }
    return vals;
  }

  // Calls in expressions go to fns while the land grows.
  const growing = (f) => {
    const was = w.genFns;
    w.genFns = { ...was, ...fns };
    try {
      return f();
    } finally {
      w.genFns = was;
    }
  };
  return {
    cell: (x, y) => growing(() => cell(x, y)),
    // A chunk: size × size cells from (cx, cy) × size, flat, layer by layer.
    chunk: (cx, cy, n) =>
      growing(() => {
        const out = new Array(n * n * L);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
          const c = cell(cx * n + x, cy * n + y);
          for (let l = 0; l < L; l++) out[(y * n + x) * L + l] = c[l];
        }
        return out;
      }),
    // A sized board: width × height cells from (0, 0).
    board: (W, H) =>
      growing(() => {
        const out = new Array(W * H * L);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const c = cell(x, y);
          for (let l = 0; l < L; l++) out[(y * W + x) * L + l] = c[l];
        }
        return out;
      }),
  };
}

// ---- the window ----

const isFrog = (v) => v?.c === "Frog";

// An endless level's land, played through a window of chunks round
// Phibber. Chunks once grown are kept, as they are now; a save keeps only
// how each differs from what the seed grows there.
export class Land {
  constructor(w, endless, { seed = 0, regs = {}, blueprints = {}, saved = null } = {}) {
    this.w = w;
    this.CH = endless.chunk;
    this.WIN = endless.window;
    this.SPAN = this.CH * this.WIN;
    this.land = compileLand(w, endless.land, { seed, regs, blueprints });
    this.chunks = new Map();
    this.explored = new Set(saved?.explored ?? []);
    // Changes, by chunk: [cell, layer, value index, …] into values.
    this.diffs = saved?.chunks ?? {};
    this.palette = (saved?.values ?? []).map((v) => intern(w, v));
    // Phibber, on the map (home is 0, 0).
    this.frog = saved?.frog ?? null;
    this.ccx = 0;
    this.ccy = 0;
  }

  get origin() {
    const half = (this.WIN - 1) / 2;
    return { x: (this.ccx - half) * this.CH, y: (this.ccy - half) * this.CH };
  }

  chunk(cx, cy) {
    const k = `${cx},${cy}`;
    let c = this.chunks.get(k);
    if (c) return c;
    c = this.land.chunk(cx, cy, this.CH);
    const d = this.diffs[k];
    if (d) for (let i = 0; i < d.length; i += 3) c[d[i] * this.w.L + d[i + 1]] = this.palette[d[i + 2]];
    this.chunks.set(k, c);
    return c;
  }

  // The board of the window round chunk (ccx, ccy), with Phibber on it
  // once, where he is.
  build(ccx, ccy) {
    const { CH, SPAN, WIN } = this;
    const L = this.w.L;
    const half = (WIN - 1) / 2;
    this.ccx = ccx;
    this.ccy = ccy;
    const board = new Array(SPAN * SPAN * L);
    for (let a = 0; a < WIN; a++) {
      for (let b = 0; b < WIN; b++) {
        const cx = ccx - half + a;
        const cy = ccy - half + b;
        const c = this.chunk(cx, cy);
        this.explored.add(`${cx},${cy}`);
        for (let y = 0; y < CH; y++) {
          for (let x = 0; x < CH * L; x++) board[((b * CH + y) * SPAN + a * CH) * L + x] = c[y * CH * L + x];
        }
      }
    }
    // One Phibber: where he is, if the window holds that; else the first.
    const o = this.origin;
    const item = L - 1;
    const want = this.frog && (this.frog[1] - o.y) * SPAN + (this.frog[0] - o.x);
    let keep = -1;
    for (let i = 0; i < SPAN * SPAN; i++) if (isFrog(board[i * L + item]) && (keep < 0 || i === want)) keep = i;
    const empty = intern(this.w, defaultOf(this.w, this.w.cellTypes[item]));
    for (let i = 0; i < SPAN * SPAN; i++) if (i !== keep && isFrog(board[i * L + item])) board[i * L + item] = empty;
    if (keep < 0) {
      keep = this.landing(board, this.frog ?? [ccx * CH + CH / 2, ccy * CH + CH / 2]);
      board[keep * L + item] = intern(this.w, { c: "Frog", a: ["S", { c: "Sit", a: [] }] });
    }
    this.frog = [o.x + (keep % SPAN), o.y + Math.floor(keep / SPAN)];
    return board;
  }

  // A free cell of floor near map cell (x, y), as a window index.
  landing(board, [x, y]) {
    const { SPAN } = this;
    const L = this.w.L;
    const o = this.origin;
    const floor = this.w.patterns.get("floor");
    for (let r = 0; r < SPAN; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const lx = x + dx - o.x;
          const ly = y + dy - o.y;
          if (lx < 0 || ly < 0 || lx >= SPAN || ly >= SPAN) continue;
          const i = ly * SPAN + lx;
          const g = board[i * L];
          if ((floor ? match(this.w, floor, g, 0, {}) : true) && board[i * L + L - 1].c === "Empty") return i;
        }
      }
    }
    return Math.floor(SPAN / 2) * SPAN + Math.floor(SPAN / 2);
  }

  // The window's cells back into their chunks.
  writeBack(board) {
    const { CH, SPAN, WIN } = this;
    const L = this.w.L;
    const half = (WIN - 1) / 2;
    for (let a = 0; a < WIN; a++) {
      for (let b = 0; b < WIN; b++) {
        const c = this.chunk(this.ccx - half + a, this.ccy - half + b);
        for (let y = 0; y < CH; y++) {
          for (let x = 0; x < CH * L; x++) c[y * CH * L + x] = board[((b * CH + y) * SPAN + a * CH) * L + x];
        }
      }
    }
  }

  // Where Phibber is on the board, as a window index, or -1.
  find(board) {
    const L = this.w.L;
    for (let i = L - 1; i < board.length; i += L) if (isFrog(board[i])) return (i - L + 1) / L;
    return -1;
  }

  // After a tick: notes where Phibber is, and moves the window when he is
  // well into another chunk. Returns null, or { sx, sy, board }: how far
  // the window's corner moved, in cells, and the new window's board.
  follow(board) {
    const { CH, SPAN } = this;
    const P = this.find(board);
    if (P < 0) return null;
    const o = this.origin;
    const fx = o.x + (P % SPAN);
    const fy = o.y + Math.floor(P / SPAN);
    this.frog = [fx, fy];
    const dx = fx - (this.ccx * CH + CH / 2);
    const dy = fy - (this.ccy * CH + CH / 2);
    if (Math.abs(dx) <= CH * 0.75 + 0.5 && Math.abs(dy) <= CH * 0.75 + 0.5) return null;
    this.writeBack(board);
    const next = this.build(floorDiv(fx, CH), floorDiv(fy, CH));
    const o2 = this.origin;
    return { sx: o2.x - o.x, sy: o2.y - o.y, board: next };
  }

  // A window index in the window before a shift, in the one after (or -1).
  static remap(i, sx, sy, SPAN) {
    const x = (i % SPAN) - sx;
    const y = Math.floor(i / SPAN) - sy;
    return x < 0 || y < 0 || x >= SPAN || y >= SPAN ? -1 : y * SPAN + x;
  }

  // What a save keeps: each chunk Phibber changed, as how it differs from
  // the seed's, and where he is.
  save(board) {
    this.writeBack(board);
    const L = this.w.L;
    const values = [];
    const ids = new Map();
    const chunks = {};
    for (const [k, c] of this.chunks) {
      const [cx, cy] = k.split(",").map(Number);
      const fresh = this.land.chunk(cx, cy, this.CH);
      const d = [];
      for (let s = 0; s < c.length; s++) {
        if (c[s] === fresh[s]) continue;
        let id = ids.get(c[s]);
        if (id == null) {
          id = values.push({ c: c[s].c, a: c[s].a }) - 1;
          ids.set(c[s], id);
        }
        d.push((s - (s % L)) / L, s % L, id);
      }
      if (d.length) chunks[k] = d;
    }
    // Chunks not grown since loading keep what they had.
    for (const [k, d] of Object.entries(this.diffs)) {
      if (this.chunks.has(k)) continue;
      const out = [];
      for (let i = 0; i < d.length; i += 3) {
        const v = this.palette[d[i + 2]];
        let id = ids.get(v);
        if (id == null) {
          id = values.push({ c: v.c, a: v.a }) - 1;
          ids.set(v, id);
        }
        out.push(d[i], d[i + 1], id);
      }
      chunks[k] = out;
    }
    return { chunks, values, frog: this.frog, explored: [...this.explored] };
  }

  // What a map cell holds, or null if no one has been near it.
  peek(x, y) {
    const cx = floorDiv(x, this.CH);
    const cy = floorDiv(y, this.CH);
    if (!this.explored.has(`${cx},${cy}`)) return null;
    const c = this.chunk(cx, cy);
    const i = ((y - cy * this.CH) * this.CH + (x - cx * this.CH)) * this.w.L;
    return c.slice(i, i + this.w.L);
  }
}

// Hash, exported for games' daily choices and tests.
export { hash };
