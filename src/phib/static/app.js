// Phib's page: a home (#home) with the puzzles, the stress test and an about;
// the puzzles on a 2D board, and the world's recipes as cards you can read,
// or redraw with the editor and play with your rules instead; and a stress
// test of its engines (stress.js), automata on a big board.
import { Board } from "./board.js";
import { SOURCES } from "./content.js";
import { Palette, recipeCard } from "./editor.js";
import { ENGINES, PRESETS, SIZES, Stress } from "./stress.js";
import { parse, parseRecipe, printRecipe } from "./syntax.js";
import { build, flatten, solved, start, step } from "./terms.js";
import { View } from "./view.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(`phib.${k}`));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(`phib.${k}`);
      else localStorage.setItem(`phib.${k}`, JSON.stringify(v));
    } catch {
      // Private windows can refuse storage: it lasts this visit.
    }
  },
};

const FILE = parse(SOURCES.puzzles);
const LEVELS = FILE.levels.map((lv, index) => ({ id: lv.id, name: lv.name, index }));

const game = {
  L: null,
  ast: null, // the level, flattened out of the file
  edits: new Map(), // recipe id -> raw recipe, as redrawn
  errors: new Map(), // recipe id -> why it doesn't build
  w: null, // the last world that built
  history: [],
  moves: 0,
  won: false,
  editing: !!store.get("editing"),
  view: "home", // "home", "puzzle" or "stress"
};
const board = new Board($("board"));
const palette = new Palette($("palette"), () => {});
const now = () => game.history.at(-1);

// The stress test: its own section, and its world's recipes in the panel.
const stress = new Stress({
  canvas: $("stressCanvas"),
  pixels: $("stressPixels"),
  stats: (text) => ($("stressStats").textContent = text),
  onWorld: (w) => {
    $("rules").replaceChildren(...w.flat.recipes.map((r) => recipeCard(w, r, { size: 30 })));
    $("stressName").textContent = `Stress test: ${PRESETS[stress.preset].name}`;
    $("stressAbout").textContent = PRESETS[stress.preset].about;
  },
});
stress.preset = PRESETS[store.get("stress.preset")] ? store.get("stress.preset") : "life";

// Which of the page's views is open: the home, a puzzle, or the stress test.
function show(view) {
  game.view = view;
  $("home").hidden = view !== "home";
  $("play").hidden = view === "home";
  $("levels").hidden = view === "home";
  if (view !== "stress") stress.stop();
}

function load(id) {
  if (id === "" || id === "home") return openHome();
  if (id === "stress" || id.startsWith("stress/")) return openStress(id.slice(7));
  show("puzzle");
  $("puzzleBox").hidden = false;
  $("stressBox").hidden = true;
  $("editing").hidden = false;
  const L = LEVELS.find((x) => x.id === id) ?? LEVELS[0];
  game.L = L;
  game.ast = flatten(parse(SOURCES.puzzles), L.index);
  game.edits = new Map();
  for (const r of game.ast.recipes) {
    const saved = store.get(`edit.${L.id}.${r.id}`);
    if (!saved) continue;
    try {
      game.edits.set(r.id, { ...parseRecipe(saved), id: r.id, group: r.group });
    } catch {
      // A recipe that no longer reads: the level's own.
    }
  }
  game.w = null;
  rebuild();
  $("name").textContent = game.ast.level.name;
  $("intro").textContent = game.ast.level.intro;
  $("hint").textContent = game.ast.level.hint;
  $("hintBox").hidden = !game.ast.level.hint;
  $("hintBox").open = false;
  if (location.hash !== `#${L.id}`) history.replaceState(null, "", `#${L.id}`);
  document.title = `${game.ast.level.name} · Phib`;
  tabs();
  reset();
}

// `preset`, from the hash (#stress/ants), or the last one picked.
function openStress(preset) {
  if (PRESETS[preset]) setPreset(preset);
  show("stress");
  game.L = null;
  $("puzzleBox").hidden = true;
  $("stressBox").hidden = false;
  for (const id of ["editing", "restore", "paletteBox"]) $(id).hidden = true;
  if (location.hash !== `#stress/${stress.preset}`) history.replaceState(null, "", `#stress/${stress.preset}`);
  document.title = "Stress test · Phib";
  tabs();
  stress.reset().then(playing);
}

// The home: links to each puzzle (✓ once solved) and each stress-test world.
function openHome() {
  show("home");
  game.L = null;
  if (location.hash && location.hash !== "#home") history.replaceState(null, "", "#home");
  document.title = "Phib · a Quilt demo";
  const link = (href, text, cls = "") => Object.assign(document.createElement("a"), { href, textContent: text, className: cls });
  $("homePuzzles").replaceChildren(
    ...LEVELS.map((L) => link(`#${L.id}`, `${L.index + 1}. ${L.name}${store.get(`solved.${L.id}`) ? " ✓" : ""}`)),
  );
  $("homeStress").replaceChildren(...Object.entries(PRESETS).map(([id, p]) => link(`#stress/${id}`, p.name)));
  const next = LEVELS.find((L) => !store.get(`solved.${L.id}`)) ?? LEVELS[0];
  $("homePlay").href = `#${next.id}`;
}

// The world with the edited recipes in it. If they don't build, the last
// world that did carries on and the card says why.
function rebuild() {
  const recipes = game.ast.recipes.map((r) => game.edits.get(r.id) ?? r);
  try {
    game.w = build({ ...game.ast, recipes });
    game.errors.clear();
  } catch (err) {
    const id = [...game.edits.keys()].find((k) => err.message.includes(k)) ?? [...game.edits.keys()].at(-1);
    game.errors.set(id, err.message);
    game.w ??= build(game.ast);
  }
  palette.setLimit([]);
  palette.setWorld(game.w);
  cards();
}

function edit(id, raw) {
  game.edits.set(id, raw);
  store.set(`edit.${game.L.id}.${id}`, printRecipe(raw, { group: false }));
  rebuild();
  draw();
}

function cards() {
  const root = $("rules");
  root.replaceChildren();
  $("paletteBox").hidden = !game.editing;
  $("editing").setAttribute("aria-pressed", String(game.editing));
  $("restore").hidden = !game.edits.size;
  for (const r of [...game.ast.recipes].sort((a, b) => a.group - b.group)) {
    const raw = game.edits.get(r.id) ?? r;
    root.append(
      game.editing
        ? recipeCard(game.w, raw, { editable: true, palette, error: game.errors.get(r.id), onEdit: (next) => edit(r.id, next) })
        : recipeCard(game.w, raw, { size: 30 }),
    );
  }
  lit();
}

// The cards of the recipes that fired last tick light up.
function lit() {
  const fired = new Map();
  for (const m of now()?.fired ?? []) fired.set(m.r.id, (fired.get(m.r.id) ?? 0) + 1);
  for (const card of $("rules").querySelectorAll(".recipe")) {
    const n = fired.get(card.dataset.id) ?? 0;
    card.classList.toggle("lit", !!n);
    const c = card.querySelector(".count");
    if (c) c.textContent = n ? (n > 1 ? `×${n}` : "fired") : "";
  }
}

function reset() {
  game.history = [start(game.w)];
  game.moves = 0;
  game.won = false;
  $("win").hidden = true;
  draw();
}

function tick(input) {
  if (game.won) return;
  let next;
  try {
    next = step(game.w, now(), input);
  } catch (err) {
    $("status").textContent = `Stopped: ${err.message}`;
    return;
  }
  game.history.push(next);
  if (input) game.moves++;
  draw();
  if (solved(game.w, next)) win();
}

function undo() {
  if (game.history.length < 2) return;
  game.history.pop();
  game.moves = Math.max(0, game.moves - 1);
  game.won = false;
  $("win").hidden = true;
  draw();
}

function win() {
  game.won = true;
  store.set(`solved.${game.L.id}`, true);
  const next = LEVELS[game.L.index + 1];
  $("winText").textContent = `Solved in ${game.moves} move${game.moves === 1 ? "" : "s"}.`;
  $("winNext").hidden = !next;
  $("win").hidden = false;
  tabs();
}

function draw() {
  board.draw(game.w, now());
  $("status").textContent = `moves ${game.moves} · tick ${now().tick}`;
  lit();
}

function tabs() {
  $("levels").replaceChildren(
    Object.assign(document.createElement("a"), { href: "#home", textContent: "← Home", className: "home-tab" }),
    ...LEVELS.map((L) => {
      const b = document.createElement("button");
      b.textContent = `${L.index + 1}. ${L.name}${store.get(`solved.${L.id}`) ? " ✓" : ""}`;
      b.setAttribute("aria-current", String(L === game.L));
      b.onclick = () => load(L.id);
      return b;
    }),
    Object.assign(document.createElement("button"), { textContent: "Stress test ⚡", className: "stress-tab", onclick: () => load("stress") }),
  );
  $("levels").lastChild.setAttribute("aria-current", String(!game.L));
}

// Where Phibber is, for a tap beside him.
function frogCell() {
  const a = new View(game.w).worldOf(now());
  const f = a.kinds.i.indexOf("frog");
  return f < 0 ? -1 : a.it.indexOf(f);
}

const KEYS = { ArrowUp: "N", ArrowRight: "E", ArrowDown: "S", ArrowLeft: "W" };
const hop = (d) => tick({ d, far: false });
window.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (e.metaKey || e.ctrlKey || e.altKey || !game.L) return;
  if (KEYS[e.key]) {
    e.preventDefault();
    hop(KEYS[e.key]);
  } else if (e.key === "w" || e.key === "W") tick(null);
  else if (e.key === "z" || e.key === "Z") undo();
  else if (e.key === "r" || e.key === "R") reset();
  else if (e.key === "Enter" && !$("win").hidden && !$("winNext").hidden) $("winNext").click();
  else if (e.key === "Escape") $("win").hidden = true;
});
$("board").addEventListener("click", (e) => {
  if (!game.L) return;
  const i = board.pick(e.clientX, e.clientY);
  const P = frogCell();
  if (i < 0 || P < 0) return;
  const W = game.w.level.W;
  const dx = (i % W) - (P % W);
  const dy = Math.floor(i / W) - Math.floor(P / W);
  if (Math.abs(dx) + Math.abs(dy) === 1) hop(dx > 0 ? "E" : dx < 0 ? "W" : dy > 0 ? "S" : "N");
});
for (const b of document.querySelectorAll("#pad [data-d]")) b.onclick = () => hop(b.dataset.d);
$("wait").onclick = () => tick(null);
$("undo").onclick = undo;
$("restart").onclick = reset;
$("winNext").onclick = () => load(LEVELS[game.L.index + 1].id);
$("winStay").onclick = () => ($("win").hidden = true);
$("editing").onclick = () => {
  game.editing = !game.editing;
  store.set("editing", game.editing || null);
  cards();
};
$("restore").onclick = () => {
  for (const id of game.edits.keys()) store.set(`edit.${game.L.id}.${id}`, null);
  game.edits = new Map();
  rebuild();
  reset();
};
addEventListener("resize", () => {
  if (game.view === "puzzle") draw();
  else if (game.view === "stress" && !stress.playing) stress.draw();
});

// The stress test's controls.
const playing = () => ($("stressPlay").textContent = stress.playing ? "Pause" : "Play");
$("stressPreset").replaceChildren(...Object.entries(PRESETS).map(([id, p]) => new Option(p.name, id)));
$("stressPreset").value = stress.preset;
function setPreset(id) {
  stress.preset = id;
  store.set("stress.preset", id);
  $("stressPreset").value = id;
  $("stressResults").hidden = true;
}
$("stressPreset").onchange = () => load(`stress/${$("stressPreset").value}`);
$("stressSize").replaceChildren(...SIZES.map((n) => new Option(`${n}×${n} (${(n * n).toLocaleString()} cells)`, String(n))));
$("stressSize").value = String(stress.N);
$("stressSize").onchange = () => {
  stress.N = +$("stressSize").value;
  stress.reset().then(playing);
};
function engines() {
  $("stressEngines").replaceChildren(
    ...Object.entries(ENGINES).map(([k, name]) => {
      const b = document.createElement("button");
      b.textContent = name;
      b.setAttribute("aria-pressed", String(stress.engine === k));
      b.onclick = () => {
        stress.engine = k;
        engines();
        stress.reset().then(playing);
      };
      return b;
    }),
  );
}
engines();
$("stressPlay").onclick = () => {
  if (stress.playing) stress.stop();
  else stress.play();
  playing();
};
$("stressReset").onclick = () => stress.reset().then(playing);
$("stressCompare").onclick = async () => {
  const buttons = ["stressPlay", "stressReset", "stressCompare", "stressSize", "stressPreset"].map($);
  buttons.forEach((b) => (b.disabled = true));
  $("stressResults").hidden = true;
  try {
    results(await stress.compare((text) => ($("stressStats").textContent = text)));
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    playing();
  }
};
// Compare's table: each engine's agreement, speed, and speedup over the interpreter.
function results(rows) {
  const timed = rows.filter((r) => r.perTick);
  const best = Math.min(...timed.map((r) => r.perTick));
  const ms = (x) => (x < 1 ? x.toFixed(2) : x < 10 ? x.toFixed(1) : x.toFixed(0));
  $("stressResults").tBodies[0].replaceChildren(
    ...rows.map((r) => {
      const tr = document.createElement("tr");
      const cell = (text, cls = "") => Object.assign(document.createElement("td"), { textContent: text, className: cls });
      if (r.skipped) {
        tr.append(cell(ENGINES[r.engine]), Object.assign(cell(`skipped: ${r.skipped}`), { colSpan: 5 }));
        return tr;
      }
      const rate = 1000 / r.perTick;
      tr.append(
        cell(ENGINES[r.engine]),
        cell(r.agree ? "✓" : "✗ differ", r.agree ? "ok" : "bad"),
        cell(ms(r.perTick), r.perTick === best ? "best" : ""),
        cell(rate < 10 ? rate.toFixed(1) : rate.toFixed(0)),
        cell(r.speedup ? `${r.speedup < 10 ? r.speedup.toFixed(1) : r.speedup.toFixed(0)}×` : "", r.perTick === best ? "best" : ""),
        cell(r.engine === "interp" ? "—" : `${r.compileMs.toFixed(0)} ms`),
      );
      return tr;
    }),
  );
  $("stressResults").hidden = false;
  const fastest = timed.find((r) => r.perTick === best);
  $("stressStats").textContent = fastest ? `${ENGINES[fastest.engine]} is fastest at ${PRESETS[stress.preset].name}, ${stress.N}×${stress.N}${fastest.speedup ? `, ${fastest.speedup.toFixed(0)}× the interpreter` : ""}.` : "";
}
addEventListener("hashchange", () => load(location.hash.slice(1)));

load(location.hash.slice(1));
