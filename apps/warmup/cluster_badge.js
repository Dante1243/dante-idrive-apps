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
 * Degrades safely: if cluster-render is not installed (or sockets / decode are
 * unavailable) the badge is a no-op and the rest of Warm-Up is unaffected.
 */
const { decode, resizeRGBA } = require('./kit/png');
const icons = require('./cluster_icons');          // { cold: <b64 png>, hot: <b64 png> }

let ClusterRender = null;
try { ({ ClusterRender } = require('./kit/cluster_render')); } catch (e) { /* no net / not present */ }

function iconPixels(b64, size) {
    const png = decode(Buffer.from(b64, 'base64'));
    return Buffer.from(resizeRGBA(png.data, png.w, png.h, size, size));
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
        this.cr = null;
        this.px = {};
        if (!ClusterRender) { this.log.warn('cluster badge: node net unavailable, disabled'); return; }
        try {
            this.px.cold = iconPixels(icons.cold, this.size);
            this.px.hot = iconPixels(icons.hot, this.size);
        } catch (e) { this.log.warn('cluster badge: icon decode failed, disabled: ' + e); return; }
        try {
            this.cr = new ClusterRender(opts.app || 'warmup');
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
        this.log.info('cluster badge ready (' + this.target + ' ' + this.x + ',' + this.y + ' ' + this.size + 'px)');
    }

    _apply() {
        if (!this.cr || !this.ref) return;
        if (this.state === 'off') { this.cr.visible(this.ref, false); return; }
        if (this.shown !== this.state) { this.cr.pixels(this.ref, this.px[this.state]); this.shown = this.state; }
        this.cr.visible(this.ref, true);
    }

    /** 'off' | 'cold' | 'hot' */
    setState(s) { if (s !== this.state) { this.state = s; this._apply(); } }

    close() {
        this.state = 'off';
        if (this.cr) { try { if (this.ref) this.cr.drop(this.ref); this.cr.close(); } catch (e) {} }
    }
}

module.exports = { ClusterBadge };
