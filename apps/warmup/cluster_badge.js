'use strict';
/*
 * cluster_badge.js - shows an oil telltale on the instrument cluster through
 * cluster-render (see ./kit/cluster_render and apps/warmup/CLUSTER.md).
 *
 * Two icons, same spot, one at a time:
 *   cold (blue)  while oil is below the warm threshold
 *   hot  (amber) at/above the hot threshold
 * The artwork is the user's own PNGs, embedded in ./cluster_icons (base64) and
 * decoded + resized to the layer size here (./kit/png). The cluster takes raw
 * RGBA, so there is no image box - the pixels go straight to the layer.
 *
 * Slot Lab's test card is a second, see-through layer over the whole target: a lettered grid, so
 * one photo of the cluster shows where a slot sits and how much of the scene it lets through.
 *
 * Degrades safely: if cluster-render is not installed (or sockets / decode are
 * unavailable) the badge is a no-op and the rest of Warm-Up is unaffected.
 */
const { decode, resizeRGBA } = require('./kit/png');
const { Canvas } = require('./kit/canvas');
const icons = require('./cluster_icons');          // { cold: <b64 png>, hot: <b64 png> }

let ClusterRender = null;
try { ({ ClusterRender } = require('./kit/cluster_render')); } catch (e) { /* no net / not present */ }

const CARD_W = 480, CARD_H = 180, TARGET_W = 1920, TARGET_H = 720;
const CARD_COLS = 8, CARD_ROWS = 3, CARD_ALPHA = 140;

function iconPixels(b64, size) {
    const png = decode(Buffer.from(b64, 'base64'));
    return Buffer.from(resizeRGBA(png.data, png.w, png.h, size, size));
}

/** The lettered grid, a quarter of the target's size (the layer scales it up): A1 top left, H3 bottom right. */
function cardPixels() {
    const cv = new Canvas(CARD_W, CARD_H).clear('#0a1a2a');
    const cw = CARD_W / CARD_COLS, ch = CARD_H / CARD_ROWS;
    for (let r = 0; r < CARD_ROWS; r++) {
        for (let c = 0; c < CARD_COLS; c++) {
            if ((r + c) % 2) cv.fillRect(c * cw, r * ch, cw, ch, '#12344f');
            cv.text('ABCDEFGH'[c] + (r + 1), c * cw + cw / 2, r * ch + ch / 2 + 9, 26, '#ffffff', { align: 'center', font: 'bold', literal: true });
        }
    }
    const d = cv.d;
    for (let i = 3; i < d.length; i += 4) d[i] = CARD_ALPHA;
    return Buffer.from(d.buffer, d.byteOffset, d.length);
}

class ClusterBadge {
    constructor(opts) {
        opts = opts || {};
        this.log = opts.log || { info() {}, warn() {} };
        this.size = opts.size || 90;
        this.x = opts.x != null ? opts.x : 1670;
        this.y = opts.y != null ? opts.y : 620;
        this.target = opts.target || 'panel';
        this.state = 'off';            // 'off' | 'cold' | 'hot'
        this.shown = null;             // which icon's pixels are currently uploaded
        this.ref = 0;
        this.card = false;             // the test card wanted
        this.cardRef = 0;
        this.cr = null;
        this.px = {};
        if (!ClusterRender) { this.log.warn('cluster badge: node net unavailable, disabled'); return; }
        try {
            this.px.cold = iconPixels(icons.cold, this.size);
            this.px.hot = iconPixels(icons.hot, this.size);
        } catch (e) { this.log.warn('cluster badge: icon decode failed, disabled: ' + e); return; }
        try {
            this.cr = new ClusterRender(opts.app || 'warmup', opts.socket);
            this.cr.on('ready', () => this._onReady());
            this.cr.on('error', (e) => this.log.warn('cluster badge: ' + ((e && e.reason) || e)));
            this.cr.connect();
        } catch (e) { this.log.warn('cluster badge off: ' + e); this.cr = null; }
    }

    // called on every (re)connect: (re)create the layer, then re-apply current state + pixels
    _onReady() {
        if (!this.ref) {
            this.ref = this.cr.image({
                target: this.target, klass: 'alert',
                x: this.x, y: this.y, w: this.size, h: this.size, iw: this.size, ih: this.size,
                visible: this.state !== 'off',
            });
        } else {
            this.cr.set(this.ref, { x: this.x, y: this.y, w: this.size, h: this.size });
        }
        this.shown = null;             // force the pixels to be re-sent after a (re)connect
        this._apply();
        this._applyCard();
        this.log.info('cluster badge ready (' + this.target + ' ' + this.x + ',' + this.y + ' ' + this.size + 'px)');
    }

    _apply() {
        if (!this.cr || !this.ref) return;
        if (this.state === 'off') { this.cr.visible(this.ref, false); return; }
        if (this.shown !== this.state) { this.cr.pixels(this.ref, this.px[this.state]); this.shown = this.state; }
        this.cr.visible(this.ref, true);
    }

    _applyCard() {
        if (!this.cr || !this.cr.ready) return;
        if (this.card && !this.cardRef) {
            this.cardRef = this.cr.image({ target: this.target, klass: 'overlay', x: 0, y: 0, w: TARGET_W, h: TARGET_H, iw: CARD_W, ih: CARD_H, sampling: 'nearest' });
            try { this.cr.pixels(this.cardRef, cardPixels()); } catch (e) { this.log.warn('test card: ' + e); }
        } else if (!this.card && this.cardRef) {
            this.cr.drop(this.cardRef);
            this.cardRef = 0;
        }
    }

    /** 'off' | 'cold' | 'hot' */
    setState(s) { if (s !== this.state) { this.state = s; this._apply(); } }

    /** The lettered grid over the whole target, for Slot Lab. */
    setTestCard(on) { if (!!on !== this.card) { this.card = !!on; this._applyCard(); } }

    /** Live-move / resize the badge (from the tuning settings). Re-bakes pixels if size changed. */
    setGeometry(x, y, size) {
        const sizeChanged = size != null && size !== this.size;
        if (x != null) this.x = x;
        if (y != null) this.y = y;
        if (sizeChanged) {
            this.size = size;
            try { this.px.cold = iconPixels(icons.cold, size); this.px.hot = iconPixels(icons.hot, size); }
            catch (e) { this.log.warn('cluster badge: resize failed: ' + e); }
            this.shown = null;                         // force the (new-size) pixels to re-upload
            if (this.cr && this.cr.ready && this.ref) { this.cr.drop(this.ref); this.ref = 0; this._onReady(); }
        } else if (this.cr && this.ref) {
            this.cr.set(this.ref, { x: this.x, y: this.y });
        }
    }

    close() {
        this.state = 'off';
        if (this.cr) { try { if (this.ref) this.cr.drop(this.ref); if (this.cardRef) this.cr.drop(this.cardRef); this.cr.close(); } catch (e) {} }
    }
}

module.exports = { ClusterBadge, cardPixels };
