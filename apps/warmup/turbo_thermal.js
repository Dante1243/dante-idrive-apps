'use strict';
/*
 * turbo_thermal.js - a lumped-capacitance estimate of turbine-housing / downpipe
 * temperature, so Warm-Up's cool-down knows real heat IN vs heat OUT at the current
 * conditions instead of a fixed "hard driving" timer.
 *
 *   const tt = new TurboThermal({ ratedKw, boostMax, redline, ambientFallback });
 *   tt.update(d, dt);            // d = { rpm, speed, torque, boost, oil, ambient }, dt seconds
 *   tt.T                         // estimated housing temperature (deg C), or null before first sample
 *   tt.dTdt                      // smoothed rate (deg C / s): > 0 heating / soaking, < 0 shedding
 *   tt.heatIn / tt.heatOut       // the two sides of the balance (deg C / s), for the UI bar
 *   tt.secondsToSafe(cokeTemp)   // predicted s until T <= cokeTemp at the current rate (null if not cooling)
 *
 * This is a CALIBRATED ESTIMATE, not a measurement: there is no EGT or housing sensor on
 * the bus. The absolute numbers are tuned to land in believable ranges and the DYNAMICS -
 * how load and road speed move heat in vs out - are what the cool-down decision rides on.
 * Every constant is gathered in K so it can be re-baked from the on-car log (main.js writes
 * one line every 5 s: "turbo <T>C <rate>/min load .. in .. out .. spd .. boost .. amb ..").
 *
 * Model (all rates are deg C / s), integrated each sample with explicit Euler (dt <= ~0.25 s
 * live, so it is unconditionally stable here):
 *
 *   load  = boost + brake-power blend (0 idle .. ~1.2 full enrichment)
 *   mdot  = rpmFrac * (0.15 + 0.85*load)         exhaust mass-flow proxy (idle floor)
 *   Tgas  = amb + egtIdle + egtLoad*load + egtEnrich*enrich(load)   gas the metal is driven toward
 *   heat  = kHeat * flow * (Tgas - T)            signed: cooler gas after a lift draws heat out
 *   cConv = (kConv0 + kConvV*speed^0.8)*(T-amb)  forced airflow cooling  <-- the road-speed term
 *   cRad  = kRad * ((T/1000)^4 - (amb/1000)^4)   radiation (speed-independent, matters when glowing)
 *   cOil  = kOil * max(0, T - oil)   while running; STOPS at shutdown -> heat-soak
 *   dT/dt = heat - cConv - cRad - cOil
 */

const isNum = (x) => typeof x === 'number' && isFinite(x);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// --- calibration constants (first pass; re-bake from the on-car log) ---
const K = {
    // exhaust gas temperature the housing is driven toward (deg C above ambient)
    egtIdle: 360,       // light-load idle EGT rise over ambient
    egtLoad: 430,       // linear rise with load 0..1
    egtEnrich: 280,     // extra rise from fuel enrichment above the knee
    enrichKnee: 0.8,    // load above which enrichment (the EGT spike) starts
    // heat transfer (per second)
    kHeat: 0.030,       // gas <-> metal, scaled by the mass-flow proxy and (Tgas - T)
    flowFloor: 0.25,    // gas keeps touching the housing even at idle (floor on the flow term)
    kRad: 0.42,         // radiation, on ((T+273)/1000)^4 difference
    kConv0: 0.005,      // natural / fan convection at a standstill
    kConvV: 0.0006,     // forced convection, times speed(km/h)^0.8  <-- the road-speed term
    kOil: 0.007,        // oil / water cooling while the engine runs (stops at shutdown -> soak)
    minRunRpm: 300,     // below this the engine is off: no exhaust heat, no oil cooling
    tau: 3,             // s, smoothing of the displayed rate
};

class TurboThermal {
    constructor(opts) {
        opts = opts || {};
        this.ratedKw = opts.ratedKw || 230;
        this.boostMax = opts.boostMax || 1.4;
        this.redline = opts.redline || 7000;
        this.ambientFallback = isNum(opts.ambientFallback) ? opts.ambientFallback : 20;
        this.reset();
    }

    reset() {
        this.T = null; this.dTdt = null;
        this.heatIn = 0; this.heatOut = 0; this.load = 0; this.Tgas = null; this.running = false;
    }

    update(d, dt) {
        d = d || {};
        const amb = isNum(d.ambient) ? d.ambient : this.ambientFallback;
        if (this.T == null) {                                   // start cold, at the best ambient we have
            this.T = clamp(isNum(d.ambient) ? d.ambient : (isNum(d.coolant) ? d.coolant : amb), -40, 1100);
        }
        if (!(dt > 0)) return this;
        dt = Math.min(dt, 1);                                   // guard against a long stall

        const rpm = isNum(d.rpm) ? d.rpm : 0;
        const running = rpm >= K.minRunRpm;

        // load: prefer boost (gauge bar) when present, blended with brake-power fraction
        const pkW = (isNum(d.torque) && rpm > 0) ? d.torque * rpm / 9549 : 0;
        const powFrac = clamp(pkW / Math.max(1, this.ratedKw), 0, 1.4);
        let load;
        if (isNum(d.boost)) {
            const boostFrac = clamp(d.boost / Math.max(0.1, this.boostMax), 0, 1.3);   // vacuum -> 0
            load = clamp(0.5 * boostFrac + 0.5 * powFrac, 0, 1.4);
        } else {
            load = powFrac;
        }
        this.load = load;

        const rpmFrac = clamp(rpm / Math.max(1000, this.redline), 0, 1.1);
        const mdot = running ? clamp(rpmFrac * (0.15 + 0.85 * load), 0.02, 1.3) : 0;
        const flow = running ? (K.flowFloor + (1 - K.flowFloor) * mdot) : 0;
        const enrich = Math.max(0, load - K.enrichKnee);
        const Tgas = amb + K.egtIdle + K.egtLoad * load + K.egtEnrich * enrich;
        this.Tgas = Tgas;

        const T = this.T;
        const spd = Math.max(0, isNum(d.speed) ? d.speed : 0);
        const heat = K.kHeat * flow * (Tgas - T);               // signed
        const cConv = (K.kConv0 + K.kConvV * Math.pow(spd, 0.8)) * (T - amb);
        const cRad = K.kRad * (Math.pow((T + 273.15) / 1000, 4) - Math.pow((amb + 273.15) / 1000, 4));
        const cOil = (running && isNum(d.oil)) ? K.kOil * Math.max(0, T - d.oil) : 0;
        const dTdt = heat - cConv - cRad - cOil;

        this.T = clamp(T + dTdt * dt, amb - 5, 1100);
        this.heatIn = Math.max(0, heat);                        // what the exhaust is adding
        this.heatOut = Math.max(0, cConv) + Math.max(0, cRad) + cOil + Math.max(0, -heat);  // what is being rejected
        this.running = running;
        const a = 1 - Math.exp(-dt / K.tau);
        this.dTdt = this.dTdt == null ? dTdt : this.dTdt + (dTdt - this.dTdt) * a;
        return this;
    }

    /** Predicted seconds until T falls to cokeTemp at the current (smoothed) rate; null if not cooling. */
    secondsToSafe(cokeTemp) {
        if (!isNum(this.T)) return null;
        if (this.T <= cokeTemp) return 0;
        const r = this.dTdt;
        if (!isNum(r) || r >= -0.05) return null;               // rising or barely moving: no honest estimate
        return clamp((this.T - cokeTemp) / -r, 0, 5999);
    }
}

module.exports = { TurboThermal, K };
