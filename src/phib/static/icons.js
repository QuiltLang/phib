// Flat icons for recipe cards and the editor's brushes: a recipe reads best
// as a little picture, Before → After. Same palette as the 3D board.

const C = {
  grass: ["#1f7a64", "#1b6d5a"], water: "#123a6b", waterHi: "#5aebf5", rock: "#3b2a6e", rockHi: "#b967ff", log: "#8a5a33", logEnd: "#d9b382",
  stone: "#9a92b8", stoneHi: "#c4bde0", gold: "#f6c85f", goldHi: "#fff3c4", ingot: "#dfe6f0", tree: "#b967ff", treeHi: "#ff2a6d",
  furnace: "#3a2440", fire: "#ff7a2a", fireHi: "#ffd36a", rail: "#05d9e8", tie: "#5a3a2a", cart: "#ff2a6d",
  ink: "#ece6ff", muted: "#a397cf", lotus: "#f08bb0", panel: "#1a0e3f", pink: "#ff2a6d", cyan: "#05d9e8", green: "#3dffa2", purple: "#b967ff",
};
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// Phibber from above, flat: four legs splayed, a round body, his head with
// two big eyes, and his shutter shades across them. Head up, centred on the
// origin, about s across; drawn with an outline so he reads on any ground.
const FROG_C = { skin: "#a6e22e", dark: "#5f8f17", belly: "#c9f26b", eye: "#f7f0a0", pupil: "#141414" };
const SHADES_Y = -0.2; // where his shades sit, as a fraction of s

function drawFrog(g, s) {
  const line = Math.max(1, s * 0.035);
  const blob = (cx, cy, rx, ry, fill, rot = 0) => {
    g.beginPath();
    g.ellipse(cx * s, cy * s, rx * s, ry * s, rot, 0, 7);
    g.fillStyle = fill;
    g.fill();
    g.lineWidth = line;
    g.strokeStyle = FROG_C.dark;
    g.stroke();
  };
  // Legs: back ones long and bent out, front ones short.
  for (const sx of [-1, 1]) {
    blob(sx * 0.27, 0.22, 0.17, 0.08, FROG_C.skin, sx * 0.7);
    blob(sx * 0.33, 0.34, 0.08, 0.05, FROG_C.skin, sx * 0.2);
    blob(sx * 0.24, -0.08, 0.1, 0.05, FROG_C.skin, -sx * 0.6);
  }
  blob(0, 0.1, 0.24, 0.27, FROG_C.skin); // body
  blob(0, 0.13, 0.12, 0.13, FROG_C.belly); // a lighter back
  blob(0, -0.17, 0.2, 0.15, FROG_C.skin); // head
  // Eyes on top of his head, pupils looking ahead.
  for (const sx of [-1, 1]) {
    blob(sx * 0.11, -0.25, 0.075, 0.075, FROG_C.eye);
    g.fillStyle = FROG_C.pupil;
    g.beginPath();
    g.ellipse(sx * 0.11 * s, -0.27 * s, 0.032 * s, 0.026 * s, 0, 0, 7);
    g.fill();
  }
}

export function hashCss(name) {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 75% 55%)`;
}

function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function chevron(g, cx, cy, d, len, col, lw) {
  g.save();
  g.translate(cx, cy);
  g.rotate((d * Math.PI) / 2);
  g.strokeStyle = col;
  g.lineWidth = lw;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(-len, len * 0.55);
  g.lineTo(0, -len * 0.45);
  g.lineTo(len, len * 0.55);
  g.stroke();
  g.restore();
}
function label(g, x, y, s, text, color, size = 0.22) {
  g.fillStyle = color;
  g.font = `700 ${s * (text.length > 6 ? size * 0.8 : size)}px ui-monospace, Menlo, monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x + s / 2, y + s / 2);
}

export function ground(g, x, y, s, kind, d = -1) {
  const fill = (c) => {
    g.fillStyle = c;
    g.fillRect(x, y, s + 0.5, s + 0.5);
  };
  switch (kind) {
    case "grass":
      fill(C.grass[0]);
      break;
    case "water":
      fill(C.water);
      if (d >= 0) chevron(g, x + s / 2, y + s / 2, d, s * 0.16, C.waterHi, Math.max(1, s * 0.06));
      break;
    case "raft":
      fill(C.water);
      for (let k = 0; k < 3; k++) {
        g.fillStyle = C.log;
        rr(g, x + s * 0.1, y + s * (0.14 + k * 0.25), s * 0.8, s * 0.2, s * 0.08);
        g.fill();
      }
      if (d >= 0) chevron(g, x + s / 2, y + s / 2, d, s * 0.14, C.waterHi, Math.max(1, s * 0.06));
      break;
    case "ford":
      fill(C.water);
      g.fillStyle = C.stone;
      for (const [a, b, r] of [[0.3, 0.3, 0.2], [0.68, 0.36, 0.18], [0.42, 0.7, 0.22]]) {
        g.beginPath();
        g.ellipse(x + s * a, y + s * b, s * r, s * r * 0.8, 0, 0, 7);
        g.fill();
      }
      break;
    case "rock":
      fill(C.rock);
      g.strokeStyle = C.rockHi;
      g.lineWidth = Math.max(1, s * 0.05);
      g.strokeRect(x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84);
      break;
    case "rail":
    case "cart":
      fill(C.grass[1]);
      g.fillStyle = C.tie;
      for (let k = 0; k < 3; k++) g.fillRect(x + s * (0.12 + k * 0.3), y + s * 0.2, s * 0.12, s * 0.6);
      g.fillStyle = C.rail;
      g.fillRect(x, y + s * 0.3, s, s * 0.06);
      g.fillRect(x, y + s * 0.64, s, s * 0.06);
      if (kind === "cart") {
        g.save();
        g.translate(x + s / 2, y + s / 2);
        g.rotate((((d >= 0 ? d : 1) - 1) * Math.PI) / 2);
        g.fillStyle = C.cart;
        rr(g, -s * 0.38, -s * 0.28, s * 0.76, s * 0.56, s * 0.1);
        g.fill();
        g.fillStyle = C.fireHi;
        g.fillRect(s * 0.3, -s * 0.2, s * 0.08, s * 0.4);
        g.restore();
      }
      break;
    case "vein":
      fill(C.rock);
      g.fillStyle = C.gold;
      for (const [a, b] of [[0.32, 0.4], [0.58, 0.5], [0.44, 0.64]]) g.fillRect(x + s * a, y + s * b, s * 0.1, s * 0.1);
      break;
    case "ice":
      fill("#8fd8ef");
      g.strokeStyle = "#ffffff";
      g.lineWidth = Math.max(1, s * 0.04);
      g.beginPath();
      g.moveTo(x + s * 0.2, y + s * 0.35);
      g.lineTo(x + s * 0.45, y + s * 0.18);
      g.moveTo(x + s * 0.5, y + s * 0.8);
      g.lineTo(x + s * 0.8, y + s * 0.55);
      g.stroke();
      // Windy ice: a white chevron the way the wind blows.
      if (d >= 0) chevron(g, x + s / 2, y + s / 2, d, s * 0.14, "#ffffff", Math.max(1, s * 0.06));
      break;
    case "belt":
      fill("#1a1440");
      chevron(g, x + s / 2, y + s / 2, d >= 0 ? d : 1, s * 0.18, C.green, Math.max(1.2, s * 0.08));
      break;
    case "lily":
      // A round green leaf on the water, its notch facing up and a pink bud on it.
      fill(C.water);
      g.fillStyle = "#2f9a5c";
      g.beginPath();
      g.moveTo(x + s / 2, y + s / 2);
      g.arc(x + s / 2, y + s / 2, s * 0.4, -Math.PI / 2 + 0.35, Math.PI * 1.5 - 0.35);
      g.closePath();
      g.fill();
      g.fillStyle = C.lotus;
      g.beginPath();
      g.arc(x + s * 0.36, y + s * 0.62, s * 0.08, 0, 7);
      g.fill();
      break;
    case "pot":
      fill(C.water);
      g.fillStyle = "#c8643c";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.32, 0, 7);
      g.fill();
      g.fillStyle = "#2a1208";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.18, 0, 7);
      g.fill();
      chevron(g, x + s / 2 + DX[d >= 0 ? d : 0] * s * 0.36, y + s / 2 + DY[d >= 0 ? d : 0] * s * 0.36, d >= 0 ? d : 0, s * 0.1, "#ffb04a", Math.max(1, s * 0.06));
      break;
    case "shards":
      fill(C.water);
      g.fillStyle = "#a85434";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.26, 0, 7);
      g.fill();
      g.fillStyle = "#2a1208";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.15, 0, 7);
      g.fill();
      g.fillStyle = "#a85434";
      for (const [a, b] of [[0.16, 0.8], [0.84, 0.74], [0.7, 0.14]]) g.fillRect(x + s * a - s * 0.06, y + s * b - s * 0.04, s * 0.12, s * 0.08);
      break;
    case "mole": {
      // A mound of earth on the grass, the mole's pink snout poking out the way it tunnels.
      fill(C.grass[0]);
      const f = d >= 0 ? d : 2;
      g.fillStyle = "#6b4a2e";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.32, 0, 7);
      g.fill();
      g.fillStyle = "#2a2236";
      g.beginPath();
      g.arc(x + s / 2 + DX[f] * s * 0.22, y + s / 2 + DY[f] * s * 0.22, s * 0.13, 0, 7);
      g.fill();
      g.fillStyle = "#ff8fb1";
      g.beginPath();
      g.arc(x + s / 2 + DX[f] * s * 0.36, y + s / 2 + DY[f] * s * 0.36, s * 0.06, 0, 7);
      g.fill();
      break;
    }
    case "sluice": {
      // A plank gate across the river, between two posts, the flow it holds back marked upstream.
      fill(C.water);
      const f = d >= 0 ? d : 2;
      g.save();
      g.translate(x + s / 2, y + s / 2);
      g.rotate((f * Math.PI) / 2);
      g.fillStyle = "#8a5a33";
      g.fillRect(-s * 0.46, -s * 0.12, s * 0.92, s * 0.24);
      g.fillStyle = "#5a3a20";
      g.fillRect(-s * 0.5, -s * 0.2, s * 0.14, s * 0.4);
      g.fillRect(s * 0.36, -s * 0.2, s * 0.14, s * 0.4);
      g.restore();
      chevron(g, x + s / 2 - DX[f] * s * 0.32, y + s / 2 - DY[f] * s * 0.32, f, s * 0.1, "#05d9e8", Math.max(1, s * 0.06));
      break;
    }
    case "snag":
      fill(C.water);
      g.fillStyle = "#c9a066";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.34, 0, 7);
      g.fill();
      g.save();
      g.translate(x + s / 2, y + s / 2);
      g.rotate(((d >= 0 ? d : 0) * Math.PI) / 2);
      g.fillStyle = "#8a5a33";
      g.fillRect(-s * 0.12, -s * 0.44, s * 0.24, s * 0.88);
      g.restore();
      break;
    case "fuse":
      fill(C.grass[0]);
      g.strokeStyle = "#c9a050";
      g.lineWidth = Math.max(2, s * 0.1);
      g.beginPath();
      g.moveTo(x + s * 0.1, y + s * 0.5);
      g.quadraticCurveTo(x + s * 0.5, y + s * 0.2, x + s * 0.9, y + s * 0.5);
      g.stroke();
      break;
    case "ash":
      fill("#3a3448");
      break;
    case "flat":
      fill("#6e6046");
      g.strokeStyle = C.cyan;
      g.globalAlpha = 0.6;
      g.lineWidth = Math.max(1, s * 0.05);
      g.beginPath();
      g.moveTo(x + s * 0.15, y + s * 0.35);
      g.quadraticCurveTo(x + s * 0.5, y + s * 0.25, x + s * 0.85, y + s * 0.35);
      g.moveTo(x + s * 0.25, y + s * 0.68);
      g.quadraticCurveTo(x + s * 0.5, y + s * 0.6, x + s * 0.75, y + s * 0.68);
      g.stroke();
      g.globalAlpha = 1;
      break;
    case "trail":
      fill("#2b1040");
      g.strokeStyle = C.pink;
      g.lineWidth = Math.max(1, s * 0.05);
      rr(g, x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6, s * 0.06);
      g.stroke();
      break;
    case "nest":
      fill(C.grass[0]);
      g.fillStyle = "#2f9a5c";
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.42, 0, 7);
      g.fill();
      g.strokeStyle = "#fffb96";
      g.lineWidth = Math.max(1, s * 0.06);
      g.stroke();
      g.fillStyle = C.lotus;
      g.beginPath();
      g.arc(x + s / 2, y + s / 2, s * 0.14, 0, 7);
      g.fill();
      break;
    case "floe":
      fill("#b9e6f5");
      if (d >= 0) chevron(g, x + s / 2, y + s / 2, d, s * 0.14, "#5a8ab0", Math.max(1, s * 0.05));
      break;
    case "geode":
    case "lode":
      fill(kind === "geode" ? "#2a2a5e" : "#4a2e1e");
      g.fillStyle = kind === "geode" ? "#8be9ff" : "#ffc23d";
      for (const [a, b] of [[0.28, 0.34], [0.58, 0.44], [0.4, 0.64], [0.66, 0.7]]) g.fillRect(x + s * a, y + s * b, s * 0.11, s * 0.11);
      break;
    default:
      fill("#140832");
      g.strokeStyle = hashCss(kind);
      g.lineWidth = Math.max(1, s * 0.06);
      g.strokeRect(x + s * 0.06, y + s * 0.06, s * 0.88, s * 0.88);
      label(g, x, y, s, kind.slice(0, 7), hashCss(kind), 0.2);
  }
}

export function item(g, x, y, s, kind, o = -1) {
  const dot = (cx, cy, r, c) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(x + s * cx, y + s * cy, s * r, 0, 7);
    g.fill();
  };
  switch (kind) {
    case "none":
      return;
    case "log":
      g.fillStyle = C.log;
      rr(g, x + s * 0.12, y + s * 0.32, s * 0.76, s * 0.36, s * 0.12);
      g.fill();
      dot(0.8, 0.5, 0.12, C.logEnd);
      break;
    case "stone":
      dot(0.5, 0.54, 0.32, C.stone);
      dot(0.42, 0.44, 0.11, C.stoneHi);
      break;
    case "ore":
      g.fillStyle = C.gold;
      g.beginPath();
      g.moveTo(x + s * 0.5, y + s * 0.18);
      g.lineTo(x + s * 0.78, y + s * 0.5);
      g.lineTo(x + s * 0.5, y + s * 0.82);
      g.lineTo(x + s * 0.22, y + s * 0.5);
      g.fill();
      break;
    case "ingot":
      g.fillStyle = C.ingot;
      g.beginPath();
      g.moveTo(x + s * 0.2, y + s * 0.68);
      g.lineTo(x + s * 0.31, y + s * 0.36);
      g.lineTo(x + s * 0.69, y + s * 0.36);
      g.lineTo(x + s * 0.8, y + s * 0.68);
      g.fill();
      break;
    case "tree":
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        g.strokeStyle = k % 2 ? C.tree : C.treeHi;
        g.lineWidth = Math.max(1.5, s * 0.08);
        g.beginPath();
        g.moveTo(x + s / 2, y + s / 2);
        g.lineTo(x + s / 2 + Math.cos(a) * s * 0.38, y + s / 2 + Math.sin(a) * s * 0.38);
        g.stroke();
      }
      dot(0.5, 0.5, 0.1, "#5a3a78");
      break;
    case "furnace":
      g.fillStyle = C.furnace;
      rr(g, x + s * 0.1, y + s * 0.1, s * 0.8, s * 0.8, s * 0.12);
      g.fill();
      g.fillStyle = C.fire;
      rr(g, x + s * 0.3, y + s * 0.52, s * 0.4, s * 0.28, s * 0.08);
      g.fill();
      break;
    case "torch":
      g.fillStyle = C.log;
      g.fillRect(x + s * 0.45, y + s * 0.42, s * 0.1, s * 0.44);
      g.fillStyle = C.fire;
      g.beginPath();
      g.ellipse(x + s / 2, y + s * 0.32, s * 0.13, s * 0.2, 0, 0, 7);
      g.fill();
      break;
    case "spark":
      dot(0.5, 0.5, 0.2, C.fireHi);
      dot(0.5, 0.5, 0.09, "#ffffff");
      break;
    case "charge":
      g.fillStyle = "#d23a4a";
      rr(g, x + s * 0.24, y + s * 0.3, s * 0.52, s * 0.5, s * 0.08);
      g.fill();
      g.fillStyle = "#f0e0b0";
      g.fillRect(x + s * 0.24, y + s * 0.48, s * 0.52, s * 0.1);
      break;
    case "boom":
      g.fillStyle = C.fireHi;
      g.beginPath();
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6;
        const r = s * (k % 2 ? 0.2 : 0.44);
        g.lineTo(x + s / 2 + Math.cos(a) * r, y + s / 2 + Math.sin(a) * r);
      }
      g.fill();
      break;
    case "gate":
      g.fillStyle = "#7d6142";
      for (let k = 0; k < 4; k++) g.fillRect(x + s * (0.14 + k * 0.2), y + s * 0.16, s * 0.12, s * 0.68);
      g.fillStyle = C.pink;
      g.fillRect(x + s * 0.08, y + s * 0.1, s * 0.84, s * 0.08);
      break;
    case "cloner":
      g.strokeStyle = C.cyan;
      g.lineWidth = Math.max(1.2, s * 0.06);
      rr(g, x + s * 0.14, y + s * 0.14, s * 0.72, s * 0.72, s * 0.1);
      g.stroke();
      g.fillStyle = C.purple;
      g.fillRect(x + s * 0.38, y + s * 0.38, s * 0.24, s * 0.24);
      break;
    case "mud":
      g.fillStyle = "#5a3a22";
      g.beginPath();
      g.ellipse(x + s / 2, y + s * 0.6, s * 0.32, s * 0.2, 0, 0, 7);
      g.fill();
      dot(0.4, 0.52, 0.06, "#8a6040");
      break;
    case "lodestone":
      // A dark rock with a red horseshoe magnet in it, its poles silver.
      dot(0.5, 0.58, 0.32, "#3a3448");
      g.strokeStyle = C.pink;
      g.lineWidth = Math.max(1.2, s * 0.09);
      g.beginPath();
      g.arc(x + s * 0.5, y + s * 0.46, s * 0.15, 0, Math.PI);
      g.moveTo(x + s * 0.35, y + s * 0.46);
      g.lineTo(x + s * 0.35, y + s * 0.3);
      g.moveTo(x + s * 0.65, y + s * 0.46);
      g.lineTo(x + s * 0.65, y + s * 0.3);
      g.stroke();
      g.fillStyle = C.ingot;
      g.fillRect(x + s * 0.3, y + s * 0.2, s * 0.1, s * 0.1);
      g.fillRect(x + s * 0.6, y + s * 0.2, s * 0.1, s * 0.1);
      break;
    case "heron":
      // A grey wader on thin legs, its long neck up and a yellow bill out front.
      g.strokeStyle = "#2a2440";
      g.lineWidth = Math.max(1, s * 0.04);
      g.beginPath();
      g.moveTo(x + s * 0.44, y + s * 0.62);
      g.lineTo(x + s * 0.44, y + s * 0.9);
      g.moveTo(x + s * 0.54, y + s * 0.62);
      g.lineTo(x + s * 0.54, y + s * 0.9);
      g.stroke();
      g.fillStyle = "#8fa3c0";
      g.beginPath();
      g.ellipse(x + s * 0.46, y + s * 0.54, s * 0.24, s * 0.12, -0.3, 0, 7);
      g.fill();
      g.fillRect(x + s * 0.6, y + s * 0.2, s * 0.07, s * 0.32);
      dot(0.64, 0.18, 0.08, "#dfe6f0");
      g.fillStyle = C.gold;
      g.fillRect(x + s * 0.7, y + s * 0.165, s * 0.2, s * 0.035);
      break;
    case "bellows":
      // Two wooden boards in a wedge, dark pleats between, a brass nozzle out the right.
      g.fillStyle = "#5a3020";
      g.fillRect(x + s * 0.3, y + s * 0.38, s * 0.3, s * 0.24);
      g.fillStyle = "#b0703a";
      g.beginPath();
      g.moveTo(x + s * 0.12, y + s * 0.26);
      g.lineTo(x + s * 0.66, y + s * 0.42);
      g.lineTo(x + s * 0.66, y + s * 0.47);
      g.lineTo(x + s * 0.12, y + s * 0.34);
      g.moveTo(x + s * 0.12, y + s * 0.74);
      g.lineTo(x + s * 0.66, y + s * 0.58);
      g.lineTo(x + s * 0.66, y + s * 0.53);
      g.lineTo(x + s * 0.12, y + s * 0.66);
      g.fill();
      g.fillStyle = "#d9a640";
      g.fillRect(x + s * 0.66, y + s * 0.45, s * 0.2, s * 0.1);
      break;
    case "egret":
      // A white wader on black legs with golden feet, its neck in an S and a black bill.
      g.strokeStyle = "#1a1626";
      g.lineWidth = Math.max(1, s * 0.04);
      g.beginPath();
      g.moveTo(x + s * 0.42, y + s * 0.62);
      g.lineTo(x + s * 0.42, y + s * 0.88);
      g.moveTo(x + s * 0.52, y + s * 0.62);
      g.lineTo(x + s * 0.52, y + s * 0.88);
      g.stroke();
      dot(0.42, 0.9, 0.04, C.gold);
      dot(0.52, 0.9, 0.04, C.gold);
      g.fillStyle = "#f4f7fb";
      g.beginPath();
      g.ellipse(x + s * 0.44, y + s * 0.54, s * 0.22, s * 0.11, -0.3, 0, 7);
      g.fill();
      g.strokeStyle = "#f4f7fb";
      g.lineWidth = Math.max(1, s * 0.06);
      g.beginPath();
      g.moveTo(x + s * 0.58, y + s * 0.46);
      g.quadraticCurveTo(x + s * 0.5, y + s * 0.34, x + s * 0.62, y + s * 0.2);
      g.stroke();
      dot(0.63, 0.19, 0.07, "#f4f7fb");
      g.fillStyle = "#1a1626";
      g.fillRect(x + s * 0.68, y + s * 0.175, s * 0.2, s * 0.03);
    case "tortoise":
      // A domed green shell with a lighter scute on top, four stubby feet and a head out front.
      g.fillStyle = "#8a9a5b";
      for (const [fx, fy] of [[0.3, 0.72], [0.62, 0.72]]) g.fillRect(x + s * fx, y + s * fy, s * 0.1, s * 0.12);
      dot(0.8, 0.56, 0.09, "#8a9a5b");
      g.fillStyle = "#4a5a2a";
      g.beginPath();
      g.ellipse(x + s * 0.48, y + s * 0.6, s * 0.3, s * 0.2, 0, Math.PI, 0);
      g.fill();
      g.fillStyle = "#6b5a2e";
      g.fillRect(x + s * 0.17, y + s * 0.6, s * 0.62, s * 0.06);
      dot(0.48, 0.5, 0.07, C.green);
      dot(0.31, 0.56, 0.045, C.green);
      dot(0.65, 0.56, 0.045, C.green);
      dot(0.83, 0.54, 0.02, "#1a1626");
      break;
    case "reed":
      g.strokeStyle = C.green;
      g.lineWidth = Math.max(1.2, s * 0.06);
      g.beginPath();
      for (const [a, b] of [[0.5, 0.18], [0.36, 0.3], [0.64, 0.32]]) {
        g.moveTo(x + s / 2, y + s * 0.86);
        g.lineTo(x + s * a, y + s * b);
      }
      g.stroke();
      g.fillStyle = "#6a4024";
      g.fillRect(x + s * 0.45, y + s * 0.14, s * 0.1, s * 0.2);
      break;
    case "basket":
      g.fillStyle = "#c9a066";
      g.beginPath();
      g.moveTo(x + s * 0.16, y + s * 0.38);
      g.lineTo(x + s * 0.84, y + s * 0.38);
      g.lineTo(x + s * 0.72, y + s * 0.82);
      g.lineTo(x + s * 0.28, y + s * 0.82);
      g.fill();
      g.strokeStyle = "#8a6234";
      g.lineWidth = Math.max(1, s * 0.04);
      g.beginPath();
      for (const b of [0.52, 0.66]) {
        g.moveTo(x + s * 0.2, y + s * b);
        g.lineTo(x + s * 0.8, y + s * b);
      }
      g.stroke();
      g.fillStyle = "#fffb96";
      g.fillRect(x + s * 0.14, y + s * 0.34, s * 0.72, s * 0.06);
      break;
    case "seed":
      dot(0.5, 0.62, 0.12, "#7a5232");
      g.strokeStyle = C.green;
      g.lineWidth = Math.max(1.2, s * 0.06);
      g.beginPath();
      g.moveTo(x + s / 2, y + s * 0.55);
      g.lineTo(x + s / 2, y + s * 0.32);
      g.stroke();
      break;
    case "ant":
      // Drawn facing up, then turned the way it faces.
      g.save();
      g.translate(x + s / 2, y + s / 2);
      g.rotate(((o >= 0 ? o : 0) * Math.PI) / 2);
      g.strokeStyle = "#2a0a3a";
      g.lineWidth = Math.max(1, s * 0.05);
      for (const [a, b] of [[-0.3, -0.02], [0.3, -0.02], [-0.3, 0.14], [0.3, 0.14], [-0.26, 0.3], [0.26, 0.3]]) {
        g.beginPath();
        g.moveTo(0, s * (b - 0.08));
        g.lineTo(s * a, s * b);
        g.stroke();
      }
      g.fillStyle = C.pink;
      g.beginPath();
      g.ellipse(0, s * 0.2, s * 0.14, s * 0.19, 0, 0, 7);
      g.fill();
      g.fillStyle = "#2a0a3a";
      g.beginPath();
      g.arc(0, s * -0.02, s * 0.09, 0, 7);
      g.arc(0, s * -0.22, s * 0.1, 0, 7);
      g.fill();
      g.fillStyle = C.goldHi;
      for (const sx of [-0.06, 0.06]) {
        g.beginPath();
        g.arc(s * sx, s * -0.26, s * 0.03, 0, 7);
        g.fill();
      }
      g.restore();
      return;
    case "frog":
    case "walker":
    case "slider":
      g.save();
      g.translate(x + s / 2, y + s / 2);
      g.rotate(((o >= 0 ? o : 2) * Math.PI) / 2);
      drawFrog(g, s);
      // His shutter shades, across his eyes.
      g.fillStyle = C.pink;
      g.fillRect(-s * 0.2, SHADES_Y * s - s * 0.03, s * 0.4, s * 0.06);
      if (kind === "walker") chevron(g, 0, -s * 0.4, 0, s * 0.1, C.lotus, Math.max(1.5, s * 0.06));
      if (kind === "slider") {
        g.strokeStyle = "#ffffff";
        g.lineWidth = Math.max(1.2, s * 0.05);
        for (const ox of [-0.18, 0, 0.18]) {
          g.beginPath();
          g.moveTo(s * ox, s * 0.36);
          g.lineTo(s * ox, s * 0.48);
          g.stroke();
        }
      }
      g.restore();
      return;
    case "crystal":
      g.fillStyle = "#8be9ff";
      for (const [cx, h, wd] of [[0.5, 0.62, 0.13], [0.32, 0.4, 0.1], [0.68, 0.44, 0.1]]) {
        g.beginPath();
        g.moveTo(x + s * cx, y + s * (0.8 - h));
        g.lineTo(x + s * (cx + wd), y + s * 0.8);
        g.lineTo(x + s * (cx - wd), y + s * 0.8);
        g.fill();
      }
      break;
    case "gold":
      dot(0.45, 0.55, 0.2, "#ffc23d");
      dot(0.64, 0.64, 0.12, "#ffc23d");
      dot(0.4, 0.48, 0.06, "#fff3c4");
      break;
    case "bar":
      g.fillStyle = "#ffcf4a";
      for (const dy of [0.12, -0.08]) {
        g.beginPath();
        g.moveTo(x + s * 0.2, y + s * (0.68 + dy));
        g.lineTo(x + s * 0.31, y + s * (0.4 + dy));
        g.lineTo(x + s * 0.69, y + s * (0.4 + dy));
        g.lineTo(x + s * 0.8, y + s * (0.68 + dy));
        g.fill();
      }
      break;
    case "relic":
      g.fillStyle = "#ffcf4a";
      g.fillRect(x + s * 0.24, y + s * 0.66, s * 0.52, s * 0.14);
      dot(0.5, 0.46, 0.2, C.green);
      dot(0.42, 0.36, 0.05, C.pink);
      dot(0.58, 0.36, 0.05, C.pink);
      break;
    case "scroll":
      g.fillStyle = "#f3e6c4";
      g.fillRect(x + s * 0.24, y + s * 0.38, s * 0.52, s * 0.24);
      g.fillStyle = "#ffcf4a";
      g.fillRect(x + s * 0.18, y + s * 0.34, s * 0.08, s * 0.32);
      g.fillRect(x + s * 0.74, y + s * 0.34, s * 0.08, s * 0.32);
      g.fillStyle = C.pink;
      g.fillRect(x + s * 0.45, y + s * 0.36, s * 0.1, s * 0.28);
      break;
    case "portal":
      g.strokeStyle = C.pink;
      g.lineWidth = Math.max(1.5, s * 0.08);
      g.strokeRect(x + s * 0.24, y + s * 0.16, s * 0.52, s * 0.7);
      g.fillStyle = "rgba(185, 103, 255, .4)";
      g.fillRect(x + s * 0.28, y + s * 0.2, s * 0.44, s * 0.62);
      break;
    default: {
      const c = hashCss(kind);
      g.fillStyle = "#140832";
      rr(g, x + s * 0.18, y + s * 0.18, s * 0.64, s * 0.64, s * 0.08);
      g.fill();
      g.strokeStyle = c;
      g.lineWidth = Math.max(1, s * 0.05);
      g.stroke();
      label(g, x, y, s, kind.slice(0, 6), c, 0.18);
    }
  }
  if (o >= 0 && !["frog", "walker", "slider", "ant"].includes(kind)) chevron(g, x + s / 2 + DX[o] * s * 0.36, y + s / 2 + DY[o] * s * 0.36, o, s * 0.07, C.ink, Math.max(1, s * 0.04));
}

export function badge(g, x, y, s, text, color) {
  g.font = `700 ${s * 0.2}px ui-monospace, Menlo, monospace`;
  const tw = g.measureText(text).width + s * 0.12;
  g.fillStyle = "rgba(13,2,33,0.88)";
  rr(g, x + s * 0.04, y + s * 0.04, tw, s * 0.26, s * 0.08);
  g.fill();
  g.fillStyle = color;
  g.textAlign = "left";
  g.textBaseline = "middle";
  g.fillText(text, x + s * 0.1, y + s * 0.17);
}

// A brush swatch: a ground, an item on grass, or a word.
export function swatch(layer, kind, d = -1, px = 26) {
  const c = document.createElement("canvas");
  const s = px * 2;
  c.width = c.height = s;
  c.style.width = c.style.height = `${px}px`;
  const g = c.getContext("2d");
  if (layer === "g") ground(g, 0, 0, s, kind, d);
  else {
    ground(g, 0, 0, s, "grass");
    item(g, 0, 0, s, kind, d);
  }
  return c;
}
