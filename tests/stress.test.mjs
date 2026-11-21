// Every stress-test preset (stress/*.phib): compiled to JavaScript, and on
// the GPU (emulated), it makes the interpreter's boards, tick for tick; the
// board changes; and the ants (or moths), where there are any, are all still there.
import assert from "node:assert/strict";
import { test } from "node:test";

const { PRESETS, stressWorld } = await import("../src/phib/static/stress.js");
const { useCompiled } = await import("../src/phib/static/compile.js");
const { compileGpu, emulate, toIds } = await import("../src/phib/static/compile-gpu.js");
const { key, start, step } = await import("../src/phib/static/terms.js");

const TICKS = 12;
const boards = (w, n) => {
  let st = start(w);
  const out = [];
  for (let t = 0; t < n; t++) out.push((st = step(w, st, null)).board);
  return out;
};
const ants = (board) => board.filter((v) => v.c === "Ant" || v.c === "Moth").length;

for (const [id, P] of Object.entries(PRESETS)) {
  test(`${P.name}: compiled and the GPU make the interpreter's boards`, () => {
    const plain = boards(stressWorld(id, 48), TICKS);
    const flat = plain.map((b) => b.map(key).join());
    assert.deepEqual(boards(useCompiled(stressWorld(id, 48)), TICKS).map((b) => b.map(key).join()), flat);
    assert.notEqual(flat[0], flat.at(-1), "the board changes");

    const w = stressWorld(id, 48);
    const plan = compileGpu(w, start(w).board);
    let ids = toIds(plan, start(w).board);
    plain.forEach((b, t) => {
      ids = emulate(plan, ids, { tick: t });
      assert.deepEqual([...ids], [...toIds(plan, b)], `the GPU's tick ${t + 1}`);
    });

    const n = ants(start(w).board);
    if (n) assert.equal(ants(plain.at(-1)), n, "every ant is still there");
  });
}
