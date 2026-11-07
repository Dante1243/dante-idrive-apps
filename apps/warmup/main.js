'use strict';
/**
 * Warm-Up - know when the engine is ready to be used, and when it has cooled.
 *
 *   Warm-up page
 *   - oil + coolant gauges (oil is what matters: it lags coolant by minutes)
 *   - warm-up calculator: minutes until oil / coolant are warm,
 *     from the measured warm-up rate (typical rates until enough is measured),
 *     projected on the trend graph; "engine off" when a hybrid drives electric
 *   - safe rev limit that climbs from the cold limit to the redline with oil temp
 *   - 20-minute temperature trend
 *
 *   Turbo page
 *   - a live heat balance from rpm, torque and road speed (turbo_thermal.js, THERMAL.md): the kW the
 *     exhaust is carrying, the kW going into the turbo and downpipe, the kW being rejected, and an
 *     estimate of their temperatures. Fitted to published measurements, but an estimate: no car in
 *     this family has an exhaust temperature sensor to check it against
 *   - cool-down: where the bearing housing would peak if you switched off now, and how long until
 *     that is under the limit
 *
 *   Cluster page
 *   - the instrument cluster's display slots, and a check of what the oil icon does to them
 *     (slot_lab.js, CLUSTER.md), for finding a slot on this car that steals nothing
 *
 *   Optional oil telltale on the instrument cluster (setting "clusterBadge"): a blue icon while oil
 *   is below the warm threshold, an amber icon at/above the hot threshold ("hotOil"), drawn through
 *   cluster-render when installed. In its stock slot the icon hides the media widget, so by default
 *   it only shows for a few seconds ("clusterHold"); "clusterShow" limits it to cold/hot/both.
 */
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const Car = require('./kit/car');
const { ClusterBadge } = require('./cluster_badge');
const { TurboThermal } = require('./turbo_thermal');
const { SlotLab, parseStatus, snapshot, explain, hex } = require('./slot_lab');

let ClusterRender = null;
try { ({ ClusterRender } = require('./kit/cluster_render')); } catch (e) { /* no net */ }

const W = 1600, H = 520;
const GO = '#2fd27a';
const PAGES = ['Warm-up', 'Turbo', 'Cluster'];
// typical warm-up rates (deg C / min) until enough has been measured
const TYPICAL = { oil: { drive: 4, idle: 1.5 }, coolant: { drive: 7, idle: 3 } };
const BRIEF_MS = 10000;             // "clusterHold" brief: how long the icon stays...
const BRIEF_AGAIN_MS = 300000;      // ...and how often hot oil brings it back
const TEST_MS = 7000;               // Test icon: how long the icon stays up while the slots are watched
const LAB_READ_MS = 2000;           // how often the Cluster page reads the slots
const LAB_KEEP_MS = 30000;          // a trial runs out by itself; this keeps it alive while parked

mgu.run({
    async start(ctx) {
        const { ui, settings } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'temps', 'torque', 'boost', 'ambient']);
        const mono = () => { const h = process.hrtime(); return h[0] * 1000 + h[1] / 1e6; };

        /* ---------- turbo / downpipe heat balance (turbo_thermal.js, THERMAL.md) ---------- */
        const turbo = new TurboThermal({ litres: settings.get('engineL'), ambientFallback: settings.get('ambientC') });
        settings.onChange(() => { turbo.litres = settings.get('engineL'); turbo.ambientFallback = settings.get('ambientC'); });

        /* ---------- cluster badge: oil telltale on the instrument cluster ---------- */
        // Needs robertnisipeanu's cluster-render installed; a no-op without it (see CLUSTER.md).
        // Position + size are live-tunable (clusterX / clusterY / clusterSize settings) so the
        // spot can be dialled in on the car, then baked as the defaults.
        const lab = new SlotLab({ log: ctx.log });
        let badge = null, test = null;                 // test: the Test icon check under way
        const forced = () => !!test || !!lab.trial;     // the check and a trial show the icon whatever the oil
        const geom = () => ({ x: settings.get('clusterX'), y: settings.get('clusterY'), size: settings.get('clusterSize') });
        function badgeApply() {
            const on = settings.get('clusterBadge') || forced(), g = geom();
            if (on && !badge) badge = new ClusterBadge({ app: 'warmup', x: g.x, y: g.y, size: g.size, log: ctx.log });
            else if (!on && badge) { badge.close(); badge = null; }
            else if (badge) badge.setGeometry(g.x, g.y, g.size);      // live-tune position / size
            if (badge) badge.setTestCard(!!lab.trial);
        }
        // oil temperature -> which icon (never from demo data): cold below warm, hot at/above hot.
        // "clusterShow" limits which states show.
        function clusterState(d) {
            if (d.demo || !G.isNum(d.oil)) return 'off';
            const mode = settings.get('clusterShow');
            if (d.oil >= settings.get('hotOil')) return mode === 'cold' ? 'off' : 'hot';
            if (d.oil < settings.get('warmOil')) return mode === 'hot' ? 'off' : 'cold';
            return 'off';
        }
        // "clusterHold" brief: in its stock slot the icon hides the media widget, so it says its piece
        // and goes; hot oil comes back every few minutes, cold oil once per warm-up
        let briefState = 'off', briefAt = 0;
        function held(want, m) {
            if (settings.get('clusterHold') !== 'brief') return want;
            if (want === 'off') { briefState = 'off'; return 'off'; }
            if (want !== briefState) { briefState = want; briefAt = m; } else if (want === 'hot' && m - briefAt > BRIEF_AGAIN_MS) briefAt = m;
            return m - briefAt < BRIEF_MS ? want : 'off';
        }
        badgeApply();
        settings.onChange(badgeApply);
        process.on('exit', () => { if (lab.trial) lab.abort('app closed'); if (badge) badge.close(); });

        /* ---------- tracking ---------- */
        const hist = [];             // [t, oil, coolant] every 5 s, 20 min; t = steady clock (mono)
        const thist = [];            // [t, housing, downpipe], the same
        // the head unit sets its clock after start-up: wall-clock times can jump by hours, which
        // threw the trend lines across the screen. A steady clock only ever moves forward.
        let lastHist = 0, lastT = 0, lastLog = 0, lastKeep = 0;
        const parked = (d) => !d.demo && G.isNum(d.speed) && d.speed < 1;
        car.onSample((d, t) => {
            // sample times (the demo replays late steps with theirs) are wall-clock: a step back counts as no time
            const dt = lastT ? G.clamp(t - lastT, 0, 250) / 1000 : 0, m = mono(); lastT = t;
            turbo.update(d, dt);
            if (m - lastHist > 5000 && (G.isNum(d.oil) || G.isNum(d.coolant))) {
                lastHist = m; hist.push([m, d.oil, d.coolant, d.rpm, d.speed]);
                if (G.isNum(turbo.Th)) thist.push([m, turbo.Th, turbo.Td]);
                while (hist.length > 240) hist.shift();
                while (thist.length > 240) thist.shift();
            }
            // for checking it against a thermocouple, should anyone ever fit one
            if (G.isNum(turbo.Th) && m - lastLog > 5000) {
                lastLog = m;
                ctx.log.info('turbo gas ' + (G.isNum(turbo.Tg) ? Math.round(turbo.Tg) : '-') + ' housing ' + Math.round(turbo.Th) + ' downpipe ' + Math.round(turbo.Td)
                    + ' bearing ' + Math.round(turbo.Tb) + ' C, exhaust ' + turbo.qExh.toFixed(1) + ' in ' + turbo.qIn.toFixed(1) + ' out ' + turbo.qOut.toFixed(1)
                    + ' kW, soak ' + Math.round(turbo.soak) + ', rpm ' + Math.round(d.rpm || 0) + ' Nm ' + Math.round(d.torque || 0) + ' kmh ' + Math.round(d.speed || 0)
                    + ' boost ' + (G.isNum(d.boost) ? d.boost.toFixed(2) : '-') + (turbo.boostOk ? '' : '?') + ' amb ' + (G.isNum(d.ambient) ? Math.round(d.ambient) : '-'));
            }
            // Slot Lab: a trial only ever runs at a standstill, and runs out unless it is kept alive
            if (lab.trial) {
                if (!parked(d)) { lab.abort('Stopped: the car moved'); badgeApply(); } else if (m - lastKeep > LAB_KEEP_MS) { lastKeep = m; lab.keepAlive(); }
            }
            if (test && m - test.at > TEST_MS) {
                lab.refresh();
                lab.finding = explain(test.before, snapshot(lab.slots), lab.seen);
                ctx.log.info('slot lab: ' + lab.finding);
                test = null; badgeApply();
            }
            // cluster telltale: cold below the warm threshold, hot at/above the hot threshold
            if (badge) badge.setState(forced() ? 'cold' : held(clusterState(d), m));
        }, () => { hist.length = 0; thist.length = 0; turbo.reset(); if (badge) badge.setState('off'); });

        const F = () => settings.get('tempUnit') === 'f';
        const T = (c) => (G.isNum(c) ? (F() ? c * 9 / 5 + 32 : c) : null);
        const tU = () => (F() ? '°F' : '°C');

        /* ---------- cool-down: what the soak says ---------- */
        // secondsToSafe looks ahead with the model, so it is not done every frame
        let safeAt = -1e9, safeNow = null, safeIdle = null, soakStart = null;
        const coolingOn = () => settings.get('cooldown') && G.isNum(turbo.soak);
        const soaked = () => coolingOn() && turbo.soak > settings.get('soakLimit');
        function safeTimes(d) {
            const m = mono();
            if (m - safeAt < 2000) return;
            safeAt = m;
            const limit = settings.get('soakLimit');
            safeNow = turbo.secondsToSafe(limit);
            safeIdle = turbo.secondsToSafe(limit, { rpm: 750, torque: 20, speed: 0, coolant: d.coolant, oil: d.oil, ambient: d.ambient });
        }

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

        /** Seconds as the status panel shows them. */
        const shortTime = (s) => (s >= 90 ? '~' + Math.round(s / 60) + ' min' : '~' + Math.max(5, Math.round(s / 5) * 5) + ' s');

        function drawWarm(cv, t, d, now) {
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
            const cooling = soaked();
            let st, col;
            if (!G.isNum(d.oil)) { st = 'NO OIL TEMP'; col = t.dim; }
            else if (hot) { st = 'OIL HOT - EASE OFF'; col = t.crit; }
            else if (cooling) { st = 'TURBO COOL-DOWN'; col = t.warn; }
            else if (ready) { st = 'READY'; col = GO; }
            else if (d.oil >= warm - 20) { st = 'WARMING UP'; col = t.warn; }
            else { st = 'COLD'; col = t.cold; }
            cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.22));
            if (st === 'READY') cv.roundRect(952, 70, 600, 60, 10, withAlpha(col, 0.15 + 0.1 * Math.sin(now / 400)));
            cv.text(st, 1252, 114, st.length > 14 ? 30 : 38, col, { align: 'center', font: 'bold', spacing: 3 });

            if (cooling) {
                // the bearing housing would soak over the limit: how long until it would not
                safeTimes(d);
                if (soakStart === null) soakStart = turbo.soak;
                soakStart = Math.max(soakStart, turbo.soak);
                const eo = eta('oil', d.oil, warm, d);
                const line = eo.state === 'ready' ? 'Oil warm' : eo.state === 'warming' ? 'Oil ready in ~' + Math.max(1, Math.round(eo.min)) + ' min'
                    : eo.state === 'off' ? 'Engine off - oil not warming' : eo.state === 'stalled' ? 'Oil not warming' : '';
                cv.text(line, 952, 170, 24, eo.state === 'ready' ? GO : t.dim, { font: 'bold' });
                cv.text('IF YOU SWITCH OFF NOW', 952, 210, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text('bearing soaks to ' + Math.round(T(turbo.soak)) + tU(), 1552, 210, 22, t.warn, { align: 'right', font: 'bold' });
                const left = G.isNum(safeIdle) ? safeIdle : null;
                const lw = cv.text(left === null ? '--' : String(Math.ceil(left)), 952, 289, 80, t.text, { font: 'num' });
                if (left !== null) cv.text('s', 962 + lw, 289, 30, t.dim);
                cv.text(!turbo.running ? 'engine off: idling would cool it' : !G.isNum(safeNow) ? 'at idle: this pace keeps it hot' : shortTime(safeNow) === shortTime(left === null ? 0 : left) ? 'keep it gentle' : 'at idle, ' + shortTime(safeNow) + ' like this', 1552, 262, 24, t.text, { align: 'right', font: 'bold' });
                const span = soakStart - settings.get('soakLimit'), f = span > 0 ? G.clamp((soakStart - turbo.soak) / span, 0, 1) : 1;
                cv.roundRect(952, 303, 600, 12, 6, t.track);
                if (f > 0) cv.rampRect(952, 303, Math.max(12, 600 * f), 12, 6, [t.warn, GO], 952, 600);
            } else {
                soakStart = null;
                etaRow(cv, t, 170, 'OIL READY IN', eta('oil', d.oil, warm, d), warm);
                etaRow(cv, t, 255, 'COOLANT READY IN', eta('coolant', d.coolant, warmC, d), warmC);
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
        }

        /** Hot metal as a bar: 0-1000 deg C, the housing's limit in the warn and crit zones. */
        function hotBar(cv, t, y, h, val, label) {
            const st = F() ? 180 : 100;
            G.segBar(cv, t, 24, y, 880, h, {
                label, value: T(val), unit: tU(), decimals: 0, min: T(0), max: T(1000), step: st, scale: { every: st * 2 },
                zones: [{ from: T(750), to: T(900), color: 'warn' }, { from: T(900), to: T(1100), color: 'crit' }],
                ramp: 'hot', limit: T(900),
            });
        }
        const kw = (v) => (G.isNum(v) ? v.toFixed(v < 10 ? 1 : 0) + ' kW' : '-- kW');

        function drawTurbo(cv, t, d) {
            const room = G.pageBottom(cv) - G.BOTTOM, half = Math.round(room / 2);
            hotBar(cv, t, G.TOP, 225 + half, turbo.Th, 'Turbine housing (estimate)');
            hotBar(cv, t, G.TOP + 242 + half, 225 - half, turbo.Td, 'Downpipe (estimate)');

            const sp = G.panel(cv, t, 928, 44, 648, 468, null);
            const have = G.isNum(turbo.Th), net = turbo.qIn - turbo.qOut;
            let st, col;
            if (!have) { st = 'WAITING FOR THE CAR'; col = t.dim; }
            else if (!turbo.running) { st = 'ENGINE OFF - SOAKING'; col = t.warn; }
            else if (turbo.fuelCut) { st = 'OVERRUN - COOL AIR THROUGH'; col = GO; }
            else if (net > 0.4) { st = 'TAKING ON HEAT'; col = t.warn; }
            else if (net < -0.4) { st = 'SHEDDING HEAT'; col = GO; }
            else { st = 'IN BALANCE'; col = t.text; }
            cv.roundRect(952, 62, 600, 54, 10, withAlpha(col, 0.22));
            cv.text(st, 1252, 100, st.length > 18 ? 26 : 32, col, { align: 'center', font: 'bold', spacing: 2 });

            const row = (y, label, value, c) => {
                cv.text(label, 952, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
                cv.text(value, 1552, y + 1, 28, c || t.text, { align: 'right', font: 'bold' });
            };
            row(156, 'EXHAUST GAS', G.isNum(turbo.Tg) ? '~' + Math.round(T(turbo.Tg)) + tU() : '--');
            row(192, 'HEAT LEAVING IN THE EXHAUST', kw(turbo.qExh));
            row(228, 'GOING INTO TURBO + DOWNPIPE', kw(turbo.qIn), t.warn);
            row(264, 'BEING REJECTED', kw(turbo.qOut), GO);
            cv.text('radiation ' + turbo.qRad.toFixed(1) + '  air ' + turbo.qAir.toFixed(1) + '  coolant ' + turbo.qCool.toFixed(1) + ' kW', 1552, 290, 20, t.dim, { align: 'right' });

            // cool-down
            const limitC = settings.get('soakLimit');
            if (soaked()) {
                safeTimes(d);
                row(328, 'BEARING IF OFF NOW', Math.round(T(turbo.soak)) + tU(), t.warn);
                const here = G.isNum(safeNow) && shortTime(safeNow) !== (G.isNum(safeIdle) ? shortTime(safeIdle) : '') ? ', ' + shortTime(safeNow) + ' like this' : '';
                cv.text(G.isNum(safeIdle) ? 'safe in ' + shortTime(safeIdle) + ' idling' + here : 'ease off to cool it', 1552, 354, 22, t.warn, { align: 'right', font: 'bold' });
            } else {
                row(328, 'BEARING IF OFF NOW', G.isNum(turbo.soak) ? Math.round(T(turbo.soak)) + tU() : '--', GO);
                cv.text(!have ? '' : 'under ' + Math.round(T(limitC)) + tU() + ': OK to switch off', 1552, 354, 22, GO, { align: 'right', font: 'bold' });
            }

            // trend: housing and downpipe, last minutes
            const gx = 952, gy = 398, gw = 600, gh = 90 + sp.h - 468;
            const now0 = thist.length ? thist[thist.length - 1][0] : mono();
            const span = G.clamp(thist.length ? now0 - thist[0][0] : 0, 300000, 1200000);
            const X = (ts) => gx + gw - ((now0 - ts) / span) * gw, Y = (c) => gy + gh - G.clamp(c / 1000, 0, 1) * gh;
            cv.fillRect(gx, gy - 20, 22, 4, t.oil || t.accent); cv.text('HOUSING', gx + 30, gy - 11, 20, t.dim, { font: 'bold' });
            cv.fillRect(gx + 150, gy - 20, 22, 4, t.cold); cv.text('DOWNPIPE', gx + 180, gy - 11, 20, t.dim, { font: 'bold' });
            [[1, t.oil || t.accent], [2, t.cold]].forEach(([i, c]) => {
                const pts = thist.filter((h) => G.isNum(h[i])).map((h) => [X(h[0]), Y(h[i])]).filter((p) => p[0] >= gx);
                if (pts.length > 1) cv.polyline(pts, 3, c);
            });
            cv.fillRect(gx, gy + gh, gw, 1, withAlpha(t.tick, 0.5));
        }

        /* ---------- cluster page: the slots, and what the icon does to them ---------- */
        let probe = null, labAt = -1e9;
        function labTick() {
            const m = mono();
            if (m - labAt < LAB_READ_MS) return;
            labAt = m;
            lab.refresh();
            if (!probe && ClusterRender) {
                probe = new ClusterRender('warmup-lab');
                probe.on('status', (text) => { lab.status = parseStatus(text); });
                probe.connect();
            }
            if (probe) probe.status();
        }
        function startTest() {
            if (test) return null;
            lab.refresh();
            test = { at: mono(), before: snapshot(lab.slots) };
            lab.finding = 'Icon is up: watch the widget...';
            badgeApply();
            return render();
        }
        function nextSlot() {
            const c = lab.next(parked(car.data()));
            if (c) { lastKeep = mono(); labAt = -1e9; }
            badgeApply();
            return render();
        }
        function keepSlot() {
            const slot = lab.trial && lab.trial.slot;
            if (lab.keep() && slot !== null) {
                // the trial proved this slot takes the icon: it no longer has to be brief
                settings.set('clusterHold', 'always');
                settings.set('clusterBadge', true);
            }
            badgeApply();
            return render();
        }

        function drawCluster(cv, t, d) {
            labTick();
            const sp = G.panel(cv, t, 24, 44, 880, 468, 'Display slots the KOMBI reports');
            const rows = lab.rows(), fit = Math.floor((sp.h - 92) / 32);
            const stateCol = { disabled: 'dim', free: GO, shown: 'text', parked: 'warn' };
            G.table(cv, t, 48, 92, 832, [{ label: 'Slot', w: 110 }, { label: 'State', w: 150 }, { label: 'Content', w: 460 }, { label: 'Class', w: 112, align: 'right' }],
                rows.slice(0, fit).map((r) => [hex(r.slot), { text: r.state, color: stateCol[r.state] }, r.name, r.cls === null ? '' : String(r.cls)]),
                { rowH: 32, size: 22, empty: 'No slot table yet: cluster-render logs it, and an app may not be able to read that' });
            if (rows.length > fit) cv.text('+' + (rows.length - fit) + ' more', 880, 74, 20, t.dim, { align: 'right' });

            const rp = G.panel(cv, t, 928, 44, 648, 468, null);
            const panel = lab.status.targets.panel;
            cv.text('OIL ICON', 952, 86, 22, t.dim, { font: 'bold', spacing: 1.5 });
            cv.text(panel ? 'slot ' + hex(panel.slot) + ': ' + panel.state.split(';')[0] : 'cluster-render not answering', 1552, 86, 24, panel ? t.text : t.warn, { align: 'right', font: 'bold' });
            // long lines go over two rows
            const wrap = (s, y, size, c) => {
                const words = String(s).split(' ');
                let line = '', n = 0;
                words.forEach((w) => {
                    if (cv.textWidth(line + ' ' + w, size) > 600 && n < 2) { cv.text(line, 952, y + n * (size + 8), size, c); line = w; n++; } else line = line ? line + ' ' + w : w;
                });
                if (line) cv.text(line, 952, y + n * (size + 8), size, c);
            };
            cv.text('WHAT THE ICON DOES', 952, 134, 22, t.dim, { font: 'bold', spacing: 1.5 });
            wrap(lab.finding || 'Play music so the widget is up, then press Test icon.', 170, 24, lab.finding ? t.text : t.dim);

            cv.text('SLOT LAB', 952, 262, 22, t.dim, { font: 'bold', spacing: 1.5 });
            let lines;
            if (!lab.tool) lines = 'Trying another slot needs the Cluster Slot Lab tool from the Store, then one head unit restart.';
            else if (lab.trial) lines = 'Trying ' + hex(lab.trial.slot) + ': ' + lab.trial.why + '. Is the grid on the cluster, and is the widget still there?';
            else if (lab.tool.mode === 'kept') lines = 'Keeping slot ' + lab.tool.slot + '. Next slot tries others, Stock goes back.';
            else lines = 'Stock settings. Parked, press Next slot and watch the cluster.';
            wrap(lab.note || lines, 298, 24, lab.note ? t.warn : t.text);

            const by = 44 + rp.h - 76, busy = !!test;
            G.button(cv, t, 952, by, 186, 52, busy ? 'Watching' : 'Test icon', startTest, { key: 'test', busy, primary: true });
            G.button(cv, t, 1150, by, 186, 52, 'Next slot', nextSlot, { key: 'next', busy: !parked(d) || !lab.tool });
            G.button(cv, t, 1348, by, 204, 52, lab.trial ? 'Keep this' : 'Stock', lab.trial ? keepSlot : () => { lab.stock(); badgeApply(); return render(); }, { key: 'keep', busy: !lab.tool });
        }

        function render() {
            const t = ctx.theme(), d = car.data(), now = Date.now();
            const cv = ctx.canvas(W, H).clear(t.bg);
            if (page === 1) drawTurbo(cv, t, d); else if (page === 2) drawCluster(cv, t, d); else drawWarm(cv, t, d, now);
            G.frame(cv, t, PAGES, page, [d.demo && { text: 'DEMO' }]);     // G20-style frame
            return ui.image('MAIN_GFX', cv);
        }

        let page = 0;
        const go = (i) => { page = (i + PAGES.length) % PAGES.length; return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => go(i));
        // on the page where the kit runs the screen; elsewhere the bar has them, and they open the page
        const onCluster = (fn) => () => { if (page !== 2) { page = 2; lab.refresh(); } return fn(); };
        ui.onClick('BTN_TEST', onCluster(startTest));
        ui.onClick('BTN_NEXT', onCluster(nextSlot));
        ui.onClick('BTN_KEEP', onCluster(keepSlot));
        ['BTN_TEST', 'BTN_NEXT', 'BTN_KEEP'].forEach((b) => ctx.hideButton(b));

        // every screen refresh (60 fps) with the GPU renderer; 4 fps in software (PNG frames)
        ctx.loop('MAIN', 4, render);
        render().then(() => ctx.log.info('first frame done')).catch((e) => ctx.log.warn('first render: ' + e));
    },
});
