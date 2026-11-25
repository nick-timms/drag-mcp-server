import { deflateSync } from "node:zlib";

/**
 * PNG encoding of raw pixels, with Node's own zlib: no native image library,
 * so the package installs anywhere `npx` runs.
 */

export interface RawImage {
  width: number;
  height: number;
  /** 1 grey, 2 grey + alpha, 3 RGB, 4 RGBA. */
  channels: number;
  data: Uint8Array | Uint8ClampedArray;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

const COLOR_TYPE: Record<number, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };

/** A PNG of 8-bit pixels, rows top to bottom, no padding. */
export function encodePng({ width, height, channels, data }: RawImage): Buffer {
  const colorType = COLOR_TYPE[channels];
  if (colorType === undefined) throw new Error(`cannot encode ${channels}-channel pixels`);
  const stride = width * channels;
  if (data.length < stride * height) throw new Error("pixel data is shorter than the image");
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Scale down so the longer side is at most `maxSide`, averaging each block of source pixels. */
export function scaleDown(image: RawImage, maxSide: number): RawImage {
  const { width, height, channels, data } = image;
  const factor = Math.ceil(Math.max(width, height) / maxSide);
  if (factor <= 1) return image;
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
  const out = new Uint8Array(w * h * channels);
  const area = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * width;
          for (let dx = 0; dx < factor; dx++) sum += data[(row + x * factor + dx) * channels + c];
        }
        out[(y * w + x) * channels + c] = Math.round(sum / area);
      }
    }
  }
  return { width: w, height: h, channels, data: out };
}
