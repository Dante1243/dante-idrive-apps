'use strict';

// Warm-Up's Slot Lab: reading the KOMBI's slot table, what to try, the requests it sends, and the
// root tool's script in a sandbox. No SDK or vehicle needed:
//   node kit/tools/test_slot_lab.js
// (the script's part needs sh, and is skipped without it)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const L = require(path.join(ROOT, 'apps', 'warmup', 'slot_lab.js'));
const { parseSlots, parseStatus, describe, snapshot, changes, explain, candidates, SlotLab } = L;

// real lines, as cluster-render logs them (issues #21 and #85 of robertnisipeanu/idrive-apps)
const TABLE = [
    '10:00:00.100 I dcsm: slot 0x100 status 2 content 0x1000300 class 0 map 1',
    '10:00:00.100 I dcsm: slot 0x101 status 1 content 0x0 class 0 map 0',
    '10:00:00.100 I dcsm: slot 0x103 status 2 content 0x1000314 class 1024 map 3',
    '10:00:00.100 I dcsm: slot 0x103 status 2 content 0x1000310 class 0 map 1',
    '10:00:00.100 I dcsm: slot 0x105 status 0 content 0x0 class 0 map 0',
    '10:00:00.100 I dcsm: slot 0x203 status 1 content 0x0 class 0 map 0',
    '10:00:00.100 I dcsm: slot 0x351 status 1 content 0x0 class 0 map 0',
].join('\n');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slotlab-'));

const checks = [
    ['the log lines make a table', () => {
        const t = parseSlots(TABLE);
        assert.strictEqual(t.size, 6);
        assert.strictEqual(t.get(0x103).rows.size, 2);
        assert.deepStrictEqual(describe(t.get(0x103)), { slot: 0x103, state: 'shown', content: 0x1000310, cls: 0, name: 'BMW turn box' });
        assert.strictEqual(describe(t.get(0x105)).state, 'disabled');
        assert.strictEqual(describe(t.get(0x101)).state, 'free');
    }],
    ['a later line wins, and a parked content reads as parked', () => {
        const t = parseSlots(TABLE + '\n10:00:01 I dcsm: slot 0x103 status 2 content 0x1000310 class 0 map 0');
        assert.strictEqual(describe(t.get(0x103)).state, 'parked');
    }],
    ['candidates: stock first, the same spot next, then free slots, cluster before HUD', () => {
        const c = candidates(parseSlots(TABLE));
        assert(c[0].stock);
        assert(c.slice(1, 4).every((x) => x.slot === 0x203 && !x.stock), 'the same spot next');
        const rest = c.slice(4).map((x) => x.slot);
        assert.deepStrictEqual(rest, [0x101, 0x351]);
    }],
    ['never a disabled or occupied slot', () => {
        const slots = candidates(parseSlots(TABLE)).map((x) => x.slot);
        [0x100, 0x103, 0x105].forEach((s) => assert(slots.indexOf(s) < 0, L.hex(s) + ' offered'));
    }],
    ['what changed: stock slots only, not cluster-render\'s own scenes', () => {
        const a = parseSlots(TABLE);
        const b = parseSlots(TABLE + '\n1 I dcsm: slot 0x203 status 2 content 0x1000400 class 0 map 1\n2 I dcsm: slot 0x103 status 0 content 0x1000310 class 0 map 0');
        const c = changes(snapshot(a), snapshot(b));
        assert(c.some((x) => /0x103 occupied to disabled/.test(x)), c.join('; '));
        assert(c.some((x) => /BMW turn box in 0x103 shown to unmapped/.test(x)), c.join('; '));
        assert(!c.some((x) => /Panel/.test(x)), 'our own scene reported: ' + c.join('; '));
    }],
    ['the finding says plainly what happened', () => {
        const a = snapshot(parseSlots(TABLE));
        assert(/No stock slot changed/.test(explain(a, a, true)));
        assert(/No slot table/.test(explain(a, a, false)));
    }],
    ['status text: the panel target and its state', () => {
        const s = parseStatus('upload: cap 5500 KB/s\ntarget panel: slot 0x203 scene 0x1000400 1920x720: shown (us); verified\ndcsm: Dcsm2 available for 12 s; subscription: x\n');
        assert.strictEqual(s.targets.panel.slot, 0x203);
        assert(/^shown/.test(s.targets.panel.state));
        assert(/available/.test(s.dcsm));
        assert.deepStrictEqual(parseStatus(undefined).targets, {});
    }],
    ['no tool: reads the log, and refuses to try anything', () => {
        const dir = tmp(), log = path.join(dir, 'cluster-render.log');
        fs.writeFileSync(log, TABLE);
        const lab = new SlotLab({ dir: path.join(dir, 'none'), logFile: log });
        lab.refresh();
        assert.strictEqual(lab.tool, null);
        assert.strictEqual(lab.rows().length, 6);
        assert.strictEqual(lab.next(true), null);
        assert(/Install/.test(lab.note));
    }],
    ['requests: only when parked, in the form the tool takes', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, 'in'));
        fs.writeFileSync(path.join(dir, 'state'), 'mode=stock\nslot=\n');
        fs.writeFileSync(path.join(dir, 'slots.txt'), TABLE);
        const lab = new SlotLab({ dir, logFile: path.join(dir, 'none') });
        const asked = () => fs.readFileSync(path.join(dir, 'in', 'request'), 'utf8').trim();
        lab.refresh();
        assert.strictEqual(lab.next(false), null);
        assert(/Park/.test(lab.note));
        assert.strictEqual(lab.trial, null);
        lab.next(true);
        assert.strictEqual(asked(), 'try 0x203 0x010004f1 0 120');
        lab.next(true);
        assert.strictEqual(asked(), 'try 0x203 0x010004f0 0 120');
        lab.next(true); lab.next(true);
        // another slot: the guide hold's scene id, not the panel's (the HUD target shares that)
        assert.strictEqual(asked(), 'try 0x101 0x010004f1 0 120');
        assert(lab.keep());
        assert.strictEqual(asked(), 'keep');
        assert.strictEqual(lab.trial, null);
        lab.next(true);
        lab.abort('moved');
        assert.strictEqual(asked(), 'revert');
        assert.strictEqual(lab.trial, null);
    }],
    ['a scan never replaces a request the tool has not taken yet', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, 'in'));
        fs.writeFileSync(path.join(dir, 'state'), 'mode=stock\n');
        fs.writeFileSync(path.join(dir, 'slots.txt'), TABLE);
        const lab = new SlotLab({ dir, logFile: path.join(dir, 'none') });
        const asked = () => fs.readFileSync(path.join(dir, 'in', 'request'), 'utf8').trim();
        lab.refresh();
        assert.strictEqual(asked(), 'scan');
        fs.unlinkSync(path.join(dir, 'in', 'request'));
        lab.next(true);
        lab.refresh();
        assert(/^try /.test(asked()), 'the try was lost: ' + asked());
    }],
    ['a slot showing our own trial stays on the list, so Next slot does not skip one', () => {
        const before = candidates(parseSlots(TABLE)).map((x) => x.slot);
        const during = candidates(parseSlots(TABLE + '\n1 I dcsm: slot 0x101 status 2 content 0x1000400 class 0 map 1')).map((x) => x.slot);
        assert.deepStrictEqual(during, before);
    }],
    ['the list wraps round to stock, which ends the trial', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, 'in'));
        fs.writeFileSync(path.join(dir, 'state'), 'mode=stock\n');
        fs.writeFileSync(path.join(dir, 'slots.txt'), TABLE);
        const lab = new SlotLab({ dir, logFile: path.join(dir, 'none') });
        lab.refresh();
        for (let i = 0; i < lab.list().length; i++) lab.next(true);
        assert.strictEqual(lab.trial, null);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'in', 'request'), 'utf8').trim(), 'stock');
    }],
    ['component.json and the repo manifest agree, and hooks name a real file', () => {
        const dir = path.join(ROOT, 'tools', 'dante-slotlab');
        const c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
        const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8'));
        const entry = repo.tools.find((t) => t.id === c.id);
        assert(entry && entry.path === 'tools/dante-slotlab', 'not in mgu-repo.json');
        assert(/^[a-z0-9][a-z0-9-]*$/.test(c.id) && /^\d+\.\d+\.\d+$/.test(c.version) && c.kind === 'tool');
        c.files.forEach((f) => assert(fs.existsSync(path.join(dir, f.path)), f.path));
        c.units.forEach((u) => assert(fs.existsSync(path.join(dir, u.name)), u.name));
        assert(c.files.some((f) => f.path === c.deactivate[0] && f.mode === '0755'), 'deactivate must name an executable file of the tool');
        assert.deepStrictEqual(c.recmgr, ['dante-slotlab']);
        // the rules mgu-store's updater and deploy tool hold a tool to (sources.js packComponent, mgu-deploy.js validateTool, hookOk)
        const safeRel = (p) => typeof p === 'string' && p !== '' && p[0] !== '/' && p.indexOf('\\') < 0 && p.split('/').every((x) => x !== '..' && x !== '.' && x !== '');
        assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(c.id) && !c.build, 'id, and no build step');
        c.files.forEach((f) => assert(safeRel(f.path) && /^[0-7]{3,4}$/.test(f.mode), 'file ' + f.path));
        c.units.forEach((u) => assert(safeRel(u.name) && u.name.indexOf('/') < 0, 'unit ' + u.name));
        c.enable.forEach((e) => assert(safeRel(e.unit) && safeRel(e.target), 'enable'));
        c.recmgr.concat(c.restart).forEach((n) => assert(/^[A-Za-z0-9:._+@-]{1,255}$/.test(n) && !/^oapcontroller/.test(n), 'recmgr/restart ' + n));
        assert(c.deactivate.every((x) => typeof x === 'string' && x && x.split('/').indexOf('..') < 0), 'hook shape');
        assert(/ExecStart=\/var\/opt\/dante-slotlab\/current\/slotlab\.sh/.test(fs.readFileSync(path.join(dir, c.units[0].name), 'utf8')), 'the unit runs the installed script');
    }],
];

/* ---------- the root tool's script, in a sandbox ---------- */
const sh = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
const haveSh = !sh.error && /ok/.test(sh.stdout || '');
const SCRIPT = path.join(ROOT, 'tools', 'dante-slotlab', 'slotlab.sh');

function sandbox() {
    const root = tmp();
    const render = path.join(root, 'var', 'opt', 'cluster-render');
    fs.mkdirSync(path.join(render, 'log'), { recursive: true });
    const restarts = path.join(root, 'restarts');
    fs.writeFileSync(path.join(render, 'log', 'cluster-render.log'), TABLE + '\nnoise\n');
    return {
        root, render, conf: path.join(render, 'cluster-render.local.conf'), lab: path.join(root, 'dev', 'shm', 'dante-slotlab'), restarts,
        env: Object.assign({}, process.env, { SLOTLAB_ROOT: root.replace(/\\/g, '/'), SLOTLAB_RESTART: 'touch-count ' + restarts.replace(/\\/g, '/'), SLOTLAB_TICK: '0.05' }),
    };
}
// 'restarting' in the sandbox: a tiny script on PATH that adds a line to a file
function withCounter(s) {
    const bin = path.join(s.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'touch-count'), '#!/bin/sh\necho x >> "$1"\n', { mode: 0o755 });
    s.env.PATH = bin + path.delimiter + s.env.PATH;
    return s;
}
const restarts = (s) => { try { return fs.readFileSync(s.restarts, 'utf8').trim().split('\n').filter(Boolean).length; } catch (e) { return 0; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
    for (let i = 0; i < 600; i++) { if (fn()) return; await wait(25); }
    assert.fail('timed out: ' + what);
}
const state = (s) => {
    const o = {};
    try { fs.readFileSync(path.join(s.lab, 'state'), 'utf8').split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }); } catch (e) { /* not yet */ }
    return o;
};
// taken, and published after that: the state file changes twice (processes are slow to start on some systems)
const ask = async (s, line) => {
    const f = path.join(s.lab, 'in', 'request'), stamp = () => { try { return fs.statSync(path.join(s.lab, 'state')).mtimeMs; } catch (e) { return 0; } };
    fs.writeFileSync(f + '.t', line + '\n'); fs.renameSync(f + '.t', f);
    await until(() => !fs.existsSync(f), 'request taken: ' + line);
    for (let i = 0; i < 2; i++) { const was = stamp(); await until(() => stamp() !== was, 'published after: ' + line); }
};
// started and stopped from a shell: killing sh from here can leave the real one running (Windows),
// and two copies would race for each request, which systemd never allows on the car
const start = async (s) => {
    const pid = path.join(s.root, 'pid').replace(/\\/g, '/');
    try { fs.unlinkSync(path.join(s.lab, 'state')); } catch (e) { /* first start */ }
    spawn('sh', ['-c', 'sh "' + SCRIPT.replace(/\\/g, '/') + '" & echo $! > "' + pid + '"; wait'], { env: s.env, stdio: 'ignore' });
    await until(() => state(s).mode, 'the tool up');
    return { kill() { spawnSync('sh', ['-c', 'kill $(cat "' + pid + '")'], { env: s.env }); } };
};

const shellChecks = [
    ['a trial writes its block beside the owner\'s settings, once, and restarts the renderer', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, 'guide_hold = 0\n');
        const p = await start(s);
        await ask(s, 'try 0x104 0x01000400 0 60');
        const conf = fs.readFileSync(s.conf, 'utf8');
        assert(/guide_hold = 0/.test(conf), 'the owner\'s line went');
        assert(/panel_slot = 0x104/.test(conf) && /panel_scene_id = 0x01000400/.test(conf) && /panel_content_class = 0/.test(conf), conf);
        assert.strictEqual(state(s).mode, 'trial');
        assert.strictEqual(restarts(s), 1);
        await ask(s, 'try 0x104 0x01000400 0 60');
        assert.strictEqual(restarts(s), 1, 'the same trial again must only extend the time');
        p.kill();
    }],
    ['a trial runs out by itself and the owner\'s settings are as they were', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, 'guide_hold = 0\n');
        const p = await start(s);
        await ask(s, 'try 0x104 0x01000400 0 10');
        fs.writeFileSync(path.join(s.lab, 'in', 'request.none'), '');
        assert.strictEqual(state(s).mode, 'trial');
        p.kill();
        await wait(100);
        // the deadline is in whole seconds: run it short from a fresh start of the same block
        const again = await start(s);
        await until(() => state(s).mode === 'stock', 'a trial does not survive a restart');
        assert.strictEqual(fs.readFileSync(s.conf, 'utf8'), 'guide_hold = 0\n');
        again.kill();
    }],
    ['keep survives a restart, a later trial falls back to it, stock clears it', async () => {
        const s = withCounter(sandbox());
        const p = await start(s);
        await ask(s, 'try 0x104 0x01000400 0 60');
        await ask(s, 'keep');
        assert.strictEqual(state(s).mode, 'kept');
        p.kill();
        await wait(100);
        const q = await start(s);
        assert.strictEqual(state(s).mode, 'kept');
        assert.strictEqual(state(s).slot, '0x104');
        await ask(s, 'try 0x201 0x01000400 0 60');
        assert(/panel_slot = 0x201/.test(fs.readFileSync(s.conf, 'utf8')));
        await ask(s, 'revert');
        assert(/panel_slot = 0x104/.test(fs.readFileSync(s.conf, 'utf8')), 'back to the kept slot');
        assert.strictEqual(state(s).mode, 'kept');
        await ask(s, 'stock');
        assert.strictEqual(state(s).mode, 'stock');
        assert(!fs.existsSync(s.conf), 'nothing of ours left');
        q.kill();
    }],
    ['a kept slot takes over from the stock HMI, so the icon can come back; a trial never does', async () => {
        const s = withCounter(sandbox());
        const p = await start(s);
        await ask(s, 'try 0x105 0x01000400 0 60');
        assert(!/take_over/.test(fs.readFileSync(s.conf, 'utf8')), 'a trial took over');
        await ask(s, 'keep');
        assert(/panel_slot = 0x105\npanel_scene_id = 0x01000400\npanel_content_class = 0\npanel_take_over_stock = 1\n# dante-slotlab end/.test(fs.readFileSync(s.conf, 'utf8')), fs.readFileSync(s.conf, 'utf8'));
        assert.strictEqual(restarts(s), 2, 'keep must restart the renderer so take-over applies');
        p.kill();
    }],
    ['a slot kept by 1.0.0 gets take-over at the next start, once', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, 'guide_hold = 0\n# dante-slotlab begin kept\npanel_slot = 0x105\npanel_scene_id = 0x01000400\npanel_content_class = 0\n# dante-slotlab end\n');
        fs.writeFileSync(path.join(s.render, 'dante-slotlab.kept'), '0x105 0x01000400 0\n');
        const p = await start(s);
        await until(() => /panel_take_over_stock = 1/.test(fs.readFileSync(s.conf, 'utf8')), 'take-over added');
        assert(/^guide_hold = 0\n/.test(fs.readFileSync(s.conf, 'utf8')), 'the owner\'s line went');
        assert.strictEqual(state(s).mode, 'kept');
        assert.strictEqual(restarts(s), 1);
        p.kill();
        await wait(100);
        const q = await start(s);
        await wait(200);
        assert.strictEqual(restarts(s), 1, 'upgraded twice');
        q.kill();
    }],
    ['a slot kept with the panel\'s scene id (shared with the HUD target) moves to the guide hold\'s, once', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, 'guide_hold = 0\n# dante-slotlab begin kept\npanel_slot = 0x105\npanel_scene_id = 0x01000400\npanel_content_class = 0\npanel_take_over_stock = 1\n# dante-slotlab end\n');
        fs.writeFileSync(path.join(s.render, 'dante-slotlab.kept'), '0x105 0x01000400 0\n');
        const p = await start(s);
        await until(() => /panel_scene_id = 0x010004f1/.test(fs.readFileSync(s.conf, 'utf8')), 'scene id moved');
        assert.strictEqual(fs.readFileSync(path.join(s.render, 'dante-slotlab.kept'), 'utf8').trim(), '0x105 0x010004f1 0');
        assert.strictEqual(state(s).scene, '0x010004f1');
        assert(/^guide_hold = 0\n/.test(fs.readFileSync(s.conf, 'utf8')));
        assert.strictEqual(restarts(s), 1);
        p.kill();
        await wait(100);
        const q = await start(s);
        await wait(200);
        assert.strictEqual(restarts(s), 1, 'moved twice');
        q.kill();
    }],
    ['the stock slot kept with the panel\'s scene id stays as it is', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, '# dante-slotlab begin kept\npanel_slot = 0x203\npanel_scene_id = 0x01000400\npanel_content_class = 512\npanel_take_over_stock = 1\n# dante-slotlab end\n');
        fs.writeFileSync(path.join(s.render, 'dante-slotlab.kept'), '0x203 0x01000400 512\n');
        const p = await start(s);
        await wait(200);
        assert(/panel_scene_id = 0x01000400/.test(fs.readFileSync(s.conf, 'utf8')));
        assert.strictEqual(restarts(s), 0);
        p.kill();
    }],
    ['anything else is refused, nothing is written, nothing runs', async () => {
        const s = withCounter(sandbox());
        const p = await start(s);
        const evil = path.join(s.root, 'pwned').replace(/\\/g, '/');
        for (const line of [
            'try 0x104 0x99999999 0 60', 'try 104 0x01000400 0 60', 'try 0x1040 0x01000400 0 60', 'try 0x104 0x01000400 7 60',
            'try 0x104 0x01000400 0 5', 'try 0x104 0x01000400 0 abc', 'try $(touch ' + evil + ') 0x01000400 0 60',
            'try 0x104;touch ' + evil + ' 0x01000400 0 60', '`touch ' + evil + '`', 'rm -rf /',
        ]) {
            await ask(s, line);
            assert.strictEqual(state(s).mode, 'stock', 'took: ' + line);
            assert(/refused/.test(state(s).msg), 'no refusal for: ' + line);
        }
        assert(!fs.existsSync(s.conf), 'wrote settings');
        assert(!fs.existsSync(evil), 'ran something');
        assert.strictEqual(restarts(s), 0);
        p.kill();
    }],
    ['a request that is a link is not followed', async () => {
        const s = withCounter(sandbox());
        const p = await start(s);
        const f = path.join(s.lab, 'in', 'request');
        try { fs.symlinkSync(s.conf, f); } catch (e) { p.kill(); return; }     // no links on this file system
        await wait(200);
        assert.strictEqual(state(s).mode, 'stock');
        p.kill();
    }],
    ['scan publishes only the slot lines', async () => {
        const s = withCounter(sandbox());
        const p = await start(s);
        await ask(s, 'scan');
        const text = fs.readFileSync(path.join(s.lab, 'slots.txt'), 'utf8');
        assert(/slot 0x103/.test(text) && !/noise/.test(text), text);
        p.kill();
    }],
    ['--restore takes the block out and restarts once; with nothing to do, it does nothing', async () => {
        const s = withCounter(sandbox());
        fs.writeFileSync(s.conf, 'guide_hold = 0\n# dante-slotlab begin kept\npanel_slot = 0x104\npanel_scene_id = 0x01000400\npanel_content_class = 0\n# dante-slotlab end\n');
        fs.writeFileSync(path.join(s.render, 'dante-slotlab.kept'), '0x104 0x01000400 0\n');
        const run = () => spawnSync('sh', [SCRIPT.replace(/\\/g, '/'), '--restore'], { env: s.env });
        run();
        assert.strictEqual(fs.readFileSync(s.conf, 'utf8'), 'guide_hold = 0\n');
        assert(!fs.existsSync(path.join(s.render, 'dante-slotlab.kept')));
        assert.strictEqual(restarts(s), 1);
        run();
        assert.strictEqual(restarts(s), 1);
    }],
];

(async () => {
    let failed = 0, ran = 0;
    for (const [name, fn] of checks.concat(haveSh ? shellChecks : [])) {
        ran++;
        try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n     ' + e.message); }
    }
    if (!haveSh) console.log('(no sh here: the tool\'s script was not run)');
    if (failed) { console.error(failed + ' of ' + ran + ' failed'); process.exit(1); }
    console.log('Slot Lab checks passed (' + ran + ').');
    process.exit(0);
})();
