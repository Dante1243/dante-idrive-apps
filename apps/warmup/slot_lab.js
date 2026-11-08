'use strict';
/*
 * slot_lab.js - see what the instrument cluster's display slots are doing, from the car.
 *
 * The KOMBI shows head-unit content in numbered slots, and it has groups of them that switch each
 * other off: on an F40's HUD, a scene in 0x371 makes it disable 0x350-0x352 and BMW's guidance goes,
 * while a scene in 0x351 sits beside that guidance with nothing lost. cluster-render's `panel` target
 * (slot 0x203, the same scene id as BMW's speech dialog) is one of the switching kind: on this car
 * the map stays but the media widget and its button go. So the way to an overlay that steals nothing
 * is to find the slot on this car that behaves like 0x351. See CLUSTER.md.
 *
 * Read-only, needs nothing but cluster-render:
 *   - the slot table, from the `dcsm: slot ...` lines of cluster-render's log
 *   - which stock slots change when the icon comes up (the Test icon button)
 *
 * Trying another slot means changing cluster-render.local.conf and restarting it, which an app
 * cannot do: that is the optional root tool tools/dante-slotlab. An app asks it with one line in
 * /dev/shm/dante-slotlab/in/request and reads /dev/shm/dante-slotlab/state. Every trial runs out by
 * itself unless Keep is pressed, so a slot that upsets the KOMBI does not stay.
 */
const fs = require('fs');
const path = require('path');

const LAB_DIR = '/dev/shm/dante-slotlab';
const RENDER_LOG = '/var/opt/cluster-render/log/cluster-render.log';
const SCENE_PANEL = 0x01000400;     // cluster-render's panel and HUD; also BMW's speech dialog
const SCENE_HOLD = 0x010004f1;      // cluster-render's guide hold: known to the KOMBI, not a dialog
const SCENE_MAP = 0x010004f0;       // cluster-render's map: the same, in every version of it
const STOCK_SLOT = 0x203;
const TRIAL_S = 120;                // a trial reverts by itself after this unless kept alive
const LOG_TAIL = 262144;            // bytes of each log file to read
const hex = (n, w) => '0x' + Number(n).toString(16).padStart(w || 3, '0');

// content the slot tables of several cars have shown (cluster-render's docs and issues)
const CONTENT = {
    0x1000210: 'BMW HUD guidance', 0x1000251: 'BMW HUD pop-up', 0x1000300: 'BMW map', 0x1000310: 'BMW turn box',
    0x1000314: 'BMW reduced box', 0x1000351: 'BMW pop-up', 0x1000400: 'Panel or speech dialog', 0x10004f0: 'Map layer',
    0x10004f1: 'Oil icon or guide hold',
};
const OURS = [0x1000400, 0x10004f0, 0x10004f1];
const STATUS = ['disabled', 'free', 'occupied'];
const MAP = ['unmapped', 'shown', 'behind', 'parked'];

/** `dcsm: slot ...` lines to a Map of slot -> { slot, status, rows: Map of content -> { content, cls, map } }. */
function parseSlots(text) {
    const slots = new Map(), re = /dcsm: slot 0x([0-9a-f]+) status (\d+) content 0x([0-9a-f]+) class (\d+) map (\d+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const id = parseInt(m[1], 16), content = parseInt(m[3], 16);
        let s = slots.get(id);
        if (!s) { s = { slot: id, status: 0, rows: new Map() }; slots.set(id, s); }
        s.status = Number(m[2]);
        if (content) s.rows.set(content, { content, cls: Number(m[4]), map: Number(m[5]) });
    }
    return slots;
}

/** What a slot is showing, for a table row. */
function describe(s) {
    const rows = Array.from(s.rows.values());
    const shown = rows.find((r) => r.map === 1 || r.map === 2), parked = rows.find((r) => r.map === 3);
    const top = shown || parked || null;
    const state = s.status === 0 ? 'disabled' : shown ? 'shown' : parked ? 'parked' : 'free';
    return { slot: s.slot, state, content: top ? top.content : 0, cls: top ? top.cls : null, name: top ? (CONTENT[top.content] || hex(top.content, 7)) : '' };
}

/** A copy of a table: what it says now, for comparing later. */
function snapshot(slots) {
    const out = new Map();
    slots.forEach((s, id) => {
        const rows = new Map();
        s.rows.forEach((r, c) => rows.set(c, Object.assign({}, r)));
        out.set(id, { slot: id, status: s.status, rows });
    });
    return out;
}

/** What changed between two tables, leaving out cluster-render's own scenes. */
function changes(before, after) {
    const out = [];
    after.forEach((a, id) => {
        const b = before.get(id);
        if (b && a.status !== b.status) out.push(hex(id) + ' ' + (STATUS[b.status] || b.status) + ' to ' + (STATUS[a.status] || a.status));
        a.rows.forEach((r, c) => {
            if (OURS.indexOf(c) >= 0) return;
            const was = b && b.rows.get(c);
            if (!was || was.map !== r.map) out.push((CONTENT[c] || hex(c, 7)) + ' in ' + hex(id) + ' ' + (was ? (MAP[was.map] || was.map) + ' to ' : '') + (MAP[r.map] || r.map));
        });
    });
    return out;
}

/** The result of the Test icon check, in words. */
function explain(before, after, seen) {
    if (!seen) return 'No slot table to read yet. Try again in a moment.';
    const c = changes(before, after);
    if (!c.length) return 'No stock slot changed, so the KOMBI looks to be hiding the widget by itself.';
    return 'Icon up changed: ' + c.slice(0, 3).join('; ') + (c.length > 3 ? ' and ' + (c.length - 3) + ' more' : '');
}

/**
 * What to try, in order. First stock, then the same slot with what might stop the KOMBI treating it
 * as a dialog (keeps the exact position), then every other slot it reports free: the cluster's, then
 * the HUD's. Never a disabled or occupied slot.
 */
function candidates(slots) {
    const list = [
        { slot: STOCK_SLOT, scene: SCENE_PANEL, cls: 0, stock: true, why: 'Stock: hides the widget' },
        { slot: STOCK_SLOT, scene: SCENE_HOLD, cls: 0, why: 'Same spot, not the speech dialog id' },
        { slot: STOCK_SLOT, scene: SCENE_MAP, cls: 0, why: 'Same spot, the map scene id' },
        { slot: STOCK_SLOT, scene: SCENE_PANEL, cls: 512, why: 'Same spot, pop-up class' },
    ];
    const free = [];
    slots.forEach((s) => {
        // a slot showing our own trial still counts, or the list would shrink under Next slot
        const stock = Array.from(s.rows.values()).some((r) => r.map !== 0 && OURS.indexOf(r.content) < 0);
        if (s.slot !== STOCK_SLOT && s.status !== 0 && !stock) free.push(s.slot);
    });
    // another slot goes with the guide hold's scene id: the panel's (0x01000400) is the HUD target's too in
    // cluster-render, so any app drawing on the HUD would hold the icon back ("scene id in use by another
    // target", seen on a G20). The hold's id is only taken while a guide hold is up (Waze on the cluster).
    free.sort((a, b) => a - b).forEach((slot) => list.push({ slot, scene: SCENE_HOLD, cls: 0, why: slot >= 0x300 ? 'Free HUD slot' : 'Free cluster slot' }));
    return list;
}

/** cluster-render's status text: its targets and what they are doing. */
function parseStatus(text) {
    const targets = {};
    String(text || '').split('\n').forEach((l) => {
        const m = /^target (\S+): slot 0x([0-9a-f]+) scene 0x([0-9a-f]+) (\d+)x(\d+): (.*)$/.exec(l);
        if (m) targets[m[1]] = { slot: parseInt(m[2], 16), scene: parseInt(m[3], 16), w: Number(m[4]), h: Number(m[5]), state: m[6] };
    });
    return { targets, dcsm: (/^dcsm: Dcsm2 ([^;\n]*)/m.exec(String(text || '')) || [])[1] || null };
}

function tail(file, bytes) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), b = Buffer.alloc(n);
        fs.readSync(fd, b, 0, n, size - n);
        return b.toString('latin1');
    } catch (e) { return ''; } finally { if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* gone */ } }
}

class SlotLab {
    constructor(opts) {
        opts = opts || {};
        this.dir = opts.dir || process.env.MGU_SLOTLAB_DIR || LAB_DIR;
        this.logFile = opts.logFile || process.env.MGU_SLOTLAB_LOG || RENDER_LOG;
        this.log = opts.log || { info() {}, warn() {} };
        this.slots = new Map();         // the table
        this.tool = null;               // the root tool's state; null: not installed or not started
        this.status = { targets: {}, dcsm: null };
        this.finding = '';              // what the last Test icon showed
        this.trial = null;              // the candidate on trial
        this.note = '';
        this.index = 0;
    }

    /** Read the table and the tool's state. Cheap, but only needed while the page is up. */
    refresh() {
        this.tool = this._readTool();
        // (one request at a time: a scan must not replace a try the tool has not taken yet)
        if (this.tool && !fs.existsSync(path.join(this.dir, 'in', 'request'))) this._ask('scan');
        let text = '';
        try { text = fs.readFileSync(path.join(this.dir, 'slots.txt'), 'latin1'); } catch (e) { /* no tool */ }
        if (!text) text = tail(this.logFile + '.1', LOG_TAIL) + tail(this.logFile, LOG_TAIL);
        if (text) this.slots = parseSlots(text);
        return this;
    }

    _readTool() {
        let raw;
        try { raw = fs.readFileSync(path.join(this.dir, 'state'), 'utf8'); } catch (e) { return null; }
        const s = {};
        raw.split('\n').forEach((l) => { const i = l.indexOf('='); if (i > 0) s[l.slice(0, i)] = l.slice(i + 1); });
        return s;
    }

    _ask(line) {
        const dir = path.join(this.dir, 'in'), tmp = path.join(dir, 'request.' + process.pid);
        try {
            fs.writeFileSync(tmp, line + '\n');
            fs.renameSync(tmp, path.join(dir, 'request'));
            return true;
        } catch (e) { this.log.warn('slot lab: ' + e); return false; }
    }

    rows() {
        return Array.from(this.slots.values()).sort((a, b) => a.slot - b.slot).map(describe);
    }

    list() { return candidates(this.slots); }

    get seen() { return this.slots.size > 0; }

    _line(c) { return 'try ' + hex(c.slot) + ' ' + hex(c.scene, 8) + ' ' + c.cls + ' ' + TRIAL_S; }

    /** Move on to the next candidate. Stock ends the trial. parked: the caller's word for it. */
    next(parked) {
        if (!parked) { this.note = 'Park first: this only runs at a standstill'; return null; }
        if (!this.tool) { this.note = 'Install Cluster Slot Lab from the Store first'; return null; }
        const list = this.list();
        this.index = (this.index + 1) % list.length;
        const c = list[this.index];
        if (c.stock) { this.stock(); return c; }
        this.trial = c;
        this.note = '';
        this._ask(this._line(c));
        this.log.info('slot lab: trying ' + this._line(c));
        return c;
    }

    /** A trial runs out unless it is asked for again. */
    keepAlive() { return this.trial ? this._ask(this._line(this.trial)) : false; }

    /** Make the trial stick, across restarts too. */
    keep() {
        if (!this.trial) { this.note = 'Nothing on trial to keep'; return false; }
        this._ask('keep');
        this.log.info('slot lab: keeping ' + this._line(this.trial));
        this.note = 'Kept ' + hex(this.trial.slot);
        this.trial = null;
        return true;
    }

    /** Back to cluster-render's own settings. */
    stock() {
        this.trial = null; this.index = 0;
        this.note = '';
        if (this.tool) this._ask('stock');
    }

    /** A trial must not outlive standing still. */
    abort(why) {
        if (!this.trial) return;
        this.trial = null; this.index = 0;
        this._ask('revert');
        this.note = why;
        this.log.info('slot lab: ' + why);
    }
}

module.exports = { SlotLab, parseSlots, parseStatus, describe, snapshot, changes, explain, candidates, hex, STOCK_SLOT, SCENE_PANEL, SCENE_HOLD };
