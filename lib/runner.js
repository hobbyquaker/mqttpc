/**
 * Running the processes: spawn, signal, pipe, and what each of those publishes.
 *
 * Separated from index.js so the lifecycle can be tested against a fake spawn — a real one would
 * make the tests depend on the machine they run on.
 *
 * The output modes, the buffering, `stdinFromSpawnPayload` and `enqueueSpawns` come from
 * ddlsmurf's PR #1 (2023), reworked here: `stream` stays the default, as 1.x behaved, rather than
 * `drop`.
 */

import {spawn as nodeSpawn} from 'node:child_process';
import {spawnOptions, isSignal} from './procs.js';

/** Bytes kept in buffer mode before the oldest output is dropped. */
export const DEFAULT_BUFFER_MAX = 128 * 1024;

/** What an entry can ask for per output stream. */
export const OUTPUT_MODES = ['drop', 'stream', 'stream_retain', 'buffer', 'buffer_retain'];

/**
 * The mode for one stream, honouring the 1.x `disableStdout` / `disableStderr` booleans.
 *
 * `stdout` and `stderr` stream by default, which is what 1.x did (retained, which was wrong — see
 * the changelog). `output`, the two combined, is off unless asked for: defaulting it to stream
 * would publish everything twice.
 */
export function outputMode(proc, stream) {
    const explicit = proc[stream];
    if (typeof explicit === 'string') {
        return explicit;
    }
    if (stream === 'output') {
        return 'drop';
    }
    if (stream === 'stdout' && proc.disableStdout) {
        return 'drop';
    }
    if (stream === 'stderr' && proc.disableStderr) {
        return 'drop';
    }
    return 'stream';
}

/**
 * @param {object} options
 * @param {object} options.procs the validated procs file
 * @param {object} options.log
 * @param {(item: string, value: *, opts?: object) => void} options.publish `<name>/status/<item>`
 * @param {boolean} [options.isRoot] whether uid/gid in an entry can be honoured
 * @param {() => void} [options.onChange] called whenever something starts or stops
 * @param {Function} [options.spawn] for tests
 */
export function createRunner({procs, log, publish, isRoot = false, onChange = () => {}, spawn = nodeSpawn}) {
    /** name → the running ChildProcess. Absent means not running. */
    const running = new Map();
    /** name → payloads waiting for their turn (`enqueueSpawns`). */
    const queues = new Map();
    /** name → {stream: {chunks, bytes, clipped}} while buffering. */
    const buffers = new Map();

    const statusOf = (name, item, value, opts) => publish(`${name}/${item}`, value, opts);

    function bufferOf(name, stream) {
        const perProc = buffers.get(name) || {};
        buffers.set(name, perProc);
        perProc[stream] = perProc[stream] || {chunks: [], bytes: 0, clipped: 0};
        return perProc[stream];
    }

    /** Append, dropping the oldest chunks once the buffer is over its limit. */
    function appendBuffer(name, stream, data, max) {
        const buf = bufferOf(name, stream);
        buf.chunks.push(data);
        buf.bytes += data.length;
        while (buf.chunks.length > 1 && buf.bytes > max) {
            const dropped = buf.chunks.shift();
            buf.bytes -= dropped.length;
            buf.clipped += dropped.length;
        }
    }

    function handleOutput(name, proc, stream, data) {
        const mode = outputMode(proc, stream);
        const max = Number(proc.bufferMax) > 0 ? Number(proc.bufferMax) : DEFAULT_BUFFER_MAX;
        switch (mode) {
            case 'drop':
                break;
            case 'stream':
            case 'stream_retain':
                statusOf(name, stream, data.toString(), {retain: mode === 'stream_retain'});
                break;
            case 'buffer':
            case 'buffer_retain':
                appendBuffer(name, stream, data, max);
                break;
            default:
                // validate() refuses an unknown mode, so this is only reachable through the api
                log.warn(name, 'unknown output mode', mode, 'for', stream);
        }
    }

    /** Publish what buffer mode collected, once, when the process is done. */
    function flushBuffer(name, proc, stream) {
        const mode = outputMode(proc, stream);
        if (mode !== 'buffer' && mode !== 'buffer_retain') {
            return;
        }
        const buf = bufferOf(name, stream);
        if (buf.bytes === 0 && buf.clipped === 0) {
            return;
        }
        const body = Buffer.concat(buf.chunks, buf.bytes).toString();
        // say so rather than silently handing back a truncated log
        const text = buf.clipped > 0 ? `...(clipped ${buf.clipped} bytes)...\n${body}` : body;
        statusOf(name, stream, text, {retain: mode === 'buffer_retain'});
    }

    function start(name, payload = '') {
        const proc = procs[name];
        if (running.has(name)) {
            if (proc.enqueueSpawns) {
                const queue = queues.get(name) || [];
                queue.push(payload);
                queues.set(name, queue);
                log.info(name, 'is running; queued (' + queue.length + ' waiting)');
                return false;
            }
            log.warn(name, 'is already running as pid', running.get(name).pid);
            return false;
        }
        let child;
        try {
            child = spawn(proc.path, proc.args || [], spawnOptions(proc, {isRoot}));
        } catch (error) {
            log.error(name, 'could not be started:', error.message);
            statusOf(name, 'error', error.message);
            return false;
        }
        running.set(name, child);
        buffers.delete(name); // this run's output, not the last one's
        statusOf(name, 'error', ''); // a previous failure is not this run's

        child.on('error', (error) => {
            // spawn failures arrive here asynchronously, with no exit event to follow
            log.error(name, 'failed:', error.message);
            statusOf(name, 'error', error.message);
            statusOf(name, 'pid', '');
            running.delete(name);
            onChange();
        });

        for (const stream of ['stdout', 'stderr']) {
            if (child[stream]) {
                child[stream].on('data', (data) => {
                    log.debug(name, stream, String(data).trimEnd());
                    handleOutput(name, proc, stream, data);
                    handleOutput(name, proc, 'output', data);
                });
            }
        }

        child.on('exit', (code, signal) => {
            log.info(name, 'exited', signal ? `on ${signal}` : `with code ${code}`);
            running.delete(name);
            for (const stream of ['stdout', 'stderr', 'output']) {
                flushBuffer(name, proc, stream);
            }
            buffers.delete(name);
            statusOf(name, 'pid', '');
            // `code` is null when a signal killed it — 1.x tested `typeof code === null`, which is
            // never true, so the signal never made it out
            statusOf(name, 'exit', signal === null || signal === undefined ? code : signal);
            onChange();
            const queue = queues.get(name);
            if (queue && queue.length > 0) {
                log.info(name, 'finished; starting the next queued run');
                start(name, queue.shift());
            }
        });

        if (child.pid) {
            log.info(name, 'started', proc.path, 'as pid', child.pid);
            statusOf(name, 'pid', child.pid);
        }
        onChange();
        if (proc.stdinFromSpawnPayload && child.stdin) {
            // one-shot: the payload is the whole input, so close stdin or the program waits for EOF
            child.stdin.write(String(payload));
            child.stdin.end();
        }
        return true;
    }

    function signal(name, value) {
        const child = running.get(name);
        if (!child) {
            log.warn(name, 'is not running');
            return false;
        }
        const wanted = String(value ?? '').trim() || 'SIGTERM';
        if (!isSignal(wanted)) {
            // kill() throws on an unknown signal, so this has to stop here
            log.error(name, 'not a signal:', wanted);
            return false;
        }
        log.info(name, 'sending', wanted);
        try {
            child.kill(wanted);
        } catch (error) {
            log.error(name, 'could not be signalled:', error.message);
            return false;
        }
        return true;
    }

    function pipe(name, value) {
        const proc = procs[name];
        if (proc.disableStdin) {
            log.warn(name, 'has stdin disabled');
            return false;
        }
        const child = running.get(name);
        if (!child || !child.stdin || child.stdin.destroyed) {
            log.warn(name, 'is not running');
            return false;
        }
        const text = String(value ?? '');
        if (text === '') {
            // a program that reads until EOF never finishes otherwise
            log.debug(name, 'closing stdin');
            child.stdin.end();
            return true;
        }
        // 1.x validated all of this and then never wrote anything — the feature had never worked
        child.stdin.write(text);
        log.debug(name, 'stdin <', text.trimEnd());
        return true;
    }

    return {
        start,
        signal,
        pipe,
        isRunning: (name) => running.has(name),
        queued: (name) => (queues.get(name) || []).length,
        get names() {
            return [...running.keys()];
        },
        /** SIGTERM everything still running, so a restart does not orphan children. */
        stopAll() {
            queues.clear(); // a queued run must not start while we are going down
            for (const [name, child] of running) {
                log.info(name, 'stopping (mqttpc is shutting down)');
                try {
                    child.kill('SIGTERM');
                } catch {
                    // already gone
                }
            }
        },
    };
}
