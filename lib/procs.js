/**
 * Reading and validating the procs file — the allowlist of what this instance may run.
 *
 * A name that is not in here cannot be started over MQTT, so this file *is* the security boundary:
 * MQTT chooses which entry to run, never what the command is. Arguments never come from a message.
 */

import fs from 'node:fs';

/** A process name is one MQTT topic level. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const KNOWN = new Set([
    'path',
    'args',
    'cwd',
    'env',
    'uid',
    'gid',
    'shell',
    'disableStdin',
    'disableStdout',
    'disableStderr',
    'stdout',
    'stderr',
    'output',
    'bufferMax',
    'stdinFromSpawnPayload',
    'enqueueSpawns',
    'comment',
]);

/** How an output stream is published. */
export const OUTPUT_MODES = ['drop', 'stream', 'stream_retain', 'buffer', 'buffer_retain'];

/**
 * Check a parsed procs object, returning the problems as strings.
 *
 * Reported rather than thrown one at a time: someone editing this file in a config UI wants every
 * mistake at once, not the first one.
 *
 * @returns {string[]} empty when the file is usable
 */
export function validate(procs) {
    const problems = [];
    if (!procs || typeof procs !== 'object' || Array.isArray(procs)) {
        return ['the procs file must be a JSON object of <name>: {path, …}'];
    }
    for (const [name, proc] of Object.entries(procs)) {
        if (!NAME_RE.test(name)) {
            problems.push(`${name}: not a usable process name — it becomes an MQTT topic level`);
            continue;
        }
        if (!proc || typeof proc !== 'object' || Array.isArray(proc)) {
            problems.push(`${name}: must be an object with at least a path`);
            continue;
        }
        if (typeof proc.path !== 'string' || proc.path === '') {
            problems.push(`${name}: needs a path`);
        }
        if (proc.args !== undefined && (!Array.isArray(proc.args) || proc.args.some((a) => typeof a !== 'string'))) {
            problems.push(`${name}: args must be an array of strings, one argument per element`);
        }
        if (proc.env !== undefined && (typeof proc.env !== 'object' || proc.env === null || Array.isArray(proc.env))) {
            problems.push(`${name}: env must be an object`);
        }
        for (const stream of ['stdout', 'stderr', 'output']) {
            if (proc[stream] !== undefined && !OUTPUT_MODES.includes(proc[stream])) {
                problems.push(`${name}: ${stream} must be one of ${OUTPUT_MODES.join(', ')}`);
            }
        }
        if (proc.bufferMax !== undefined && !(Number.isInteger(proc.bufferMax) && proc.bufferMax > 0)) {
            problems.push(`${name}: bufferMax must be a positive number of bytes`);
        }
        for (const key of Object.keys(proc)) {
            if (!KNOWN.has(key)) {
                problems.push(`${name}: unknown attribute ${key}`);
            }
        }
    }
    return problems;
}

/**
 * Read and validate the procs file.
 *
 * @param {string} file
 * @param {{fs?: object}} [deps]
 * @returns {{procs: object, problems: string[]}}
 */
export function loadProcs(file, {fs: fsImpl = fs} = {}) {
    let raw;
    try {
        raw = fsImpl.readFileSync(file, 'utf8');
    } catch (error) {
        return {procs: {}, problems: [`cannot read ${file}: ${error.message}`]};
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {procs: {}, problems: [`${file} is not valid JSON: ${error.message}`]};
    }
    const problems = validate(parsed);
    return {procs: problems.length > 0 ? {} : parsed, problems};
}

/**
 * The options `child_process.spawn` gets for one entry.
 *
 * `uid`/`gid` are only passed when we can actually use them: a process that is not root cannot
 * become another user, and passing them anyway makes spawn fail with EPERM instead of saying why.
 */
export function spawnOptions(proc, {isRoot = false} = {}) {
    const options = {stdio: 'pipe'};
    if (proc.cwd) {
        options.cwd = proc.cwd;
    }
    if (proc.env) {
        options.env = proc.env;
    }
    if (proc.shell !== undefined) {
        options.shell = proc.shell;
    }
    if (isRoot) {
        if (proc.uid !== undefined) {
            options.uid = proc.uid;
        }
        if (proc.gid !== undefined) {
            options.gid = proc.gid;
        }
    }
    return options;
}

/** Which entries ask for a uid/gid that only root can grant — worth a warning at startup. */
export function needsRoot(procs) {
    return Object.entries(procs)
        .filter(([, proc]) => proc && (proc.uid !== undefined || proc.gid !== undefined))
        .map(([name]) => name);
}

/** Signals `kill()` accepts. Anything else would throw rather than be delivered. */
export function isSignal(value) {
    return typeof value === 'string' && /^SIG[A-Z0-9]+$/.test(value.trim());
}
