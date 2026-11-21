// The stress test: a cellular automaton (stress/*.phib, one a preset) on a
// big random board, run by each of Phib's engines: interpreted (terms.js),
// compiled to JavaScript (compile.js) and compiled to WGSL for the GPU
// (compile-gpu.js, gpu.js). Each draws a pixel a cell. Compare checks that
// every engine makes the same boards from the same start, then times each.
import { read } from "./content.js";
import { useCompiled } from "./compile.js";
import { compileGpu, toIds } from "./compile-gpu.js";
import { GpuRunner, gpuDevice, PixelView } from "./gpu.js";
import { parse } from "./syntax.js";
import { build, key, start, step } from "./terms.js";

export const SIZES = [128, 256, 512, 1024];
export const ENGINES = { interp: "Interpreted", compiled: "Compiled to JS", gpu: "GPU (WGSL)" };
const BUDGET = 24; // ms of ticking a frame, on the CPU
const SLOW = 4000; // ms: a tick slower than this isn't timed
const BATCH = 32; // the most ticks one GPU submission runs (gpu.js)

// Colours as RGBA bytes (R lowest), the same on the CPU's canvas and the GPU's.
const rgb = (hex) => (0xff000000 | (hex & 0xff) << 16 | (hex & 0xff00) | (hex >> 16)) >>> 0;
const BG = rgb(0x140d2a);
const ANT = rgb(0xff4d4d);

// Each preset: its world, what it's about, a cell of its random board (a
// legend character, from rand()), and each constructor's colour. A layer
// above the first that has no colour for a value (Clear) shows the one under it.
export const PRESETS = {
  life: {
    name: "Life",
    file: "life",
    about: "Conway's Life, one recipe.",
    cell: (rand) => (rand() < 0.3 ? "#" : "."),
    colours: { Dead: BG, Alive: rgb(0xa6f26f) },
  },
  ants: {
    name: "Langton's ants",
    file: "ants",
    about: "Thousands of Langton's ants on one board, three recipes: two to turn, flip and step, and one for an ant that's blocked.",
    cell: (rand) => (rand() < 0.003 ? "nesw"[Math.floor(rand() * 4)] : "."),
    colours: { White: BG, Black: rgb(0x5fb3ff), Ant: ANT },
  },
  lifeants: {
    name: "Life + ants",
    file: "lifeants",
    about: "Life, with ants crossing it: straight on over dead cells, right at live ones, sowing a dead cell they leave and clearing a live one, so each trails a spray of Life.",
    cell: (rand) => (rand() < 0.002 ? "nesw"[Math.floor(rand() * 4)] : rand() < 0.3 ? "#" : "."),
    colours: { Dead: BG, Alive: rgb(0xa6f26f), Ant: ANT },
  },
  moths: {
    name: "Moths in the weave",
    file: "moths",
    about: "A three-state rule that knits noise into a maze of stripes and stops, and moths, Langton's ants, that keep chewing holes in it for the weave to mend.",
    cell: (rand) => (rand() < 0.0005 ? "nesw"[Math.floor(rand() * 4)] : rand() < 0.3 ? "#" : "."),
    colours: { Bare: BG, Thread: rgb(0xf2e6c9), Frayed: rgb(0xff9f43), Moth: ANT },
  },
  starships: {
    name: "Starships",
    file: "starships",
    about: "A four-state rule, one recipe: noise clears into a dark sky full of gliders, arrowheads and long trains.",
    cell: (rand) => (rand() < 0.3 ? "#" : "."),
    colours: { Off: BG, On: rgb(0xffffff), Fading: rgb(0xffd25f), Faint: rgb(0x7a2fbf) },
  },
  brain: {
    name: "Brian's Brain",
    file: "brain",
    about: "Brian's Brain, one recipe of three states: nothing stays on, so it never settles.",
    cell: (rand) => (rand() < 0.2 ? "#" : "."),
    colours: { Off: BG, On: rgb(0xffffff), Dying: rgb(0x3d6fff) },
  },
  rps: {
    name: "Rock, paper, scissors",
    file: "rps",
    about: "A cyclic automaton, one recipe: a cell becomes what beats it once three neighbours have. Noise turns into spirals.",
    cell: (rand) => "rps"[Math.floor(rand() * 3)],
    colours: { Rock: rgb(0xff5f7a), Paper: rgb(0xffd25f), Scissors: rgb(0x4fd1c5) },
  },
};
const SOURCES = Object.fromEntries(await Promise.all(Object.entries(PRESETS).map(async ([id, p]) => [id, await read(`./stress/${p.file}.phib`)])));

// A preset's world N cells square, at random, the same for a seed.
export function stressWorld(preset, N, seed = 1) {
  const P = PRESETS[preset];
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rows = Array.from({ length: N }, () => `  ${Array.from({ length: N }, () => P.cell(rand)).join("")}`);
  return build(parse(`${SOURCES[preset]}\nlevel stress "${P.name}, ${N}×${N}"\nmap\n${rows.join("\n")}\n`), 0);
}
export const lifeWorld = (N, seed) => stressWorld("life", N, seed);

// A value's colour in layer l, or 0 for none (an upper layer's blank).
function colourOf(preset, v, l) {
  const c = PRESETS[preset].colours[v?.c];
  return c ?? (l ? 0 : BG);
}

const sameBoards = (a, b) => a.length === b.length && a.every((v, i) => key(v) === key(b[i]));

export class Stress {
  constructor({ canvas, pixels, stats, onWorld }) {
    Object.assign(this, { canvas, pixels: new PixelView(pixels), pixelsEl: pixels, stats, onWorld });
    this.N = 128;
    this.preset = "life";
    this.engine = "compiled";
    this.playing = false;
    this.token = 0;
  }

  // A fresh world at the current size, on the current engine.
  async reset() {
    this.stop();
    const token = ++this.token;
    this.w = stressWorld(this.preset, this.N);
    this.onWorld?.(this.w);
    this.st = start(this.w);
    this.gpu?.runner.destroy();
    this.gpu = null;
    this.compileMs = 0;
    if (this.engine === "compiled") {
      const t0 = performance.now();
      useCompiled(this.w);
      this.compileMs = performance.now() - t0;
    }
    if (this.engine === "gpu") {
      try {
        this.gpu = await this.startGpu(this.w, this.st.board);
      } catch (err) {
        if (token !== this.token) return;
        this.stats(`No GPU here (${err.message}). Pick Interpreted or Compiled.`);
        this.showPixels(false);
        return;
      }
      if (token !== this.token) return this.gpu.runner.destroy();
    }
    this.showPixels(!!this.gpu);
    this.ticks = 0;
    this.ms = 0;
    this.draw();
    this.report();
  }

  async startGpu(w, board) {
    const device = await gpuDevice();
    if (!device) throw new Error("this browser has no WebGPU");
    const t0 = performance.now();
    const plan = compileGpu(w, board);
    const runner = await GpuRunner.create(device, plan, toIds(plan, board));
    this.compileMs = performance.now() - t0;
    await this.pixels.use(device, runner);
    // The pixels in the preset's colours, not gpu.js's hashed ones.
    const pal = new Uint32Array(Math.max(4, plan.values.reduce((n, vs) => n + vs.length, 0)));
    let at = 0;
    plan.values.forEach((vs, l) => vs.forEach((v) => (pal[at++] = colourOf(this.preset, v, l))));
    device.queue.writeBuffer(this.pixels.palBuf, 0, pal);
    return { device, plan, runner, tick: 0 };
  }

  showPixels(on) {
    this.canvas.hidden = on;
    this.pixelsEl.hidden = !on;
  }

  play() {
    if (this.playing) return;
    this.playing = true;
    const frame = async () => {
      if (!this.playing) return;
      await this.burst();
      this.draw();
      this.report();
      if (this.playing) this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  // As many ticks as fit a frame (at least one).
  async burst() {
    const t0 = performance.now();
    if (this.gpu) {
      const g = this.gpu;
      // Enough ticks a call to keep the GPU busy, and the page smooth.
      const n = Math.max(1, Math.min(BATCH, Math.round(this.gpuBatch ?? 4)));
      await g.runner.run(n, { tick: g.tick });
      g.tick += n;
      const ms = performance.now() - t0;
      this.gpuBatch = Math.max(1, Math.min(BATCH, n * (ms < 12 ? 2 : ms > 24 ? 0.5 : 1)));
      this.ticks += n;
    } else {
      do {
        this.st = step(this.w, this.st, null);
        this.ticks++;
      } while (performance.now() - t0 < BUDGET);
    }
    this.ms += performance.now() - t0;
  }

  draw() {
    if (this.gpu) {
      const c = this.pixelsEl;
      this.pixels.cam = { cx: this.N / 2, cy: this.N / 2, scale: Math.max(0.5, Math.min(c.clientWidth, c.clientHeight) * Math.min(2, devicePixelRatio || 1) / this.N) };
      this.pixels.draw();
      return;
    }
    const { N } = this;
    if (this.canvas.width !== N) this.canvas.width = this.canvas.height = N;
    const ctx = this.canvas.getContext("2d");
    const img = ctx.createImageData(N, N);
    const px = new Uint32Array(img.data.buffer);
    const board = this.st.board;
    const L = this.w.L;
    // Each value's colour, once: the top layer's, unless it has none.
    const memo = Array.from({ length: L }, () => new Map());
    const colour = (v, l) => {
      let c = memo[l].get(v);
      if (c === undefined) memo[l].set(v, (c = colourOf(this.preset, v, l)));
      return c;
    };
    for (let i = 0; i < N * N; i++) {
      let c = 0;
      for (let l = L - 1; l >= 0 && !c; l--) c = colour(board[i * L + l], l);
      px[i] = c;
    }
    ctx.putImageData(img, 0, 0);
  }

  report() {
    const per = this.ticks ? this.ms / this.ticks : 0;
    const rate = per ? 1000 / per : 0;
    const cells = this.N * this.N;
    const compiled = this.engine === "interp" ? "" : ` · compiled in ${this.compileMs.toFixed(0)} ms`;
    this.stats(
      `${PRESETS[this.preset].name} · ${ENGINES[this.engine]} · ${this.N}×${this.N} = ${cells.toLocaleString()} cells · ${this.ticks} ticks · ` +
        (per ? `${per < 1 ? per.toFixed(2) : per.toFixed(1)} ms a tick, ${rate.toFixed(rate < 10 ? 1 : 0)} ticks/s, ${fmt(rate * cells)} cells/s` : "press Play") +
        compiled,
    );
  }

  // Every engine from the same start: first that they agree, tick for tick,
  // then how fast each goes. `progress(text)` says what it's doing.
  async compare(progress) {
    this.stop();
    const N = this.N;
    const CHECK = 12;
    const out = [];
    const base = stressWorld(this.preset, N);
    const st0 = start(base);
    // The interpreter's boards are the reference.
    progress(`Checking ${CHECK} ticks interpreted…`);
    await pause();
    const ref = [];
    let st = st0;
    for (let t = 0; t < CHECK; t++) {
      const t0 = performance.now();
      st = step(base, st, null);
      ref.push(st.board);
      // A slow interpreter checks two ticks, not twelve.
      if (t >= 1 && performance.now() - t0 > 1000) break;
      await pause();
    }
    for (const engine of Object.keys(ENGINES)) {
      progress(`${ENGINES[engine]}: checking, then timing…`);
      await pause();
      try {
        out.push(await this.measure(engine, N, st0, ref));
      } catch (err) {
        out.push({ engine, skipped: err.message });
      }
    }
    const interp = out.find((r) => r.engine === "interp" && r.perTick);
    for (const r of out) if (interp && r.perTick) r.speedup = interp.perTick / r.perTick;
    await this.reset();
    return out;
  }

  async measure(engine, N, st0, ref) {
    const w = stressWorld(this.preset, N);
    let compileMs = 0;
    if (engine === "gpu") {
      const g = await this.startGpu(w, st0.board);
      try {
        compileMs = this.compileMs;
        // Agreement: the GPU's value ids against the interpreter's boards'.
        let agree = true;
        for (let t = 0; t < ref.length && agree; t++) {
          await g.runner.run(1, { tick: t });
          const ids = await g.runner.download();
          const want = toIds(g.plan, ref[t]);
          agree = ids.length === want.length && ids.every((x, i) => x === want[i]);
        }
        // Speed: full batches for about two seconds.
        const t0 = performance.now();
        let ticks = 0;
        while (performance.now() - t0 < 2000) {
          await g.runner.run(BATCH, { tick: ref.length + ticks });
          ticks += BATCH;
        }
        return { engine, agree, ticks, perTick: (performance.now() - t0) / ticks, compileMs };
      } finally {
        g.runner.destroy();
      }
    }
    if (engine === "compiled") {
      const t0 = performance.now();
      useCompiled(w);
      compileMs = performance.now() - t0;
    }
    // Agreement, tick for tick.
    let st = st0;
    let agree = true;
    for (let t = 0; t < ref.length && agree; t++) {
      st = step(w, st, null);
      agree = sameBoards(st.board, ref[t]);
    }
    // Speed: ticks for about two seconds, yielding now and then.
    const t0 = performance.now();
    let ticks = 0;
    do {
      const one = performance.now();
      st = step(w, st, null);
      ticks++;
      if (performance.now() - one > SLOW) break;
      if (ticks % 4 === 0) await pause();
    } while (performance.now() - t0 < 2000);
    return { engine, agree, ticks, perTick: (performance.now() - t0) / ticks, compileMs };
  }
}

const pause = () => new Promise((r) => setTimeout(r, 0));
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0));
