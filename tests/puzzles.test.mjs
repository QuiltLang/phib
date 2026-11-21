// Phib on its own: its content is its standard library and five puzzles, and
// each puzzle's own solution solves it.
import assert from "node:assert/strict";
import { test } from "node:test";

const { game, GAMES, MODULES } = await import("../src/phib/static/content.js");
const { build, play, solved } = await import("../src/phib/static/terms.js");

test("Phib's content is its own: std and five puzzles", () => {
  assert.deepEqual(GAMES, ["puzzles"]);
  assert.equal(game("puzzles").levels.length, 5);
  assert.ok(MODULES["std/frog"] && MODULES["std/water"]);
  assert.equal(MODULES["std/lanes"], undefined);
});

test("each puzzle's solution solves it, and not before its last move", () => {
  const ast = game("puzzles");
  ast.levels.forEach((lv, i) => {
    const w = build(ast, i);
    const path = w.level.solution;
    assert.ok(path, `${lv.id} has a solution`);
    const states = play(w, path);
    assert.ok(solved(w, states.at(-1)), `${lv.id} is solved by ${path}`);
    assert.ok(!solved(w, states.at(-2)), `${lv.id} isn't solved a move early`);
  });
});
