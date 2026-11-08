'use strict';

// Warm-Up's turbo model against published measurements, so its numbers cannot drift off what real
// gasoline turbos were measured doing. No SDK or vehicle needed:
//   node kit/tools/test_turbo_thermal.js
//
// [M] Savaripour, Alaviyoun, Rosen, "Thermal Investigation of a Turbocharger Using IR Thermography",
//     Clean Technologies 4(2), 2022, https://doi.org/10.3390/cleantechnol4020019 (Figs 15 and 17 digitised)
// [A] Aghaali, "On-Engine Turbocharger Performance Considering Heat Transfer", KTH 2012 (Table 7.1, Table 4.3)
// [H] The heat-soak test cited in apps/warmup/THERMAL.md: bearing housing +60 C after shutdown to 220 C

const assert = require('assert');
const path = require('path');
const { TurboThermal, K } = require(path.join(__dirname, '..', '..', 'apps', 'warmup', 'turbo_thermal.js'));

const BENCH = { bayView: 1 };                     // an open test cell: no shield or engine bay around it
const bench = (litres) => new TurboThermal({ litres, k: BENCH });
const at = (curve, t) => {
    for (let i = 1; i < curve.length; i++) {
        if (t <= curve[i][0]) { const [a, b] = curve[i - 1], [c, e] = curve[i]; return b + (e - b) * (t - a) / (c - a); }
    }
    return curve[curve.length - 1][1];
};
function run(tt, d, seconds, dt) {
    dt = dt || 0.25;
    for (let t = 0; t < seconds; t += dt) tt.update(d, dt);
    return tt;
}
/** Holds the gas at a measured temperature, whatever the model's own map says, to test the metal alone. */
function withGas(tt, Tg, flow) {
    tt.operating = () => ({ running: true, flow: flow / 1000, fuelKw: 0, Tg, T4: Tg - 40, cut: false });
    return tt;
}

// [M] Fig 15: engine stopped from 5500 rpm full load. Mean of its two lines on the turbine housing.
const COOL_L1 = [[0, 643], [30, 609], [75, 576], [100, 556], [150, 510], [200, 481], [250, 464], [300, 446], [350, 431], [403, 418], [435, 413], [448, 410]];
const COOL_L2 = [[0, 722], [15, 695], [43, 668], [73, 639], [102, 618], [120, 602], [152, 572], [165, 552], [181, 532], [212, 517], [240, 504], [268, 491], [300, 472], [350, 457], [388, 438], [421, 430], [448, 425]];
const COOL = (t) => (at(COOL_L1, t) + at(COOL_L2, t)) / 2;
// [M] Fig 17: cold start straight to 2000 rpm, 28 Nm. Mean of its two lines.
const WARM_L1 = [[0, 8], [30, 35], [60, 50], [90, 83], [110, 110], [135, 150], [185, 226], [235, 288], [257, 305], [300, 336], [400, 380], [450, 393], [475, 410], [555, 425], [620, 437], [700, 446], [785, 458], [820, 463]];
const WARM_L2 = [[0, 8], [28, 30], [55, 55], [105, 115], [135, 147], [165, 177], [190, 183], [200, 198], [215, 207], [235, 236], [320, 280], [400, 318], [485, 358], [565, 400], [645, 405], [675, 418], [745, 422], [770, 430], [820, 437]];
const WARM = (t) => (at(WARM_L1, t) + at(WARM_L2, t)) / 2;

const near = (got, want, tol, what) => assert(Math.abs(got - want) <= tol, what + ': got ' + got.toFixed(1) + ', measured ' + want + ' (+/-' + tol + ')');
const OFF = { rpm: 0, torque: 0, speed: 0, coolant: 90, oil: 95, ambient: 25 };

const checks = [
    ['[M] engine-off cool-down follows the measured curve', () => {
        const tt = bench(1.7);
        tt.update(OFF, 0);
        tt.Th = COOL(0); tt.Tb = 140; tt.Td = 500;
        let sq = 0, n = 0, worst = 0;
        for (let t = 0; t <= 440; t += 1) {
            const e = tt.Th - COOL(t);
            sq += e * e; n++; worst = Math.max(worst, Math.abs(e));
            tt.update(OFF, 1);
        }
        const rms = Math.sqrt(sq / n);
        console.log('    cool-down rms ' + rms.toFixed(1) + ' C, worst ' + worst.toFixed(1) + ' C over 440 s');
        assert(rms < 15 && worst < 30, 'cool-down off the measurement: rms ' + rms.toFixed(1) + ', worst ' + worst.toFixed(1));
    }],
    ['[M] the housing is still above 400 C 7 minutes after a full-load stop', () => {
        const tt = bench(1.7);
        tt.update(OFF, 0);
        tt.Th = COOL(0); tt.Tb = 140; tt.Td = 500;
        run(tt, OFF, 420, 1);
        assert(tt.Th > 400, 'after 420 s: ' + tt.Th.toFixed(0));
    }],
    ['[A] 625 C gas holds a 419 C wall, 848 C holds 617 C', () => {
        const air = { rpm: 2000, torque: 50, speed: 20, coolant: 20, oil: 55, ambient: 21 };   // their water ran at 16 C
        const low = withGas(bench(2.0), 625, 12);
        run(low, air, 3000, 1);
        near(low.Th, 419, 40, '625 C gas');
        const high = withGas(bench(2.0), 848, 44);
        run(high, air, 3000, 1);
        near(high.Th, 617, 40, '848 C gas');
        console.log('    wall ' + low.Th.toFixed(0) + ' C (measured 419), ' + high.Th.toFixed(0) + ' C (measured 617)');
    }],
    ['[M] full load: a wall around 720 C, the bearing housing 122-155 C', () => {
        const tt = withGas(bench(1.7), 930, 130);
        run(tt, { rpm: 5500, torque: 200, speed: 20, coolant: 95, oil: 110, ambient: 25 }, 3000, 1);
        near(tt.Th, 720, 50, 'wall');
        near(tt.Tb, 138, 25, 'bearing housing');
        console.log('    wall ' + tt.Th.toFixed(0) + ' C (measured 643-722 average, 839 at the hottest), bearing ' + tt.Tb.toFixed(0) + ' C (measured 122-155)');
    }],
    ['[M] warm-up at 2000 rpm, 28 Nm follows the measured climb', () => {
        const tt = bench(1.7), d = { rpm: 2000, torque: 28, speed: 20, coolant: 20, oil: 20, ambient: 10 };
        tt.update(d, 0);
        tt.Th = 8; tt.Tb = 8; tt.Td = 8;
        let sq = 0, n = 0;
        for (let t = 0; t <= 820; t += 1) {
            d.coolant = Math.min(90, 20 + t * 0.09); d.oil = Math.min(90, 20 + t * 0.07);
            const e = tt.Th - WARM(t);
            sq += e * e; n++;
            tt.update(d, 1);
        }
        const rms = Math.sqrt(sq / n);
        console.log('    warm-up rms ' + rms.toFixed(1) + ' C, reaching ' + tt.Th.toFixed(0) + ' C at 820 s (measured ' + WARM(820).toFixed(0) + ')');
        assert(rms < 60, 'warm-up off the measurement: rms ' + rms.toFixed(1));
    }],
    ['[M] the hot spot at full load is near the 839 C measured, above the average', () => {
        const tt = withGas(bench(1.7), 930, 130);
        run(tt, { rpm: 5500, torque: 200, speed: 20, coolant: 95, oil: 110, ambient: 25 }, 3000, 1);
        near(tt.Thot, 839, 30, 'hot spot');
        assert(tt.Thot > tt.Th + 60, 'hot spot ' + tt.Thot.toFixed(0) + ' barely above the average ' + tt.Th.toFixed(0));
        console.log('    hot spot ' + tt.Thot.toFixed(0) + ' C (measured 839), average ' + tt.Th.toFixed(0) + ' C');
    }],
    ['G20 330i stage 1: full throttle makes the turbo glow well inside 30 s, idle never does', () => {
        const tt = new TurboThermal({ litres: 2.0 }), base = { coolant: 95, oil: 105, ambient: 15 };
        run(tt, Object.assign({ rpm: 2000, torque: 80, speed: 100 }, base), 600, 0.1);
        assert(!tt.glowing, 'glowing at a 2000 rpm cruise: ' + tt.Thot.toFixed(0));
        let glowAt = null;
        for (let t = 0.1; t <= 30; t += 0.1) {
            const rpm = 2500 + 4000 * (t % 10) / 10;
            tt.update(Object.assign({ rpm, torque: rpm <= 4500 ? 450 : 450 - (rpm - 4500) * 0.06, speed: 80 + t * 4 }, base), 0.1);
            if (glowAt === null && tt.glowing) glowAt = t;
        }
        assert(glowAt !== null && glowAt < 15, 'glow at ' + glowAt);
        assert(tt.Thot > 750, 'hot spot after 30 s ' + tt.Thot.toFixed(0));
        run(tt, Object.assign({ rpm: 750, torque: 20, speed: 0 }, base), 120, 0.25);
        assert(!tt.glowing && Math.abs(tt.Thot - tt.Th) < 30, 'still glowing after 2 min idle: ' + tt.Thot.toFixed(0) + ' / ' + tt.Th.toFixed(0));
        const idle = new TurboThermal({ litres: 2.0 });
        run(idle, { rpm: 750, torque: 20, speed: 0, coolant: 95, oil: 100, ambient: 30 }, 3000, 1);
        assert(idle.Thot < 400, 'idle hot spot ' + idle.Thot.toFixed(0));
        console.log('    glowing after ' + glowAt.toFixed(1) + ' s of full throttle, hot spot ' + tt.Thot.toFixed(0) + ' C two minutes after, idle ' + idle.Thot.toFixed(0) + ' C');
    }],
    ['the thin downpipe glows under full throttle, not at a cruise', () => {
        const tt = new TurboThermal({ litres: 2.0 }), base = { coolant: 95, oil: 105, ambient: 15 };
        run(tt, Object.assign({ rpm: 2300, torque: 120, speed: 110 }, base), 900, 0.25);
        assert(!tt.pipeGlowing, 'downpipe glowing at 110 km/h: ' + tt.Tp.toFixed(0));
        let at = null;
        for (let t = 0.1; t <= 40; t += 0.1) { tt.update(Object.assign({ rpm: 5500, torque: 450, speed: 160 }, base), 0.1); if (at === null && tt.pipeGlowing) at = t; }
        assert(at !== null && at < 30, 'downpipe glow at ' + at);
        assert(tt.Tp > tt.Td, 'the thin pipe should lead the heavy downpipe and catalyst: ' + tt.Tp.toFixed(0) + ' / ' + tt.Td.toFixed(0));
        console.log('    downpipe glows after ' + at.toFixed(1) + ' s of full throttle, ' + tt.Tp.toFixed(0) + ' C at 40 s');
    }],
    ['the DME catalyst figure corrects the gas temperature, steadily, per flow band', () => {
        const base = { coolant: 95, oil: 105, ambient: 15 };
        const truth = new TurboThermal({ litres: 2.0 }), tt = new TurboThermal({ litres: 2.0 });
        truth.correction = () => 120;                    // the real engine runs its gas 120 C hotter than the map
        const drive = (d, secs) => { let worst = 0; for (let i = 0; i < secs * 10; i++) { truth.update(d, 0.1); tt.update(Object.assign({ catDme: truth.Tc }, d), 0.1); worst = Math.max(worst, ...tt.learn.map(Math.abs)); } return worst; };
        const worst = drive(Object.assign({ rpm: 2000, torque: 80, speed: 100 }, base), 900);
        assert(tt.learning, 'not learning at a cruise');
        near(tt.Tc, truth.Tc, 25, 'catalyst after 15 min cruise');
        assert(worst < 200, 'learning overshot: ' + worst.toFixed(0));
        drive(Object.assign({ rpm: 5500, torque: 450, speed: 160 }, base), 60);
        near(tt.Tg, truth.Tg, 30, 'gas after a minute at full load');
        // without the DME it keeps what it learned, and stops claiming it is live
        const before = tt.learn.slice();
        run(tt, Object.assign({ rpm: 2000, torque: 80, speed: 100 }, base), 30, 0.1);
        assert.deepStrictEqual(tt.learn, before);
        assert(!tt.learning, 'still says it is learning with no DME figure');
        console.log('    learned ' + tt.learn.map((x) => x.toFixed(0)).join(' / ') + ' C across the flow bands (truth +120)');
    }],
    ['no DME: the model is exactly what it was', () => {
        const a = new TurboThermal({ litres: 2.0 }), b = new TurboThermal({ litres: 2.0 });
        const d = { rpm: 4000, torque: 300, speed: 120, coolant: 95, oil: 110, ambient: 20 };
        run(a, d, 60); run(b, Object.assign({ catDme: null, afterCatDme: null }, d), 60);
        assert.strictEqual(a.Th, b.Th); assert(a.learn.every((x) => x === 0));
    }],
    ['[H] a hot stop soaks the bearing housing about 60 C, to around 220 C', () => {
        const tt = new TurboThermal({ litres: 2.0 });
        tt.update({ rpm: 5500, torque: 400, speed: 180, coolant: 105, oil: 120, ambient: 25 }, 0);
        tt.Th = 760; tt.Tb = 160; tt.Td = 620;
        const stop = { rpm: 0, torque: 0, speed: 0, coolant: 105, oil: 120, ambient: 25 };
        tt.update(stop, 0.25);
        const start = tt.Tb, peak = tt.soakPeak(tt._state());
        near(peak - start, 60, 20, 'soak rise');
        console.log('    bearing ' + start.toFixed(0) + ' -> ' + peak.toFixed(0) + ' C after a hot stop (measured +60 C to 220 C)');
    }],
    ['enrichment does not spike the gas: the map tops out at the 950 C limit', () => {
        const tt = new TurboThermal({ litres: 2.0 });
        const env = tt._env({ ambient: 20, coolant: 95, oil: 110, speed: 100 });
        const full = tt.operating({ rpm: 5500, torque: 390 }, env), mid = tt.operating({ rpm: 3000, torque: 200 }, env);
        assert(full.Tg <= 950 && full.Tg > mid.Tg, 'gas at full load ' + full.Tg);
    }],
    ['fuel maths lands on real figures for a 225 kW 2.0', () => {
        const tt = new TurboThermal({ litres: 2.0 });
        const env = tt._env({ ambient: 20, coolant: 95, oil: 100, speed: 110 });
        const litresPerHour = (op) => op.fuelKw * 1000 / K.lhv * 3600 / 0.745;
        const idle = tt.operating({ rpm: 750, torque: 20 }, env);
        const cruise = tt.operating({ rpm: 2300, torque: 87 }, env);
        const wot = tt.operating({ rpm: 5500, torque: 390 }, env);
        near(litresPerHour(idle), 1.0, 0.4, 'idle l/h');
        near(litresPerHour(cruise) / 110 * 100, 7.2, 1.2, 'cruise l/100 km');
        near(wot.flow * 1000, 250, 35, 'full-load exhaust flow g/s');
        console.log('    idle ' + litresPerHour(idle).toFixed(2) + ' l/h, cruise ' + (litresPerHour(cruise) / 110 * 100).toFixed(1) + ' l/100 km, full load ' + (wot.flow * 1000).toFixed(0) + ' g/s');
    }],
    ['the exhaust carries a realistic share of the fuel energy', () => {
        const tt = new TurboThermal({ litres: 2.0 });
        const go = (d) => { const t = new TurboThermal({ litres: 2.0 }); run(t, d, 5); return t.qExh / t.fuelKw; };
        const cruise = go({ rpm: 2300, torque: 87, speed: 110, coolant: 95, oil: 100, ambient: 20 });
        const wot = go({ rpm: 5500, torque: 390, speed: 150, coolant: 100, oil: 115, ambient: 20 });
        assert(cruise > 0.25 && cruise < 0.42, 'cruise share ' + cruise);
        assert(wot > 0.3 && wot < 0.48, 'full-load share ' + wot);
        console.log('    exhaust share of fuel energy: cruise ' + (cruise * 100).toFixed(0) + ' %, full load ' + (wot * 100).toFixed(0) + ' %');
        assert(tt);
    }],
    ['road speed sheds more heat, and a stopped car soaks', () => {
        const hot = (speed, rpm, torque) => {
            const t = new TurboThermal({ litres: 2.0 });
            t.update({ rpm, torque, speed, coolant: 95, oil: 110, ambient: 20 }, 0);
            t.Th = 650; t.Tb = 150; t.Td = 500;
            run(t, { rpm, torque, speed, coolant: 95, oil: 110, ambient: 20 }, 120, 0.5);
            return t.Th;
        };
        assert(hot(120, 2300, 87) < hot(0, 750, 20) + 80, 'speed makes no difference');
        const moving = new TurboThermal({ litres: 2.0 }), still = new TurboThermal({ litres: 2.0 });
        [moving, still].forEach((t, i) => { const d = { rpm: 750, torque: 20, speed: i ? 0 : 110, coolant: 95, oil: 105, ambient: 20 }; t.update(d, 0); t.Th = 600; t.Tb = 130; t.Td = 450; t.update(d, 0.25); });
        assert(moving.qOut > still.qOut * 1.2, 'rejected kW moving ' + moving.qOut.toFixed(2) + ', still ' + still.qOut.toFixed(2));
    }],
    ['the metal never goes below what surrounds it, and nothing blows up', () => {
        const tt = new TurboThermal({ litres: 2.0 });
        for (let i = 0; i < 40000; i++) {
            tt.update({ rpm: i % 4000 < 2000 ? 6500 : 0, torque: i % 4000 < 2000 ? 390 : 0, speed: (i % 7000) / 40, coolant: 95, oil: 110, ambient: 20 }, 0.25);
            assert(isFinite(tt.Th) && isFinite(tt.Td) && isFinite(tt.Tb), 'not finite at ' + i);
            assert(tt.Th < 960 && tt.Th > 15, 'housing out of range: ' + tt.Th);
            assert(isFinite(tt.Thot) && tt.Thot < 960 && tt.Thot >= tt.Th, 'hot spot out of range: ' + tt.Thot);
        }
    }],
    ['missing signals: no torque, no ambient, no boost still runs', () => {
        const tt = new TurboThermal({ litres: 2.0, ambientFallback: 15 });
        run(tt, { rpm: 2000 }, 30);
        assert(isFinite(tt.Th) && isFinite(tt.soak));
        tt.reset();
        assert.strictEqual(tt.Th, null);
        tt.update({}, 0.25);
        assert(isFinite(tt.Th));
    }],
    ['a boost field that never moves is ignored', () => {
        const stuck = new TurboThermal({ litres: 2.0 }), none = new TurboThermal({ litres: 2.0 });
        const d = { rpm: 5000, torque: 350, speed: 120, coolant: 95, oil: 110, ambient: 20 };
        run(stuck, Object.assign({ boost: 0 }, d), 60);
        run(none, d, 60);
        assert.strictEqual(stuck.boostOk, false);
        assert(Math.abs(stuck.Td - none.Td) < 0.01, 'stuck boost changed the result');
    }],
];

let failed = 0;
for (const [name, fn] of checks) {
    try { fn(); console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); }
}
if (failed) { console.error(failed + ' of ' + checks.length + ' failed'); process.exit(1); }
console.log('Turbo model checks passed (' + checks.length + ').');
