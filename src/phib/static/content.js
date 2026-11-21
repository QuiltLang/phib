// Phib's content: the standard library (std/*.phib) and the puzzles
// (puzzles.phib), read once when this module loads, from disk in node and
// fetched beside it in a browser, so `use std/frog` resolves synchronously
// (syntax.js's setModules). A host with games and modules of its own adds
// them with extend(), and they resolve the same way.
import { parse, setModules } from "./syntax.js";
import { build } from "./terms.js";

export const STD = ["std", "frog", "water", "furnace", "rails", "veins", "gates", "ice", "belts", "fuses", "cloners", "trees", "nests", "ants", "palms", "boats"];
export const GAMES = ["puzzles"];

const node = !!globalThis.process?.versions?.node;

/** A file's text, by a URL or a path relative to `base` (this module's). */
export async function read(path, base = import.meta.url) {
  const url = new URL(path, base);
  if (node) return (await import("node:fs")).readFileSync(url, "utf8");
  // Once more if the first try fails: a small server may drop a request.
  for (let tries = 0; ; tries++) {
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`couldn't load ${path}`);
      return r.text();
    } catch (err) {
      if (tries >= 2) throw err;
    }
  }
}

// One after another, gently.
async function readAll(names, path) {
  const out = {};
  for (const [key, n] of names) out[key] = await read(path(n));
  return out;
}

// Every module's text, by the name a `use` gives it: std, std/frog, ...
export const MODULES = await readAll(
  STD.map((n) => [n === "std" ? "std" : `std/${n}`, n]),
  (n) => `./std/${n}.phib`,
);
// Every game's text.
export const SOURCES = await readAll(
  GAMES.map((n) => [n, n]),
  (n) => `./${n}.phib`,
);

/** Adds a host's modules ({"std/x": text}) and games ({id: text}); a game
 * already here is replaced, so a host can extend one (see the puzzles). */
export function extend({ modules = {}, games = {} } = {}) {
  Object.assign(MODULES, modules);
  Object.assign(SOURCES, games);
  for (const id of Object.keys(games)) if (!GAMES.includes(id)) GAMES.push(id);
}
setModules((name) => MODULES[name] ?? SOURCES[name] ?? null);

// A game's file, parsed (in node, a path to a .phib file works too); and
// one of its levels as a world.
const fs = node ? await import("node:fs") : null;
export const game = (id) => parse(id.endsWith(".phib") ? fs.readFileSync(id, "utf8") : SOURCES[id]);
export const levelWorld = (id, level) => build(game(id), level);
