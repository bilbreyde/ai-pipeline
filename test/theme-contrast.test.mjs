import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Guards readability: every theme's text tokens must clear WCAG AA on the surfaces they sit on.
// This reads the real stylesheet, so editing a color in app.css that breaks contrast fails here.
const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/app.css"), "utf8");

function tokens(selectorStart, { skip = 0 } = {}) {
  // Pull "--name:value;" pairs out of the first block that starts with the selector.
  let i = -1;
  for (let n = 0; n <= skip; n++) i = css.indexOf(selectorStart, i + 1);
  assert.ok(i >= 0, `selector not found: ${selectorStart}`);
  const open = css.indexOf("{", i);
  const close = css.indexOf("}", open);
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) out[m[1]] = m[2];
  return out;
}
const lum = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const THEMES = {
  light: tokens(":root{"),
  dark: tokens(':root[data-theme="dark"]{'),
  warm: tokens(':root[data-theme="warm"]{'),
  contrast: tokens(':root[data-theme="contrast"]{'),
};
// (foreground token, background token, minimum ratio)
const PAIRS = [
  ["ink", "bg", 4.5], ["ink", "surface", 4.5], ["ink", "surface-2", 4.5],
  ["ink-2", "bg", 4.5], ["ink-2", "surface", 4.5], ["ink-2", "surface-2", 4.5],
  ["ink-3", "bg", 4.5], ["ink-3", "surface", 4.5], ["ink-3", "surface-2", 4.5],
  ["accent", "surface", 4.5], ["accent", "accent-soft", 4.5], ["accent-ink", "accent", 4.5],
  ["good", "good-soft", 4.5], ["warn", "warn-soft", 4.5], ["crit", "crit-soft", 4.5],
  ["focus", "surface", 3],
];

for (const [name, t] of Object.entries(THEMES)) {
  test(`${name} theme: text and control tokens meet WCAG contrast`, () => {
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(t[fg] && t[bg], `${name}: missing ${fg} or ${bg}`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(r >= min, `${name}: ${fg} ${t[fg]} on ${bg} ${t[bg]} is ${r.toFixed(2)}:1, needs ${min}:1`);
    }
  });
  test(`${name} theme: chart gray and both series colors are visible on the surface`, () => {
    // Series colors below 3:1 are allowed only where labels and the table view carry the values (see README).
    assert.ok(ratio(t.cg, t.surface) >= 3, `${name}: gray mark ${ratio(t.cg, t.surface).toFixed(2)}:1`);
    assert.ok(ratio(t.c1, t.surface) >= 3, `${name}: series 1 ${ratio(t.c1, t.surface).toFixed(2)}:1`);
    assert.ok(ratio(t.c2, t.surface) >= 2.5, `${name}: series 2 ${ratio(t.c2, t.surface).toFixed(2)}:1`);
    const ramp = [t.o1, t.o2, t.o3, t.o4].map((h) => lum(h));
    const mono = ramp.every((v, i) => i === 0 || (name === "dark" ? v > ramp[i - 1] : v < ramp[i - 1]));
    assert.ok(mono, `${name}: ordinal ramp must step monotonically`);
    assert.ok(ratio(name === "dark" ? t.o1 : t.o1, t.surface) >= 2, `${name}: ordinal ramp light end must clear 2:1`);
  });
}

test("the high contrast theme uses near black text on white", () => {
  const t = THEMES.contrast;
  assert.ok(ratio(t.ink, t.surface) >= 15);
  assert.ok(ratio(t["ink-3"], t.surface) >= 12);
});
