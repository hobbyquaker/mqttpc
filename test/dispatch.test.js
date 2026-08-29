/**
 * set/<proc>/<command> → the runner.
 *
 * This exists because of a real bug: index.js called start(name) without the payload, so
 * `stdinFromSpawnPayload` wrote an empty string and every such process read EOF and exited having
 * done nothing. The runner's own tests could not see it — the wiring was what was wrong.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {createDispatch} from '../lib/dispatch.js';

function setup(procs = {df: {path: '/bin/df'}}) {
    const calls = [];
    const logged = [];
    const runner = {
        start: (...a) => calls.push(['start', ...a]),
        signal: (...a) => calls.push(['signal', ...a]),
        pipe: (...a) => calls.push(['pipe', ...a]),
    };
    const log = {warn: (...a) => logged.push(a.join(' ')), info() {}, debug() {}, error() {}};
    return {dispatch: createDispatch({procs, runner, log}), calls, logged};
}

describe('dispatch', () => {
    test('spawn passes the payload through — stdinFromSpawnPayload needs it', () => {
        const {dispatch, calls} = setup();
        dispatch(['df', 'spawn'], 'parsed', 'pc/set/df/spawn', 'hello pr1');
        assert.deepEqual(calls, [['start', 'df', 'hello pr1']]);
    });

    test('the RAW payload reaches the process, not the parsed value', () => {
        // stdin is bytes the user chose; {"val": …} unwrapping or number coercion would corrupt it
        const {dispatch, calls} = setup();
        dispatch(['df', 'pipe'], 42, 'pc/set/df/pipe', '{"val": 42}');
        assert.deepEqual(calls, [['pipe', 'df', '{"val": 42}']]);
    });

    test('signal and pipe reach the runner', () => {
        const {dispatch, calls} = setup();
        dispatch(['df', 'signal'], 'SIGHUP', 't', 'SIGHUP');
        dispatch(['df', 'pipe'], 'x', 't', 'x');
        assert.deepEqual(calls, [
            ['signal', 'df', 'SIGHUP'],
            ['pipe', 'df', 'x'],
        ]);
    });

    test('a missing payload becomes an empty string, never undefined', () => {
        const {dispatch, calls} = setup();
        dispatch(['df', 'spawn'], undefined, 't', undefined);
        assert.deepEqual(calls, [['start', 'df', '']]);
    });

    test('a process that is not in the procs file does nothing at all', () => {
        const {dispatch, calls, logged} = setup();
        dispatch(['nope', 'spawn'], '', 't', '');
        assert.deepEqual(calls, []);
        assert.match(logged.join(' '), /no process named nope/);
    });

    test('an unknown command is refused rather than guessed at', () => {
        const {dispatch, calls, logged} = setup();
        dispatch(['df', 'restart'], '', 't', '');
        assert.deepEqual(calls, []);
        assert.match(logged.join(' '), /unknown command restart/);
    });

    test('a process name that collides with Object.prototype is not a process', () => {
        const {dispatch, calls} = setup();
        dispatch(['constructor', 'spawn'], '', 't', '');
        dispatch(['toString', 'spawn'], '', 't', '');
        assert.deepEqual(calls, [], 'hasOwn, not `in` — inherited keys are not entries');
    });
});
