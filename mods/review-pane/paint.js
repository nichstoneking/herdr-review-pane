// Colors for the diff rows, in the app's theme (from herdr-gitview's
// diffview.js, github.com/ChmaraX/herdr-gitview, MIT): tint roles (`@ins`,
// …), and syntax colors lifted just enough to stay legible on a red or green row.

export function color(c, t) {
  switch (c) {
    case "red": return t.ansi1;
    case "green": return t.ansi2;
    case "@ins": return `${t.ansi2}26`;
    case "@del": return `${t.ansi1}26`;
    case "@ins_emph": return `${t.ansi2}5c`;
    case "@del_emph": return `${t.ansi1}5c`;
    case "@gutter": return t.dim;
    case "@fold": return t.raised;
    case "@fold_fg": return t.muted;
    default: return c;
  }
}

export function isDark(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  if (Number.isNaN(n)) return true;
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

const MIN_CONTRAST = 3.5;
const legible = new Map();

function rgba(hex) {
  const h = String(hex).replace("#", "");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return null;
  const n = (i) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

function over(top, under) {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
}

function luminance(c) {
  const f = (x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (c) => `#${c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}`;

// `fg` as drawn on the layers in `behind` (bottom first, over t.background).
export function readable(fg, behind, t) {
  const key = `${fg}|${behind.join(",")}|${t.background}|${t.foreground}`;
  if (legible.has(key)) return legible.get(key);
  let out = fg;
  const f = rgba(fg), base = rgba(t.background), ink = rgba(t.foreground);
  if (f && base && ink) {
    const bg = behind.map(rgba).filter(Boolean).reduce((under, top) => over(top, under), base);
    let c = f;
    for (let step = 1; step <= 20 && contrast(c, bg) < MIN_CONTRAST; step++) c = [0, 1, 2].map((i) => f[i] + (ink[i] - f[i]) * step / 20).concat(1);
    out = c === f ? fg : hex(c);
  }
  legible.set(key, out);
  return out;
}
