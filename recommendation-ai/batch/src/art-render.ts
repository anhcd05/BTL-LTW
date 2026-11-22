// Procedural cover art and avatars for the synthetic demo catalogue (DEMO ONLY, no downloads).
// Pure pixel generation (deterministic per id) + WebP encoding with the local ffmpeg/libwebp.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Bumping this changes every generated key (and therefore the images). */
export const ART_STYLE_VERSION = 'reco-art-v1';
/** Inside the API's normalised limits: covers ≤ 1200 px ("inside"), avatars ≤ 512 px ("cover", square). */
export const COVER_SIZE = 640;
export const AVATAR_SIZE = 512;
/** Same encoder settings as apps/api/src/image-decoder.ts (webp quality 82). */
export const WEBP_QUALITY = 82;

export type RGB = [number, number, number];

/** Hue (deg), saturation, lightness per demo genre (world.ts GENRES ids). */
export const GENRE_HSL: Record<string, [number, number, number]> = {
  pop: [330, 0.75, 0.6],
  'v-pop': [350, 0.7, 0.58],
  ballad: [265, 0.55, 0.55],
  bolero: [18, 0.7, 0.52],
  'r-and-b': [290, 0.5, 0.45],
  'hip-hop': [44, 0.85, 0.52],
  rap: [2, 0.7, 0.48],
  rock: [210, 0.25, 0.38],
  indie: [165, 0.5, 0.45],
  edm: [190, 0.9, 0.5],
  'lo-fi': [28, 0.35, 0.6],
  acoustic: [95, 0.4, 0.5],
  jazz: [222, 0.55, 0.35],
  folk: [62, 0.45, 0.45],
  'k-pop': [312, 0.8, 0.62],
};
const DEFAULT_HSL: [number, number, number] = [200, 0.4, 0.5];

/** Deterministic stream of [0,1) numbers from an id (sha256 counter mode). */
export function idRandom(id: string, salt = ''): () => number {
  let counter = 0;
  let pool: Buffer = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset + 4 > pool.length) {
      pool = createHash('sha256').update(`${ART_STYLE_VERSION}:${salt}:${id}:${counter++}`).digest();
      offset = 0;
    }
    const value = pool.readUInt32BE(offset) / 0x1_0000_0000;
    offset += 4;
    return value;
  };
}

/** UUID-shaped, deterministic object-key component (so re-runs overwrite instead of leaking objects). */
export function deterministicUuid(id: string, salt: string): string {
  const h = createHash('sha256').update(`${ART_STYLE_VERSION}:${salt}:${id}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Same key layout as the API: cover/<trackId>/<uuid>.webp and avatar/<userId>/<uuid>.webp (bucket artwork). */
export const coverKey = (trackId: string) => `cover/${trackId}/${deterministicUuid(trackId, 'cover')}.webp`;
export const avatarKey = (userId: string) => `avatar/${userId}/${deterministicUuid(userId, 'avatar')}.webp`;

export function hsl(h: number, s: number, l: number): RGB {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: RGB, k: number): RGB => (k >= 0 ? mix(c, [1, 1, 1], k) : mix(c, [0, 0, 0], -k));

/** Float RGB canvas with anti-aliased signed-distance shapes. */
export class Canvas {
  readonly data: Float32Array;
  constructor(readonly size: number) {
    this.data = new Float32Array(size * size * 3);
  }
  paint(fn: (x: number, y: number) => RGB): void {
    const n = this.size;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const c = fn(x + 0.5, y + 0.5);
        const i = (y * n + x) * 3;
        this.data[i] = c[0];
        this.data[i + 1] = c[1];
        this.data[i + 2] = c[2];
      }
  }
  /** sdf < 0 inside (pixels). color may depend on the position. */
  shape(
    box: [number, number, number, number],
    sdf: (x: number, y: number) => number,
    color: RGB | ((x: number, y: number) => RGB),
    opacity = 1,
  ): void {
    const n = this.size;
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(n, Math.ceil(box[2])), y1 = Math.min(n, Math.ceil(box[3]));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const a = clamp01(0.5 - sdf(px, py)) * opacity;
        if (a <= 0) continue;
        const c = typeof color === 'function' ? color(px, py) : color;
        const i = (y * n + x) * 3;
        this.data[i] = this.data[i]! + (c[0] - this.data[i]!) * a;
        this.data[i + 1] = this.data[i + 1]! + (c[1] - this.data[i + 1]!) * a;
        this.data[i + 2] = this.data[i + 2]! + (c[2] - this.data[i + 2]!) * a;
      }
  }
  circle(cx: number, cy: number, r: number, color: RGB | ((x: number, y: number) => RGB), opacity = 1): void {
    this.shape([cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1], (x, y) => Math.hypot(x - cx, y - cy) - r, color, opacity);
  }
  ring(cx: number, cy: number, r: number, width: number, color: RGB, opacity = 1): void {
    this.shape([cx - r - width, cy - r - width, cx + r + width, cy + r + width], (x, y) => Math.abs(Math.hypot(x - cx, y - cy) - r) - width / 2, color, opacity);
  }
  roundRect(x0: number, y0: number, x1: number, y1: number, radius: number, color: RGB | ((x: number, y: number) => RGB), opacity = 1): void {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - radius, hy = (y1 - y0) / 2 - radius;
    this.shape([x0 - 1, y0 - 1, x1 + 1, y1 + 1], (x, y) => {
      const dx = Math.abs(x - cx) - hx, dy = Math.abs(y - cy) - hy;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
    }, color, opacity);
  }
  /** Grain + vignette, then 8-bit RGB. */
  toRgb24(rand: () => number, grain = 0.025, vignette = 0.28): Buffer {
    const n = this.size;
    const out = Buffer.alloc(n * n * 3);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot((x - n / 2) / n, (y - n / 2) / n) * 1.41;
        const v = 1 - vignette * d * d;
        const g = (rand() - 0.5) * grain;
        const i = (y * n + x) * 3;
        for (let k = 0; k < 3; k++) out[i + k] = Math.round(clamp01(this.data[i + k]! * v + g) * 255);
      }
    return out;
  }
}

function palette(genres: readonly string[], rand: () => number) {
  const [h, s, l] = GENRE_HSL[genres[0] ?? ''] ?? DEFAULT_HSL;
  const second = genres[1] ? GENRE_HSL[genres[1]] : undefined;
  const h2 = second ? second[0] : h + 35 + rand() * 50;
  const base = hsl(h + (rand() - 0.5) * 16, s, l);
  return {
    base,
    deep: hsl(h + (rand() - 0.5) * 20, Math.min(1, s + 0.1), Math.max(0.12, l - 0.3)),
    partner: hsl(h2, second ? second[1] : s * 0.9, Math.min(0.75, (second ? second[2] : l) + 0.08)),
    light: hsl(h + 180 + (rand() - 0.5) * 40, 0.55, 0.85),
  };
}

function gradientBackground(canvas: Canvas, from: RGB, to: RGB, angle: number): void {
  const n = canvas.size, ca = Math.cos(angle), sa = Math.sin(angle);
  canvas.paint((x, y) => {
    const t = clamp01(0.5 + (((x - n / 2) * ca + (y - n / 2) * sa) / n) * 1.1);
    return mix(from, to, t * t * (3 - 2 * t));
  });
}

export const COVER_STYLES = ['vinyl', 'sunset', 'bauhaus', 'cassette'] as const;
export type CoverStyle = (typeof COVER_STYLES)[number];

export function coverStyle(trackId: string): CoverStyle {
  return COVER_STYLES[Math.floor(idRandom(trackId, 'style')() * COVER_STYLES.length)]!;
}

/** Square RGB24 cover: gradient + one of four motifs, coloured by the track's genres. */
export function coverPixels(trackId: string, genres: readonly string[], size = COVER_SIZE): Buffer {
  const rand = idRandom(trackId, 'cover');
  const p = palette(genres, rand);
  const c = new Canvas(size);
  const u = size / 100;
  const style = coverStyle(trackId);
  gradientBackground(c, p.deep, p.partner, rand() * Math.PI * 2);
  // Soft background bubbles.
  for (let i = 0; i < 6; i++) c.circle(rand() * size, rand() * size, (8 + rand() * 22) * u, p.light, 0.06 + rand() * 0.06);

  if (style === 'vinyl') {
    const cx = (45 + rand() * 12) * u, cy = (48 + rand() * 6) * u, r = 36 * u;
    // Sleeve peeking out behind the record.
    c.roundRect(8 * u, 14 * u, 60 * u, 86 * u, 2 * u, shade(p.base, 0.15), 0.9);
    c.circle(cx + 1.5 * u, cy + 2 * u, r, [0, 0, 0], 0.35);
    c.circle(cx, cy, r, [0.07, 0.07, 0.08]);
    for (let g = 0; g < 14; g++) c.ring(cx, cy, r * (0.42 + g * 0.04), 0.35 * u, [0.2, 0.2, 0.22], 0.7);
    c.shape([cx - r, cy - r, cx + r, cy + r], (x, y) => {
      const a = Math.atan2(y - cy, x - cx);
      const band = Math.abs(((a + Math.PI * 0.75) % (Math.PI * 2)) - 0.5) - 0.18;
      return Math.max(Math.hypot(x - cx, y - cy) - r * 0.97, band * r);
    }, [1, 1, 1], 0.08);
    c.circle(cx, cy, r * 0.33, p.base);
    c.circle(cx, cy, r * 0.33, (x, y) => shade(p.base, ((y - cy) / (r * 0.33)) * -0.2), 0.6);
    c.ring(cx, cy, r * 0.22, 0.5 * u, shade(p.base, 0.4), 0.7);
    c.circle(cx, cy, 1.6 * u, [0.05, 0.05, 0.05]);
  } else if (style === 'sunset') {
    const sunX = (30 + rand() * 40) * u, sunY = (34 + rand() * 12) * u;
    for (let i = 0; i < 30; i++) c.circle(rand() * size, rand() * 50 * u, (0.3 + rand() * 0.5) * u, [1, 1, 1], 0.5 + rand() * 0.4);
    c.circle(sunX, sunY, 26 * u, p.light, 0.15);
    c.circle(sunX, sunY, 17 * u, (x, y) => mix(hsl(48, 0.95, 0.72), p.base, clamp01((y - sunY + 17 * u) / (34 * u))));
    for (let layer = 0; layer < 4; layer++) {
      const base = (58 + layer * 10) * u, amp = (4 + rand() * 5) * u, freq = 0.02 + rand() * 0.03, phase = rand() * 6;
      const color = shade(mix(p.deep, p.partner, 0.3 - layer * 0.1), -0.15 - layer * 0.15);
      c.shape([0, base - amp - 2, size, size], (x, y) => base + Math.sin(x * freq / u * 3 + phase) * amp + Math.sin(x * freq / u * 7 + phase * 2) * amp * 0.35 - y, color);
    }
  } else if (style === 'bauhaus') {
    const shapes = 5 + Math.floor(rand() * 4);
    for (let i = 0; i < shapes; i++) {
      const color = [p.base, p.partner, p.light, shade(p.deep, -0.2), hsl(48, 0.9, 0.6)][Math.floor(rand() * 5)]!;
      const x = (15 + rand() * 70) * u, y = (15 + rand() * 70) * u, r = (8 + rand() * 20) * u;
      const kind = Math.floor(rand() * 3);
      if (kind === 0) c.circle(x, y, r, color, 0.85);
      else if (kind === 1) c.roundRect(x - r, y - r * 0.6, x + r, y + r * 0.6, 1.5 * u, color, 0.85);
      else
        c.shape([x - r, y - r, x + r, y + r], (px, py) => {
          // Half disc (quarter-turn chosen by hash): a classic Bauhaus motif.
          const d = Math.hypot(px - x, py - y) - r;
          return Math.max(d, i % 2 ? py - y : x - px);
        }, color, 0.9);
    }
    for (let i = 0; i < 3; i++) c.ring(50 * u, 50 * u, (12 + i * 9) * u, 0.6 * u, [1, 1, 1], 0.25);
  } else {
    // Cartoon cassette tape with a smiling label.
    const x0 = 14 * u, y0 = 26 * u, x1 = 86 * u, y1 = 74 * u;
    c.roundRect(x0 + 1.5 * u, y0 + 2 * u, x1 + 1.5 * u, y1 + 2 * u, 5 * u, [0, 0, 0], 0.3);
    c.roundRect(x0, y0, x1, y1, 5 * u, shade(p.deep, -0.35));
    c.roundRect(x0 + 5 * u, y0 + 5 * u, x1 - 5 * u, y0 + 30 * u, 3 * u, p.light);
    c.roundRect(x0 + 5 * u, y0 + 5 * u, x1 - 5 * u, y0 + 12 * u, 3 * u, p.base);
    c.roundRect(32 * u, 44 * u, 68 * u, 54 * u, 5 * u, [0.12, 0.12, 0.14]);
    for (const rx of [40 * u, 60 * u]) {
      c.circle(rx, 49 * u, 4.2 * u, [0.95, 0.95, 0.95]);
      for (let t = 0; t < 6; t++) {
        const a = (t / 6) * Math.PI * 2 + rand();
        c.circle(rx + Math.cos(a) * 2.6 * u, 49 * u + Math.sin(a) * 2.6 * u, 0.7 * u, [0.12, 0.12, 0.14]);
      }
    }
    // Eyes and smile on the label.
    c.circle(38 * u, 40 * u, 1.4 * u, [0.1, 0.1, 0.12]);
    c.circle(62 * u, 40 * u, 1.4 * u, [0.1, 0.1, 0.12]);
    c.circle(33 * u, 43 * u, 2.2 * u, hsl(350, 0.8, 0.75), 0.6);
    c.circle(67 * u, 43 * u, 2.2 * u, hsl(350, 0.8, 0.75), 0.6);
    c.shape([44 * u, 38 * u, 56 * u, 46 * u], (x, y) => {
      const d = Math.abs(Math.hypot(x - 50 * u, y - 38 * u) - 5 * u) - 0.6 * u;
      return y < 40 * u ? 9e9 : d;
    }, [0.1, 0.1, 0.12]);
    c.roundRect(36 * u, y1 - 9 * u, 64 * u, y1, 2 * u, shade(p.deep, -0.15));
    for (const sx of [x0 + 3.5 * u, x1 - 3.5 * u]) for (const sy of [y0 + 3.5 * u, y1 - 3.5 * u]) c.circle(sx, sy, 1 * u, [0.6, 0.6, 0.62]);
    // Musical notes floating out.
    for (let i = 0; i < 3; i++) {
      const nx = (72 + i * 7) * u, ny = (20 - i * 5 + rand() * 4) * u;
      c.circle(nx, ny, 2.2 * u, [1, 1, 1], 0.85);
      c.roundRect(nx + 1.4 * u, ny - 9 * u, nx + 2.4 * u, ny, 0.4 * u, [1, 1, 1], 0.85);
    }
  }
  return c.toRgb24(idRandom(trackId, 'grain'));
}

/** Up to two initials, Unicode-aware (Vietnamese diacritics kept; "Đ" stays "Đ"). */
export function initials(name: string): string {
  const words = name.normalize('NFC').split(/[\s_.-]+/u).filter((w) => /\p{L}|\p{N}/u.test(w));
  const first = (w: string) => [...w].find((ch) => /\p{L}|\p{N}/u.test(ch)) ?? '';
  const picked = words.length >= 2 ? [words[0]!, words[words.length - 1]!] : words.slice(0, 1);
  return picked.map(first).join('').toLocaleUpperCase('vi') || '?';
}

export type AvatarStyle = 'initials' | 'face';

/** Square RGB24 avatar. initials: coloured disc (text is drawn by ffmpeg); face: a simple cartoon face. */
export function avatarPixels(userId: string, style: AvatarStyle, genres: readonly string[], size = AVATAR_SIZE): Buffer {
  const rand = idRandom(userId, 'avatar');
  const p = palette(genres, rand);
  const c = new Canvas(size);
  const u = size / 100;
  gradientBackground(c, shade(p.partner, 0.25), shade(p.base, -0.1), rand() * Math.PI * 2);
  if (style === 'initials') {
    c.circle(50 * u, 52 * u, 40 * u, [0, 0, 0], 0.18);
    c.circle(50 * u, 50 * u, 40 * u, (x, y) => mix(shade(p.base, 0.1), p.deep, clamp01((y - 10 * u) / (80 * u))));
    c.ring(50 * u, 50 * u, 36 * u, 0.8 * u, [1, 1, 1], 0.3);
    // A few equaliser bars under the initials.
    for (let i = 0; i < 5; i++) {
      const h = (3 + rand() * 7) * u, x = (39 + i * 5) * u;
      c.roundRect(x, 80 * u - h, x + 3 * u, 80 * u, 1 * u, [1, 1, 1], 0.55);
    }
  } else {
    const skin = hsl(20 + rand() * 18, 0.45 + rand() * 0.2, 0.62 + rand() * 0.15);
    const hair = hsl(rand() * 40, 0.3 + rand() * 0.3, 0.12 + rand() * 0.2);
    const shirt = p.base;
    c.shape([10 * u, 70 * u, 90 * u, 100 * u], (x, y) => Math.hypot((x - 50 * u) / 1.15, y - 108 * u) - 34 * u, shirt);
    c.roundRect(44 * u, 58 * u, 56 * u, 74 * u, 4 * u, shade(skin, -0.1));
    c.circle(50 * u, 30 * u, 25 * u, hair);
    c.circle(50 * u, 45 * u, 24 * u, skin);
    // Fringe (hair over the forehead): style chosen by hash.
    const fringe = Math.floor(rand() * 3);
    if (fringe === 0) c.shape([24 * u, 18 * u, 76 * u, 40 * u], (x, y) => Math.max(Math.hypot(x - 50 * u, y - 44 * u) - 25 * u, y - 33 * u), hair);
    else if (fringe === 1) c.shape([24 * u, 18 * u, 76 * u, 42 * u], (x, y) => Math.max(Math.hypot(x - 50 * u, y - 44 * u) - 25 * u, y - (30 * u + (x - 26 * u) * 0.25)), hair);
    else for (let i = 0; i < 5; i++) c.circle((31 + i * 9.5) * u, 27 * u, 7 * u, hair);
    // Headphones for music lovers.
    if (rand() < 0.55) {
      c.shape([20 * u, 14 * u, 80 * u, 46 * u], (x, y) => Math.max(Math.abs(Math.hypot(x - 50 * u, y - 44 * u) - 27 * u) - 1.5 * u, y - 44 * u), [0.15, 0.15, 0.17]);
      c.roundRect(19 * u, 40 * u, 27 * u, 56 * u, 3 * u, p.partner);
      c.roundRect(73 * u, 40 * u, 81 * u, 56 * u, 3 * u, p.partner);
    }
    c.circle(41 * u, 46 * u, 2.4 * u, [0.12, 0.1, 0.1]);
    c.circle(59 * u, 46 * u, 2.4 * u, [0.12, 0.1, 0.1]);
    c.circle(41.8 * u, 45.2 * u, 0.7 * u, [1, 1, 1]);
    c.circle(59.8 * u, 45.2 * u, 0.7 * u, [1, 1, 1]);
    c.circle(36 * u, 53 * u, 3.5 * u, hsl(355, 0.75, 0.72), 0.45);
    c.circle(64 * u, 53 * u, 3.5 * u, hsl(355, 0.75, 0.72), 0.45);
    c.shape([42 * u, 50 * u, 58 * u, 60 * u], (x, y) => (y < 53 * u ? 9e9 : Math.abs(Math.hypot(x - 50 * u, y - 50 * u) - 6 * u) - 0.9 * u), [0.35, 0.12, 0.12]);
  }
  return c.toRgb24(idRandom(userId, 'grain'), 0.02, 0.2);
}

const FONT_CANDIDATES = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];

/**
 * Raw RGB24 → WebP (libwebp, quality 82, no alpha, no metadata). `text` (avatars) is drawn centred with a local
 * font through a textfile, so no escaping of user-visible names is needed.
 */
export async function encodeWebp(rgb: Buffer, size: number, text?: string, bin = process.env.FFMPEG_PATH || 'ffmpeg'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'reco-art-'));
  try {
    const raw = join(dir, 'in.rgb');
    const out = join(dir, 'out.webp');
    await writeFile(raw, rgb);
    const filters: string[] = [];
    const font = FONT_CANDIDATES.find((f) => existsSync(f));
    if (text && font) {
      const textFile = join(dir, 'text.txt');
      await writeFile(textFile, text, 'utf8');
      const fontSize = Math.round(size * (text.length > 1 ? 0.3 : 0.36));
      filters.push(
        `drawtext=fontfile=${font}:textfile=${textFile}:fontsize=${fontSize}:fontcolor=white:` +
          `shadowcolor=black@0.35:shadowx=${Math.round(size / 128)}:shadowy=${Math.round(size / 128)}:` +
          `x=(w-text_w)/2:y=(h-text_h)/2-h*0.04`,
      );
    }
    await run(
      bin,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${size}x${size}`, '-i', raw,
        ...(filters.length ? ['-vf', filters.join(',')] : []),
        '-frames:v', '1', '-map_metadata', '-1', '-c:v', 'libwebp', '-lossless', '0', '-quality', String(WEBP_QUALITY),
        '-compression_level', '4', '-pix_fmt', 'yuv420p', '-f', 'webp', '-y', out,
      ],
      { timeout: 60_000 },
    );
    const webp = await readFile(out);
    validateNormalizedWebp(webp, size);
    return webp;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Same framing rules as validateNormalizedImage in apps/api/src/image-validation.ts: a single still WebP made only
 * of VP8X/ALPH/VP8/VP8L chunks, with both edges ≤ maxEdge. Throws on anything else.
 */
export function validateNormalizedWebp(input: Buffer, maxEdge: number): { width: number; height: number } {
  const fail = (why: string): never => {
    throw new Error(`generated image is not a valid normalised WebP (${why})`);
  };
  if (input.length < 20 || input.toString('ascii', 0, 4) !== 'RIFF' || input.toString('ascii', 8, 12) !== 'WEBP') fail('header');
  if (input.readUInt32LE(4) + 8 !== input.length) fail('size');
  let offset = 12, width = 0, height = 0, rasters = 0;
  while (offset < input.length) {
    if (offset + 8 > input.length) fail('truncated');
    const type = input.toString('ascii', offset, offset + 4), length = input.readUInt32LE(offset + 4), data = offset + 8;
    if (length > input.length - data) fail('chunk length');
    if (!['VP8X', 'ALPH', 'VP8 ', 'VP8L'].includes(type)) fail(`chunk ${type}`);
    if (type === 'VP8X') {
      if (input[data]! & 2) fail('animated');
      width = input.readUIntLE(data + 4, 3) + 1;
      height = input.readUIntLE(data + 7, 3) + 1;
    }
    if (type === 'VP8 ') {
      rasters += 1;
      if (length < 10 || !input.subarray(data + 3, data + 6).equals(Buffer.from([157, 1, 42]))) fail('VP8 frame');
      width = input.readUInt16LE(data + 6) & 0x3fff;
      height = input.readUInt16LE(data + 8) & 0x3fff;
    }
    if (type === 'VP8L') {
      rasters += 1;
      if (length < 5 || input[data] !== 0x2f) fail('VP8L frame');
      const bits = input.readUInt32LE(data + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    offset += 8 + length + (length % 2);
  }
  if (offset !== input.length || rasters !== 1) fail('raster count');
  if (!width || !height || width > maxEdge || height > maxEdge) fail('dimensions');
  return { width, height };
}
