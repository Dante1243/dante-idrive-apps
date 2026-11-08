'use strict';

// Warm-Up's reader for the DME's own exhaust temperatures (apps/warmup/dme_exhaust.js), against a
// fake reader: how often it asks, when it gives up, what counts as fresh. No car needed:
//   node kit/tools/test_dme_exhaust.js

const assert = require('assert');
const path = require('path');
const { DmeExhaust, CAT, AFTER, POLL_MS, RETRY_MS, FRESH_MS } = require(path.join(__dirname, '..', '..', 'apps', 'warmup', 'dme_exhaust.js'));
const { check } = require(path.join(__dirname, '..', 'runtime', 'readonly-diag.js'));

const tick = () => new Promise((r) => setImmediate(r));
function fake(values) {
    const asked = [];
    return { asked, value: (name, list) => { asked.push(name); return Promise.resolve(values[name] === undefined ? null : values[name]); } };
}

const checks = [
    ['every request it can make passes the read-only check', () => {
        for (const c of CAT.concat(AFTER)) {
            if (c.obd) check(0x12, 0x01, [parseInt(c.obd, 16)], false);
            else check(0x12, 0x22, [parseInt(c.did.slice(0, 2), 16), parseInt(c.did.slice(2), 16)], false);
        }
    }],
    ['decodes like Live Data: catalyst 0.1 C -40, after-catalyst signed 0.1 K', () => {
        const dec = (c, bytes) => { let raw = 0; bytes.forEach((b) => { raw = raw * 256 + b; }); if (c.signed && raw >= 32768) raw -= 65536; return raw * c.factor + c.offset; };
        assert(Math.abs(dec(CAT[0], [0x1F, 0x40]) - 760) < 0.01);              // 8000 * 0.1 - 40
        assert(Math.abs(dec(AFTER[0], [0x2A, 0x30]) - 806.86) < 0.01);         // 10800 * 0.1 - 273.14
        assert(Math.abs(dec(AFTER[0], [0xFF, 0x9C]) - -283.14) < 0.01);        // signed: -100 * 0.1 - 273.14
    }],
    ['asks about once a second while the engine runs, never twice at once, not at all when off', async () => {
        const rd = fake({ cat: 640, after: 600 }), dme = new DmeExhaust({ reader: rd });
        dme.tick(false, 0); await tick();
        assert.strictEqual(rd.asked.length, 0);
        dme.tick(true, 0); dme.tick(true, 10); await tick(); await tick();
        assert.deepStrictEqual(rd.asked, ['cat', 'after']);
        dme.tick(true, POLL_MS - 1); await tick();
        assert.strictEqual(rd.asked.length, 2);
        dme.tick(true, POLL_MS); await tick(); await tick();
        assert.strictEqual(rd.asked.length, 4);
        assert.strictEqual(dme.state, 'reading');
    }],
    ['fresh only for a few seconds', async () => {
        const dme = new DmeExhaust({ reader: fake({ cat: 640 }) });
        dme.tick(true, 1000); await tick(); await tick();
        assert.deepStrictEqual(dme.fresh(1000 + FRESH_MS), { cat: 640, after: null });
        assert.deepStrictEqual(dme.fresh(1001 + FRESH_MS), { cat: null, after: null });
    }],
    ['a DME that never answers is asked only every 30 s', async () => {
        const rd = fake({}), dme = new DmeExhaust({ reader: rd });
        let t = 0;
        for (let i = 0; i < 5; i++) { dme.tick(true, t); await tick(); await tick(); t += POLL_MS; }
        assert.strictEqual(dme.state, 'no answer');
        const n = rd.asked.length;
        dme.tick(true, t); await tick();
        assert.strictEqual(rd.asked.length, n, 'asked again after a second');
        dme.tick(true, t - POLL_MS + RETRY_MS); await tick(); await tick();
        assert.strictEqual(rd.asked.length, n + 2);
    }],
];

(async () => {
    let failed = 0;
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); }
    }
    if (failed) { console.error(failed + ' of ' + checks.length + ' failed'); process.exit(1); }
    console.log('DME exhaust reader checks passed (' + checks.length + ').');
})();
