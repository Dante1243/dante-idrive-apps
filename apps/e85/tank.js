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
 * (reads only); the cluster's value comes as a plain signal. Fuel sloshes, so each source's reading
 * is the median of its last few, and it counts as settled once those agree.
 *
 * Now and then one of them reads far too low for a while (on a G20 330i: 36 l with the tank at
 * 52). A tank cannot lose fuel faster than the engine burns it, so a drop faster than that is not
 * believed: the level holds where it was, the drop is shown as ignored, and it is only taken once it
 * has stayed for DOUBT_MS. While both sources answer and disagree, the one that agrees with the
 * level so far wins. Rises are taken at once: they are fills.
 *
 *   const tank = new Tank({ signals: ctx.signals, log });
 *   tank.tick(Date.now());     // call often; it paces itself
 *   tank.now(Date.now())       // { v, src: 'dme1' | 'kombi', settled, dme, kombi, ignored } or null when
 *                              // nothing is fresh; dme / kombi: each source's own reading (null when not
 *                              // fresh), ignored: { v, src } of a drop not believed, or null
 */
const DME = 0x12;
const POLL_MS = 2000, FRESH_MS = 8000, KEEP = 5, SETTLED = 1.0;
const MAX_USE = 0.05;                // l/s: more than a tuned 2.0 burns flat out
const DROP_SLACK = 1.5;              // l: a drop this size is always believed (1 l steps, slosh)
const AGREE = 3;                     // l: the two sources this far apart disagree
const DOUBT_MS = 5 * 60000;          // a drop the engine cannot have made is taken after this long

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
        this.recent = { dme1: [], kombi: [] };     // each source's last readings, newest last
        this.seen = { dme1: 0, kombi: 0 };         // the time of the last reading taken in
        this.level = null;           // { v, src, at }: the level believed, and when it last moved
        this.ignored = null;         // { v, src, held }: a drop not believed yet, and for how many s of readings
        this.live = 0;               // s of readings since the level last moved
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

    /** The litres now (see the top of this file), or null. Calling it again changes nothing. */
    now(now) {
        const fresh = (x) => x && now - x.at <= FRESH_MS;
        const cands = [];
        [['dme1', this.dme], ['kombi', this.kombi]].forEach(([src, x]) => {
            if (!fresh(x)) { this.recent[src] = []; return; }
            const r = this.recent[src];
            if (x.at !== this.seen[src]) { this.seen[src] = x.at; r.push(x.v); if (r.length > KEEP) r.shift(); }
            const s = r.slice().sort((a, b) => a - b);
            cands.push({ src, v: s[s.length >> 1], at: x.at, settled: s.length >= 3 && s[s.length - 1] - s[0] <= SETTLED });
        });
        if (!cands.length) return null;
        const dme = cands.find((c) => c.src === 'dme1'), kombi = cands.find((c) => c.src === 'kombi');
        // the source to go by: the engine unit's, unless the two disagree and the gauge agrees with the level so far
        let c = dme || kombi;
        if (dme && kombi && Math.abs(dme.v - kombi.v) > AGREE && this.level && Math.abs(kombi.v - this.level.v) < Math.abs(dme.v - this.level.v)) c = kombi;
        const at = Math.max(dme ? dme.at : 0, kombi ? kombi.at : 0);
        if (at !== this._judged) { this._judged = at; this._judge(c, now); }
        const L = this.level || c;
        return { v: L.v, src: L.src, settled: !!(this.level && c.settled && !this.ignored), dme: dme ? dme.v : null, kombi: kombi ? kombi.v : null, ignored: this.ignored ? { v: this.ignored.v, src: this.ignored.src } : null };
    }

    /** A new reading c: believed, or held back as a drop the engine cannot have made. */
    _judge(c, now) {
        // the engine can only have burnt fuel while the car was on and reading: a gap with no readings
        // (ignition off, the head unit asleep) counts as no more than the 10 s it can have been running
        const gap = this._lastJudge ? Math.min(10, Math.max(0, (now - this._lastJudge) / 1000)) : 0;
        this._lastJudge = now;
        if (!this.level) { if (c.settled) { this.level = { v: c.v, src: c.src, at: now }; this.live = 0; } return; }
        this.live += gap;
        const secs = this.live, drop = this.level.v - c.v;
        if (drop > DROP_SLACK + MAX_USE * secs) {
            if (!this.ignored || Math.abs(this.ignored.v - c.v) > AGREE) {
                this.ignored = { v: c.v, src: c.src, held: 0 };
                this.log.info('tank: ' + c.src + ' dropped from ' + this.level.v + ' to ' + c.v + ' l in ' + Math.round(secs) + ' s: not believed yet');
            }
            this.ignored.held += gap;                   // (only while reading: not overnight)
            if (this.ignored.held * 1000 < DOUBT_MS) return;
            this.log.info('tank: ' + c.v + ' l held for ' + DOUBT_MS / 60000 + ' min: taken');
        }
        this.ignored = null;
        if (c.v !== this.level.v || c.src !== this.level.src) { this.level = { v: c.v, src: c.src, at: now }; this.live = 0; }
    }
}

module.exports = { Tank, WHOLE, KOMBI };
