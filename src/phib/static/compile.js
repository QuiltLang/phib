// Phib, the recipe compiler. From a built world it writes
// JavaScript that finds the same matches as terms.js's matches(), in the
// same order, much faster on a big board, and runs a phase with it: a world
// with `w.compiled = compileWorld(w)` has terms.js's phase() hand its work
// here. Settling and the registers are terms.js's own (settleAll, effects),
// so a compiled tick is the interpreter's tick, match for match.
//
// What is compiled, and why it is exact:
//
// - Every value on the board is interned (terms.js's ID), so a board is
//   also an array of small ids, kept here beside it (`ids`). A recipe
//   cell's pattern without variables matches a value or doesn't, whatever
//   else is bound: a table over ids says which (quick(), exact there). A
//   cell with variables gets the same table as a filter (quick() never
//   says no where match() would say yes), and is matched for real below.
// - For each recipe at each rotation, the generated code is a test of an
//   anchor: every keyed cell's table at its fixed offset from the anchor.
//   The anchors that pass, the candidates, are kept from tick to tick, and
//   only the anchors round the cells a phase rewrote are tested again
//   (incremental matching): a cell whose value changes from one id to
//   another touches only the recipe cells whose tables tell those ids
//   apart. A board that arrives from elsewhere (undo, a level's window
//   following Phibber, a gift placed by a shop) is compared with the last
//   one cell by cell, or, if most of it differs, scanned afresh.
// - What a candidate does depends only on the values in its cells that
//   have variables, its rotation, the key, and the registers its recipe
//   reads: so the outcome (the environment, `where`, the writes) is worked
//   out by terms.js's own match() and evalT() once per such tuple of ids,
//   and remembered (`memo`). The memo forgets itself when a register the
//   recipe reads changes.
// - Then, as matches() does: rules in the order given, rotations 0 to 3,
//   anchors ascending; one match a footprint, the lowest rotation; the
//   dice (hash32) after the footprint; one match per set of writes.
//
// Plain generated JavaScript, not Quilt: what is generated is small and
// flat (offsets and table numbers spliced into tests), so string templates
// say it plainly, and the page needs no wasm to run it.

import { writeQuilt } from "./anchors.js";
import { HOLE, ID, effects, evalT, fill, fit, hasVars, hash32, idOf, intern, match, quick, ruleHash, settleAll } from "./terms.js";

// A recipe cell's offset after k quarter turns clockwise (terms.js's turnOffset).
function turnOffset(x, y, k) {
  for (let i = 0; i < k; i++) [x, y] = [-y, x];
  return [x, y];
}
const trivial = (p) => p.t === "any" || p.t === "keep" || p.t === "var";

// The registers a recipe's templates read: names nothing on its Before side
// binds. A call to a fun may read anything, so then every register counts.
function regReads(w, r) {
  const bound = new Set();
  const binds = (p) => {
    if (!p || typeof p !== "object") return;
    if (p.t === "var" || p.t === "bind") bound.add(p.n);
    if (p.p) binds(p.p);
    for (const a of p.args ?? p.alts ?? p.items ?? []) binds(a);
  };
  binds(r.on);
  for (const cell of r.cellsB) cell.forEach(binds);
  const out = new Set();
  let calls = false;
  const reads = (t) => {
    if (!t || typeof t !== "object") return;
    if (Array.isArray(t)) return t.forEach(reads);
    if (t.t === "var" && !bound.has(t.n)) out.add(t.n);
    if (t.t === "call" && w.funs.has(t.f)) calls = true;
    for (const k of ["e", "c", "a", "b", "p", "args", "items"]) reads(t[k]);
    for (const f of t.fields ?? []) reads(f[1]);
  };
  for (const cell of r.cellsA) cell.forEach(reads);
  reads(r.where);
  if (calls) for (const n of Object.keys(w.regs0 ?? {})) out.add(n);
  return [...out].sort();
}

// A world's recipes compiled. `phase` is terms.js's phase() for this world.
// `write` writes the code: for each recipe at each turn (rks), a test of an
// anchor (its keyed cells' tables, in `order(rk)`) and the key its outcome is
// kept under. It is anchors.js's writeQuilt, expanded from Quilt quotes
// (quilt/anchors.ts.quilt), or one that writes the same.
export function compileWorld(w, write = writeQuilt) {
  return new Compiled(w, write);
}

export class Compiled {
  constructor(w, write = writeQuilt) {
    const t0 = performance.now();
    this.w = w;
    this.write = write;
    const { W, H } = w.level;
    const L = w.L;
    this.W = W;
    this.H = H;
    this.L = L;
    this.N = W * H;
    this.rules = new Map(); // recipe -> its info
    this.rks = []; // one per recipe and rotation
    this.entries = []; // keyed recipe cells: { p, k, l }, a table each
    this.watch = Array.from({ length: L }, () => []); // per layer: entries watching it
    w.recipes.forEach((r, ri) => {
      const info = { r, ri, rks: [], reads: regReads(w, r), sig: null, writes: r.cellsA.some((c) => c.some((t) => t.t !== "keep")), square: r.h === r.wd, hash: ruleHash(r.hashId ?? r.id) };
      this.rules.set(r, info);
      const full = [];
      r.cellsB.forEach((cell, n) => cell.forEach((p, l) => hasVars(w, p) && full.push({ n, l, p })));
      for (let k = 0; k < 4; k++) {
        const offs = [];
        for (let i = 0; i < r.h; i++) for (let j = 0; j < r.wd; j++) offs.push(turnOffset(j, i, k));
        const mx = Math.min(...offs.map((o) => o[0]));
        const my = Math.min(...offs.map((o) => o[1]));
        const relX = offs.map((o) => o[0] - mx);
        const relY = offs.map((o) => o[1] - my);
        const rel = relX.map((x, n) => relY[n] * W + x);
        const rk = { i: this.rks.length, info, k, relX, relY, rel, bw: Math.max(...relX) + 1, bh: Math.max(...relY) + 1, keyed: [], full: full.map((f) => ({ ...f, off: rel[f.n] * L + f.l })), cand: new Set(), list: null, memo: new Map() };
        r.cellsB.forEach((cell, n) =>
          cell.forEach((p, l) => {
            if (trivial(p)) return;
            const e = this.entries.length;
            this.entries.push({ p, k, l, rk, n, relX: relX[n], relY: relY[n], off: rel[n] * L + l });
            this.watch[l].push(e);
            rk.keyed.push(e);
          }),
        );
        info.rks.push(rk);
        this.rks.push(rk);
      }
    });
    this.T = this.entries.map(() => new Uint8Array(256));
    this.pass = Array.from({ length: L }, () => []); // per layer, per id: entries whose table says 1
    this.holey = new Uint8Array(256); // per id: 1 if the value holds a hole, 2 if not
    this.filled = 0; // ids the tables cover
    this.F = [];
    this.ids = new Int32Array(this.N * L);
    this.generate();
    this.cur = null; // the board `ids` describes
    this.fills = new Map(); // a write with holes over an old value -> the value
    this.diffs = Array.from({ length: L }, () => new Map()); // per layer: (old id, new id) -> the entries that tell them apart
    this.stats = { compile: performance.now() - t0, rescans: 0, synced: 0 };
  }

  // The code: for each recipe at each turn, a test of an anchor (its keyed
  // cells' tables, the cells fewest of the board passes first, once a
  // board has been seen: `seen(e)`) and the key its outcome is kept under.
  generate(seen = () => 0) {
    const order = (rk) => [...rk.keyed].sort((a, b) => seen(a) - seen(b));
    this.source = this.write(this.rks, this.entries, this.L, order);
    this.F.length = 0;
    // eslint-disable-next-line no-new-func
    new Function("F", "T", "ids", this.source)(this.F, this.T, this.ids);
  }

  // Tables for every id interned since last time.
  grow() {
    const w = this.w;
    const n = w.values.length;
    if (n <= this.filled) return;
    if (n > this.holey.length) {
      let cap = this.holey.length;
      while (cap < n) cap *= 2;
      // In place: the generated code reads T through the array it was given.
      this.T.forEach((t, e) => {
        const u = new Uint8Array(cap);
        u.set(t);
        this.T[e] = u;
      });
      const h = new Uint8Array(cap);
      h.set(this.holey);
      this.holey = h;
    }
    const { entries, T } = this;
    for (let id = this.filled; id < n; id++) {
      const v = w.values[id];
      for (let l = 0; l < this.L; l++) {
        const on = [];
        for (const e of this.watch[l]) {
          const E = entries[e];
          if (quick(w, E.p, E.k, v)) {
            T[e][id] = 1;
            on.push(e);
          }
        }
        this.pass[l][id] = on;
      }
      this.holey[id] = hasHole(v) ? 1 : 2;
    }
    this.filled = n;
  }

  // The board's ids, and the candidates kept in step with it.
  sync(board) {
    if (board === this.cur) return;
    const { ids } = this;
    const w = this.w;
    if (!this.cur) return this.rescan(board);
    const cur = this.cur;
    const changes = [];
    for (let s = 0; s < board.length; s++) {
      if (board[s] === cur[s]) continue;
      const v = board[s];
      const id = v[ID] ?? idOf(w, v);
      if (id !== ids[s]) {
        // Most of it differs (a window that moved): scan it afresh.
        if (changes.length > board.length / 4) return this.rescan(board);
        changes.push(s, ids[s]);
        ids[s] = id;
      }
    }
    this.grow();
    this.update(changes);
    this.cur = board;
    this.stats.synced++;
  }

  // Every candidate worked out afresh: for each recipe at each turn, the
  // cells of its rarest keyed cell, as matches() picks its key cell.
  rescan(board) {
    this.stats.rescans++;
    const w = this.w;
    const { L, W, H, ids, entries, T } = this;
    for (let s = 0; s < board.length; s++) {
      const v = board[s];
      ids[s] = v[ID] ?? idOf(w, v);
    }
    this.grow();
    // Where each id is, per layer.
    const at = Array.from({ length: L }, () => new Map());
    for (let s = 0; s < ids.length; s++) {
      const m = at[s % L];
      const c = (s - (s % L)) / L;
      const list = m.get(ids[s]);
      if (list) list.push(c);
      else m.set(ids[s], [c]);
    }
    // How many cells each keyed cell's table passes.
    const seen = entries.map((E, e) => {
      let cnt = 0;
      for (const [id, cells] of at[E.l]) if (T[e][id] === 1) cnt += cells.length;
      return cnt;
    });
    // The first board seen orders each test, rarest cell first.
    if (!this.ordered) {
      this.ordered = true;
      this.generate((e) => seen[e]);
    }
    for (const rk of this.rks) {
      rk.cand.clear();
      rk.list = null;
      if (!rk.keyed.length) continue;
      let best = -1;
      let bestN = Infinity;
      for (const e of rk.keyed) {
        if (seen[e] < bestN) {
          bestN = seen[e];
          best = e;
        }
      }
      if (!bestN) continue;
      const E = entries[best];
      const test = this.F[rk.i].test;
      for (const [id, cells] of at[E.l]) {
        if (T[best][id] !== 1) continue;
        for (const c of cells) {
          const x = (c % W) - E.relX;
          const y = (c - (c % W)) / W - E.relY;
          if (x < 0 || y < 0 || x + rk.bw > W || y + rk.bh > H) continue;
          const a = y * W + x;
          if (test(a)) rk.cand.add(a);
        }
      }
    }
    this.cur = board;
  }

  // Slots that changed (pairs: slot, old id; `ids` holds the new): the
  // anchors round them tested again, where a keyed cell's table passes the
  // new id and not the old. An anchor whose cell now fails stays among the
  // candidates until matches() next reads them, which tests each again: so
  // the candidates are always every anchor that passes, and maybe more.
  update(changes) {
    const { L, W, H, ids, entries, F, diffs } = this;
    for (let c = 0; c < changes.length; c += 2) {
      const s = changes[c];
      const was = changes[c + 1];
      const now = ids[s];
      const l = s % L;
      // The entries that pass the new id and not the old (a table never
      // changes once filled, so neither does this): usually none, as when
      // a counter ticks up.
      const dk = was * 67108864 + now;
      let gain = diffs[l].get(dk);
      if (!gain) diffs[l].set(dk, (gain = this.gain(l, was, now)));
      if (!gain.length) continue;
      const cell = (s - l) / L;
      const cx = cell % W;
      const cy = (cell - cx) / W;
      for (const e of gain) {
        const E = entries[e];
        const x = cx - E.relX;
        const y = cy - E.relY;
        const rk = E.rk;
        if (x < 0 || y < 0 || x + rk.bw > W || y + rk.bh > H) continue;
        const a = y * W + x;
        if (!rk.cand.has(a) && F[rk.i].test(a)) {
          rk.cand.add(a);
          rk.list = null;
        }
      }
    }
  }

  // On layer l, the entries whose tables pass `now` and not `was`.
  gain(l, was, now) {
    const { T, pass } = this;
    return pass[l][now].filter((e) => T[e][was] !== 1);
  }

  // A recipe at a turn's candidates, ascending.
  anchors(rk) {
    if (!rk.keyed.length) {
      // Nothing to key on: every anchor that fits.
      if (!rk.list) {
        const out = [];
        for (let y = 0; y + rk.bh <= this.H; y++) for (let x = 0; x + rk.bw <= this.W; x++) out.push(y * this.W + x);
        rk.list = out;
      }
      return rk.list;
    }
    if (!rk.list) rk.list = Int32Array.from(rk.cand).sort();
    // Each tested again: those that fail now go.
    const test = this.F[rk.i].test;
    const list = rk.list;
    let out = null;
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (test(a)) out?.push(a);
      else {
        out ??= Array.from(list.subarray(0, i));
        rk.cand.delete(a);
      }
    }
    if (out) rk.list = Int32Array.from(out);
    return rk.list;
  }

  // terms.js's matches(), compiled: the same matches in the same order.
  matches(board, rules, input, ctx) {
    const w = this.w;
    const L = this.L;
    const out = [];
    const regsNow = w.regsNow ?? {};
    const inputKey = input ? `${input.a[0]},${input.a[1]}` : "";
    for (const r of rules) {
      const info = this.rules.get(r);
      if (!info.writes) continue;
      // The memo holds while the registers the recipe reads (and the key) do.
      const sig = info.reads.map((n) => `${regsNow[n] ?? w.regs0?.[n]}`).join(",") + (r.on ? `|${inputKey}` : "");
      if (sig !== info.sig) {
        info.sig = sig;
        for (const rk of info.rks) rk.memo.clear();
      }
      const nc = r.cellsB.length;
      const feet = new Set();
      const sigs = new Set();
      const chance = r.chance == null ? null : (typeof r.chance === "string" ? +(regsNow[r.chance] ?? 0) : r.chance) / 100;
      for (const rk of info.rks) {
        const k = rk.k;
        const env0 = {};
        if (r.on) {
          if (!input || !match(w, r.on, input, k, env0)) continue;
        }
        const list = this.anchors(rk);
        if (!list.length) continue;
        const key = this.F[rk.i].key;
        const memo = rk.memo;
        for (let ai = 0; ai < list.length; ai++) {
          const a = list[ai];
          const mk = key(a);
          let res = memo.get(mk);
          if (res === undefined) {
            res = this.outcome(rk, board, a, env0);
            memo.set(mk, res);
          }
          if (!res) continue;
          const foot = a * 2 + (info.square ? 0 : k & 1);
          if (feet.has(foot)) continue;
          feet.add(foot);
          if (chance != null && hash32(ctx.seed ?? 0, ctx.tick ?? 0, info.hash, foot) >= chance) continue;
          const proto = res.writes ?? this.writesOf(rk, res);
          const cells = new Array(nc);
          for (let n = 0; n < nc; n++) cells[n] = a + rk.rel[n];
          const writes = new Array(proto.length);
          for (let j = 0; j < proto.length; j++) {
            const p = proto[j];
            const i = cells[p.n];
            writes[j] = { i, n: p.n, l: p.l, s: i * L + p.l, v: p.v, id: p.id };
          }
          const sg = writes.length === 1 ? `${writes[0].s}=${writes[0].id}` : writes.map((x) => `${x.s}=${x.id}`).sort().join(";");
          if (sigs.has(sg)) continue;
          sigs.add(sg);
          const moved = r.moves.map(([f, p, t, pt]) => ({ from: [cells[f], p], to: [cells[t], pt] }));
          out.push({ r, k, cells, writes, env: res.env, moves: moved, foot });
        }
      }
    }
    return out;
  }

  // Whether a candidate matches, by its cells with variables: the
  // environment if it does (and `where` holds), else false.
  outcome(rk, board, a, env0) {
    const w = this.w;
    const L = this.L;
    const r = rk.info.r;
    const env = { ...env0 };
    for (const f of rk.full) if (!match(w, f.p, board[(a + rk.rel[f.n]) * L + f.l], rk.k, env)) return false;
    if (r.where && !evalT(w, r.where, env, rk.k)) return false;
    return { env: Object.freeze(env), writes: null };
  }

  // A matching outcome's writes, worked out when first needed (after the
  // dice, as matches() does), each cell layer its template doesn't keep.
  writesOf(rk, res) {
    const w = this.w;
    const r = rk.info.r;
    const out = [];
    r.cellsA.forEach((cell, n) =>
      cell.forEach((tc, l) => {
        if (tc.t === "keep") return;
        const v = intern(w, fit(w, w.cellTypes[l], evalT(w, tc, res.env, rk.k), `recipe ${r.id}`));
        out.push({ n, l, v, id: v[ID] });
      }),
    );
    res.writes = out;
    return out;
  }

  // terms.js's apply(), remembering what a write with holes makes of each
  // value it lands on, and keeping `ids` and the candidates in step.
  apply(board, won) {
    const w = this.w;
    const { ids } = this;
    const next = board.slice();
    // The slots written this phase, stamped.
    this.stamp ??= new Int32Array(ids.length);
    const done = this.stamp;
    const now = (this.stampNow = ((this.stampNow ?? 0) + 1) | 0);
    const changes = [];
    for (const m of won) {
      for (const x of m.writes) {
        if (done[x.s] === now) continue;
        done[x.s] = now;
        let v = x.v;
        if (this.holey[x.id] !== 2) {
          const old = ids[x.s];
          const mk = x.id * 67108864 + old;
          v = this.fills.get(mk);
          if (!v) {
            v = intern(w, fill(w, x.v, board[x.s], w.cellTypes[x.l]));
            this.fills.set(mk, v);
          }
        }
        next[x.s] = v;
        const id = v[ID];
        if (id !== ids[x.s]) {
          changes.push(x.s, ids[x.s]);
          ids[x.s] = id;
        }
      }
    }
    this.grow();
    this.update(changes);
    this.cur = next;
    return next;
  }

  // terms.js's phase() for this world.
  phase(board, rules, input, ctx, regs) {
    this.sync(board);
    const all = settleAll(this.matches(board, rules, input, ctx));
    return { ...all, board: all.won.length ? this.apply(board, all.won) : board, regs: effects(this.w, all.won, regs) };
  }

  // Whether this compiled code is for these rules on this board.
  fits(board, rules) {
    return board.length === this.N * this.L && rules.every((r) => this.rules.has(r));
  }
}

const hasHole = (v) => v === HOLE || (!!v && typeof v === "object" && Array.isArray(v.a) && v.a.some(hasHole));

// Gives a world compiled code (Run's `compile` option takes this).
export function useCompiled(w) {
  w.compiled = compileWorld(w);
  return w;
}
