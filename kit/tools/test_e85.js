'use strict';

// E85 Blend: the mixing maths, the guided fill at the pump, booking fills, and where the tank's
// litres come from. No SDK or vehicle needed:
//   node kit/tools/test_e85.js

const assert = require('assert');
const path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'e85');
const { mix, topUp, fullTank, Book } = require(path.join(APP, 'blend.js'));
const { Tank, LEFT, RIGHT, WHOLE } = require(path.join(APP, 'tank.js'));
const { check } = require(path.join(__dirname, '..', 'runtime', 'readonly-diag.js'));

const near = (got, want, tol, what) => assert(Math.abs(got - want) <= tol, what + ': got ' + got + ', want ' + want);
const F = { E85: 0.85, 98: 0, E10: 0.10 };
const tick = () => new Promise((r) => setImmediate(r));

const checks = [
    ['mixing: 30 l of E0 and 10 l of E85 is E21.25', () => {
        near(mix(30, 0, 10, 0.85), 0.2125, 1e-9, 'mix');
        near(mix(0, 0.5, 20, 0.85), 0.85, 1e-9, 'into an empty tank');
    }],
    ['top up with E85 lands exactly on target', () => {
        const r = topUp(20, 0, 0.30, 0.85, 0, 59);
        assert.strictEqual(r.kind, 'add'); assert.strictEqual(r.fuel, 'E85');
        near(mix(20, 0, r.litres, 0.85), 0.30, 1e-9, 'after');
        near(r.litres, 10.909, 0.001, 'litres');
    }],
    ['over target: top up with 98', () => {
        const r = topUp(30, 0.40, 0.10, 0.85, 0, 59);
        assert.strictEqual(r.fuel, '98');
        assert.strictEqual(r.kind, 'nofit');      // 90 l would do it: more than the tank takes
        near(r.need, 90, 1e-9, 'need'); near(r.litres, 29, 1e-9, 'what fits');
        near(r.after, mix(30, 0.40, 29, 0), 1e-9, 'where a full tank of 98 lands');
        const ok = topUp(30, 0.15, 0.10, 0.85, 0, 59);
        assert.strictEqual(ok.kind, 'add'); near(ok.litres, 15, 1e-9, '98 litres');
    }],
    ['on target, impossible targets, empty tank', () => {
        assert.strictEqual(topUp(30, 0.30, 0.30, 0.85, 0, 59).kind, 'on');
        assert.strictEqual(topUp(30, 0.10, 0.90, 0.85, 0, 59).kind, 'never');     // above E85's own content
        assert.strictEqual(topUp(30, 0.10, 0, 0.85, 0, 59).kind, 'never');        // 98 never reaches E0 exactly
        assert.strictEqual(topUp(0, 0, 0.3, 0.85, 0, 59).kind, 'empty');
    }],
    ['full tank: both fuels fill it and land on target', () => {
        const r = fullTank(15, 0.10, 0.30, 0.85, 0, 59);
        assert(r.reach);
        near(r.e85 + r.p98, 44, 1e-9, 'fills the space');
        near((15 * 0.10 + r.e85 * 0.85) / 59, 0.30, 1e-9, 'lands on target');
        const lowT = fullTank(40, 0.60, 0.10, 0.85, 0, 59);
        assert(!lowT.reach && lowT.e85 === 0); near(lowT.after, 40 * 0.6 / 59, 1e-9, 'all 98 still above');
        const hiT = fullTank(40, 0, 0.80, 0.85, 0, 59);
        assert(!hiT.reach && hiT.p98 === 0);
    }],
    ['at the pump, 98 first: the pump runs over, the E85 fills what is left and lands just under', () => {
        const b = new Book({ e: 0.10, known: true });
        const s1 = b.start('full', ['98', 'E85'], 15, 0.30, F, 59);
        assert.strictEqual(s1.fuel, '98'); assert.strictEqual(s1.of, 2);
        const s2 = b.done(s1.litres + 0.6);                 // ran over by 0.6 l
        assert.strictEqual(s2.fuel, 'E85');
        near(15 + s1.litres + 0.6 + s2.litres, 59, 1e-9, 'fills the tank, no further');
        assert.strictEqual(b.done(s2.litres), null);
        assert(b.e < 0.30, 'over target');
        near(b.e, 0.30, 0.01, 'tank after');               // 0.6 l over on 59 l: under a percent
        assert.strictEqual(b.log.length, 2);
        assert.strictEqual(b.last.poured.length, 2);
    }],
    ['at the pump, a short first pour is made good: more of the second, still on target', () => {
        const b = new Book({ e: 0.10, known: true });
        const s1 = b.start('full', ['E85', '98'], 15, 0.30, F, 59);
        const s2 = b.done(s1.litres - 1);                   // stopped a litre short of the E85
        b.done(s2.litres);
        near(b.e, 0.30, 1e-6, 'still on target');
        assert(b.last.v < 59, 'a little room left, which is fine');
    }],
    ['at the pump, E85 first, and pouring exactly the plan lands on target', () => {
        const b = new Book({ e: 0, known: true });
        const s1 = b.start('full', ['E85', '98'], 10, 0.30, F, 59);
        assert.strictEqual(s1.fuel, 'E85');
        const s2 = b.done(s1.litres);
        assert.strictEqual(s2.fuel, '98');
        b.done(s2.litres);
        near(b.e, 0.30, 1e-6, 'tank after');
        near(b.last.v, 59, 1e-6, 'full');
    }],
    ['top up is one step of one fuel', () => {
        const b = new Book({ e: 0.05, known: true });
        const s = b.start('top', ['98', 'E85'], 30, 0.20, F, 59);
        assert.deepStrictEqual([s.fuel, s.n, s.of], ['E85', 1, 1]);
        assert.strictEqual(b.done(s.litres), null);
        near(b.e, 0.20, 1e-6, 'tank after');
        assert.strictEqual(new Book({ e: 0.2 }).start('top', ['98', 'E85'], 30, 0.20, F, 59), null);
    }],
    ['a full tank that needs only one fuel skips the other', () => {
        const b = new Book({ e: 0.85, known: true });
        const s = b.start('full', ['E85', '98'], 50, 0.85, F, 59);
        assert.strictEqual(s.fuel, 'E85'); assert.strictEqual(s.n, 1);
        assert.strictEqual(b.done(s.litres), null);
    }],
    ['a fill booked by hand: the tank after comes from the car, the litres from the pump', () => {
        const b = new Book({ e: 0.30, known: true });
        const e = b.refuel({ fuel: '98', litres: 20, vAfter: 50, eFuel: 0 });
        near(e, 30 * 0.30 / 50, 1e-9, 'after');
        assert(b.known);
        assert.strictEqual(b.log[0].fuel, '98');
        const json = JSON.parse(JSON.stringify(b));
        const again = new Book(json);
        near(again.e, e, 1e-12, 'saved and loaded');
    }],
    ['a guided fill survives the app closing at the pump', () => {
        const b = new Book({ e: 0, known: true });
        const s1 = b.start('full', ['98', 'E85'], 10, 0.30, F, 59);
        const b2 = new Book(JSON.parse(JSON.stringify(b)));
        assert.deepStrictEqual(b2.step(), s1);
        assert(b2.done(s1.litres).fuel === 'E85');
    }],
    ['a fill the car measures: level before, Done, booked once it settles higher', () => {
        const b = new Book({ e: 0.30, known: true });
        b.trackStart('98', 20.5);
        assert.strictEqual(b.trackFeed({ v: 32, settled: true }, 0), null, 'booked before Done filling');
        b.trackDone();
        assert.strictEqual(b.trackFeed({ v: 40, settled: false }, 0), null, 'booked while still moving');
        assert.strictEqual(b.trackFeed({ v: 21, settled: true }, 0), null, 'booked a gauge that has not caught up');
        const res = b.trackFeed({ v: 45.5, settled: true }, 0);
        assert(res && res.booked.measured);
        near(res.booked.litres, 25, 1e-9, 'litres');
        near(b.e, 20.5 * 0.30 / 45.5, 1e-9, 'tank after');
        assert.strictEqual(b.track, null);
        assert.strictEqual(b.trackFeed({ v: 50, settled: true }, 0), null, 'booked twice');
    }],
    ['a measured fill survives the app closing between Start and Done', () => {
        const b = new Book({ e: 0, known: true });
        b.trackStart('E85', 10);
        const b2 = new Book(JSON.parse(JSON.stringify(b)));
        b2.trackDone();
        near(b2.trackFeed({ v: 30, settled: true }, 0.85).booked.eAfter, 20 * 0.85 / 30, 1e-9, 'after');
    }],
    ['undo takes the last fill back out, and a reset too', () => {
        const b = new Book({ e: 0.1, known: false });
        b.refuel({ fuel: 'E85', litres: 10, vAfter: 40, eFuel: 0.85 });
        b.undo();
        near(b.e, 0.1, 1e-12, 'after undoing the fill');
        assert.strictEqual(b.log.length, 0);
        b.reset(0.85);
        b.undo();
        assert.strictEqual(b.e, 0.1); assert.strictEqual(b.known, false);
        assert.strictEqual(b.undo(), null);
    }],
    ['the tank reads only, and the halves are 0.5 l', () => {
        for (const c of LEFT.concat(RIGHT, WHOLE)) check(0x12, 0x22, [parseInt(c.did.slice(0, 2), 16), parseInt(c.did.slice(2), 16)], false);
        assert.strictEqual(LEFT[0].factor, 0.5); assert.strictEqual(RIGHT[0].factor, 0.5);
    }],
    ['the tank: both halves added up; else the whole; median of the last readings', async () => {
        let vals = { left: 15.5, right: 16 };
        const reader = { value: (n) => Promise.resolve(vals[n] === undefined ? null : vals[n]) };
        const tank = new Tank({ reader });
        for (let i = 0; i < 4; i++) { tank.tick(1000 + i * 2000); await tick(); await tick(); await tick(); tank.now(1000 + i * 2000); }
        const r = tank.now(7000);
        assert.deepStrictEqual([r.v, r.src, r.settled], [31.5, 'dme', true]);
        vals = { whole: 30 };
        tank.tick(9000); await tick(); await tick(); await tick(); await tick();
        const w = tank.now(9000);
        assert.deepStrictEqual([w.v, w.src, w.settled], [30, 'dme1', false]);
    }],
    ['no DME: the cluster gauge; nothing fresh: null', () => {
        const tank = new Tank({ reader: { value: () => Promise.resolve(null) } });
        assert.strictEqual(tank.now(Date.now()), null);
        tank.kombi = { v: 41, at: 5000 };
        assert.deepStrictEqual(tank.now(6000), { v: 41, src: 'kombi', settled: false });
        assert.strictEqual(tank.now(20000), null);
    }],
];

(async () => {
    let failed = 0;
    for (const [name, fn] of checks) {
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); }
    }
    if (failed) { console.error(failed + ' of ' + checks.length + ' failed'); process.exit(1); }
    console.log('E85 Blend checks passed (' + checks.length + ').');
})();
