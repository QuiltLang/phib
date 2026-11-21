// Recipes as pictures you can draw. A recipe card shows the Before cells, an
// arrow, and the After cells, each drawn by picture.js; on a recipe that is
// yours, a click paints the palette's brush into a cell, where its type
// fits (a Thing goes in On's thing), a right click (or a long press) picks
// what the cell holds up as the brush, and the cell's text and the whole
// recipe's text can be typed instead. All of it edits one AST
// (syntax.js's), so the picture and the text are always the same recipe.

import { codeOverlay, highlightHtml } from "./highlight.js";
import { draw, drawCell, fitCanvas, varColor } from "./picture.js";
import { DIRS, isTuple, parseCellText, parseRecipe, printCell, printExpr, printRecipe } from "./syntax.js";

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};

const ANY = { t: "any" };
const KEEP = { t: "keep" };

// An expression made fit for a side: `_` can't be written, so on the After
// side it becomes `*` (keep); on the Before side a `*` inside is `_`.
export function forSide(e, side) {
  if (!e || typeof e !== "object") return e;
  if (side === "after" && e.t === "any") return KEEP;
  const sub = (x) => (x.t === "keep" && side === "before" ? ANY : forSide(x, side));
  switch (e.t) {
    case "con":
      return { ...e, args: e.args.map(sub) };
    case "or":
      return { ...e, alts: e.alts.map(sub) };
    case "not":
    case "bind":
      return { ...e, p: sub(e.p) };
  }
  return e;
}

// What a field's value can be, as expressions to pick from.
function optionsFor(w, ty, side) {
  const out = [];
  if (side === "before") out.push(["_ anything", ANY]);
  else out.push(["* keep", KEEP]);
  if (ty.k === "opt") {
    out.push(["none", { t: "lit", v: null }]);
    ty = ty.of;
  }
  if (ty.k === "Dir") for (const d of DIRS) out.push([`${d} ${{ N: "↑", E: "→", S: "↓", W: "←" }[d]}`, { t: "lit", v: d }]);
  else if (ty.k === "Bool") for (const b of [true, false]) out.push([String(b), { t: "lit", v: b }]);
  else if (ty.k === "Nat") for (let n = 0; n < Math.min(ty.n, 13); n++) out.push([String(n), { t: "lit", v: n }]);
  else if (ty.k === "user") for (const con of w.types.get(ty.name).cons) out.push([isTuple(con.c) ? "( … )" : con.fields.length ? `${con.c}(…)` : con.c, defaultCon(w, con.c, side)]);
  return out;
}

// A constructor with its fields left open (Before) or set to their first
// values (After), for a palette.
export function defaultCon(w, c, side) {
  const con = w.cons.get(c);
  return { t: "con", c, args: con.fields.map((f) => (side === "before" ? ANY : defaultField(w, f.type))) };
}

function defaultField(w, ty) {
  if (ty.k === "opt") return { t: "lit", v: null };
  if (ty.k === "Dir") return { t: "lit", v: "E" };
  if (ty.k === "Bool") return { t: "lit", v: false };
  if (ty.k === "Nat") return { t: "lit", v: 0 };
  if (ty.k !== "user") return KEEP; // a type parameter: nothing to pick yet
  // A type that contains itself starts from its base (Empty), so this ends.
  const T = w.types.get(ty.name);
  return defaultCon(w, T.cons[T.base ?? 0].c, "after");
}

// The type an expression is about: its first constructor's, or a named
// pattern's. Null for _, *, a variable or a literal.
export function typeOf(w, e) {
  if (!e) return null;
  if (e.t === "con") return w.cons.get(e.c)?.type.name ?? null;
  if (e.t === "named" || (e.t === "var" && w.patterns.has(e.n))) return typeOf(w, w.patterns.get(e.n));
  for (const x of [e.p, ...(e.alts ?? [])]) {
    const t = typeOf(w, x);
    if (t) return t;
  }
  return null;
}

const strip = (ty) => (ty.k === "opt" ? strip(ty.of) : ty);

// The types a brush can be: the cell's own, and those its constructors hold
// (a Tile's Floor and Thing), each with whether it can be `none` there.
// In a world of layers (cell Ground / Item), each layer's type and those
// its constructors hold.
const layerNames = (w) => w.layers ?? [w.cell];
export function brushTypes(w) {
  const out = new Map(layerNames(w).map((n) => [n, false]));
  for (const name of layerNames(w)) {
    for (const con of w.types.get(name).cons) {
      for (const f of con.fields) {
        const t = strip(f.type);
        if (t.k === "user" && !out.has(t.name)) out.set(t.name, out.get(t.name) || f.type.k === "opt");
      }
    }
  }
  return out;
}

// Where in a cell's constructor c a value of type T goes: a field index, or -1.
function slot(w, c, T) {
  return (w.cons.get(c)?.fields ?? []).findIndex((f) => {
    const t = strip(f.type);
    return t.k === "user" && t.name === T;
  });
}

// Cell expression `cell` with brush e (of type T) painted in: the whole cell
// if T is the cell's type, else into the field of type T, keeping the rest
// (On(Grass, none) painted with Frog(E, Sit) is On(Grass, Frog(E, Sit))). A
// cell with no such field becomes the first constructor that has one, its
// other fields left open.
export function paint(w, cell, T, e, side) {
  if (T == null) return e;
  if ((w.L ?? 1) > 1) {
    // A cell of layers: paint the layer the brush belongs in.
    const rest = side === "before" ? ANY : KEEP;
    const items = cell?.t === "layers" ? [...cell.items] : w.layers.map(() => (cell?.t === "any" || cell?.t === "keep" ? cell : rest));
    const l = w.layers.findIndex((n) => n === T || w.types.get(n).cons.some((k) => slot(w, k.c, T) >= 0));
    if (l < 0) return cell;
    items[l] = paintIn(w, w.layers[l], items[l], T, e, side);
    return { t: "layers", items };
  }
  return paintIn(w, w.cell, cell, T, e, side);
}

function paintIn(w, cellName, cell, T, e, side) {
  if (T === cellName) return e;
  if (cell?.t === "bind") return { ...cell, p: paint(w, cell.p, T, e, side) };
  if (cell?.t === "con" && slot(w, cell.c, T) >= 0) {
    const args = [...cell.args];
    args[slot(w, cell.c, T)] = e;
    return { ...cell, args };
  }
  const con = w.types.get(cellName).cons.find((k) => slot(w, k.c, T) >= 0);
  if (!con) return e;
  const args = con.fields.map(() => (side === "before" ? ANY : KEEP));
  args[slot(w, con.c, T)] = e;
  return { t: "con", c: con.c, args };
}

// What a right click picks up from a cell: the last field that says
// something, as a brush of its type (a frog, not the grass under it), or
// else the whole cell.
export function pickUp(w, cell) {
  if (cell?.t === "layers") {
    // The top layer that says something.
    for (let l = cell.items.length - 1; l >= 0; l--) {
      const a = cell.items[l];
      if (a.t !== "any" && a.t !== "keep") return pickUp({ ...w, L: 1, cell: w.layers[l] }, a);
    }
    return { T: w.layers.at(-1), e: cell.items.at(-1) };
  }
  if (cell?.t === "con" && w.cons.get(cell.c)?.type.name === w.cell) {
    const fields = w.cons.get(cell.c).fields;
    for (let i = fields.length - 1; i >= 0; i--) {
      const t = strip(fields[i].type);
      const a = cell.args[i];
      if (t.k === "user" && brushTypes(w).has(t.name) && a && a.t !== "any" && a.t !== "keep") return { T: t.name, e: a };
    }
  }
  return { T: w.cell, e: cell };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- the palette ----

// The brush: an expression of one of the types a cell holds (brushTypes).
// Built from the world's own types, so every world gets a palette of its own
// values.
export class Palette {
  constructor(root, onChange) {
    this.root = root;
    this.onChange = onChange;
    this.brush = null; // { T, e }: a type, and an expression of it
    this.side = "before";
    this.varName = "x";
  }

  // What the level's limits leave to draw with (`limit` in its yours
  // recipes): only some constructors, no variables. One list per recipe of
  // yours; a palette offers what any of them allows.
  setLimit(limits) {
    const ls = limits.length ? limits : [null];
    this.only = ls.some((l) => !l?.only) ? null : new Set(ls.flatMap((l) => l.only));
    this.noVar = ls.every((l) => l?.noVar);
  }

  setWorld(w) {
    this.w = w;
    if (this.brush && !brushTypes(w).has(this.brush.T)) this.brush = null;
    this.render();
  }

  set(T, e) {
    this.brush = { T, e };
    this.render();
    this.onChange?.();
  }

  render() {
    const w = this.w;
    const root = this.root;
    root.replaceChildren();
    if (!w) return;
    // The things on top first, the cell's own type last.
    for (const [name, opt] of [...brushTypes(w)].reverse()) {
      const T = w.types.get(name);
      const row = el("div", { class: "pal-row" }, el("span", { class: "pal-layer" }, T.name));
      const add = (label, e, title) => {
        const b = el("button", { class: "swatch", title: title ?? printExpr(e), onclick: () => this.set(name, e) });
        const cv = el("canvas");
        const ctx = fitCanvas(cv, 34, 34);
        drawCell(ctx, w, paint(w, KEEP, name, e, "after"), 0, 0, 34);
        b.append(cv);
        if (label) b.append(el("span", {}, label));
        if (this.brush?.T === name && same(this.brush.e, e)) b.classList.add("on");
        row.append(b);
      };
      for (const con of T.cons) if (!this.only || this.only.has(con.c) || T.cons.every((c) => !this.only.has(c.c))) add("", defaultCon(w, con.c, this.side));
      if (opt) add("none", { t: "lit", v: null }, "none : nothing there");
      add("_", ANY, "_ : anything (Before only; on the After side it keeps)");
      add("*", KEEP, "* : keep what's there");
      if (!this.noVar) add(this.varName, { t: "var", n: this.varName }, `${this.varName} : a variable. Before: matches anything and names it; After: writes what it named`);
      for (const [pn, p] of w.patterns) if (typeOf(w, p) === name) add("", { t: "named", n: pn }, `${pn} = ${printExpr(p)}`);
      root.append(row);
    }
    // The variable's name, for the var swatch.
    root.append(
      el(
        "label",
        { class: "pal-var" },
        "variable ",
        el("input", {
          value: this.varName,
          size: 4,
          oninput: (ev) => {
            const v = ev.target.value.trim();
            if (/^[a-z][A-Za-z0-9_']*$/.test(v) && !w.patterns.has(v)) {
              this.varName = v;
              if (this.brush?.e.t === "var") this.brush.e = { t: "var", n: v };
              this.render();
              this.root.querySelector(".pal-var input")?.focus();
            }
          },
        }),
      ),
    );
    if (this.brush) root.append(this.brushEditor());
  }

  // The brush itself, big, with a control per field (nested ones too), and
  // its text.
  brushEditor() {
    const w = this.w;
    const { T, e } = this.brush;
    const box = el("div", { class: "brush" });
    const cv = el("canvas");
    const ctx = fitCanvas(cv, 64, 64);
    drawCell(ctx, w, paint(w, KEEP, T, forSide(e, this.side), "after"), 0, 0, 64);
    const fields = el("div", { class: "fields" });
    const walk = (expr, set, depth) => {
      if (expr.t !== "con") return;
      const con = w.cons.get(expr.c);
      if (!con) return;
      con.fields.forEach((f, i) => {
        const opts = optionsFor(w, f.type, this.side);
        const cur = expr.args[i];
        let idx = opts.findIndex(([, o]) => same(o, cur) || (o.t === "con" && cur.t === "con" && o.c === cur.c));
        const isVar = cur.t === "var";
        const sel = el("select", {
          onchange: (ev) => {
            const v = ev.target.value;
            const next = v === "var" ? { t: "var", n: this.varName } : opts[Number(v)][1];
            const args = [...expr.args];
            args[i] = next;
            set({ ...expr, args });
          },
        });
        opts.forEach(([label], k) => sel.append(el("option", { value: k, selected: !isVar && k === idx }, label)));
        sel.append(el("option", { value: "var", selected: isVar }, `variable ${isVar ? cur.n : this.varName}`));
        if (idx < 0 && !isVar) sel.append(el("option", { value: "", selected: true, disabled: true }, printExpr(cur)));
        fields.append(el("label", { style: `margin-left:${depth}em` }, `${f.name} `, sel));
        if (cur.t === "con")
          walk(
            cur,
            (sub) => {
              const args = [...expr.args];
              args[i] = sub;
              set({ ...expr, args });
            },
            depth + 1,
          );
      });
    };
    walk(e, (next) => this.set(T, next), 0);
    const text = el("input", {
      class: "brush-text",
      value: printExpr(forSide(e, this.side)),
      title: "The brush as text: type any pattern or term, then Enter",
      onkeydown: (ev) => {
        if (ev.key !== "Enter") return;
        try {
          const next = parseCellText(ev.target.value);
          this.set(typeOf(w, next) ?? T, next);
          ev.target.classList.remove("bad");
        } catch (err) {
          ev.target.classList.add("bad");
          ev.target.title = err.message;
        }
      },
    });
    box.append(el("div", { class: "brush-top" }, cv, el("div", {}, el("b", {}, `Brush · ${T}`), codeOverlay(text))), fields);
    return box;
  }
}

// ---- a recipe card ----

// A recipe card's meta line: its id and group, and its `on` and `where` in
// colour.
function meta(raw) {
  const p = el("p", { class: "meta" });
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  p.innerHTML = `${esc(raw.id)} · group ${raw.group}${raw.on ? ` · on <span class="mono">${highlightHtml(printExpr(raw.on))}</span>` : ""}${raw.where ? ` · where <span class="mono">${highlightHtml(printExpr(raw.where))}</span>` : ""}`;
  return p;
}

// A one-line input for a cell's text, drawn in colour as it's typed.
const cellInput = (attrs) => codeOverlay(el("input", attrs));

// The card for a recipe. `raw` is its parsed AST; a card
// that is `editable` paints with `palette` and reports every edit to
// onEdit(newRaw). `error` is shown under it.
export function recipeCard(w, raw, { editable = false, palette = null, onEdit = null, error = null, size = 46, onFocus = null } = {}) {
  // Automata's recipe card (its .card), lit when the recipe fires.
  const card = el("article", { class: `card recipe${editable ? " yours" : ""}${raw.on ? " key" : ""}`, "data-id": raw.id });
  card.append(
    el("div", { class: "hd" }, el("b", {}, raw.name), el("span", { class: "count" })),
    meta(raw),
  );
  const sides = el("div", { class: "sides" });
  const cellBox = el("div", { class: "cellbox", hidden: true });

  const grid = (side) => {
    const rows = raw[side];
    const g = el("div", { class: "grid", style: `grid-template-columns: repeat(${rows[0].length}, ${size}px)` });
    rows.forEach((row, i) =>
      row.forEach((cell, j) => {
        const cv = el("canvas", { class: "rcell", title: printCell(cell) });
        const ctx = fitCanvas(cv, size, size);
        ctx.fillStyle = "#0d0221";
        ctx.fillRect(0, 0, size, size);
        drawCellRaw(ctx, w, cell, size);
        if (editable) {
          cv.addEventListener("click", () => {
            onFocus?.();
            if (palette?.brush) {
              const { T, e } = palette.brush;
              const next = clone(raw);
              next[side][i][j] = paint(w, cell, T, forSide(e, side), side);
              onEdit(next);
            } else showCell(side, i, j);
          });
          const pick = (ev) => {
            ev.preventDefault();
            onFocus?.();
            const { T, e } = pickUp(w, cell);
            palette.side = side;
            palette.set(T, e);
            showCell(side, i, j);
          };
          cv.addEventListener("contextmenu", pick);
          let timer = null;
          cv.addEventListener("touchstart", (ev) => (timer = setTimeout(() => pick(ev), 500)), { passive: true });
          cv.addEventListener("touchend", () => clearTimeout(timer));
          cv.addEventListener("mouseenter", () => {
            if (palette && palette.side !== side) {
              palette.side = side;
              palette.render();
            }
          });
        }
        g.append(cv);
      }),
    );
    return g;
  };

  // The cell's own text, to type instead of paint.
  const showCell = (side, i, j) => {
    PICKED.set(raw.id, [side, i, j]);
    cellBox.hidden = false;
    cellBox.replaceChildren(
      el("span", {}, `${side} row ${i + 1} cell ${j + 1}: `),
      cellInput({
        value: printCell(raw[side][i][j]),
        size: 30,
        onkeydown: (ev) => {
          if (ev.key !== "Enter") return;
          try {
            const next = clone(raw);
            next[side][i][j] = parseCellText(ev.target.value);
            onEdit(next);
          } catch (err) {
            ev.target.classList.add("bad");
            ev.target.title = err.message;
          }
        },
      }),
    );
  };

  sides.append(el("div", { class: "side" }, el("small", {}, "before"), grid("before")), el("div", { class: "arrow" }, "→"), el("div", { class: "side" }, el("small", {}, "after"), grid("after")));
  card.append(sides);

  if (editable) {
    const resize = (dr, dc) => {
      const next = clone(raw);
      const blank = (side) => (side === "before" ? ANY : KEEP);
      for (const side of ["before", "after"]) {
        const rows = next[side];
        if (dc > 0) rows.forEach((row) => row.push(blank(side)));
        if (dc < 0 && rows[0].length > 1) rows.forEach((row) => row.pop());
        if (dr > 0) rows.push(rows[0].map(() => blank(side)));
        if (dr < 0 && rows.length > 1) rows.pop();
      }
      onEdit(next);
    };
    card.append(
      el(
        "div",
        { class: "tools" },
        el("button", { class: "sm", title: "Add a column", onclick: () => resize(0, 1) }, "+col"),
        el("button", { class: "sm", title: "Remove the last column", onclick: () => resize(0, -1) }, "−col"),
        el("button", { class: "sm", title: "Add a row", onclick: () => resize(1, 0) }, "+row"),
        el("button", { class: "sm", title: "Remove the last row", onclick: () => resize(-1, 0) }, "−row"),
        el("span", { class: "hint" }, "click: paint the brush · right-click: pick up · or type below"),
      ),
      cellBox,
    );
    const ta = el("textarea", { class: "rtext", spellcheck: "false", rows: raw.before.length + 2 + (raw.on ? 1 : 0) + (raw.where ? 1 : 0) });
    ta.value = printRecipe(raw, { group: false });
    const msg = el("div", { class: "err" }, error ?? "");
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) ta.dispatchEvent(new Event("change"));
      ev.stopPropagation();
    });
    ta.addEventListener("change", () => {
      try {
        const r = parseRecipe(ta.value);
        onEdit({ ...r, group: raw.group, yours: true });
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    card.append(el("details", { class: "textual", open: true }, el("summary", {}, "as text (edit, then click away or Ctrl+Enter)"), codeOverlay(ta)), msg);
  } else {
    const src = el("pre", { class: "rsrc" });
    src.innerHTML = highlightHtml(printRecipe(raw, { group: false }));
    card.append(src);
  }
  const p = editable && PICKED.get(raw.id);
  if (p && raw[p[0]][p[1]]?.[p[2]]) showCell(...p);
  return card;
}

// Draws a raw cell: a lowercase name that is a world pattern is that
// pattern, not a variable.
function drawCellRaw(ctx, w, cell, s) {
  const fix = (e) => {
    if (!e || typeof e !== "object" || !e.t) return e;
    if (e.t === "var" && w.patterns?.has(e.n)) return { t: "named", n: e.n };
    const out = { ...e };
    if (e.args) out.args = e.args.map(fix);
    if (e.alts) out.alts = e.alts.map(fix);
    if (e.p) out.p = fix(e.p);
    return out;
  };
  drawCell(ctx, w, fix(cell), 0, 0, s);
}

const clone = (x) => structuredClone(x);
// The cell each card last showed the text of, kept across redraws.
const PICKED = new Map();

export { draw, varColor };
