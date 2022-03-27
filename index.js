#!/usr/bin/env node

var pkg =       require('./package.json');
var log =       require('yalm');
var config =    require('./config.js');
var Mqtt =      require('mqtt');
var spawn =     require('child_process').spawn;

var procs =     require(config.config);

const DEFAULT_BUF_SIZE = 128 * 1024;
const TOPICS_TO_WATCH_FOR_RETAINED_FROM_PREVIOUS_CONF = '/status/+/stdout /status/+/stderr /status/+/output'.split(' ');
const TOPICS_TO_WATCH_FOR_RETAINED_TIMEOUT_MS = 20 * 1000;

var mqttConnected;

log.setLevel(config.verbosity);

log.info(pkg.name + ' ' + pkg.version + ' starting');
log.info('mqtt trying to connect', config.url);

var mqtt = Mqtt.connect(config.url, {will: {topic: config.name + '/connected', payload: '0', retain: true}});

mqtt.on('connect', function () {
    mqttConnected = true;

    log.info('mqtt connected', config.url);
    mqtt.publish(config.name + '/connected', '1', {retain: true});

    const subAndLog = (topic) => {
        log.info('mqtt subscribe', config.name + topic);
        mqtt.subscribe(config.name + topic);
    }

    subAndLog('/set/#');

    TOPICS_TO_WATCH_FOR_RETAINED_FROM_PREVIOUS_CONF.forEach(x => subAndLog(x));
    setTimeout(() => {
        const topics = TOPICS_TO_WATCH_FOR_RETAINED_FROM_PREVIOUS_CONF.map(x => config.name + x);
        log.info('mqtt unsubscribe', topics.join(" and "));
        mqtt.unsubscribe(topics);
    }, TOPICS_TO_WATCH_FOR_RETAINED_TIMEOUT_MS);
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

function appendBuffer(proc, fdName, data) {
    const fds = proc._fdBuffers = proc._fdBuffers || {};
    const fdBuf = fds[fdName] = fds[fdName] || { len: 0, data: [], clipped: 0 };
    fdBuf.len += data.length;
    fdBuf.data.push(data);
    const max_buffer_size = proc.bufferMax || DEFAULT_BUF_SIZE;
    while (fdBuf.data.length > 1 && fdBuf.len > (max_buffer_size + fdBuf.data[0].length)) {
        const plopped = fdBuf.data.shift();
        fdBuf.len -= plopped.length;
        fdBuf.clipped += plopped.length;
    }
}

function handleProcessOutputEach(procName, proc, fdName, data) {
    log.debug(procName, fdName, data.toString().replace(/\n$/, ''));
    let retain = false;
    switch (proc[fdName] || 'drop') {
        case 'drop': break;
        case 'buffer':
        case 'buffer_retain':
            appendBuffer(proc, fdName, data);
            break;
        case 'stream_retain':
            retain = true;
            // no break: passthrough on purpose here
        case 'stream':
            mqtt.publish(config.name + '/status/' + procName + '/' + fdName, data, {retain});
            break;
        default:
            throw new Error("Unknown handler " + JSON.stringify(proc[fdName]) + " in proc definition for " + procName);
    }
}

function handleProcessOutput(procName, proc, fdName, data) {
    handleProcessOutputEach(procName, proc, fdName, data);
    handleProcessOutputEach(procName, proc, 'output', data);
}

function handleProcessOutputAtExit(procName, proc, fdName) {
    let retain = false;
    switch (proc[fdName] || 'drop') {
        case 'buffer_retain':
            retain = true;
            // no break: passthrough on purpose here
        case 'buffer':
            const fds = proc._fdBuffers = proc._fdBuffers || {};
            const fdBuf = fds[fdName] = fds[fdName] || { len: 0, data: [] };
            if (!fdBuf.len) return;
            const dropped = fdBuf.clipped ? `...(clipped ${fdBuf.clipped})...\n` : "";
            const result = Buffer.concat(fdBuf.data, fdBuf.len);
            mqtt.publish(config.name + '/status/' + procName + '/' + fdName, dropped ? (dropped + result.toString()) : result, {retain});
            delete fdBuf[fdName];
            break;
    }
}

function fdActionHasRetain(proc, fdName) {
    return proc[fdName] == 'buffer_retain' || [fdName] == 'stream_retain';
}

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

    delete proc._fdBuffers;
    proc._.stdout.on('data', data => handleProcessOutput(procName, proc, 'stdout', data));
    proc._.stderr.on('data', data => handleProcessOutput(procName, proc, 'stderr', data));

    proc._.on('exit', function (code, signal) {
        log.info(procName, 'exit', code, signal);
        handleProcessOutputAtExit(procName, proc, 'stdout');
        handleProcessOutputAtExit(procName, proc, 'stderr');
        handleProcessOutputAtExit(procName, proc, 'output');
        mqtt.publish(config.name + '/status/' + procName + '/pid', '', {retain: true});
        mqtt.publish(config.name + '/status/' + procName + '/exit', '' + (code === null ? signal : code), {retain: true});
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

mqtt.on('message', function (topic, payload, packet) {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);

    var tmp = topic.substr(config.name.length).split('/');
    const dir = tmp[1];
    var p = tmp[2];
    var cmd = tmp[3];

    if (!procs[p]) {
        log.error('unknown process ' + p);
        return;
    }
    var proc = procs[p];

    if (dir == "status") {
        if (!packet.retain) return;

        const fd = cmd;
        if (!fdActionHasRetain(proc)) {
            log.warn(p, 'deleting retained mqtt but not retained in config', packet);
            mqtt.publish(topic, "", {retain: true});
        }
        return;
    }


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
