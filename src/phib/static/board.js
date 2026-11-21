// A world's board in 2D: each cell's value drawn as its icons, the way a
// recipe card draws a cell (picture.js), with its goals ringed, green once
// they hold. view.js says what a 3D renderer needs instead.
import { drawCell, fitCanvas, valueExpr } from "./picture.js";
import { goalHolds } from "./terms.js";
import { cellAt } from "./view.js";

// A type's first value, with no fields (Empty): nothing to draw.
function blank(w, v) {
  if (v === null || typeof v !== "object") return v === null;
  const T = w.cons.get(v.c)?.type;
  return T?.cons[0]?.c === v.c && !T.cons[0].fields.length;
}

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.s = 0;
    this.W = 0;
    this.H = 0;
  }

  /** Draws `state` of world `w`, cells as big as fit the canvas's box. */
  draw(w, state) {
    const { W, H } = w.level;
    // The room inside the canvas's box, less its padding.
    const box = this.canvas.parentElement;
    const css = getComputedStyle(box);
    const roomW = box.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    const roomH = box.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
    const s = Math.max(14, Math.floor(Math.min(roomW / W, (roomH > 0 ? roomH : roomW) / H)));
    Object.assign(this, { s, W, H });
    const ctx = fitCanvas(this.canvas, s * W, s * H);
    ctx.clearRect(0, 0, s * W, s * H);
    for (let i = 0; i < W * H; i++) {
      // A cell of layers (Ground / Item) draws its ground as the tile and
      // the rest on it, as a recipe card does, but a layer's blank value
      // (Empty) as nothing, as view.js does.
      const v = cellAt(w, state.board, i);
      const e = w.L > 1 ? { t: "layers", items: v.map((x, k) => (k > 0 && blank(w, x) ? { t: "any" } : valueExpr(x))) } : valueExpr(v);
      drawCell(ctx, w, e, (i % W) * s, Math.floor(i / W) * s, s);
    }
    for (const g of w.level.goals) {
      const met = goalHolds(w, state, g);
      ctx.save();
      ctx.lineWidth = Math.max(2, s / 12);
      ctx.strokeStyle = met ? "#3dffa2" : "#fffb96";
      ctx.setLineDash(met ? [] : [s / 6, s / 8]);
      ctx.strokeRect(g.x * s + ctx.lineWidth / 2, g.y * s + ctx.lineWidth / 2, s - ctx.lineWidth, s - ctx.lineWidth);
      ctx.restore();
    }
  }

  /** The cell under a point on the screen, or -1. */
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - r.left) / this.s);
    const y = Math.floor((clientY - r.top) / this.s);
    return x >= 0 && y >= 0 && x < this.W && y < this.H ? y * this.W + x : -1;
  }
}
