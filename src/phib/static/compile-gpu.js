// Phib, the GPU compiler. A world's tick as WGSL compute
// passes over a grid of value ids, so a world of 1024² or 2048² cells runs
// in a browser (gpu.js runs it). Exact: the same boards, tick for tick, as
// terms.js's step().
//
// Every type in a world is finite, so every value a layer can hold is
// listed once (terms.js's enumerate) and numbered: a board on the GPU is
// one u32 per cell layer, that number. What a recipe makes of the values
// in its cells is then a table over those numbers, worked out here on the
// CPU by terms.js's own match() and evalT():
//
// - rank: per recipe cell (layer) at a turn, each value's place among the
//   values its pattern can match (quick()), or NONE. For a cell without
//   variables that is the whole test.
// - comp: the cells with variables, in groups that share variables (and
//   `where`, which joins the groups whose variables it reads): for each
//   tuple of values (by rank), whether they match together.
// - write: per cell layer the After side writes, the value written, as a
//   table over the tuples of the groups whose variables it reads. A value
//   with holes (*) gets a number past the layer's list, and a fill table
//   says what it makes of each value it lands on.
// - per turn and key, whether the recipe runs at all (`on`, `in`, and a
//   `where` that reads only registers), and its chance.
//
// Tables depend on the registers; their layout doesn't, so the registers
// changing means new tables (gpu.js uploads them), never a new shader.
//
// A tick is two phases, the key's recipes (if a key was pressed) and the
// clock's, each groups in order, two passes a group, one thread an anchor:
//   propose: each match that no earlier group has outranked offers its
//            writes into prop[slot]; a different value there marks conf.
//   accept:  each such match whose slots all agree writes them into the
//            next board and stamps taken[slot] with its group.
// That is settleAll's rule. Like matches(), a recipe at a footprint keeps
// only its lowest matching turn (each thread tries the turns in order),
// and rolls hash32's dice after that. matches() also keeps one of a
// recipe's matches that write exactly the same: on the board that changes
// nothing (the same writes, the same claims), so the GPU needn't.
//
// What falls back: a world isn't eligible (compileGpu throws GpuError) if
// a layer's type has too many values or contains itself, if a table would
// be too big, or if a recipe that can ever fire adds to a register (the
// registers live on the CPU). A recipe that can't fire on what the board
// holds or anything the recipes write is left out (a nest's banking, in a
// world without nests). The CPU engine (compile.js or terms.js) runs the
// rest. `emulate` runs the passes in JavaScript, for tests.

import { HOLE, defaultOf, enumerate, evalT, fill, fit, hasVars, hash32, key, match, quick, ruleHash } from "./terms.js";
import { DIRS } from "./syntax.js";
import { NONE, wgsl } from "./wgsl.js";

export class GpuError extends Error {}

const CAP_VALUES = 1 << 16; // values a layer may have
const CAP_TABLE = 1 << 20; // entries one table may have
const CAP_TOTAL = 1 << 25; // entries in all

function turnOffset(x, y, k) {
  for (let i = 0; i < k; i++) [x, y] = [-y, x];
  return [x, y];
}
const trivial = (p) => p.t === "any" || p.t === "keep" || p.t === "var";

// The variables a pattern binds or reads.
function patVars(w, p, out = new Set()) {
  if (!p) return out;
  switch (p.t) {
    case "var":
      out.add(p.n);
      break;
    case "bind":
      out.add(p.n);
      patVars(w, p.p, out);
      break;
    case "named":
      patVars(w, w.patterns.get(p.n), out);
      break;
    case "con":
      p.args.forEach((a) => patVars(w, a, out));
      break;
    case "or":
      p.alts.forEach((a) => patVars(w, a, out));
      break;
    case "not":
      patVars(w, p.p, out);
      break;
  }
  return out;
}
// The names a template reads.
function tplVars(t, out = new Set()) {
  if (!t || typeof t !== "object") return out;
  if (Array.isArray(t)) {
    t.forEach((x) => tplVars(x, out));
    return out;
  }
  if (t.t === "var") out.add(t.n);
  for (const k of ["e", "c", "a", "b", "p", "args", "items"]) tplVars(t[k], out);
  for (const f of t.fields ?? []) tplVars(f[1], out);
  return out;
}
const callsFuns = (w, t) => {
  let found = false;
  const walk = (x) => {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (x.t === "call" && w.funs.has(x.f)) found = true;
    for (const k of ["e", "c", "a", "b", "p", "args", "items"]) walk(x[k]);
    for (const f of x.fields ?? []) walk(f[1]);
  };
  walk(t);
  return found;
};

// The key presses, as variants: N E S W, each walked and superhopped.
export const VARIANTS = DIRS.flatMap((d) => [false, true].map((far) => ({ c: "Key", a: [d, far] })));
export const variantOf = (input) => (input ? DIRS.indexOf(input.d) * 2 + (input.far ? 1 : 0) : -1);

// The exact u32 threshold for a chance q (a fraction): hash32(...) < q is
// h < T, h being the hash's u32 before it's divided by 2³².
export function threshold(q) {
  const two32 = 4294967296;
  let t = Math.ceil(q * two32);
  t = Math.max(0, Math.min(two32, t));
  while (t > 0 && (t - 1) / two32 >= q) t--;
  while (t < two32 && t / two32 < q) t++;
  return t;
}

// ---- the plan: what's on the GPU, and its tables ----

// Compiles world w for the GPU, given its current board (values the
// recipes can't make but the board holds count as there). Throws GpuError
// if the world can't run there. `regs` are the registers the tables read.
export function compileGpu(w, board, regs = w.regs0 ?? {}) {
  const t0 = performance.now();
  const L = w.L;
  // Every value of every layer, numbered.
  const values = w.cellTypes.map((ty, l) => {
    const vs = enumerate(w, ty, CAP_VALUES);
    if (!vs) throw new GpuError(`the ${w.layers[l]} layer has too many values (or contains itself)`);
    return vs;
  });
  const ids = values.map((vs) => new Map(vs.map((v, i) => [key(v), i])));
  const dom = values.map((vs) => vs.length);
  const blank = w.cellTypes.map((ty, l) => ids[l].get(key(defaultOf(w, ty))));
  const plan = { w, L, values, ids, dom, blank, regsRead: new Set(), stats: { errors: 0 } };

  // The rules, each laid out (tables to fill per register values later).
  const rules = [];
  for (const r of w.recipes) {
    const writes = [];
    r.cellsA.forEach((cell, n) => cell.forEach((tc, l) => tc.t !== "keep" && writes.push({ n, l, tc })));
    if (!writes.length) continue;
    rules.push(layoutRule(plan, r, writes));
  }
  plan.allRules = rules;
  fillTables(plan, regs);
  // Which recipes can fire: their cells can match what the board holds, or
  // what a recipe that can fire writes (a fixpoint).
  plan.board0 = values.map((vs) => new Uint8Array(vs.length));
  const at = toIds(plan, board);
  for (let s = 0; s < at.length; s++) plan.board0[s % L][at[s]] = 1;
  liveRules(plan);
  layoutBuffer(plan);
  plan.wgsl = wgsl(plan);
  plan.stats = { ...plan.stats, values: dom, rules: plan.rules.length, dropped: plan.dropped, cases: plan.cases.length, tableWords: plan.T.length, ms: performance.now() - t0 };
  return plan;
}

// The recipes that can fire, from what the board held and what they write
// (a fixpoint), and so the passes. Returns whether that changed.
function liveRules(plan) {
  const present = plan.board0.map((p) => p.slice());
  const live = new Set();
  for (let more = true; more; ) {
    more = false;
    for (const R of plan.allRules) {
      if (live.has(R) || !canFire(R, present)) continue;
      live.add(R);
      more = true;
      for (const v of R.outputs) present[v.l][v.id] = 1;
    }
  }
  const before = plan.rules?.map((R) => R.r.id).join(",");
  plan.present = present;
  plan.rules = plan.allRules.filter((R) => live.has(R));
  plan.dropped = plan.allRules.filter((R) => !live.has(R)).map((R) => R.r.id);
  for (const R of plan.rules) if (R.r.add?.length) throw new GpuError(`recipe ${R.r.id} adds to a register`);
  // Groups, per phase: the key's recipes and the clock's.
  const groupsOf = (rs) => [...new Set(rs.map((R) => R.r.group ?? 0))].sort((a, b) => a - b).map((g) => rs.filter((R) => (R.r.group ?? 0) === g));
  plan.phases = [groupsOf(plan.rules.filter((R) => R.r.on)), groupsOf(plan.rules.filter((R) => !R.r.on))];
  plan.cases = plan.phases.flatMap((groups, ph) => groups.map((rs, gi) => ({ ph, gi, rules: rs })));
  return before !== plan.rules.map((R) => R.r.id).join(",");
}

// Whether recipe R can fire on what's present: at some turn, every cell's
// pattern can match a present value.
function canFire(R, present) {
  return R.ks.some((K) => K.cells.every((c) => c.pass.some((id) => present[c.l][id])));
}

// A rule's layout: per turn, its cells, their groups (comps), its writes,
// and every table's size. Nothing here reads a register.
function layoutRule(plan, r, writes) {
  const { w, values } = plan;
  const onVars = patVars(w, r.on);
  const R = { r, hash: ruleHash(r.hashId ?? r.id), square: r.h === r.wd, ks: [], outputs: [], variants: r.on ? 8 : 1 };
  // Registers this rule reads: unbound names in its templates (and any, if
  // it calls a fun), its chance, and its `in`.
  const bound = new Set(onVars);
  r.cellsB.forEach((cell) => cell.forEach((p) => patVars(w, p).forEach((n) => bound.add(n))));
  const reads = new Set();
  for (const x of [r.where, ...writes.map((x) => x.tc)]) for (const n of tplVars(x)) if (!bound.has(n)) reads.add(n);
  if ([r.where, ...writes.map((x) => x.tc)].some((x) => callsFuns(w, x))) for (const n of Object.keys(w.regs0 ?? {})) reads.add(n);
  if (typeof r.chance === "string") reads.add(r.chance);
  if (r.in) reads.add(r.in);
  R.reads = [...reads];
  R.reads.forEach((n) => plan.regsRead.add(n));
  const whereVars = new Set([...tplVars(r.where)].filter((n) => bound.has(n) && !onVars.has(n)));
  for (let k = 0; k < 4; k++) {
    const offs = [];
    for (let i = 0; i < r.h; i++) for (let j = 0; j < r.wd; j++) offs.push(turnOffset(j, i, k));
    const mx = Math.min(...offs.map((o) => o[0]));
    const my = Math.min(...offs.map((o) => o[1]));
    const relX = offs.map((o) => o[0] - mx);
    const relY = offs.map((o) => o[1] - my);
    const K = { k, relX, relY, bw: Math.max(...relX) + 1, bh: Math.max(...relY) + 1, cells: [], comps: [], writes: [] };
    // Cells that test anything, in matches()'s order (cell, then layer).
    r.cellsB.forEach((cell, n) =>
      cell.forEach((p, l) => {
        if (trivial(p) && !hasVars(w, p)) return;
        const vars = hasVars(w, p) ? [...patVars(w, p)].filter((x) => !onVars.has(x)) : [];
        const pass = [];
        for (let id = 0; id < values[l].length; id++) if (quick(w, p, k, values[l][id])) pass.push(id);
        K.cells.push({ n, l, p, vars, full: hasVars(w, p), pass, rx: relX[n], ry: relY[n] });
      }),
    );
    // Cells with variables, grouped by the variables they share; `where`
    // joins the groups it reads.
    const full = K.cells.filter((c) => c.full);
    const parent = full.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const byVar = new Map();
    full.forEach((c, i) => {
      for (const v of c.vars) {
        if (byVar.has(v)) parent[find(i)] = find(byVar.get(v));
        else byVar.set(v, i);
      }
    });
    const wv = [...whereVars].filter((v) => byVar.has(v));
    for (let i = 1; i < wv.length; i++) parent[find(byVar.get(wv[i]))] = find(byVar.get(wv[0]));
    const comps = new Map();
    full.forEach((c, i) => {
      const root = find(i);
      if (!comps.has(root)) comps.set(root, { cells: [], vars: new Set(), where: false });
      comps.get(root).cells.push(c);
      c.vars.forEach((v) => comps.get(root).vars.add(v));
    });
    K.comps = [...comps.values()];
    for (const C of K.comps) {
      C.where = wv.length > 0 && wv.some((v) => C.vars.has(v));
      // Mixed radix over its cells' ranks.
      let size = 1;
      for (let i = C.cells.length - 1; i >= 0; i--) {
        C.cells[i].mul = size;
        size *= C.cells[i].pass.length;
      }
      C.size = size;
      if (size > CAP_TABLE) throw new GpuError(`recipe ${r.id}: its cells with variables have ${size} combinations`);
    }
    // A `where` that reads no cell's variables is a constant (per key).
    K.whereConst = !!r.where && wv.length === 0;
    for (const x of writes) {
      const reads = tplVars(x.tc);
      const deps = K.comps.filter((C) => [...C.vars].some((v) => reads.has(v)));
      let size = 1;
      for (let i = deps.length - 1; i >= 0; i--) size *= deps[i].size;
      if (size > CAP_TABLE) throw new GpuError(`recipe ${r.id}: a write has ${size} combinations`);
      K.writes.push({ ...x, deps, size, rx: relX[x.n], ry: relY[x.n] });
    }
    R.ks.push(K);
  }
  return R;
}

// Fills every table from the registers: the comps, the writes, the
// flags, the chance. Holes and their fills are numbered as they come.
export function fillTables(plan, regs) {
  const { w, ids, values, dom } = plan;
  const saved = w.regsNow;
  w.regsNow = regs;
  plan.holes = plan.holes ?? values.map(() => []); // per layer: values with holes
  plan.holeIds = plan.holeIds ?? values.map(() => new Map());
  plan.regs = { ...regs };
  plan.sig = regSig(plan, regs);
  try {
    for (const R of plan.allRules) {
      const r = R.r;
      const outputs = new Map();
      for (const K of R.ks) {
        K.flag = new Uint8Array(R.variants);
        K.compOk = K.comps.map((C) => new Uint8Array(C.size * R.variants));
        K.writeT = K.writes.map((x) => new Uint32Array(x.size * R.variants));
        for (let vi = 0; vi < R.variants; vi++) {
          const env0 = {};
          let on = true;
          if (r.on) on = match(w, r.on, VARIANTS[vi], K.k, env0);
          if (on && r.in) on = !!regs[r.in];
          if (on && K.whereConst) on = !!guard(plan, () => evalT(w, r.where, env0, K.k));
          K.flag[vi] = on ? 1 : 0;
          if (!on) continue;
          // Each comp's tuples: whether they match, and what they bind.
          const envs = K.comps.map((C, ci) => {
            const out = new Array(C.size);
            const ok = K.compOk[ci];
            for (let m = 0; m < C.size; m++) {
              const env = { ...env0 };
              let good = true;
              for (const c of C.cells) {
                const rank = Math.floor(m / c.mul) % c.pass.length;
                if (!match(w, c.p, values[c.l][c.pass[rank]], K.k, env)) {
                  good = false;
                  break;
                }
              }
              if (good && C.where) good = !!guard(plan, () => evalT(w, r.where, env, K.k));
              if (good) {
                ok[vi * C.size + m] = 1;
                out[m] = env;
              }
            }
            return out;
          });
          K.writes.forEach((x, j) => {
            const T = K.writeT[j];
            for (let m = 0; m < x.size; m++) {
              let env = env0;
              let rest = m;
              let good = true;
              for (let d = x.deps.length - 1; d >= 0; d--) {
                const C = x.deps[d];
                const e = envs[K.comps.indexOf(C)][rest % C.size];
                rest = Math.floor(rest / C.size);
                if (!e) {
                  good = false;
                  break;
                }
                env = env === env0 ? { ...e } : Object.assign(env, e);
              }
              if (!good) continue;
              const v = guard(plan, () => fit(w, w.cellTypes[x.l], evalT(w, x.tc, env, K.k), `recipe ${r.id}`));
              if (v === undefined) continue;
              const id = valueId(plan, x.l, v);
              T[vi * x.size + m] = id;
              outputs.set(`${x.l}:${id}`, { l: x.l, id });
            }
          });
        }
      }
      // What it can write, fills included.
      R.outputs = [...outputs.values()].flatMap((o) => (o.id < dom[o.l] ? [o] : plan.fills[o.l][o.id - dom[o.l]].map((id) => ({ l: o.l, id }))));
      // Its chance, as a threshold.
      const q = r.chance == null ? null : (typeof r.chance === "string" ? +(regs[r.chance] ?? 0) : r.chance) / 100;
      const t = q == null ? 4294967296 : threshold(q);
      R.chance = t >= 4294967296 ? [0, 0] : [1, t];
    }
  } finally {
    w.regsNow = saved;
  }
  void ids;
}

// A value's number in layer l: its place in the list, or past the list
// for a value with holes (and then a fill table, worked out once).
function valueId(plan, l, v) {
  const { w, ids, values, dom } = plan;
  const k = key(v);
  const id = ids[l].get(k);
  if (id !== undefined) return id;
  if (!hasHole(v)) throw new GpuError(`a recipe writes ${k}, which isn't a ${w.layers[l]}`);
  let h = plan.holeIds[l].get(k);
  if (h === undefined) {
    h = plan.holes[l].length;
    plan.holes[l].push(v);
    plan.holeIds[l].set(k, h);
    plan.fills ??= values.map(() => []);
    plan.fills[l][h] = values[l].map((old) => {
      const f = fill(w, v, old, w.cellTypes[l]);
      const id2 = ids[l].get(key(f));
      if (id2 === undefined) throw new GpuError(`filling ${k} makes ${key(f)}, which isn't a ${w.layers[l]}`);
      return id2;
    });
  }
  return dom[l] + h;
}
const hasHole = (v) => v === HOLE || (!!v && typeof v === "object" && Array.isArray(v.a) && v.a.some(hasHole));

// An evaluation that may fail on a combination no board will hold: then
// nothing (and counted).
function guard(plan, f) {
  try {
    return f();
  } catch {
    plan.stats.errors++;
    return undefined;
  }
}

// The registers the tables read, as a string: when it changes, the tables
// must be filled again.
export const regSig = (plan, regs) => [...plan.regsRead].map((n) => `${n}=${regs[n] ?? plan.w.regs0?.[n]}`).join(",");

// ---- one buffer of tables ----

// Lays every table into one u32 array, T, and notes each one's offset.
export function layoutBuffer(plan) {
  const { dom, L } = plan;
  plan.fills ??= plan.values.map(() => []);
  const parts = [];
  let at = 0;
  const put = (arr) => {
    const off = at;
    parts.push([off, arr]);
    at += arr.length;
    if (at > CAP_TOTAL) throw new GpuError(`the tables would take ${at} words`);
    return off;
  };
  // Fills, per layer: (hole, old) -> value.
  plan.fillOff = plan.fills.map((fs, l) => {
    const arr = new Uint32Array(Math.max(1, fs.length * dom[l]));
    fs.forEach((f, h) => arr.set(f, h * dom[l]));
    return put(arr);
  });
  // Phibber, per layer: 1 where the value is a Frog (for the camera).
  plan.frogOff = plan.values.map((vs) => put(Uint32Array.from(vs, (v) => (hasFrog(v) ? 1 : 0))));
  // Ranks are the same for every register and key: shared when equal.
  const shared = new Map();
  for (const R of plan.rules) {
    R.chanceOff = put(Uint32Array.from(R.chance));
    for (const K of R.ks) {
      K.flagOff = put(Uint32Array.from(K.flag));
      for (const c of K.cells) {
        const sig = `${c.l}:${c.pass.join(",")}`;
        let off = shared.get(sig);
        if (off === undefined) {
          const arr = new Uint32Array(dom[c.l]).fill(NONE);
          c.pass.forEach((id, i) => (arr[id] = i));
          shared.set(sig, (off = put(arr)));
        }
        c.rankOff = off;
      }
      K.comps.forEach((C, ci) => (C.off = put(Uint32Array.from(K.compOk[ci]))));
      K.writes.forEach((x, j) => (x.off = put(K.writeT[j])));
    }
  }
  const T = new Uint32Array(Math.max(4, at));
  for (const [off, arr] of parts) T.set(arr, off);
  plan.T = T;
  void L;
}

// New registers: the tables again (the same layout, so the same shader).
export function refill(plan, regs) {
  fillTables(plan, regs);
  // Other recipes may fire now, and a new value with holes needs a fill
  // table: then the offsets move, and the shader with them.
  liveRules(plan);
  const before = plan.wgsl;
  layoutBuffer(plan);
  plan.wgsl = wgsl(plan);
  return { T: plan.T, shader: plan.wgsl !== before };
}

const hasFrog = (v) => !!v && typeof v === "object" && (v.c === "Frog" || (v.a ?? []).some(hasFrog));

// ---- WGSL: wgsl.js, which quilt/wgsl.ts.quilt writes ----

export { wgsl };

// ---- the same passes in JavaScript ----

// Board <-> ids.
export function toIds(plan, board) {
  const out = new Uint32Array(board.length);
  // A board's values are mostly the same few objects (interned): key() once each.
  const seen = Array.from({ length: plan.L }, () => new Map());
  for (let s = 0; s < board.length; s++) {
    const l = s % plan.L;
    const v = board[s];
    let id = seen[l].get(v);
    if (id === undefined) {
      id = plan.ids[l].get(key(v));
      if (id === undefined) throw new GpuError(`the board holds ${key(v)}, which isn't a ${plan.w.layers[l]}`);
      seen[l].set(v, id);
    }
    out[s] = id;
  }
  return out;
}
export function fromIds(plan, ids, intern) {
  const out = new Array(ids.length);
  const cache = plan.values.map(() => new Map());
  for (let s = 0; s < ids.length; s++) {
    const l = s % plan.L;
    let v = cache[l].get(ids[s]);
    if (!v) cache[l].set(ids[s], (v = intern(plan.values[l][ids[s]])));
    out[s] = v;
  }
  return out;
}

// Whether the board holds only what the plan expects (else compile again:
// a recipe left out might fire now).
export const fits = (plan, ids) => {
  for (let s = 0; s < ids.length; s++) if (!plan.present[s % plan.L][ids[s]]) return false;
  return true;
};

// One tick of the passes, in JavaScript, exactly as the shader runs them
// (each pass's threads one after another: a serial order the GPU's atomics
// allow). `cur` is the ids; returns the next ids.
export function emulate(plan, cur, { tick = 0, seed = 0, input = null } = {}) {
  const variant = variantOf(input);
  let A = cur;
  for (let ph = 0; ph < 2; ph++) {
    if (ph === 0 && variant < 0) continue;
    const groups = plan.phases[ph];
    if (!groups.length) continue;
    A = emulatePhase(plan, A, groups, { tick, seed, variant: Math.max(0, variant) });
  }
  return A;
}

function emulatePhase(plan, A, groups, P) {
  const { T, L } = plan;
  const { W, H } = plan.w.level;
  const N = W * H;
  const B = A.slice();
  const prop = new Uint32Array(A.length);
  const conf = new Uint8Array(A.length);
  const taken = new Uint32Array(A.length);
  groups.forEach((rules, gi) => {
    prop.fill(0);
    conf.fill(0);
    const free = (s) => taken[s] === 0 || taken[s] - 1 >= gi;
    for (const accept of [false, true]) {
      for (let a = 0; a < N; a++) {
        const ox = a % W;
        const oy = (a - ox) / W;
        const o = a * L;
        for (const R of rules) {
          const cls = [false, false];
          const vb = R.variants > 1 ? P.variant : 0;
          for (const K of R.ks) {
            if (!(ox <= W - K.bw && oy <= H - K.bh && T[K.flagOff + vb] !== 0)) continue;
            const r = K.cells.map((c) => T[c.rankOff + A[o + (c.ry * W + c.rx) * L + c.l]]);
            if (r.some((x) => x === NONE)) continue;
            const m = K.comps.map((C) => C.cells.reduce((acc, c) => acc + r[K.cells.indexOf(c)] * c.mul, 0));
            if (!K.comps.every((C, ci) => T[C.off + vb * C.size + m[ci]] !== 0)) continue;
            const ci = R.square ? 0 : K.k & 1;
            if (cls[ci]) continue;
            cls[ci] = true;
            const [roll, thr] = [T[R.chanceOff], T[R.chanceOff + 1]];
            if (roll && !((hash32(P.seed, P.tick, R.hash, a * 2 + (R.square ? 0 : K.k & 1)) * 4294967296) < thr)) continue;
            const ws = K.writes.map((x) => {
              let idx = 0;
              let mul = 1;
              for (let d = x.deps.length - 1; d >= 0; d--) {
                idx += m[K.comps.indexOf(x.deps[d])] * mul;
                mul *= x.deps[d].size;
              }
              return { s: o + (x.ry * W + x.rx) * L + x.l, v: T[x.off + vb * x.size + idx], l: x.l };
            });
            if (!ws.every((x) => free(x.s))) continue;
            if (accept) {
              if (ws.every((x) => conf[x.s] === 0)) {
                for (const x of ws) {
                  B[x.s] = x.v < plan.dom[x.l] ? x.v : T[plan.fillOff[x.l] + (x.v - plan.dom[x.l]) * plan.dom[x.l] + A[x.s]];
                  taken[x.s] = gi + 1;
                }
              }
            } else {
              for (const x of ws) {
                if (prop[x.s] === 0) prop[x.s] = x.v + 1;
                else if (prop[x.s] !== x.v + 1) conf[x.s] = 1;
              }
            }
          }
        }
      }
    }
  });
  return B;
}
