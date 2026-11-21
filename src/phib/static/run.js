// A game played: a file of levels (syntax.js's game statements) run one
// level at a time through terms.js. A Run keeps the registers from level to
// level, runs each level's `start`, checks the triggers after every tick,
// opens shops, and says what the HUD shows. It decides nothing about cells:
// recipes do that. Plain JS, so node runs it too.
//
//   const run = new Run(parse(src), { seed: 7 });
//   run.play("E");            // a hop; null waits; { d: "E", far: true } superhops
//   run.state                 // "play", "shop", "won" or "lost"
//   run.hud()                 // [{ label, text, good, warn, frac }]
//
// What happens comes back from play() as messages: { say }, { win }, { lose },
// { shop }, { level }, and in an endless level { shift: { sx, sy } }: the
// window moved that many cells under Phibber (land.js).
//
// Expressions also call px() and py(), where Phibber is (from home, in an
// endless level), and near(C, r), how many cells within r of him hold a C
// (a constructor, on any layer, at any depth: near(Crystal, 9)).

import { lex, parseExpr2, printValue } from "./syntax.js";
import { generate } from "./gen.js";
import { Land } from "./land.js";
import { build, evalT, solved, start, step } from "./terms.js";

export class Run {
  constructor(ast, { seed = 0, level = 0, saved = null, compile = null } = {}) {
    this.ast = ast;
    this.compile = compile; // compile(w), if given, readies each level's world (compile.js)
    this.G = ast.game;
    this.seed = seed;
    this.once = new Set();
    this.out = [];
    this.shop = null;
    if (saved) {
      this.load(saved);
      return;
    }
    this.regs = null;
    this.startLevel(level, this.out);
  }

  // ---- levels ----

  startLevel(n, out = []) {
    const levels = this.ast.levels;
    if (n >= levels.length) {
      this.state = "won";
      out.push({ win: this.text(this.G.won || "You finished the game") });
      return out;
    }
    this.level = n;
    this.w = build(this.ast, n);
    this.compile?.(this.w);
    // Registers carry on from level to level; a level's own start with it.
    this.st = start(this.w, { seed: this.seed, regs: this.regs ?? {} });
    this.regs = this.st.regs;
    // A level its gen draws, from the seed and what the registers say now.
    if (this.w.level.gen) this.st = { ...this.st, board: generate(this.w, this.expand(this.w.level.gen), { seed: this.seed, level: n, regs: this.regs, blueprints: this.G.blueprints }) };
    // An endless level: the window of its land round home.
    this.land = null;
    if (this.w.level.endless) {
      this.land = this.newLand();
      this.st = { ...this.st, board: this.land.build(0, 0) };
    }
    this.state = "play";
    this.moves = 0;
    out.push({ level: n });
    this.exec(levels[n].start ?? [], out);
    return out;
  }

  // The land sees the world's first registers, not today's: it must grow
  // the same whenever Phibber comes back.
  newLand(saved = null) {
    return new Land(this.w, this.expand(this.w.level.endless), { seed: this.seed, regs: this.w.regs0, blueprints: this.G.blueprints, saved });
  }

  get L() {
    return this.ast.levels[this.level];
  }

  // ---- a tick ----

  // A key (a Dir, or { d, far }) or null to wait: one tick, then what it set off.
  play(key = null) {
    if (this.state !== "play") return [];
    const input = key == null ? null : typeof key === "string" ? { d: key, far: false } : key;
    this.st = step(this.w, { ...this.st, regs: this.regs }, input);
    this.regs = this.st.regs;
    this.moves++;
    const shift = this.follow();
    const out = this.afterTick();
    return shift ? [{ shift }, ...out] : out;
  }

  // In an endless level, the window follows Phibber: what this tick fired
  // and moved, in the new window's cells.
  follow() {
    const f = this.land?.follow(this.st.board);
    if (!f) return null;
    const { sx, sy, board } = f;
    const map = (i) => Land.remap(i, sx, sy, this.land.SPAN);
    const moves = (this.st.moves ?? []).map((m) => ({ from: [map(m.from[0]), m.from[1]], to: [map(m.to[0]), m.to[1]] })).filter((m) => m.from[0] >= 0 && m.to[0] >= 0);
    const fired = (this.st.fired ?? []).map((m) => ({ ...m, cells: m.cells.map(map).filter((i) => i >= 0) })).filter((m) => m.cells.length);
    this.st = { ...this.st, board, moves, fired, shift: { sx, sy } };
    return { sx, sy };
  }

  // Where the window's corner is on the map.
  get origin() {
    return this.land ? this.land.origin : { x: 0, y: 0 };
  }

  afterTick() {
    const out = [];
    if (this.w.level.goals.length && solved(this.w, this.st)) {
      // A level with goals is won when they hold; in a run of levels, the
      // next one begins.
      out.push({ win: this.text(this.L.won || "Solved") });
      if (this.G.flow === "run") this.startLevel(this.level + 1, out);
      else this.state = "won";
      return out;
    }
    this.G.triggers.forEach((t, n) => {
      if (this.state !== "play") return;
      if (t.once && this.once.has(n)) return;
      if (!this.val(t.when)) return;
      if (t.once) this.once.add(n);
      this.exec(t.do, out);
    });
    return out;
  }

  // ---- actions ----

  // Runs actions; true if one ended play here (a win, a loss, a shop, a
  // level), after which the rest wait (a shop) or are dropped.
  exec(list, out) {
    for (let n = 0; n < list.length; n++) {
      const a = list[n];
      if (a.t === "set") {
        const v = this.val(a.e);
        const was = this.regs[a.reg] ?? 0;
        this.setReg(a.reg, a.op === "+=" ? was + v : a.op === "-=" ? was - v : v);
      } else if (a.t === "say") out.push({ say: this.text(a.text) });
      else if (a.t === "pass") {
        // The world runs on, no key and no triggers: a night.
        for (let k = this.val(a.n); k > 0; k--) {
          this.st = step(this.w, { ...this.st, regs: this.regs }, null);
          this.regs = this.st.regs;
          const shift = this.follow();
          if (shift) out.push({ shift });
        }
      }
      else if (a.t === "if") {
        if (this.exec(this.val(a.c) ? a.then : a.else, out)) return true;
      } else if (a.t === "place") this.place(a.what, this.val(a.n));
      else if (a.t === "win" || a.t === "lose") {
        this.state = a.t === "win" ? "won" : "lost";
        out.push({ [a.t]: this.text(a.text) });
        return true;
      } else if (a.t === "shop") {
        this.openShop(a.id, list.slice(n + 1));
        out.push({ shop: a.id });
        return true;
      } else if (a.t === "level") {
        const to = a.to;
        const ids = this.ast.levels.map((l) => l.id);
        const n2 = to === "next" ? this.level + 1 : to === "same" ? this.level : typeof to === "string" ? ids.indexOf(to) : this.val(to);
        if (n2 < 0) throw new Error(`no level ${to}`);
        this.startLevel(n2, out);
        return true;
      }
    }
    return false;
  }

  setReg(name, v) {
    this.regs = { ...this.regs, [name]: v };
    this.st = { ...this.st, regs: this.regs };
  }

  // Puts n of an item on the free grass nearest Phibber (a shop's gift).
  place(what, n) {
    const w = this.w;
    const { W, H } = w.level;
    const L = w.L;
    const v = evalT(w, what, {}, 0);
    const board = [...this.st.board];
    const item = L - 1;
    let at = board.findIndex((x, s) => s % L === item && x.c === "Frog");
    at = at < 0 ? 0 : (at - item) / L;
    const seen = new Set([at]);
    const queue = [at];
    while (queue.length && n > 0) {
      const i = queue.shift();
      if (board[i * L + item].c === "Empty" && board[i * L].c === "Grass") {
        board[i * L + item] = v;
        n--;
      }
      const x = i % W;
      const y = (i - x) / W;
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(ny * W + nx)) continue;
        seen.add(ny * W + nx);
        queue.push(ny * W + nx);
      }
    }
    this.st = { ...this.st, board };
  }

  // ---- shops ----

  openShop(id, rest) {
    const sh = this.G.shops.find((s) => s.id === id);
    if (!sh) throw new Error(`no shop ${id}`);
    let items = sh.items.filter((it) => (it.repeat || !this.once.has(`buy:${it.id}`)) && (!it.needs || this.val(it.needs)));
    if (sh.pick > 0 && items.length > sh.pick) {
      // A pick the seed and the day choose, the same each time.
      let h = (this.seed * 31 + this.level * 977 + (this.regs.day ?? 0) * 7) >>> 0;
      const rnd = () => ((h = (Math.imul(h, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
      items = [...items].sort(() => rnd() - 0.5).slice(0, sh.pick);
    }
    this.shop = { id, name: sh.name, intro: sh.intro, currency: sh.currency, offers: items.map((it) => it.id), rest };
    this.state = "shop";
  }

  offer(id) {
    const it = this.G.shops.find((s) => s.id === this.shop.id).items.find((x) => x.id === id);
    return { ...it, price: this.val(it.cost) };
  }

  buy(id) {
    if (this.state !== "shop" || !this.shop.offers.includes(id)) return false;
    const it = this.offer(id);
    const cur = this.shop.currency;
    if (cur && (this.regs[cur] ?? 0) < it.price) return false;
    if (cur) this.setReg(cur, (this.regs[cur] ?? 0) - it.price);
    this.exec(it.do, this.out);
    if (!it.repeat) {
      this.once.add(`buy:${id}`);
      this.shop.offers = this.shop.offers.filter((x) => x !== id);
    }
    return true;
  }

  leaveShop() {
    if (this.state !== "shop") return [];
    const rest = this.shop.rest;
    this.shop = null;
    this.state = "play";
    const out = [];
    this.exec(rest, out);
    return out;
  }

  // ---- what the game says ----

  // The value of an expression: registers, the tick, the level, the seed,
  // and the game's defines.
  val(e) {
    const env = { ...this.regs, tick: this.st.tick, level: this.level, seed: this.seed, moves: this.moves };
    const w = this.w;
    const was = w.genFns;
    w.genFns = this.fns();
    try {
      return evalT(w, this.expand(e), env, 0);
    } finally {
      w.genFns = was;
    }
  }

  // Where Phibber is on the board, as a cell, or -1.
  frogCell() {
    if (this.frogAt?.board === this.st.board) return this.frogAt.i;
    const L = this.w.L;
    const b = this.st.board;
    let i = -1;
    for (let s = L - 1; s < b.length; s += L) {
      if (b[s].c === "Frog") {
        i = (s - L + 1) / L;
        break;
      }
    }
    this.frogAt = { board: b, i };
    return i;
  }

  fns() {
    const { W, H } = this.w.level;
    const L = this.w.L;
    const o = this.origin;
    const at = () => {
      const i = this.frogCell();
      return i < 0 ? [0, 0] : [i % W, Math.floor(i / W)];
    };
    const has = (v, c) => !!v && typeof v === "object" && (v.c === c || v.a?.some((x) => has(x, c)));
    return {
      px: () => o.x + at()[0],
      py: () => o.y + at()[1],
      near: (v, r) => {
        if (this.frogCell() < 0) return 0;
        const [fx, fy] = at();
        const b = this.st.board;
        let n = 0;
        for (let y = Math.max(0, fy - r); y <= Math.min(H - 1, fy + r); y++) {
          for (let x = Math.max(0, fx - r); x <= Math.min(W - 1, fx + r); x++) {
            for (let l = 0; l < L; l++) if (has(b[(y * W + x) * L + l], v.c)) n++;
          }
        }
        return n;
      },
    };
  }

  expand(e) {
    const D = this.G.defines;
    const go = (x) => {
      if (!x || typeof x !== "object") return x;
      if (Array.isArray(x)) return x.map(go);
      if (x.t === "var" && D[x.n]) return go(D[x.n]);
      const out = {};
      for (const [k, v] of Object.entries(x)) out[k] = typeof v === "object" ? go(v) : v;
      return out;
    };
    return Object.keys(D).length ? go(e) : e;
  }

  // Text with {expressions} filled in.
  text(s) {
    return String(s).replace(/\{([^}]*)\}/g, (_, x) => {
      const v = this.val(parseExpr2(lex(x)));
      return typeof v === "number" ? String(Math.round(v * 100) / 100) : v && typeof v === "object" ? printValue(v) : String(v);
    });
  }

  score() {
    return this.G.score ? this.val(this.G.score) : null;
  }

  hud() {
    return this.G.hud.map((h) => {
      const max = h.max ? this.val(h.max) : null;
      const of = h.of ? this.val(h.of) : null;
      return {
        label: h.label,
        text: this.text(h.text),
        good: !!(h.good && this.val(h.good)),
        warn: !!(h.warn && this.val(h.warn)),
        frac: max ? Math.max(0, Math.min(1, of / max)) : null,
      };
    });
  }

  // ---- saving ----

  save() {
    const s = { seed: this.seed, level: this.level, regs: this.regs, once: [...this.once], state: this.state, moves: this.moves, tick: this.st.tick, board: this.st.board, shop: this.shop };
    // An endless level keeps only the chunks Phibber changed.
    if (this.land) Object.assign(s, { board: null, land: this.land.save(this.st.board), at: [this.land.ccx, this.land.ccy] });
    return s;
  }

  load(s) {
    this.seed = s.seed;
    this.level = s.level;
    this.w = build(this.ast, s.level);
    this.compile?.(this.w);
    this.regs = s.regs;
    this.once = new Set(s.once);
    this.state = s.state;
    this.moves = s.moves;
    const st = start(this.w, { seed: s.seed, regs: s.regs });
    this.st = { ...st, tick: s.tick, board: s.board ?? st.board };
    this.shop = s.shop;
    this.land = null;
    if (this.w.level.endless) {
      this.land = this.newLand(s.land);
      this.st = { ...this.st, board: this.land.build(...s.at) };
    }
  }
}
