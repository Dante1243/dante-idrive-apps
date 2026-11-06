'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - warm-up calculator: minutes until oil / coolant are warm,
 *     from the measured warm-up rate (typical rates until enough is measured),
 *     projected on the trend graph; "engine off" when a hybrid drives electric
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - 20-minute temperature trend
 *   - turbo cool-down from a live heat model (turbo_thermal.js): estimates the turbine /
 *     downpipe temperature from load, rpm, boost and - crucially - road speed (airflow
 *     cooling), and says when it has cooled below a coking-safe temperature. A real
 *     heat-in vs heat-out balance, not a fixed timer (see THERMAL.md); a calibrated
 *     estimate, tunable on-car from the "turbo ..." log line
 *   - optional oil telltale on the instrument cluster (setting "clusterBadge"):
 *     a blue icon while oil is below the warm threshold, an amber icon at/above the
 *     hot threshold ("hotOil"), drawn through cluster-render when installed (CLUSTER.md).
 *     The cluster slot shows one thing at a time, so while the icon is up the stock
 *     widget (media/now-playing) is hidden; "clusterShow" limits this to cold/hot/both.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ClusterBadge } = require('./cluster_badge');
const { TurboThermal } = require('./turbo_thermal');

const W = 1600, H = 520;
const GO = '#2fd27a';
// typical warm-up rates (deg C / min) until enough has been measured
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 } };

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque', 'boost', 'ambient']);

        /* ---------- turbo / downpipe heat model (turbo_thermal.js, THERMAL.md) ---------- */
        const turbo = new TurboThermal({
            ratedKw: settings.get('ratedKw'), boostMax: settings.get('boostMax'),
            redline: settings.get('redline'), ambientFallback: settings.get('ambientC'),
        });
        settings.onChange(() => {
            turbo.ratedKw = settings.get('ratedKw'); turbo.boostMax = settings.get('boostMax');
            turbo.redline = settings.get('redline'); turbo.ambientFallback = settings.get('ambientC');
        });

        /* ---------- cluster badge: oil telltale on the instrument cluster ---------- */
        // Needs robertnisipeanu's cluster-render installed; a no-op without it (see CLUSTER.md).
        // Position + size are live-tunable (clusterX / clusterY / clusterSize settings) so the
        // spot can be dialled in on the car, then baked as the defaults.
        let badge = null;
        const geom = () => ({ x: settings.get('clusterX'), y: settings.get('clusterY'), size: settings.get('clusterSize') });
        function badgeApply() {
            const on = settings.get('clusterBadge'), g = geom();
            if (on && !badge) badge = new ClusterBadge({ app: 'warmup', x: g.x, y: g.y, size: g.size, log: ctx.log });
            else if (!on && badge) { badge.close(); badge = null; }
            else if (badge) badge.setGeometry(g.x, g.y, g.size);      // live-tune position / size
        }
        // oil temperature -> which icon (never from demo data): cold below warm, hot at/above hot.
        // "clusterShow" limits which states take the cluster slot (it can show only one thing, so
        // the stock widget is hidden only while the icon is up): both | hot | cold.
        function clusterState(d) {
            if (d.demo || !G.isNum(d.oil)) return 'off';
            const mode = settings.get('clusterShow');
            if (d.oil >= settings.get('hotOil')) return mode === 'cold' ? 'off' : 'hot';
            if (d.oil < settings.get('warmOil')) return mode === 'hot' ? 'off' : 'cold';
            return 'off';
        }
        badgeApply();
        settings.onChange(badgeApply);
        process.on('exit', () => { if (badge) badge.close(); });

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant] every 5 s, 20 min; t = steady clock (mono)
        // the head unit sets its clock after start-up: wall-clock times can jump by hours, which
        // threw the trend lines across the screen. A steady clock only ever moves forward.
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };
        let lastHist = 0, lastT = 0, lastTurboLog = 0;
        car.onSample((d, t) => {
            // sample times (the demo replays late steps with theirs) are wall-clock: a step back counts as no time
            const dt = lastT ? G.clamp(t - lastT, 0, 250) / 1000 : 0, m = mono(); lastT = t;
            if (dt > 0) turbo.update(d, dt);        // live turbo / downpipe heat balance
            if (m - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = m; hist.push([m, d.oil, d.coolant, d.rpm, d.speed]);
                while (hist.length > 240) hist.shift();
            }
            // on-car calibration line: estimated temp, rate, balance and the inputs behind them
            if (G.isNum(turbo.T) && m - lastTurboLog > 5000) {
                lastTurboLog = m;
                const r = turbo.dTdt * 60;
                ctx.log.info('turbo ' + Math.round(turbo.T) + 'C ' + (r >= 0 ? '+' : '') + r.toFixed(0)
                    + '/min load ' + turbo.load.toFixed(2) + ' in ' + turbo.heatIn.toFixed(2) + ' out ' + turbo.heatOut.toFixed(2)
                    + ' spd ' + Math.round(G.isNum(d.speed) ? d.speed : 0) + ' boost ' + (G.isNum(d.boost) ? d.boost.toFixed(2) : '-')
                    + ' amb ' + (G.isNum(d.ambient) ? Math.round(d.ambient) : '-'));
            }
            // cluster telltale: cold below the warm threshold, hot at/above the hot threshold
            if (badge) badge.setState(clusterState(d));
        }, () => { hist.length = 0; turbo.reset(); if (badge) badge.setState('off'); });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        function limit(oil) {
            const warm = settings.get('warmOil'), red = settings.get('redline'), cold = Math.min(settings.get('coldLimit'), red);
            if (!G.isNum(oil)) return null;
            if (oil >= warm) return red;
            return Math.round((cold + (red - cold) * G.clamp((oil - 30) / (warm - 30), 0, 1)) / 100) * 100;
        }

        /** deg C per minute over the last ~3 min (least squares) and the time it covers (ms). */
        function measured(idx) {
            const last = hist.length ? hist[hist.length - 1][0] : 0;
            const pts = hist.filter((h) => G.isNum(h[idx]) && last - h[0] < 180000);
            if (pts.length < 4) return { rate: null, span: 0 };
            const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[idx], 0) / n;
            let num = 0, den = 0;
            pts.forEach((p) => { num += (p[0] - mx) * (p[idx] - my); den += (p[0] - mx) * (p[0] - mx); });
            return { rate: den ? num / den * 60000 : null, span: pts[n - 1][0] - pts[0][0] };
        }

        /**
         * Warm-up estimate for 'oil' / 'coolant': { state, min, rate, est }.
         * state: ready | warming | off (engine not running) | stalled (not getting warmer).
         * The typical rate is blended into the measured one over the first 2 minutes (est = mostly typical).
         */
        function eta(key, temp, target, d) {
            if (!G.isNum(temp)) return { state: 'none' };
            if (temp >= target) return { state: 'ready' };
            if (G.isNum(d.rpm) && d.rpm < 300) return { state: 'off' };
            const m = measured(key === 'oil' ? 1 : 2);
            const typ = TYPICAL[key][G.isNum(d.speed) && d.speed > 10 ? 'drive' : 'idle'];
            const w = G.clamp(m.span / 120000, 0, 1);
            const rate = G.isNum(m.rate) ? w * m.rate + (1 - w) * typ : typ;
            if (w > 0.8 && rate < 0.15) return { state: 'stalled', rate };
            const min = (target - temp) / Math.max(0.15, rate);
            return { state: 'warming', min, rate, est: w < 0.5 };
        }

        /* ---------- drawing ---------- */
        /**
         * Temperature as a tach bar (Redline style), 0-150 deg C in 10 deg segments in the tach colours
         * (blue -> purple -> red at 120 deg C, solid red above); cold / warn / crit zones tint the
         * track, green mark where it counts as warm.
         */
        function gauge(cv, t, y, h, val, label, warm) {
            const st = F() ? 18 : 10;
            G.segBar(cv, t, 24, y, 880, h, {
                label, value: T(val), unit: tU(), decimals: 0, min: T(0), max: T(150), step: st, scale: { every: st * 2.5 },
                zones: [{ from: T(120), to: T(135), color: 'warn' }, { from: T(135), to: T(160), color: 'crit' }],
                ramp: 'hot', limit: T(120), marks: [{ value: T(warm), color: GO }],
            });
        }

        /** One "ready in" row: label + target, big minutes (or the state), a reason on the right. */
        function etaRow(cv, t, y, label, e, target) {
            cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            let big, col = t.text, right = '', unit = '';
            if (e.state === 'ready') { big = 'READY'; col = GO; }
            else if (e.state === 'off') { big = 'ENGINE OFF'; col = t.dim; right = 'electric driving'; }
            else if (e.state === 'stalled') { big = 'NOT WARMING'; col = t.warn; right = 'drive to warm up'; }
            else if (e.state === 'warming') { big = e.min > 60 ? '>60' : '~' + Math.max(1, Math.round(e.min)); unit = 'min'; }
            else { big = '--'; col = t.dim; }
            // the large number font has digits and a few letters only: words in bold, minutes in num + 'min'
            const bw = cv.text(big, 952, y + 50, unit ? 52 : 40, col, { font: unit || big === '--' ? 'num' : 'bold', spacing: unit ? 0 : 1 });
            if (unit) cv.text(unit, 960 + bw, y + 50, 26, t.dim);
            if (right) cv.text(right, 1552, y + 48, 24, t.dim, { align: 'right' });
            cv.text('target ' + Math.round(T(target)) + tU(), 1552, y, 22, t.dim, { align: 'right' });
        }

        function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            const warm = settings.get('warmOil'), warmC = settings.get('warmCoolant');
            // the room below the page (on the car, with no bar under it): half to each gauge; the coolant
            // panel ends at the page's bottom, and G.panel adds the room back to it
            const room = G.pageBottom(cv) - G.BOTTOM, half = Math.round(room / 2);
            gauge(cv, t, G.TOP, 225 + half, d.oil, 'Oil', warm);
            gauge(cv, t, G.TOP + 242 + half, 225 - half, d.coolant, 'Coolant', warmC);

            // ---- status panel
            const sp = G.panel(cv, t, 928, 44, 648, 468, null);
            const lim = limit(d.oil);
            const ready = G.isNum(d.oil) && d.oil >= warm;
            const hot = G.isNum(d.oil) && d.oil > 125;
            const coke = settings.get('cokeTemp');
            const haveT = G.isNum(turbo.T);
            const useTurbo = settings.get('cooldown') && haveT;
            const soaked = useTurbo && turbo.T > coke;         // turbo still too hot to switch off
            const rateMin = haveT ? turbo.dTdt * 60 : 0;        // deg C / min (smoothed)
            const shedding = rateMin < -3;                      // matches secondsToSafe's cooling cutoff
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (soaked) { st = shedding ? 'TURBO COOL-DOWN' : 'TURBO HOT'; col = t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 114, st.length > 14 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            if (soaked) {
                // turbo above the coking-safe temp: estimated temp, the live heat balance, and the predicted wait
                const secs = turbo.secondsToSafe(coke);
                const eo = eta('oil', d.oil, warm, d);
                const oilLine = eo.state === 'ready' ? 'Oil warm' : eo.state === 'warming' ? 'Oil ready in ~' + Math.max(1, Math.round(eo.min)) + ' min' : '';
                if (oilLine) cv.text(oilLine, 952, 170, 24, eo.state === 'ready' ? GO : t.dim, { font: 'bold' });
                cv.text('TURBO ~' + Math.round(T(turbo.T)) + tU(), 952, 210, 22, t.dim, { font: 'bold', spacing: 1.5 });
                if (shedding && G.isNum(secs)) {
                    // big: predicted seconds until coking-safe at the CURRENT speed
                    const lw = cv.text(String(Math.ceil(secs)), 952, 289, 80, t.text, { font: 'num' });
                    cv.text('s', 962 + lw, 289, 30, t.dim);
                    cv.text('to safe - keep moving', 1552, 262, 24, t.text, { align: 'right', font: 'bold' });
                } else {
                    // not shedding fast enough for a countdown: show the actual signed rate and nudge for airflow
                    cv.text((rateMin >= 0 ? '+' : '') + Math.round(rateMin) + tU() + '/min', 952, 285, 44, t.warn, { font: 'bold' });
                    const hint = rateMin >= 1 ? (G.isNum(d.speed) && d.speed > 5 ? 'still soaking' : 'get airflow to cool')
                        : 'cooling slowly - keep moving';
                    cv.text(hint, 1552, 262, 24, t.warn, { align: 'right', font: 'bold' });
                }
                // heat-out share of the balance: full green = all heat is being rejected (cooling)
                const inOut = turbo.heatIn + turbo.heatOut;
                const f = inOut > 0 ? G.clamp(turbo.heatOut / inOut, 0, 1) : 1;
                cv.roundRect(952, 303, 600, 12, 6, t.track);
                if (f > 0) cv.rampRect(952, 303, Math.max(12, 600 * f), 12, 6, [t.warn, GO], 952, 600);
            } else {
                etaRow(cv, t, 170, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaRow(cv, t, 255, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
                // one turbo line once the model has a reading and the turbo is below the safe temp
                if (useTurbo) cv.text('Turbo ~' + Math.round(T(turbo.T)) + tU() + (turbo.T <= coke ? ' - OK to switch off' : ''),
                    952, 325, 20, turbo.T <= coke ? GO : t.dim, { font: 'bold' });
            }

            // ---- safe rev limit (always) + trend
            const red = settings.get('redline'), fl = lim ? lim / red : 0;
            cv.text('SAFE REV LIMIT', 952, 350, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(lim ? lim + ' rpm' : '---- rpm', 1552, 352, 26, ready ? GO : t.text, { align: 'right', font: 'bold' });
            cv.roundRect(1160, 340, 230, 8, 4, t.track);
            if (fl > 0) cv.roundRect(1160, 340, 230 * fl, 8, 4, ready ? GO : col);

            // trend: last minutes (steady clock, see mono) + up to 5 min projected; nothing is drawn outside the graph
            // (it grows with the status panel where that goes on down to the screen's bottom)
            const gx = 952, gy = 398, gw = 600, gh = 90 + sp.h - 468, nowX = gx + gw - 90;
            const now0 = hist.length ? hist[hist.length - 1][0] : mono();
            const span = G.clamp(hist.length ? now0 - hist[0][0] : 0, 300000, 1200000);
            const ahead = 300000;                                  // projection: up to 5 min ahead
            const lo = 0, hi = 140;
            const X = (ts) => nowX - ((now0 - ts) / span) * (gw - 90), Y = (c) => gy + gh - (G.clamp(c, lo, hi) - lo) / (hi - lo) * gh;
            cv.fillRect(gx, gy - 20, 22, 4, t.oil || t.accent); cv.text('OIL', gx + 30, gy - 11, 20, t.dim, { font: 'bold' });
            cv.fillRect(gx + 100, gy - 20, 22, 4, t.cold); cv.text('COOLANT', gx + 130, gy - 11, 20, t.dim, { font: 'bold' });
            cv.fillRect(gx, Y(warm), gw, 1, withAlpha(GO, 0.5));
            cv.text(String(Math.round(T(warm))), gx + gw + 4, Y(warm) + 7, 20, GO);
            cv.fillRect(nowX, gy, 1, gh, withAlpha(t.tick, 0.5));       // "now"
            [[1, t.oil || t.accent, 'oil', warm, d.oil], [2, t.cold, 'coolant', warmC, d.coolant]].forEach(([i, c, key, target, cur]) => {
                const pts = hist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]).filter((p) => p[0] >= gx && p[0] <= nowX + 0.5);
                if (pts.length > 1) cv.polyline(pts, 3, c);
                // projection to the target, dashed
                const e = eta(key, cur, target, d);
                if (e.state === 'warming' && pts.length) {
                    const x0 = nowX, y0 = Y(cur), mins = Math.min(e.min, ahead / 60000);
                    const x1 = x0 + (mins * 60000 / ahead) * 90, y1 = Y(cur + e.rate * mins);
                    for (let k = 0; k < 6; k++) {
                        const a = k / 6, b = (k + 0.5) / 6;
                        cv.line(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, 2, withAlpha(c, 0.8));
                    }
                }
            });
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
            G.frame(cv, t, ['Warm-up'], 0, [d.demo && { text: 'DEMO' }]);     // G20-style frame
            return ui.image('MAIN_GFX', cv);
        }

        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software (PNG frames)
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
