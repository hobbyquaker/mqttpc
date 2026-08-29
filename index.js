#!/usr/bin/env node

/**
 * mqttpc — control processes on a host over MQTT, on mqtt-interfaces-core.
 *
 *   <name>/set/<proc>/spawn    start it (payload ignored)
 *   <name>/set/<proc>/signal   send a signal, default SIGTERM
 *   <name>/set/<proc>/pipe     write the payload to its stdin
 *   <name>/status/<proc>/{pid,exit,error,stdout,stderr}
 *
 * The procs file is the allowlist: MQTT picks which entry runs, never what the command is.
 */

import {createAdapter} from 'mqtt-interfaces-core';
import config from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall, ROOT_WARNING} from './lib/install.js';
import {loadProcs, needsRoot} from './lib/procs.js';
import {createRunner} from './lib/runner.js';
import {createDispatch} from './lib/dispatch.js';

handleInstall(config); // --install / --uninstall never reach the rest

const {procs, problems} = loadProcs(config.procsFile);
if (problems.length > 0) {
    // starting with an empty allowlist would look like it worked and then do nothing
    for (const problem of problems) {
        console.error(`mqttpc: ${problem}`);
    }
    process.exit(1);
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
let runner;
let dispatch;

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'proc',
    info: () => ({
        procsFile: config.procsFile,
        processes: Object.keys(procs),
        running: runner ? runner.names : [],
        root: isRoot,
    }),
    onSet: (...args) => dispatch(...args),
    // children of a process controller outlive nothing: stop them with it
    onShutdown: () => runner.stopAll(),
});

runner = createRunner({
    procs,
    log: adapter.log,
    isRoot,
    publish: (item, value, options) => adapter.pubStatus(item, value, options),
});
dispatch = createDispatch({procs, runner, log: adapter.log});

if (isRoot) {
    adapter.log.warn(ROOT_WARNING.replace('<name>', config.name));
}
const wantsRoot = needsRoot(procs);
if (wantsRoot.length > 0 && !isRoot) {
    // uid/gid are silently ignored when we cannot use them, which would look like a bug later
    adapter.log.warn(`uid/gid ignored for ${wantsRoot.join(', ')} — only root can start a process as another user`);
}
adapter.log.info(`${Object.keys(procs).length} process(es) from ${config.procsFile}`);
adapter.start();
adapter.setDeviceConnected(true); // nothing to connect to: the host is always there
