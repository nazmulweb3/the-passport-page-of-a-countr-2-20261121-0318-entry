// The Passport Page of a Country That Isn't There
// A program that draws one invented passport spread (1024x1024 PNG) to
// /output/entry.png. Pure Node, no dependencies: it carries its own PNG
// encoder, a small canvas rasteriser, and a vector-font renderer fed by
// glyph outlines (glyphs.json, extracted from DejaVu fonts) so the
// typography holds together like a real document.
//
// The country is the Republic of Thalverra, a North Atlantic island of
// herring fishers. Holder: Maren Elise Dahl of Kaldvik. The passport was
// issued 02 JUN 2026 and expires 02 JUN 2036; every stamp falls after
// the issue date, and the travel history agrees with the place of issue.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so two runs are byte-identical.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------------------
// Canvas: 24-bit RGB, alpha-blended drawing, even-odd polygon fill.
// ---------------------------------------------------------------------------
const W = 1024;
const H = 1024;
const px = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function setPixel(x: number, y: number, c: RGB, a = 1): void {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const o = (iy * W + ix) * 3;
  if (a >= 1) {
    px[o] = c[0];
    px[o + 1] = c[1];
    px[o + 2] = c[2];
  } else {
    px[o] = clamp255(px[o] * (1 - a) + c[0] * a);
    px[o + 1] = clamp255(px[o + 1] * (1 - a) + c[1] * a);
    px[o + 2] = clamp255(px[o + 2] * (1 - a) + c[2] * a);
  }
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB, a = 1): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) setPixel(xx, yy, c, a);
  }
}

function drawLine(x0: number, y0: number, x1: number, y1: number, c: RGB, th = 1, a = 1): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  const r = th / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x0 + dx * t;
    const cy = y0 + dy * t;
    for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
      for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        if (ox * ox + oy * oy <= r * r + 0.5) setPixel(cx + ox, cy + oy, c, a);
      }
    }
  }
}

function drawCircle(cx: number, cy: number, r: number, c: RGB, th = 1, a = 1): void {
  const steps = Math.max(48, Math.floor(r * 6));
  let px0 = cx + r;
  let py0 = cy;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const x = cx + Math.cos(t) * r;
    const y = cy + Math.sin(t) * r;
    drawLine(px0, py0, x, y, c, th, a);
    px0 = x;
    py0 = y;
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    const dy = y - cy;
    const half = Math.sqrt(Math.max(0, r * r - dy * dy));
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      setPixel(x, y, c, a);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB, a = 1): void {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    const dy = (y - cy) / ry;
    const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    for (let x = Math.floor(cx - half); x <= Math.ceil(cx + half); x++) {
      setPixel(x, y, c, a);
    }
  }
}

type Pt = [number, number];

// Even-odd scanline fill over several contours at once (holes stay empty).
function fillPolygons(contours: Pt[][], c: RGB, a = 1): void {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of contours) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return;
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  const x0 = Math.max(0, Math.floor(minX));
  const x1 = Math.min(W - 1, Math.ceil(maxX));
  for (let y = y0; y <= y1; y++) {
    const sy = y + 0.5;
    const xs: number[] = [];
    for (const poly of contours) {
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = Math.max(x0, Math.ceil(xs[i] - 0.5));
      const xb = Math.min(x1, Math.floor(xs[i + 1] - 0.5));
      for (let x = xa; x <= xb; x++) setPixel(x, y, c, a);
    }
  }
}

function fillPoly(poly: Pt[], c: RGB, a = 1): void {
  fillPolygons([poly], c, a);
}

// 2x-supersampled even-odd fill for one glyph's contours. Small text
// (8-10 px) loses hairline strokes to plain scanline sampling; rendering
// each glyph at 2x and box-downsampling keeps every stem visible.
function fillGlyphAA(contours: Pt[][], c: RGB, a = 1): void {
  const SS = 2;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const poly of contours) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!isFinite(minX)) return;
  const ox = Math.floor(minX * SS);
  const oy = Math.floor(minY * SS);
  const w2 = Math.ceil(maxX * SS) - ox + 1;
  const h2 = Math.ceil(maxY * SS) - oy + 1;
  const mask = new Uint8Array(w2 * h2);
  for (let j = 0; j < h2; j++) {
    const sy = (oy + j + 0.5) / SS;
    const xs: number[] = [];
    for (const poly of contours) {
      for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
    }
    xs.sort((m, n) => m - n);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const ka = Math.max(0, Math.ceil(xs[i] * SS - ox - 0.5));
      const kb = Math.min(w2 - 1, Math.floor(xs[i + 1] * SS - ox - 0.5));
      for (let k = ka; k <= kb; k++) mask[j * w2 + k] = 1;
    }
  }
  const bx0 = Math.floor(minX);
  const by0 = Math.floor(minY);
  const bw = Math.ceil(maxX) - bx0 + 1;
  const bh = Math.ceil(maxY) - by0 + 1;
  const cov = new Float32Array(bw * bh);
  for (let j = 0; j < h2; j++) {
    for (let k = 0; k < w2; k++) {
      if (!mask[j * w2 + k]) continue;
      const dx = Math.floor((ox + k) / SS) - bx0;
      const dy = Math.floor((oy + j) / SS) - by0;
      if (dx >= 0 && dx < bw && dy >= 0 && dy < bh) cov[dy * bw + dx]++;
    }
  }
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const cv = cov[y * bw + x];
      if (cv > 0) setPixel(bx0 + x, by0 + y, c, (cv / 4) * a);
    }
  }
}

// ---------------------------------------------------------------------------
// Vector fonts (glyph outlines in font units, y up).
// ---------------------------------------------------------------------------
interface Glyph {
  adv: number;
  paths: number[][][];
}
interface FontData {
  upm: number;
  glyphs: Record<string, Glyph>;
}
const glyphData = JSON.parse(
  readFileSync(new URL("./glyphs.json", import.meta.url), "utf-8"),
) as { fonts: Record<string, FontData> };

function textWidth(fontName: string, size: number, text: string, ls = 0): number {
  const font = glyphData.fonts[fontName];
  const s = size / font.upm;
  let w = 0;
  for (const ch of text) {
    const g = font.glyphs[ch];
    w += (g ? g.adv : font.upm * 0.5) * s + ls;
  }
  return w - ls;
}

// Draw text; (x, y) is the baseline start. Optional rotation in degrees
// around (x, y). Returns the advance width.
function drawText(
  fontName: string,
  size: number,
  x: number,
  y: number,
  text: string,
  c: RGB,
  ls = 0,
  rotDeg = 0,
  a = 1,
): number {
  const font = glyphData.fonts[fontName];
  const s = size / font.upm;
  const rot = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  let cx = x;
  for (const ch of text) {
    const g = font.glyphs[ch];
    if (g) {
      const contours: Pt[][] = g.paths.map((path) =>
        path.map(([gx, gy]) => {
          const lx = gx * s;
          const ly = -gy * s;
          return [
            cx + lx * cos - ly * sin,
            y + lx * sin + ly * cos,
          ] as Pt;
        }),
      );
      fillGlyphAA(contours, c, a);
      cx += g.adv * s + ls;
    } else {
      cx += font.upm * 0.5 * s + ls;
    }
  }
  return cx - x - ls;
}

function drawTextCentered(
  fontName: string,
  size: number,
  cx: number,
  y: number,
  text: string,
  c: RGB,
  ls = 0,
  a = 1,
): void {
  const w = textWidth(fontName, size, text, ls);
  drawText(fontName, size, cx - w / 2, y, text, c, ls, 0, a);
}

// Text along a circular arc (for round stamps).
function drawCircularText(
  fontName: string,
  size: number,
  text: string,
  cx: number,
  cy: number,
  radius: number,
  midDeg: number,
  c: RGB,
  flip = false,
): void {
  const total = textWidth(fontName, size, text, 1);
  const spanDeg = (total / radius) * (180 / Math.PI);
  // Top arc reads left to right as the angle grows; the bottom arc must
  // run the other way, or its letters come out reversed and upside down.
  let angle = flip ? midDeg + spanDeg / 2 : midDeg - spanDeg / 2;
  for (const ch of text) {
    const g = glyphData.fonts[fontName].glyphs[ch];
    const adv = g ? g.adv : glyphData.fonts[fontName].upm * 0.5;
    const w = (adv * size) / glyphData.fonts[fontName].upm + 1;
    const charDeg = (w / radius) * (180 / Math.PI);
    const aDeg = flip ? angle - charDeg / 2 : angle + charDeg / 2;
    const rad = (aDeg * Math.PI) / 180;
    const px0 = cx + Math.cos(rad) * radius;
    const py0 = cy + Math.sin(rad) * radius;
    // Tangent direction: the glyph's top points at the circle's centre.
    const rot = aDeg - 90;
    drawText(fontName, size, px0, py0, ch, c, 0, rot);
    angle += flip ? -charDeg : charDeg;
  }
}

function wrapText(fontName: string, size: number, text: string, maxW: number, ls = 0): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    const trial = cur ? cur + " " + word : word;
    if (textWidth(fontName, size, trial, ls) <= maxW || !cur) {
      cur = trial;
    } else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const PAPER: RGB = [245, 240, 227];
const PAPER_DARK: RGB = [232, 225, 205];
const INK: RGB = [29, 43, 69];
const INK_SOFT: RGB = [74, 82, 96];
const LABEL: RGB = [110, 104, 88];
const TEAL: RGB = [31, 111, 107];
const GOLD: RGB = [176, 141, 74];
const STAMP_BLUE: RGB = [43, 76, 155];
const STAMP_RED: RGB = [163, 51, 39];
const STAMP_PURPLE: RGB = [107, 63, 125];
const STAMP_GREEN: RGB = [46, 107, 52];
const SKIN: RGB = [232, 185, 143];
const SKIN_DARK: RGB = [214, 163, 118];
const HAIR: RGB = [122, 96, 58];
const NAVY_JACKET: RGB = [38, 54, 84];

// ---------------------------------------------------------------------------
// Background: table, open spread, paper, spine.
// ---------------------------------------------------------------------------
function drawBackground(): void {
  fillRect(0, 0, W, H, [42, 52, 66]);
  // faint table grain
  for (let i = 0; i < 9000; i++) {
    setPixel(rand() * W, rand() * H, [58, 68, 84], 0.5);
  }
  // spread
  fillRect(16, 16, 992, 992, PAPER);
  // paper edge shading
  for (let i = 0; i < 992; i++) {
    setPixel(16 + i, 16, [255, 252, 240], 0.6);
    setPixel(16, 16 + i, [255, 252, 240], 0.6);
  }
  // spine shadow and centre crease
  for (let x = 500; x <= 524; x++) {
    const d = Math.abs(x - 512);
    const a = 0.28 - d * 0.02;
    if (a > 0) fillRect(x, 16, 1, 992, [120, 110, 88], a);
  }
  drawLine(512, 16, 512, 1008, [150, 140, 115], 1, 0.5);
  // sparse paper noise (kept light so the PNG stays under 1 MiB)
  for (let i = 0; i < 26000; i++) {
    const x = 16 + rand() * 992;
    const y = 16 + rand() * 992;
    const v = rand() > 0.5 ? [255, 252, 240] : [210, 200, 175];
    setPixel(x, y, v as RGB, 0.25);
  }
}

// ---------------------------------------------------------------------------
// Coat of arms: shield, mountain, sun, waves, stars.
// ---------------------------------------------------------------------------
function drawArms(cx: number, cy: number, s: number): void {
  // sun
  fillCircle(cx, cy - 6 * s, 9 * s, GOLD);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    drawLine(
      cx + Math.cos(a) * 12 * s,
      cy - 6 * s + Math.sin(a) * 12 * s,
      cx + Math.cos(a) * 17 * s,
      cy - 6 * s + Math.sin(a) * 17 * s,
      GOLD,
      2,
    );
  }
  // shield outline
  const shield: Pt[] = [
    [cx - 20 * s, cy - 26 * s],
    [cx + 20 * s, cy - 26 * s],
    [cx + 20 * s, cy + 2 * s],
    [cx, cy + 24 * s],
    [cx - 20 * s, cy + 2 * s],
  ];
  fillPoly(shield, [250, 246, 232]);
  // shield border (draw as outline via short lines)
  for (let i = 0; i < shield.length; i++) {
    const [ax, ay] = shield[i];
    const [bx, by] = shield[(i + 1) % shield.length];
    drawLine(ax, ay, bx, by, INK, 2);
  }
  // mountain inside shield
  fillPoly(
    [
      [cx - 16 * s, cy + 8 * s],
      [cx - 4 * s, cy - 14 * s],
      [cx + 6 * s, cy + 0 * s],
      [cx + 12 * s, cy - 8 * s],
      [cx + 16 * s, cy + 8 * s],
    ],
    TEAL,
  );
  // snow cap
  fillPoly(
    [
      [cx - 4 * s, cy - 14 * s],
      [cx - 1 * s, cy - 8 * s],
      [cx - 4 * s, cy - 6 * s],
      [cx - 7 * s, cy - 9 * s],
    ],
    [250, 246, 232],
  );
  // waves
  for (let i = 0; i < 2; i++) {
    const wy = cy + (12 + i * 5) * s;
    for (let x = -14; x <= 14; x += 2) {
      const yy = wy + Math.sin((x / 14) * Math.PI * (2 + i)) * 1.6 * s;
      setPixel(cx + x * s, yy, TEAL, 0.9);
    }
  }
  // flanking stars
  for (const sx of [cx - 30 * s, cx + 30 * s]) {
    fillCircle(sx, cy - 2 * s, 2.2 * s, GOLD);
  }
}

// ---------------------------------------------------------------------------
// Stylised portrait of the holder (flat vector illustration).
// ---------------------------------------------------------------------------
function drawPortrait(x: number, y: number, w: number, h: number): void {
  // backdrop: pale sea-grey with faint diagonal light
  fillRect(x, y, w, h, [168, 182, 190]);
  for (let i = 0; i < 24; i++) {
    drawLine(x + i * 8, y, x + i * 8 + 40, y + h, [186, 198, 204], 1, 0.35);
  }
  const cx = x + w / 2;
  const headY = y + h * 0.42;
  const headRx = w * 0.27;
  const headRy = h * 0.27;
  // shoulders / navy jacket
  fillPoly(
    [
      [x + w * 0.08, y + h],
      [x + w * 0.2, y + h * 0.74],
      [cx - w * 0.1, y + h * 0.66],
      [cx + w * 0.1, y + h * 0.66],
      [x + w * 0.8, y + h * 0.74],
      [x + w * 0.92, y + h],
    ],
    NAVY_JACKET,
  );
  // shirt V
  fillPoly(
    [
      [cx - w * 0.09, y + h * 0.68],
      [cx + w * 0.09, y + h * 0.68],
      [cx, y + h * 0.86],
    ],
    [240, 238, 230],
  );
  // neck
  fillRect(cx - w * 0.07, headY + headRy * 0.55, w * 0.14, h * 0.14, SKIN_DARK);
  // face
  fillEllipse(cx, headY, headRx, headRy, SKIN);
  // jaw shading
  fillEllipse(cx, headY + headRy * 0.55, headRx * 0.62, headRy * 0.3, SKIN_DARK, 0.35);
  // hair: dark blonde, parted, framing the face
  fillPoly(
    [
      [cx - headRx * 1.02, headY - headRy * 0.25],
      [cx - headRx * 0.95, headY - headRy * 1.05],
      [cx - headRx * 0.3, headY - headRy * 1.12],
      [cx + headRx * 0.45, headY - headRy * 1.08],
      [cx + headRx * 0.98, headY - headRy * 0.7],
      [cx + headRx * 1.0, headY - headRy * 0.1],
      [cx + headRx * 0.82, headY - headRy * 0.28],
      [cx + headRx * 0.78, headY - headRy * 0.75],
      [cx + headRx * 0.3, headY - headRy * 0.92],
      [cx - headRx * 0.35, headY - headRy * 0.9],
      [cx - headRx * 0.72, headY - headRy * 0.72],
      [cx - headRx * 0.8, headY - headRy * 0.3],
    ],
    HAIR,
  );
  // hair falling past the shoulders
  fillPoly(
    [
      [cx - headRx * 1.02, headY - headRy * 0.2],
      [cx - headRx * 0.95, headY + headRy * 0.9],
      [cx - headRx * 0.6, headY + headRy * 0.95],
      [cx - headRx * 0.72, headY - headRy * 0.1],
    ],
    HAIR,
  );
  fillPoly(
    [
      [cx + headRx * 1.0, headY - headRy * 0.1],
      [cx + headRx * 0.95, headY + headRy * 0.85],
      [cx + headRx * 0.6, headY + headRy * 0.9],
      [cx + headRx * 0.72, headY - headRy * 0.05],
    ],
    HAIR,
  );
  // brows, eyes, nose, mouth
  const eyeY = headY - headRy * 0.08;
  for (const sgn of [-1, 1]) {
    const ex = cx + sgn * headRx * 0.38;
    drawLine(ex - headRx * 0.2, eyeY - headRy * 0.22, ex + headRx * 0.2, eyeY - headRy * 0.26, HAIR, 2);
    fillEllipse(ex, eyeY, headRx * 0.09, headRy * 0.06, [52, 44, 36]);
    fillEllipse(ex + headRx * 0.03, eyeY - headRy * 0.02, headRx * 0.03, headRy * 0.02, [245, 245, 240]);
  }
  drawLine(cx, eyeY + headRy * 0.1, cx - headRx * 0.05, eyeY + headRy * 0.42, SKIN_DARK, 1.5);
  drawLine(cx - headRx * 0.22, headY + headRy * 0.62, cx + headRx * 0.22, headY + headRy * 0.62, [150, 84, 70], 2);
  // soft cheek colour
  fillEllipse(cx - headRx * 0.55, headY + headRy * 0.32, headRx * 0.16, headRy * 0.1, [226, 150, 120], 0.35);
  fillEllipse(cx + headRx * 0.55, headY + headRy * 0.32, headRx * 0.16, headRy * 0.1, [226, 150, 120], 0.35);
  // faint THV watermark across the photo
  drawText("sansBold", 26, x + w * 0.28, y + h * 0.62, "THV", [255, 255, 255], 2, -18, 0.28);
}

// ---------------------------------------------------------------------------
// MRZ check digits (ICAO 9303, weights 7-3-1).
// ---------------------------------------------------------------------------
function mrzValue(ch: string): number {
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55;
  return 0; // '<'
}
function mrzCheck(s: string): string {
  const w = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) sum += mrzValue(s[i]) * w[i % 3];
  return String(sum % 10);
}
function buildMrz(): [string, string] {
  const line1 = ("P<THVDAHL<<MAREN<ELISE" + "<".repeat(44)).slice(0, 44);
  const num = "THV482913";
  const dob = "940314";
  const exp = "360602";
  const personal = "<".repeat(14);
  const composite = num + mrzCheck(num) + "THV" + dob + mrzCheck(dob) + "F" + exp + mrzCheck(exp) + personal;
  const line2 = num + mrzCheck(num) + "THV" + dob + mrzCheck(dob) + "F" + exp + mrzCheck(exp) + personal + mrzCheck(personal) + mrzCheck(composite);
  return [line1, line2];
}

// ---------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------
function rectStamp(
  x: number, y: number, w: number, h: number, rot: number,
  color: RGB, top: string, mid: string, bottom: string,
): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (rot * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotPt = (px0: number, py0: number): Pt => {
    const dx = px0 - cx;
    const dy = py0 - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const corners: Pt[] = [rotPt(x, y), rotPt(x + w, y), rotPt(x + w, y + h), rotPt(x, y + h)];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    drawLine(ax, ay, bx, by, color, 2, 0.85);
  }
  const inset = 6;
  const ic: Pt[] = [rotPt(x + inset, y + inset), rotPt(x + w - inset, y + inset), rotPt(x + w - inset, y + h - inset), rotPt(x + inset, y + h - inset)];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = ic[i];
    const [bx, by] = ic[(i + 1) % 4];
    drawLine(ax, ay, bx, by, color, 1, 0.7);
  }
  // Text is drawn rotated about the stamp centre. drawText rotates about
  // its own start point, so pre-rotate the anchor points.
  const anchor = (lx: number, ly: number): Pt => {
    const dx = lx - cx;
    const dy = ly - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const wTop = textWidth("sansBold", 12, top, 1);
  const [tx, ty] = anchor(cx - wTop / 2, y + h * 0.3);
  drawText("sansBold", 12, tx, ty, top, color, 1, rot, 0.85);
  const wMid = textWidth("sansBold", 15, mid, 1);
  const [mx, my] = anchor(cx - wMid / 2, y + h * 0.6);
  drawText("sansBold", 15, mx, my, mid, color, 1, rot, 0.9);
  const wBot = textWidth("sans", 9, bottom, 1);
  const [bx, by] = anchor(cx - wBot / 2, y + h * 0.88);
  drawText("sans", 9, bx, by, bottom, color, 1, rot, 0.85);
}

function circleStamp(
  cx: number, cy: number, r: number, color: RGB,
  ringText: string, centreTop: string, centreDate: string,
): void {
  drawCircle(cx, cy, r, color, 2, 0.85);
  drawCircle(cx, cy, r - 7, color, 1, 0.7);
  drawCircularText("sansBold", 11, ringText, cx, cy, r - 13, -90, color);
  drawCircularText("sansBold", 9, "HERRING PORT AUTHORITY", cx, cy, r - 13, 90, color, true);
  drawTextCentered("sansBold", 13, cx, cy - 4, centreTop, color, 1, 0.9);
  drawTextCentered("sansBold", 12, cx, cy + 16, centreDate, color, 1, 0.9);
  fillCircle(cx, cy - 26, 2.5, color, 0.85);
}

// ---------------------------------------------------------------------------
// Left page: the data page.
// ---------------------------------------------------------------------------
function drawDataPage(): void {
  const L = 28;
  const R = 500;
  // faint guilloche rosette behind the header
  for (let i = 0; i < 3; i++) {
    drawCircle(264, 82, 46 + i * 7, TEAL, 1, 0.1);
  }
  drawArms(264, 82, 1);
  drawTextCentered("serifBold", 25, 264, 138, "REPUBLIC OF THALVERRA", INK, 1);
  drawTextCentered("sans", 11, 264, 158, "VEGABRÉF  •  PASSPORT", INK_SOFT, 3);
  drawLine(L + 12, 172, R - 12, 172, INK, 1.5);
  drawLine(L + 12, 176, R - 12, 176, INK, 0.75);

  // photo
  const px0 = 48;
  const py0 = 196;
  const pw = 152;
  const ph = 184;
  fillRect(px0 - 3, py0 - 3, pw + 6, ph + 6, INK);
  drawPortrait(px0, py0, pw, ph);
  drawTextCentered("sans", 10, px0 + pw / 2, py0 + ph + 16, "PHOTOGRAPH OF HOLDER", LABEL, 1);

  // data fields
  const fx = 224;
  let y = 214;
  const row = (label: string, value: string, valueSize = 14) => {
    drawText("sans", 9, fx, y, label, LABEL, 1);
    drawText("sansBold", valueSize, fx, y + 17, value, INK, 0.5);
    y += 34;
  };
  const row2 = (
    l1: string, v1: string, l2: string, v2: string, x2 = 372,
  ) => {
    drawText("sans", 9, fx, y, l1, LABEL, 1);
    drawText("sansBold", 14, fx, y + 17, v1, INK, 0.5);
    drawText("sans", 9, x2, y, l2, LABEL, 1);
    drawText("sansBold", 14, x2, y + 17, v2, INK, 0.5);
    y += 34;
  };
  row2("TYPE", "P", "CODE", "THV", 300);
  row("PASSPORT No.", "THV 482 913");
  row("SURNAME", "DAHL");
  row("GIVEN NAMES", "MAREN ELISE");
  row("NATIONALITY", "THALVERRAN");
  row2("DATE OF BIRTH", "14 MAR 1994", "SEX", "F", 400);
  row("PLACE OF BIRTH", "KALVIK, THALVERRA");
  row2("DATE OF ISSUE", "02 JUN 2026", "DATE OF EXPIRY", "02 JUN 2036", 372);
  row("AUTHORITY", "MINISTRY OF THE INTERIOR", 12);

  // holder's signature
  const sy = 528;
  drawText("sans", 9, fx, sy, "HOLDER'S SIGNATURE", LABEL, 1);
  drawLine(fx, sy + 26, fx + 180, sy + 26, INK_SOFT, 1);
  // a flowing signature squiggle
  let sx = fx + 8;
  let syy = sy + 20;
  const sig: Pt[] = [[sx, syy]];
  for (let i = 0; i < 26; i++) {
    sx += 6.5;
    syy = sy + 20 + Math.sin(i * 1.1) * 5 - (i < 6 ? i * 0.8 : 0);
    sig.push([sx, syy]);
  }
  for (let i = 0; i + 1 < sig.length; i++) {
    drawLine(sig[i][0], sig[i][1], sig[i + 1][0], sig[i + 1][1], INK, 1.5, 0.9);
  }
  drawLine(fx + 150, sy + 8, fx + 196, sy + 24, INK, 1.5, 0.9);

  // observations box: the telling detail on the data page
  const oy = 566;
  drawLine(L + 12, oy, R - 12, oy, INK, 1);
  drawText("sansBold", 10, L + 12, oy + 18, "OBSERVATIONS", INK, 1);
  const obs = wrapText(
    "sans", 11,
    "Holder is a registered seafarer of the Kaldvik herring fleet. " +
      "See Condition 7 overleaf: landing is for the herring season only.",
    R - L - 40, 0.5,
  );
  let oyy = oy + 38;
  for (const line of obs) {
    drawText("sans", 11, L + 12, oyy, line, INK_SOFT, 0.5);
    oyy += 16;
  }
  drawLine(L + 12, oyy + 6, R - 12, oyy + 6, INK, 1);

  // MRZ
  const [mrz1, mrz2] = buildMrz();
  const mz = 872;
  fillRect(L + 12, mz - 26, R - L - 24, 74, [238, 233, 218]);
  drawLine(L + 12, mz - 26, R - L - 24 + L, mz - 26, INK, 1);
  const mrzSize = 15;
  const ls = (R - L - 48 - textWidth("sansBold", mrzSize, mrz1, 0)) / 43;
  drawText("sansBold", mrzSize, L + 24, mz, mrz1, INK, ls);
  drawText("sansBold", mrzSize, L + 24, mz + 24, mrz2, INK, ls);

  drawTextCentered(
    "sans", 10, 264, 972,
    "THIS PASSPORT IS THE PROPERTY OF THE REPUBLIC OF THALVERRA",
    LABEL, 1,
  );
  drawText("sans", 10, L + 12, 986, "12", LABEL, 1);
}

// ---------------------------------------------------------------------------
// Right page: visas, stamps, conditions, island map.
// ---------------------------------------------------------------------------
function drawIslandMap(x: number, y: number, w: number, h: number): void {
  drawLine(x, y, x + w, y, INK, 1);
  drawText("sansBold", 10, x, y + 14, "THALVERRA", INK, 1);
  drawText("sans", 9, x, y + 26, "NORTH ATLANTIC  •  64°N  18°W", LABEL, 0.5);
  // island outline
  const isl: Pt[] = [
    [x + 18, y + 78], [x + 34, y + 52], [x + 62, y + 40], [x + 92, y + 46],
    [x + 112, y + 62], [x + 106, y + 84], [x + 84, y + 100], [x + 52, y + 104],
    [x + 30, y + 94],
  ];
  fillPoly(isl, [214, 226, 214]);
  for (let i = 0; i < isl.length; i++) {
    const [ax, ay] = isl[i];
    const [bx, by] = isl[(i + 1) % isl.length];
    drawLine(ax, ay, bx, by, TEAL, 1.5);
  }
  // mountain mark + capital dot
  fillPoly(
    [[x + 58, y + 62], [x + 66, y + 76], [x + 50, y + 76]],
    TEAL,
  );
  fillCircle(x + 88, y + 82, 3, STAMP_RED);
  drawText("sansBold", 8, x + 94, y + 85, "KALVIK", INK, 0.5);
  drawText("sans", 9, x, y + 116, "Mt. Sævar  •  Herring grounds", LABEL, 0.5);
}

function drawVisaPage(): void {
  const L = 524;
  const R = 996;
  drawTextCentered("serifBold", 24, 760, 62, "VISAS", INK, 4);
  drawTextCentered("sans", 10, 760, 82, "VISAS  •  STAMPS OF ENTRY AND DEPARTURE", INK_SOFT, 2);
  drawLine(L + 12, 96, R - 12, 96, INK, 1.5);

  drawIslandMap(800, 116, 184, 130);

  // OSTERLAND visa, issued before the first trip
  rectStamp(540, 122, 236, 108, -3, STAMP_GREEN, "OSTERLAND", "VISA 0417", "ISSUED 05 SEP 2026  •  90 DAYS");
  // NORDMARK arrival + departure
  rectStamp(556, 258, 210, 104, -6, STAMP_BLUE, "NORDMARK", "ARRIVAL", "18 SEP 2026  •  PORT OF VESTA");
  rectStamp(782, 262, 210, 104, 4, STAMP_BLUE, "NORDMARK", "DEPARTURE", "24 SEP 2026  •  PORT OF VESTA");
  // KARVOST circular stamps
  circleStamp(648, 470, 76, STAMP_PURPLE, "KARVOST • BORDER CONTROL •", "ARRIVAL", "11 OCT 2026");
  circleStamp(872, 478, 72, STAMP_RED, "KARVOST • HARBOUR OFFICE •", "DEPARTURE", "02 NOV 2026");
  // fee stamp
  rectStamp(788, 588, 190, 64, -5, STAMP_RED, "FEE PAID", "40 KR", "HARBOUR OFFICE, KALVIK");

  // Conditions panel: the paperwork detail that reveals the place
  const py = 668;
  fillRect(L + 12, py, R - L - 24, 268, [250, 246, 232]);
  drawLine(L + 12, py, R - 12, py, INK, 2);
  drawLine(L + 12, py + 268, R - 12, py + 268, INK, 2);
  drawLine(L + 12, py, L + 12, py + 268, INK, 1);
  drawLine(R - 12, py, R - 12, py + 268, INK, 1);
  drawText("sansBold", 12, L + 28, py + 26, "CONDITIONS OF ENTRY — CONDITION 7", INK, 1);
  drawLine(L + 28, py + 36, R - 28, py + 36, INK, 1);
  const cond = wrapText(
    "sans", 12,
    "The holder may land for ninety (90) days for the herring season only. " +
      "Work ashore is forbidden without a harbour-master's permit, and no " +
      "catch may be sold except through the Kaldvik fish market. " +
      "A breach ends the stay at once.",
    R - L - 56, 0.5,
  );
  let cy = py + 62;
  for (const line of cond) {
    drawText("sans", 12, L + 28, cy, line, INK_SOFT, 0.5);
    cy += 19;
  }
  drawText("sansBold", 11, L + 28, cy + 22, "HARBOUR OFFICE, KALVIK", INK, 0.5);
  drawText("sans", 11, L + 28, cy + 42, "Signed 02 JUN 2026  •  Permit No. HK-2291", INK_SOFT, 0.5);
  drawText("sans", 9, L + 28, cy + 66, "THV 482 913  •  DAHL, MAREN ELISE", LABEL, 1);

  drawText("sans", 10, R - 24, 986, "13", LABEL, 1);
}

// ---------------------------------------------------------------------------
// PNG encoding (filter 0, zlib deflate).
// ---------------------------------------------------------------------------
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function encodePng(): Buffer {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0;
    raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main(): void {
  drawBackground();
  drawDataPage();
  drawVisaPage();
  const png = encodePng();
  mkdirSync("/output", { recursive: true });
  writeFileSync("/output/entry.png", png);
  // eslint-disable-next-line no-console
  console.log(`wrote /output/entry.png ${png.length} bytes`);
}

main();
