'use strict';
/*
 * turbo_thermal.js - a live heat balance of the exhaust side of the engine.
 *
 * Every sample it works out, in real units, how much heat the engine is putting into the exhaust
 * and how much of it the turbo and downpipe are soaking up or rejecting right now, from rpm, torque
 * and road speed, and tracks three lumps of metal:
 *
 *   turbine housing    the hot end: fed by the gas, cooled mostly by RADIATION, then by air
 *   downpipe / cat     fed by the gas leaving the turbine, cooled by radiation and the air under the car
 *   bearing housing    water and oil cooled; after shutdown nothing moves the heat, so it soaks
 *
 *   const tt = new TurboThermal({ litres, ambientFallback });
 *   tt.update(d, dt);          // d = { rpm, torque, speed, oil, coolant, ambient, boost,
 *                              //       catDme, afterCatDme (the DME's own figures, when fresh) }, dt in s
 *   tt.Tp, tt.pipeGlowing      // the thin downpipe right after the turbine, and whether it glows
 *   tt.Tc, tt.catDme           // the catalyst brick: ours, and the DME's figure we last learned from
 *   tt.learning                // true while the DME's figure is correcting the gas temperature
 *   tt.correction(f2)          // what it has learned to add to the gas temperature at a flow (C)
 *   tt.Th, tt.Td, tt.Tb        // turbine housing (average), downpipe, bearing housing (deg C), null at first
 *   tt.Thot, tt.glowing        // the housing's hottest spot, the thin wall that glows first, and whether it does
 *   tt.Tg                      // exhaust gas at the turbine inlet (deg C), null with the engine off
 *   tt.qExh                    // kW the exhaust gas is carrying away from the engine
 *   tt.qIn, tt.qOut            // kW going into the metal / being rejected from it
 *   tt.qRad, tt.qAir, tt.qCool // qOut split: radiation, moving air, coolant + oil
 *   tt.soak                    // deg C: where the bearing housing would peak if you switched off now
 *   tt.secondsToSafe(limit)    // s until switching off is safe if you carry on like this, null = never
 *
 * It is an ESTIMATE: no car in this family has an exhaust or housing temperature sensor on the bus,
 * so nothing here can be checked on the car without fitting a thermocouple. What it does have is
 * data behind it. The constants below are fitted to published measurements of gasoline turbos, and
 * kit/tools/test_turbo_thermal.js holds those measurements and fails if the model drifts off them:
 *
 *   [M] Savaripour, Alaviyoun, Rosen, Clean Technologies 4(2) 2022 (1.7 L gasoline, water cooled):
 *       emissivity of the turbine housing 0.92, turbine housing 839 C at its hottest at 5500 rpm
 *       full load, bearing housing 122-155 C there, and the warm-up and engine-off cool-down curves.
 *   [A] Aghaali, KTH licentiate thesis 2012 (2 L GDI, water cooled): turbine inlet 625 C gives a
 *       419 C wall, 848 C gives 617 C; 850 C at 2000 rpm and 12.4 bar BMEP.
 *   [S] Storm, Linkoping/Volvo thesis 2017: turbine inlet 427-877 C over 1000-4000 rpm, 15-135 Nm.
 *   [H] A heat-soak test: the bearing housing rose 60 C after shutdown to 220 C, about 10 C with an
 *       electric water pump running on.
 *
 * Three things the old model got wrong, for the record. Enrichment COOLS the exhaust (it is what
 * the ECU does to protect the turbo), it does not spike it; the gas temperature here simply tops
 * out near the 950 C limit instead. Radiation, not airflow, does most of the cooling of a hot
 * housing: radiation alone reproduces the measured cool-down. And housing temperature is the wrong
 * thing to wait on: a housing takes many minutes to fall below 300 C, while what actually cooks oil
 * is the bearing housing after the water and oil stop, so that is what "safe to switch off" uses.
 */

const SIGMA = 5.670e-8;
const ZERO_C = 273.15;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const k4 = (c) => { const t = (c + ZERO_C) / 100; return t * t * t * t * 1e8; };   // (T in K)^4

// Everything is for a 2.0 L engine and scaled to other sizes; see the note on each.
const K = {
    /* fuel and gas flow: petrol at lambda 1 */
    lhv: 42.5e6,            // J/kg, lower heating value of petrol
    exhPerFuel: 15.7,       // kg of exhaust per kg of fuel (14.7 air + 1 fuel)
    cpExh: 1180,            // J/kg K, exhaust gas around 800 K
    etaPart: 0.38,          // fuel energy to piston work at part load...
    etaFull: 0.345,         // ...and at full load (late spark, some enrichment)
    bmepPart: 12, bmepFull: 22,   // bar, where that falls from one to the other
    lossMep: 0.9, lossMepPerKrpm: 0.22,   // friction + pumping in bar, the Willans line's intercept
    /* turbine inlet gas temperature (deg C) against exhaust flow (g/s, 2.0 L basis): [S] [A] [M].
     * Rises fast with flow, then flattens at the limit the ECU protects with enrichment. */
    egt: [[3, 380], [5, 430], [12, 630], [27, 750], [44, 850], [100, 915], [250, 945]],
    /* overrun: no fuel, the throttled engine pumps warm air through */
    cutTorque: 3, cutRpm: 1100, cutFlow: 0.2, cutRise: 60,
    /* turbine housing. Radiation alone fits [M]'s cool-down to about 5 C rms with area / capacity
     * = 3.0e-5; adding the small air and conduction terms gives the capacity below, about 9 kg of
     * cast steel, which takes in the manifold built into the housing. The split between mass and
     * area is a judgement, so the kW figures carry more doubt than the temperatures. */
    hCap: 5500,             // J/K, fitted with the terms below to all of [M] and [A] at once
    hArea: 0.12,            // m2
    hEmiss: 0.92,           // [M]
    bayView: 0.75,          // heat shield and engine bay: what the housing radiates to is not cold
    gasUA: 15,              // W/K gas to wall at the reference flow, from [A]'s and [M]'s steady points
    gasRef: 12,             // g/s
    gasExp: 0.42,           // fitted over 12-140 g/s
    airH0: 6,               // W/m2K still air (the area is the housing's, part of it shielded)
    airHv: 0.9,             // ... plus this times (km/h)^0.7 under the bonnet
    bayShare: 0.45,         // the bay sits this far from ambient towards coolant when parked...
    bayFade: 40,            // ... and fades with speed (km/h)
    /* the hottest spot: the thin wall where the gas turns into the volute, which is what glows first.
     * [M] measured it at 839 C at full load where the housing averaged about 720 C. It is a few mm
     * of steel, not the 9 kg lump, so it follows the gas in seconds. Rates are per J/K of that wall:
     * gas side scaled with flow^0.8 (turbulent pipe flow), one face radiating, conduction into the
     * thick body around it. Display only: the lump above still carries the heat. */
    skinGas: 0.083,         // 1/s at skinRef: about 1300 W/m2K on a 4 mm wall
    skinRef: 150,           // g/s, 2.0 L basis
    skinExp: 0.8,
    skinArea: 5e-5,         // m2 per J/K: a 4 mm wall seen from one side
    skinCond: 0.03,         // 1/s into the body around it
    glowC: 600,             // a dull red you can see in a dark engine bay (the Draper point, 525 C, needs dark-adapted eyes)
    /* bearing housing: [M] 122-155 C at full load, [H] +60 C soak without a pump */
    bCap: 1500,             // J/K
    bFromH: 2.4,            // W/K from the turbine housing, by conduction
    bWater: 45,             // W/K to coolant and oil while they flow
    bStill: 9,              // W/K once they stop (thermosiphon and the block)
    waterShare: 0.7,        // the sink is mostly coolant, some oil
    /* downpipe and first catalyst brick */
    dCap: 3000,             // J/K
    dArea: 0.2,             // m2
    dEmiss: 0.6,            // stainless, and only partly in view of cold surfaces
    dView: 0.6,
    dGasUA: 10, dGasExp: 0.6,
    dAirH0: 10, dAirHv: 1.6,    // under the car it sees far more of the airflow
    catShare: 0.015,        // of fuel energy, released in the catalyst
    /* the thin pipe from the turbine outlet into the catalyst: what glows under the car. 1.5 mm
     * stainless, so it follows the gas in seconds like the turbine hot spot; gas side from pipe
     * flow (Dittus-Boelter, about doubled for the swirl behind the turbine). Display only. */
    pipeGas: 0.055,         // 1/s at skinRef: about 370 W/m2K
    pipeArea: 1.5e-4,       // m2 per J/K: 1.5 mm stainless, one face
    pipeEmiss: 0.7,         // heat-tinted stainless
    pipeCond: 0.01,         // 1/s into the flange and catalyst can
    /* the catalyst brick, as the DME models it: the gas flows through and the brick follows it,
     * slowly at idle and in seconds at full flow. Only here to compare with the DME's own figure. */
    catCap: 1200,           // J/K, about 1 l of coated ceramic and its can
    catLoss: 1.5,           // W/K through the can's insulation
    /* learning from the DME: the gap between its catalyst temperature and ours corrects the gas
     * temperature, kept per band of exhaust flow (g/s, 2.0 L basis) so cruise and full load learn
     * their own. Slower than the brick itself responds, so it cannot swing. */
    learnFlows: [5, 15, 40, 100, 250],
    learnMinFlow: 8,        // g/s: below this the brick is too slow to say anything
    learnTau: 20,           // s, at least twice the brick's own time constant
    learnMax: 250,          // C either way
    learnFresh: 5,          // s: the correction counts as live this long after the DME last spoke
    /* other */
    minRunRpm: 300,
    turbDropFlow: 0.35, turbDropBase: 20, turbDropMax: 110,   // C across the turbine, without boost
    compEff: 0.72,
    boostMoved: 0.03,       // bar: boost only counts once it has moved (some cars never fill it)
    rateTau: 3,             // s, smoothing of the displayed rate
    soakStep: 5, soakMax: 900,
};

function table(t, x) {
    if (x <= t[0][0]) return t[0][1];
    for (let i = 1; i < t.length; i++) {
        if (x <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (x - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
    }
    return t[t.length - 1][1];
}

class TurboThermal {
    constructor(opts) {
        opts = opts || {};
        this.k = Object.assign({}, K, opts.k);
        this.litres = opts.litres || 2.0;
        this.ambientFallback = isNum(opts.ambientFallback) ? opts.ambientFallback : 20;
        this.reset();
    }

    reset() {
        this.Th = null; this.Td = null; this.Tb = null; this.Tg = null; this.Ts = null; this.Thot = null; this.glowing = false;
        this.Tp = null; this.pipeGlowing = false; this.Tc = null; this.catDme = null; this.T5 = null;
        if (!this.learn || this.learn.length !== this.k.learnFlows.length) this.learn = this.k.learnFlows.map(() => 0);   // survives reset: it is the engine, not the drive
        this._learnAt = -1e9;
        this.qExh = 0; this.qIn = 0; this.qOut = 0; this.qRad = 0; this.qAir = 0; this.qCool = 0;
        this.fuelKw = 0; this.flow = 0; this.running = false; this.fuelCut = false;
        this.dTdt = null; this.soak = null; this.boostLo = null; this.boostHi = null; this.boostOk = false;
        this._soakAt = 0; this._t = 0;
    }

    /** Size scale: thermal mass and areas grow with the surface of a bigger engine's hot end. */
    get size() { return Math.pow(this.litres / 2.0, 2 / 3); }

    /** Air around the housing, and what it radiates to: warmer parked, near ambient at speed. */
    _env(d) {
        const amb = isNum(d.ambient) ? d.ambient : this.ambientFallback;
        const cool = isNum(d.coolant) ? d.coolant : amb + 60;
        const oil = isNum(d.oil) ? d.oil : cool;
        const speed = Math.max(0, isNum(d.speed) ? d.speed : 0);
        const bay = amb + (cool - amb) * this.k.bayShare / (1 + speed / this.k.bayFade);
        const sink = cool * this.k.waterShare + oil * (1 - this.k.waterShare);
        return { amb, bay, sink, speed };
    }

    /** What the engine is doing: fuel power, exhaust flow and gas temperatures. */
    operating(d, env) {
        const k = this.k, rpm = isNum(d.rpm) ? d.rpm : 0, tq = Math.max(0, isNum(d.torque) ? d.torque : 0);
        if (rpm < k.minRunRpm) return { running: false, flow: 0, fuelKw: 0, Tg: null, T4: null, cut: false };
        const vol = this.litres / 1000, strokes = rpm / 120;                         // m3, cycles a second
        if (tq < k.cutTorque && rpm > k.cutRpm) {                                     // overrun: fuel cut
            const flow = k.cutFlow * vol * strokes * 1.2;
            const Tg = env.bay + k.cutRise;
            return { running: true, flow, fuelKw: 0, Tg, T4: Tg, cut: true };
        }
        const brake = tq * rpm * 2 * Math.PI / 60;
        const loss = (k.lossMep + k.lossMepPerKrpm * rpm / 1000) * 1e5 * vol * strokes;
        const bmep = tq * 4 * Math.PI / vol / 1e5;
        const eta = k.etaPart + (k.etaFull - k.etaPart) * clamp((bmep - k.bmepPart) / (k.bmepFull - k.bmepPart), 0, 1);
        const fuel = (brake + loss) / eta;                                            // W
        const flow = fuel / k.lhv * k.exhPerFuel;                                     // kg/s of exhaust
        const flow2 = flow * 1000 / (this.litres / 2.0);                              // g/s on the 2.0 L basis
        const Tg = Math.min(1050, table(k.egt, flow2) + this.correction(flow2));
        let drop;
        if (this.boostOk && isNum(d.boost)) {                                         // turbine work = compressor work
            const pr = Math.max(1, 1 + d.boost), air = flow * (k.exhPerFuel - 1) / k.exhPerFuel;
            const work = air * 1005 * (env.amb + ZERO_C) * (Math.pow(pr, 0.286) - 1) / k.compEff;
            drop = clamp(work / (flow * k.cpExh), 0, 160);
        } else drop = Math.min(k.turbDropMax, k.turbDropBase + k.turbDropFlow * flow2);
        return { running: true, flow, fuelKw: fuel / 1000, Tg, T4: Tg - drop, cut: false };
    }

    /** Heat flows in W for one state at one operating point; d* are the three lumps' temperature rates. */
    _flows(s, op, env) {
        const k = this.k, z = this.size, f2 = op.flow * 1000 / (this.litres / 2.0);
        const vh = Math.pow(env.speed, 0.7);
        // turbine housing
        const gas = op.running ? k.gasUA * z * Math.pow(Math.max(f2, 0.5) / k.gasRef, k.gasExp) * (op.Tg - s.Th) : 0;
        const rad = k.hEmiss * k.bayView * SIGMA * k.hArea * z * (k4(s.Th) - k4(env.bay));
        const air = (k.airH0 + k.airHv * vh) * k.hArea * z * (s.Th - env.bay);
        const toB = k.bFromH * z * (s.Th - s.Tb);
        // bearing housing
        const water = (op.running ? k.bWater : k.bStill) * z * (s.Tb - env.sink);
        // downpipe: the gas has already given up the turbine's share of heat, but cannot leave
        // the housing cooler than the metal it has just been through
        const T5 = op.running ? Math.max(Math.min(op.T4, s.Th), op.T4 - (op.flow > 0 ? Math.max(0, gas) / (op.flow * k.cpExh) : 0)) : 0;
        const dgas = op.running ? k.dGasUA * z * Math.pow(Math.max(f2, 0.5) / k.gasRef, k.dGasExp) * (T5 - s.Td) : 0;
        const dcat = op.fuelKw * 1000 * k.catShare;
        const drad = k.dEmiss * k.dView * SIGMA * k.dArea * z * (k4(s.Td) - k4(env.amb));
        const dair = (k.dAirH0 + k.dAirHv * vh) * k.dArea * z * (s.Td - env.amb);
        return { gas, rad, air, toB, water, dgas, dcat, drad, dair, T5,
            dTh: (gas - rad - air - toB) / (k.hCap * z),
            dTb: (toB - water) / (k.bCap * z),
            dTd: (dgas + dcat - drad - dair) / (k.dCap * z) };
    }

    /** Where flow f2 (g/s, 2.0 L basis) sits between the learning bands: [index, weight] pairs. */
    _bands(f2) {
        const F = this.k.learnFlows, x = Math.log(Math.max(f2, F[0]));
        if (f2 >= F[F.length - 1]) return [[F.length - 1, 1]];
        for (let i = 1; i < F.length; i++) {
            if (f2 <= F[i]) { const a = (x - Math.log(F[i - 1])) / (Math.log(F[i]) - Math.log(F[i - 1])); return [[i - 1, 1 - a], [i, a]]; }
        }
        return [[0, 1]];
    }

    /** What the DME has taught us to add to the gas temperature at this flow (deg C). */
    correction(f2) { return this._bands(f2).reduce((s, [i, w]) => s + w * this.learn[i], 0); }

    /** Is the gas temperature being corrected by the DME right now? */
    get learning() { return this._t - this._learnAt <= this.k.learnFresh; }

    /**
     * The catalyst brick, and learning from the DME's figure for it. The gas reaching the brick (T5)
     * comes from the same map as everything else, so correcting it moves the housing, its hot spot
     * and the downpipe together. Only learns where the brick answers quickly enough to compare.
     */
    _catalyst(op, T5, d, env, dt) {
        const k = this.k, z = this.size, cap = k.catCap * z, f2 = op.flow * 1000 / (this.litres / 2.0);
        const flowUA = op.running ? op.flow * k.cpExh : 0;
        const n = Math.max(1, Math.ceil(dt * (flowUA + k.catLoss * z) / cap / 0.3));
        let T = this.Tc;
        for (let i = 0; i < n; i++) T += (flowUA * ((op.running ? T5 : T) - T) + op.fuelKw * 1000 * k.catShare - k.catLoss * z * (T - env.amb)) / cap * dt / n;
        if (isFinite(T)) this.Tc = T;
        const dme = isNum(d.catDme) ? d.catDme : isNum(d.afterCatDme) ? d.afterCatDme : null;
        this.catDme = dme;
        if (dme === null || !op.running || op.cut || f2 < k.learnMinFlow) return;
        const tau = Math.max(k.learnTau, 2 * cap / Math.max(flowUA, 1e-3));
        const err = dme - this.Tc;
        for (const [i, w] of this._bands(f2)) this.learn[i] = clamp(this.learn[i] + w * err * dt / tau, -k.learnMax, k.learnMax);
        this._learnAt = this._t;
    }

    /** The thin downpipe: gas leaving the turbine, radiation, the air under the car, a little into the can. */
    _pipe(op, T5, env, dt) {
        const k = this.k, f2 = op.flow * 1000 / (this.litres / 2.0);
        const g = op.running ? k.pipeGas * Math.pow(Math.max(f2, 0.5) / k.skinRef, k.skinExp) : 0;
        const air = (k.dAirH0 + k.dAirHv * Math.pow(env.speed, 0.7)) * k.pipeArea;
        const n = Math.max(1, Math.ceil(dt * (g + k.pipeCond + air) / 0.3));
        let T = this.Tp;
        for (let i = 0; i < n; i++) {
            const out = k.pipeEmiss * SIGMA * k.pipeArea * (k4(T) - k4(env.amb)) + air * (T - env.amb);
            T += ((op.running ? g * (T5 - T) : 0) - k.pipeCond * (T - this.Td) - out) * dt / n;
        }
        if (isFinite(T)) this.Tp = T;
    }

    /** The thin hot spot: driven by the gas, held back by the body around it, radiating one face. */
    _skin(op, env, dt) {
        const k = this.k, f2 = op.flow * 1000 / (this.litres / 2.0);
        const g = op.running ? k.skinGas * Math.pow(Math.max(f2, 0.5) / k.skinRef, k.skinExp) : 0;
        const air = (k.airH0 + k.airHv * Math.pow(env.speed, 0.7)) * k.skinArea;
        // the gas side is fast at full flow: step in pieces so it cannot overshoot
        const n = Math.max(1, Math.ceil(dt * (g + k.skinCond) / 0.3));
        let T = this.Ts;
        for (let i = 0; i < n; i++) {
            const out = k.hEmiss * k.bayView * SIGMA * k.skinArea * (k4(T) - k4(env.bay)) + air * (T - env.bay);
            T += ((op.running ? g * (op.Tg - T) : 0) - k.skinCond * (T - this.Th) - out) * dt / n;
        }
        if (isFinite(T)) this.Ts = T;
    }

    _advance(s, op, env, dt) {
        const f = this._flows(s, op, env);
        s.Th += f.dTh * dt; s.Tb += f.dTb * dt; s.Td += f.dTd * dt;
        return f;
    }

    /** Where the bearing housing peaks if the engine stops now (worst case: no electric pump credit). */
    soakPeak(s) {
        const k = this.k, env = s.env || { amb: this.ambientFallback, bay: this.ambientFallback + 30, sink: 90, speed: 0 };
        const off = { running: false, flow: 0, fuelKw: 0, Tg: null, T4: null };
        const parked = { amb: env.amb, bay: env.parkedBay != null ? env.parkedBay : env.bay, sink: env.sink, speed: 0 };
        const x = { Th: s.Th, Tb: s.Tb, Td: s.Td };
        let peak = x.Tb;
        for (let t = 0; t < k.soakMax; t += k.soakStep) {
            this._advance(x, off, parked, k.soakStep);
            if (x.Tb > peak) peak = x.Tb; else if (t > 60) break;
        }
        return peak;
    }

    update(d, dt) {
        d = d || {};
        const env = this._env(d);
        if (this.Th === null) {                         // start at what the engine shows: after a long
            const t0 = isNum(d.coolant) ? d.coolant : env.amb;    // stop the metal is near coolant temperature
            this.Th = t0; this.Td = t0; this.Tb = t0;
        }
        if (this.Ts === null) { this.Ts = this.Th; this.Tp = this.Td; this.Tc = this.Td; }
        if (!(dt > 0)) { this.Thot = Math.max(this.Ts, this.Th); return this; }
        dt = Math.min(dt, 1);                           // the clock can stall; never leap
        if (this._t < 5 && isNum(d.coolant) && d.coolant > this.Th) {   // coolant came after the first sample
            this.Th = d.coolant; this.Td = d.coolant; this.Tb = d.coolant; this.Ts = d.coolant; this.Tp = d.coolant; this.Tc = d.coolant;
        }
        // a DME catalyst figure is the best start for the catalyst and pipe after a short stop
        if (this._t < 5 && isNum(d.catDme) && d.catDme > this.Tc) { this.Tc = d.catDme; this.Tp = Math.max(this.Tp, d.catDme); this.Td = Math.max(this.Td, d.catDme); }
        if (isNum(d.boost)) {                           // a field some cars never fill sits at one number
            this.boostLo = this.boostLo === null ? d.boost : Math.min(this.boostLo, d.boost);
            this.boostHi = this.boostHi === null ? d.boost : Math.max(this.boostHi, d.boost);
            if (this.boostHi - this.boostLo >= this.k.boostMoved) this.boostOk = true;
        }
        const op = this.operating(d, env);
        const s = { Th: this.Th, Tb: this.Tb, Td: this.Td };
        const before = this.Th;
        this._skin(op, env, dt);
        const f = this._advance(s, op, env, dt);
        this._pipe(op, f.T5, env, dt);
        this._catalyst(op, f.T5, d, env, dt);
        this.Th = s.Th; this.Tb = s.Tb; this.Td = s.Td;
        this.T5 = op.running ? f.T5 : null;
        this.Thot = Math.max(this.Ts, this.Th);
        this.glowing = this.Thot >= this.k.glowC;
        this.pipeGlowing = this.Tp >= this.k.glowC;
        this.Tg = op.Tg; this.running = op.running; this.fuelCut = !!op.cut;
        this.flow = op.flow * 1000; this.fuelKw = op.fuelKw;
        // kW: positive gas flow is heat going in; gas cooler than the metal is carrying heat away
        this.qExh = op.running ? op.flow * this.k.cpExh * Math.max(0, op.Tg - env.amb) / 1000 : 0;
        this.qIn = (Math.max(0, f.gas) + Math.max(0, f.dgas) + f.dcat) / 1000;
        this.qRad = (Math.max(0, f.rad) + Math.max(0, f.drad)) / 1000;
        this.qAir = (Math.max(0, f.air) + Math.max(0, f.dair) + Math.max(0, -f.gas) + Math.max(0, -f.dgas)) / 1000;
        this.qCool = Math.max(0, f.water) / 1000;
        this.qOut = this.qRad + this.qAir + this.qCool;
        const rate = (this.Th - before) / dt, a = 1 - Math.exp(-dt / this.k.rateTau);
        this.dTdt = this.dTdt === null ? rate : this.dTdt + (rate - this.dTdt) * a;
        this._env0 = env; this._op = op; this._t += dt;
        if (this._t - this._soakAt >= 1 || this.soak === null) {       // once a second is plenty
            this._soakAt = this._t;
            this.soak = this.soakPeak(this._state());
        }
        return this;
    }

    _state() {
        const e = this._env0, parkedBay = e.amb + (e.bay - e.amb) * (1 + e.speed / this.k.bayFade);
        return { Th: this.Th, Tb: this.Tb, Td: this.Td, env: Object.assign({}, e, { parkedBay }) };
    }

    /**
     * Seconds until the soak falls to limit if the engine keeps doing what it is doing now (or, with
     * d, what d says: a sample to hold, such as a parked idle). 0: already safe. null: it never will.
     */
    secondsToSafe(limit, d) {
        if (this.Th === null || !this._env0) return null;
        const start = this._state();
        if (this.soakPeak(start) <= limit) return 0;
        const env = d ? this._env(d) : this._env0, op = d ? this.operating(d, env) : this._op;
        const s = { Th: this.Th, Tb: this.Tb, Td: this.Td, env: start.env };
        const STEP = 5;
        for (let t = STEP; t <= 1800; t += STEP) {
            this._advance(s, op, env, STEP);
            if (t % 15 === 0 && this.soakPeak(s) <= limit) return t;
        }
        return null;
    }
}

module.exports = { TurboThermal, K };
