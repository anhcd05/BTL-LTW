import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  AVATAR_SIZE,
  COVER_SIZE,
  COVER_STYLES,
  GENRE_HSL,
  avatarKey,
  avatarPixels,
  coverKey,
  coverPixels,
  coverStyle,
  encodeWebp,
  initials,
  validateNormalizedWebp,
} from '../src/art-render';
import { GENRES } from '../src/world';

const T1 = '0b6c3d0e-1111-4222-8333-444455556666';
const T2 = '7f2d9a10-aaaa-4bbb-8ccc-ddddeeeeffff';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

test('keys follow the API layout and are deterministic per id', () => {
  assert.match(coverKey(T1), new RegExp(`^cover/${T1}/${UUID}\\.webp$`));
  assert.match(avatarKey(T1), new RegExp(`^avatar/${T1}/${UUID}\\.webp$`));
  assert.equal(coverKey(T1), coverKey(T1));
  assert.notEqual(coverKey(T1), coverKey(T2));
  assert.notEqual(coverKey(T1).split('/')[2], avatarKey(T1).split('/')[2]);
});

test('every demo genre has a colour', () => {
  for (const g of GENRES) assert.ok(GENRE_HSL[g.id], g.id);
});

test('pixels are deterministic per id, differ between ids, and are not flat', () => {
  const a = coverPixels(T1, ['ballad'], 64);
  assert.equal(a.length, 64 * 64 * 3);
  assert.ok(a.equals(coverPixels(T1, ['ballad'], 64)));
  assert.ok(!a.equals(coverPixels(T2, ['ballad'], 64)));
  assert.ok(!a.equals(coverPixels(T1, ['edm'], 64)), 'genre changes the colours');
  assert.ok(new Set(a).size > 20);
  const face = avatarPixels(T1, 'face', ['v-pop'], 64);
  assert.equal(face.length, 64 * 64 * 3);
  assert.ok(face.equals(avatarPixels(T1, 'face', ['v-pop'], 64)));
  assert.ok(!face.equals(avatarPixels(T1, 'initials', ['v-pop'], 64)));
});

test('all four cover motifs occur over many ids', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(coverStyle(`track-${i}`));
  assert.deepEqual([...seen].sort(), [...COVER_STYLES].sort());
});

test('initials are Unicode-aware', () => {
  assert.equal(initials('Phố Lang Thang'), 'PT');
  assert.equal(initials('Đức'), 'Đ');
  assert.equal(initials('đức anh'), 'ĐA');
  assert.equal(initials('  '), '?');
});

test('WebP framing check mirrors the API validator', () => {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const riff = (...chunks: Buffer[]) => {
    const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]);
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const vp8 = (w: number, h: number) => {
    const b = Buffer.alloc(10);
    b.set([157, 1, 42], 3);
    b.writeUInt16LE(w, 6);
    b.writeUInt16LE(h, 8);
    return chunk('VP8 ', b);
  };
  assert.deepEqual(validateNormalizedWebp(riff(vp8(640, 640)), 1200), { width: 640, height: 640 });
  assert.throws(() => validateNormalizedWebp(riff(vp8(640, 640)), 512), /dimensions/);
  assert.throws(() => validateNormalizedWebp(riff(vp8(64, 64), chunk('EXIF', Buffer.alloc(4))), 512), /chunk EXIF/);
  assert.throws(() => validateNormalizedWebp(riff(vp8(64, 64), vp8(64, 64)), 512), /raster/);
  assert.throws(() => validateNormalizedWebp(Buffer.from('not an image at all!'), 512), /header/);
});

let ffmpeg = true;
try {
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  ffmpeg = false;
}
test('ffmpeg encodes normalised WebP covers and avatars', { skip: !ffmpeg && 'ffmpeg not available' }, async () => {
  const cover = await encodeWebp(coverPixels(T1, ['acoustic']), COVER_SIZE);
  assert.deepEqual(validateNormalizedWebp(cover, 1200), { width: COVER_SIZE, height: COVER_SIZE });
  const avatar = await encodeWebp(avatarPixels(T2, 'initials', ['ballad']), AVATAR_SIZE, 'PT');
  assert.deepEqual(validateNormalizedWebp(avatar, 512), { width: AVATAR_SIZE, height: AVATAR_SIZE });
  assert.ok(cover.length < 300_000 && avatar.length < 200_000);
});
