// Phib on the GPU: runs a world's tick with the shader
// compile-gpu.js writes (GpuRunner), and draws a big world as pixels, one a
// cell, straight from the GPU's buffers (PixelView). A browser without
// WebGPU gets null from gpuDevice(), and the page runs the world on the CPU.

import { refill, regSig } from "./compile-gpu.js";

// The GPU, or null.
let devicePromise = null;
export function gpuDevice() {
  devicePromise ??= (async () => {
    if (!globalThis.navigator?.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const L = adapter.limits;
    return adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: L.maxStorageBufferBindingSize, maxBufferSize: L.maxBufferSize, maxStorageBuffersPerShaderStage: Math.min(8, L.maxStorageBuffersPerShaderStage) },
    });
  })().catch(() => null);
  return devicePromise;
}

const PARAM = 256; // bytes between one dispatch's params and the next's
const BATCH = 32; // ticks one submission may run

export class GpuRunner {
  // plan: compileGpu(w, board). Throws with the compiler's messages if the
  // WGSL is refused.
  static async create(device, plan, ids) {
    const r = new GpuRunner();
    r.device = device;
    r.plan = plan;
    const { W, H } = plan.w.level;
    r.W = W;
    r.H = H;
    r.N = W * H;
    r.slots = r.N * plan.L;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    const buf = (size, u = usage) => device.createBuffer({ size: Math.max(16, size), usage: u });
    r.cells = [buf(r.slots * 4), buf(r.slots * 4)];
    r.prop = buf(r.slots * 4);
    r.conf = buf(r.slots * 4);
    r.taken = buf(r.slots * 4);
    r.found = buf(16);
    r.where = buf(16, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    r.params = buf(PARAM * (BATCH * 2 * Math.max(1, plan.cases.length) + 1), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    await r.build();
    r.upload(ids);
    r.frog = -1;
    return r;
  }

  // The pipelines and the tables, for the plan as it is now.
  async build() {
    const d = this.device;
    const plan = this.plan;
    const module = d.createShaderModule({ code: plan.wgsl });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) throw new Error(`WGSL: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")}`);
    const storage = (n, readOnly = false) => ({ binding: n, visibility: GPUShaderStage.COMPUTE, buffer: { type: readOnly ? "read-only-storage" : "storage" } });
    this.layout = d.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 32 } }, storage(1, true), storage(2), storage(3), storage(4), storage(5), storage(6, true), storage(7)],
    });
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const pipe = (entryPoint) => d.createComputePipelineAsync({ layout, compute: { module, entryPoint } });
    [this.propose, this.accept, this.locate] = await Promise.all(["propose", "accept", "locate"].map(pipe));
    this.setTables(plan.T);
  }

  setTables(T) {
    const d = this.device;
    if (!this.tables || this.tables.size < T.byteLength) {
      this.tables?.destroy();
      this.tables = d.createBuffer({ size: Math.max(16, T.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    d.queue.writeBuffer(this.tables, 0, T);
    const [X, Y] = this.cells;
    const bind = (A, B) =>
      d.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: { buffer: this.params, size: 32 } }, ...[A, B, this.prop, this.conf, this.taken, this.tables, this.found].map((buffer, n) => ({ binding: n + 1, resource: { buffer } }))],
      });
    this.binds = [bind(X, Y), bind(Y, X)];
  }

  // The current board's buffer, for drawing.
  get current() {
    return this.cells[this.parity];
  }

  upload(ids) {
    this.parity = 0;
    this.device.queue.writeBuffer(this.cells[0], 0, ids);
  }

  // New registers: new tables (or, rarely, a new shader).
  async setRegs(regs) {
    if (regSig(this.plan, regs) === this.plan.sig) return;
    const { shader } = refill(this.plan, regs);
    if (shader) await this.build();
    else this.setTables(this.plan.T);
  }

  // Runs n ticks from tick t in one submission; the first with the key
  // pressed, if any (an input { d, far }, as terms.js's step takes). Resolves
  // when the GPU is done, with Phibber's cell found (this.frog).
  run(n, { tick = 0, seed = 0, input = null } = {}) {
    const d = this.device;
    const plan = this.plan;
    const wg = Math.ceil(this.N / 256);
    const enc = d.createCommandEncoder();
    const variant = input ? "NESW".indexOf(input.d) * 2 + (input.far ? 1 : 0) : -1;
    const steps = [];
    for (let t = 0; t < Math.min(n, BATCH); t++) {
      for (let ph = 0; ph < 2; ph++) {
        if (ph === 0 && (t > 0 || variant < 0)) continue;
        if (!plan.phases[ph].length) continue;
        steps.push({ t, ph });
      }
    }
    // Every dispatch's params, 256 bytes apart.
    const P = new Int32Array((PARAM / 4) * (steps.length * Math.max(1, plan.cases.length) + 1));
    let slot = 0;
    const param = (gi, kase, t) => {
      P.set([this.W, this.H, this.N, gi, seed | 0, (tick + t) | 0, Math.max(0, variant), kase], slot * (PARAM / 4));
      return slot++ * PARAM;
    };
    const plans = [];
    for (const { t, ph } of steps) {
      const cases = plan.cases.map((c, kase) => ({ c, kase })).filter((x) => x.c.ph === ph);
      plans.push({ t, cases: cases.map(({ c, kase }) => ({ off: param(c.gi, kase, t) })) });
    }
    const locateOff = param(0, 0, 0);
    d.queue.writeBuffer(this.params, 0, P, 0, slot * (PARAM / 4));
    const bytes = this.slots * 4;
    for (const s of plans) {
      const bg = this.binds[this.parity];
      enc.copyBufferToBuffer(this.cells[this.parity], 0, this.cells[this.parity ^ 1], 0, bytes);
      enc.clearBuffer(this.taken);
      for (const c of s.cases) {
        enc.clearBuffer(this.prop);
        enc.clearBuffer(this.conf);
        const pass = enc.beginComputePass();
        pass.setBindGroup(0, bg, [c.off]);
        pass.setPipeline(this.propose);
        pass.dispatchWorkgroups(wg);
        pass.setPipeline(this.accept);
        pass.dispatchWorkgroups(wg);
        pass.end();
      }
      this.parity ^= 1;
    }
    // Where Phibber is now.
    enc.clearBuffer(this.found);
    const pass = enc.beginComputePass();
    pass.setPipeline(this.locate);
    pass.setBindGroup(0, this.binds[this.parity], [locateOff]);
    pass.dispatchWorkgroups(wg);
    pass.end();
    const mapping = this.where.mapState === "unmapped";
    if (mapping) enc.copyBufferToBuffer(this.found, 0, this.where, 0, 16);
    d.queue.submit([enc.finish()]);
    const done = d.queue.onSubmittedWorkDone();
    if (!mapping) return done;
    return Promise.all([
      done,
      this.where.mapAsync(GPUMapMode.READ).then(() => {
        this.frog = new Uint32Array(this.where.getMappedRange())[0] - 1;
        this.where.unmap();
      }),
    ]);
  }

  // The board's ids, read back.
  async download() {
    const d = this.device;
    const read = d.createBuffer({ size: this.slots * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyBufferToBuffer(this.current, 0, read, 0, this.slots * 4);
    d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(read.getMappedRange()).slice();
    read.unmap();
    read.destroy();
    return out;
  }

  destroy() {
    for (const b of [...this.cells, this.prop, this.conf, this.taken, this.found, this.where, this.params, this.tables]) b?.destroy();
  }
}

// ---------------- pixels ----------------

// A colour a kind of thing, by its constructor's name; else one from the name.
const HEX = {
  grass: "#1d7460", water: "#123a6b", raft: "#8a5a33", ford: "#5e5480", rock: "#2c1f55", rail: "#2f8f9a", vein: "#9a7a2a", cart: "#ff2a6d", ice: "#8fd8ef", belt: "#3a3a58", fuse: "#b08a40", ash: "#4a4458", nest: "#fffb96", trail: "#3f9a6a",
  frog: "#c6ff3a", log: "#d9a46a", stone: "#c4bde0", ore: "#ffd34a", ingot: "#f4f7fa", tree: "#b967ff", furnace: "#ff7a2a", torch: "#ffb04a", spark: "#fff3c4", charge: "#ff3a4a", boom: "#ffe36a", gate: "#ff2a6d", cloner: "#05d9e8", seed: "#3dffa2", ant: "#ff5ad1",
};
function hashHex(name) {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (0.55 - 0.41 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
// A value's colour: a Loose thing's by what it is, Some(x)'s by x.
function nameOf(v) {
  if (!v || typeof v !== "object") return String(v);
  if (v.c === "Some" || v.c === "Loose") return nameOf(v.a[0]);
  return v.c;
}
const rgba = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
};
export const colourOf = (v) => {
  const n = nameOf(v).toLowerCase();
  return HEX[n] ?? hashHex(n);
};

// Every value's colour, layer after layer; 0 (clear) for an upper layer's
// blank, so the layer under it shows.
export function palette(plan) {
  const offs = [];
  let at = 0;
  for (const vs of plan.values) {
    offs.push(at);
    at += vs.length;
  }
  const pal = new Uint32Array(Math.max(4, at));
  plan.values.forEach((vs, l) => vs.forEach((v, i) => (pal[offs[l] + i] = l > 0 && i === plan.blank[l] ? 0 : rgba(colourOf(v)))));
  return { pal, offs };
}

const drawShader = (L, offs) => `
struct Cam { cx: f32, cy: f32, scale: f32, W: f32, H: f32, vw: f32, vh: f32, frog: f32 }
@group(0) @binding(0) var<uniform> C: Cam;
@group(0) @binding(1) var<storage, read> X: array<u32>;
@group(0) @binding(2) var<storage, read> pal: array<u32>;
@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[v], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let cell = (pos.xy - vec2f(C.vw, C.vh) * 0.5) / C.scale + vec2f(C.cx, C.cy);
  if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= C.W || cell.y >= C.H) { return vec4f(0.05, 0.008, 0.13, 1.0); }
  let i = u32(cell.y) * u32(C.W) + u32(cell.x);
  var col = unpack4x8unorm(pal[${offs[0]}u + X[i * ${L}u]]);
${offs
  .slice(1)
  .map((o, n) => `  let c${n + 1} = pal[${o}u + X[i * ${L}u + ${n + 1}u]];\n  if (c${n + 1} != 0u) {\n    let f = fract(cell);\n    if (C.scale < 5.0 || (f.x > 0.15 && f.x < 0.85 && f.y > 0.15 && f.y < 0.85)) { col = unpack4x8unorm(c${n + 1}); }\n  }`)
  .join("\n")}
  return vec4f(col.rgb, 1.0);
}`;

// Draws the runner's board on a canvas, one pixel a cell at scale 1, the
// camera on (cx, cy).
export class PixelView {
  constructor(canvas) {
    this.canvas = canvas;
    this.cam = { cx: 0, cy: 0, scale: 4 };
  }

  async use(device, runner) {
    this.device = device;
    this.runner = runner;
    const plan = runner.plan;
    if (!this.ctx) {
      this.ctx = this.canvas.getContext("webgpu");
      this.format = navigator.gpu.getPreferredCanvasFormat();
      this.ctx.configure({ device, format: this.format, alphaMode: "opaque" });
      this.camBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const { pal, offs } = palette(plan);
    const module = device.createShaderModule({ code: drawShader(plan.L, offs) });
    this.pipeline = await device.createRenderPipelineAsync({ layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list" } });
    this.palBuf?.destroy();
    this.palBuf = device.createBuffer({ size: pal.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.palBuf, 0, pal);
    this.binds = new Map();
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const c = this.canvas;
    const w = Math.min(8192, Math.round(c.clientWidth * dpr));
    const h = Math.min(8192, Math.round(c.clientHeight * dpr));
    if (w && h && (c.width !== w || c.height !== h)) {
      c.width = w;
      c.height = h;
    }
  }

  // The cell under a point on the page, or -1.
  cellAt(clientX, clientY) {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const dpr = c.width / r.width;
    const x = Math.floor(((clientX - r.left) * dpr - c.width / 2) / this.cam.scale + this.cam.cx);
    const y = Math.floor(((clientY - r.top) * dpr - c.height / 2) / this.cam.scale + this.cam.cy);
    const { W, H } = this.runner;
    return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
  }

  draw() {
    const d = this.device;
    const r = this.runner;
    if (!d || !r) return;
    this.resize();
    const X = r.current;
    if (!this.binds.has(X)) this.binds.set(X, d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [this.camBuf, X, this.palBuf].map((buffer, n) => ({ binding: n, resource: { buffer } })) }));
    const c = this.canvas;
    d.queue.writeBuffer(this.camBuf, 0, new Float32Array([this.cam.cx, this.cam.cy, this.cam.scale, r.W, r.H, c.width, c.height, 0]));
    const enc = d.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0.05, g: 0.01, b: 0.13, a: 1 } }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.binds.get(X));
    pass.draw(3);
    pass.end();
    d.queue.submit([enc.finish()]);
  }
}
