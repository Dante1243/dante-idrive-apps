'use strict';
/*
 * cluster_badge.js - shows a cold-oil telltale on the instrument cluster while
 * the engine oil is below the warm threshold, drawn through cluster-render
 * (see ./kit/cluster_render and apps/warmup/CLUSTER.md).
 *
 * The icon is drawn with the kit's software Canvas, whose .d field is a straight-
 * alpha RGBA buffer - exactly what cluster-render's image layer wants - so there
 * is no PNG decode or external rasteriser, and the colour themes with the app.
 *
 * Degrades safely: if cluster-render is not installed (or sockets are not
 * available) the badge is a no-op and the rest of Warm-Up is unaffected.
 */
const { Canvas } = require('./kit/canvas');

let ClusterRender = null;
try { ({ ClusterRender } = require('./kit/cluster_render')); } catch (e) { /* no net / not present */ }

// where the badge sits inside the target, as [x, y] given the target size and icon size
const POS = {
    'top-left':     (W, H, s) => [40, 40],
    'top-right':    (W, H, s) => [W - s - 40, 40],
    'bottom-left':  (W, H, s) => [40, H - s - 40],
    'bottom-right': (W, H, s) => [W - s - 40, H - s - 40],
    'center':       (W, H, s) => [Math.round((W - s) / 2), Math.round((H - s) / 2)],
};
const FALLBACK = { panel: { w: 1920, h: 720 }, map: { w: 1088, h: 480 }, hud: { w: 800, h: 480 } };

/** The oil-can-over-wavy-lines telltale, drawn in `color` on a transparent S x S canvas. */
function drawOilIcon(S, color) {
    const cv = new Canvas(S, S).clear([0, 0, 0, 0]);
    const k = S / 128, P = (n) => n * k;            // design grid is 128 x 128
    cv.arc(P(42), P(58), P(12), P(18), -62, 62, color);          // handle (top hump)
    cv.roundRect(P(14), P(56), P(72), P(42), P(11), color);      // can body
    cv.line(P(80), P(60), P(114), P(30), P(11), color);          // spout
    cv.triangle([[P(114), P(42)], [P(107), P(56)], [P(121), P(56)]], color);   // drop: pointed top
    cv.circle(P(114), P(58), P(7), color);                       // drop: round bottom
    for (let row = 0; row < 2; row++) {                          // two wavy oil lines under the can
        const y0 = P(108 + row * 12), amp = P(4), x0 = P(16), x1 = P(112), steps = 24, pts = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            pts.push([x0 + (x1 - x0) * t, y0 + Math.sin(t * Math.PI * 3 + row * Math.PI) * amp]);
        }
        cv.polyline(pts, P(4), color);
    }
    return cv;
}

class ClusterBadge {
    constructor(opts) {
        opts = opts || {};
        this.log = opts.log || { info() {}, warn() {} };
        this.size = opts.size || 128;
        this.pos = opts.pos || 'top-right';
        this.color = opts.color || '#53b0ff';       // cold blue
        this.target = opts.target || 'panel';
        this.want = false;                           // desired visibility
        this.ref = 0;
        this.cr = null;
        this._px = null;
        if (!ClusterRender) { this.log.warn('cluster badge: node net unavailable, disabled'); return; }
        try {
            this.cr = new ClusterRender(opts.app || 'warmup');
            this.cr.on('ready', (backend, targets) => this._onReady(backend, targets));
            this.cr.on('error', (e) => this.log.warn('cluster badge: ' + ((e && e.reason) || e)));
            this.cr.connect();
        } catch (e) { this.log.warn('cluster badge off: ' + e); this.cr = null; }
    }

    _dims(targets) {
        const t = targets && targets[this.target];
        if (typeof t === 'string') { const m = /(\d+)\s*x\s*(\d+)/.exec(t); if (m) return { w: +m[1], h: +m[2] }; }
        if (t && t.w && t.h) return { w: t.w, h: t.h };
        return FALLBACK[this.target] || FALLBACK.panel;
    }

    // called on every (re)connect: (re)create the layer, (re)upload the pixels, restore visibility
    _onReady(backend, targets) {
        const dim = this._dims(targets);
        const [x, y] = (POS[this.pos] || POS['top-right'])(dim.w, dim.h, this.size);
        if (!this._px) this._px = Buffer.from(drawOilIcon(this.size, this.color).d);
        if (!this.ref) {
            this.ref = this.cr.image({
                target: this.target, klass: 'alert',
                x: x, y: y, w: this.size, h: this.size, iw: this.size, ih: this.size,
                visible: this.want,
            });
        } else {
            this.cr.set(this.ref, { x: x, y: y });
        }
        this.cr.pixels(this.ref, this._px);
        this.cr.visible(this.ref, this.want);
        this.log.info('cluster badge ready (' + (backend || '?') + ', ' + this.target + ' ' + dim.w + 'x' + dim.h + ')');
    }

    /** Show or hide the badge (driven by oil temperature). */
    show(on) {
        on = !!on;
        if (on === this.want) return;
        this.want = on;
        if (this.cr && this.ref) this.cr.visible(this.ref, on);
    }

    close() {
        this.want = false;
        if (this.cr) { try { if (this.ref) this.cr.drop(this.ref); this.cr.close(); } catch (e) {} }
    }
}

module.exports = { ClusterBadge, drawOilIcon };
