'use strict';
/*
 * png.js - tiny PNG decoder -> straight-alpha RGBA, plus an alpha-aware resize.
 * zlib only (same as canvas.js). Enough for app icons: 8-bit, non-interlaced,
 * colour types 0 (grey), 2 (RGB), 3 (palette + tRNS), 4 (grey+alpha), 6 (RGBA).
 */
const zlib = require('zlib');
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function paeth(a, b, c) {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode a PNG Buffer -> { w, h, data: Uint8Array(w*h*4) } in RGBA, straight alpha. */
function decode(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
    let off = 8, w = 0, h = 0, depth = 0, ct = 0, inter = 0, plte = null, trns = null;
    const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        off += 12 + len;                                   // 4 len + 4 type + len + 4 crc
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ct = data[9]; inter = data[12]; }
        else if (type === 'PLTE') plte = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
    }
    if (depth !== 8) throw new Error('unsupported bit depth ' + depth);
    if (inter !== 0) throw new Error('interlaced PNG unsupported');
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!channels) throw new Error('unsupported colour type ' + ct);
    if (ct === 3 && !plte) throw new Error('palette PNG without PLTE');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = channels, stride = w * bpp;
    const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride);
    const out = new Uint8Array(w * h * 4);
    let ri = 0;
    for (let y = 0; y < h; y++) {
        const ft = raw[ri++];
        for (let x = 0; x < stride; x++) {
            const rb = raw[ri++];
            const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
            let v;
            switch (ft) {
                case 0: v = rb; break;
                case 1: v = rb + a; break;
                case 2: v = rb + b; break;
                case 3: v = rb + ((a + b) >> 1); break;
                case 4: v = rb + paeth(a, b, c); break;
                default: throw new Error('bad filter ' + ft);
            }
            cur[x] = v & 255;
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (ct === 3) {
                const idx = cur[x];
                out[o] = plte[idx * 3]; out[o + 1] = plte[idx * 3 + 1]; out[o + 2] = plte[idx * 3 + 2];
                out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
            } else if (ct === 6) {
                const s = x * 4; out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3];
            } else if (ct === 2) {
                const s = x * 3; out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255;
            } else if (ct === 4) {
                const s = x * 2; out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1];
            } else { // ct === 0
                const g = cur[x]; out[o] = out[o + 1] = out[o + 2] = g; out[o + 3] = 255;
            }
        }
        cur.copy(prev);
    }
    return { w: w, h: h, data: out };
}

/** Area-average resize of an RGBA buffer, alpha-weighted so edges stay clean. */
function resizeRGBA(src, sw, sh, dw, dh) {
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy0 = Math.floor(y * sh / dh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * sh / dh));
        for (let x = 0; x < dw; x++) {
            const sx0 = Math.floor(x * sw / dw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sw / dw));
            let r = 0, g = 0, b = 0, asum = 0, wsum = 0;
            for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) {
                const i = (yy * sw + xx) * 4, al = src[i + 3] / 255;
                r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; asum += src[i + 3]; wsum += al;
            }
            const n = (sy1 - sy0) * (sx1 - sx0), o = (y * dw + x) * 4;
            if (wsum > 0) { out[o] = Math.round(r / wsum); out[o + 1] = Math.round(g / wsum); out[o + 2] = Math.round(b / wsum); }
            out[o + 3] = Math.round(asum / n);
        }
    }
    return out;
}

module.exports = { decode: decode, resizeRGBA: resizeRGBA };
