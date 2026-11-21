// Phib, the engine. A world is a grid of values of the
// datatype its `cell` line names, one value a cell, and recipes are rewrite
// rules on rectangles of cells, matched in all four rotations: patterns on
// the Before side, terms on the After side. Ground and what stands on it are
// nothing the engine knows: a type says it (On(floor: Floor, thing: Thing?)),
// so a Rock with no fields can hold nothing, and no rule has to say so. This is the interpreter wiki/Phibber Terms.md plans; the
// text it reads is syntax.js's, and the pictures are picture.js's.
//
// Values are plain JS: a Nat is a number, a Bool a boolean, a Dir one of
// "N" "E" "S" "W", and a constructor is { c, a: [fields] }, tuples too
// (c is "(,)", "(,,)", …). An optional value is the prelude's Option:
// None, or Some(v); `T?` and `none` are only sugar for Option<T> and None.
// A write may hold holes ({ hole: true }): keep that field from the board.

import { DIRS, isTuple, parse, printCell, printExpr, printType, printValue, tupleName } from "./syntax.js";
import { blob, hash, vnoise } from "./noise.js";

export const HOLE = Object.freeze({ hole: true });

export class WorldError extends Error {
  constructor(msg, line) {
    super(line != null ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

// ---- values ----

export function key(v) {
  if (v === null) return "~";
  if (typeof v !== "object") return String(v);
  if (v.hole) return "*";
  if (isTuple(v.c)) return `(${v.a.map(key).join(",")})`;
  return v.a.length ? `${v.c}(${v.a.map(key).join(",")})` : v.c;
}
export const eq = (a, b) => a === b || key(a) === key(b);

export const turnDir = (d, k) => DIRS[(DIRS.indexOf(d) + (((k % 4) + 4) % 4)) % 4];

// ---- types ----
//
// A type is { k: "Bool" | "Dir" | "Nat" (n) | "Int" (lo, hi) | "user" (name, args) | "var"
// (name) | "opt" (of) }. "opt" is how `T?` is written; norm() makes it the
// Option<T> it means. A user type is a sum of constructors, each a product
// of fields, and may take parameters (type Box<a> = Box(a)) and contain
// itself (type Stack = Empty | Push(top: Thing, rest: Stack)).

export const OPTION = "Option";

// The types every world has: Option, tuples up to 6, and the key press.
const PRELUDE = `
type Option<a> = None | Some(value: a)
type Input = Key(d: Dir, far: Bool)
`;
const TUPLES = 6;

export function norm(ty) {
  if (ty.k === "opt") return { k: "user", name: OPTION, args: [norm(ty.of)] };
  if (ty.k === "user") return { k: "user", name: ty.name, args: (ty.args ?? []).map(norm) };
  return ty;
}

const typeName = (ty) => printType(ty);

const isOption = (ty) => ty?.k === "user" && ty.name === OPTION;
const isOptionValue = (v) => !!v && typeof v === "object" && (v.c === "None" || v.c === "Some");

// Type ty with its type variables replaced from `sub` (a Map); a variable
// with no entry stays a variable: a type not known here.
function subst(ty, sub) {
  if (ty.k === "var") return sub.get(ty.name) ?? ty;
  if (ty.k === "user" && ty.args.length) return { k: "user", name: ty.name, args: ty.args.map((a) => subst(a, sub)) };
  return ty;
}

// The types of constructor c's fields, as a value of type ty (ty may be
// unknown: null, or a var).
export function fieldTypes(w, c, ty = null) {
  const con = w.cons.get(c);
  if (!con) return [];
  const T = con.type;
  const sub = new Map();
  if (ty?.k === "user" && ty.name === T.name) T.params.forEach((p, i) => ty.args[i] && sub.set(p, ty.args[i]));
  return con.fieldsN.map((f) => subst(f.type, sub));
}

// Every value of a type, or null if there are more than `cap` (or
// infinitely many, or the type isn't known).
function enumerate(w, ty, cap = 4096, inside = []) {
  ty = norm(ty);
  if (ty.k === "Bool") return [false, true];
  if (ty.k === "Dir") return [...DIRS];
  if (ty.k === "Nat") return ty.n <= cap ? Array.from({ length: ty.n }, (_, i) => i) : null;
  if (ty.k === "Int") return ty.hi - ty.lo + 1 <= cap ? Array.from({ length: ty.hi - ty.lo + 1 }, (_, i) => ty.lo + i) : null;
  if (ty.k !== "user") return null;
  if (inside.includes(ty.name)) return null; // it contains itself
  const T = w.types.get(ty.name);
  const out = [];
  for (const con of T.cons) {
    let combos = [[]];
    for (const fty of fieldTypes(w, con.c, ty)) {
      const vs = enumerate(w, fty, cap, [...inside, ty.name]);
      if (!vs) return null;
      combos = combos.flatMap((c) => vs.map((v) => [...c, v]));
      if (combos.length + out.length > cap) return null;
    }
    for (const a of combos) out.push({ c: con.c, a });
  }
  return out;
}

// The first value of a type: what a hole becomes if the board's value has no
// such field. For a type that contains itself, its first constructor that
// doesn't (build() finds it: T.base), so the value is finite.
function defaultOf(w, ty) {
  ty = norm(ty);
  if (ty.k === "Bool") return false;
  if (ty.k === "Dir") return "N";
  if (ty.k === "Nat") return 0;
  if (ty.k === "Int") return Math.max(ty.lo, Math.min(ty.hi, 0));
  if (ty.k !== "user") return false; // a type not known here: never written
  const T = w.types.get(ty.name);
  const con = T.cons[T.base];
  return { c: con.c, a: fieldTypes(w, con.c, ty).map((f) => defaultOf(w, f)) };
}

// Rotation acts on values: a quarter turn on Dir, a type's own `rotates` on
// its constructors, and field by field on everything else.
export function rot(w, v, k) {
  k = ((k % 4) + 4) % 4;
  if (k === 0 || v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return turnDir(v, k);
  if (v.hole) return v;
  const con = w.cons.get(v.c);
  let c = v.c;
  const R = con?.type.rotates;
  if (R) for (let i = 0; i < k; i++) c = R[c] ?? c;
  return { c, a: v.a.map((x) => rot(w, x, k)) };
}

// A value made to fit its type, all the way down: a Nat clamped to 0..n-1,
// as counters saturate, and a T where a T? goes made Some(T), the sugar's
// one rule. Anything else that doesn't fit is an error.
export function fit(w, ty, v, where) {
  if (v === HOLE) return v;
  ty = ty.k === "opt" ? norm(ty) : ty;
  switch (ty.k) {
    case "Nat":
      if (typeof v !== "number") throw new WorldError(`${where}: wanted a number, got ${printValue(v)}`);
      return Math.max(0, Math.min(ty.n - 1, Math.trunc(v)));
    case "Int":
      if (typeof v !== "number") throw new WorldError(`${where}: wanted a number, got ${printValue(v)}`);
      return Math.max(ty.lo, Math.min(ty.hi, Math.trunc(v)));
    case "Bool":
      if (typeof v !== "boolean") throw new WorldError(`${where}: wanted true or false, got ${printValue(v)}`);
      return v;
    case "Dir":
      if (!DIRS.includes(v)) throw new WorldError(`${where}: wanted a direction, got ${printValue(v)}`);
      return v;
    case "user": {
      if (ty.name === OPTION) {
        if (v === null) return NONE;
        if (!isOptionValue(v)) return { c: "Some", a: [fit(w, ty.args[0] ?? VAR, v, where)] };
      }
      if (!v || typeof v !== "object" || w.cons.get(v.c)?.type.name !== ty.name) throw new WorldError(`${where}: wanted ${aType(ty)}, got ${printValue(v)}`);
      const fts = fieldTypes(w, v.c, ty);
      let a = null;
      for (let i = 0; i < v.a.length; i++) {
        const x = fit(w, fts[i], v.a[i], where);
        if (x !== v.a[i]) (a ??= [...v.a])[i] = x;
      }
      return a ? { c: v.c, a } : v;
    }
  }
  return v;
}

const VAR = Object.freeze({ k: "var", name: "?" });
const NONE = Object.freeze({ c: "None", a: Object.freeze([]) });
const aType = (ty) => (isTuple(ty.name) ? `a tuple ${typeName(ty)}` : `a ${typeName(ty)}`);

// ---- building a world ----

// A world from its source text: its types, cell type, named patterns, functions,
// looks, recipes and level, all checked.
export function compile(src) {
  return build(parse(src));
}

// One level of a file as a world of its own: the file's declarations and
// the level's, a type's `+=` folded into it, a pattern's `+=` added as
// alternatives, a later recipe with an earlier one's id in its place, and
// what `use … except` drops left out.
export function flatten(ast, which = 0) {
  const levels = ast.levels?.length ? ast.levels : [ast.level];
  const L = typeof which === "number" ? levels[which] : levels.find((l) => l.id === which);
  if (!L) throw new WorldError(`no level ${which}`);
  const parts = L === ast ? [ast] : [ast, L];
  const all = (key) => parts.flatMap((x) => x[key] ?? []);
  const types = [];
  for (const T of all("types")) {
    if (!T.extend) {
      types.push({ ...T, cons: [...T.cons] });
      continue;
    }
    const base = types.find((x) => x.name === T.name);
    if (!base) throw new WorldError(`type ${T.name} += …: there's no type ${T.name} before it`, T.line);
    base.cons.push(...T.cons);
  }
  const patterns = [];
  for (const P of all("patterns")) {
    const i = patterns.findIndex((x) => x.name === P.name);
    if (P.extend) {
      if (i < 0) throw new WorldError(`pattern ${P.name} ${P.extend}= …: there's no pattern ${P.name} before it`, P.line);
      // p -= q is p and not q: !(!p | q).
      const p = P.extend === "-" ? { t: "not", p: { t: "or", alts: [{ t: "not", p: patterns[i].p }, P.p] } } : { t: "or", alts: [patterns[i].p, P.p] };
      patterns[i] = { ...patterns[i], p };
    } else if (i >= 0) patterns[i] = P;
    else patterns.push(P);
  }
  const recipes = [];
  for (const r of all("recipes")) {
    const i = recipes.findIndex((x) => x.id === r.id);
    if (i >= 0) recipes[i] = r;
    else recipes.push(r);
  }
  const drop = new Set(all("drop"));
  const regs = {};
  for (const g of all("regs")) regs[g.name] = g.v;
  return {
    ...ast,
    cell: L.cell ?? ast.cell,
    types,
    patterns,
    funs: all("funs"),
    looks: Object.assign({}, ...parts.map((x) => x.looks ?? {})),
    recipes: recipes.filter((r) => !drop.has(r.id)),
    regs: Object.entries(regs).map(([name, v]) => ({ name, v })),
    legend: all("legend"),
    // The level's own declarations are the file's now.
    level: { ...L, types: [], patterns: [], funs: [], looks: {}, recipes: [], regs: [], legend: [], drop: [] },
    // Flat: built again, it is this level and nothing else.
    levels: [],
  };
}

export function build(ast, which = 0) {
  const file = ast;
  ast = flatten(ast, which);
  const w = { ast: file, flat: ast, types: new Map(), cons: new Map(), patterns: new Map(), funs: new Map(), looks: ast.looks, recipes: [], regs0: Object.fromEntries(ast.regs.map((g) => [g.name, g.v])) };
  const declare = (T, prelude) => {
    if (w.types.has(T.name) || ["Bool", "Dir", "Nat", "Int"].includes(T.name)) throw new WorldError(`type ${T.name} is declared ${prelude ? "already: it comes with every world" : "twice"}`, T.line);
    const type = { name: T.name, params: T.params ?? [], cons: T.cons, rotates: T.rotates, prelude };
    w.types.set(T.name, type);
    for (const con of T.cons) {
      if (w.cons.has(con.c)) throw new WorldError(`constructor ${con.c} is declared ${w.cons.get(con.c).type.prelude ? "already: it comes with every world" : "twice"}`, T.line);
      const names = new Set();
      for (const f of con.fields) {
        if (names.has(f.name)) throw new WorldError(`${con.c} has two fields called ${f.name}`, T.line);
        names.add(f.name);
      }
      w.cons.set(con.c, { ...con, fieldsN: con.fields.map((f) => ({ ...f, type: norm(f.type) })), type });
    }
  };
  for (const T of parse(PRELUDE).types) declare(T, true);
  for (let n = 2; n <= TUPLES; n++) {
    const params = Array.from({ length: n }, (_, i) => `t${i}`);
    declare({ name: tupleName(n), params, cons: [{ c: tupleName(n), fields: params.map((p, i) => ({ name: String(i), type: { k: "var", name: p } })) }], rotates: null }, true);
  }
  // A world that says Input itself (as the tests' worlds may) means the prelude's.
  for (const T of ast.types) {
    if (T.name === "Input" && T.cons.length === 1 && T.cons[0].c === "Key") continue;
    declare(T, false);
  }
  const checkType = (ty, line, params = null) => {
    if (ty.k === "opt") return checkType(ty.of, line, params);
    if (ty.k === "var") {
      if (params && !params.includes(ty.name)) throw new WorldError(`no type parameter ${ty.name}`, line);
      return;
    }
    if (ty.k !== "user") return;
    if (isTuple(ty.name) && ty.args.length > TUPLES) throw new WorldError(`a tuple has at most ${TUPLES} parts`, line);
    const T = w.types.get(ty.name);
    if (!T) throw new WorldError(`no type ${ty.name}`, line);
    const n = ty.args?.length ?? 0;
    if (n !== T.params.length) throw new WorldError(T.params.length ? `${ty.name} takes ${T.params.length} type${T.params.length === 1 ? "" : "s"}, like ${ty.name}<${T.params.join(", ")}>` : `${ty.name} takes no types`, line);
    for (const a of ty.args ?? []) checkType(a, line, params);
  };
  for (const T of ast.types) {
    for (const con of T.cons) for (const f of con.fields) checkType(f.type, T.line, T.params ?? []);
    if (T.rotates) {
      for (const [a, b] of Object.entries(T.rotates)) {
        if (w.cons.get(a)?.type.name !== T.name || w.cons.get(b)?.type.name !== T.name) throw new WorldError(`${T.name} rotates only its own constructors`, T.line);
        if (w.cons.get(a).fields.length || w.cons.get(b).fields.length) throw new WorldError(`${T.name} rotates only constructors without fields`, T.line);
      }
      for (const con of T.cons) {
        let c = con.c;
        for (let i = 0; i < 4; i++) c = T.rotates[c] ?? c;
        if (c !== con.c) throw new WorldError(`four turns of ${con.c} must be ${con.c}, not ${c}`, T.line);
      }
    }
  }
  // A type may contain itself, but it must have a finite value: some
  // constructor whose fields all do (a type parameter counts as having
  // one). Each type's base is the first such constructor, found in order of
  // how deep its smallest value is, so defaultOf() always ends.
  const finite = (ty) => ty.k !== "user" || w.types.get(ty.name).base != null;
  for (let more = true; more; ) {
    more = false;
    const found = [];
    for (const T of w.types.values()) {
      if (T.base != null) continue;
      const i = T.cons.findIndex((con) => w.cons.get(con.c).fieldsN.every((f) => finite(f.type)));
      if (i >= 0) found.push([T, i]);
    }
    for (const [T, i] of found) T.base = i;
    more = found.length > 0;
  }
  for (const T of ast.types) {
    if (w.types.get(T.name).base == null) throw new WorldError(`type ${T.name} has no finite value: give it a constructor that doesn't contain ${T.name}, like Empty`, T.line);
  }

  if (!ast.cell) throw new WorldError("the world needs a `cell` line naming the type of its cells, like: cell Tile");
  // A cell is one value, or (cell Ground / Item) one value per layer. Each
  // layer of each cell is claimed on its own when recipes settle.
  w.layers = Array.isArray(ast.cell) ? ast.cell : [ast.cell];
  for (const name of w.layers) {
    if (!w.types.has(name)) throw new WorldError(`the cell's type ${name} is no type`);
    if (w.types.get(name).params.length) throw new WorldError(`the cell's type ${name} takes types: name one that doesn't`);
  }
  w.L = w.layers.length;
  w.cell = w.layers.join(" / ");
  w.cellTypes = w.layers.map((name) => ({ k: "user", name, args: [] }));
  w.cellType = w.cellTypes[0];
  // Interned values: every distinct layer value on a board is one object
  // with a small id (see intern()).
  w.interned = new Map();
  w.values = [];

  for (const f of ast.funs) {
    if (w.funs.has(f.name) || BUILTINS[f.name]) throw new WorldError(`fun ${f.name} is declared twice`, f.line);
    for (const t of [...f.args, f.ret]) checkType(t, f.line);
    f.argsN = f.args.map(norm);
    f.retN = norm(f.ret);
    w.funs.set(f.name, f);
  }
  for (const P of ast.patterns) w.patterns.set(P.name, null);
  for (const P of ast.patterns) w.patterns.set(P.name, pattern(w, P.p, P.line));
  w.patternTypes = new Map([...w.patterns].map(([n, p]) => [n, patternType(w, p)]));
  for (const f of ast.funs) {
    if (f.table) {
      if (f.args.length !== 1 || f.args[0].k !== "Nat" || f.args[0].n !== f.table.length) throw new WorldError(`fun ${f.name}: a table is a fun from Nat<${f.table.length}>`, f.line);
      f.tableV = f.table.map((e) => fit(w, f.retN, evalT(w, template(w, e, f.line, f.retN), {}, 0), `fun ${f.name}`));
    } else {
      f.clausesC = f.clauses.map((cl) => {
        if (cl.pats.length !== f.args.length) throw new WorldError(`fun ${f.name} takes ${f.args.length} arguments`, f.line);
        const vt = new Map();
        const pats = cl.pats.map((p, i) => pattern(w, p, f.line, f.argsN[i], vt));
        return { pats, e: template(w, cl.e, f.line, f.retN, vt) };
      });
    }
  }
  for (const f of ast.funs) checkEquivariant(w, f);

  for (const r of ast.recipes) w.recipes.push(recipe(w, r));
  const ids = new Set();
  for (const r of w.recipes) {
    if (ids.has(r.id)) throw new WorldError(`two recipes are called ${r.id}`, r.line);
    ids.add(r.id);
  }
  w.level = levelOf(w, ast.level, ast.legend);
  return w;
}

// A recipe's cells, checked: patterns before, templates after.
export function recipe(w, r) {
  const vt = new Map(); // each variable's type, where the Before side says it
  const on = r.on && pattern(w, r.on, r.line, INPUT, vt);
  // A cell's layers, one expression each: `A / B`, or a lone `_` or `*`
  // for all of them.
  const cellsB = r.before.flat().map((e) => layersOf(w, e, r.line, ANY_E, vt, `recipe ${r.id}: `).map((x, l) => pattern(w, x, r.line, w.cellTypes[l], vt)));
  const cellsA = r.after.flat().map((e) => layersOf(w, e, r.line, KEEP_E, vt, `recipe ${r.id}: `).map((x, l) => template(w, x, r.line, w.cellTypes[l], vt)));
  const wd = r.before[0].length;
  const shape = (cells) => r.before.map((row, i) => row.map((_, j) => (w.L === 1 ? cells[i * wd + j][0] : { t: "layers", items: cells[i * wd + j] })));
  const before = shape(cellsB);
  const after = shape(cellsA);
  const out = { ...r, before, after, cellsB, cellsA, on, where: r.where && template(w, r.where, r.line, null, vt), h: before.length, wd };
  out.add = (r.add ?? []).map((a) => ({ reg: a.reg, e: template(w, a.e, r.line, null, vt) }));
  if (typeof r.chance === "string" ? !(r.chance in (w.regs0 ?? {})) : r.chance != null && !(r.chance >= 0 && r.chance <= 100)) throw new WorldError(`recipe ${r.id}: a chance is a percent, 0 to 100, or a register`, r.line);
  if (r.in && !(r.in in (w.regs0 ?? {}))) throw new WorldError(`recipe ${r.id}: in ${r.in}, but there's no register ${r.in}`, r.line);
  // Every variable a template reads must be bound by the pattern.
  const bound = new Set();
  const binds = (p) => {
    if (!p) return;
    if (p.t === "var" || p.t === "bind") bound.add(p.n);
    if (p.p) binds(p.p);
    for (const a of p.args ?? p.alts ?? []) binds(a);
  };
  binds(out.on);
  for (const cell of cellsB) cell.forEach(binds);
  const reads = (t) => {
    if (!t) return;
    if (t.t === "var" && !bound.has(t.n) && !(t.n in (w.regs0 ?? {}))) throw new WorldError(`recipe ${r.id}: ${t.n} is never matched on the Before side`, r.line);
    for (const x of [t.e, t.c, t.a, t.b, ...(t.args ?? []), ...(t.items ?? []), ...(t.fields ?? []).map((f) => f[1])]) if (x && typeof x === "object" && x.t) reads(x);
  };
  for (const cell of cellsA) cell.forEach(reads);
  reads(out.where);
  for (const a of out.add) reads(a.e);
  if (r.limit) checkLimit(w, out, r.limit);
  out.moves = moves(out);
  return out;
}

const ANY_E = Object.freeze({ t: "any" });
const KEEP_E = Object.freeze({ t: "keep" });

// A cell's layers, one expression each. `A / B` says them all; a lone `_`
// or `*` stands for every layer; and a lone value of one layer's type is
// that layer, the others `rest` (`_` on the Before side, `*` on the After),
// so in `cell Ground / Item`, `Frog(E, Sit)` is `* / Frog(E, Sit)`.
function layersOf(w, e, line, rest, vt = new Map(), who = "") {
  if (e.t === "layers") {
    if (w.L === 1) throw new WorldError("a cell is one value, not ground/item: say what it holds with a field, like On(Grass, Frog(E, Sit))", line);
    if (e.items.length !== w.L) throw new WorldError(`${who}a cell here has ${w.L} layers (${w.cell}), not ${e.items.length}`, line);
    return e.items;
  }
  if (w.L === 1 || e.t === "any" || e.t === "keep") return Array(w.L).fill(e);
  const l = w.layers.indexOf(rawType(w, e, vt));
  if (l < 0) throw new WorldError(`${who}a cell here has ${w.L} layers (${w.cell}): write each, with / between, or one value of a layer's type`, line);
  return w.layers.map((_, i) => (i === l ? e : rest));
}

// The type an expression plainly has, by name, before it's checked: what a
// lone value in a cell of layers is said in.
function rawType(w, e, vt) {
  switch (e.t) {
    case "con":
      return w.cons.get(e.c)?.type.name ?? null;
    case "bind":
    case "not":
      return rawType(w, e.p, vt);
    case "upd":
      return rawType(w, e.e, vt);
    case "if":
      return rawType(w, e.a, vt) ?? rawType(w, e.b, vt);
    case "named":
      return w.patternTypes?.get(e.n) ?? null;
    case "var": {
      if (w.patterns.has(e.n)) return w.patternTypes?.get(e.n) ?? null;
      const t = vt.get(e.n);
      if (t?.k === "user") return t.name;
      const c = sugarCon(w, e.n);
      return c ? w.cons.get(c).type.name : null;
    }
    case "or": {
      const ts = new Set(e.alts.map((a) => rawType(w, a, vt)));
      return ts.size === 1 ? [...ts][0] : null;
    }
    case "call":
      return w.funs.get(e.f)?.retN?.name ?? null;
  }
  return null;
}

// A level's bounds on a recipe the player draws (`limit` in a yours
// recipe), so the first puzzles each teach one idea, and a drawn recipe
// can't rewrite the whole board.
function checkLimit(w, r, lim) {
  const bad = (msg) => {
    throw new WorldError(`recipe ${r.id}: ${msg}`, r.line);
  };
  if (lim.max) {
    const [mw, mh] = lim.max;
    if (!((r.wd <= mw && r.h <= mh) || (r.wd <= mh && r.h <= mw))) bad(`this level allows recipes of at most ${mw}×${mh} cells`);
  }
  const nodes = [];
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x.t) return;
    nodes.push(x);
    for (const k of ["p", "e", "c", "a", "b", "args", "alts", "items", "fields"]) walk(x[k]);
  };
  walk([r.cellsB, r.cellsA, r.on, r.where, r.add.map((a) => a.e)]);
  if (lim.noFun && nodes.some((x) => x.t === "call")) bad("this level's recipes call no functions");
  if (lim.noVar && nodes.some((x) => (x.t === "var" && !w.patterns.has(x.n)) || x.t === "bind")) bad("this level's recipes name nothing: no variables");
  if (lim.only) {
    // Within the types it names: `only Frog Sit` leaves the floors alone.
    const ok = new Set(lim.only);
    const named = new Set(lim.only.map((c) => w.cons.get(c)?.type.name));
    const other = nodes.find((x) => x.t === "con" && !ok.has(x.c) && named.has(w.cons.get(x.c)?.type.name));
    if (other) bad(`this level's recipes use only ${lim.only.join(", ")}, not ${other.c}`);
  }
}

// Where a recipe says its things go: every After position written as a
// variable (or a variable with fields changed, x { mode = Sit }) is the very
// thing the Before side matched there, moved. Each is [from cell, from path,
// to cell, to path], cells numbered row by row and a path being field
// indices into the value. Positions written any other way say nothing, and
// the board guesses (view.js). So `a@Loose(_)  b@Loose(_)  ->  b  a` swaps
// two logs even when they are the same log.
function moves(r) {
  const site = new Map(); // var -> [cell, path], where the Before side first binds it
  const bind = (p, n, path) => {
    if (!p) return;
    if (p.t === "var" || p.t === "bind") {
      if (!site.has(p.n)) site.set(p.n, [n, path]);
    }
    if (p.t === "bind") bind(p.p, n, path);
    if (p.t === "layers") p.items.forEach((a, l) => bind(a, n, [...path, l]));
    if (p.t === "con") p.args.forEach((a, i) => bind(a, n, [...path, i]));
  };
  r.before.flat().forEach((p, n) => bind(p, n, []));
  const out = [];
  const write = (t, n, path) => {
    const v = t.t === "upd" ? t.e : t;
    if (v.t === "var" && site.has(v.n)) out.push([...site.get(v.n), n, path]);
    else if (t.t === "con") t.args.forEach((a, i) => write(a, n, [...path, i]));
    else if (t.t === "layers") t.items.forEach((a, l) => write(a, n, [...path, l]));
  };
  r.after.flat().forEach((t, n) => write(t, n, []));
  return out;
}

const INPUT = Object.freeze({ k: "user", name: "Input", args: [] });

// The sugar for optional values. Where a T? (an Option<T>) is wanted and
// the expression is plainly a T, a constructor of another type or a
// literal other than `none`, it means Some of it; `none` is None. So
// On(Grass, Frog(E, Sit)) is On(Grass, Some(Frog(E, Sit))) when the field
// is a Thing?.
const optionOf = (ty) => (isOption(ty) ? ty.args[0] : null);
function plainly(w, e) {
  if (e.t === "con") return w.cons.get(e.c)?.type.name !== OPTION;
  if (e.t === "lit") return e.v !== null;
  if (e.t === "named") {
    const T = w.patternTypes?.get(e.n);
    return !!T && T !== OPTION;
  }
  return false;
}
const some = (x) => ({ t: "con", c: "Some", args: [x] });
const NONE_E = Object.freeze({ t: "con", c: "None", args: [] });

// The type a pattern can only match, by name, if that's plain.
function patternType(w, p) {
  if (!p) return null;
  if (p.t === "con") return w.cons.get(p.c)?.type.name ?? null;
  if (p.t === "bind" || p.t === "not") return patternType(w, p.p);
  if (p.t === "named") return w.patternTypes?.get(p.n) ?? patternType(w, w.patterns.get(p.n));
  if (p.t === "or") {
    const ts = new Set(p.alts.map((a) => patternType(w, a)));
    return ts.size === 1 ? [...ts][0] : null;
  }
  return null;
}

const known = (ty) => !!ty && ty.k !== "var";

// The constructor a lowercase name stands for, if any: loose and loose2 are
// Loose. Not the prelude's (none is None already) or a tuple's.
function sugarCon(w, n) {
  const base = n.replace(/[0-9']+$/, "");
  if (!base) return null;
  const c = base.charAt(0).toUpperCase() + base.slice(1);
  const con = w.cons.get(c);
  return con && !con.type.prelude ? c : null;
}

// A raw expression as a pattern: names resolved, the sugar unfolded,
// anything a pattern can't say refused. `ty` is the type expected, if
// known; `vt` collects each variable's type, where known, for the
// templates that read it.
export function pattern(w, e, line, ty = null, vt = new Map()) {
  const bad = (msg) => {
    throw new WorldError(msg, line);
  };
  if (ty && ty.k === "opt") ty = norm(ty);
  // Sugar: a lowercase name that is a constructor's, maybe with a number
  // after it (loose, loose2), binds a value made by that constructor, as
  // Automata's tags do: loose means loose@Loose.
  if (e.t === "var" && !w.patterns.has(e.n)) {
    const c = sugarCon(w, e.n);
    if (c) e = { t: "bind", n: e.n, p: { t: "con", c, args: [] } };
  }
  const inner = optionOf(ty);
  if (e.t === "lit" && e.v === null) return NONE_E;
  if (inner && plainly(w, e)) return some(pattern(w, e, line, inner, vt));
  if (inner && e.t === "bind" && plainly(w, e.p)) return some(pattern(w, e, line, inner, vt));
  // A variable already bound to a T, again where a T? is: Some of it.
  if (inner && e.t === "var" && known(vt.get(e.n)) && !isOption(vt.get(e.n))) return some(pattern(w, e, line, inner, vt));
  switch (e.t) {
    case "any":
    case "keep":
    case "lit":
      return e;
    case "var":
      if (w.patterns.has(e.n)) return pattern(w, { t: "named", n: e.n }, line, ty, vt);
      if (known(ty) && !vt.has(e.n)) vt.set(e.n, ty);
      return e;
    case "named":
      if (!w.patterns.has(e.n)) bad(`no pattern ${e.n}`);
      return e;
    case "con": {
      const con = w.cons.get(e.c) ?? bad(`no constructor ${e.c}`);
      // Sugar: a constructor written bare matches whatever its fields hold
      // (Frog is Frog(_, _)).
      if (!e.args.length && con.fields.length) e = { ...e, args: con.fields.map(() => ({ t: "any" })) };
      if (e.args.length !== con.fields.length) bad(`${isTuple(e.c) ? "this tuple" : e.c} has ${con.fields.length} ${isTuple(e.c) ? "part" : "field"}${con.fields.length === 1 ? "" : "s"}${con.fields.length && !isTuple(e.c) ? ` (${con.fields.map((f) => f.name).join(", ")})` : ""}, not ${e.args.length}`);
      if (ty?.k === "user" && con.type.name !== ty.name) bad(`${isTuple(e.c) ? printExpr(e) : e.c} is ${aType(conType(w, e.c))}, but this is ${aType(ty)}`);
      const fts = fieldTypes(w, e.c, ty);
      return { t: "con", c: e.c, args: e.args.map((a, i) => pattern(w, a, line, fts[i], vt)) };
    }
    case "or":
      return { t: "or", alts: e.alts.map((a) => pattern(w, a, line, ty, vt)) };
    case "not":
      return { t: "not", p: pattern(w, e.p, line, ty, new Map(vt)) };
    case "bind":
      if (w.patterns.has(e.n)) bad(`${e.n} is a pattern's name, so it can't name a match`);
      if (known(ty) && !vt.has(e.n)) vt.set(e.n, ty);
      return { t: "bind", n: e.n, p: pattern(w, e.p, line, ty, vt) };
  }
  return bad(`a pattern can't hold ${printExpr(e)}`);
}

// A constructor's type, its parameters left as they are.
const conType = (w, c) => {
  const T = w.cons.get(c).type;
  return { k: "user", name: T.name, args: T.params.map((p) => ({ k: "var", name: p })) };
};

// A raw expression as a template, the sugar unfolded as for patterns. A
// variable known to be a T, written where a T? goes, is Some of it.
export function template(w, e, line, ty = null, vt = new Map()) {
  const bad = (msg) => {
    throw new WorldError(msg, line);
  };
  if (ty && ty.k === "opt") ty = norm(ty);
  const inner = optionOf(ty);
  if (e.t === "lit" && e.v === null) return NONE_E;
  if (inner && plainly(w, e)) return some(template(w, e, line, inner, vt));
  if (inner && (e.t === "var" || (e.t === "upd" && e.e.t === "var"))) {
    const vty = vt.get(e.t === "var" ? e.n : e.e.n);
    if (known(vty) && !isOption(vty)) return some(template(w, e, line, inner, vt));
  }
  switch (e.t) {
    case "keep":
    case "lit":
    case "var":
      return e;
    case "any":
      return bad("_ matches anything, so it can't be written: write * to keep what's there");
    case "con": {
      const con = w.cons.get(e.c) ?? bad(`no constructor ${e.c}`);
      if (e.args.length !== con.fields.length) bad(`${isTuple(e.c) ? "this tuple" : e.c} has ${con.fields.length} ${isTuple(e.c) ? "part" : "field"}${con.fields.length === 1 ? "" : "s"}, not ${e.args.length}`);
      if (ty?.k === "user" && con.type.name !== ty.name) bad(`${isTuple(e.c) ? printExpr(e) : e.c} is ${aType(conType(w, e.c))}, but this is ${aType(ty)}`);
      const fts = fieldTypes(w, e.c, ty);
      return { t: "con", c: e.c, args: e.args.map((a, i) => template(w, a, line, fts[i], vt)) };
    }
    case "upd":
      return { t: "upd", e: template(w, e.e, line, null, vt), fields: e.fields.map(([f, x]) => [f, template(w, x, line, null, vt)]) };
    case "if":
      return { t: "if", c: template(w, e.c, line, null, vt), a: template(w, e.a, line, ty, vt), b: template(w, e.b, line, ty, vt) };
    case "bin":
      return { t: "bin", op: e.op, a: template(w, e.a, line, null, vt), b: template(w, e.b, line, null, vt) };
    case "not":
      return { t: "not", p: template(w, e.p, line, null, vt) };
    case "list":
      return { t: "list", items: e.items.map((x) => template(w, x, line, null, vt)) };
    case "call": {
      if (!BUILTINS[e.f] && !w.funs.has(e.f)) bad(`no function ${e.f}`);
      const F = w.funs.get(e.f);
      return { t: "call", f: e.f, args: e.args.map((x, i) => template(w, x, line, F?.argsN?.[i] ?? null, vt)) };
    }
  }
  return bad(`a template can't hold ${printExpr(e)}`);
}

// ---- matching ----

// Whether pattern `p`, in the recipe's rotation k, matches value v. Binds
// variables into env (a plain object, copied where a branch may fail).
export function match(w, p, v, k, env) {
  switch (p.t) {
    case "any":
    case "keep":
      return true;
    case "lit":
      return typeof p.v === "string" ? v === turnDir(p.v, k) : v === p.v;
    case "var":
      if (p.n in env) return eq(env[p.n], v);
      env[p.n] = v;
      return true;
    case "named":
      return match(w, w.patterns.get(p.n), v, k, env);
    case "con":
      if (!v || typeof v !== "object" || v.c !== p.c) return false;
      for (let i = 0; i < p.args.length; i++) if (!match(w, p.args[i], v.a[i], k, env)) return false;
      return true;
    case "or":
      for (const a of p.alts) {
        const e2 = { ...env };
        if (match(w, a, v, k, e2)) {
          Object.assign(env, e2);
          return true;
        }
      }
      return false;
    case "not":
      return !match(w, p.p, v, k, { ...env });
    case "bind":
      if (!match(w, p.p, v, k, env)) return false;
      if (p.n in env) return eq(env[p.n], v);
      env[p.n] = v;
      return true;
  }
  return false;
}

// ---- evaluating templates ----

const BUILTINS = {
  turn: (w, [d, n]) => turnDir(d, n),
  count: (w, [x, xs]) => xs.filter((y) => eq(x, y)).length,
  min: (w, [a, b]) => Math.min(a, b),
  // Arithmetic beyond + and - (a recipe row's * keeps, its / is a layer).
  times: (w, [a, b]) => a * b,
  div: (w, [a, b]) => Math.floor(a / b),
  abs: (w, [a]) => Math.abs(a),
  max: (w, [a, b]) => Math.max(a, b),
  // For land and games: rounding, distance, and noise that is the same
  // wherever and whenever it is read (noise.js).
  round: (w, [a]) => Math.round(a),
  ceil: (w, [a]) => Math.ceil(a),
  hypot: (w, [a, b]) => Math.hypot(a, b),
  hash: (w, [a, b, s]) => hash(a, b, s),
  noise: (w, [x, y, scale, s]) => vnoise(x, y, scale, s),
  blob: (w, [x, y, scale, s]) => blob(x, y, scale, s),
};

function call(w, f, args) {
  if (BUILTINS[f]) return BUILTINS[f](w, args);
  // A generator's own: rand(), ground(x, y), item(x, y) (gen.js).
  if (w.genFns?.[f]) return w.genFns[f](...args);
  const F = w.funs.get(f);
  args = args.map((a, i) => fit(w, F.argsN[i], a, `fun ${f}`));
  if (F.tableV) return F.tableV[args[0]];
  for (const cl of F.clausesC) {
    const env = {};
    if (cl.pats.every((p, i) => match(w, p, args[i], 0, env))) return fit(w, F.retN, evalT(w, cl.e, env, 0), `fun ${f}`);
  }
  throw new WorldError(`fun ${f} has no case for ${args.map(printValue).join(", ")}`, F.line);
}

// A template's value in the recipe's rotation k. `*` inside is a hole.
export function evalT(w, t, env, k) {
  switch (t.t) {
    case "keep":
      return HOLE;
    case "lit":
      return typeof t.v === "string" ? turnDir(t.v, k) : t.v;
    case "var":
      // A name nothing matched is a register: what it holds this tick.
      return t.n in env ? env[t.n] : (w.regsNow?.[t.n] ?? w.regs0?.[t.n]);
    case "con": {
      const con = w.cons.get(t.c);
      return { c: t.c, a: t.args.map((a, i) => fit(w, con.fieldsN[i].type, evalT(w, a, env, k), `${t.c}'s ${con.fields[i].name}`)) };
    }
    case "upd": {
      let v = evalT(w, t.e, env, k);
      if (!v || typeof v !== "object" || v.hole) throw new WorldError(`${printExpr(t)}: only a constructor has fields`);
      // Some(x) { f = … } changes x's f, as the sugar hides the Some.
      if (v.c === "Some" && !t.fields.some(([f]) => f === "value")) {
        const inner = evalT(w, { ...t, e: { t: "lit", v: v.a[0] } }, env, k);
        return { c: "Some", a: [inner] };
      }
      if (v.c === "None") return v;
      const con = w.cons.get(v.c);
      const a = [...v.a];
      for (const [f, x] of t.fields) {
        const i = con.fields.findIndex((g) => g.name === f);
        if (i < 0) continue; // A value without that field is written as it is.
        a[i] = fit(w, con.fieldsN[i].type, evalT(w, x, env, k), `${v.c}'s ${f}`);
      }
      return { c: v.c, a };
    }
    case "if":
      return evalT(w, t.c, env, k) ? evalT(w, t.a, env, k) : evalT(w, t.b, env, k);
    case "not":
      return !evalT(w, t.p, env, k);
    case "list":
      return t.items.map((x) => evalT(w, x, env, k));
    case "call":
      return call(w, t.f, t.args.map((x) => evalT(w, x, env, k)));
    case "bin": {
      const a = evalT(w, t.a, env, k);
      if (t.op === "&&") return a && evalT(w, t.b, env, k);
      if (t.op === "||") return a || evalT(w, t.b, env, k);
      const b = evalT(w, t.b, env, k);
      switch (t.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "mod":
          return ((a % b) + b) % b;
        case "==":
          return eq(a, b);
        case "!=":
          return !eq(a, b);
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
      }
    }
  }
  throw new WorldError(`can't evaluate ${printExpr(t)}`);
}

// A function recipes call must commute with rotation, or a recipe would mean
// different things in different rotations. Every type is finite, so try them
// all (when there aren't too many).
function checkEquivariant(w, f) {
  let combos = [[]];
  for (const t of f.argsN) {
    const vs = enumerate(w, t, 2000);
    if (!vs) return;
    combos = combos.flatMap((c) => vs.map((v) => [...c, v]));
    if (combos.length > 20000) return;
  }
  for (const args of combos) {
    const out = call(w, f.name, args);
    const turned = call(
      w,
      f.name,
      args.map((a) => rot(w, a, 1)),
    );
    if (!eq(turned, rot(w, out, 1))) throw new WorldError(`fun ${f.name} doesn't turn with the board: ${f.name}(${args.map(printValue).join(", ")}) is ${printValue(out)}, but turned a quarter it gives ${printValue(turned)}, not ${printValue(rot(w, out, 1))}`, f.line);
  }
}

// ---- the level ----

// A legend value: a template with nothing bound, holes filled with defaults.
function legendValue(w, e, l, line, ch) {
  const ty = w.cellTypes[l];
  if (e.t === "keep" || e.t === "any") return intern(w, defaultOf(w, ty));
  const t = template(w, e, line, ty);
  return intern(w, fill(w, fit(w, ty, evalT(w, t, {}, 0), `legend ${ch}`), defaultOf(w, ty), ty));
}

// Each layer's legend, char -> value: what a blueprint (land.js) is drawn in.
export function layerLegends(w) {
  const byLayer = w.layers.map(() => new Map());
  for (const { ch, cell, line, layer } of w.flat.legend) {
    if (!layer) continue;
    const l = w.layers.findIndex((n) => n.toLowerCase() === layer.toLowerCase());
    if (l >= 0) byLayer[l].set(ch, legendValue(w, cell, l, line, ch));
  }
  return byLayer;
}

function levelOf(w, L, legends = L.legend) {
  // A legend for whole cells, and one per layer for maps drawn a grid a
  // layer (legend ground ~ = Water(none), legend item l = Loose(Log, none)),
  // later ones over earlier.
  const legend = new Map();
  const byLayer = w.layers.map(() => new Map());
  for (const { ch, cell, line, layer } of legends) {
    if (layer) {
      const l = w.layers.findIndex((n) => n.toLowerCase() === layer.toLowerCase());
      if (l < 0) throw new WorldError(`legend ${layer}: the layers are ${w.layers.join(", ")}`, line);
      byLayer[l].set(ch, legendValue(w, cell, l, line, ch));
    } else {
      legend.set(
        ch,
        layersOf(w, cell, line, KEEP_E).map((e, l) => legendValue(w, e, l, line, ch)),
      );
    }
  }
  const layered = w.L > 1 && byLayer.every((m) => m.size);
  if ((L.gen || L.endless) && !L.map.length) {
    // A level its `gen` draws (gen.js, when it starts): its size, and every
    // layer's first value until then. An endless level (land.js) is the
    // window of its land that runs.
    const env = { ...(w.regs0 ?? {}) };
    const span = L.endless && L.endless.chunk * L.endless.window;
    const W = span || evalT(w, L.gen.W, env, 0);
    const H = span || evalT(w, L.gen.H, env, 0);
    const blank = w.cellTypes.map((ty) => intern(w, defaultOf(w, ty)));
    const cells = Array.from({ length: W * H }, () => blank).flat();
    const goals = L.goals.map((g) => {
      const pats = layersOf(w, g.cell, g.line, ANY_E).map((e, l) => pattern(w, e, g.line, w.cellTypes[l]));
      return { x: g.x, y: g.y, cell: pats[0], layers: pats };
    });
    return { id: L.id ?? "", name: L.name, intro: L.intro, hint: L.hint, par: L.par ?? null, solution: L.solution ?? null, W, H, cells, goals, gen: L.gen, endless: L.endless };
  }
  const H = L.map.length;
  // A row of one grid in a map of layers draws the ground alone: the
  // layers above it start as their blank (a room's walls and floor).
  const grids = L.map.map((r) => (layered ? r.split(/\s+/).map((g) => [...g]) : [[...r]]));
  if (layered && grids.some((g) => g.length !== w.L && g.length !== 1)) throw new WorldError(`a map row here is ${w.L} grids side by side, one a layer (${w.cell})`, L.line);
  const blankOf = w.cellTypes.map((ty) => intern(w, defaultOf(w, ty)));
  const W = Math.max(0, ...grids.flat().map((g) => g.length));
  const cells = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (layered) {
        for (let l = 0; l < w.L; l++) {
          if (!grids[y][l]) {
            cells.push(blankOf[l]);
            continue;
          }
          const ch = grids[y][l][x] ?? " ";
          const v = byLayer[l].get(ch);
          if (!v) throw new WorldError(`the map's ${w.layers[l]} '${ch}' at ${x}, ${y} has no legend`, L.line);
          cells.push(v);
        }
        continue;
      }
      const ch = grids[y][0][x] ?? " ";
      const cell = legend.get(ch);
      if (!cell) throw new WorldError(`the map's '${ch}' at ${x}, ${y} has no legend`, L.line);
      cells.push(...cell);
    }
  }
  // Things (buildings, furniture, portals) stand on their cells: rock to
  // the engine, with nothing on it; whoever plays the file draws them.
  const things = L.things ?? [];
  if (things.length && w.cons.has("Rock")) {
    const rock = intern(w, { c: "Rock", a: [] });
    for (const { at: [x0, y0, tw, th] } of things) {
      for (let y = y0; y < y0 + th; y++) {
        for (let x = x0; x < x0 + tw; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          for (let l = 0; l < w.L; l++) cells[(y * W + x) * w.L + l] = l === 0 ? rock : blankOf[l];
        }
      }
    }
  }
  const goals = L.goals.map((g) => {
    if (g.x >= W || g.y >= H) throw new WorldError(`goal at ${g.x}, ${g.y} is off the map`, g.line);
    const pats = layersOf(w, g.cell, g.line, ANY_E).map((e, l) => pattern(w, e, g.line, w.cellTypes[l]));
    return { x: g.x, y: g.y, cell: pats[0], layers: pats };
  });
  return { id: L.id ?? "", name: L.name, intro: L.intro, hint: L.hint, par: L.par ?? L.solution?.length ?? null, solution: L.solution ?? null, W, H, cells, goals, things };
}

// A level's first state. `seed` picks the dice (chance recipes), and
// `regs` are the world's registers, which `add` changes.
export const start = (w, { seed = 0, regs = {} } = {}) => ({ board: [...w.level.cells], tick: 0, fired: [], moves: [], regs: { ...(w.regs0 ?? {}), ...regs }, seed });

// ---- values on the board ----
//
// Each distinct layer value on a board is one object with a small id,
// hidden under ID: a hash-cons table filled as values appear. A cell then
// compares by id, settling keys on numbers, and what a pattern makes of a
// value is worked out once per value rather than once per cell.

export const ID = Symbol("id");

export function intern(w, v) {
  if (v[ID] !== undefined) return v;
  const k = key(v);
  let c = w.interned.get(k);
  if (!c) {
    c = Object.isFrozen(v) ? { c: v.c, a: v.a } : v;
    Object.defineProperty(c, ID, { value: w.values.length });
    w.values.push(c);
    w.interned.set(k, c);
  }
  return c;
}
export const idOf = (w, v) => intern(w, v)[ID];

// Whether a pattern reads or binds variables, so that what it matches
// depends on more than the value.
const VARS = new WeakMap();
export function hasVars(w, p) {
  const known = VARS.get(p);
  if (known !== undefined) return known;
  let r;
  switch (p.t) {
    case "var":
    case "bind":
      r = true;
      break;
    case "named":
      r = hasVars(w, w.patterns.get(p.n));
      break;
    case "con":
      r = p.args.some((a) => hasVars(w, a));
      break;
    case "or":
      r = p.alts.some((a) => hasVars(w, a));
      break;
    case "not":
      r = hasVars(w, p.p);
      break;
    default:
      r = false;
  }
  VARS.set(p, r);
  return r;
}

// Whether p could match v, whatever is bound: exact for a pattern without
// variables, and never false where match() would be true.
export function quick(w, p, k, v) {
  switch (p.t) {
    case "any":
    case "keep":
    case "var":
      return true;
    case "lit":
      return typeof p.v === "string" ? v === turnDir(p.v, k) : v === p.v;
    case "named":
      return quick(w, w.patterns.get(p.n), k, v);
    case "con":
      if (!v || typeof v !== "object" || v.c !== p.c) return false;
      for (let i = 0; i < p.args.length; i++) if (!quick(w, p.args[i], k, v.a[i])) return false;
      return true;
    case "or":
      for (const a of p.alts) if (quick(w, a, k, v)) return true;
      return false;
    case "not":
      return hasVars(w, p.p) ? true : !match(w, p.p, v, k, {});
    case "bind":
      return quick(w, p.p, k, v);
  }
  return false;
}

// quick() of a recipe cell's pattern on an interned value, remembered in
// c (the cell's cache from prep(), one array per rotation, by value id).
function q(w, c, p, k, v) {
  const id = v[ID] ?? idOf(w, v);
  let r = c[k][id];
  if (r === undefined) r = c[k][id] = quick(w, p, k, w.values[id]);
  return r;
}

const trivial = (p) => p.t === "any" || p.t === "keep" || p.t === "var";

// ---- a tick ----

// A recipe cell's offset after k quarter turns clockwise: E (1,0) goes to S (0,1).
function turnOffset(x, y, k) {
  for (let i = 0; i < k; i++) [x, y] = [-y, x];
  return [x, y];
}

// A recipe's four rotations on a W×H board, worked out once: each cell's
// place in the rotated rectangle and its bounding box.
function prep(w, r) {
  const { W, H } = w.level;
  if (r._prep && r._prep.w === w && r._prep.W === W && r._prep.H === H) return r._prep;
  const rots = [];
  for (let k = 0; k < 4; k++) {
    const offs = [];
    for (let i = 0; i < r.h; i++) for (let j = 0; j < r.wd; j++) offs.push(turnOffset(j, i, k));
    const mx = Math.min(...offs.map((o) => o[0]));
    const my = Math.min(...offs.map((o) => o[1]));
    const relX = offs.map((o) => o[0] - mx);
    const relY = offs.map((o) => o[1] - my);
    rots.push({ relX, relY, rel: relX.map((x, n) => relY[n] * W + x), bw: Math.max(...relX) + 1, bh: Math.max(...relY) + 1 });
  }
  const full = r.cellsB.map((cell) => cell.map((p) => hasVars(w, p)));
  const keyed = r.cellsB.map((cell) => cell.map((p) => !trivial(p)));
  const qc = r.cellsB.map((cell) => cell.map(() => [[], [], [], []]));
  const prepared = { w, W, H, rots, full, keyed, qc };
  Object.defineProperty(r, "_prep", { value: prepared, configurable: true, writable: true });
  return prepared;
}

// Chance, as Automata rolls it: a hash of the seed, the tick, the recipe's
// id and the footprint, so replays, the solver and every engine agree.
export function hash32(a, b, c, d) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1442695041) ^ Math.imul(d | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
const ruleHashes = new Map();
export function ruleHash(id) {
  let h = ruleHashes.get(id);
  if (h == null) {
    h = 0;
    for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    ruleHashes.set(id, h);
  }
  return h;
}

// Where each value is on the board, per layer: id -> cells.
function index(w, board) {
  const L = w.L;
  const out = Array.from({ length: L }, () => new Map());
  for (let s = 0; s < board.length; s++) {
    const v = board[s];
    const id = v[ID] ?? idOf(w, v);
    const b = out[s % L];
    const at = b.get(id);
    if (at) at.push((s - (s % L)) / L);
    else b.set(id, [(s - (s % L)) / L]);
  }
  return out;
}

// Every match of `rules` on `board`. A match is { r, k, cells, writes, env,
// moves, foot }: cells in the recipe's order (row by row), a write per cell
// layer its template doesn't leave as `*` ({ i: cell, l: layer, s: slot,
// v, id }), and the recipe's moves on the board: { from: [cell, path], to:
// [cell, path] }. `ctx` is { tick, seed }, for chance.
export function matches(w, rules, board, input, ctx = { tick: 0, seed: 0 }) {
  const { W, H } = w.level;
  const L = w.L;
  const at = index(w, board);
  const out = [];
  for (const r of rules) {
    const P = prep(w, r);
    const nc = r.cellsB.length;
    const feet = new Set();
    const sigs = new Set();
    for (let k = 0; k < 4; k++) {
      const env0 = {};
      if (r.on) {
        if (!input || !match(w, r.on, input, k, env0)) continue;
      }
      const R = P.rots[k];
      // The key cell: the one whose pattern the fewest board cells could
      // match. Only anchors that put it on one of those are tried.
      let best = -1;
      let bestL = 0;
      let bestN = Infinity;
      for (let n = 0; n < nc && bestN > 0; n++) {
        for (let l = 0; l < L; l++) {
          if (!P.keyed[n][l]) continue;
          const p = r.cellsB[n][l];
          let cnt = 0;
          for (const [id, cells] of at[l]) if (q(w, P.qc[n][l], p, k, w.values[id])) cnt += cells.length;
          if (cnt < bestN) {
            bestN = cnt;
            best = n;
            bestL = l;
          }
        }
      }
      if (bestN === 0) continue;
      let anchors;
      if (best >= 0) {
        anchors = [];
        const p = r.cellsB[best][bestL];
        for (const [id, cells] of at[bestL]) {
          if (!q(w, P.qc[best][bestL], p, k, w.values[id])) continue;
          for (const c of cells) {
            const x = (c % W) - R.relX[best];
            const y = (c - (c % W)) / W - R.relY[best];
            if (x < 0 || y < 0 || x + R.bw > W || y + R.bh > H) continue;
            anchors.push(y * W + x);
          }
        }
        anchors.sort((a, b) => a - b);
      } else {
        anchors = [];
        for (let y = 0; y + R.bh <= H; y++) for (let x = 0; x + R.bw <= W; x++) anchors.push(y * W + x);
      }
      next: for (const a of anchors) {
        const cells = new Array(nc);
        for (let n = 0; n < nc; n++) cells[n] = a + R.rel[n];
        for (let n = 0; n < nc; n++) {
          for (let l = 0; l < L; l++) if (P.keyed[n][l] && !q(w, P.qc[n][l], r.cellsB[n][l], k, board[cells[n] * L + l])) continue next;
        }
        const env = { ...env0 };
        for (let n = 0; n < nc; n++) {
          for (let l = 0; l < L; l++) if (P.full[n][l] && !match(w, r.cellsB[n][l], board[cells[n] * L + l], k, env)) continue next;
        }
        if (r.where && !evalT(w, r.where, env, k)) continue;
        // One footprint, one match: the lowest rotation that fits. A
        // rectangle's footprint is its top-left cell and, if it isn't
        // square, which way it lies.
        let top = cells[0];
        for (const c of cells) if (c < top) top = c;
        const foot = top * 2 + (r.h !== r.wd ? k & 1 : 0);
        if (feet.has(foot)) continue;
        feet.add(foot);
        if (r.chance != null && hash32(ctx.seed ?? 0, ctx.tick ?? 0, ruleHash(r.hashId ?? r.id), foot) >= (typeof r.chance === "string" ? +(w.regsNow?.[r.chance] ?? 0) : r.chance) / 100) continue;
        const writes = [];
        for (let n = 0; n < nc; n++) {
          for (let l = 0; l < L; l++) {
            const tc = r.cellsA[n][l];
            if (tc.t === "keep") continue;
            const v = intern(w, fit(w, w.cellTypes[l], evalT(w, tc, env, k), `recipe ${r.id}`));
            writes.push({ i: cells[n], n, l, s: cells[n] * L + l, v, id: v[ID] });
          }
        }
        if (!writes.length) continue;
        // A recipe's matches that write exactly the same thing are one.
        const sig = writes.length === 1 ? `${writes[0].s}=${writes[0].id}` : writes.map((x) => `${x.s}=${x.id}`).sort().join(";");
        if (sigs.has(sig)) continue;
        sigs.add(sig);
        const moved = r.moves.map(([f, p, t, pt]) => ({ from: [cells[f], p], to: [cells[t], pt] }));
        out.push({ r, k, cells, writes, env, moves: moved, foot });
      }
    }
  }
  return out;
}

// Settle.lean's rule, over cell layers: groups in ascending order; a match
// loses if a layer it writes was claimed by an earlier group (outranked);
// within a group, a layer two surviving matches write differently clashes,
// and every match writing it skips. Writes compare as written, holes and
// all.
export function settleAll(ms) {
  const groups = [...new Set(ms.map((m) => m.r.group ?? 0))].sort((a, b) => a - b);
  const taken = new Map();
  const won = [];
  const outranked = [];
  const clashed = [];
  for (const g of groups) {
    const live = [];
    for (const m of ms) {
      if ((m.r.group ?? 0) !== g) continue;
      const lost = m.writes.find((x) => taken.has(x.s));
      if (lost) outranked.push({ m, by: taken.get(lost.s), at: lost.i });
      else live.push(m);
    }
    const want = new Map();
    const clash = new Set();
    for (const m of live) {
      for (const x of m.writes) {
        const id = want.get(x.s);
        if (id === undefined) want.set(x.s, x.id);
        else if (id !== x.id) clash.add(x.s);
      }
    }
    const from = won.length;
    for (const m of live) {
      if (clash.size && m.writes.some((x) => clash.has(x.s))) clashed.push(m);
      else won.push(m);
    }
    for (let n = from; n < won.length; n++) for (const x of won[n].writes) if (!taken.has(x.s)) taken.set(x.s, won[n]);
  }
  return { won, outranked, clashed };
}
export const settle = (ms) => settleAll(ms).won;

// A write with holes takes those fields from what's there.
export function fill(w, v, old, ty) {
  if (v === HOLE) return old;
  if (!v || typeof v !== "object") return v;
  if (!v.a.some((x) => x === HOLE || (x && typeof x === "object" && !Array.isArray(x)))) return v;
  const fts = fieldTypes(w, v.c, ty);
  const same = old && typeof old === "object" && old.c === v.c;
  return {
    c: v.c,
    a: v.a.map((x, i) => {
      if (x === HOLE) return same ? old.a[i] : defaultOf(w, fts[i]);
      return fill(w, x, same ? old.a[i] : undefined, fts[i]);
    }),
  };
}

function apply(w, board, won) {
  const next = board.slice();
  const done = new Set();
  for (const m of won) {
    for (const x of m.writes) {
      if (done.has(x.s)) continue;
      done.add(x.s);
      next[x.s] = intern(w, fill(w, x.v, board[x.s], w.cellTypes[x.l]));
    }
  }
  return next;
}

// What the winners add to the registers, from what they matched.
export function effects(w, won, regs) {
  let out = regs;
  for (const m of won) {
    for (const a of m.r.add ?? []) {
      if (out === regs) out = { ...regs };
      out[a.reg] = (out[a.reg] ?? 0) + (+evalT(w, a.e, m.env, m.k) || 0);
    }
  }
  return out;
}

// Half a tick: `rules` match `board`, settle, and the winners write. Returns
// { board, regs, won, outranked, clashed }. A world with compiled code
// (compile.js: w.compiled) runs it instead, to the same result.
export function phase(w, board, rules, input, ctx = { tick: 0, seed: 0 }, regs = {}) {
  w.regsNow = ctx.regs ?? regs;
  if (w.compiled?.fits(board, rules)) return w.compiled.phase(board, rules, input, ctx, regs);
  const all = settleAll(matches(w, rules, board, input, ctx));
  return { ...all, board: all.won.length ? apply(w, board, all.won) : board, regs: effects(w, all.won, regs) };
}

// The moves of a tick's two halves as one: a thing the key's recipes moved
// and the clock's recipes moved again went from where it was to where it is.
// A first-half move into a cell the second half rewrote, and didn't move on,
// is forgotten (that thing may be gone).
function chain(first, second, rewrote) {
  const back = (pos) => {
    let best = null;
    for (const m of first) {
      const [c, p] = m.to;
      if (c === pos[0] && p.length <= pos[1].length && p.every((x, i) => x === pos[1][i]) && (!best || p.length > best.to[1].length)) best = m;
    }
    return best ? [best.from[0], [...best.from[1], ...pos[1].slice(best.to[1].length)]] : pos;
  };
  return [...first.filter((m) => !rewrote.has(m.to[0])), ...second.map((m) => ({ from: back(m.from), to: m.to }))];
}

// One tick: the key press (null to wait) runs the input recipes, the ones
// with `on`, first; then every other recipe matches the board that leaves.
// Returns the next state; `fired` lists what fired, and `moves` where the
// recipes said things went, for the pictures.
export function step(w, state, input = null, rules = w.recipes) {
  // A recipe `in r` runs while register r is on.
  rules = rules.filter((r) => !r.in || state.regs?.[r.in]);
  const ctx = { tick: state.tick, seed: state.seed ?? 0, regs: state.regs ?? {} };
  let board = state.board;
  let regs = state.regs ?? {};
  const fired = [];
  let moved = [];
  const inputV = input && { c: "Key", a: [input.d, !!input.far] };
  if (inputV) {
    const p = phase(w, board, rules.filter((r) => r.on), inputV, ctx, regs);
    board = p.board;
    regs = p.regs;
    for (const m of p.won) fired.push(m); // not push(...): a big board has more matches than a call takes arguments
    moved = p.won.flatMap((m) => m.moves);
  }
  const p = phase(w, board, rules.filter((r) => !r.on), null, ctx, regs);
  board = p.board;
  regs = p.regs;
  for (const m of p.won) fired.push(m);
  const rewrote = new Set(p.won.flatMap((m) => m.writes.map((x) => x.i)));
  moved = chain(moved, p.won.flatMap((m) => m.moves), rewrote);
  return { board, tick: state.tick + 1, fired, moves: moved, regs, seed: state.seed ?? 0 };
}

// Every goal holds.
// Every goal holds, now and after one more tick with no key, so a thing
// sliding, drifting or shoved across a goal on its way somewhere else
// doesn't count.
export function solved(w, state, rules = w.recipes) {
  const holds = (s) => w.level.goals.length > 0 && w.level.goals.every((g) => goalHolds(w, s, g));
  return holds(state) && holds(step(w, state, null, rules));
}

// Whether goal g holds. It is one pattern a layer, sharing its variables,
// so On(Plate(s), Loose(s)) wants the very thing the plate names.
export function goalHolds(w, state, g) {
  const env = {};
  const i = g.y * w.level.W + g.x;
  return (g.layers ?? [g.cell]).every((p, l) => match(w, p, state.board[i * w.L + l], 0, env));
}

export const boardKey = (state) => state.board.map((v) => v[ID] ?? key(v)).join("|");

// Breadth-first search for a sequence of keys that solves the level, for
// tests and hints: moves are "N" "E" "S" "W" or "." (wait).
export function solve(w, { limit = 100000, rules = w.recipes, waits = true } = {}) {
  const moves = [...DIRS, ...(waits ? ["."] : [])];
  let s0 = start(w);
  const seen = new Set([boardKey(s0)]);
  let frontier = [[s0, ""]];
  while (frontier.length && seen.size < limit) {
    const next = [];
    for (const [s, path] of frontier) {
      for (const m of moves) {
        const t = step(w, s, m === "." ? null : { d: m, far: false }, rules);
        const p = path + m;
        if (solved(w, t)) return p;
        const kk = boardKey(t);
        if (seen.has(kk)) continue;
        seen.add(kk);
        next.push([t, p]);
      }
    }
    frontier = next;
  }
  return null;
}

// Play a path of moves; returns every state along it.
export function play(w, path, rules = w.recipes) {
  const states = [start(w)];
  // N E S W hop, . waits, n e s w superhop.
  for (const m of path) states.push(step(w, states.at(-1), m === "." ? null : { d: m.toUpperCase(), far: m !== m.toUpperCase() }, rules));
  return states;
}

export { enumerate, defaultOf, typeName, printCell, printValue };

// A value with the sugar put back: Some(x) as x and None as null, how
// the pictures and the editor show it.
export function sugared(v) {
  if (!v || typeof v !== "object" || v.hole) return v;
  if (v.c === "None") return null;
  if (v.c === "Some") return sugared(v.a[0]);
  return v.a.length ? { c: v.c, a: v.a.map(sugared) } : v;
}
