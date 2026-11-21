// The board as a world a renderer draws (board.js in 2D, or a host's own
// in 3D). Nothing here decides anything; terms.js runs the world and this
// says, for each state, which kinds stand where, facing
// which way, and which thing is which from one tick to the next (so a thing
// that moved glides, Phibber hops, a new thing pops up, a gone one sinks).
//
// A cell is one value; what it looks like is the world's `look ... model`
// lines, which stack models with `/`, bottom first:
//
//   look Grass model "grass"          a ground kind
//   look Frog  model "frog"           an item kind
//   look Loose model "{what}"         the model of field `what`'s value
//   look On    model "{floor}/{thing}"  field floor's model, thing's on it
//   look Cart  model "cart/{load}"    a cart, carrying its load
//   look Paint model "{c: grass trail ash nest}"   a Nat field picks a word
//   look Alive model "grass/tree"     two words, one on the other
//
// The first model in the stack is the ground; after it, ground that moves (a
// cart, a lily pad, a raft) rides on the ground before it, and anything else
// is the item. `none` is nothing, and so is a nested value with no model
// that is its type's first constructor without fields (Empty); any other
// value with no model is drawn as a kind with no model is (a labelled tile
// or crate). The first Dir field of a value is the way
// it faces, and what it holds faces that way too unless it has its own.

import { DIRS } from "./syntax.js";
import { enumerate, goalHolds, key } from "./terms.js";

const FROG = "frog";
// Ground with a model that moves, over the tile under it (a 3D renderer
// keeps the same table; this file runs in node too).
export const MOVING_GROUND = { raft: "water", cart: "rail", lily: "water", mole: "grass" };

// A Nat field's word ({c: grass trail ash nest}) or a field's model ({what}),
// filled into model text m for value v.
function fillText(w, v, m) {
  const fields = w.cons.get(v.c)?.fields ?? [];
  return m.replace(/\{(\w+)(?::([^}]*))?\}/g, (_, name, words) => {
    const n = fields.findIndex((f) => f.name === name);
    if (n < 0) return "";
    const a = v.a[n];
    if (words != null) return words.trim().split(/\s+/)[typeof a === "number" ? a : 0] ?? "";
    return parts(w, a, [], -1, true)
      .filter((p) => !p.blank)
      .map((p) => p.word)
      .join("/");
  });
}

// Value v's models, bottom first: { word, d, path }, d the way it faces and
// path the field indices from the cell's value to the value it is the model
// of, so a move that names that value (terms.js) can find it. A nested
// type's blank first value is `blank`: nothing, unless it is the ground.
function parts(w, v, path = [], face = -1, nested = false) {
  if (v === null || typeof v !== "object" || v.c === "None") return [];
  // T? is sugar: Some(x) draws as x.
  if (v.c === "Some" && !w.looks.Some) return parts(w, v.a[0], [...path, 0], face, nested);
  const own = faceOf(w, v);
  const d = own >= 0 ? own : face;
  const m = w.looks[v.c]?.model;
  if (m == null) {
    const T = w.cons.get(v.c)?.type;
    const blank = nested && T?.cons[0]?.c === v.c && !T.cons[0].fields.length;
    return [{ word: v.c.toLowerCase(), d, path, blank }];
  }
  const fields = w.cons.get(v.c)?.fields ?? [];
  const out = [];
  for (const seg of m.split("/")) {
    const ref = /^\s*\{(\w+)\}\s*$/.exec(seg);
    const n = ref ? fields.findIndex((f) => f.name === ref[1]) : -1;
    if (n >= 0) out.push(...parts(w, v.a[n], [...path, n], d, true));
    else for (const word of fillText(w, v, seg).split("/")) if (word.trim()) out.push({ word: word.trim(), d, path });
  }
  return out;
}

// The same for a constructor expression in a recipe, whose fields may be
// patterns: {model, d, used}, with what it can't know left out (Cart(d, c)
// is a cart with no load drawn), `used` the fields the model shows, and d
// its facing if a Dir field is a literal. Null if it has no model.
export function exprModel(w, e, role) {
  const text = exprText(w, e);
  if (text == null) return null;
  const words = text.split("/").map((t) => t.trim() || null);
  let g = null;
  let i = null;
  if (words.length > 1) {
    g = words[0];
    for (const word of words.slice(1)) if (word && MOVING_GROUND[word]) g = word;
    else if (word) i = word;
  } else if (role === "tile" || MOVING_GROUND[words[0]]) g = words[0];
  else i = words[0];
  if (!g && !i) return null;
  const fields = w.cons.get(e.c)?.fields ?? [];
  const n = fields.findIndex((f) => f.type.k === "Dir");
  const a = e.args[n];
  const d = n >= 0 && a?.t === "lit" ? DIRS.indexOf(a.v) : -1;
  const used = new Set();
  const m = w.looks[e.c].model;
  for (const [, name] of m.matchAll(/\{(\w+)/g)) used.add(name);
  return { g, i, d, used };
}

function exprText(w, e) {
  if (e?.t === "bind") return exprText(w, e.p);
  if (!e || e.t !== "con") return null;
  const m = w.looks[e.c]?.model;
  if (m == null) return null;
  const fields = w.cons.get(e.c)?.fields ?? [];
  return m.replace(/\{(\w+)(?::([^}]*))?\}/g, (_, name, words) => {
    const n = fields.findIndex((f) => f.name === name);
    const a = e.args[n];
    if (!a) return "";
    if (words != null) return a.t === "lit" && typeof a.v === "number" ? (words.trim().split(/\s+/)[a.v] ?? "") : "";
    return exprText(w, a) ?? "";
  });
}

// The way value v faces: its first Dir field, as 0-3 (N E S W), or -1. A
// Dir? field counts too (a river's flow, a road's way): Some(d) faces d.
const isDir = (ty) => ty.k === "Dir" || (ty.k === "opt" && ty.of?.k === "Dir");
function faceOf(w, v) {
  if (!v || typeof v !== "object") return -1;
  const n = (w.cons.get(v.c)?.fields ?? []).findIndex((f) => isDir(f.type));
  if (n < 0) return -1;
  const d = v.a[n];
  return DIRS.indexOf(d?.c === "Some" ? d.a[0] : d);
}

// A cell's value as {g, i, d, o, under}: its ground kind and facing, its
// item kind (or null) and facing, and for ground that moves the ground under
// it.
export const cellModel = (w, v) => cellLayout(w, v).m;

// Cell i of a board: its value, or in a world of layers (cell Ground /
// Item) its layers' values, ground first.
export const cellAt = (w, board, i) => (w.L > 1 ? board.slice(i * w.L, (i + 1) * w.L) : board[i]);

// A cell's models: its value's, or its layers' in order, each path starting
// with its layer, and a later layer's blank value (Empty) drawn as nothing.
const cellParts = (w, v) => (Array.isArray(v) ? v.flatMap((x, l) => parts(w, x, [l], -1, l > 0)) : parts(w, v));

// The same, with the paths (see parts()) of the ground and the item.
function cellLayout(w, v) {
  const m = { g: "grass", i: null, d: -1, o: -1, under: null };
  let gp = null;
  let ip = null;
  cellParts(w, v).forEach((p, k) => {
    if (p.blank && k > 0) return;
    if (k === 0 || MOVING_GROUND[p.word]) {
      if (k > 0) m.under = m.g;
      m.g = p.word;
      m.d = p.d;
      gp = p.path;
    } else {
      m.i = p.word;
      m.o = p.d;
      ip = p.path;
    }
  });
  if (MOVING_GROUND[m.g] && !m.under) m.under = MOVING_GROUND[m.g];
  if (m.under === m.g) m.under = null;
  return { m, gp, ip };
}

const isPrefix = (p, q) => p.length <= q.length && p.every((x, i) => x === q[i]);

// One level's worth of states as worlds a renderer draws. Ids carry on from a
// state to the one stepped from it. Where a recipe said what went where (a
// variable on both sides: terms.js's moves), that is so, even for two equal
// things trading places. Where it didn't, the board guesses: a thing gone
// from a cell a recipe touched, and the same kind of thing new in a cell the
// same recipe touched, is the same thing, moved.
export class View {
  constructor(w) {
    this.w = w;
    this.kinds = { g: ["grass"], i: ["none"] };
    this.nextId = 1;
    this.cache = new WeakMap();
    this.goals = w.level.goals.map((g) => goalLook(w, g));
  }

  index(layer, name) {
    let n = this.kinds[layer].indexOf(name);
    if (n < 0) n = this.kinds[layer].push(name) - 1;
    return n;
  }

  // The world for `state`; `prev` is the state it was stepped from, if it was.
  worldOf(state, prev = null, input = null) {
    const hit = this.cache.get(state);
    if (hit) return hit;
    const { W, H } = this.w.level;
    const N = W * H;
    const a = {
      W, H, N,
      kinds: this.kinds,
      g: new Uint8Array(N), gd: new Int8Array(N).fill(-1), gc: new Int16Array(N), gid: new Int32Array(N),
      it: new Uint8Array(N), io: new Int8Array(N).fill(-1), ic: new Int16Array(N), iid: new Int32Array(N),
      under: new Array(N).fill(null),
      gpath: new Array(N).fill(null), ipath: new Array(N).fill(null),
      tick: state.tick,
      goals: this.goals,
      fired: {},
      events: [],
      rules: [],
    };
    const moving = [];
    const items = [];
    for (let i = 0; i < N; i++) {
      const { m, gp, ip } = cellLayout(this.w, cellAt(this.w, state.board, i));
      a.gpath[i] = gp;
      a.ipath[i] = ip;
      a.g[i] = this.index("g", m.g);
      a.gd[i] = m.d;
      a.under[i] = m.under;
      if (MOVING_GROUND[m.g]) moving.push(i);
      // Ground that stays put is known by its cell.
      else a.gid[i] = -1 - i;
      if (m.i) {
        a.it[i] = this.index("i", m.i);
        a.io[i] = m.o;
        items.push(i);
      }
    }
    let before = prev && this.cache.get(prev);
    // An endless level's window moved this tick (run.js): what was drawn
    // before, in the new window's cells, so things keep who they are.
    if (before && state.shift) before = shifted(before, state.shift);
    const fired = state.fired ?? [];
    const moves = state.moves ?? [];
    this.carry(before, a, "g", "gid", moving, fired, moves);
    this.carry(before, a, "it", "iid", items, fired, moves);
    if (input) a.events.push({ key: DIRS.indexOf(input.d) });
    for (const m of fired) {
      a.fired[m.r.id] = (a.fired[m.r.id] ?? 0) + 1;
      a.events.push({ rule: m.r.id, cells: m.cells });
    }
    a.met = this.w.level.goals.map((g) => goalHolds(this.w, state, g));
    this.cache.set(state, a);
    return a;
  }

  // Gives each thing in `cells` (layer `kindOf`, ids in `ids`) the id it had
  // in `before`, or a new one.
  carry(before, a, kindOf, ids, cells, fired, moves = []) {
    const name = (w, i) => w.kinds[kindOf === "g" ? "g" : "i"][w[kindOf][i]];
    const paths = kindOf === "g" ? "gpath" : "ipath";
    const open = new Set(cells);
    const left = new Map(); // cell -> id, the things of before not yet found
    if (before) {
      for (let i = 0; i < before.N; i++) {
        const id = before[ids][i];
        if (kindOf === "it" ? before.it[i] : id > 0) left.set(i, id);
      }
      // Said by a recipe: the value it named, written here. The longest
      // named value holding the thing says.
      for (const mv of [...moves].sort((x, y) => y.to[1].length - x.to[1].length)) {
        const [i, to] = mv.to;
        const path = a[paths][i];
        if (!open.has(i) || !path || !isPrefix(to, path)) continue;
        const [j, from] = mv.from;
        const want = [...from, ...path.slice(to.length)].join(",");
        if (!left.has(j) || before[paths][j]?.join(",") !== want) continue;
        a[ids][i] = left.get(j);
        left.delete(j);
        open.delete(i);
      }
      // Still there: the same kind in the same cell.
      for (const i of cells) {
        if (left.has(i) && name(before, i) === name(a, i)) {
          a[ids][i] = left.get(i);
          left.delete(i);
          open.delete(i);
        }
      }
      // Moved by a recipe: gone from one of its cells, new in another.
      for (const m of fired) {
        for (const i of m.cells) {
          if (!open.has(i)) continue;
          const from = m.cells.find((j) => left.has(j) && name(before, j) === name(a, i));
          if (from == null) continue;
          a[ids][i] = left.get(from);
          left.delete(from);
          open.delete(i);
        }
      }
      // Changed where it stands: the same thing, now something else.
      for (const i of [...open]) {
        if (!left.has(i)) continue;
        a[ids][i] = left.get(i);
        left.delete(i);
        open.delete(i);
      }
    }
    for (const i of open) a[ids][i] = this.nextId++;
  }
}

// A drawn world as seen from a window moved by (sx, sy) cells: each cell
// where it is in the new window; what fell off it, gone.
function shifted(a, { sx, sy }) {
  const { W, H, N } = a;
  const out = { ...a };
  for (const k of ["g", "gd", "gc", "gid", "it", "io", "ic", "iid", "under", "gpath", "ipath"]) {
    const from = a[k];
    const to = Array.isArray(from) ? new Array(N).fill(null) : new from.constructor(N);
    if (k === "gd" || k === "io") to.fill(-1);
    for (let i = 0; i < N; i++) {
      const x = (i % W) - sx;
      const y = Math.floor(i / W) - sy;
      if (x >= 0 && y >= 0 && x < W && y < H) to[y * W + x] = from[i];
    }
    out[k] = to;
  }
  return out;
}

// A goal as a renderer marks it: a lotus at its cell, with a ghost of the
// thing it wants there (none for Phibber himself). What it wants is the item
// of the first value that would meet it, on the ground the cell starts with
// if one does.
function goalLook(w, g) {
  const { W } = w.level;
  const at = g.y * W + g.x;
  // The ground's own value, by its path (Plate(Stone), not just "grass").
  const groundOf = (v) => {
    let x = v;
    for (const n of cellLayout(w, v).gp ?? []) x = Array.isArray(x) ? x[n] : x?.a?.[n];
    return key(x);
  };
  const start = cellAt(w, w.level.cells, at);
  const ground = groundOf(start);
  // What could stand there: every value of the cell, or, in a world of
  // layers, every value of the top layer over the ground it starts with.
  const top = w.L > 1 ? w.cellTypes[w.L - 1] : w.cellType;
  const cands = (enumerate(w, top, 4096) ?? []).map((v) => (w.L > 1 ? [...start.slice(0, -1), v] : v));
  let want;
  for (const v of cands) {
    const board = [];
    if (w.L > 1) v.forEach((x, l) => (board[at * w.L + l] = x));
    else board[at] = v;
    if (!goalHolds(w, { board }, g)) continue;
    const m = cellModel(w, v);
    want ??= m.i;
    if (groundOf(v) === ground) {
      want = m.i;
      break;
    }
  }
  return { x: g.x, y: g.y, i: want && want !== FROG ? want : null };
}
