'use strict';
/**
 * E85 Blend - what ethanol content is in the tank, and what to pump to hit a target.
 *
 *   Blend page
 *   - the tank: litres from the car (tank.js: the engine unit's two tank halves, 0.5 l, else the
 *     cluster's gauge), and the ethanol content book-kept from every fill (blend.js)
 *   - the target (E0-E85): a top-up (one fuel, as little as gets there) and a full tank (both fuels)
 *   - at the pump: Top up / Full, 98 first / Full, E85 first. It says what to pump; Done (with the
 *     pump's figure, +/- if it ran over) books it, and the next fuel is worked out again from what
 *     actually went in
 *
 *   Refuels page
 *   - log any fill: the fuel and the pump's litres (it offers the rise it saw in the tank), every fill
 *     with the tank's content before and after, and "the tank is all 98 / E85" to start over
 *
 * No ethanol sensor: the content is only as right as the fills booked. Driving does not change it.
 * Saved in data/e85.json.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { mix, topUp, fullTank, Book } = require('./blend');
const { Tank } = require('./tank');

const W = 1600, H = 520;
const GO = '#2fd27a', ETH = '#2a8cff';
const PAGES = ['Blend', 'Refuels'];
const FUELS = ['98', 'E85', 'E10'];
const RISE_L = 3;                    // the tank this much fuller than last seen: a fill to log
const DEMO_AFTER_MS = 6000;          // demo "auto": no tank reading this long

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const FILE = ctx.dataDir ? path.join(ctx.dataDir, 'e85.json') : null;
        let saved = {};
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { /* first start */ }
        const real = { book: new Book(saved.book), lastV: typeof saved.lastV === 'number' ? saved.lastV : null };
        const demo = { book: new Book({ e: 0.12, known: true }), lastV: 31.5, v: 31.5 };
        const save = () => { if (FILE) try { fs.writeFileSync(FILE, JSON.stringify({ book: real.book, lastV: real.lastV })); } catch (e) { log.warn('save: ' + e); } };

        const tank = new Tank({ signals: ctx.signals, log });
        const startedAt = Date.now();

        /* ---------- what the app works with ---------- */
        const ef = (fuel) => (fuel === 'E85' ? settings.get('e85Pct') : fuel === 'E10' ? 10 : settings.get('petrolPct')) / 100;
        const fuels = () => ({ E85: ef('E85'), 98: ef('98'), E10: ef('E10') });
        const cap = () => settings.get('tankL');
        const target = () => settings.get('target') / 100;
        function demoOn(now) {
            const m = settings.get('demo');
            return m === 'on' || (m === 'auto' && !tank.now(now) && now - startedAt > DEMO_AFTER_MS);
        }
        /** { s: real or demo store, v: litres or null, src, settled, demo } */
        function read(now) {
            if (demoOn(now)) return { s: demo, v: demo.v, src: 'demo', settled: true, demo: true };
            const r = tank.now(now);
            return { s: real, v: r ? r.v : null, src: r ? r.src : null, settled: !!(r && r.settled), demo: false };
        }

        // the tank going up by itself is a fill to log; going down (driving) just moves the mark
        function watchLevel(now) {
            const r = read(now);
            if (r.demo || !r.settled || r.s.book.fill) return;
            if (r.s.lastV === null || r.v < r.s.lastV) { r.s.lastV = r.v; save(); }
        }
        const rise = (r) => (r.v !== null && r.s.lastV !== null && r.v - r.s.lastV >= RISE_L ? r.v - r.s.lastV : 0);

        /* ---------- the guided fill ---------- */
        let poured = null;            // the Done figure: starts at the plan, +/- to the pump's
        let msg = null, msgUntil = 0;
        const say = (m) => { msg = m; msgUntil = Date.now() + 6000; };
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
            const next = b.done(poured === null ? st.litres : poured);
            poured = next ? round1(next.litres) : null;
            // what is in the tank now, by the pours: the mark the gauge is compared with, so its catching
            // up later is not taken for another fill
            const v = b.fill ? b.fill.v : b.last ? b.last.v : null;
            if (v !== null) r.s.lastV = v;
            if (r.demo) { if (v !== null) demo.v = v; } else save();
            return render();
        }
        function cancel() { const r = read(Date.now()); r.s.book.cancel(); poured = null; if (!r.demo) save(); return render(); }
        const nudge = (d) => () => { if (poured !== null) poured = Math.max(0, round1(poured + d)); return render(); };
        function stepTarget(d) { settings.set('target', Math.max(0, Math.min(85, settings.get('target') + d))); return render(); }

        /* ---------- logging a fill by hand ---------- */
        let logFuel = '98', logL = null;
        function saveLog() {
            const r = read(Date.now()), L = logL === null ? round1(rise(r)) : logL;
            if (!(L > 0)) { say('Set the litres first'); return render(); }
            const vAfter = r.v !== null ? Math.max(r.v, L) : (r.s.lastV || 0) + L;
            const e = r.s.book.refuel({ fuel: logFuel, litres: L, vAfter, eFuel: ef(logFuel) });
            r.s.lastV = vAfter; logL = null;
            say('Booked ' + L.toFixed(1) + ' l of ' + logFuel + ': tank now ' + E(e));
            if (!r.demo) save();
            return render();
        }
        function setAll(fuel) { return () => { const r = read(Date.now()); r.s.book.reset(ef(fuel)); if (r.v !== null) r.s.lastV = r.v; if (!r.demo) save(); say('Tank set to all ' + fuel); return render(); }; }

        /* ---------- format ---------- */
        const E = (e) => 'E' + pctText(e * 100);
        const L1 = (v) => (v === null || v === undefined ? '--' : v.toFixed(1) + ' l');
        const SRC = { dme: 'engine unit, 0.5 l', dme1: 'engine unit, 1 l', kombi: 'cluster gauge, 1 l', demo: 'demo' };
        const when = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '. ' + p(d.getHours()) + ':' + p(d.getMinutes()); };

        /* ---------- Blend page ---------- */
        function drawTank(cv, t, r) {
            const p = G.panel(cv, t, 24, 44, 470, 468, 'Tank');
            const b = r.s.book;
            cv.text('ETHANOL NOW', 48, 112, 22, t.dim, { font: 'bold', spacing: 1.5 });
            bigE(cv, b.e * 100, 48, 222, 104, t.text, t);
            if (!b.known) cv.text('assumed: log a fill or set it on Refuels', 48, 258, 20, t.warn, { font: 'bold' });
            // the tank as a bar: petrol and ethanol share of what is in it, and the empty space
            const bx = 48, by = 284, bw = 422, bh = 46, c = Math.max(cap(), r.v || 0), fill = r.v === null ? 0 : r.v / c;
            cv.roundRect(bx, by, bw, bh, 8, withAlpha('#ffffff', 0.06));
            if (fill > 0) {
                cv.roundRect(bx, by, bw * fill, bh, 8, withAlpha(t.text, 0.28));
                cv.roundRect(bx, by, Math.max(2, bw * fill * b.e), bh, 8, ETH);
            }
            cv.strokeRoundRect(bx, by, bw, bh, 8, 1.5, withAlpha('#ffffff', 0.3));
            cv.text(r.v === null ? 'no tank reading' : r.v.toFixed(1) + ' l of ' + cap() + ' l', 48, by + bh + 36, 30, r.v === null ? t.dim : t.text, { font: 'bold' });
            if (r.v !== null) cv.text((r.v * b.e).toFixed(1) + ' l ethanol', 470, by + bh + 36, 22, ETH, { align: 'right', font: 'bold' });
            const dy = p.y + p.h - G.BOTTOM;
            cv.text(r.src ? 'level: ' + SRC[r.src] + (r.settled ? '' : ', settling') : 'waiting for the car', 48, 480 + G.toMargin(dy, 13), 20, t.dim);
        }

        function drawTarget(cv, t, r) {
            G.panel(cv, t, 518, 44, 620, 468, 'Target');
            const tg = target(), b = r.s.book, hi = ef('E85'), lo = ef('98');
            bigE(cv, Math.round(tg * 100), 542, 196, 96, t.accent2 || t.accent, t);
            G.button(cv, t, 860, 120, 120, 60, '- 5', () => stepTarget(-5), { key: 'tdn' });
            G.button(cv, t, 994, 120, 120, 60, '+ 5', () => stepTarget(5), { key: 'tup' });
            const line = (y, label, text, col, small) => {
                cv.text(label, 542, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(text, 542, y + 40, 32, col || t.text, { font: 'bold' });
                if (small) cv.text(small, 542, y + 72, 22, t.dim);
            };
            if (r.v === null && !b.fill) { line(250, 'TOP UP', 'Waiting for the tank level', t.dim); return; }
            const st = b.step();
            if (st) {
                // a fill under way: where this step lands, worked out from what has gone in so far
                const q = poured === null ? st.litres : poured, v = b.fill.v + q, after = mix(b.fill.v, b.e, q, ef(st.fuel));
                line(250, 'AFTER THIS STEP', v.toFixed(1) + ' l at ' + E(after), t.text, st.n < st.of ? 'the next fuel is worked out from what really went in' : '');
                line(366, 'AIMING FOR', 'E' + Math.round(b.fill.target * 100) + (b.fill.kind === 'full' ? ', full tank' : ''), t.dim);
                return;
            }
            const u = topUp(r.v, b.e, tg, hi, lo, cap());
            if (u.kind === 'on') line(250, 'TOP UP', 'On target', GO);
            else if (u.kind === 'add') line(250, 'TOP UP', 'Add ' + u.litres.toFixed(1) + ' l of ' + u.fuel, t.text, 'then ' + u.total.toFixed(1) + ' l at ' + E(u.after));
            else if (u.kind === 'nofit') line(250, 'TOP UP', 'No room for the ' + u.need.toFixed(1) + ' l of ' + u.fuel + ' it needs', t.warn, 'filling up with it reaches ' + E(u.after));
            else if (u.kind === 'never') line(250, 'TOP UP', u.fuel + ' cannot get it to E' + Math.round(tg * 100), t.warn, u.fuel === 'E85' ? 'your E85 is set to E' + Math.round(hi * 100) : '');
            else line(250, 'TOP UP', 'Tank empty: use a full tank', t.dim);
            const f = fullTank(r.v, b.e, tg, hi, lo, cap());
            const parts = [f.p98 >= 0.2 && f.p98.toFixed(1) + ' l of 98', f.e85 >= 0.2 && f.e85.toFixed(1) + ' l of E85'].filter(Boolean);
            line(366, 'FULL TANK', parts.length ? parts.join(' + ') : 'Already full', f.reach ? t.text : t.warn,
                f.reach ? 'then ' + cap() + ' l at ' + E(f.after) : 'closest a full tank gets: ' + E(f.after));
        }

        function drawPump(cv, t, r) {
            const p = G.panel(cv, t, 1162, 44, 414, 468, 'At the pump');
            const b = r.s.book, st = b.step(), x = 1186, bw = 366;
            const bottom = p.y + p.h - 20;
            if (!st) {
                if (b.last) {
                    cv.text('DONE', x, 112, 22, GO, { font: 'bold', spacing: 1.5 });
                    cv.text(E(b.last.e) + ', ' + b.last.v.toFixed(1) + ' l', x, 160, 38, t.text, { font: 'bold' });
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
            G.button(cv, t, x, bottom - 2 * 64 + 4, bw, 54, st.n < st.of ? 'Done, next fuel' : 'Done', done, { key: 'done', primary: true, color: GO });
            G.button(cv, t, x, bottom - 64 + 4, bw, 54, 'Cancel', cancel, { key: 'cancel' });
        }

        /* ---------- Refuels page ---------- */
        function drawLog(cv, t, r) {
            G.panel(cv, t, 24, 44, 560, 468, 'Log a fill');
            const x = 48, up = rise(r);
            cv.text(up ? 'The tank went up ' + up.toFixed(1) + ' l. What went in?' : 'A fill made without the Blend page:', x, 108, 22, up ? t.warn : t.dim, { font: 'bold' });
            const fw = (512 - 2 * 10) / 3;
            FUELS.forEach((f, i) => G.button(cv, t, x + i * (fw + 10), 128, fw, 52, f, () => { logFuel = f; return render(); }, { key: 'lf' + f, primary: logFuel === f }));
            const L = logL === null ? round1(up) : logL;
            cv.text('LITRES (THE PUMP\'S FIGURE)', x, 222, 20, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(L1(L), x + 512, 222, 30, t.text, { align: 'right', font: 'num' });
            const nb = (512 - 3 * 10) / 4;
            [[-10, '-10'], [-1, '-1'], [1, '+1'], [10, '+10']].forEach(([d, l], i) => G.button(cv, t, x + i * (nb + 10), 240, nb, 48, l, () => { logL = Math.max(0, round1((logL === null ? L : logL) + d)); return render(); }, { key: 'l' + i }));
            [[-0.1, '-0.1'], [0.1, '+0.1']].forEach(([d, l], i) => G.button(cv, t, x + i * (nb + 10), 298, nb, 48, l, () => { logL = Math.max(0, round1((logL === null ? L : logL) + d)); return render(); }, { key: 'ls' + i }));
            if (r.v !== null && L > 0) cv.text('tank then ' + E(mix(Math.max(0, r.v - L), r.s.book.e, L, ef(logFuel))), x + 512, 330, 22, t.dim, { align: 'right' });
            G.button(cv, t, x, 372, 512, 54, 'Book this fill', saveLog, { key: 'book', primary: true, busy: !(L > 0) });
            G.button(cv, t, x, 440, 250, 48, 'Tank all 98', setAll('98'), { key: 'all98', confirm: true });
            G.button(cv, t, x + 262, 440, 250, 48, 'Tank all E85', setAll('E85'), { key: 'allE85', confirm: true });
        }

        function drawHistory(cv, t, r) {
            const p = G.panel(cv, t, 608, 44, 968, 468, 'Fills');
            const cols = [632, 812, 932, 1062, 1220];
            ['WHEN', 'FUEL', 'LITRES', 'TANK AFTER', 'ETHANOL'].forEach((h, i) => cv.text(h, cols[i], 112, 20, t.dim, { font: 'bold', spacing: 1.5 }));
            const rows = r.s.book.log.slice(0, 8 + Math.max(0, Math.floor((p.y + p.h - G.BOTTOM) / 40)));
            if (!rows.length) cv.text('No fills booked yet.', 632, 170, 24, t.dim);
            rows.forEach((x, i) => {
                const y = 156 + i * 40;
                cv.text(when(x.at), cols[0], y, 22, t.text);
                if (x.reset) cv.text('set to ' + E(x.eAfter), cols[1], y, 22, t.dim);
                else {
                    cv.text(x.fuel, cols[1], y, 22, x.fuel === 'E85' ? ETH : t.text, { font: 'bold' });
                    cv.text(x.litres.toFixed(1) + ' l', cols[2], y, 22, t.text);
                    cv.text(x.vAfter.toFixed(1) + ' l', cols[3], y, 22, t.dim);
                    cv.text(E(x.eBefore) + '  >  ' + E(x.eAfter), cols[4], y, 22, t.text, { font: 'bold' });
                }
                if (i < rows.length - 1) cv.fillRect(632, y + 13, 920, 1, withAlpha(t.tick, 0.25));
            });
        }

        /* ---------- frame ---------- */
        let page = 0;
        function render() {
            const t = ctx.theme(), now = Date.now(), r = read(now);
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 0) { drawTank(cv, t, r); drawTarget(cv, t, r); drawPump(cv, t, r); } else { drawLog(cv, t, r); drawHistory(cv, t, r); }
            if (msg && now < msgUntil) {
                const w = cv.textWidth(msg, 24, { font: 'bold' }) + 48;
                cv.roundRect(W / 2 - w / 2, H - 60, w, 44, 10, '#16202c');
                cv.strokeRoundRect(W / 2 - w / 2, H - 60, w, 44, 10, 2, GO);
                cv.text(msg, W / 2, H - 30, 24, '#ffffff', { align: 'center', font: 'bold' });
            }
            G.frame(cv, t, PAGES, page, [r.demo && { text: 'DEMO' }, rise(r) && page === 0 && { text: 'FILL TO LOG' }]);
            return ui.image('MAIN_GFX', cv);
        }

        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => go(i));
        // the bar's buttons where the HMI draws the screen; on the page where the kit does
        ui.onClick('BTN_TGT_DN', () => stepTarget(-5));
        ui.onClick('BTN_TGT_UP', () => stepTarget(5));
        ui.onClick('BTN_FULL', () => { page = 0; return read(Date.now()).s.book.step() ? render() : startFill('full', ['98', 'E85']); });
        ui.onClick('BTN_DONE', () => { page = 0; return done(); });
        ['BTN_TGT_DN', 'BTN_TGT_UP', 'BTN_FULL', 'BTN_DONE'].forEach((b) => ctx.hideButton(b));

        // a guided fill left half way (app closed at the pump) carries on where it was
        const st0 = real.book.step();
        if (st0) poured = round1(st0.litres);

        setInterval(() => { const now = Date.now(); tank.tick(now); watchLevel(now); }, 500);
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
