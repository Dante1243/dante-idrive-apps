'use strict';
/*
 * dme_exhaust.js - the engine unit's own exhaust temperatures, read live.
 *
 * The DME runs a thermal model of the exhaust for this exact engine (it protects the catalyst and
 * the turbo with it), and reports two of its results over diagnostics:
 *
 *   catalyst temperature, bank 1 sensor 1   OBD-II PID 3C (or UDS F43C), 0.1 C, -40 C
 *   exhaust after the catalyst (model)      UDS 5896 or 582F, signed, 0.1 K
 *
 * Live Data reads the same values. This only READS: it goes through kit/readonly-diag.js, which
 * refuses every service but 22 and OBD 01/09 before anything reaches the car.
 *
 *   const dme = new DmeExhaust({ signals: ctx.signals, log: ctx.log });
 *   dme.tick(engineRunning, Date.now());   // call often: it asks about once a second, one at a time
 *   dme.fresh(Date.now())                  // { cat, after } in deg C, each null when not fresh
 *   dme.state                              // 'off' | 'reading' | 'no answer' | 'unavailable'
 *
 * A DME that answers neither is asked again only every 30 s, so it costs the car next to nothing.
 */
const DME = 0x12;
const POLL_MS = 1000, RETRY_MS = 30000, FRESH_MS = 3000, GIVE_UP = 5;

const CAT = [
    { ecu: DME, obd: '3C', bytes: 2, factor: 0.1, offset: -40, min: -40, max: 1200, timeoutMs: 1500 },
    { ecu: DME, did: 'F43C', bytes: 2, factor: 0.1, offset: -40, min: -40, max: 1200, timeoutMs: 1500 },
];
const AFTER = [
    { ecu: DME, did: '5896', bytes: 2, signed: true, factor: 0.1, offset: -273.14, min: -40, max: 1200, timeoutMs: 1500 },
    { ecu: DME, did: '582F', bytes: 2, signed: true, factor: 0.1, offset: -273.14, min: -40, max: 1200, timeoutMs: 1500 },
];

class DmeExhaust {
    /** opts.reader: anything with value(name, candidates) -> Promise<number|null> (tests); else the real link. */
    constructor(opts) {
        opts = opts || {};
        this.log = opts.log || { info() {}, warn() {} };
        this.signals = opts.signals;
        this.reader = opts.reader || null;
        this.cat = null; this.after = null;            // { v, at }
        this.misses = 0; this.busy = false; this.lastAsk = -1e12; this.state = 'off';
        this.found = {};                               // which candidate answered, for the log
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
            this.state = 'unavailable';
            this.reader = { value: () => Promise.resolve(null) };
        }
        return this.reader;
    }

    tick(running, now) {
        if (!running) { if (this.state === 'reading') this.state = 'off'; return; }
        const every = this.misses >= GIVE_UP ? RETRY_MS : POLL_MS;
        if (this.busy || now - this.lastAsk < every) return;
        this.lastAsk = now;
        this.busy = true;
        this.ask(now).catch(() => {}).then(() => { this.busy = false; });
    }

    async ask(now) {
        const rd = this._reader();
        if (this._init) { await this._init; this._init = null; }
        const cat = await rd.value('cat', CAT);
        const after = await rd.value('after', AFTER);
        const t = now === undefined ? Date.now() : now;
        if (cat !== null) this.cat = { v: cat, at: t };
        if (after !== null) this.after = { v: after, at: t };
        if (cat === null && after === null) {
            this.misses++;
            if (this.misses === GIVE_UP) this.log.info('DME exhaust temperatures: no answer, asking every ' + RETRY_MS / 1000 + ' s');
            this.state = this.misses >= GIVE_UP ? 'no answer' : this.state;
        } else {
            if (this.state !== 'reading') this.log.info('DME exhaust temperatures: reading (catalyst ' + (cat === null ? '-' : cat.toFixed(0)) + ', after ' + (after === null ? '-' : after.toFixed(0)) + ' C)');
            this.misses = 0; this.state = 'reading';
        }
    }

    fresh(now) {
        const ok = (x) => (x && now - x.at <= FRESH_MS ? x.v : null);
        return { cat: ok(this.cat), after: ok(this.after) };
    }
}

module.exports = { DmeExhaust, CAT, AFTER, POLL_MS, RETRY_MS, FRESH_MS };
