// The stress test's world: Life, compiled to JavaScript, makes the same boards
// as the interpreter; and a big board's tick, where every cell's recipe fires,
// runs (step() once overflowed the stack there).
import assert from "node:assert/strict";
import { test } from "node:test";

const { lifeWorld } = await import("../src/phib/static/stress.js");
const { useCompiled } = await import("../src/phib/static/compile.js");
const { key, start, step } = await import("../src/phib/static/terms.js");

const boards = (w, n) => {
  let st = start(w);
  const out = [];
  for (let t = 0; t < n; t++) out.push((st = step(w, st, null)).board.map(key).join(""));
  return out;
};

test("Life compiled makes the interpreter's boards, tick for tick", () => {
  const plain = boards(lifeWorld(64), 6);
  const compiled = boards(useCompiled(lifeWorld(64)), 6);
  assert.deepEqual(compiled, plain);
  assert.notEqual(plain[0], plain[5], "the board changes");
});

test("a 512² tick, every cell firing, doesn't overflow the stack", () => {
  const w = useCompiled(lifeWorld(512));
  const st = step(w, start(w), null);
  assert.equal(st.board.length, 512 * 512);
  assert.ok(st.fired.length > 100000);
});
