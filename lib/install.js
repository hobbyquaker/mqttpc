/**
 * --install / --uninstall: systemd template service mqttpc@<name>.
 *
 * Two deliberate differences from every other adapter in the fleet, both because this one exists
 * to run *other* programs:
 *
 *   hardening: false   the systemd sandbox is inherited by every child, so ProtectHome would hide
 *                      /home from a backup script, ProtectSystem=full would make /usr read-only
 *                      for it, and NoNewPrivileges=true would stop `sudo` working at all — which
 *                      is the arrangement that lets mqttpc stay unprivileged and still reboot the
 *                      machine.
 *   --root             opt-in User=root. Discouraged: it turns "may publish to <name>/set/#" into
 *                      "may run anything as root". The README documents the sudoers alternative.
 */

import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'mqttpc';
export const ENV_PREFIX = 'MQTTPC';

/** The installer for one run — the unit's user depends on --root, so it cannot be built once. */
export function installerFor({root = false} = {}) {
    return createInstaller({
        service: SERVICE,
        envPrefix: ENV_PREFIX,
        description: `${SERVICE} %i - process control over MQTT`,
        documentation: 'https://github.com/hobbyquaker/mqttpc',
        user: root ? 'root' : SERVICE,
        // a process controller cannot sandbox itself without sandboxing what it runs
        hardening: false,
    });
}

/** The warning `--install --root` prints, and `index.js` logs on every start. */
export const ROOT_WARNING =
    'running as root: anyone who can publish to <name>/set/# can run every process in the procs ' +
    'file with full privileges. A sudoers entry for the few commands that need it is safer — see ' +
    'https://github.com/hobbyquaker/mqttpc#running-without-root';

export function handle(config, log = console.log) {
    if (config.install && config.root) {
        log(`WARNING: ${ROOT_WARNING}`);
    }
    return installerFor({root: config.root}).handle(config);
}

export const {unitFile, envFile} = installerFor();
