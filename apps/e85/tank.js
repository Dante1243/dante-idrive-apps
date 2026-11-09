'use strict';
/*
 * tank.js - the litres in the whole tank, from the car:
 *
 *   engine unit (DME, 0x12)  583B          the whole tank, 1 l
 *   cluster (KombiIF)        statusRangeTankStatus.fluidLevelFuelTank, 1 l (what the gauge shows)
 *
 * Only totals. The saddle tank's halves (DME 5949 / 594A, 0.5 l) are not added up: on a G20 330i
 * their sum read wrong at the pump, so they are not used at all.
 *
 * The same values Live Data shows. The DME is asked every POLL_MS through kit/readonly-diag.js
 * (reads only); the cluster's value comes as a plain signal. Fuel sloshes, so the reading is the
 * median of the last few, and it counts as settled once those agree.
 *
 *   const tank = new Tank({ signals: ctx.signals, log });
 *   tank.tick(Date.now());     // call often; it paces itself
 *   tank.now(Date.now())       // { v, src: 'dme1' | 'kombi', settled } or null when nothing is fresh
 */
const DME = 0x12;
const POLL_MS = 2000, FRESH_MS = 8000, KEEP = 5, SETTLED = 1.0;

const WHOLE = [{ ecu: DME, did: '583B', bytes: 1, factor: 1, offset: 0, min: 0, max: 150, timeoutMs: 1500 }];
const KOMBI = 'de.bmw.infotainment.KombiIF';

class Tank {
    /** opts.reader: anything with value(name, candidates) (tests); opts.signals: ctx.signals. */
    constructor(opts) {
        opts = opts || {};
        this.log = opts.log || { info() {}, warn() {} };
        this.signals = opts.signals;
        this.reader = opts.reader || null;
        this.kombi = null;           // { v, at }
        this.odo = null;             // km, the last the cluster sent
        this.dme = null;             // { v, src, at }
        this.recent = [];            // [v] of the source in use, newest last
        this.src = null;
        this.busy = false; this.lastAsk = -1e12; this.misses = 0;
        if (this.signals && this.signals.watch) {
            this.signals.watch(KOMBI, '1', {
                statusRangeTankStatus: (s) => {
                    const v = s && s.fluidLevelFuelTank;
                    if (typeof v === 'number' && v >= 0 && v < 255) this.kombi = { v, at: Date.now() };
                    // the odometer comes in the same message (cost per 100 km)
                    const km = s && Number(s.mileageKilometre);
                    if (isFinite(km) && km > 0 && km < 2000000) this.odo = km;
                },
            }, this.log).catch(() => {});
        }
    }

    _reader() {
        if (this.reader) return this.reader;
        try {
            const { ReadOnlyDiag } = require('./kit/readonly-diag');
            const { DidReader } = require('./kit/dids');
            const link = new ReadOnlyDiag(this.signals, this.log);
            this._init = link.init().catch(() => {});
            this.reader = new DidReader(link, { ecu: DME });
        } catch (e) {
            this.reader = { value: () => Promise.resolve(null) };
        }
        return this.reader;
    }

    tick(now) {
        // a DME that never answers (asleep with the ignition off) is asked only every 20 s
        if (this.busy || now - this.lastAsk < (this.misses >= 3 ? 20000 : POLL_MS)) return;
        this.lastAsk = now; this.busy = true;
        this.ask(now).catch(() => {}).then(() => { this.busy = false; });
    }

    async ask(now) {
        const rd = this._reader();
        if (this._init) { await this._init; this._init = null; }
        const w = await rd.value('whole', WHOLE);
        if (w !== null) { this.dme = { v: w, src: 'dme1', at: now }; this.misses = 0; return; }
        this.misses++;
    }

    /** The litres now: { v, src, settled }, or null. */
    now(now) {
        const fresh = (x) => x && now - x.at <= FRESH_MS;
        const pick = fresh(this.dme) ? this.dme : fresh(this.kombi) ? { v: this.kombi.v, src: 'kombi', at: this.kombi.at } : null;
        if (!pick) return null;
        if (pick.src !== this.src) { this.src = pick.src; this.recent = []; }
        if (pick.at !== this._at) { this._at = pick.at; this.recent.push(pick.v); if (this.recent.length > KEEP) this.recent.shift(); }
        const s = this.recent.slice().sort((a, b) => a - b), med = s[s.length >> 1];
        return { v: med, src: pick.src, settled: s.length >= 3 && s[s.length - 1] - s[0] <= SETTLED };
    }
}

module.exports = { Tank, WHOLE, KOMBI };
