// Node's createHash('sha1') for tools/js/roomsrc.mjs in the browser (worker.js): sync SHA-1 of a string's UTF-8 bytes.
function sha1hex(bytes) {
  const n = bytes.length, words = new Uint32Array(((n + 8 >> 6) + 1) * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= bytes[i] << (24 - (i & 3) * 8);
  words[n >> 2] |= 0x80 << (24 - (n & 3) * 8);
  words[words.length - 1] = n * 8;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476, e0 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let o = 0; o < words.length; o += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[o + t];
    for (let t = 16; t < 80; t++) { const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; w[t] = (x << 1) | (x >>> 31); }
    let a = a0, b = b0, c = c0, d = d0, e = e0;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0; e0 = (e0 + e) >>> 0;
  }
  return [a0, b0, c0, d0, e0].map(v => v.toString(16).padStart(8, '0')).join('');
}

export function createHash() {
  let data = '';
  const h = { update(s) { data += s; return h; }, digest() { return sha1hex(new TextEncoder().encode(data)); } };
  return h;
}
