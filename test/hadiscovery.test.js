/**
 * The HA model: one device per process, hanging off a bridge device.
 *
 * Payload keys are HA's abbreviations (`p`, `stat_t`, `cmd_t`, `dev_cla`, `ent_cat`, `pl_prs`) —
 * asserted literally, because a typo in one of them is invisible until HA silently ignores the
 * entity.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryModel} from '../lib/hadiscovery.js';

const PROCS = {
    backup: {path: '/usr/local/bin/backup.sh'},
    'log.tail': {path: '/usr/bin/tail', args: ['-f', '/var/log/syslog']},
};

const model = (over = {}) => discoveryModel({name: 'pc', procs: PROCS, version: '2.1.0', ...over});
const deviceFor = (blocks, procName) => blocks.find((b) => b.device.name === procName);

describe('shape', () => {
    test('a bridge device plus one device per process', () => {
        const blocks = model();
        assert.equal(blocks.length, 3);
        assert.equal(blocks[0].device.mdl, 'process control', 'the bridge comes first');
        assert.deepEqual(
            blocks.slice(1).map((b) => b.device.name),
            ['backup', 'log.tail'],
        );
    });

    test('each process hangs off the bridge and is named after its program', () => {
        const blocks = model();
        const backup = deviceFor(blocks, 'backup');
        assert.equal(backup.device.via_device, blocks[0].id);
        assert.equal(backup.device.mdl, '/usr/local/bin/backup.sh');
        assert.equal(backup.device.mf, 'mqttpc');
    });

    test('a process name that is a legal topic level but not a legal id is sanitised', () => {
        // dots are fine in a topic level and not in a discovery id
        const blocks = model();
        assert.equal(deviceFor(blocks, 'log.tail').id, 'mqttpc_pc_log_tail');
        assert.match(deviceFor(blocks, 'log.tail').components.running.uniq_id, /^mqttpc_pc_log_tail_/);
    });

    test('unique ids do not collide across processes or entities', () => {
        const ids = model().flatMap((b) => Object.values(b.components).map((c) => c.uniq_id));
        assert.equal(new Set(ids).size, ids.length, ids.join(' '));
    });
});

describe('entities', () => {
    const backup = () => deviceFor(model(), 'backup').components;

    test('running is a binary_sensor off the pid topic — a pid means it is running', () => {
        const running = backup().running;
        assert.equal(running.p, 'binary_sensor');
        assert.equal(running.stat_t, 'pc/status/backup/pid');
        assert.equal(running.dev_cla, 'running');
        assert.equal(running.val_tpl, "{{ 'ON' if value_json.val else 'OFF' }}");
    });

    test('without json payloads the template reads the plain value', () => {
        const running = deviceFor(model({jsonPayloads: false}), 'backup').components.running;
        assert.equal(running.val_tpl, "{{ 'ON' if value else 'OFF' }}");
    });

    test('start is a button that presses an empty payload', () => {
        // HA's default "PRESS" would land in stdin of a stdinFromSpawnPayload entry
        const start = backup().start;
        assert.equal(start.p, 'button');
        assert.equal(start.cmd_t, 'pc/set/backup/spawn');
        assert.equal(start.pl_prs, '');
        assert.equal(start.stat_t, undefined, 'a button has no state');
    });

    test('stop and kill are the same topic with different signals', () => {
        const {stop, kill} = backup();
        assert.equal(stop.cmd_t, 'pc/set/backup/signal');
        assert.equal(stop.pl_prs, 'SIGTERM');
        assert.equal(kill.cmd_t, 'pc/set/backup/signal');
        assert.equal(kill.pl_prs, 'SIGKILL');
        assert.notEqual(stop.uniq_id, kill.uniq_id, 'same item, so the uid must differ');
        assert.equal(kill.ent_cat, 'diagnostic', 'kill is not the everyday button');
    });

    test('pid, exit and error are diagnostics, running and the buttons are not', () => {
        const c = backup();
        for (const key of ['pid', 'exit', 'error', 'kill']) {
            assert.equal(c[key].ent_cat, 'diagnostic', key);
        }
        for (const key of ['running', 'start', 'stop']) {
            assert.equal(c[key].ent_cat, undefined, key);
        }
    });

    test('no stdout or stderr entity — HA caps a sensor state at 255 characters', () => {
        const c = backup();
        for (const key of ['stdout', 'stderr', 'output']) {
            assert.equal(c[key], undefined, `${key} would spend its life logging errors`);
        }
    });

    test('every state topic points at something mqttpc actually publishes', () => {
        const published = new Set(['pid', 'exit', 'error']);
        for (const block of model().slice(1)) {
            for (const [key, comp] of Object.entries(block.components)) {
                if (!comp.stat_t) continue;
                const item = comp.stat_t.split('/').pop();
                assert.ok(published.has(item), `${key} reads ${comp.stat_t}, which is never published`);
            }
        }
    });
});

describe('the bridge device', () => {
    test('carries the version and a count of what is running', () => {
        const bridge = model()[0];
        assert.equal(bridge.device.sw, '2.1.0');
        assert.equal(bridge.components.running.stat_t, 'pc/status/bridge/running');
        assert.equal(bridge.components.running.ent_cat, 'diagnostic');
    });

    test('an empty procs file still yields the bridge alone', () => {
        const blocks = discoveryModel({name: 'pc', procs: {}});
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].components.running.p, 'sensor');
    });
});
