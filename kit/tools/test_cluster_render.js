'use strict';

// kit/cluster_render.js and Warm-Up's badge against a stand-in for the cluster-render service, on
// its real wire format (PROTOCOL.md: u32 length, u8 type, body). No SDK or vehicle needed:
//   node kit/tools/test_cluster_render.js

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const { ClusterRender } = require(path.join(KIT, 'cluster_render.js'));
const { ClusterBadge, cardPixels } = require(path.join(ROOT, 'apps', 'warmup', 'cluster_badge.js'));

const T_JSON = 0x4A, T_FRAME = 0x46;
let seq = 0;
const socketPath = () => (process.platform === 'win32' ? '\\\\.\\pipe\\cr-test-' + process.pid + '-' + (++seq) : path.join(os.tmpdir(), 'cr-test-' + process.pid + '-' + (++seq)));

/** The service's side: reads messages, answers hello and status, and keeps what it was sent. */
class Service {
    constructor(p) {
        this.path = p; this.json = []; this.frames = []; this.socks = [];
        this.server = net.createServer((s) => this._conn(s));
    }
    listen() { return new Promise((r) => this.server.listen(this.path, r)); }
    _conn(s) {
        this.socks.push(s);
        let rx = Buffer.alloc(0);
        s.on('error', () => {});
        s.on('data', (b) => {
            rx = Buffer.concat([rx, b]);
            while (rx.length >= 4) {
                const len = rx.readUInt32LE(0);
                if (rx.length < 4 + len) return;
                const type = rx.readUInt8(4), body = rx.subarray(5, 4 + len);
                rx = rx.subarray(4 + len);
                if (type === T_JSON) this._json(s, JSON.parse(body.toString('utf8')));
                if (type === T_FRAME) this.frames.push({ ref: body.readUInt32LE(0), rects: body.readUInt16LE(12), bytes: body.length - 14 });
            }
        });
    }
    _json(s, m) {
        this.json.push(m);
        if (m.op === 'hello') this.send(s, { ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
        if (m.op === 'status') this.send(s, { ev: 'status', text: 'target panel: slot 0x203 scene 0x1000400 1920x720: shown (us); verified\n' });
    }
    send(s, o) {
        const b = Buffer.from(JSON.stringify(o)), h = Buffer.alloc(5);
        h.writeUInt32LE(b.length + 1, 0); h.writeUInt8(T_JSON, 4);
        s.write(Buffer.concat([h, b]));
    }
    all(o) { this.socks.forEach((s) => { if (!s.destroyed) this.send(s, o); }); }
    /** the service restarting under its clients: Slot Lab does this on every trial */
    drop() { this.socks.forEach((s) => s.destroy()); this.socks = []; this.json = []; this.frames = []; }
    close() { this.drop(); return new Promise((r) => this.server.close(r)); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
    for (let i = 0; i < 400; i++) { if (fn()) return; await wait(15); }
    assert.fail('timed out: ' + what);
}
const quiet = { info() {}, warn() {} };

const checks = [
    ['hello, then ready with the targets', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const c = new ClusterRender('t', p);
        let ready = null;
        c.on('ready', (b, t) => { ready = [b, t]; });
        c.connect();
        await until(() => ready, 'ready');
        assert.strictEqual(ready[0], 'id7');
        assert(/panel:1920x720/.test(ready[1]));
        assert.strictEqual(sv.json[0].proto, 1);
        c.close(); await sv.close();
    }],
    ['status comes back as text', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const c = new ClusterRender('t', p);
        let text = null;
        c.on('status', (s) => { text = s; });
        assert.strictEqual(c.status(), false, 'not connected yet');
        c.connect();
        await until(() => c.ready, 'ready');
        c.status();
        await until(() => text, 'status');
        assert(/slot 0x203/.test(text));
        c.close(); await sv.close();
    }],
    ['target events name the target (they carry it as `target`)', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const c = new ClusterRender('t', p);
        let got = null;
        c.on('target', (name, state, ev) => { got = [name, state, ev.holder]; });
        c.connect();
        await until(() => c.ready, 'ready');
        sv.all({ ev: 'target', target: 'panel', state: 'parked', holder: 'stock' });
        await until(() => got, 'target');
        assert.deepStrictEqual(got, ['panel', 'parked', 'stock']);
        c.close(); await sv.close();
    }],
    ['a refusal with nobody listening does not bring the app down', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const c = new ClusterRender('t', p);
        c.connect();
        await until(() => c.ready, 'ready');
        sv.all({ ev: 'error', op: 'layer', reason: 'no' });
        await wait(60);
        assert(c.ready);
        c.close(); await sv.close();
    }],
    ['the icon: a layer of the right size at the right spot, whole-image pixels', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const b = new ClusterBadge({ app: 't', x: 1670, y: 620, size: 90, log: quiet, socket: p });
        await until(() => sv.json.some((m) => m.op === 'layer'), 'layer');
        const l = sv.json.find((m) => m.op === 'layer');
        assert.deepStrictEqual([l.target, l.kind, l.x, l.y, l.w, l.h, l.iw, l.ih, l.visible], ['panel', 'image', 1670, 620, 90, 90, 90, 90, 0]);
        assert(!('contend' in l), 'contend would take the slot from stock content');
        b.setState('cold');
        await until(() => sv.frames.length, 'pixels');
        assert.deepStrictEqual([sv.frames[0].rects, sv.frames[0].bytes], [0, 90 * 90 * 4]);
        assert(sv.json.some((m) => m.op === 'set' && m.visible === 1), 'shown');
        b.setState('off');
        await until(() => sv.json.some((m) => m.op === 'set' && m.visible === 0), 'hidden');
        b.close(); await sv.close();
    }],
    ['the test card: over the whole target, a quarter size, see-through, and gone again', async () => {
        const px = cardPixels();
        assert.strictEqual(px.length, 480 * 180 * 4);
        assert(px[3] > 0 && px[3] < 255, 'see-through');
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const b = new ClusterBadge({ app: 't', size: 90, log: quiet, socket: p });
        await until(() => sv.json.some((m) => m.op === 'layer'), 'layer');
        b.setTestCard(true);
        await until(() => sv.json.filter((m) => m.op === 'layer').length === 2, 'card layer');
        const l = sv.json.filter((m) => m.op === 'layer')[1];
        assert.deepStrictEqual([l.x, l.y, l.w, l.h, l.iw, l.ih, l.sampling], [0, 0, 1920, 720, 480, 180, 'nearest']);
        await until(() => sv.frames.some((f) => f.bytes === px.length), 'card pixels');
        b.setTestCard(false);
        await until(() => sv.json.some((m) => m.op === 'drop' && m.ref === l.ref), 'card dropped');
        b.close(); await sv.close();
    }],
    ['the service restarting (what a Slot Lab trial does): icon and card come back with their pixels', async () => {
        const p = socketPath(), sv = new Service(p); await sv.listen();
        const b = new ClusterBadge({ app: 't', size: 90, log: quiet, socket: p });
        await until(() => sv.json.some((m) => m.op === 'layer'), 'layer');
        b.setState('hot'); b.setTestCard(true);
        await until(() => sv.frames.length >= 2, 'pixels');
        sv.drop();
        await until(() => sv.json.filter((m) => m.op === 'layer').length === 2, 'layers again');
        await until(() => sv.frames.some((f) => f.bytes === 90 * 90 * 4) && sv.frames.some((f) => f.bytes === 480 * 180 * 4), 'pixels again');
        b.close(); await sv.close();
    }],
    ['no service: every call is a quiet no-op, and it keeps trying', async () => {
        const b = new ClusterBadge({ app: 't', size: 90, log: quiet, socket: socketPath() });
        b.setState('cold'); b.setTestCard(true); b.setGeometry(100, 100, 90); b.setState('off'); b.setTestCard(false);
        await wait(50);
        b.close();
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed.push(name); console.error('FAIL ' + name + '\n     ' + e.message); }
    }
    if (failed.length) process.exit(1);
    console.log('cluster-render client checks passed (' + checks.length + ').');
    process.exit(0);
})();
