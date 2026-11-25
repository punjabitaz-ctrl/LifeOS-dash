// v1.4.0 B8: the app icons, drawn here with no external asset. A rounded square in the app's accent colour with a white "L" (a bar and a foot)
// and a dot. Output is a plain PNG with a tEXt chunk carrying the shell marker the service worker checks ("lifeos-shell", NUL, version).
import { deflateSync } from 'node:zlib';

export const ACCENT = [79, 70, 229]; // #4f46e5, the app's accent (v2.3.0)
export const BACKGROUND = '#f5f7fb', THEME = '#4f46e5';
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// Coverage (0..1) of a point inside a rounded rectangle given in unit coordinates.
const inRR = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x, cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// maskable: the background fills the whole square and the mark stays inside the central 80 percent.
export function drawIcon(size, maskable, version) {
  const S = 3, px = Buffer.alloc(size * (size * 4 + 1));
  const scale = maskable ? 0.62 : 0.7, off = (1 - scale) / 2;
  const mark = (u, v) => {
    const x = (u - off) / scale, y = (v - off) / scale;
    return inRR(x, y, 0.18, 0.08, 0.42, 0.92, 0.05) || inRR(x, y, 0.18, 0.68, 0.84, 0.92, 0.05) || ((x - 0.7) ** 2 + (y - 0.28) ** 2 <= 0.12 * 0.12);
  };
  for (let j = 0; j < size; j++) {
    const row = j * (size * 4 + 1);
    px[row] = 0;
    for (let i = 0; i < size; i++) {
      let bg = 0, fg = 0;
      for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) {
        const u = (i + (a + 0.5) / S) / size, v = (j + (b + 0.5) / S) / size;
        if (maskable || inRR(u, v, 0, 0, 1, 1, 0.22)) { bg++; if (mark(u, v)) fg++; }
      }
      const n = S * S, o = row + 1 + i * 4, a = bg / n, f = bg ? fg / bg : 0;
      px[o] = Math.round(ACCENT[0] + (255 - ACCENT[0]) * f); px[o + 1] = Math.round(ACCENT[1] + (255 - ACCENT[1]) * f); px[o + 2] = Math.round(ACCENT[2] + (255 - ACCENT[2]) * f);
      px[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('lifeos-shell\0' + version, 'latin1')), chunk('IDAT', deflateSync(px, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export const ICONS = [
  { path: 'icons/icon-192.png', size: 192, maskable: false, purpose: 'any' },
  { path: 'icons/icon-512.png', size: 512, maskable: false, purpose: 'any' },
  { path: 'icons/icon-maskable-512.png', size: 512, maskable: true, purpose: 'maskable' }
];
// v1.4.0 audit: the iPhone home-screen icon, 180 px, opaque to the edge (iOS fills transparency with black and rounds the corners itself).
// It is inlined in the page as a data: URL, because the page policy allows images only from data: and Chrome applies img-src to a
// same-origin apple-touch-icon link (tested). It is not a manifest icon and not a separate file.
export const APPLE_ICON = Object.freeze({ size: 180, maskable: true });
export const appleIconDataUrl = (version) => 'data:image/png;base64,' + drawIcon(APPLE_ICON.size, APPLE_ICON.maskable, version).toString('base64');
export function manifestFor(version) {
  return {
    name: 'LifeOS', short_name: 'LifeOS', description: 'A private, encrypted life dashboard.',
    start_url: './lifeos', scope: './', display: 'standalone',
    background_color: BACKGROUND, theme_color: THEME,
    icons: ICONS.map((i) => ({ src: i.path, sizes: i.size + 'x' + i.size, type: 'image/png', purpose: i.purpose })),
    lifeos_shell: version
  };
}
