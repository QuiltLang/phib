# Phib

Phib is a language for cellular automata. A world is a grid of values, and
every rule of it is a recipe: a small picture of cells before, and after.
Help Phibber the frog to the lotus, then open the rules and redraw them.

```
// The primes, by trial division.
type C = O | I(Nat<64>, Nat<64>)
cell C
recipe count
  I(n, _)  O  ->  *  I(n + 1, n)
recipe divide
  I(n, d)  ->  I(n, d - 1)
  where n mod d != 0
```

- **A grid of values.** Each cell holds a term of an algebraic data type the
  world declares, such as `type Ground += Belt(face: Dir)`.
- **Rewrite rules.** Each recipe matches cells before and writes cells after,
  with variables that bind parts of terms. Every tick, each recipe that
  matches somewhere, in any of four turns, rewrites those cells.
- **One meaning, three engines.** An interpreter runs the rules as written.
  Two compilers turn them into JavaScript and into WGSL for the GPU, their
  code written in [Quilt](https://github.com/QuiltLang/quilt). All three must
  make the same boards; the stress test checks.

## Run it

With [Nix](https://nixos.org) and [direnv](https://direnv.net):

```sh
direnv allow
main            # http://127.0.0.1:8150: five puzzles, the editor, the stress test
test            # the engine's tests, and that the Quilt-expanded modules are fresh
```

Without them, any Python 3.11+ and Node 22+ will do:
`uv run phib` (or `python3 -m http.server -d src/phib/static 8150`) and
`node --test tests/*.test.mjs`.

## Layout

- `src/phib/static/`: the whole engine, plain ES modules with no build step.
  `syntax.js` parses Phib, `terms.js` interprets it, `compile.js` and
  `compile-gpu.js` compile it, `view.js` and `editor.js` draw and edit it.
- `src/phib/static/std/`: the standard library (frog, water, belts, gates, …).
- `src/phib/static/puzzles.phib`: the five puzzles, each with its solution.
- `src/phib/static/stress/`: the stress test's worlds (Life, Langton's ants,
  Brian's Brain, …).
- `quilt/`: the Quilt sources of `anchors.js`, `wgsl.js` and `print.js`.
  `quilt/gen.sh` writes them; `quilt/gen.sh --check` fails if they're stale.
- `tests/`: `node --test`.

## License

MIT or Apache-2.0, at your option.
