/* A QR encoder, because the alternative was a CDN.
 *
 * The app vendors its dependencies and runs under a policy that blocks external
 * hosts, so "share this as a QR code" is either a library in the repository or
 * about two hundred lines here. This is byte mode at error-correction level M,
 * versions 1 to 10 -- up to 271 bytes, where a link from this app is around 60.
 *
 * Loaded on demand, the way Leaflet is: most sessions never share anything.
 */

// Byte-mode data capacity in codewords at ECC level M, and how the codewords
// are split into Reed-Solomon blocks. [ecPerBlock, blocks1, data1, blocks2, data2]
const SPEC = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* ---- GF(256), the field Reed-Solomon is defined over --------------------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;          // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for `n` error-correction codewords. */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder is the error-correction block. */
function ecBlock(data, n) {
  const gen = generator(n);
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= mul(gen[i + 1], factor);
  }
  return rem;
}

/* ---- bitstream ---------------------------------------------------------- */

class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

/* ---- matrix ------------------------------------------------------------- */

function reserve(size, version) {
  // null = free, true/false = a module already placed and not maskable.
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const finder = (r, c) => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const y = r + i, x = c + j;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const edge = i === -1 || i === 7 || j === -1 || j === 7;
        const ring = i === 0 || i === 6 || j === 0 || j === 6;
        const core = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        m[y][x] = edge ? false : (ring || core);
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {          // timing patterns
    const on = i % 2 === 0;
    m[6][i] = on;
    m[i][6] = on;
  }

  // Alignment patterns sit at every pairing of the version's coordinates except
  // the three that would land on a finder. Testing for "already occupied" is
  // not the same test: from version 7 the middle coordinate is on row and
  // column 6, so those patterns cross the timing pattern quite legitimately and
  // must still be drawn -- they take precedence where they overlap.
  const onFinder = (r, c) =>
    (r <= 8 && c <= 8) ||
    (r <= 8 && c >= size - 9) ||
    (r >= size - 9 && c <= 8);
  for (const r of ALIGN[version]) {
    for (const c of ALIGN[version]) {
      if (onFinder(r, c)) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          m[r + i][c + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
        }
      }
    }
  }

  if (version >= 7) {                           // version information blocks
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = size - 11 + (i % 3);
      m[r][c] = false;
      m[c][r] = false;
    }
  }

  m[size - 8][8] = true;                        // the always-dark module
  for (let i = 0; i < 9; i++) {                 // format information areas
    if (m[8][i] === null) m[8][i] = false;
    if (m[i][8] === null) m[i][8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = false;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = false;
  }
  return m;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH(18,6) version information. Only versions 7 and up carry it. */
function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

/** BCH(15,5) format information: level M is 0b00, then the mask, then ECC. */
function formatBits(mask) {
  let value = (0b00 << 3) | mask;
  let rem = value << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((value << 10) | rem) ^ 0x5412;
}

function penalty(m) {
  const n = m.length;
  let score = 0;

  const run = (get) => {
    for (let a = 0; a < n; a++) {
      let last = null, len = 0;
      for (let b = 0; b < n; b++) {
        const v = get(a, b);
        if (v === last) { len++; if (len === 5) score += 3; else if (len > 5) score += 1; }
        else { last = v; len = 1; }
      }
    }
  };
  run((r, c) => m[r][c]);
  run((c, r) => m[r][c]);

  for (let r = 0; r < n - 1; r++) {                       // 2x2 blocks
    for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  const FIND = [true, false, true, true, true, false, true];
  const looks = (get, a, b) => {
    for (let i = 0; i < 7; i++) if (get(a, b + i) !== FIND[i]) return false;
    const before = [];
    for (let i = 1; i <= 4; i++) before.push(get(a, b - i));
    const after = [];
    for (let i = 7; i < 11; i++) after.push(get(a, b + i));
    return before.every((v) => v === false) || after.every((v) => v === false);
  };
  const safe = (r, c) => (r < 0 || r >= n || c < 0 || c >= n ? false : m[r][c]);
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (looks((x, y) => safe(x, y), a, b)) score += 40;
      if (looks((x, y) => safe(y, x), a, b)) score += 40;
    }
  }

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` as a QR matrix.
 * @returns {boolean[][]} true = dark module.
 */
export function encode(text) {
  const bytes = new TextEncoder().encode(text);

  let version = 0;
  let spec = null;
  for (let v = 1; v <= 10; v++) {
    const [ec, b1, d1, b2, d2] = SPEC[v];
    if (b1 * d1 + b2 * d2 >= bytes.length + 2 + (v < 10 ? 1 : 2)) {
      version = v; spec = SPEC[v]; break;
    }
  }
  if (!version) throw new Error("too much data for a version-10 QR code");

  const [ecLen, blocks1, data1, blocks2, data2] = spec;
  const totalData = blocks1 * data1 + blocks2 * data2;

  const bs = new Bits();
  bs.push(0b0100, 4);                                   // byte mode
  bs.push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bs.push(b, 8);
  bs.push(0, Math.min(4, totalData * 8 - bs.length));   // terminator
  while (bs.length % 8) bs.bits.push(0);

  const codewords = [];
  for (let i = 0; i < bs.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bs.bits[i + j];
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < totalData; i++) {  // pad bytes, alternating
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let at = 0;
  for (let i = 0; i < blocks1 + blocks2; i++) {
    const size = i < blocks1 ? data1 : data2;
    const block = codewords.slice(at, at + size);
    at += size;
    dataBlocks.push(block);
    ecBlocks.push(ecBlock(block, ecLen));
  }

  // Interleave, which is what makes a burst of damage survivable.
  const stream = [];
  for (let i = 0; i < Math.max(data1, data2); i++) {
    for (const block of dataBlocks) if (i < block.length) stream.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const block of ecBlocks) stream.push(block[i]);

  const size = version * 4 + 17;
  const base = reserve(size, version);

  // Place the stream in the free modules, two columns at a time, upwards then
  // downwards, skipping the vertical timing pattern.
  const placed = base.map((row) => row.slice());
  let bit = 0;
  const nextBit = () => {
    const byte = stream[bit >> 3];
    const value = byte === undefined ? 0 : (byte >>> (7 - (bit & 7))) & 1;
    bit++;
    return value === 1;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                          // the timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (placed[row][col] === null) placed[row][col] = nextBit();
      }
    }
    upward = !upward;
  }

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = placed.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (base[r][c] === null && MASKS[mask](r, c)) m[r][c] = !m[r][c];
      }
    }
    const fmt = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const on = ((fmt >>> i) & 1) === 1;   // bit i, least significant first
      // Copy one wraps the top-left finder: up the column, then along the row.
      if (i < 6) m[i][8] = on;
      else if (i === 6) m[7][8] = on;
      else if (i === 7) m[8][8] = on;
      else if (i === 8) m[8][7] = on;
      else m[8][14 - i] = on;
      // Copy two is split between the other two finders. It stops one short of
      // the bottom-left corner: (size-8, 8) is the permanently dark module.
      if (i < 7) m[size - 1 - i][8] = on;
      else m[8][size - 15 + i] = on;
    }
    if (version >= 7) {
      const info = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const on = ((info >>> i) & 1) === 1;
        const r = Math.floor(i / 3), c = size - 11 + (i % 3);
        m[r][c] = on;
        m[c][r] = on;
      }
    }
    m[size - 8][8] = true;
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return best;
}

/** Render a matrix as a standalone SVG string, quiet zone included. */
export function toSvg(matrix, { quiet = 4, dark = "#000", light = "#fff" } = {}) {
  const n = matrix.length;
  const total = n + quiet * 2;
  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`;
}
