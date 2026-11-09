'use strict';
/*
 * blend.js - what is in the tank, and how much of which fuel takes it to a target ethanol content.
 *
 * There is no ethanol sensor, so the tank's ethanol content is book-kept: every fill is mixed in by
 * volume. Driving does not change it (the engine burns the mix as it is), only the litres go down,
 * and those the car measures. All fractions here are 0-1 (E30 = 0.30).
 *
 *   mix(v0, e0, litres, eFuel)                  -> the tank's fraction after adding litres of a fuel
 *   topUp(v0, e0, target, hi, lo, cap)          -> one fuel, as little as takes it to target
 *   fullTank(v0, e0, target, hi, lo, cap)       -> both fuels, filling the tank and landing on target
 *       hi: the ethanol fraction of E85 (pump E85 is often less than 0.85: a setting), lo: of 98
 *
 *   const b = new Book(saved)                   // { e, set, log }: the tank's book, saved by the app
 *   b.refuel({ fuel, litres, vAfter, eFuel })   // mixes a fill in; vAfter = the tank after it
 *   b.start / b.done(poured, vNow) / b.cancel   // the guided fill at the pump (see Book below)
 *   b.trackStart / trackDone / trackFeed        // a fill the car measures: the level before and after
 *   b.undo()                                    // the last fill taken back out
 */

const ON_TARGET = 0.0025;              // within a quarter of a percent: nothing to add
const MIN_POUR = 0.2;                  // l: anything less is not worth a trip to the pump
const MIN_TRACK = 1.0;                 // l: a measured fill counts once the tank reads this much more (it reads in 1 l)

const isNum = (x) => typeof x === 'number' && isFinite(x);

function mix(v0, e0, litres, eFuel) {
    const v = v0 + litres;
    return v > 0 ? (Math.max(0, v0) * e0 + litres * eFuel) / v : e0;
}

/**
 * One fuel, as little of it as reaches the target: { kind, fuel, litres, after, total }.
 * kind: 'on' (on target already), 'add' (litres of fuel gets there), 'nofit' (the tank fills first:
 * litres fills it, after is where that lands), 'never' (that fuel cannot get there: E85 to above
 * its own content, or 98 down to its own), 'empty' (nothing in the tank to mix with: use fullTank).
 */
function topUp(v0, e0, t, hi, lo, cap) {
    if (!(v0 > 0.5)) return { kind: 'empty' };
    if (Math.abs(e0 - t) < ON_TARGET) return { kind: 'on', after: e0, total: v0 };
    const up = e0 < t, fuel = up ? 'E85' : '98', ef = up ? hi : lo;
    if (up ? ef <= t : ef >= t) return { kind: 'never', fuel };
    const litres = v0 * (t - e0) / (ef - t), space = Math.max(0, cap - v0);
    if (litres <= space) return { kind: 'add', fuel, litres, after: t, total: v0 + litres };
    return { kind: 'nofit', fuel, litres: space, need: litres, after: mix(v0, e0, space, ef), total: cap };
}

/**
 * The tank filled to cap with both fuels so it lands on the target: { e85, p98, after, reach }.
 * reach false: even all of one fuel cannot get there (after says where it lands).
 */
function fullTank(v0, e0, t, hi, lo, cap) {
    v0 = Math.max(0, v0);
    const space = Math.max(0, cap - v0);
    const e85 = (t * cap - e0 * v0 - lo * space) / (hi - lo);
    if (e85 < 0) return { e85: 0, p98: space, after: mix(v0, e0, space, lo), reach: false };
    if (e85 > space) return { e85: space, p98: 0, after: mix(v0, e0, space, hi), reach: false };
    return { e85, p98: space - e85, after: t, reach: true };
}

/**
 * The tank's book: its ethanol fraction (e), whether that was ever set (known: false means the
 * E0 it starts with is an assumption), the fills, and a guided fill under way (fill).
 *
 * A guided fill: start(kind, order, v0) with kind 'top' or 'full' and order ['98', 'E85'] or
 * ['E85', '98']. step() says what to pump now: { fuel, litres, n, of }. done(poured) books what went
 * in and works out the next step from what actually did, so a pump that ran over is made good by
 * the second fuel. The tank's litres come from the car at the start only; after that, pours add up.
 */
class Book {
    constructor(saved) {
        const s = saved || {};
        this.e = isNum(s.e) ? s.e : 0;
        this.known = !!s.known;
        this.log = Array.isArray(s.log) ? s.log.slice(0, 100) : [];
        this.fill = s.fill && typeof s.fill === 'object' ? s.fill : null;
        this.track = s.track && typeof s.track === 'object' ? s.track : null;
    }

    toJSON() { return { e: this.e, known: this.known, log: this.log, fill: this.fill, track: this.track }; }

    /** The tank holds this much of this (a fresh start, or a correction). */
    reset(e) {
        this.log.unshift({ at: Date.now(), reset: true, eBefore: this.e, knownBefore: this.known, eAfter: e });
        this.e = e; this.known = true; this.fill = null; this.track = null;
    }

    /** Take the last fill (or reset) back out: the tank's content goes back to what it was before it. */
    undo() {
        const x = this.log[0];
        if (!x || !isNum(x.eBefore)) return null;
        this.log.shift();
        this.e = x.eBefore;
        if (x.knownBefore !== undefined) this.known = !!x.knownBefore;
        return x;
    }

    /**
     * A fill the car measures: trackStart(fuel, v0) with the tank's litres now; pump; trackDone();
     * then trackFeed(reading, eFuel) with each reading from the car books it, once one has settled
     * at least MIN_TRACK above where it started: { booked: the log entry } or null while it waits.
     */
    trackStart(fuel, v0, at) { this.track = { fuel, v0, at: at || Date.now(), done: false }; return this.track; }
    trackDone() { if (this.track) this.track.done = true; }
    trackCancel() { this.track = null; }
    trackFeed(r, eFuel, extra) {
        const k = this.track;
        if (!k || !k.done || !r || !r.settled || !isNum(r.v)) return null;
        const litres = r.v - k.v0;
        if (litres < MIN_TRACK) return null;
        this.refuel(Object.assign({}, extra || {}, { fuel: k.fuel, litres, vAfter: r.v, eFuel }));
        this.log[0].measured = true;
        this.track = null;
        return { booked: this.log[0] };
    }

    /**
     * A fill: litres of fuel (ethanol fraction eFuel) went in, and the tank holds vAfter now. The
     * litres before are vAfter - litres, so the car's reading is only needed once, after.
     */
    refuel(f) {
        const vBefore = Math.max(0, f.vAfter - f.litres);
        const eAfter = mix(vBefore, this.e, f.litres, f.eFuel);
        const x = { at: f.at || Date.now(), fuel: f.fuel, litres: round(f.litres, 2), vAfter: round(f.vAfter, 1), eBefore: this.e, knownBefore: this.known, eAfter };
        // what it cost (the price a litre, when the owner has set one) and the odometer then
        if (isNum(f.price) && f.price > 0) { x.price = f.price; x.cost = round(f.litres * f.price, 2); }
        if (isNum(f.km)) x.km = f.km;
        this.log.unshift(x);
        this.log = this.log.slice(0, 100);
        this.e = eAfter; this.known = true;
        return eAfter;
    }

    start(kind, order, v0, target, fuels, cap) {
        if (kind === 'top') {               // one fuel, whichever the top-up needs
            const r = topUp(v0, this.e, target, fuels.E85, fuels['98'], cap);
            order = r.kind === 'add' || r.kind === 'nofit' ? [r.fuel] : [];
        }
        this.fill = { kind, order: order.slice(), n: 0, v: v0, target, fuels: Object.assign({}, fuels), cap, poured: [] };
        this._plan();
        return this.step();
    }

    /** What to pump now, or null when the fill is over. */
    step() {
        const f = this.fill;
        if (!f || f.n >= f.order.length) return null;
        return { fuel: f.order[f.n], litres: f.plan, n: f.n + 1, of: f.order.length };
    }

    _plan() {
        const f = this.fill, hi = f.fuels.E85, lo = f.fuels['98'];
        // skip what there is none of to pump (a top-up is one fuel; a full tank may need only one)
        for (;;) {
            if (f.n >= f.order.length) { f.plan = 0; return; }
            const fuel = f.order[f.n], last = f.n === f.order.length - 1;
            let litres;
            if (f.kind === 'top' || (last && f.v > 0.5)) {
                // the last fuel of a full tank is worked out again from what actually went in: as
                // much as lands on the target (about the space left, if the first pour was close),
                // the space left if the target is beyond a full tank, none if it would move away
                const r = topUp(f.v, this.e, f.target, hi, lo, f.cap);
                litres = (r.kind === 'add' || r.kind === 'nofit') && r.fuel === fuel ? r.litres : 0;
            } else {
                const p = fullTank(f.v, this.e, f.target, hi, lo, f.cap);
                litres = fuel === 'E85' ? p.e85 : p.p98;
            }
            if (litres >= MIN_POUR) { f.plan = litres; return; }
            f.n++;
        }
    }

    /**
     * That step's fuel went in: poured litres (the pump's figure). extra(fuel): { price, km } for the
     * log (optional). Returns the next step or null.
     */
    done(poured, extra) {
        const f = this.fill, s = this.step();
        if (!s) return null;
        const litres = isNum(poured) && poured >= 0 ? poured : s.litres;
        if (litres > 0) {
            f.v += litres;
            this.refuel(Object.assign({}, extra ? extra(s.fuel) : {}, { fuel: s.fuel, litres, vAfter: f.v, eFuel: f.fuels[s.fuel] }));
            f.poured.push({ fuel: s.fuel, litres });
        }
        f.n++;
        this._plan();
        const next = this.step();
        if (!next) { this.last = { poured: f.poured, e: this.e, v: f.v, target: f.target, kind: f.kind }; this.fill = null; }
        return next;
    }

    cancel() { this.fill = null; }
}

function round(x, d) { const k = Math.pow(10, d); return Math.round(x * k) / k; }

/* ---------- the owner's limits: the range they want, and what their tune can take ---------- */

/**
 * limits(min, max, safe) in percent -> fractions { min, max, safe }, put in order: the desired range
 * never reaches over the safe limit, and its bottom is never over its top.
 */
function limits(min, max, safe) {
    const s = Math.max(0, Math.min(100, isNum(safe) ? safe : 30)) / 100;
    let lo = (isNum(min) ? min : 0) / 100, hi = (isNum(max) ? max : s * 100) / 100;
    if (lo > hi) { const x = lo; lo = hi; hi = x; }
    hi = Math.min(hi, s); lo = Math.min(lo, hi);
    return { min: lo, max: hi, safe: s };
}

/** Where e sits: 'low' (under the range), 'ok' (in it), 'over' (over it, still safe), 'unsafe'. */
function zone(e, L) {
    if (e > L.safe + 0.0005) return 'unsafe';
    if (e > L.max + 0.0005) return 'over';
    if (e < L.min - 0.0005) return 'low';
    return 'ok';
}

/**
 * How many litres of a fuel (ethanol fraction eFuel) the tank (v0 litres at e0) takes before it goes
 * over the safe fraction: Infinity when that fuel cannot take it over, 0 when it is over already.
 */
function maxBeforeSafe(v0, e0, eFuel, safe) {
    if (eFuel <= safe) return Infinity;
    if (e0 >= safe) return 0;
    return Math.max(0, v0) * (safe - e0) / (eFuel - safe);
}

/* ---------- what the fuel costs ---------- */

/**
 * The car's use and cost from the book's fills and the tank and odometer now:
 * { km, used, per100, cost100, price, spent30, litres30 }. per100 is null until the car has gone
 * MIN_KM since the oldest fill in the window (the newest fills in a row that have the odometer, up to
 * 10); cost100 is null without prices. used: the litres burned since, from the tank's readings
 * (the tank after that fill, plus the fills since, minus the tank now).
 */
const MIN_KM = 50;
function usage(log, vNow, kmNow, now) {
    now = now || Date.now();
    const fills = (log || []).filter((x) => !x.reset);
    const out = { km: null, used: null, per100: null, cost100: null, price: null, spent30: 0, litres30: 0 };
    fills.forEach((x) => { if (now - x.at <= 30 * 86400000) { out.litres30 += x.litres; if (isNum(x.cost)) out.spent30 += x.cost; } });
    // newest first: the run of fills with the odometer
    const win = [];
    for (const x of fills) { if (!isNum(x.km) || win.length >= 10) break; win.push(x); }
    if (!win.length || !isNum(vNow) || !isNum(kmNow)) return out;
    const first = win[win.length - 1], km = kmNow - first.km;
    if (!(km >= MIN_KM)) return out;
    const later = win.slice(0, -1).reduce((s, x) => s + x.litres, 0);
    const used = first.vAfter + later - vNow;
    if (!(used > 0)) return out;
    out.km = km; out.used = used; out.per100 = used / km * 100;
    const priced = win.filter((x) => isNum(x.price));
    if (priced.length) {
        const L = priced.reduce((s, x) => s + x.litres, 0);
        out.price = L > 0 ? priced.reduce((s, x) => s + x.litres * x.price, 0) / L : null;
        if (out.price !== null) out.cost100 = out.per100 * out.price;
    }
    return out;
}

module.exports = { mix, topUp, fullTank, Book, limits, zone, maxBeforeSafe, usage, ON_TARGET, MIN_POUR, MIN_TRACK, MIN_KM };
