#!/usr/bin/env node

var pkg =       require('./package.json');
var log =       require('yalm');
var config =    require('./config.js');
var Mqtt =      require('mqtt');
var spawn =     require('child_process').spawn;

var procs =     require(config.config);

var mqttConnected;

log.setLevel(config.verbosity);

log.info(pkg.name + ' ' + pkg.version + ' starting');
log.info('mqtt trying to connect', config.url);

var mqtt = Mqtt.connect(config.url, {will: {topic: config.name + '/connected', payload: '0', retain: true}});

mqtt.on('connect', function () {
    mqttConnected = true;

    log.info('mqtt connected', config.url);
    mqtt.publish(config.name + '/connected', '1', {retain: true});

    log.info('mqtt subscribe', config.name + '/set/#');
    mqtt.subscribe(config.name + '/set/#');

});

mqtt.on('close', function () {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.url);
    }

});

mqtt.on('error', function (err) {
    log.error('mqtt', err);

});

function processSpawn(procName, proc, payload) {
    if (proc._) {
        if (proc.enqueueSpawns) {
            log.warn(procName, 'already running', proc._.pid, ' enqueuing...');
            (proc.queue = proc.queue || []).push(payload);
        } else {
            log.error(procName, 'already running', proc._.pid);
        }
        return;
    }

    mqtt.publish(config.name + '/status/' + procName + '/error', '', {retain: true});

    proc._ = spawn(proc.path, proc.args, {
        cwd: proc.cwd,
        env: proc.env,
        uid: proc.uid,
        gid: proc.gid,
        shell: proc.shell,
        stdio: 'pipe'
    });

    if (proc._.pid) {
        log.info(procName, 'started', proc.path, proc._.pid);
        mqtt.publish(config.name + '/status/' + procName + '/pid', '' + proc._.pid, {retain: true});

    } else {
        log.error(procName, 'no pid, start failed');
    }

    proc._.stdout.on('data', function (data) {
        log.debug(procName, 'stdout', data.toString().replace(/\n$/, ''));
        if (!proc.disableStdout) mqtt.publish(config.name + '/status/' + procName + '/stdout', data.toString(), {retain: true});
    });

    proc._.stderr.on('data', function (data) {
        log.debug(procName, 'stderr', data.toString().replace(/\n$/, ''));
        if (!proc.disableStderr) mqtt.publish(config.name + '/status/' + procName + '/stderr', data.toString(), {retain: true});
    });

    proc._.on('exit', function (code, signal) {
        log.info(procName, 'exit', code, signal);
        mqtt.publish(config.name + '/status/' + procName + '/pid', '', {retain: true});
        mqtt.publish(config.name + '/status/' + procName + '/exit', '' + (typeof code === null ? signal : code), {retain: true});
        delete(proc._);
        if (proc.queue && proc.queue.length) {
            log.info(procName, 'finished running, dequeuing...');
            processSpawn(procName, proc, proc.queue.shift());
        }
    });

    proc._.on('error', function (e) {
        log.error(procName, 'error', e);
        mqtt.publish(config.name + '/status/' + procName + '/error', e.toString(), {retain: true});
    });

    if (proc.stdinFromSpawnPayload) {
        proc._.stdin.write(payload);
        proc._.stdin.end();
    }

}

mqtt.on('message', function (topic, payload) {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);

    var tmp = topic.substr(config.name.length).split('/');

    var p = tmp[2];
    var cmd = tmp[3];

    if (!procs[p]) {
        log.error('unknown process ' + p);
        return;
    }

    var proc = procs[p];

    switch (cmd) {
        case 'pipe':
            if (proc.disableStdin) {
                log.error('piping to stdin disabled');
                return;
            }
            if (!proc._) {
                log.error(p, 'not running');
                return;
            }
            if (payload.length)
                proc._.stdin.write(payload);
            else
                proc._.stdin.end();
            break;


        case 'spawn':
            processSpawn(p, proc, payload);
            break;


        case 'signal':
            if (!proc._) {
                log.error(p, 'not running');
                return;
            }
            if (!payload.match(/SIG[A-Z]+/)) {
                log.error(p, 'invalid signal', payload);
            }
            log.info(p, 'sending', payload);
            proc._.kill(payload);

            break;


        default:
            log.error('received unknown command ' + cmd + ' for process ' + p);
    }

});
