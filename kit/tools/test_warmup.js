'use strict';

// Warm-Up against a stubbed car (kit/car) and the head unit's clock jumping after start-up: the heat
// model counts a step back of the clock as no time and never leaps, the pages draw, and the cluster
// icon's brief mode keeps to its time. No SDK or vehicle needed:
//   node kit/tools/test_warmup.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..'), KIT = path.join(ROOT, 'kit', 'runtime');
const MAIN = path.join(ROOT, 'apps', 'warmup', 'main.js');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'warmup', 'app.json'), 'utf8'));
const { Recorder } = require(path.join(KIT, 'record'));        // what the kit draws into (display.js)
const themes = require(path.join(KIT, 'themes'));

process.env.MGU_SLOTLAB_DIR = path.join(ROOT, 'no-such-lab');
process.env.MGU_SLOTLAB_LOG = path.join(ROOT, 'no-such-log');

// the steady clock (process.hrtime) and the head unit's wall clock, moved by hand
let mono = 5000, wall = Date.UTC(2026, 9, 1, 8);
process.hrtime = () => [Math.floor(mono / 1000), (mono % 1000) * 1e6];
Date.now = () => wall;

let app = null, car = null, badges = [];
class FakeCar {
    constructor() { car = this; this.d = {}; }
    onSample(fn) { this.fn = fn; }
    data() { return this.d; }
}
class FakeBadge {
    constructor() { this.state = 'off'; this.card = false; this.log = []; badges.push(this); }
    setState(s) { if (s !== this.state) { this.state = s; this.log.push(s); } }
    setTestCard(on) { this.card = on; }
    setGeometry() {}
    close() { this.closed = true; }
}
const stubs = { './kit/mgu': { run(a) { app = a; } }, './kit/car': FakeCar, './cluster_badge': { ClusterBadge: FakeBadge } };
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (stubs[req]) return stubs[req];
    if (req.startsWith('./kit/')) return load.call(this, path.join(KIT, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};

/** A fresh Warm-Up (a new process); render() draws a frame and returns its texts in order. */
let render = null, tab = null, S = null, clicks = {}, changed = [];
/** A setting changed from the settings screen: the app hears about it. */
const setting = (k, v) => { S[k] = v; changed.forEach((fn) => fn(k, v)); };
async function start(over) {
    delete require.cache[MAIN];
    require(MAIN);
    S = {};
    SPEC.settings.forEach((s) => { S[s.key] = s.default; });
    Object.assign(S, over);
    badges = []; clicks = {}; changed = [];
    let texts = [], frame = null;
    await app.start({
        ui: { image: async () => {}, onClick(n, fn) { clicks[n] = fn; }, text() {} },
        settings: { get: (k) => S[k], set(k, v) { S[k] = v; }, onChange(fn) { changed.push(fn); } }, log: { info() {}, warn() {} },
        theme: () => themes.theme('m_tricolour'), loop: (name, fps, fn) => { frame = fn; },
        onTab(fn) { tab = fn; }, hideButton() {},
        canvas: (w, h) => {
            const cv = new Recorder(w, h), text = cv.text.bind(cv);
            texts = [];
            cv.text = (str, ...a) => { texts.push(String(str)); return text(str, ...a); };
            return cv;
        },
    });
    render = async () => { await frame(); return texts; };
}
/** s seconds of samples 100 ms apart, both clocks running */
function drive(d, s) {
    for (let i = 0; i < s * 10; i++) { mono += 100; wall += 100; car.d = d; car.fn(d, wall); }
}
const HARD = { rpm: 5500, torque: 390, oil: 118, coolant: 104, speed: 150, ambient: 20 };
const GENTLE = { rpm: 1500, torque: 40, oil: 100, coolant: 95, speed: 50, ambient: 20 };
const IDLE = { rpm: 750, torque: 20, oil: 100, coolant: 95, speed: 0, ambient: 20 };
const COLD = { rpm: 750, torque: 20, oil: 40, coolant: 40, speed: 0, ambient: 20 };
const HOT = { rpm: 3000, torque: 150, oil: 115, coolant: 100, speed: 100, ambient: 20 };
const has = (t, s) => t.indexOf(s) >= 0;
const checks = [
    ['a long hard run asks for a cool-down, and the bearing soak says why', async () => {
        await start();
        assert(!has(await render(), 'TURBO COOL-DOWN'), 'cool-down before driving');
        drive(HARD, 300);
        const t = await render();
        assert(has(t, 'TURBO COOL-DOWN'), 'after 5 hard minutes: ' + t.join(' | '));
        assert(has(t, 'IF YOU SWITCH OFF NOW'), t.join(' | '));
    }],
    ['a short pull from a cruise does not', async () => {
        await start();
        drive(GENTLE, 600);
        drive(HARD, 10);
        assert(!has(await render(), 'TURBO COOL-DOWN'));
    }],
    ['gentle driving clears it', async () => {
        await start();
        drive(HARD, 300);
        drive(GENTLE, 300);
        const t = await render();
        assert(!has(t, 'TURBO COOL-DOWN') && has(t, 'READY'), t.join(' | '));
    }],
    ['the clock jumping back counts as no time', async () => {
        await start();
        drive(HARD, 300);
        wall -= 3 * 3600000;                      // the head unit sets its clock
        drive(IDLE, 1);
        assert(has(await render(), 'TURBO COOL-DOWN'));
    }],
    ['the clock jumping ahead does not cool the turbo by hours', async () => {
        await start();
        drive(HARD, 300);
        wall += 3 * 3600000;
        drive(IDLE, 1);
        assert(has(await render(), 'TURBO COOL-DOWN'), 'three hours passed in one sample');
    }],
    ['turned off, there is no cool-down advice', async () => {
        await start({ cooldown: false });
        drive(HARD, 300);
        assert(!has(await render(), 'TURBO COOL-DOWN'));
    }],
    ['the Turbo page shows the balance in kW', async () => {
        await start();
        drive(GENTLE, 120);
        await tab(1);
        const t = await render();
        // no DME on the bench: the gas is the model's own, and says so
        assert(has(t, 'EXHAUST GAS (ESTIMATE)'), 'gas source: ' + t.join(' | '));
        assert(t.some((x) => /^catalyst /.test(x)), 'no catalyst figure by the downpipe');
        ['HEAT LEAVING IN THE EXHAUST', 'GOING INTO TURBO + DOWNPIPE', 'BEING REJECTED', 'BEARING IF OFF NOW'].forEach((s) => assert(has(t, s), s + ': ' + t.join(' | ')));
        assert(t.some((x) => /kW$/.test(x)), 'no kW figure');
    }],
    ['the Turbo page says when the engine is off and when it is on overrun', async () => {
        await start();
        drive(GENTLE, 120);
        await tab(1);
        drive({ rpm: 2500, torque: 0, oil: 100, coolant: 95, speed: 100, ambient: 20 }, 2);
        assert((await render()).some((x) => /OVERRUN/.test(x)));
        drive({ rpm: 0, torque: 0, oil: 100, coolant: 95, speed: 0, ambient: 20 }, 2);
        assert((await render()).some((x) => /ENGINE OFF/.test(x)));
    }],
    ['the Cluster page draws with no renderer, no log and no tool', async () => {
        await start();
        await tab(2);
        const t = await render();
        assert(has(t, 'OIL ICON') && has(t, 'SLOT LAB'), t.join(' | '));
        assert(t.some((x) => /cluster-render not answering/.test(x)));
        assert(t.some((x) => /Store/.test(x)), 'should say where the tool comes from');
    }],
    ['every page draws in Fahrenheit too', async () => {
        await start({ tempUnit: 'f' });
        drive(HARD, 300);
        for (let i = 0; i < 3; i++) { await tab(i); await render(); }
    }],
    ['the page buttons go round, and the bar\'s Test icon opens the Cluster page', async () => {
        await start();
        await clicks.BTN_PAGE();
        assert(has(await render(), 'BEING REJECTED'));
        await clicks.BTN_PAGE();
        assert(has(await render(), 'OIL ICON'));
        await clicks.BTN_PAGE();
        assert(has(await render(), 'SAFE REV LIMIT'));
        await clicks.BTN_PREV();
        assert(has(await render(), 'OIL ICON'));
    }],
    ['brief: cold oil shows the icon for 10 s, once', async () => {
        await start({ clusterBadge: true, clusterHold: 'brief' });
        drive(COLD, 5);
        assert.strictEqual(badges[0].state, 'cold');
        drive(COLD, 7);
        assert.strictEqual(badges[0].state, 'off');
        drive(COLD, 600);
        assert.deepStrictEqual(badges[0].log, ['cold', 'off']);
    }],
    ['brief: switching the icon off and on again shows it again', async () => {
        await start({ clusterBadge: true, clusterHold: 'brief' });
        drive(COLD, 12);
        assert.strictEqual(badges[0].state, 'off');
        setting('clusterBadge', false);
        assert(badges[0].closed, 'not taken down');
        setting('clusterBadge', true);
        drive(COLD, 1);
        assert.strictEqual(badges.length, 2);
        assert.strictEqual(badges[1].state, 'cold', 'back on, but the icon stayed hidden');
        drive(COLD, 12);
        assert.strictEqual(badges[1].state, 'off');
    }],
    ['brief: hot oil comes back every 5 minutes', async () => {
        await start({ clusterBadge: true, clusterHold: 'brief' });
        drive(HOT, 12);
        assert.strictEqual(badges[0].state, 'off');
        drive(HOT, 292);                          // 304 s since it first showed
        assert.strictEqual(badges[0].state, 'hot');
        drive(HOT, 12);
        assert.strictEqual(badges[0].state, 'off');
    }],
    ['always: the icon stays', async () => {
        await start({ clusterBadge: true, clusterHold: 'always' });
        drive(COLD, 60);
        assert.strictEqual(badges[0].state, 'cold');
    }],
    ['the icon never comes from demo data', async () => {
        await start({ clusterBadge: true, clusterHold: 'always' });
        drive(Object.assign({ demo: true }, COLD), 5);
        assert.strictEqual(badges[0].state, 'off');
    }],
    ['Test icon shows it whatever the oil, for its 7 s, and needs no setting', async () => {
        await start({ clusterBadge: false });
        drive(IDLE, 1);
        await tab(2);
        await render();
        assert.strictEqual(badges.length, 0);
        await clicks.BTN_TEST();
        assert.strictEqual(badges.length, 1, 'no badge for the test');
        drive(IDLE, 3);
        assert.strictEqual(badges[0].state, 'cold');
        drive(IDLE, 5);
        assert(badges[0].closed, 'the badge should go again');
        assert((await render()).some((x) => /slot table/i.test(x)), 'the finding should show');
    }],
    ['Test icon ends on time with the engine off, when the car sends no samples', async () => {
        await start({ clusterBadge: false });
        drive(IDLE, 1);
        await tab(2);
        await clicks.BTN_TEST();
        await render();
        assert.strictEqual(badges[0].state, 'cold', 'the icon should be up without a new sample');
        mono += 8000; wall += 8000;                       // 8 s pass, not one sample
        const t = await render();
        assert(badges[0].closed, 'the test never ended: the icon stays forced on');
        assert(!t.includes('Watching'), '"Watching" stuck: ' + t.join(' | '));
    }],
];

(async () => {
    const failed = [];
    for (const [name, fn] of checks) {
        try { await fn(); } catch (e) { failed.push(name); console.error('FAIL ' + name + ': ' + e.message); }
    }
    if (failed.length) process.exit(1);
    console.log('Warm-Up checks passed (' + checks.length + ': cool-down, clock jumps, all three pages, the cluster icon\'s brief mode, Test icon).');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
