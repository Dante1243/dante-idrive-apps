'use strict';
/*
 * cluster_render.js - minimal client for robertnisipeanu's cluster-render service,
 * the renderer that draws app layers on the BMW instrument cluster and HUD
 * (https://github.com/robertnisipeanu/idrive-apps, native/cluster-render).
 *
 * This is an independent, clean-room implementation of the documented PROTOCOL.md
 * wire format (protocol v1): it contains NO code from cluster-render (which is
 * MPL-2.0) and is MIT like the rest of this kit. It implements only what an app
 * needs to put a static image on the cluster: the hello handshake, an image layer,
 * whole-image RGBA upload, show/hide, the service's status text, and silent
 * auto-reconnect that restores the layer when the renderer (re)appears.
 *
 * It never throws into the app. If cluster-render is not installed, the socket
 * simply never connects and every call is a quiet no-op while it keeps retrying,
 * so an app that uses it still runs normally on a car without the renderer.
 *
 * Wire format (PROTOCOL.md): each message is  u32 LE length (of the bytes after
 * it) | u8 type | body.  Type 'J' (0x4A) = a flat JSON object, 'F' (0x46) = a
 * pixel frame. An image frame body is  u32 ref | u64 frameId | u16 rectCount |
 * rects | pixels, little-endian; rectCount 0 means "the whole image" follows as
 * RGBA rows (straight alpha), top-left origin - exactly a canvas.js Canvas.d.
 */
const net = require('net');
const EventEmitter = require('events');

const DEFAULT_PATH = '/dev/shm/cluster-render/render.sock';
const T_JSON = 0x4A, T_FRAME = 0x46;
const MAX_MSG = 5529664;          // protocol ceiling (bytes after the length field)
const RECONNECT_MS = 2000;

class ClusterRender extends EventEmitter {
    constructor(app, socketPath) {
        super();
        this.app = app || 'app';
        this.path = socketPath || DEFAULT_PATH;
        this.sock = null;
        this.ready = false;
        this.closed = false;
        this.backend = null;
        this.targets = null;
        this._nextRef = 1;
        this._layers = new Map();     // ref -> { opts, px: Buffer|null }
        this._frameId = 0;
        this._rx = null;
        this._retry = null;
    }

    connect() { this.closed = false; this._open(); return this; }

    _open() {
        if (this.sock || this.closed) return;
        let s;
        try { s = net.connect({ path: this.path }); } catch (e) { return this._scheduleRetry(); }
        this.sock = s;
        s.on('connect', () => { this._send({ op: 'hello', app: this.app, proto: 1 }); });
        s.on('data', (b) => this._onData(b));
        s.on('error', () => {});                     // real handling is in 'close'
        s.on('close', () => {
            this.sock = null; this.ready = false; this._rx = null;
            this.emit('disconnected');
            this._scheduleRetry();
        });
    }

    _scheduleRetry() {
        if (this.closed || this._retry) return;
        this._retry = setTimeout(() => { this._retry = null; this._open(); }, RECONNECT_MS);
        if (this._retry.unref) this._retry.unref();
    }

    close() {
        this.closed = true;
        if (this._retry) { clearTimeout(this._retry); this._retry = null; }
        if (this.sock) { try { this.sock.destroy(); } catch (e) {} this.sock = null; }
        this.ready = false;
    }

    /* ---------- outgoing ---------- */
    _frame(type, body) {
        if (!this.sock) return false;
        const len = 1 + body.length;
        if (len > MAX_MSG) return false;
        const h = Buffer.allocUnsafe(5);
        h.writeUInt32LE(len, 0); h.writeUInt8(type, 4);
        try { this.sock.write(h); this.sock.write(body); return true; } catch (e) { return false; }
    }

    _send(obj) {
        let body;
        try { body = Buffer.from(JSON.stringify(obj), 'utf8'); } catch (e) { return false; }
        return this._frame(T_JSON, body);
    }

    _sendPixels(ref, px) {
        const head = Buffer.allocUnsafe(14);
        head.writeUInt32LE(ref >>> 0, 0);
        const id = (++this._frameId) >>> 0;          // u64 LE as low|high; frame ids stay small
        head.writeUInt32LE(id, 4); head.writeUInt32LE(0, 8);
        head.writeUInt16LE(0, 12);                   // rectCount 0 = whole image
        return this._frame(T_FRAME, Buffer.concat([head, px]));
    }

    /* ---------- incoming ---------- */
    _onData(b) {
        this._rx = this._rx ? Buffer.concat([this._rx, b]) : b;
        for (;;) {
            if (this._rx.length < 4) return;
            const len = this._rx.readUInt32LE(0);
            if (len < 1 || len > MAX_MSG) { this._rx = null; return; }   // desync: drop and wait for close
            if (this._rx.length < 4 + len) return;
            const type = this._rx.readUInt8(4);
            const body = this._rx.subarray(5, 4 + len);
            this._rx = this._rx.subarray(4 + len);
            if (type === T_JSON) {
                let ev = null;
                try { ev = JSON.parse(body.toString('utf8')); } catch (e) { ev = null; }
                if (ev) this._onEvent(ev);
            }
        }
    }

    _onEvent(ev) {
        switch (ev.ev) {
            case 'hello':
                this.backend = ev.backend || null;
                this.targets = ev.targets || null;
                this.ready = true;
                this._replay();
                this.emit('ready', this.backend, this.targets);
                break;
            case 'layer':  this.emit('layer', ev.ref, ev.state, ev.reason); break;
            case 'target': this.emit('target', ev.target, ev.state, ev); break;
            case 'budget': this.emit('budget', ev); break;
            case 'status': this.emit('status', String(ev.text || '')); break;
            // (an 'error' nobody listens to would throw)
            case 'error':  if (this.listenerCount('error')) this.emit('error', ev); break;
            default: break;
        }
    }

    _replay() {
        for (const [ref, L] of this._layers) {
            this._send(Object.assign({ op: 'layer', ref }, L.opts));
            if (L.px) this._sendPixels(ref, L.px);
        }
    }

    /** Ask for the service's status text: its targets, slots and layers. Answered by a 'status' event. */
    status() { return this.ready ? this._send({ op: 'status' }) : false; }

    /* ---------- public layer API ---------- */
    /**
     * Create an image layer; returns a client-chosen ref. opts: target,x,y,w,h,[iw,ih,klass,z,visible,sampling,contend].
     * contend: keep asking for the slot when the stock HMI has it, and on a target set to take over
     * from the stock HMI (`<target>_take_over_stock`), move its content aside. Without it a layer
     * waits until the slot is free, which a slot the stock HMI shows something in never is.
     */
    image(opts) {
        opts = opts || {};
        const ref = this._nextRef++;
        const o = {
            target: opts.target || 'panel', kind: 'image',
            x: opts.x | 0, y: opts.y | 0, w: opts.w | 0, h: opts.h | 0,
            iw: ((opts.iw == null ? opts.w : opts.iw) | 0),
            ih: ((opts.ih == null ? opts.h : opts.ih) | 0),
            'class': opts.klass || opts['class'] || 'overlay',
            sampling: opts.sampling || 'bilinear',
            visible: opts.visible === false || opts.visible === 0 ? 0 : 1,
        };
        if (opts.z != null) o.z = opts.z;
        if (opts.contend) o.contend = 1;
        this._layers.set(ref, { opts: o, px: null });
        if (this.ready) this._send(Object.assign({ op: 'layer', ref }, o));
        return ref;
    }

    /** Upload whole-image RGBA pixels (a Buffer or Uint8Array of iw*ih*4 bytes). */
    pixels(ref, px) {
        const L = this._layers.get(ref);
        if (!L) return false;
        L.px = Buffer.isBuffer(px) ? px : Buffer.from(px);
        return this.ready ? this._sendPixels(ref, L.px) : false;
    }

    /** Change layer fields later (x,y,w,h,z,visible,opacity,rotate,...). */
    set(ref, opts) {
        const L = this._layers.get(ref);
        if (!L) return false;
        Object.assign(L.opts, opts);
        return this.ready ? this._send(Object.assign({ op: 'set', ref }, opts)) : false;
    }

    visible(ref, on) { return this.set(ref, { visible: on ? 1 : 0 }); }

    drop(ref) {
        if (this._layers.delete(ref) && this.ready) this._send({ op: 'drop', ref });
    }
}

module.exports = { ClusterRender, DEFAULT_PATH };
