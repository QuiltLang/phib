// Pictures of values, patterns and templates, so a recipe reads (and is
// drawn, in editor.js) as pictures as well as text. One drawer does all
// three: a board value is turned into the expression that writes it, and
// patterns and templates are expressions already.
//
// What things look like comes from the world's `look` lines: a model, drawn
// as Automata draws its kinds on its recipe cards (icons.js), or
// else a colour, a glyph, or a glyph "{field}" that draws that field's value
// instead (a Loose(Gem) looks like its gem). A model that stacks fields,
// "{floor}/{thing}", draws each field's own picture, one on the other. Fields
// are drawn around the main picture: a Dir is an arrow at that edge, a number
// a badge, a nested value a chip.
//
//   _        anything: grey hatching
//   *        keep what's there: a dotted outline
//   x        a variable: a coloured tag with its name
//   floor    a named pattern: its name, dashed
//   A | B    either: the cell split in stripes
//   !A       not: A, struck through
//   x@A      A, with x's tag in the corner
//   f(...)   anything computed: ƒ and the text

import { ground as groundIcon, item as itemIcon } from "./icons.js";
import { printExpr } from "./syntax.js";
import { exprModel } from "./view.js";

const hue = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
};
export const varColor = (n) => `hsl(${hue(n)} 80% 62%)`;
const conColor = (c) => `hsl(${hue(c)} 35% 38%)`;

// A value as the expression that would write it.
export function valueExpr(v) {
  if (v === null || typeof v !== "object") return { t: "lit", v };
  // T? is sugar: Some(x) shows as x, and None as none.
  if (v.c === "None") return { t: "lit", v: null };
  if (v.c === "Some") return valueExpr(v.a[0]);
  if (v.hole) return { t: "keep" };
  return { t: "con", c: v.c, args: v.a.map(valueExpr) };
}

// The type of a field, if the expression is a known constructor.
const fieldsOf = (w, c) => w.cons.get(c)?.fields ?? [];

const ARROW = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

function arrow(ctx, d, x, y, s, color) {
  const [dx, dy] = ARROW[d];
  const cx = x + s / 2 + dx * s * 0.36;
  const cy = y + s / 2 + dy * s * 0.36;
  const r = s * 0.13;
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgb(0 0 0 / 55%)";
  ctx.lineWidth = Math.max(1, s / 40);
  ctx.beginPath();
  ctx.moveTo(cx + dx * r, cy + dy * r);
  ctx.lineTo(cx - dx * r * 0.7 - dy * r, cy - dy * r * 0.7 + dx * r);
  ctx.lineTo(cx - dx * r * 0.7 + dy * r, cy - dy * r * 0.7 - dx * r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function tag(ctx, text, cx, cy, s, color, { dark = true } = {}) {
  const fs = Math.max(8, s * 0.24);
  ctx.font = `700 ${fs}px ui-rounded, system-ui, sans-serif`;
  const tw = Math.max(ctx.measureText(text).width + fs * 0.6, fs * 1.2);
  const th = fs * 1.25;
  ctx.fillStyle = color;
  roundRect(ctx, cx - tw / 2, cy - th / 2, tw, th, th / 2);
  ctx.fill();
  ctx.fillStyle = dark ? "#10181a" : "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + fs * 0.05);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function glyph(ctx, g, cx, cy, size) {
  ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f4f1e4";
  ctx.fillText(g, cx, cy + size * 0.06);
}

function hatch(ctx, x, y, s) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, s, s);
  ctx.clip();
  ctx.fillStyle = "rgb(140 150 150 / 30%)";
  ctx.fillRect(x, y, s, s);
  ctx.strokeStyle = "rgb(200 210 210 / 35%)";
  ctx.lineWidth = Math.max(1, s / 24);
  for (let k = -s; k < s; k += s / 5) {
    ctx.beginPath();
    ctx.moveTo(x + k, y + s);
    ctx.lineTo(x + k + s, y);
    ctx.stroke();
  }
  ctx.restore();
}

// Draws expression e as a `role` ("tile": fills the square, as a ground;
// "item": a glyph on top) in the square at x, y of side s.
export function draw(ctx, w, e, x, y, s, role) {
  switch (e.t) {
    case "keep":
      return;
    case "any":
      if (role === "tile") hatch(ctx, x, y, s);
      else tag(ctx, "?", x + s / 2, y + s / 2, s * 1.5, "rgb(200 210 210 / 70%)");
      return;
    case "var":
      if (role === "tile") hatch(ctx, x, y, s);
      tag(ctx, e.n, x + s / 2, y + (role === "tile" ? s * 0.78 : s / 2), role === "tile" ? s * 1.1 : s * 1.6, varColor(e.n));
      return;
    case "named": {
      const look = w.looks[e.n] ?? {};
      ctx.fillStyle = look.color ?? "rgb(120 140 120 / 40%)";
      if (role === "tile") ctx.fillRect(x, y, s, s);
      ctx.setLineDash([s / 10, s / 14]);
      ctx.strokeStyle = "#e8f0d8";
      ctx.lineWidth = Math.max(1, s / 30);
      ctx.strokeRect(x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84);
      ctx.setLineDash([]);
      tag(ctx, e.n, x + s / 2, y + (role === "tile" ? s * 0.8 : s / 2), s * 0.85, "#e8f0d8");
      return;
    }
    case "or": {
      const n = e.alts.length;
      e.alts.forEach((a, i) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + (s * i) / n, y, s / n, s);
        ctx.clip();
        draw(ctx, w, a, x, y, s, role);
        ctx.restore();
      });
      ctx.strokeStyle = "#f4f1e4";
      ctx.lineWidth = Math.max(1, s / 30);
      for (let i = 1; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(x + (s * i) / n, y);
        ctx.lineTo(x + (s * i) / n, y + s);
        ctx.stroke();
      }
      return;
    }
    case "not":
      draw(ctx, w, e.p, x, y, s, role);
      ctx.strokeStyle = "#ff5a6e";
      ctx.lineWidth = Math.max(2, s / 12);
      ctx.beginPath();
      ctx.moveTo(x + s * 0.15, y + s * 0.15);
      ctx.lineTo(x + s * 0.85, y + s * 0.85);
      ctx.stroke();
      return;
    case "bind":
      draw(ctx, w, e.p, x, y, s, role);
      tag(ctx, e.n, x + s * 0.22, y + s * 0.18, s * 0.75, varColor(e.n));
      return;
    case "layers":
      // A cell of layers (Grass / Frog(E, Sit)): the ground as the tile,
      // what stands on it over it.
      e.items.forEach((a, k) => {
        if (k === 0) return draw(ctx, w, a, x, y, s, role);
        if (a.t === "any" || a.t === "keep") return;
        const o = s * 0.05;
        draw(ctx, w, a, x + o, y + o, s - 2 * o, "item");
      });
      return;
    case "con":
      return drawCon(ctx, w, e, x, y, s, role);
    case "lit":
      if (typeof e.v === "string") {
        arrow(ctx, e.v, x, y, s, "#f6c85f");
        return;
      }
      // Nothing on a tile: as Automata's cards draw an empty item, ∅.
      if (e.v === null && role === "item") tag(ctx, "∅", x + s / 2, y + s / 2, s * 1.3, "rgb(236 230 255 / 22%)", { dark: false });
      else tag(ctx, e.v === null ? "none" : String(e.v), x + s / 2, y + s / 2, s, "#f4f1e4");
      return;
    case "upd":
      draw(ctx, w, e.e, x, y, s, role);
      tag(ctx, `{${e.fields.map(([f]) => f).join(",")}}`, x + s / 2, y + s * 0.82, s * 0.7, "#f6c85f");
      return;
    default:
      // Computed: if, arithmetic, a function call.
      if (role === "tile") {
        ctx.fillStyle = "rgb(90 70 140 / 55%)";
        ctx.fillRect(x, y, s, s);
      }
      tag(ctx, "ƒ", x + s / 2, y + s * 0.4, s * 1.1, "#c9a7ff");
      ctx.font = `${Math.max(7, s * 0.14)}px ui-monospace, monospace`;
      ctx.fillStyle = "#f4f1e4";
      ctx.textAlign = "center";
      ctx.fillText(short(printExpr(e)), x + s / 2, y + s * 0.8, s * 0.95);
  }
}

const short = (t) => (t.length > 18 ? `${t.slice(0, 17)}…` : t);

// The fields a look stacks ("{floor}/{thing}": [0, 1]), or null.
export function stackOf(w, c) {
  const segs = (w.looks[c]?.model ?? "").split("/");
  if (segs.length < 2) return null;
  const fields = fieldsOf(w, c);
  const out = segs.map((seg) => {
    const m = /^\s*\{(\w+)\}\s*$/.exec(seg);
    return m ? fields.findIndex((f) => f.name === m[1]) : -1;
  });
  return out.every((n) => n >= 0) ? out : null;
}

function drawCon(ctx, w, e, x, y, s, role) {
  const look = w.looks[e.c] ?? {};
  const fields = fieldsOf(w, e.c);
  const at = (name) => fields.findIndex((f) => f.name === name);
  const stack = stackOf(w, e.c);
  if (stack) {
    // Each field's picture, one on the other: the first as the cell's ground
    // (if this is the cell), the rest a little smaller on top.
    stack.forEach((n, k) => {
      const a = e.args[n];
      if (!a) return;
      if (k === 0) return draw(ctx, w, a, x, y, s, role);
      const o = s * 0.05;
      draw(ctx, w, a, x + o, y + o, s - 2 * o, "item");
    });
    return;
  }
  const model = exprModel(w, e, role);
  if (role === "tile" && !model?.g) {
    ctx.fillStyle = look.color ?? conColor(e.c);
    ctx.fillRect(x, y, s, s);
  }
  // The main picture: a model, a field's, a glyph, or a label.
  let main = -1;
  const m = /^\{(\w+)\}$/.exec(look.glyph ?? "");
  if (!model && m) main = at(m[1]);
  const lm = /^\{(\w+)\}$/.exec(look.label ?? "");
  if (look.model === "" && !fields.length) {
    // Nothing at all, as Automata's cards draw an empty item: ∅.
    if (role === "item") tag(ctx, "∅", x + s / 2, y + s / 2, s * 1.3, "rgb(236 230 255 / 22%)", { dark: false });
  } else if (model) {
    // Ground on the item layer (a cart) sits inside the cell, not over it.
    const k = role === "tile" ? 1 : 0.86;
    const o = (s * (1 - k)) / 2;
    if (model.g) groundIcon(ctx, x + o, y + o, s * k, model.g, model.d);
    if (model.i) itemIcon(ctx, x, y, s, model.i, model.g ? -1 : model.d);
  } else if (main >= 0) {
    const inner = e.args[main];
    const k = role === "tile" ? 0.62 : 1;
    const o = (s * (1 - k)) / 2;
    if (role === "tile") ctx.globalAlpha = 0.55;
    draw(ctx, w, inner, x + o, y + o, s * k, "item");
    ctx.globalAlpha = 1;
  } else if (lm && at(lm[1]) >= 0) {
    // A label from a field: a number tints the tile, anything else is a badge.
    main = at(lm[1]);
    const a = e.args[main];
    if (a.t === "lit" && typeof a.v === "number") {
      if (a.v && role === "tile") {
        ctx.fillStyle = `hsl(${(a.v * 97 + 20) % 360} 65% 50%)`;
        ctx.fillRect(x, y, s, s);
      }
    } else if (a.t !== "any" && a.t !== "keep") badgeAt(ctx, w, a, x, y, s, 0, lm[1]);
  } else if (look.glyph != null) {
    if (look.glyph) glyph(ctx, look.glyph, x + s / 2, y + s / 2, s * (role === "tile" ? 0.5 : 0.62));
  } else if (look.label) {
    tag(ctx, look.label, x + s / 2, y + s / 2, s, "#f4f1e4");
  } else if (!look.color || role === "item") {
    if (role === "item") {
      ctx.fillStyle = conColor(e.c);
      ctx.beginPath();
      ctx.arc(x + s / 2, y + s / 2, s * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.font = `700 ${s * 0.26}px ui-rounded, system-ui, sans-serif`;
    ctx.fillStyle = "#f4f1e4";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(e.c.slice(0, 3), x + s / 2, y + s / 2);
  }
  // The other fields, around it.
  let chip = 0;
  let badge = 0;
  fields.forEach((f, i) => {
    if (i === main) return;
    const a = e.args[i];
    if (!a) return;
    // What the model already shows (Loose(Log)'s log) needs no chip.
    if (model?.used.has(f.name) && (a.t === "con" || (a.t === "lit" && a.v === null))) return;
    const ty = f.type.k === "opt" ? f.type.of : f.type;
    if (ty.k === "Dir") {
      if (a.t === "lit" && typeof a.v === "string") arrow(ctx, a.v, x, y, s, role === "tile" ? "#bfe3ff" : "#f6c85f");
      else if (a.t !== "any" && a.t !== "keep") badgeAt(ctx, w, a, x, y, s, badge++, f.name);
      return;
    }
    if (ty.k === "user") {
      if (a.t === "any" || a.t === "keep") return;
      if (a.t === "con" && !w.cons.get(a.c)?.fields.length && w.looks[a.c]?.glyph === "") return;
      const cs = s * 0.42;
      const cx = chip === 0 ? x + s - cs - s * 0.02 : x + s * 0.02;
      const cy = y + s * 0.02;
      chip++;
      ctx.fillStyle = "rgb(16 24 26 / 72%)";
      roundRect(ctx, cx, cy, cs, cs, cs * 0.25);
      ctx.fill();
      draw(ctx, w, a, cx, cy, cs, "item");
      return;
    }
    // Nat, Bool, none: a badge (a var's tag, ƒ, or the number).
    if (a.t === "any" || a.t === "keep") return;
    badgeAt(ctx, w, a, x, y, s, badge++, f.name);
  });
}

function badgeAt(ctx, w, a, x, y, s, n, name) {
  const cx = x + s * (n % 2 ? 0.24 : 0.76);
  const cy = y + s * 0.82;
  if (a.t === "lit") tag(ctx, a.v === true ? "✓" : a.v === false ? "✗" : a.v === null ? "–" : String(a.v), cx, cy, s * 0.8, "#f6c85f");
  else if (a.t === "var") tag(ctx, a.n, cx, cy, s * 0.8, varColor(a.n));
  else tag(ctx, short(printExpr(a)), cx, cy, s * 0.7, "#c9a7ff");
}

// One cell: its one expression, filling the square.
export const drawCell = (ctx, w, e, x, y, s) => draw(ctx, w, e, x, y, s, "tile");

export const drawValueCell = (ctx, w, v, x, y, s) => drawCell(ctx, w, valueExpr(v), x, y, s);

// A canvas sized for CSS pixels at the screen's density.
export function fitCanvas(canvas, cssW, cssH) {
  const dpr = globalThis.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// A label-from-field look (Paint's "{c}"): the board draws the number.
export function labelField(w, v) {
  if (!v || typeof v !== "object") return null;
  const m = /^\{(\w+)\}$/.exec(w.looks[v.c]?.label ?? "");
  if (!m) return null;
  const i = fieldsOf(w, v.c).findIndex((f) => f.name === m[1]);
  return i >= 0 ? v.a[i] : null;
}
