/**
 * Adapter options on top of the core's parseConfig(): the shared MQTT / name / maintenance
 * options, MQTTPC_* environment variables and --config-schema come from mqtt-interfaces-core.
 *
 * mqttpc runs other programs, so what it may run is a file rather than a set of flags — see
 * --procs-file, which a management UI can edit against the JSON schema shipped with the package.
 */

import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};

export const OPTIONS = {
    'procs-file': {
        alias: 'f',
        type: 'string',
        describe: 'JSON file listing the processes this instance may run (see example-procs.json)',
        demandOption: true,
        file: {
            format: 'json',
            example: 'example-procs.json',
            schema: 'procs.schema.json',
            describe: 'processes mqttpc may run',
        },
    },
    root: {
        type: 'boolean',
        describe: 'run the service as root — every process starts with full privileges. Prefer a sudoers entry',
        default: false,
    },
};

/** yargs .check(): what the option types cannot express. */
export function check(argv) {
    if (argv.root && !argv.install && process.getuid && process.getuid() !== 0) {
        throw new Error('--root only makes sense for --install, or when already running as root');
    }
    return true;
}

export default parseConfig({
    pkg,
    options: OPTIONS,
    defaults: {name: 'pc'},
    check,
    examples: [
        ['$0 -u mqtt://broker -f /etc/mqttpc/pc.procs.json', 'run in the foreground'],
        ['sudo $0 --install -n pc -u mqtt://broker -f /etc/mqttpc/pc.procs.json', 'install as mqttpc@pc'],
        ['sudo $0 --install -n pc --root -f …', 'install running as root (discouraged, see the README)'],
    ],
    epilog:
        'mqttpc runs the programs named in its procs file on request over MQTT. Anyone who can\n' +
        'publish to <name>/set/# can run every one of them, so keep that file small and give the\n' +
        'instance its own broker credentials with an ACL. Prefer a sudoers entry over --root.\n' +
        pkg.homepage,
});
