/**
 * Home Assistant discovery: one bridge device plus one device per process in the procs file,
 * linked with `via_device`.
 *
 * Pure — processes in, device blocks out; the core publishes them. The set is fixed once the procs
 * file is read, so this is built once rather than on a trigger.
 *
 * What a process gets is what you actually do with one: start it, stop it, see whether it is
 * running and how it ended. Deliberately **not** stdout/stderr — an HA sensor state is capped at
 * 255 characters and process output routinely exceeds that, so those entities would spend their
 * life logging errors. See ROADMAP.md.
 */

import {discoveryId, entity} from 'mqtt-interfaces-core';

/** A device id may only hold these; a process name is looser (dots are legal in a topic level). */
const idSafe = (text) => text.replace(/[^a-zA-Z0-9_-]/g, '_');

/** `true` when the pid topic holds one, i.e. the process is running. An empty payload is not. */
function runningTemplate(jsonPayloads) {
    return jsonPayloads ? "{{ 'ON' if value_json.val else 'OFF' }}" : "{{ 'ON' if value else 'OFF' }}";
}

/**
 * @param {object} input
 * @param {string} input.name instance name / topic prefix
 * @param {object} input.procs the validated procs file
 * @param {boolean} [input.jsonPayloads]
 * @param {string} [input.version] adapter version, shown as the bridge's firmware
 * @returns {Array<object>} device blocks for the core's discovery publisher
 */
export function discoveryModel({name, procs, jsonPayloads = true, version}) {
    const bridgeId = discoveryId('mqttpc', name);

    const blocks = Object.entries(procs).map(([proc, def]) => {
        const id = `${bridgeId}_${idSafe(proc)}`;
        const e = (item, uid, platform, label, more = {}) =>
            entity({id, name, item: `${proc}/${item}`, uid, platform, label, jsonPayloads, ...more});

        return {
            id,
            device: {
                name: proc,
                mf: 'mqttpc',
                // the program is what this device actually is
                mdl: def.path,
                via_device: bridgeId,
            },
            components: {
                running: e('pid', 'running', 'binary_sensor', 'Running', {
                    extra: {dev_cla: 'running', val_tpl: runningTemplate(jsonPayloads)},
                }),
                start: e('spawn', 'start', 'button', 'Start', {
                    command: true,
                    icon: 'mdi:play',
                    // the default "PRESS" would be written to stdin of a stdinFromSpawnPayload entry
                    extra: {pl_prs: ''},
                }),
                stop: e('signal', 'stop', 'button', 'Stop', {
                    command: true,
                    icon: 'mdi:stop',
                    extra: {pl_prs: 'SIGTERM'},
                }),
                kill: e('signal', 'kill', 'button', 'Kill', {
                    command: true,
                    icon: 'mdi:skull',
                    category: 'diagnostic',
                    extra: {pl_prs: 'SIGKILL'},
                }),
                pid: e('pid', 'pid', 'sensor', 'PID', {category: 'diagnostic', icon: 'mdi:identifier'}),
                exit: e('exit', 'exit', 'sensor', 'Last exit', {
                    category: 'diagnostic',
                    icon: 'mdi:flag-checkered',
                }),
                error: e('error', 'error', 'sensor', 'Last error', {
                    category: 'diagnostic',
                    icon: 'mdi:alert-circle-outline',
                }),
            },
        };
    });

    const bridge = {
        id: bridgeId,
        device: {mf: 'mqttpc', mdl: 'process control', ...(version && {sw: version})},
        components: {
            running: entity({
                id: bridgeId,
                name,
                item: 'bridge/running',
                uid: 'running',
                platform: 'sensor',
                label: 'Running processes',
                category: 'diagnostic',
                icon: 'mdi:cog-play',
                jsonPayloads,
            }),
        },
    };

    return [bridge, ...blocks];
}
