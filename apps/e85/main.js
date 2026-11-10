'use strict';
/**
 * E85 Blend - what ethanol content is in the tank, and what to pump to hit a target.
 *
 *   Setup (first start, and Setup on Refuels): tank size, the fuels at your pump, your tune's safe
 *   limit, the range you want, and what is in the tank now
 *
 *   Blend page
 *   - the tank: litres from the car (tank.js: the engine unit's whole-tank level, else the
 *     cluster's gauge), and the ethanol content book-kept from every fill (blend.js)
 *   - the ethanol bar: grey under the range you want, blue in it, amber over it, red past the safe
 *     limit of your tune; the big figure takes the colour of where the tank is
 *   - the target (E0 up to the safe limit): a top-up (one fuel, as little as gets there) and a full
 *     tank (both fuels)
 *   - at the pump: Top up / Full, 98 first / Full, E85 first. It says what to pump and where the safe
 *     limit is; Done (with the pump's figure, +/- if it ran over) books it, and the next fuel is
 *     worked out again from what actually went in
 *   - the tank size, checked against the car: after a full tank, or when the car reads more
 *
 *   Refuels page
 *   - Start filling 98 / E85 / E10: the car measures the fill (the tank's litres before, and once Done
 *     filling has settled, after), and books it by itself
 *   - or the pump's litres, for a fill the car did not see (it offers the rise it saw in the tank)
 *   - the price a litre of each fuel: every fill's cost, l/100 km and cost per 100 km from the
 *     odometer, and the last 30 days' spend
 *   - every fill with the tank's content before and after, Undo last, and "all 98 / E85" to start over
 *
 * No ethanol sensor: the content is only as right as the fills booked. Driving does not change it.
 * Saved in data/e85.json.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { mix, topUp, fullTank, Book, limits, zone, maxBeforeSafe, usage } = require('./blend');
const { Tank } = require('./tank');

const W = 1600, H = 520;
const GO = '#2fd27a', ETH = '#2a8cff', GREY = '#6f7a88';
const PAGES = ['Blend', 'Refuels'];
const FUELS = ['98', 'E85', 'E10'];
const RISE_L = 3;                    // the tank this much fuller than last seen: a fill to log
const DEMO_AFTER_MS = 6000;          // demo "auto": no tank reading this long
const STEPS5 = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85];
const TANKS = [40, 50, 52, 57, 59, 60, 63, 66, 68, 74];
const SETUP = ['Your tank', 'Your fuels', 'Your tune', 'What you want', 'In the tank now'];
const TUNES = [
    { label: 'Stock tune, E30', safe: 30, min: 20, max: 30 },
    { label: 'Tuned for E40', safe: 40, min: 30, max: 40 },
    { label: 'Tuned for E50', safe: 50, min: 40, max: 50 },
    { label: 'Tuned for E85', safe: 85, min: 60, max: 85 },
];
const PRICE0 = { 98: 2.00, E85: 1.60, E10: 1.90 };   // where +/- starts from when no price is set
const FULL_CHECK_MS = 20000, FULL_CHECK_UNTIL = 15 * 60000;

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const FILE = ctx.dataDir ? path.join(ctx.dataDir, 'e85.json') : null;
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* first start */ }
        const real = { book: new Book(saved.book), lastV: typeof saved.lastV === 'number' ? saved.lastV : null };
        const demo = { book: new Book({ e: 0.12, known: true }), lastV: 31.5, v: 31.5, km: 23817 };
        const prices = Object.assign({}, saved.prices || {});
        let setupDone = !!saved.setup;
        let maxSeen = typeof saved.maxSeen === 'number' ? saved.maxSeen : 0;
        let noSize = typeof saved.noSize === 'number' ? saved.noSize : null;
        const save = () => {
            if (!FILE) return;
            try { fs.writeFileSync(FILE, JSON.stringify({ book: real.book, lastV: real.lastV, setup: setupDone, prices, maxSeen, noSize })); } catch (e) { log.warn('save: ' + e); }
        };

        const tank = new Tank({ signals: ctx.signals, log });
        const startedAt = Date.now();

        /* ---------- what the app works with ---------- */
        const ef = (fuel) => (fuel === 'E85' ? settings.get('e85Pct') : fuel === 'E10' ? 10 : settings.get('petrolPct')) / 100;
        const fuels = () => ({ E85: ef('E85'), 98: ef('98'), E10: ef('E10') });
        const cap = () => settings.get('tankL');
        const lim = () => limits(settings.get('eMin'), settings.get('eMax'), settings.get('eSafe'));
        // the target never goes past the safe limit
        const target = () => Math.min(settings.get('target') / 100, lim().safe);
        function demoOn(now) {
            const m = settings.get('demo');
            return m === 'on' || (m === 'auto' && !tank.now(now) && now - startedAt > DEMO_AFTER_MS);
        }
        /** { s: real or demo store, v: litres or null, src, settled, demo, km } */
        function read(now) {
            if (demoOn(now)) return { s: demo, v: demo.v, src: 'demo', settled: true, demo: true, km: demo.km };
            const r = tank.now(now);
            return { s: real, v: r ? r.v : null, src: r ? r.src : null, settled: !!(r && r.settled), demo: false, km: tank.odo,
                dme: r ? r.dme : null, kombi: r ? r.kombi : null, ignored: r ? r.ignored : null };
        }
        /** What goes in the log with a fill of fuel: its price a litre and the odometer. */
        const extra = (r) => (fuel) => ({ price: prices[fuel], km: r.km });

        // the tank going up by itself is a fill to log; going down (driving) just moves the mark
        function watchLevel(now) {
            const r = read(now);
            if (r.demo || !r.settled || r.s.book.fill || r.s.book.track) return;
            if (r.s.lastV === null || r.v < r.s.lastV) { r.s.lastV = r.v; save(); }
        }
        // (not while a fill is being made here: that one books itself)
        const rise = (r) => (!r.s.book.track && !r.s.book.fill && r.v !== null && r.s.lastV !== null && r.v - r.s.lastV >= RISE_L ? r.v - r.s.lastV : 0);

        /* ---------- messages ---------- */
        let msg = null, msgUntil = 0, msgCrit = false;
        const say = (m, crit) => { msg = m; msgUntil = Date.now() + (crit ? 10000 : 6000); msgCrit = !!crit; };
        /** After a fill: the tank's new content, and a loud warning past the safe limit. */
        function booked(text, e) {
            const L = lim(), bad = zone(e, L) === 'unsafe';
            say(text + ': tank now ' + E(e) + (bad ? ', OVER your ' + E(L.safe) + ' limit' : ''), bad);
        }

        /* ---------- the guided fill ---------- */
        let poured = null;            // the Done figure: starts at the plan, +/- to the pump's
        let fullAt = null;            // a full tank was just poured here: check the tank size against the car
        function startFill(kind, order) {
            const now = Date.now(), r = read(now);
            if (r.v === null) { say('No tank reading yet'); return render(); }
            r.s.book.last = null;
            const st = r.s.book.start(kind, order, r.v, target(), fuels(), Math.max(cap(), r.v));
            poured = st ? round1(st.litres) : null;
            if (!st) say(kind === 'top' ? 'Nothing to add: on target' : 'Nothing to add');
            if (!r.demo) save();
            return render();
        }
        function done() {
            const r = read(Date.now()), b = r.s.book, st = b.step();
            if (!st) return render();
            const next = b.done(poured === null ? st.litres : poured, extra(r));
            poured = next ? round1(next.litres) : null;
            // what is in the tank now, by the pours: the mark the gauge is compared with, so its catching
            // up later is not taken for another fill
            const v = b.fill ? b.fill.v : b.last ? b.last.v : null;
            if (v !== null) r.s.lastV = v;
            if (!next && b.last) {
                if (zone(b.e, lim()) === 'unsafe') booked('Done', b.e);
                if (b.last.kind === 'full' && !r.demo) fullAt = Date.now();
            }
            if (r.demo) { if (v !== null) demo.v = v; } else save();
            return render();
        }
        function cancel() { const r = read(Date.now()); r.s.book.cancel(); poured = null; if (!r.demo) save(); return render(); }
        const nudge = (d) => () => { if (poured !== null) poured = Math.max(0, round1(poured + d)); return render(); };
        function stepTarget(d) {
            const safe = settings.get('eSafe'), want = settings.get('target') + d;
            if (d > 0 && want > safe) say('The target stops at your safe limit, E' + safe + ' (Setup)');
            settings.set('target', Math.max(0, Math.min(85, safe, want)));
            return render();
        }

        /* ---------- logging a fill by hand ---------- */
        let logFuel = '98', logL = null;
        function saveLog() {
            const r = read(Date.now()), L = logL === null ? round1(rise(r)) : logL;
            if (!(L > 0)) { say('Set the litres first'); return render(); }
            const vAfter = r.v !== null ? Math.max(r.v, L) : (r.s.lastV || 0) + L;
            const e = r.s.book.refuel(Object.assign(extra(r)(logFuel), { fuel: logFuel, litres: L, vAfter, eFuel: ef(logFuel) }));
            r.s.lastV = vAfter; logL = null;
            booked('Booked ' + L.toFixed(1) + ' l of ' + logFuel, e);
            if (!r.demo) save();
            return render();
        }
        function nudgePrice(d) {
            return () => {
                const p = typeof prices[logFuel] === 'number' ? prices[logFuel] : PRICE0[logFuel];
                prices[logFuel] = Math.max(0.5, Math.round((p + d) * 100) / 100);
                save();
                return render();
            };
        }
        /* ---------- a fill the car measures ---------- */
        function trackStart() {
            const r = read(Date.now());
            if (r.v === null) { say('No tank reading yet'); return render(); }
            r.s.book.trackStart(logFuel, r.v);
            if (!r.demo) save();
            return render();
        }
        function trackDone() { const r = read(Date.now()); r.s.book.trackDone(); if (!r.demo) save(); return render(); }
        function trackCancel() { const r = read(Date.now()); r.s.book.trackCancel(); if (!r.demo) save(); return render(); }
        /** Each reading: a finished measured fill is booked once the level has settled higher. */
        function trackTick(now) {
            const r = read(now), k = r.s.book.track;
            if (!k) return;
            if (r.demo && !k.done) demo.v = Math.min(cap(), demo.v + 0.25);       // the demo pump runs at 0.5 l/s
            const res = r.s.book.trackFeed({ v: r.v, settled: r.settled }, ef(k.fuel), extra(r)(k.fuel));
            if (!res) return;
            r.s.lastV = r.v;
            if (!r.demo) save();
            booked('Booked ' + res.booked.litres.toFixed(1) + ' l of ' + res.booked.fuel, res.booked.eAfter);
            render();
        }
        function undo() {
            const r = read(Date.now()), x = r.s.book.undo();
            if (!x) return render();
            if (!r.demo) save();
            say(x.reset ? 'Took back the reset: tank ' + E(r.s.book.e) : 'Took back ' + x.litres.toFixed(1) + ' l of ' + x.fuel + ': tank ' + E(r.s.book.e));
            return render();
        }
        function setAll(fuel) { return () => { const r = read(Date.now()); r.s.book.reset(ef(fuel)); if (r.v !== null) r.s.lastV = r.v; if (!r.demo) save(); say('Tank set to all ' + fuel); return render(); }; }

        /* ---------- the tank size, checked against the car ---------- */
        let sizeOffer = null;         // { v, why: 'full' | 'seen' }
        function sizeTick(now) {
            const r = read(now);
            if (r.demo || !r.settled || r.v === null) return;
            if (r.v > maxSeen + 0.4) { maxSeen = r.v; save(); }
            if (fullAt && now - fullAt >= FULL_CHECK_MS) {
                // a full tank, poured here, has settled: what the car reads now is the tank's size
                const v = Math.round(r.v);
                if (now - fullAt <= FULL_CHECK_UNTIL && Math.abs(v - cap()) >= 2 && v >= cap() * 0.6) { sizeOffer = { v, why: 'full' }; render(); }
                fullAt = null;
            }
        }
        function offer() {
            if (sizeOffer && sizeOffer.v !== noSize && sizeOffer.v !== cap()) return sizeOffer;
            const m = Math.round(maxSeen);
            if (m > cap() + 1 && m !== noSize) return { v: m, why: 'seen' };
            return null;
        }
        function setSize(v) { return () => { settings.set('tankL', v); sizeOffer = null; noSize = null; save(); say('Tank size set to ' + v + ' l'); return render(); }; }
        function keepSize(v) { return () => { noSize = v; sizeOffer = null; save(); return render(); }; }

        /* ---------- setup ---------- */
        let setup = setupDone ? null : 0;      // the setup step shown, or null
        let setupE = null;                    // in the tank now: 'keep', 'unsure' or a percentage
        function openSetup() { setup = 0; setupE = real.book.known ? 'keep' : 'unsure'; return render(); }
        if (setup !== null) setupE = real.book.known ? 'keep' : 'unsure';
        function finishSetup(skip) {
            return () => {
                if (!skip) {
                    if (typeof setupE === 'number') { real.book.reset(setupE / 100); const r = read(Date.now()); if (!r.demo && r.v !== null) real.lastV = r.v; }
                    else if (setupE === 'unsure') { if (!real.book.log.length) real.book.e = ef('98'); real.book.known = false; }
                    say('All set. Change any of it in Settings, or Setup on Refuels');
                }
                setupDone = true; setup = null; page = 0;
                save();
                return render();
            };
        }
        /** Settings that hang together: the range under the safe limit, the target in the range. */
        function setLimits(o) {
            const safe = o.safe !== undefined ? o.safe : settings.get('eSafe');
            let min = o.min !== undefined ? o.min : settings.get('eMin'), max = o.max !== undefined ? o.max : settings.get('eMax');
            max = Math.min(max, safe);
            if (o.min !== undefined && min > max) max = Math.min(min, safe);
            min = Math.min(min, max);
            [['eSafe', safe], ['eMax', max], ['eMin', min]].forEach(([k, v]) => { if (settings.get(k) !== v) settings.set(k, v); });
            const tg = settings.get('target');
            if (o.target !== undefined) settings.set('target', o.target);
            else if (tg > max || tg < min) settings.set('target', max);
        }

        /* ---------- format ---------- */
        const E = (e) => 'E' + pctText(e * 100);
        const P = (f) => Math.round(f * 100);
        const L1 = (v) => (v === null || v === undefined ? '--' : v.toFixed(1) + ' l');
        const $ = (x) => '$' + x.toFixed(2);
        const range = (L) => (P(L.min) === P(L.max) ? 'E' + P(L.max) : 'E' + P(L.min) + '-' + P(L.max));
        const SRC = { dme1: 'engine unit, whole tank', kombi: 'cluster gauge, 1 l', demo: 'demo' };
        const when = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
        const crit = (t) => t.crit || '#ef2b2d';
        /** The colour of where e sits: grey under the range, blue in it, amber over it, red past the limit. */
        const zoneCol = (t, z) => (z === 'unsafe' ? crit(t) : z === 'over' ? t.warn : z === 'ok' ? ETH : GREY);

        /**
         * The ethanol bar, E0 up to the E85 at the pump: grey under the range wanted, blue in it, amber
         * over it, red past the safe limit (drawn last, over everything). The part up to e is lit; e null
         * draws the scale only.
         */
        function eBar(cv, t, x, y, w, h, e, L) {
            const top = Math.max(ef('E85'), L.safe + 0.05, e || 0);
            const X = (f) => x + w * Math.max(0, Math.min(1, f / top));
            const zones = [[0, L.min, GREY], [L.min, L.max, ETH], [L.max, L.safe, t.warn], [L.safe, top, crit(t)]];
            cv.roundRect(x, y, w, h, 6, withAlpha('#ffffff', 0.05));
            zones.forEach(([a, b, c]) => { if (b > a) cv.fillRect(X(a), y, X(b) - X(a), h, withAlpha(c, 0.22)); });
            if (e !== null && e !== undefined) zones.forEach(([a, b, c]) => { const to = Math.min(b, e); if (to > a) cv.fillRect(X(a), y, X(to) - X(a), h, c); });
            // the limit: a red line over everything, and the edges of the range
            [[L.min, GREY], [L.max, ETH]].forEach(([f, c]) => { if (f > 0 && f < L.safe) cv.fillRect(X(f) - 1, y - 4, 2, h + 8, withAlpha(c === GREY ? '#ffffff' : c, 0.8)); });
            cv.fillRect(X(L.safe) - 2, y - 6, 4, h + 12, crit(t));
            if (e !== null && e !== undefined) { cv.fillRect(X(e) - 3, y - 8, 6, h + 16, '#ffffff'); }
            cv.strokeRoundRect(x, y, w, h, 6, 1.5, withAlpha('#ffffff', 0.3));
            // labels under it, the limit's first; one that would run into a label drawn already is left out
            const labels = [[L.safe, 'E' + P(L.safe) + ' LIMIT', crit(t)]];
            if (P(L.max) !== P(L.safe)) labels.push([L.max, 'E' + P(L.max), ETH]);
            if (L.min > 0 && P(L.min) !== P(L.max)) labels.push([L.min, 'E' + P(L.min), t.dim]);
            const drawn = [];
            labels.forEach(([f, s, c]) => {
                const half = cv.textWidth(s, 18, { font: 'bold' }) / 2, cx = Math.max(x + half, Math.min(x + w - half, X(f)));
                if (drawn.some(([a, b]) => cx + half + 8 > a && cx - half - 8 < b)) return;
                cv.text(s, cx, y + h + 24, 18, c, { align: 'center', font: 'bold' });
                drawn.push([cx - half, cx + half]);
            });
        }

        /* ---------- Blend page ---------- */
        function drawTank(cv, t, r) {
            const p = G.panel(cv, t, 24, 44, 470, 468, 'Tank');
            const b = r.s.book, L = lim(), z = zone(b.e, L);
            cv.text('ETHANOL NOW', 48, 112, 22, t.dim, { font: 'bold', spacing: 1.5 });
            bigE(cv, b.e * 100, 48, 212, 100, zoneCol(t, z), t);
            let note = null, col = t.dim;
            if (z === 'unsafe') { note = 'OVER YOUR ' + E(L.safe) + ' SAFE LIMIT: add 98'; col = crit(t); }
            else if (!b.known) { note = 'assumed: log a fill or set it on Refuels'; col = t.warn; }
            else if (z === 'over') { note = 'over your ' + range(L) + ', under the limit'; col = t.warn; }
            else if (z === 'low') note = 'under your ' + range(L);
            else { note = 'in your ' + range(L); col = ETH; }
            cv.text(note, 48, 250, 20, col, { font: 'bold' });
            eBar(cv, t, 48, 268, 422, 38, b.e, L);
            // the tank's litres: a thin bar, petrol and ethanol share of what is in it
            const by = 348, c = Math.max(cap(), r.v || 0), fill = r.v === null ? 0 : r.v / c;
            cv.roundRect(48, by, 422, 12, 6, withAlpha('#ffffff', 0.06));
            if (fill > 0) {
                cv.roundRect(48, by, 422 * fill, 12, 6, withAlpha(t.text, 0.28));
                cv.roundRect(48, by, Math.max(2, 422 * fill * b.e), 12, 6, ETH);
            }
            cv.text(r.v === null ? 'no tank reading' : r.v.toFixed(1) + ' l of ' + cap() + ' l', 48, by + 50, 30, r.v === null ? t.dim : t.text, { font: 'bold' });
            if (r.v !== null) cv.text((r.v * b.e).toFixed(1) + ' l ethanol', 470, by + 50, 22, ETH, { align: 'right', font: 'bold' });
            const dy = p.y + p.h - G.BOTTOM;
            // both sources, so a wrong one can be told; a drop the engine cannot have made is held back
            const both = [r.dme !== null && r.dme !== undefined && 'engine ' + Math.round(r.dme) + ' l', r.kombi !== null && r.kombi !== undefined && 'gauge ' + Math.round(r.kombi) + ' l'].filter(Boolean).join(', ');
            const lv = r.ignored ? 'ignoring a drop to ' + Math.round(r.ignored.v) + ' l (' + (r.ignored.src === 'kombi' ? 'gauge' : 'engine') + ')'
                : r.src === 'demo' ? 'level: demo' : r.src ? 'level: ' + (both || SRC[r.src]) + (r.settled ? '' : ', settling') : 'waiting for the car';
            cv.text(lv, 48, 480 + G.toMargin(dy, 13), 20, r.ignored ? t.warn : t.dim, { font: r.ignored ? 'bold' : undefined });
        }

        function drawTarget(cv, t, r) {
            G.panel(cv, t, 518, 44, 620, 468, 'Target');
            const tg = target(), b = r.s.book, hi = ef('E85'), lo = ef('98'), L = lim();
            bigE(cv, Math.round(tg * 100), 542, 196, 96, zoneCol(t, zone(tg, L)), t);
            G.button(cv, t, 860, 120, 120, 60, '- 5', () => stepTarget(-5), { key: 'tdn' });
            G.button(cv, t, 994, 120, 120, 60, '+ 5', () => stepTarget(5), { key: 'tup', busy: settings.get('target') >= settings.get('eSafe') });
            const line = (y, label, text, col, small, smallCol) => {
                cv.text(label, 542, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(text, 542, y + 40, 32, col || t.text, { font: 'bold' });
                if (small) cv.text(small, 542, y + 72, 22, smallCol || t.dim);
            };
            if (r.v === null && !b.fill) { line(250, 'TOP UP', 'Waiting for the tank level', t.dim); return; }
            const st = b.step();
            if (st) {
                // a fill under way: where this step lands, worked out from what has gone in so far
                const q = poured === null ? st.litres : poured, v = b.fill.v + q, after = mix(b.fill.v, b.e, q, ef(st.fuel));
                // (a first fuel that goes past the limit is fine: the second brings it back down at the pump)
                const z = st.n < st.of ? 'ok' : zone(after, L);
                line(250, 'AFTER THIS STEP', v.toFixed(1) + ' l at ' + E(after), z === 'unsafe' ? crit(t) : t.text,
                    z === 'unsafe' ? 'OVER your ' + E(L.safe) + ' safe limit' : st.n < st.of ? 'the next fuel is worked out from what really went in' : '', z === 'unsafe' ? crit(t) : null);
                line(366, 'AIMING FOR', 'E' + Math.round(b.fill.target * 100) + (b.fill.kind === 'full' ? ', full tank' : ''), t.dim);
                return;
            }
            const u = topUp(r.v, b.e, tg, hi, lo, cap());
            if (u.kind === 'on') line(250, 'TOP UP', 'On target', GO);
            else if (u.kind === 'add') line(250, 'TOP UP', 'Add ' + u.litres.toFixed(1) + ' l of ' + u.fuel, t.text, 'then ' + u.total.toFixed(1) + ' l at ' + E(u.after));
            else if (u.kind === 'nofit') line(250, 'TOP UP', 'No room for the ' + u.need.toFixed(1) + ' l of ' + u.fuel + ' it needs', t.warn, 'filling up with it reaches ' + E(u.after));
            else if (u.kind === 'never') line(250, 'TOP UP', u.fuel + ' cannot get it to E' + Math.round(tg * 100), t.warn, u.fuel === 'E85' ? 'your E85 is set to E' + Math.round(hi * 100) : '');
            else line(250, 'TOP UP', 'Tank empty: use a full tank', t.dim);
            // the tank size, when the car says it is not what is set
            const off = offer();
            if (off) {
                cv.text('TANK SIZE', 542, 366, 22, t.warn, { font: 'bold', spacing: 1.5 });
                cv.text(off.why === 'full' ? 'Full, the car reads ' + off.v + ' l' : 'The car has read ' + off.v + ' l', 542, 404, 30, t.text, { font: 'bold' });
                G.button(cv, t, 542, 422, 270, 52, 'Set ' + off.v + ' l', setSize(off.v), { key: 'szset', primary: true, color: GO });
                G.button(cv, t, 824, 422, 270, 52, 'Keep ' + cap() + ' l', keepSize(off.v), { key: 'szkeep' });
                return;
            }
            const f = fullTank(r.v, b.e, tg, hi, lo, cap());
            const parts = [f.p98 >= 0.2 && f.p98.toFixed(1) + ' l of 98', f.e85 >= 0.2 && f.e85.toFixed(1) + ' l of E85'].filter(Boolean);
            line(366, 'FULL TANK', parts.length ? parts.join(' + ') : 'Already full', f.reach ? t.text : t.warn,
                f.reach ? 'then ' + cap() + ' l at ' + E(f.after) : 'closest a full tank gets: ' + E(f.after));
        }

        function drawPump(cv, t, r) {
            const p = G.panel(cv, t, 1162, 44, 414, 468, 'At the pump');
            const b = r.s.book, st = b.step(), x = 1186, bw = 366, L = lim();
            const bottom = p.y + p.h - 20;
            if (!st) {
                if (b.last) {
                    const bad = zone(b.last.e, L) === 'unsafe';
                    cv.text(bad ? 'DONE: OVER THE LIMIT' : 'DONE', x, 112, 22, bad ? crit(t) : GO, { font: 'bold', spacing: 1.5 });
                    cv.text(E(b.last.e) + ', ' + b.last.v.toFixed(1) + ' l', x, 160, 38, bad ? crit(t) : t.text, { font: 'bold' });
                    b.last.poured.forEach((q, i) => cv.text(q.litres.toFixed(1) + ' l of ' + q.fuel, x, 200 + i * 30, 24, t.dim));
                } else {
                    wrap(cv, 'Pick how to fill. It says what to pump; press Done with what the pump shows.', x, 112, bw, 22, t.dim);
                }
                const busy = r.v === null;
                G.button(cv, t, x, bottom - 3 * 64 + 4, bw, 54, 'Top up to target', () => startFill('top', ['98', 'E85']), { key: 'ftop', busy, primary: true });
                G.button(cv, t, x, bottom - 2 * 64 + 4, bw, 54, 'Full tank, 98 first', () => startFill('full', ['98', 'E85']), { key: 'f98', busy });
                G.button(cv, t, x, bottom - 64 + 4, bw, 54, 'Full tank, E85 first', () => startFill('full', ['E85', '98']), { key: 'fe85', busy });
                return;
            }
            cv.text('STEP ' + st.n + ' OF ' + st.of, x, 112, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text('Pump ' + st.litres.toFixed(1) + ' l', x, 166, 46, t.text, { font: 'bold' });
            cv.text('of ' + st.fuel, x, 214, 46, st.fuel === 'E85' ? ETH : t.accent2 || t.accent, { font: 'bold' });
            cv.text('THE PUMP SHOWS', x, 268, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(L1(poured), x + bw, 268, 30, t.text, { align: 'right', font: 'num' });
            const nb = (bw - 3 * 10) / 4;
            [[-1, '-1'], [-0.1, '-0.1'], [0.1, '+0.1'], [1, '+1']].forEach(([d, l], i) => G.button(cv, t, x + i * (nb + 10), 286, nb, 48, l, nudge(d), { key: 'n' + i }));
            // the most of this fuel the tank takes before the safe limit (the last fuel only: before
            // it, the other fuel still comes)
            const mx = st.n < st.of ? Infinity : maxBeforeSafe(b.fill.v, b.e, b.fill.fuels[st.fuel], L.safe);
            if (isFinite(mx)) {
                const over = (poured === null ? st.litres : poured) > mx + 0.05;
                cv.text(over ? 'OVER ' + E(L.safe) + ' LIMIT: max ' + mx.toFixed(1) + ' l' : E(L.safe) + ' limit at ' + mx.toFixed(1) + ' l', x, 358, 20, over ? crit(t) : t.dim, { font: 'bold' });
            }
            G.button(cv, t, x, bottom - 2 * 64 + 4, bw, 54, st.n < st.of ? 'Done, next fuel' : 'Done', done, { key: 'done', primary: true, color: GO });
            G.button(cv, t, x, bottom - 64 + 4, bw, 54, 'Cancel', cancel, { key: 'cancel' });
        }

        /* ---------- Refuels page ---------- */
        function drawLog(cv, t, r) {
            G.panel(cv, t, 24, 44, 560, 468, 'Log a fill');
            const x = 48, w = 512, b = r.s.book, k = b.track, L = lim();
            // a fill the car measures: the level when it starts, and after
            if (k) {
                const so = r.v === null ? null : r.v - k.v0;
                cv.text((k.done ? 'MEASURING ' : 'FILLING ') + k.fuel, x, 108, 22, k.fuel === 'E85' ? ETH : t.accent2 || t.accent, { font: 'bold', spacing: 1.5 });
                cv.text(k.v0.toFixed(1) + ' l  >  ' + (r.v === null ? '--' : r.v.toFixed(1) + ' l'), x, 152, 30, t.text, { font: 'bold' });
                cv.text(so === null ? '' : (so >= 0 ? '+' : '') + so.toFixed(1) + ' l', x + w, 152, 30, so > 0 ? GO : t.dim, { align: 'right', font: 'num' });
                let note = k.done ? (r.settled ? 'Waiting for the tank to read higher (ignition on)' : 'Waiting for the level to settle') : 'Pump, then press Done filling', nc = t.dim;
                const mx = maxBeforeSafe(k.v0, b.e, ef(k.fuel), L.safe);
                if (!k.done && isFinite(mx)) {
                    if (so !== null && so > mx) { note = 'OVER your ' + E(L.safe) + ' limit: stop now'; nc = crit(t); } else { note = 'Stop by +' + mx.toFixed(1) + ' l for your ' + E(L.safe) + ' limit'; nc = t.warn; }
                }
                cv.text(note, x, 180, 20, nc, { font: nc === t.dim ? undefined : 'bold' });
                if (!k.done) G.button(cv, t, x, 192, w - 150 - 12, 52, 'Done filling', trackDone, { key: 'tdone', primary: true, color: GO });
                G.button(cv, t, k.done ? x : x + w - 150, 192, k.done ? w : 150, 52, 'Cancel', trackCancel, { key: 'tcancel' });
            } else {
                const up = rise(r);
                cv.text(up ? 'The tank went up ' + up.toFixed(1) + ' l. What went in?' : 'What are you filling with?', x, 108, 22, up ? t.warn : t.dim, { font: 'bold' });
                const fw = (w - 2 * 10) / 3;
                FUELS.forEach((f, i) => G.button(cv, t, x + i * (fw + 10), 124, fw, 52, f, () => { logFuel = f; return render(); }, { key: 'lf' + f, primary: logFuel === f }));
                G.button(cv, t, x, 188, w, 54, 'Start filling ' + logFuel, trackStart, { key: 'tstart', primary: true, color: GO, busy: r.v === null || !!b.fill });
            }
            // or the pump's litres, for a fill the car did not see
            const up = rise(r), Lt = logL === null ? round1(up) : logL, y = 272;
            cv.text('OR BY THE PUMP\'S LITRES', x, y, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(L1(Lt), x + w, y, 28, t.text, { align: 'right', font: 'num' });
            const nb = (w - 5 * 8) / 6;
            [[-10, '-10'], [-1, '-1'], [-0.1, '-.1'], [0.1, '+.1'], [1, '+1'], [10, '+10']].forEach(([d, l], i) => G.button(cv, t, x + i * (nb + 8), y + 14, nb, 44, l, () => { logL = Math.max(0, round1((logL === null ? Lt : logL) + d)); return render(); }, { key: 'l' + i }));
            const eAfter = r.v !== null && Lt > 0 ? mix(Math.max(0, r.v - Lt), b.e, Lt, ef(logFuel)) : null;
            G.button(cv, t, x, y + 70, w, 48, 'Book ' + (Lt > 0 ? Lt.toFixed(1) + ' l of ' : '') + logFuel + (eAfter !== null ? ', tank then ' + E(eAfter) : ''), saveLog,
                { key: 'book', busy: !(Lt > 0) || !!k, color: eAfter !== null && zone(eAfter, L) === 'unsafe' ? crit(t) : undefined });
            // the price a litre of the fuel picked: every fill's cost comes from it
            const py = 398, pr = prices[logFuel];
            cv.text(logFuel + ' PRICE', x, py + 28, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(typeof pr === 'number' ? $(pr) + '/l' : 'not set', x + 128, py + 28, 24, typeof pr === 'number' ? t.text : t.dim, { font: 'bold' });
            const pw = (w - 232 - 3 * 8) / 4;
            [[-0.1, '-.10'], [-0.01, '-.01'], [0.01, '+.01'], [0.1, '+.10']].forEach(([d, l], i) => G.button(cv, t, x + 232 + i * (pw + 8), py, pw, 40, l, nudgePrice(d), { key: 'p' + i }));
            const bw4 = (w - 3 * 8) / 4;
            G.button(cv, t, x, 452, bw4, 44, 'Undo last', undo, { key: 'undo', confirm: true, busy: !b.log.length });
            G.button(cv, t, x + bw4 + 8, 452, bw4, 44, 'All 98', setAll('98'), { key: 'all98', confirm: true });
            G.button(cv, t, x + 2 * (bw4 + 8), 452, bw4, 44, 'All E85', setAll('E85'), { key: 'allE85', confirm: true });
            G.button(cv, t, x + 3 * (bw4 + 8), 452, bw4, 44, 'Setup', openSetup, { key: 'setup' });
        }

        function drawHistory(cv, t, r) {
            const p = G.panel(cv, t, 608, 44, 968, 468, 'Fills');
            const cols = [632, 792, 872, 1012, 1112, 1250];
            ['WHEN', 'FUEL', 'LITRES', 'COST', 'TANK AFTER', 'ETHANOL'].forEach((h, i) => cv.text(h, cols[i], 112, 20, t.dim, { font: 'bold', spacing: 1.5 }));
            const foot = p.y + p.h - 22;
            const rows = r.s.book.log.slice(0, Math.max(1, Math.floor((foot - 44 - 156) / 40) + 1));
            if (!rows.length) cv.text('No fills booked yet.', 632, 170, 24, t.dim);
            const L = lim();
            rows.forEach((x, i) => {
                const y = 156 + i * 40;
                cv.text(when(x.at), cols[0], y, 22, t.text);
                if (x.reset) cv.text('set to ' + E(x.eAfter), cols[1], y, 22, t.dim);
                else {
                    cv.text(x.fuel, cols[1], y, 22, x.fuel === 'E85' ? ETH : t.text, { font: 'bold' });
                    cv.text(x.litres.toFixed(1) + ' l' + (x.measured ? ' (car)' : ''), cols[2], y, 22, t.text);
                    cv.text(typeof x.cost === 'number' ? $(x.cost) : '--', cols[3], y, 22, typeof x.cost === 'number' ? t.text : t.dim);
                    cv.text(x.vAfter.toFixed(1) + ' l', cols[4], y, 22, t.dim);
                    cv.text(E(x.eBefore) + '  >  ' + E(x.eAfter), cols[5], y, 22, zone(x.eAfter, L) === 'unsafe' ? crit(t) : t.text, { font: 'bold' });
                }
                if (i < rows.length - 1) cv.fillRect(632, y + 13, 920, 1, withAlpha(t.tick, 0.25));
            });
            // what the fuel costs: use from the tank's readings and the odometer
            const u = usage(r.s.book.log, r.v, r.km, Date.now());
            cv.fillRect(632, foot - 34, 920, 1, withAlpha(t.tick, 0.5));
            const parts = [];
            if (u.per100 !== null) parts.push(u.per100.toFixed(1) + ' l/100 km');
            if (u.cost100 !== null) parts.push($(u.cost100) + ' per 100 km');
            if (u.litres30 > 0) parts.push('30 days: ' + (u.spent30 > 0 ? $(u.spent30) + ' on ' : '') + Math.round(u.litres30) + ' l');
            const s = u.per100 !== null ? parts.join('   |   ') : (parts.length ? parts.join('   |   ') + '   |   ' : '') + 'l/100 km after 50 km from a fill';
            cv.text(s, 632, foot, 22, u.per100 !== null ? t.text : t.dim, { font: 'bold' });
        }

        /* ---------- Setup ---------- */
        function drawSetup(cv, t, r) {
            const n = setup, x0 = 48, w0 = W - 96, L = lim();
            G.panel(cv, t, 24, 44, W - 48, 468, 'Setup ' + (n + 1) + ' of ' + SETUP.length + ': ' + SETUP[n]);
            /** a label and a row of values to pick from; off(v): shown but not offered */
            const row = (y, label, values, cur, fmt, pick, key, opts) => {
                const o = opts || {};
                cv.text(label, x0, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                const gap = 8, bw = (w0 - gap * (values.length - 1)) / values.length;
                values.forEach((v, i) => G.button(cv, t, x0 + i * (bw + gap), y + 14, bw, 50, fmt(v), () => { pick(v); return render(); },
                    { key: key + v, primary: v === cur, color: v === cur ? o.color : undefined, busy: o.off ? o.off(v) : false }));
            };
            const say2 = (y, s, col, size) => wrap(cv, s, x0, y, w0, size || 22, col || t.dim);
            if (n === 0) {
                cv.text('Welcome to E85 Blend', x0, 140, 34, t.text, { font: 'bold' });
                say2(180, 'A few questions so the numbers fit your car. The app reads the tank from the car and keeps track of every fill: no ethanol sensor needed.');
                row(250, 'TANK SIZE', TANKS, cap(), (v) => v + ' l', (v) => settings.set('tankL', v), 'st');
                say2(360, 'Not sure? Leave it. After a full tank the app checks it against the car and offers to correct it.');
            } else if (n === 1) {
                row(130, 'ETHANOL IN THE E85 AT YOUR PUMP', [65, 70, 75, 80, 85], settings.get('e85Pct'), (v) => 'E' + v, (v) => settings.set('e85Pct', v), 'se');
                say2(228, 'Pump E85 is often weaker than 85 %, more so in winter. The pump\'s label or the station will tell you.');
                row(290, 'ETHANOL IN YOUR 98', [0, 5, 10], settings.get('petrolPct'), (v) => 'E' + v, (v) => settings.set('petrolPct', v), 'sp');
                say2(390, 'Most 98 is E0. Some stations blend a little ethanol in: the pump label says.');
            } else if (n === 2) {
                say2(132, 'How much ethanol can your tune take? The app warns before a fill goes over it.', t.text, 24);
                const tw = (w0 - 3 * 8) / 4;
                cv.text('YOUR CAR', x0, 180, 22, t.dim, { font: 'bold', spacing: 1.5 });
                TUNES.forEach((u, i) => G.button(cv, t, x0 + i * (tw + 8), 194, tw, 54, u.label, () => { setLimits({ safe: u.safe, min: u.min, max: u.max, target: u.max }); return render(); },
                    { key: 'tune' + u.safe, primary: settings.get('eSafe') === u.safe, color: settings.get('eSafe') === u.safe ? GO : undefined }));
                row(276, 'SAFE LIMIT OF YOUR TUNE', STEPS5.slice(2), settings.get('eSafe'), (v) => 'E' + v, (v) => setLimits({ safe: v }), 'ss', { color: crit(t) });
                say2(392, 'Stock tunes are usually safe to about E30. If your tuner gave you a limit, use theirs.');
            } else if (n === 3) {
                say2(132, 'The range you like to run. The bar on the Blend page shows it in blue, and your safe limit in red.', t.text, 24);
                const safe = settings.get('eSafe');
                row(172, 'DESIRED FROM', STEPS5, settings.get('eMin'), (v) => 'E' + v, (v) => setLimits({ min: v }), 'smin', { off: (v) => v > safe, color: GREY });
                row(266, 'DESIRED UP TO', STEPS5, settings.get('eMax'), (v) => 'E' + v, (v) => setLimits({ max: v, target: v }), 'smax', { off: (v) => v > safe, color: ETH });
                eBar(cv, t, x0, 370, w0, 26, null, L);
            } else {
                say2(132, 'What ethanol is in the tank right now?', t.text, 24);
                row(168, 'IN THE TANK', STEPS5, setupE, (v) => 'E' + v, (v) => { setupE = v; }, 'sn');
                const bw = (w0 - 8) / 2;
                if (real.book.known) G.button(cv, t, x0, 256, bw, 52, 'Keep ' + E(real.book.e) + ' from your fills', () => { setupE = 'keep'; return render(); }, { key: 'skeep', primary: setupE === 'keep' });
                G.button(cv, t, real.book.known ? x0 + bw + 8 : x0, 256, real.book.known ? bw : w0, 52, 'Not sure', () => { setupE = 'unsure'; return render(); }, { key: 'sunsure', primary: setupE === 'unsure' });
                say2(350, setupE === 'unsure'
                    ? 'The app starts from your 98 and gets it right once you fill up with one fuel, or set it any time on Refuels.'
                    : typeof setupE === 'number' ? 'The tank starts at E' + setupE + '. Every fill from now on is mixed in.' : 'The content stays as your fills worked it out.');
            }
            const last = n === SETUP.length - 1;
            if (n > 0) G.button(cv, t, x0, 450, 220, 52, 'Back', () => { setup--; return render(); }, { key: 'sback' });
            else G.button(cv, t, x0, 450, 220, 52, 'Skip', finishSetup(true), { key: 'sskip' });
            G.button(cv, t, x0 + w0 - 260, 450, 260, 52, last ? 'Finish' : 'Next', last ? finishSetup(false) : () => { setup++; return render(); }, { key: 'snext', primary: true, color: GO });
        }

        /* ---------- frame ---------- */
        let page = 0;
        function render() {
            const t = ctx.theme(), now = Date.now(), r = read(now);
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (setup !== null) drawSetup(cv, t, r);
            else if (page === 0) { drawTank(cv, t, r); drawTarget(cv, t, r); drawPump(cv, t, r); } else { drawLog(cv, t, r); drawHistory(cv, t, r); }
            if (msg && now < msgUntil) {
                const w = cv.textWidth(msg, 24, { font: 'bold' }) + 48, c = msgCrit ? crit(t) : GO;
                cv.roundRect(W / 2 - w / 2, H - 60, w, 44, 10, msgCrit ? '#2a1214' : '#16202c');
                cv.strokeRoundRect(W / 2 - w / 2, H - 60, w, 44, 10, 2, c);
                cv.text(msg, W / 2, H - 30, 24, '#ffffff', { align: 'center', font: 'bold' });
            }
            if (setup !== null) G.frame(cv, t, ['Setup'], 0, []);
            else {
                const bad = zone(r.s.book.e, lim()) === 'unsafe';
                G.frame(cv, t, PAGES, page, [r.demo && { text: 'DEMO' }, bad && { text: 'OVER LIMIT' }, rise(r) && page === 0 && { text: 'FILL TO LOG' }]);
            }
            return ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { if (setup !== null) return render(); page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => go(i));
        // the bar's buttons where the HMI draws the screen; on the page where the kit does
        ui.onClick('BTN_TGT_DN', () => stepTarget(-5));
        ui.onClick('BTN_TGT_UP', () => stepTarget(5));
        ui.onClick('BTN_FULL', () => { page = 0; return read(Date.now()).s.book.step() ? render() : startFill('full', ['98', 'E85']); });
        ui.onClick('BTN_DONE', () => { page = 0; return done(); });
        ['BTN_TGT_DN', 'BTN_TGT_UP', 'BTN_FULL', 'BTN_DONE'].forEach((b) => ctx.hideButton(b));
        settings.onChange(() => render());

        // a guided fill left half way (app closed at the pump) carries on where it was
        const st0 = real.book.step();
        if (st0) poured = round1(st0.litres);

        setInterval(() => { const now = Date.now(); tank.tick(now); watchLevel(now); trackTick(now); sizeTick(now); }, 500);
        ctx.loop('MAIN', 4, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

function round1(x) { return Math.round(x * 10) / 10; }

/** A big ethanol figure: the E in the bold face (the number face has digits only), then the number. */
function bigE(cv, pct, x, y, size, color, t) {
    const ew = cv.text('E', x, y, size * 0.62, t.dim, { font: 'bold' });
    return ew + cv.text(pctText(pct), x + ew + size * 0.06, y, size, color, { font: 'num' });
}

/** 29.2, or 30 when it is a whole number to the tenth. */
function pctText(p) { const r = Math.round(p * 10) / 10; return r % 1 === 0 ? String(r) : r.toFixed(1); }

/** Text broken into lines of at most width px, from (x, y) down. */
function wrap(cv, s, x, y, width, size, color) {
    let line = '', n = 0;
    String(s).split(' ').forEach((w) => {
        const next = line ? line + ' ' + w : w;
        if (line && cv.textWidth(next, size) > width) { cv.text(line, x, y + n * (size + 8), size, color); line = w; n++; } else line = next;
    });
    if (line) cv.text(line, x, y + n * (size + 8), size, color);
}
