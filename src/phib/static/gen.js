// A level drawn from the seed: its `gen` steps (syntax.js's genSteps) run
// over a blank board, each value going to the layer its type is.
//
//   seed e                       the dice roll from e from here on
//   let a = e, …                 names for the steps after
//   fill V [where e] [chance n%] V at every cell where e holds
//   put V at x, y
//   scatter n V [where e]        V at n cells where e holds, at random
//   if e / else …
//
// Expressions see x, y (the cell), width, height, the registers, the
// lets, seed and level, and call rand() (0 to 1, from the seed), ground(x,
// y) and item(x, y) (the board as drawn so far). (W and H would read as
// West and a constructor.) The same seed draws the same board every time;
// `seed e` rolls the dice from e instead, as Haul does for each day.
//
// A gen's land rules (field, zone, place, sites, layer: land.js) lay the
// whole board first, every cell from the seed and where it is; the steps
// run after, over what they laid.

import { compileLand } from "./land.js";
import { mulberry } from "./noise.js";
import { evalT, fit, intern } from "./terms.js";

export function generate(w, gen, { seed = 0, level = 0, regs = {}, blueprints = {} } = {}) {
  const { W, H } = w.level;
  const L = w.L;
  const board = gen.land ? compileLand(w, gen.land, { seed, regs, blueprints, size: [W, H] }).board(W, H) : [...w.level.cells];
  const stream = (s) => mulberry((Math.imul(s | 0, 2654435761) ^ Math.imul(level + 1, 40503)) | 0);
  let rand = stream(seed);
  const layerOf = (v) => w.layers.indexOf(w.cons.get(v?.c)?.type.name);
  const at = (x, y, l) => (x < 0 || y < 0 || x >= W || y >= H ? null : board[(y * W + x) * L + l]);
  const was = w.genFns;
  w.genFns = {
    ...was,
    rand: () => rand(),
    ground: (x, y) => at(x, y, 0),
    item: (x, y) => at(x, y, L - 1),
  };
  const lets = {};
  const env = (x, y) => ({ ...regs, ...lets, x, y, width: W, height: H, seed, level });
  const val = (e, x = 0, y = 0) => evalT(w, e, env(x, y), 0);
  const write = (v, x, y, line) => {
    const l = layerOf(v);
    if (l < 0) throw new Error(`gen, line ${line}: ${v?.c ?? v} is no layer's value`);
    board[(y * W + x) * L + l] = intern(w, fit(w, w.cellTypes[l], v, `gen, line ${line}`));
  };
  const run = (steps) => {
    for (const s of steps) {
      if (s.t === "if") run(val(s.c) ? s.then : s.else);
      else if (s.t === "seed") rand = stream(val(s.e));
      else if (s.t === "let") for (const [name, e] of s.lets) lets[name] = val(e);
      else if (s.t === "put") {
        const x = val(s.x);
        const y = val(s.y);
        if (x >= 0 && y >= 0 && x < W && y < H) write(val(s.v, x, y), x, y, s.line);
      } else if (s.t === "fill") {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (s.where && !val(s.where, x, y)) continue;
            if (s.chance != null && rand() * 100 >= s.chance) continue;
            write(val(s.v, x, y), x, y, s.line);
          }
        }
      } else if (s.t === "scatter") {
        const spots = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (!s.where || val(s.where, x, y)) spots.push([x, y]);
        for (let k = val(s.n); k > 0 && spots.length; k--) {
          const [x, y] = spots.splice(Math.floor(rand() * spots.length), 1)[0];
          write(val(s.v, x, y), x, y, s.line);
        }
      }
    }
  };
  try {
    run(gen.steps);
  } finally {
    w.genFns = was;
  }
  return board;
}
