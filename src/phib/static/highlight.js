// Code in colour: Phib's language, and the two it compiles to,
// JavaScript (compile.js) and WGSL (compile-gpu.js).
//
// Each language is cut into runs, lines of [class, text]; the app shows runs
// as spans with style.css's tk-* classes (highlightHtml, highlightLines), an
// editable field gets its colours from a copy drawn behind it (codeOverlay),
// and pages without the stylesheet, the site's notes (```phib fences, by
// site/src/satteri-phib.mjs), get the colours written in (preview).
//
// Phib: a statement's first word (recipe, type, level, map ...) and words
// with a meaning mid-line (on, where, chance ...), constructors and Dir
// literals, variables, numbers, strings with their {expressions}, arrows,
// the cell's `/` and `*` and `_`, comments; the rows under `map` by what
// each character usually is.

// ---- phib ----

const HEAD = new Set("use type cell pattern fun look group recipe yours level intro hint par solution map legend goal reg game by about won flow undo score define hud when once shop start gen endless blueprint thing without seed let fill put scatter field zone place sites layer item currency pick desc needs repeat good warn max of say win lose enable disable tick pass if else".split(" "));
const MID = new Set("on where chance add limit in at size door to href prop sign color hint except rotates then else mod true false none along width margin turns nothing from max no only".split(" "));
const DIRS = new Set(["N", "E", "S", "W"]);
const TYPES = new Set(["Bool", "Dir", "Nat", "Int"]);

const PHIB = /(\/\/.*$)|("(?:[^"\\]|\\.)*")|(->|=>|\+=|-=|==|!=|<=|>=|&&|\|\|)|(\b\d+(?:\.\d+)?%?)|([A-Z][\w']*)|([a-z_][\w']*)|(\s+)|([/*|@!{}()[\],:=<>+-])|(.)/g;

function phibLine(text, out) {
  let atStart = true;
  let m;
  PHIB.lastIndex = 0;
  while ((m = PHIB.exec(text))) {
    const [t, comment, str, op, num, con, word, space, sym] = m;
    if (comment) out("tk-comment", comment);
    else if (str) for (const p of str.split(/(\{[^}]*\})/)) p && out(p.startsWith("{") ? "tk-expr" : "tk-str", p);
    else if (op) out("tk-op", op);
    else if (num) out("tk-num", num);
    else if (con) out(DIRS.has(con) ? "tk-dir" : TYPES.has(con) ? "tk-type" : "tk-con", con);
    else if (word) out(atStart && (HEAD.has(word) || MID.has(word)) ? "tk-key" : MID.has(word) ? "tk-word" : word === "_" ? "tk-any" : "tk-var", word);
    else if (space) out(null, space);
    else if (sym) out(sym === "/" ? "tk-layer" : sym === "*" ? "tk-keep" : "tk-op", sym);
    else out(null, t);
    if (!space) atStart = false;
  }
}

// A map row: walls, water, Phibber and things by their usual characters.
const MAPCH = (ch) => (ch === "#" ? "tk-m-wall" : "~^v<>≈".includes(ch) ? "tk-m-water" : ch === "@" ? "tk-m-frog" : ch === "." ? "tk-m-dot" : /\s/.test(ch) ? null : "tk-m-thing");

function phibRuns(text) {
  let inMap = false;
  return String(text)
    .split("\n")
    .map((raw) => {
      const runs = [];
      const out = (cls, t) => {
        const last = runs.at(-1);
        if (last && last[0] === cls) last[1] += t;
        else runs.push([cls, t]);
      };
      const indent = raw.length - raw.trimStart().length;
      if (inMap && indent > 0 && raw.trim() && !raw.trim().startsWith("//")) {
        out(null, raw.slice(0, indent));
        for (const ch of raw.slice(indent)) out(MAPCH(ch), ch);
        return runs;
      }
      inMap = /^\s*map\s*$/.test(raw);
      phibLine(raw, out);
      return runs;
    });
}

// ---- JavaScript and WGSL ----

const CODE_WORDS = {
  js: "const let var function return if else for while do break continue new of in typeof instanceof switch case default null undefined true false this throw try catch finally",
  wgsl: "fn let var const return if else for loop while break continue switch case default struct true false override discard",
};
const CODE_TYPES = /^(?:[iuf]32|bool|vec[234][iuf]?|mat\d(?:x\d)?[f]?|array|atomic|ptr|texture\w*|sampler|Int32Array|Uint8Array|Uint32Array|Float64Array|Map|Set|Math)$/;
const CODE = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(=>|->)|(@[A-Za-z_]\w*)|(\b0x[\da-fA-F]+[iu]?\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?[iuf]?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|(\s+)|([^\s\w])/g;

function codeRuns(text, lang) {
  const words = new Set(CODE_WORDS[lang].split(" "));
  let inBlock = false;
  return String(text)
    .split("\n")
    .map((line) => {
      const runs = [];
      const out = (cls, t) => {
        const last = runs.at(-1);
        if (last && last[0] === cls) last[1] += t;
        else runs.push([cls, t]);
      };
      let rest = line;
      // /* … */ comments, which may run over lines.
      if (inBlock) {
        const end = rest.indexOf("*/");
        if (end < 0) return [["tk-comment", rest]];
        out("tk-comment", rest.slice(0, end + 2));
        rest = rest.slice(end + 2);
        inBlock = false;
      }
      let tail = null;
      const start = rest.indexOf("/*");
      if (start >= 0 && !/(\/\/|["'`])/.test(rest.slice(0, start)) && rest.indexOf("*/", start + 2) < 0) {
        tail = rest.slice(start);
        rest = rest.slice(0, start);
        inBlock = true;
      }
      let m;
      CODE.lastIndex = 0;
      while ((m = CODE.exec(rest))) {
        const [t, comment, str, arrow, attr, num, call, word, space] = m;
        if (comment) out("tk-comment", comment);
        else if (str) out("tk-str", str);
        else if (arrow) out("tk-op", arrow);
        else if (attr) out("tk-key", attr);
        else if (num) out("tk-num", num);
        else if (call) out(words.has(call) ? "tk-key" : CODE_TYPES.test(call) ? "tk-type" : "tk-con", call);
        else if (word) out(words.has(word) ? "tk-key" : CODE_TYPES.test(word) ? "tk-type" : "tk-var", word);
        else if (space) out(null, space);
        else out("tk-op", t);
      }
      if (tail) out("tk-comment", tail);
      return runs;
    });
}

// ---- out ----

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Lines of [class, text] runs for `text` in `lang` (phib, js or wgsl). */
export function runs(text, lang = "phib") {
  return lang === "phib" ? phibRuns(text) : codeRuns(text, lang);
}

/** Each line as HTML spans with style.css's tk-* classes. */
export function highlightLines(text, lang = "phib") {
  return runs(text, lang).map((line) => line.map(([cls, t]) => (cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t))).join(""));
}

/** The whole text as HTML spans with style.css's tk-* classes. */
export const highlightHtml = (text, lang = "phib") => highlightLines(text, lang).join("\n");

// The colours, written in, for pages without style.css.
const C = { panel: "#1a0e3f", line: "#4a2c8f", text: "#ece6ff", muted: "#a397cf", pink: "#ff2a6d", cyan: "#05d9e8", purple: "#b967ff", yellow: "#fffb96", green: "#3dffa2" };
export const STYLE = {
  "tk-key": `color:${C.pink}`,
  "tk-word": `color:${C.pink}`,
  "tk-con": `color:${C.green}`,
  "tk-dir": `color:${C.cyan}`,
  "tk-type": `color:${C.cyan}`,
  "tk-var": "",
  "tk-any": `color:${C.muted}`,
  "tk-keep": `color:${C.muted}`,
  "tk-layer": `color:${C.pink};font-weight:800`,
  "tk-str": `color:${C.yellow}`,
  "tk-expr": `color:${C.cyan}`,
  "tk-num": `color:${C.purple}`,
  "tk-op": `color:${C.cyan}`,
  "tk-comment": `color:${C.muted};font-style:italic`,
  "tk-m-wall": `color:${C.muted}`,
  "tk-m-water": `color:${C.cyan}`,
  "tk-m-frog": `color:${C.green};font-weight:800`,
  "tk-m-thing": `color:${C.yellow}`,
  "tk-m-dot": "color:#4b3d7a",
};

/** The text as HTML with the colours written in. */
export function highlight(text, lang = "phib") {
  return runs(text, lang)
    .map((line) => line.map(([cls, t]) => (cls && STYLE[cls] ? `<span style="${STYLE[cls]}">${esc(t)}</span>` : esc(t))).join(""))
    .join("\n");
}

/** A whole read-only view, styled in place: code anywhere HTML goes. */
export function preview(text, lang = "phib") {
  const box = `margin:0 0 1em;padding:8px 10px;overflow:auto;white-space:pre;tab-size:2;font:12px/1.4 ui-monospace,'JetBrains Mono','SF Mono',Menlo,Consolas,monospace;background:${C.panel};color:${C.text};border:1px solid ${C.line};border-radius:7px`;
  return `<pre class="phib-view" style="${box}"><code style="font:inherit;background:none;color:inherit;padding:0">${highlight(text, lang)}</code></pre>`;
}

/**
 * Colours an editable field (a textarea or a one-line input) as it is
 * typed in: its text is drawn in colour in a <pre> behind it, and the field's
 * own text is transparent, so typing, selecting and undo are the browser's
 * own. Returns the wrapper, which takes the field's place.
 */
export function codeOverlay(field, lang = "phib") {
  const box = document.createElement("div");
  box.className = `tk-field${field.tagName === "INPUT" ? " tk-line" : ""}`;
  const pre = document.createElement("pre");
  pre.setAttribute("aria-hidden", "true");
  field.classList.add("tk-input");
  if (field.parentNode) field.replaceWith(box);
  box.append(pre, field);
  const sync = () => {
    pre.scrollTop = field.scrollTop;
    pre.scrollLeft = field.scrollLeft;
  };
  const paint = () => {
    // A trailing newline needs a line of its own to show.
    pre.innerHTML = `${highlightHtml(field.value, lang)}${field.value.endsWith("\n") ? " " : ""}`;
    sync();
  };
  field.addEventListener("input", paint);
  field.addEventListener("scroll", sync);
  // A value set by code (field.value = …) repaints too.
  const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value");
  Object.defineProperty(field, "value", {
    configurable: true,
    get: () => own.get.call(field),
    set: (v) => {
      own.set.call(field, v);
      paint();
    },
  });
  paint();
  return box;
}
