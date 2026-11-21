// The text of a world, both ways: parse() reads a .phib source into the AST
// terms.js runs, and the print* functions write any part of that AST back as
// text. The picture editor (editor.js) edits the AST, so a recipe drawn as
// pictures and a recipe typed as text are the same thing.
//
// The language is the one in wiki/Phibber Terms.md:
//
//   type Mode = Sit | Hop(far: Bool)
//   type Thing = Frog(face: Dir, mode: Mode) | Loose(what: Stuff)
//   type Tile = Rock | On(floor: Floor, thing: Thing?)
//   cell Tile
//   pattern floor = Grass | Lotus
//   fun next : Life -> Nat<9> -> Life
//     | Alive, 2 | _, 3 => Alive
//     | _, _ => Dead
//   group 1
//   recipe hop "Walk"
//     On(_, Frog(E, Hop(_)))  On(floor, none)  ->  On(*, none)  On(*, Frog(E, Sit))
//
// and a level: `level`, `intro`, `map` with `legend`s, and `goal`s. A cell
// is one value of the `cell` type: what stands on what, and what can hold
// what (a Rock, with no fields, holds nothing), is said by the types.

// ---- tokens ----

const SYMBOLS = ["->", "=>", "==", "!=", "<=", ">=", "&&", "||", "(", ")", "[", "]", "{", "}", ",", "|", "!", "@", "*", "=", "<", ">", "+", "-", ":", "?", "/", "%"];

export class SyntaxError2 extends Error {
  constructor(msg, line) {
    super(line != null ? `line ${line}: ${msg}` : msg);
    this.line = line;
  }
}

// One line's tokens: { t: "id" | "num" | "str" | "sym", v }. A `//` outside a
// string ends the line.
export function lex(text, line = null) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (text.startsWith("//", i)) break;
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\" && j + 1 < text.length) j++;
        s += text[j++];
      }
      if (j >= text.length) throw new SyntaxError2("a string never ends", line);
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      // A decimal, for chances (1.5%) and registers.
      if (text[j] === "." && /[0-9]/.test(text[j + 1] ?? "")) {
        j++;
        while (j < text.length && /[0-9]/.test(text[j])) j++;
      }
      out.push({ t: "num", v: Number(text.slice(i, j)) });
      i = j;
      continue;
    }
    // A colour, #rrggbb, for a thing's look.
    const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(text.slice(i));
    if (hex) {
      out.push({ t: "id", v: hex[0] });
      i += hex[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_']/.test(text[j])) j++;
      out.push({ t: "id", v: text.slice(i, j) });
      i = j;
      continue;
    }
    const sym = SYMBOLS.find((s) => text.startsWith(s, i));
    if (!sym) throw new SyntaxError2(`unexpected '${ch}'`, line);
    out.push({ t: "sym", v: sym });
    i += sym.length;
  }
  return out;
}

class Tokens {
  constructor(toks, line) {
    this.toks = toks;
    this.i = 0;
    this.line = line;
  }
  peek(k = 0) {
    return this.toks[this.i + k];
  }
  done() {
    return this.i >= this.toks.length;
  }
  is(v, k = 0) {
    const t = this.peek(k);
    return !!t && (t.t === "sym" || t.t === "id") && t.v === v;
  }
  next() {
    if (this.done()) this.fail("the line ends too soon");
    return this.toks[this.i++];
  }
  eat(v) {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  want(v) {
    if (!this.eat(v)) this.fail(`expected '${v}'${this.done() ? " at the end" : `, found '${this.peek().v}'`}`);
  }
  id() {
    const t = this.next();
    if (t.t !== "id") this.fail(`expected a name, found '${t.v}'`);
    return t.v;
  }
  fail(msg) {
    throw new SyntaxError2(msg, this.line);
  }
}

// ---- expressions ----
//
// Patterns and templates share one grammar; parsing gives a raw expression,
// and pattern()/template() check it is one of the two. Juxtaposition means
// nothing, so a row of cells is just expressions one after another.

export const DIRS = ["N", "E", "S", "W"];
const RESERVED = new Set(["if", "then", "else", "mod", "where", "on", "true", "false", "none"]);

function parseExpr(ts) {
  if (ts.eat("if")) {
    const c = parseExpr(ts);
    ts.want("then");
    const a = parseExpr(ts);
    ts.want("else");
    const b = parseExpr(ts);
    return { t: "if", c, a, b };
  }
  return parseOr(ts);
}

function parseOr(ts) {
  const first = parseBin(ts, 0);
  if (!ts.is("|")) return first;
  const alts = [first];
  while (ts.eat("|")) alts.push(parseBin(ts, 0));
  return { t: "or", alts };
}

const LEVELS = [["||"], ["&&"], ["==", "!=", "<", "<=", ">", ">="], ["mod"], ["+", "-"]];

function parseBin(ts, level) {
  if (level >= LEVELS.length) return parseUnary(ts);
  let a = parseBin(ts, level + 1);
  for (;;) {
    const op = LEVELS[level].find((o) => ts.is(o));
    if (!op) return a;
    ts.next();
    const b = parseBin(ts, level + 1);
    a = { t: "bin", op, a, b };
  }
}

function parseUnary(ts) {
  if (ts.eat("!")) return { t: "not", p: parseUnary(ts) };
  // -e is 0 - e (a place west of home: -6).
  if (ts.eat("-")) return { t: "bin", op: "-", a: { t: "lit", v: 0 }, b: parseUnary(ts) };
  return parsePostfix(ts);
}

function parsePostfix(ts) {
  let e = parsePrimary(ts);
  while (ts.is("{")) {
    ts.next();
    const fields = [];
    if (!ts.is("}")) {
      do {
        const f = ts.id();
        ts.want("=");
        fields.push([f, parseExpr(ts)]);
      } while (ts.eat(","));
    }
    ts.want("}");
    e = { t: "upd", e, fields };
  }
  return e;
}

function parseArgs(ts, close = ")") {
  const args = [];
  if (ts.eat(close)) return args;
  do args.push(parseExpr(ts));
  while (ts.eat(","));
  ts.want(close);
  return args;
}

function parsePrimary(ts) {
  const t = ts.next();
  if (t.t === "num") return { t: "lit", v: t.v };
  if (t.t === "sym") {
    if (t.v === "*") return { t: "keep" };
    if (t.v === "(") {
      // (e) groups; (e, f, …) is a tuple.
      const items = [parseExpr(ts)];
      while (ts.eat(",")) items.push(parseExpr(ts));
      ts.want(")");
      return items.length === 1 ? items[0] : { t: "con", c: tupleName(items.length), args: items };
    }
    if (t.v === "[") return { t: "list", items: parseArgs(ts, "]") };
    ts.fail(`unexpected '${t.v}'`);
  }
  if (t.t === "str") ts.fail("a string can't go here");
  const v = t.v;
  if (v === "_") return { t: "any" };
  if (v === "true" || v === "false") return { t: "lit", v: v === "true" };
  if (v === "none") return { t: "lit", v: null };
  if (DIRS.includes(v)) return { t: "lit", v };
  if (RESERVED.has(v)) ts.fail(`'${v}' can't go here`);
  if (ts.is("@")) {
    ts.next();
    return { t: "bind", n: v, p: parseUnary(ts) };
  }
  if (ts.is("(")) {
    ts.next();
    const args = parseArgs(ts);
    return /^[A-Z]/.test(v) ? { t: "con", c: v, args } : { t: "call", f: v, args };
  }
  return /^[A-Z]/.test(v) ? { t: "con", c: v, args: [] } : { t: "var", n: v };
}

// A cell: one expression for its one value, or, in a world whose cell has
// layers (cell Ground / Item), one per layer with `/` between them.
function parseCell(ts) {
  const first = parseExpr(ts);
  if (!ts.is("/")) return first;
  const items = [first];
  while (ts.eat("/")) items.push(parseExpr(ts));
  return { t: "layers", items };
}

// Expressions until the line ends or `stop`.
function parseCells(ts, stop) {
  const cells = [];
  while (!ts.done() && !ts.is(stop)) cells.push(parseCell(ts));
  return cells;
}

// ---- types ----

// A type. `vars`, if given, are the type parameters in scope (a declaration's
// <a, b>); without it, as in a fun's signature, any lowercase name is one.
//   Bool | Dir | Nat<k> | T | T<τ, …> | a | (τ, τ, …) | τ?
// `τ?` is sugar for Option<τ> (terms.js's prelude), kept as written so the
// editor can offer `none`.
export function parseType(ts, vars = null) {
  let ty;
  if (ts.eat("(")) {
    const items = [parseType(ts, vars)];
    while (ts.eat(",")) items.push(parseType(ts, vars));
    ts.want(")");
    ty = items.length === 1 ? items[0] : { k: "user", name: tupleName(items.length), args: items };
  } else {
    const n = ts.id();
    if (n === "Nat") {
      ts.want("<");
      const k = ts.next();
      if (k.t !== "num" || k.v < 1) ts.fail("Nat<k> needs a number k of at least 1");
      ts.want(">");
      ty = { k: "Nat", n: k.v };
    } else if (n === "Int") {
      // Int<lo, hi>: the whole numbers lo to hi, saturating as Nat does.
      const int = () => {
        const neg = ts.eat("-");
        const k = ts.next();
        if (k.t !== "num" || !Number.isInteger(k.v)) ts.fail("Int<lo, hi> needs two whole numbers");
        return neg ? -k.v : k.v;
      };
      ts.want("<");
      const lo = int();
      ts.want(",");
      const hi = int();
      ts.want(">");
      if (hi < lo) ts.fail("Int<lo, hi> needs lo <= hi");
      ty = { k: "Int", lo, hi };
    } else if (n === "Bool" || n === "Dir") ty = { k: n };
    else if (/^[a-z]/.test(n)) {
      if (vars && !vars.includes(n)) ts.fail(`no type parameter ${n}: a type is capitalized, and a parameter is declared, like type Box<${n}> = …`);
      ty = { k: "var", name: n };
    } else {
      const args = [];
      if (ts.eat("<")) {
        do args.push(parseType(ts, vars));
        while (ts.eat(","));
        ts.want(">");
      }
      ty = { k: "user", name: n, args };
    }
  }
  while (ts.eat("?")) ty = { k: "opt", of: ty };
  return ty;
}

// The constructor (and type) of n-tuples: "(,)" for pairs, "(,,)" for triples.
export const tupleName = (n) => `(${",".repeat(n - 1)})`;
export const isTuple = (c) => /^\(,+\)$/.test(c);

// Constructors, `|` between them. A field is `name: τ`, or just `τ`, which
// is named by its place: 0, 1, …
function parseCons(ts, cons, vars) {
  do {
    const c = ts.id();
    if (!/^[A-Z]/.test(c)) ts.fail(`a constructor starts with a capital: '${c}'`);
    cons.push({ c, fields: ts.eat("(") ? parseFields(ts, vars) : [] });
  } while (ts.eat("|"));
}

// Fields up to the closing ')'.
function parseFields(ts, vars) {
  const fields = [];
  if (!ts.is(")")) {
    do {
      const named = ts.peek()?.t === "id" && ts.is(":", 1);
      const name = named ? ts.id() : String(fields.length);
      if (named) ts.want(":");
      fields.push({ name, type: parseType(ts, vars) });
    } while (ts.eat(","));
  }
  ts.want(")");
  return fields;
}

// ---- the file ----

// Lines, each with its indent and text, blanks and comment lines dropped. A
// line's tokens are read when asked for: a map row is no tokens.
function lines(src) {
  const out = [];
  src.split("\n").forEach((raw, k) => {
    const t = raw.trim();
    if (!t || t.startsWith("//")) return;
    const no = k + 1;
    const L = { no, indent: raw.length - raw.trimStart().length, raw };
    let toks = null;
    Object.defineProperty(L, "toks", { get: () => (toks ??= lex(raw, no)) });
    out.push(L);
  });
  return out;
}

function str(ts) {
  const t = ts.next();
  if (t.t !== "str") ts.fail("expected a string in quotes");
  return t.v;
}

// The whole source: everything terms.js needs to build a world, as written.
// What a file or a level declares: types, patterns, funs, looks, recipes,
// registers and legends. A level's own are added to the file's when it is
// built (terms.js's build), and a later recipe with an earlier one's id
// replaces it.
const decls = () => ({ types: [], patterns: [], funs: [], looks: {}, recipes: [], regs: [], legend: [], drop: [] });
const newLevel = (id, name, line) => ({ id, name, intro: "", hint: "", par: null, map: [], goals: [], line, ...decls() });

// Modules a file can `use`: a function from a name (std/frog) to its text,
// set once by whoever loads them (content.js).
let modules = () => null;
export function setModules(f) {
  modules = f;
}

// The whole source: everything terms.js needs to build a world, as written.
// A file is shared declarations, then levels: `level id "Name"` starts one,
// and everything after it, recipes and types included, is that level's.
// `use m` brings module m's declarations in first, once.
export function parse(src, { used = new Set() } = {}) {
  const ast = { cell: null, levels: [], ...decls(), game: { name: "", by: "", about: "", won: "", flow: "pick", undo: true, score: null, defines: {}, hud: [], triggers: [], shops: [], blueprints: {} } };
  ast.level = newLevel("", "", null);
  let D = ast; // where declarations go: the file, or the current level
  const lvl = () => (D === ast ? ast.level : D);
  const ls = lines(src);
  let group = 0;
  let k = 0;
  const merge = (into, m) => {
    for (const key of ["types", "patterns", "funs", "regs", "legend"]) into[key].push(...m[key]);
    for (const r of m.recipes) addRecipe(into, r);
    into.drop.push(...m.drop);
    Object.assign(into.looks, m.looks);
    if (!ast.cell && m.cell) ast.cell = m.cell;
    // A game used as a module (use frontier) brings its game too: defines,
    // HUD, triggers, shops and blueprints, but not its name, words, flow,
    // score or levels. What this file says after the use is added after.
    const G = ast.game;
    const g = m.game;
    if (!g) return;
    Object.assign(G.defines, g.defines);
    Object.assign(G.blueprints, g.blueprints);
    G.hud.push(...g.hud);
    G.triggers.push(...g.triggers);
    for (const sh of g.shops) {
      const i = G.shops.findIndex((x) => x.id === sh.id);
      if (i >= 0) G.shops[i] = sh;
      else G.shops.push(sh);
    }
  };
  // The indented lines after line k.
  const body = () => {
    const out = [];
    while (k + 1 < ls.length && ls[k + 1].indent > 0) out.push(ls[++k]);
    return out;
  };
  for (; k < ls.length; k++) {
    const L = ls[k];
    if (L.indent > 0) throw new SyntaxError2("this line is indented, but nothing above it takes a body", L.no);
    const first = /^[a-z]+/.exec(L.raw.trim())?.[0];
    const ts = new Tokens(first === "legend" ? [] : L.toks, L.no);
    const word = first === "legend" ? "legend" : ts.id();
    if (GAME_WORDS.has(word)) {
      gameStatement(word, ts, L, body, ast, lvl, D === ast);
    } else if (word === "use") {
      // `use std/frog std/water`, maybe `except id …`: their declarations,
      // once each, before this file's.
      const names = [];
      while (!ts.done() && !ts.is("except")) {
        let n = ts.id();
        while (ts.eat("/")) n += `/${ts.id()}`;
        names.push(n);
      }
      if (ts.eat("except")) while (!ts.done()) D.drop.push(ts.id());
      for (const n of names) {
        if (used.has(n)) continue;
        used.add(n);
        const text = modules(n);
        if (text == null) ts.fail(`no module ${n}`);
        let m;
        try {
          m = parse(text, { used });
        } catch (err) {
          throw new SyntaxError2(`in ${n}: ${err.message}`, L.no);
        }
        merge(D, m);
      }
    } else if (word === "reg") {
      // `reg vein = 7`: a register, a number (or true or false) recipes can
      // read, `add` changes, and the game sets.
      const name = ts.id();
      ts.want("=");
      const neg = ts.eat("-");
      const t = ts.next();
      const v = t.t === "num" ? (neg ? -t.v : t.v) : t.v === "true" ? true : t.v === "false" ? false : ts.fail("a register starts as a number, true or false");
      D.regs.push({ name, v, line: L.no });
    } else if (word === "type") {
      const name = ts.id();
      const params = [];
      if (ts.eat("<")) {
        do {
          const a = ts.id();
          if (!/^[a-z]/.test(a)) ts.fail(`a type parameter is lowercase: '${a}'`);
          params.push(a);
        } while (ts.eat(","));
        ts.want(">");
      }
      // `type T += C | D` adds constructors to a type declared before (a
      // module's Item gains what another module brings).
      const extend = ts.eat("+");
      ts.want("=");
      const cons = [];
      // A product on its own, type Pos = (x: Nat<5>, y: Nat<5>), is one
      // constructor named as the type.
      if (ts.eat("(")) cons.push({ c: name, fields: parseFields(ts, params) });
      else parseCons(ts, cons, params);
      let rotates = null;
      const more = (t2) => {
        while (!t2.done()) {
          if (t2.eat("rotates")) {
            rotates = {};
            do {
              const a = t2.id();
              t2.want("->");
              rotates[a] = t2.id();
            } while (t2.eat(","));
          } else {
            t2.want("|");
            parseCons(t2, cons, params);
          }
        }
      };
      more(ts);
      for (const B of body()) more(new Tokens(B.toks, B.no));
      D.types.push({ name, params, cons, rotates, line: L.no, ...(extend ? { extend: true } : {}) });
    } else if (word === "cell") {
      // `cell T`, or `cell Ground / Item` for a cell of layers, each claimed
      // on its own: a recipe that writes only the item leaves the ground free.
      const layers = [ts.id()];
      while (ts.eat("/")) layers.push(ts.id());
      ast.cell = layers.length === 1 ? layers[0] : layers;
    } else if (word === "pattern") {
      const name = ts.id();
      // `pattern floor += Raft`: more alternatives for a pattern; `-=`:
      // fewer (a puzzle where Phibber can't stand on the track).
      const extend = ts.eat("+") ? "+" : ts.eat("-") ? "-" : null;
      ts.want("=");
      D.patterns.push({ name, p: parseExpr(ts), line: L.no, ...(extend ? { extend } : {}) });
      if (!ts.done()) ts.fail("more after the pattern");
    } else if (word === "fun") {
      const name = ts.id();
      ts.want(":");
      const sig = [parseType(ts)];
      while (ts.eat("->")) sig.push(parseType(ts));
      const f = { name, args: sig.slice(0, -1), ret: sig.at(-1), line: L.no };
      if (ts.eat("=")) {
        ts.want("[");
        f.table = parseArgs(ts, "]");
      } else {
        f.clauses = [];
        for (const B of body()) {
          const bt = new Tokens(B.toks, B.no);
          bt.want("|");
          const heads = [];
          let tuple = [];
          for (;;) {
            tuple.push(parseBin(bt, 0));
            if (bt.eat(",")) continue;
            heads.push(tuple);
            tuple = [];
            if (bt.eat("|")) continue;
            bt.want("=>");
            break;
          }
          const e = parseExpr(bt);
          for (const h of heads) f.clauses.push({ pats: h, e });
        }
        if (!f.clauses.length) ts.fail(`fun ${name} needs a table '= [...]' or cases '| ... => ...'`);
      }
      D.funs.push(f);
    } else if (word === "look") {
      const c = ts.id();
      const look = (D.looks[c] ??= {});
      while (!ts.done()) {
        const what = ts.id();
        if (!["color", "glyph", "label", "model"].includes(what)) ts.fail(`a look is color, glyph, label or model, not '${what}'`);
        look[what] = str(ts);
      }
    } else if (word === "group") {
      const t = ts.next();
      if (t.t !== "num") ts.fail("a group is a number");
      group = t.v;
    } else if (word === "recipe" || word === "yours") {
      let yours = false;
      if (word === "yours") {
        yours = true;
        ts.want("recipe");
      }
      const id = ts.id();
      const name = ts.done() || ts.is("in") ? id : str(ts);
      // `in reg`: the recipe runs only while that register is on.
      const inReg = ts.eat("in") ? ts.id() : null;
      const r = { id, name, group, on: null, before: [], after: [], where: null, chance: null, add: [], yours, in: inReg, line: L.no };
      for (const B of body()) {
        const bt = new Tokens(B.toks, B.no);
        const row = B.toks.some((t) => t.t === "sym" && t.v === "->");
        if (!row && bt.is("chance")) {
          // `chance 30%`: fires at a match only that often (terms.js's roll).
          bt.next();
          // A number, or a register's name: chance traffic%.
          const n = bt.next();
          if (n.t === "id") r.chance = n.v;
          else if (n.t !== "num" || n.v > 100) bt.fail("a chance is a percent: chance 30%");
          else r.chance = n.v;
          bt.eat("%");
        } else if (!row && bt.is("limit")) {
          // A level's bounds on a recipe the player draws:
          //   limit max 2x1 no fun no var only Frog Grass
          bt.next();
          const lim = (r.limit ??= {});
          while (!bt.done()) {
            const word = bt.id();
            if (word === "max") {
              const a = bt.next();
              const b = bt.next();
              const m = a.t === "num" && b.t === "id" && /^x(\d+)$/.exec(b.v);
              if (!m) bt.fail("limit max is a size, like max 2x1");
              lim.max = [a.v, Number(m[1])];
            } else if (word === "no") {
              const what = bt.id();
              if (what !== "fun" && what !== "var") bt.fail("limit no is fun or var");
              lim[what === "fun" ? "noFun" : "noVar"] = true;
            } else if (word === "only") {
              lim.only = [];
              while (!bt.done() && /^[A-Z]/.test(bt.peek().v)) lim.only.push(bt.id());
            } else bt.fail(`a limit is max, no or only, not '${word}'`);
          }
        } else if (!row && bt.is("add")) {
          // `add coins e`: when it fires, register coins grows by e.
          bt.next();
          r.add.push({ reg: bt.id(), e: parseExpr(bt) });
        } else if (bt.eat("on")) {
          r.on = parseExpr(bt);
        } else if (bt.eat("where")) {
          r.where = parseExpr(bt);
        } else {
          const before = parseCells(bt, "->");
          bt.want("->");
          const after = parseCells(bt, null);
          if (before.length !== after.length) bt.fail(`a row's two sides need as many cells: ${before.length} -> ${after.length}`);
          r.before.push(before);
          r.after.push(after);
        }
        if (!bt.done()) bt.fail(`more than expected: '${bt.peek().v}'`);
      }
      if (!r.before.length) ts.fail(`recipe ${id} has no rows`);
      if (r.before.some((row) => row.length !== r.before[0].length)) ts.fail(`recipe ${id}'s rows have different lengths`);
      addRecipe(D, r);
    } else if (word === "level") {
      // `level id "Name"`, or just `level "Name"` in a file of one level.
      // The id is a word, and may have hyphens (nt-museum): read off the line.
      const m = /^level\s+(?:([^\s"]+)\s+)?("(?:\\.|[^"\\])*")\s*(?:\/\/.*)?$/.exec(L.raw.trim());
      if (!m) ts.fail('a level is: level id "Name"');
      const id = m[1] ?? "";
      const lv = newLevel(id, JSON.parse(m[2]), L.no);
      ts.i = ts.toks.length;
      if (!ast.levels.length && !ast.level.map.length) Object.assign(lv, { ...ast.level, id, name: lv.name, line: L.no });
      ast.levels.push(lv);
      ast.level = ast.levels[0];
      D = lv;
      group = 0;
    } else if (word === "intro") {
      lvl().intro = str(ts);
    } else if (word === "hint") {
      lvl().hint = str(ts);
    } else if (word === "par") {
      // The moves the intended solution takes: fewer is a shortcut.
      const t = ts.next();
      if (t.t !== "num") ts.fail("par is a number of moves");
      lvl().par = t.v;
    } else if (word === "solution") {
      // A path that solves the level: N E S W hop, . waits, and n e s w
      // superhop. Tests play it; without a par, its length is the par.
      lvl().solution = str(ts);
    } else if (word === "map") {
      // The rows are the raw text: any character can be a legend's. In a
      // world of layers with a legend per layer, a row is a grid per layer,
      // side by side: ground, then items.
      lvl().map = body().map((B) => B.raw.trim());
    } else if (word === "legend") {
      // `legend c = cell`, or `legend ground c = value` for one layer's
      // grid: c is any one character, so read it off the raw line.
      const m = /^legend\s+(?:([a-z][A-Za-z0-9_]*)\s+)?(\S)\s+=(.*)$/.exec(L.raw.trim());
      if (!m) ts.fail("a legend is: legend c = value");
      const lt = new Tokens(lex(m[3], L.no), L.no);
      D.legend.push({ ch: m[2], cell: parseCell(lt), line: L.no, ...(m[1] ? { layer: m[1] } : {}) });
    } else if (word === "goal") {
      const cell = parseCell(ts);
      ts.want("at");
      const x = ts.next();
      ts.want(",");
      const y = ts.next();
      if (x.t !== "num" || y.t !== "num") ts.fail("a goal is: goal pattern at x, y");
      lvl().goals.push({ cell, x: x.v, y: y.v, line: L.no });
    } else {
      ts.fail(`'${word}' doesn't start anything`);
    }
    if (!["type", "fun", "recipe", "yours", "map", "legend", "goal", "pattern", "use", ...GAME_WORDS].includes(word) && !ts.done()) ts.fail(`more than expected: '${ts.peek().v}'`);
  }
  // A file of one level reads as before: its declarations are the file's.
  if (ast.levels.length === 1) {
    const lv = ast.levels[0];
    const own = { types: lv.types, patterns: lv.patterns, funs: lv.funs, looks: lv.looks, recipes: lv.recipes, regs: lv.regs, legend: lv.legend, drop: lv.drop };
    Object.assign(lv, decls());
    merge(ast, own);
  }
  return ast;
}

// ---- the game ----
//
// A file can also be a game: its name and words, how its levels run, a
// score, HUD lines, triggers that act after every tick, shops, and what
// each level does when it starts. Everything it changes is a register, so
// parameters and switched-on recipe sets are registers too.
//
//   game "Orchard"                  about "…"   won "…"   flow run|pick
//   score apples                    undo on|off
//   define left = daylight - tick   (a name for an expression, in the game's)
//   hud "sunset in" "{left}"        then: good e, warn e, max e, of e
//   once when apples >= 1           then actions; `when e` fires every tick
//   shop stall "The stall"          then intro, currency r, pick n, and
//     item legs "Strong legs" for 3   items with desc, needs e, repeat, actions
//   start                           (in a level) actions, as it begins
//
// Actions: r = e, r += e, r -= e, enable r, disable r, say "…", win "…",
// lose "…", level next|same|ID, shop ID, place VALUE N, pass N (the world
// runs N ticks, no key: a night), if e / else if e / else. Text fills in
// {expressions}.

const GAME_WORDS = new Set(["game", "by", "about", "won", "flow", "undo", "score", "define", "hud", "when", "once", "shop", "start", "gen", "endless", "blueprint", "thing", "without"]);

// The indented lines under a line, as a tree: each { line, kids }.
function tree(lines) {
  const out = [];
  const stack = [{ indent: -1, kids: out }];
  for (const B of lines) {
    while (stack.at(-1).indent >= B.indent) stack.pop();
    const node = { line: B, kids: [] };
    stack.at(-1).kids.push(node);
    stack.push({ indent: B.indent, kids: node.kids });
  }
  return out;
}

function gameStatement(word, ts, L, body, ast, lvl, top) {
  const G = ast.game;
  const text = () => str(ts);
  if (word === "game") G.name = text();
  else if (word === "by") G.by = text();
  else if (word === "about") G.about = text();
  else if (word === "won") G.won = text();
  else if (word === "flow") {
    G.flow = ts.id();
    if (G.flow !== "run" && G.flow !== "pick") ts.fail("flow is run (levels in order) or pick (choose one)");
  } else if (word === "undo") G.undo = ts.id() !== "off";
  else if (word === "score") G.score = parseExpr(ts);
  else if (word === "define") {
    const name = ts.id();
    ts.want("=");
    G.defines[name] = parseExpr(ts);
  } else if (word === "hud") {
    const h = { label: text(), text: text(), line: L.no };
    for (const B of body()) {
      const bt = new Tokens(B.toks, B.no);
      const k = bt.id();
      if (!["good", "warn", "max", "of"].includes(k)) bt.fail(`a hud line takes good, warn, max or of, not '${k}'`);
      h[k] = parseExpr(bt);
    }
    G.hud.push(h);
  } else if (word === "when" || word === "once") {
    if (word === "once") ts.want("when");
    G.triggers.push({ once: word === "once", when: parseExpr(ts), do: actions(tree(body())), line: L.no });
  } else if (word === "shop") {
    const sh = { id: ts.id(), name: "", intro: "", currency: null, pick: 0, items: [], line: L.no };
    sh.name = ts.done() ? sh.id : text();
    for (const node of tree(body())) {
      const bt = new Tokens(node.line.toks, node.line.no);
      const k = bt.id();
      if (k === "intro") sh.intro = str(bt);
      else if (k === "currency") sh.currency = bt.id();
      else if (k === "pick") sh.pick = bt.next().v;
      else if (k === "item") {
        const it = { id: bt.id(), name: "", cost: null, desc: "", needs: null, repeat: false, do: [] };
        it.name = str(bt);
        bt.want("for");
        it.cost = parseExpr(bt);
        const rest = [];
        for (const kid of node.kids) {
          const kt = new Tokens(kid.line.toks, kid.line.no);
          if (kt.eat("desc")) it.desc = str(kt);
          else if (kt.eat("needs")) it.needs = parseExpr(kt);
          else if (kt.eat("repeat")) it.repeat = true;
          else rest.push(kid);
        }
        it.do = actions(rest);
        sh.items.push(it);
      } else bt.fail(`a shop takes intro, currency, pick or item, not '${k}'`);
    }
    G.shops.push(sh);
  } else if (word === "without") {
    // `without leap burnout`: those recipes aren't here (a level of a
    // game where the furnace never crumbles).
    while (!ts.done()) (top ? ast : lvl()).drop.push(ts.id());
  } else if (word === "thing") {
    if (top) ts.fail("a thing stands in a level");
    (lvl().things ??= []).push(thing(L.raw, ts));
  } else if (word === "start") {
    if (top) ts.fail("start goes in a level");
    lvl().start = actions(tree(body()));
  } else if (word === "gen") {
    // `gen 16 x 11`, then its steps: the level's map, drawn from the seed.
    if (top) ts.fail("gen goes in a level");
    const W = parseBin(ts, 0);
    const xs = ts.id();
    if (xs !== "x") ts.fail("a gen is: gen W x H");
    const land = newLand();
    lvl().gen = { W, H: parseBin(ts, 0), steps: genSteps(tree(body()), land) };
    if (hasLand(land)) lvl().gen.land = land;
  } else if (word === "endless") {
    // `endless`, maybe `chunk 16 window 5`, then the land's rules: a
    // level without a size, every cell grown from the seed and where it is.
    if (top) ts.fail("endless goes in a level");
    const e = { chunk: 16, window: 5, land: newLand(), line: L.no };
    while (!ts.done()) {
      const k = ts.id();
      if (k !== "chunk" && k !== "window") ts.fail(`endless takes chunk and window, not '${k}'`);
      const t = ts.next();
      if (t.t !== "num") ts.fail(`${k} is a number`);
      e[k] = t.v;
    }
    if (!(e.chunk >= 4 && e.chunk <= 64)) ts.fail("a chunk is 4 to 64 cells a side");
    if (![3, 5, 7, 9].includes(e.window)) ts.fail("a window is 3, 5, 7 or 9 chunks a side");
    for (const node of tree(body())) if (!landLine(node, e.land)) new Tokens(node.line.toks, node.line.no).fail(`an endless level takes field, zone, place, sites and layer, not '${node.line.toks[0]?.v}'`);
    lvl().endless = e;
  } else if (word === "blueprint") {
    // `blueprint name`, then rows of a little map, a grid a layer side by
    // side as a map's; a grid in quotes may hold spaces, which leave the
    // land as it is.
    const name = ts.id();
    const rows = body().map((B) => [...B.raw.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]));
    if (!rows.length) ts.fail(`blueprint ${name} has no rows`);
    G.blueprints[name] = { name, rows, line: L.no };
  }
}

// ---- land ----
//
// Land written as rules, under a gen or an endless (land.js grows it):
//
//   field wet blob 150 [seed e]      smooth noise: blob, noise or lattice
//   zone ring by e                   bands, each name its number
//     meadow 0
//     highlands 48
//   place home at -6, -6 [turns e]   a blueprint at a spot
//   sites 32 [margin 2]              at most one blueprint a 32×32 square
//     RULE …                           (its values are blueprint names)
//   layer ground [on P]              each cell, the first rule that holds
//     RULE …                           writes this layer
//
// A RULE is V, nothing, `V along FIELD at e width e` (a river, whose V
// reads `flow`, the way along it), or `pick V n%, V n%` / `pick by ZONE`
// with a row a band; then `chance n%` and `where e`.
const newLand = () => ({ fields: [], zones: [], places: [], sites: null, layers: [] });
const hasLand = (L) => L.fields.length || L.zones.length || L.places.length || L.sites || L.layers.length;

function percent(ts) {
  const t = ts.next();
  if (t.t !== "num" || t.v > 100) ts.fail("a chance is a percent, like 2.5%");
  ts.want("%");
  return t.v;
}

// A land line (and its kids), into land; false if it isn't one.
function landLine({ line, kids }, land) {
  const ts = new Tokens(line.toks, line.no);
  const w = ts.peek()?.v;
  if (!["field", "zone", "place", "sites", "layer"].includes(w)) return false;
  ts.next();
  if (w === "field") {
    const f = { name: ts.id(), noise: ts.id(), line: line.no };
    if (!["blob", "noise", "lattice"].includes(f.noise)) ts.fail("a field is blob, noise or lattice, then its scale");
    f.scale = parseBin(ts, 0);
    if (ts.eat("seed")) f.seed = parseExpr(ts);
    land.fields.push(f);
  } else if (w === "zone") {
    const z = { name: ts.id(), bands: [], line: line.no };
    ts.want("by");
    z.by = parseExpr(ts);
    for (const k of kids) {
      const bt = new Tokens(k.line.toks, k.line.no);
      const name = bt.id();
      const neg = bt.eat("-");
      const t = bt.next();
      if (t.t !== "num") bt.fail("a band is a name and where it starts: highlands 48");
      if (z.bands.length && !(t.v > z.bands.at(-1)[1])) bt.fail("each band starts higher than the one before");
      z.bands.push([name, neg ? -t.v : t.v]);
    }
    if (!z.bands.length) ts.fail(`zone ${z.name} needs bands`);
    land.zones.push(z);
  } else if (w === "place") {
    const p = { bp: ts.id(), line: line.no };
    ts.want("at");
    p.x = parseBin(ts, 0);
    ts.want(",");
    p.y = parseBin(ts, 0);
    if (ts.eat("turns")) p.turns = parseBin(ts, 0);
    land.places.push(p);
  } else if (w === "sites") {
    const t = ts.next();
    if (t.t !== "num") ts.fail("sites takes the size of its squares: sites 32");
    const s = { size: t.v, margin: 0, rules: landRules(kids, true), line: line.no };
    if (ts.eat("margin")) s.margin = ts.next().v;
    land.sites = s;
  } else {
    const L = { layer: ts.id(), on: null, rules: landRules(kids, false), line: line.no };
    if (ts.eat("on")) L.on = parseExpr(ts);
    land.layers.push(L);
  }
  if (!ts.done()) ts.fail(`more than expected: '${ts.peek().v}'`);
  return true;
}

// A layer's rules (or, with names, a sites's, whose values are blueprints).
function landRules(nodes, names) {
  const value = (ts) => (ts.is("nothing") ? (ts.next(), "nothing") : names ? ts.id() : parseExpr(ts));
  const entries = (ts) => {
    const out = [];
    do {
      const v = value(ts);
      out.push([v, percent(ts)]);
    } while (ts.eat(","));
    return out;
  };
  const tail = (ts, r) => {
    while (!ts.done()) {
      if (ts.eat("chance")) r.chance = percent(ts);
      else if (ts.eat("where")) r.where = parseExpr(ts);
      else ts.fail(`a rule takes chance and where, not '${ts.peek().v}'`);
    }
  };
  return nodes.map(({ line, kids }) => {
    const ts = new Tokens(line.toks, line.no);
    const r = { line: line.no };
    if (ts.eat("pick")) {
      r.pick = { by: null, rows: [] };
      if (ts.eat("by")) {
        r.pick.by = ts.id();
        tail(ts, r);
        for (const k of kids) {
          const bt = new Tokens(k.line.toks, k.line.no);
          r.pick.rows.push({ band: bt.id(), entries: entries(bt) });
          if (!bt.done()) bt.fail(`more than expected: '${bt.peek().v}'`);
        }
      } else {
        r.pick.rows.push({ band: null, entries: entries(ts) });
        tail(ts, r);
      }
      for (const row of r.pick.rows) if (row.entries.reduce((a, [, p]) => a + p, 0) > 100 + 1e-9) ts.fail("a pick's percents add up to more than 100");
      return r;
    }
    r.v = value(ts);
    if (!names && ts.eat("along")) {
      r.along = { field: ts.id() };
      ts.want("at");
      r.along.at = parseBin(ts, 0);
      ts.want("width");
      r.along.width = parseBin(ts, 0);
    }
    tail(ts, r);
    return r;
  });
}

// A generator's steps (a tree of lines):
//   seed e                      the dice roll from e from here on
//   let a = e, b = e            names, for the steps after
//   fill V [where e] [chance n%]  every cell where e holds, in V's layer
//   put V at x, y
//   scatter n V [where e]       n cells, at random, where e holds
//   if e / else if e / else
function genSteps(nodes, land = null) {
  const out = [];
  for (let n = 0; n < nodes.length; n++) {
    const { line, kids } = nodes[n];
    // Land rules (above) go first, whatever their place among the steps.
    if (land && landLine(nodes[n], land)) continue;
    const ts = new Tokens(line.toks, line.no);
    const w = ts.id();
    if (w === "if") {
      const a = { t: "if", c: parseExpr(ts), then: genSteps(kids), else: [] };
      out.push(a);
      let at = a;
      while (n + 1 < nodes.length && nodes[n + 1].line.toks[0]?.v === "else") {
        const nx = nodes[++n];
        const et = new Tokens(nx.line.toks, nx.line.no);
        et.want("else");
        if (et.eat("if")) {
          const b = { t: "if", c: parseExpr(et), then: genSteps(nx.kids), else: [] };
          at.else = [b];
          at = b;
        } else at.else = genSteps(nx.kids);
      }
      continue;
    }
    const s = { t: w, line: line.no };
    if (w === "seed") {
      // `seed e`: the dice roll from e from here on (a day's own map).
      s.e = parseExpr(ts);
    } else if (w === "let") {
      s.lets = [];
      do {
        const name = ts.id();
        ts.want("=");
        s.lets.push([name, parseExpr(ts)]);
      } while (ts.eat(","));
    } else if (w === "fill" || w === "scatter") {
      if (w === "scatter") s.n = parseBin(ts, 0);
      s.v = parseExpr(ts);
      while (!ts.done()) {
        if (ts.eat("where")) s.where = parseExpr(ts);
        else if (ts.eat("chance")) {
          s.chance = ts.next().v;
          ts.eat("%");
        } else ts.fail(`a ${w} takes where or chance, not '${ts.peek().v}'`);
      }
    } else if (w === "put") {
      s.v = parseExpr(ts);
      ts.want("at");
      s.x = parseBin(ts, 0);
      ts.want(",");
      s.y = parseBin(ts, 0);
    } else ts.fail(`a gen step is seed, let, fill, put, scatter or if, not '${w}'`);
    if (!ts.done()) ts.fail(`more than expected: '${ts.peek().v}'`);
    out.push(s);
  }
  return out;
}

// thing ID ["Title"] at X, Y [size WxH] [door X, Y] [to ID] [href "U"]
//   [prop ID] [sign "S"] [color ID|#rrggbb] [hint "H"] [line "L"]
//   [unlock ID] [action ID] [local] [external] [hidden], and any flag a
//   host adds with addThingFlags()
// Something that stands on a level: a building, a portal, a piece of
// furniture. Its cells are rock to the engine (terms.js's levelOf), and the
// host draws it. `door` is the cell in front of it where a frog stands to
// use it, south of its middle unless said; `to` is a level or world it
// leads to, `href` a page; the rest is for the host to draw and say. As
// JSON, Automata's shape: { id, title, at: [x, y, w, h], door: [x, y], … }.
const THING_WORDS = { to: "word", href: "str", prop: "word", sign: "str", color: "word", hint: "str", line: "str", unlock: "word", action: "word" };
const THING_FLAGS = ["local", "external", "hidden"];
/** Lets a host's things carry flags of its own: thing … [flag]. */
export function addThingFlags(...flags) {
  for (const f of flags) if (!THING_FLAGS.includes(f)) THING_FLAGS.push(f);
}
function thing(raw, ts) {
  // Data, not expressions: words split on spaces (puzzle-0 and #c6ff3a are
  // words), "strings" whole, and X, Y or X,Y for a cell.
  const w = [...raw.trim().matchAll(/"(?:\\.|[^"\\])*"|[^\s,]+|,/g)].map((m) => m[0]).slice(1);
  let k = 0;
  const strOf = (x) => (x?.startsWith('"') ? JSON.parse(x) : ts.fail(`expected a string in quotes, found ${x ?? "nothing"}`));
  const t = { id: w[k++] };
  if (!t.id || t.id.startsWith('"')) ts.fail("a thing needs an id: thing ID at X, Y");
  if (w[k]?.startsWith('"')) t.title = strOf(w[k++]);
  const cell = (what) => {
    const x = Number(w[k++]);
    if (w[k] === ",") k++;
    const y = Number(w[k++]);
    if (!Number.isInteger(x) || !Number.isInteger(y)) ts.fail(`${what} takes a cell: ${what} X, Y`);
    return [x, y];
  };
  let at = null;
  let size = [1, 1];
  let door = null;
  const rest = {};
  while (k < w.length) {
    const key = w[k++];
    if (key === "at") at = cell("at");
    else if (key === "door") door = cell("door");
    else if (key === "size") {
      const m = /^(\d+)x(\d+)$/.exec(w[k++] ?? "");
      if (!m) ts.fail("size takes WxH, like size 5x3");
      size = [+m[1], +m[2]];
    } else if (THING_WORDS[key] === "str") rest[key] = strOf(w[k++]);
    else if (THING_WORDS[key] === "word") {
      if (w[k] == null || w[k].startsWith('"')) ts.fail(`${key} takes a name`);
      rest[key] = w[k++];
    } else if (THING_FLAGS.includes(key)) rest[key] = true;
    else ts.fail(`a thing doesn't know ${key}`);
  }
  if (!at) ts.fail(`${t.id} needs a place: at X, Y`);
  t.at = [...at, ...size];
  t.door = door ?? [at[0] + Math.floor((size[0] - 1) / 2), at[1] + size[1]];
  return Object.assign(t, rest);
}

// Action lines (a tree) as actions.
function actions(nodes) {
  const out = [];
  for (let n = 0; n < nodes.length; n++) {
    const { line, kids } = nodes[n];
    const ts = new Tokens(line.toks, line.no);
    const first = ts.peek();
    const one = (a) => {
      if (!ts.done()) ts.fail(`more than expected: '${ts.peek().v}'`);
      out.push({ ...a, line: line.no });
    };
    if (ts.eat("if")) {
      const a = { t: "if", c: parseExpr(ts), then: actions(kids), else: [] };
      out.push(a);
      // else if / else, as the lines after.
      let at = a;
      while (n + 1 < nodes.length && nodes[n + 1].line.toks[0]?.v === "else") {
        const nx = nodes[++n];
        const et = new Tokens(nx.line.toks, nx.line.no);
        et.want("else");
        if (et.eat("if")) {
          const b = { t: "if", c: parseExpr(et), then: actions(nx.kids), else: [] };
          at.else = [b];
          at = b;
        } else at.else = actions(nx.kids);
      }
      continue;
    }
    if (first?.t !== "id") ts.fail("an action starts with a word");
    const w = ts.id();
    if (w === "say" || w === "win" || w === "lose") one({ t: w, text: str(ts) });
    else if (w === "level") {
      const t = ts.peek();
      one({ t: "level", to: t?.t === "id" && ["next", "same"].includes(t.v) ? ts.id() : t?.t === "id" && ts.toks.length === 2 ? ts.id() : parseExpr(ts) });
    } else if (w === "shop") one({ t: "shop", id: ts.id() });
    else if (w === "pass") one({ t: "pass", n: parseExpr(ts) });
    else if (w === "enable" || w === "disable") one({ t: "set", reg: ts.id(), op: "=", e: { t: "lit", v: w === "enable" } });
    else if (w === "place") {
      const what = parseExpr(ts);
      one({ t: "place", what, n: ts.done() ? { t: "lit", v: 1 } : parseExpr(ts) });
    } else {
      // r = e, r += e, r -= e
      const op = ts.eat("+") ? "+=" : ts.eat("-") ? "-=" : "=";
      ts.want("=");
      one({ t: "set", reg: w, op, e: parseExpr(ts) });
    }
  }
  return out;
}

// A recipe added to declarations: one with an earlier one's id replaces it
// where it stood.
function addRecipe(D, r) {
  const i = D.recipes.findIndex((x) => x.id === r.id);
  if (i >= 0) D.recipes[i] = r;
  else D.recipes.push(r);
}

// One recipe on its own, as the editor's text box holds it: `recipe ...` and
// its rows. The group comes from the line `group N` if there is one.
export function parseRecipe(src) {
  const ast = parse(src);
  if (ast.recipes.length !== 1) throw new SyntaxError2("write exactly one recipe");
  const r = ast.recipes[0];
  const g = /^\s*group\s+(\d+)/m.exec(src);
  if (g) r.group = Number(g[1]);
  return r;
}

// An expression from a line's tokens (a game's {text}).
export function parseExpr2(toks) {
  const ts = new Tokens(toks, null);
  const e = parseExpr(ts);
  if (!ts.done()) ts.fail(`more than expected: '${ts.peek().v}'`);
  return e;
}

// One cell, as the editor's per-cell box holds it.
export function parseCellText(src) {
  const ts = new Tokens(lex(src), null);
  const cell = parseCell(ts);
  if (!ts.done()) ts.fail(`more than one cell: '${ts.peek().v}'`);
  return cell;
}

// ---- printing: print.js, which quilt/print.ts.quilt writes ----

export { printCell, printExpr, printRecipe, printType, printValue } from "./print.js";
