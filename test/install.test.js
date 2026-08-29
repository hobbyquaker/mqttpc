import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

process.env.MQTTPC_MQTT_URL ||= 'mqtt://test';
process.env.MQTTPC_PROCS_FILE ||= '/etc/mqttpc/test.json';
const {unitFile, envFile, installerFor, ROOT_WARNING} = await import('../lib/install.js');
const {OPTIONS} = await import('../config.js');
const {SHARED_OPTIONS, configSchema} = await import('mqtt-interfaces-core');
const pkg = (await import('../package.json', {with: {type: 'json'}})).default;

describe('install', () => {
    test('the unit runs as the mqttpc user by default', () => {
        const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/mqttpc/index.js');
        assert.match(unit, /^User=mqttpc$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/mqttpc\/%i\.env$/m);
        assert.match(unit, /^SyslogIdentifier=mqttpc@%i$/m);
    });

    test('the sandbox is off — it would be inherited by everything mqttpc runs', () => {
        /*
         * ProtectHome would hide /home from a backup script, ProtectSystem=full would make /usr
         * read-only for it, and NoNewPrivileges=true would stop sudo working at all — which is the
         * arrangement that lets mqttpc stay unprivileged and still reboot the machine.
         */
        const unit = unitFile('/usr/bin/node index.js');
        assert.doesNotMatch(unit, /NoNewPrivileges/);
        assert.doesNotMatch(unit, /ProtectHome/);
        assert.doesNotMatch(unit, /ProtectSystem/);
        assert.doesNotMatch(unit, /PrivateTmp/);
    });

    test('--root makes the unit run as root, and nothing else does', () => {
        const asRoot = installerFor({root: true}).unitFile('/usr/bin/node index.js');
        assert.match(asRoot, /^User=root$/m);
        assert.match(asRoot, /^Group=root$/m);
        assert.match(installerFor({}).unitFile('/usr/bin/node index.js'), /^User=mqttpc$/m);
    });

    test('the root warning names the risk and points at the alternative', () => {
        assert.match(ROOT_WARNING, /set\/#/);
        assert.match(ROOT_WARNING, /sudoers/);
    });

    test('env file carries the procs file path', () => {
        const argv = {name: 'pc', procsFile: '/etc/mqttpc/pc.procs.json', mqttUrl: 'mqtt://b'};
        Object.defineProperty(argv, '$options', {value: {...OPTIONS, ...SHARED_OPTIONS}});
        const out = envFile(argv);
        assert.match(out, /^MQTTPC_PROCS_FILE=\/etc\/mqttpc\/pc\.procs\.json$/m);
    });
});

describe('config schema', () => {
    const schema = configSchema({
        pkg,
        envPrefix: 'MQTTPC',
        options: OPTIONS,
        defaults: {name: 'pc'},
        scriptName: 'mqttpc',
    });

    test('the procs file is declared as a file, so a config ui can edit it', () => {
        assert.deepEqual(schema.properties['procs-file']['x-file'], {
            format: 'json',
            example: 'example-procs.json',
            schema: 'procs.schema.json',
            describe: 'processes mqttpc may run',
        });
        assert.ok((schema.required || []).includes('procs-file'));
    });

    test('every option is described', () => {
        for (const [key, prop] of Object.entries(schema.properties)) {
            assert.ok(prop.description, `${key} has no description`);
        }
    });

    test('the package ships the example and the schema it points at', async () => {
        for (const f of ['example-procs.json', 'procs.schema.json']) {
            assert.ok(pkg.files.includes(f), `${f} is not in package.json files`);
        }
    });
});
