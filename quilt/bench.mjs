// Parity and cost of anchors.ts.quilt's three builds (⟨str⟩, ⟨qt⟩, ⟨cst⟩)
// against compile.js's writeSource. Build them first with build.mjs, then
//   node --expose-gc bench.mjs
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const S = new URL("../src/phib/static/", import.meta.url).href;
const { GAMES, game } = await import(S + "content.js");
const { build } = await import(S + "terms.js");
const { Run } = await import(S + "run.js");
const { compileWorld } = await import(S + "compile.js");

// The template writer compile.js used before anchors.js: the reference every
// Quilt build is held to, byte for byte, and timed against.
function writeSource(rks, entries, L, order) {
  const lines = [];
  for (const rk of rks) {
    const r = rk.info.r;
    const test = order(rk).map((e) => `T[${e}][ids[o + ${entries[e].off}]] === 1`);
    const ids = rk.full.map((f) => `ids[o + ${f.off}]`);
    const key = ids.length === 0 ? "0" : ids.length === 1 ? ids[0] : ids.length === 2 ? `${ids[0]} * 67108864 + ${ids[1]}` : ids.join(` + "," + `);
    lines.push(`// ${r.id} "${String(r.name ?? "").replace(/[\n"\\]/g, " ")}", turned ${rk.k}: ${r.h}×${r.wd}, ${rk.bw}×${rk.bh} on the board`);
    lines.push(`F[${rk.i}] = {\n  test: (a) => { const o = a * ${L}; return ${test.length ? test.join(" && ") : "true"}; },\n  key: (a) => { const o = a * ${L}; return ${key}; },\n};`);
  }
  return `// The world's recipes as anchor tests, ${rks.length} of them (each recipe at its four turns).\n// T[e] is keyed cell e's table over value ids (1: it can match); ids is the board's ids, ${L} a cell.\n${lines.join("\n")}\n`;
}
const REPRS = ["str", "qt", "cst"];
const writers = { tpl: writeSource };
for (const r of REPRS) {
  const t0 = performance.now();
  writers[r] = (await import(`./anchors-${r}.mjs`)).writeQuilt;
  console.log(`load the ⟨${r}⟩ writer${r === "str" ? "" : " and the runtime"}: ${(performance.now() - t0).toFixed(1)} ms`);
}

// Parity: every level of every game, keyed cells in id order and reversed.
const asc = (rk) => [...rk.keyed].sort((a, b) => a - b);
const desc = (rk) => [...rk.keyed].sort((a, b) => b - a);
let worlds = 0, rks = 0;
const same = Object.fromEntries(REPRS.map((r) => [r, 0]));
for (const id of GAMES) {
  const n = Math.max(1, game(id).levels?.length ?? 1);
  for (let lv = 0; lv < n; lv++) {
    let w;
    try { w = build(game(id), lv); } catch { continue; }
    const c = compileWorld(w);
    worlds++;
    rks += c.rks.length;
    for (const r of REPRS) {
      let ok = true;
      for (const order of [asc, desc]) {
        const a = writeSource(c.rks, c.entries, c.L, order);
        const b = writers[r](c.rks, c.entries, c.L, order);
        if (a !== b) {
          ok = false;
          const al = a.split("\n"), bl = b.split("\n");
          const i = al.findIndex((x, j) => x !== bl[j]);
          console.log(`DIFF ⟨${r}⟩ ${id}#${lv} line ${i}:\n  tpl:   ${al[i]}\n  quilt: ${bl[i]}`);
        }
      }
      if (ok) same[r]++;
    }
  }
}
console.log(`worlds ${worlds}, recipe-turns ${rks}; identical code (both orders): ${REPRS.map((r) => `⟨${r}⟩ ${same[r]}`).join(", ")}`);

// Writing one world's code (a game's first level: puzzles, or the id given),
// each writer's first write, then the median of 50.
const world = compileWorld(build(game(process.argv[2] ?? "puzzles"), 0));
const write = (f) => f(world.rks, world.entries, world.L, asc);
const med = (f, k = 50) => { const ts = []; for (let i = 0; i < k; i++) { const t = performance.now(); f(); ts.push(performance.now() - t); } ts.sort((a, b) => a - b); return ts[k >> 1]; };
console.log(`${process.argv[2] ?? "puzzles"}: ${world.rks.length} recipe-turns, ${write(writeSource).length} bytes`);
const tt = med(() => write(writeSource));
for (const r of REPRS) {
  const t0 = performance.now(); write(writers[r]); const cold = performance.now() - t0;
  const tq = med(() => write(writers[r]));
  console.log(`  ⟨${r}⟩: first write ${cold.toFixed(1)} ms, median ${tq.toFixed(2)} ms (${(tq / tt).toFixed(1)}x the template's ${tt.toFixed(2)} ms)`);
}

// Memory over repeated writes of that code.
const mem = () => { globalThis.gc?.(); const m = process.memoryUsage(); return `heap ${(m.heapUsed / 1e6).toFixed(1)} MB`; };
console.log(`memory before: ${mem()}${globalThis.gc ? "" : " (run with --expose-gc for steady numbers)"}`);
for (const r of REPRS) {
  for (let i = 0; i < 400; i++) write(writers[r]);
  console.log(`  after 400 ⟨${r}⟩ writes: ${mem()}`);
}

// Ant farm and open world: starting the level (compiling it), then ticks; the
// reordered writes (generate(seen) once a board has been seen) must match.
const ant = game("sandbox").levels.findIndex((l) => l.id === "antfarm");
const ow = game("openworld");
ow.regs = ow.regs.map((g) => (g.name === "size" ? { ...g, v: 128 } : g));
function play(id, write, { level = 0, ticks = 300, seed = 4, ast = null } = {}) {
  const t = performance.now();
  const R = new Run(ast ?? game(id), { seed, level, compile: (w) => ((w.compiled = compileWorld(w, write)), w) });
  const t1 = performance.now();
  let n = 0;
  for (let i = 0; i < ticks && R.state === "play"; i++, n++) R.play(i % 7 === 0 ? null : { d: "NESW"[i % 4], far: false });
  return { start: t1 - t, ms: performance.now() - t1, n, src: R.w.compiled.source };
}
const best = (xs, d = 3) => Math.min(...xs).toFixed(d);
for (const [name, id, opts] of [["ant farm", "sandbox", { level: ant }], ["open world 128", "openworld", { ast: ow, ticks: 150 }]]) {
  const start = {}, tick = {};
  let srcSame = true;
  for (const w of ["tpl", ...REPRS]) { start[w] = []; tick[w] = []; }
  for (let i = 0; i < 5; i++) {
    const a = play(id, writeSource, opts);
    start.tpl.push(a.start); tick.tpl.push(a.ms / a.n);
    for (const r of REPRS) {
      const b = play(id, writers[r], opts);
      start[r].push(b.start); tick[r].push(b.ms / b.n);
      srcSame &&= a.src === b.src;
    }
  }
  const row = (w) => `${w === "tpl" ? "template" : `⟨${w}⟩`} ${best(start[w], 1)} ms / ${best(tick[w])} ms`;
  console.log(`${name} (start / per tick, best of 5): ${["tpl", ...REPRS].map(row).join("; ")}; reordered code identical: ${srcSame}`);
}

// Page weight: what the page would load for each, raw and gzipped.
const size = (fs) => { const b = Buffer.concat(fs.map((f) => readFileSync(new URL(f, import.meta.url)))); return `${(b.length / 1024).toFixed(1)} KB (${(gzipSync(b, { level: 9 }).length / 1024).toFixed(1)} KB gz)`; };
console.log(`page weight: ⟨str⟩ writer ${size(["anchors-str.mjs"])}, no runtime; ⟨qt⟩ writer ${size(["anchors-qt.mjs"])}, ⟨cst⟩ writer ${size(["anchors-cst.mjs"])}, each + runtime ${size(["rt/quilt_runtime.js"])}`);
