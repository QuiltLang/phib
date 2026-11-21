// primes.phib, the primes by trial division: the row settles with I(n, 1)
// at exactly the primes, and each other n at its largest proper divisor, by
// every engine.
import assert from "node:assert/strict";
import { test } from "node:test";

const { read } = await import("../src/phib/static/content.js");
const { parse } = await import("../src/phib/static/syntax.js");
const { build, key, start, step } = await import("../src/phib/static/terms.js");
const { useCompiled } = await import("../src/phib/static/compile.js");
const { compileGpu, emulate, toIds } = await import("../src/phib/static/compile-gpu.js");

const SRC = await read("./primes.phib", new URL("../src/phib/static/", import.meta.url));
const world = () => build(parse(SRC), 0);
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61];

// Every board until it stops changing.
function run(w) {
  const out = [];
  let st = start(w);
  for (let prev = ""; ; ) {
    st = step(w, st, null);
    const k = st.board.map(key).join();
    if (k === prev) return out;
    out.push(st.board);
    prev = k;
    assert.ok(out.length < 500, "it settles");
  }
}
const primes = (board) => board.filter((v) => v.c === "I" && v.a[1] === 1).map((v) => v.a[0]);

test("the row settles on the primes to 63", () => {
  const boards = run(world());
  const last = boards.at(-1);
  assert.deepEqual(last.map((v) => v.a[0]), Array.from({ length: 62 }, (_, i) => i + 2), "it counts 2 to 63");
  assert.deepEqual(primes(last), PRIMES);
  const largest = (n) => Array.from({ length: n - 1 }, (_, i) => n - 1 - i).find((d) => n % d === 0);
  last.forEach((v) => assert.equal(v.a[1], largest(v.a[0]), `${v.a[0]}'s largest proper divisor`));
});

test("compiled and the GPU make the interpreter's boards", () => {
  const plain = run(world());
  assert.deepEqual(run(useCompiled(world())).map((b) => b.map(key).join()), plain.map((b) => b.map(key).join()));
  const w = world();
  const plan = compileGpu(w, start(w).board);
  let ids = toIds(plan, start(w).board);
  plain.forEach((b, t) => {
    ids = emulate(plan, ids, { tick: t });
    assert.deepEqual([...ids], [...toIds(plan, b)], `the GPU's tick ${t + 1}`);
  });
});
