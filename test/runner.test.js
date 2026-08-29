/**
 * The process lifecycle against a fake spawn — a real one would make these tests depend on the
 * machine. Three of the four bugs fixed in 2.0 are pinned here: pipe writing nothing, output
 * published retained, and the exit signal never being reported.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {createRunner} from '../lib/runner.js';

class FakeChild extends EventEmitter {
    constructor(pid = 4242) {
        super();
        this.pid = pid;
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.written = [];
        this.stdinEnded = false;
        this.stdin = {
            destroyed: false,
            write: (d) => this.written.push(String(d)),
            end: () => {
                this.stdinEnded = true;
            },
        };
        this.signals = [];
    }
    kill(sig) {
        this.signals.push(sig);
    }
}

function setup(procs = {df: {path: '/bin/df'}}, {spawnImpl, isRoot = false} = {}) {
    const published = [];
    const logged = [];
    const log = {
        debug: () => {},
        info: (...a) => logged.push(a.join(' ')),
        warn: (...a) => logged.push(a.join(' ')),
        error: (...a) => logged.push(a.join(' ')),
    };
    const children = [];
    const spawn =
        spawnImpl ||
        ((path, args, options) => {
            const child = new FakeChild(1000 + children.length);
            children.push({child, path, args, options});
            return child;
        });
    const runner = createRunner({
        procs,
        log,
        isRoot,
        spawn,
        publish: (item, value, opts) => published.push({item, value, retain: opts ? opts.retain : undefined}),
    });
    return {runner, published, logged, children, last: (item) => published.filter((p) => p.item === item).at(-1)};
}

describe('spawn', () => {
    test('starts the process and publishes its pid', () => {
        const {runner, children, last} = setup();
        assert.equal(runner.start('df'), true);
        assert.equal(children[0].path, '/bin/df');
        assert.deepEqual(children[0].args, []);
        assert.equal(last('df/pid').value, 1000);
        assert.equal(last('df/error').value, '', 'a previous failure is cleared');
        assert.equal(runner.isRunning('df'), true);
    });

    test('args are passed through as given', () => {
        const {runner, children} = setup({df: {path: '/bin/df', args: ['-h', '/']}});
        runner.start('df');
        assert.deepEqual(children[0].args, ['-h', '/']);
    });

    test('starting a running process is refused rather than starting a second one', () => {
        const {runner, children, logged} = setup();
        runner.start('df');
        assert.equal(runner.start('df'), false);
        assert.equal(children.length, 1);
        assert.match(logged.join(' '), /already running/);
    });

    test('a spawn that throws is reported and leaves nothing running', () => {
        const {runner, last} = setup(undefined, {
            spawnImpl: () => {
                throw new Error('EACCES');
            },
        });
        assert.equal(runner.start('df'), false);
        assert.equal(last('df/error').value, 'EACCES');
        assert.equal(runner.isRunning('df'), false);
    });

    test('an async spawn error clears the pid and frees the name', () => {
        const {runner, children, last} = setup();
        runner.start('df');
        children[0].child.emit('error', new Error('ENOENT'));
        assert.equal(last('df/error').value, 'ENOENT');
        assert.equal(last('df/pid').value, '');
        assert.equal(runner.isRunning('df'), false, 'it can be started again');
    });
});

describe('output', () => {
    test('stdout and stderr are published NOT retained — output is events, not state', () => {
        // 1.x published them retained, so the last chunk of every process stuck on the broker
        const {runner, children, published} = setup();
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('one'));
        children[0].child.stderr.emit('data', Buffer.from('bad'));
        assert.deepEqual(
            published.filter((p) => p.item === 'df/stdout'),
            [{item: 'df/stdout', value: 'one', retain: false}],
        );
        assert.equal(published.find((p) => p.item === 'df/stderr').retain, false);
    });

    test('disableStdout and disableStderr suppress publishing', () => {
        const {runner, children, published} = setup({df: {path: '/bin/df', disableStdout: true}});
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('quiet'));
        children[0].child.stderr.emit('data', Buffer.from('loud'));
        assert.equal(
            published.some((p) => p.item === 'df/stdout'),
            false,
        );
        assert.equal(
            published.some((p) => p.item === 'df/stderr'),
            true,
        );
    });

    test('drop publishes nothing', () => {
        const {runner, children, published} = setup({df: {path: '/bin/df', stdout: 'drop'}});
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('quiet'));
        assert.equal(
            published.some((p) => p.item === 'df/stdout'),
            false,
        );
    });

    test('stream_retain publishes retained, for output that should survive a restart', () => {
        const {runner, children, last} = setup({df: {path: '/bin/df', stdout: 'stream_retain'}});
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('kept'));
        assert.deepEqual(last('df/stdout'), {item: 'df/stdout', value: 'kept', retain: true});
    });

    test('the output topic combines both streams, in the order they arrived', () => {
        const {runner, children, published} = setup({df: {path: '/bin/df', output: 'stream'}});
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('one '));
        children[0].child.stderr.emit('data', Buffer.from('two '));
        children[0].child.stdout.emit('data', Buffer.from('three'));
        assert.deepEqual(
            published.filter((p) => p.item === 'df/output').map((p) => p.value),
            ['one ', 'two ', 'three'],
        );
    });

    test('output is off unless asked for — on by default would publish everything twice', () => {
        const {runner, children, published} = setup();
        runner.start('df');
        children[0].child.stdout.emit('data', Buffer.from('x'));
        assert.equal(
            published.some((p) => p.item === 'df/output'),
            false,
        );
    });
});

describe('buffer mode (from PR #1)', () => {
    test('nothing is published until the process exits, then all of it at once', () => {
        const {runner, children, published} = setup({b: {path: '/b', stdout: 'buffer'}});
        runner.start('b');
        children[0].child.stdout.emit('data', Buffer.from('line one\n'));
        children[0].child.stdout.emit('data', Buffer.from('line two\n'));
        assert.equal(
            published.some((p) => p.item === 'b/stdout'),
            false,
            'still collecting',
        );
        children[0].child.emit('exit', 0, null);
        assert.deepEqual(
            published.filter((p) => p.item === 'b/stdout'),
            [{item: 'b/stdout', value: 'line one\nline two\n', retain: false}],
        );
    });

    test('buffer_retain publishes the collected output retained', () => {
        const {runner, children, last} = setup({b: {path: '/b', stdout: 'buffer_retain'}});
        runner.start('b');
        children[0].child.stdout.emit('data', Buffer.from('done'));
        children[0].child.emit('exit', 0, null);
        assert.equal(last('b/stdout').retain, true);
    });

    test('over bufferMax the oldest output goes, and the message says how much', () => {
        // a truncated log that does not admit it is worse than no log
        const {runner, children, last} = setup({b: {path: '/b', stdout: 'buffer', bufferMax: 8}});
        runner.start('b');
        for (const chunk of ['aaaa', 'bbbb', 'cccc']) {
            children[0].child.stdout.emit('data', Buffer.from(chunk));
        }
        children[0].child.emit('exit', 0, null);
        assert.equal(last('b/stdout').value, '...(clipped 4 bytes)...\nbbbbcccc');
    });

    test('a process that produced nothing publishes nothing at exit', () => {
        const {runner, children, published} = setup({b: {path: '/b', stdout: 'buffer'}});
        runner.start('b');
        children[0].child.emit('exit', 0, null);
        assert.equal(
            published.some((p) => p.item === 'b/stdout'),
            false,
        );
    });

    test('a second run does not carry the first run’s output', () => {
        const {runner, children, published} = setup({b: {path: '/b', stdout: 'buffer'}});
        runner.start('b');
        children[0].child.stdout.emit('data', Buffer.from('first'));
        children[0].child.emit('exit', 0, null);
        runner.start('b');
        children[1].child.stdout.emit('data', Buffer.from('second'));
        children[1].child.emit('exit', 0, null);
        assert.deepEqual(
            published.filter((p) => p.item === 'b/stdout').map((p) => p.value),
            ['first', 'second'],
        );
    });
});

describe('enqueueSpawns (from PR #1)', () => {
    test('a spawn while running waits and starts on exit', () => {
        const {runner, children} = setup({q: {path: '/q', enqueueSpawns: true}});
        runner.start('q');
        assert.equal(runner.start('q'), false, 'not started now');
        assert.equal(runner.queued('q'), 1);
        children[0].child.emit('exit', 0, null);
        assert.equal(children.length, 2, 'the queued run started');
        assert.equal(runner.queued('q'), 0);
    });

    test('without it a second spawn is simply refused, as in 1.x', () => {
        const {runner, children} = setup({q: {path: '/q'}});
        runner.start('q');
        runner.start('q');
        children[0].child.emit('exit', 0, null);
        assert.equal(children.length, 1);
    });

    test('shutting down drops the queue rather than starting something on the way out', () => {
        const {runner, children} = setup({q: {path: '/q', enqueueSpawns: true}});
        runner.start('q');
        runner.start('q');
        runner.stopAll();
        children[0].child.emit('exit', null, 'SIGTERM');
        assert.equal(children.length, 1);
    });
});

describe('stdinFromSpawnPayload (from PR #1)', () => {
    test('the spawn payload becomes stdin and stdin is closed', () => {
        // without the close a program reading until EOF would wait forever
        const {runner, children} = setup({jq: {path: '/usr/bin/jq', stdinFromSpawnPayload: true}});
        runner.start('jq', '{"a": 1}');
        assert.deepEqual(children[0].child.written, ['{"a": 1}']);
        assert.equal(children[0].child.stdinEnded, true);
    });

    test('a queued run gets its own payload, not the first one’s', () => {
        const {runner, children} = setup({jq: {path: '/j', stdinFromSpawnPayload: true, enqueueSpawns: true}});
        runner.start('jq', 'first');
        runner.start('jq', 'second');
        children[0].child.emit('exit', 0, null);
        assert.deepEqual(children[1].child.written, ['second']);
    });
});

describe('exit', () => {
    test('a normal exit publishes the code and frees the name', () => {
        const {runner, children, last} = setup();
        runner.start('df');
        children[0].child.emit('exit', 0, null);
        assert.equal(last('df/exit').value, 0);
        assert.equal(last('df/pid').value, '');
        assert.equal(runner.isRunning('df'), false);
    });

    test('a killed process reports the signal, not a null code', () => {
        // 1.x tested `typeof code === null`, which is never true, so the signal never got out
        const {runner, children, last} = setup();
        runner.start('df');
        children[0].child.emit('exit', null, 'SIGKILL');
        assert.equal(last('df/exit').value, 'SIGKILL');
    });
});

describe('signal', () => {
    test('sends the named signal', () => {
        const {runner, children} = setup();
        runner.start('df');
        assert.equal(runner.signal('df', 'SIGHUP'), true);
        assert.deepEqual(children[0].child.signals, ['SIGHUP']);
    });

    test('an empty payload means SIGTERM', () => {
        const {runner, children} = setup();
        runner.start('df');
        runner.signal('df', '');
        assert.deepEqual(children[0].child.signals, ['SIGTERM']);
    });

    test('anything that is not a signal is refused — kill() would throw', () => {
        const {runner, children, logged} = setup();
        runner.start('df');
        assert.equal(runner.signal('df', 'KILL'), false);
        assert.deepEqual(children[0].child.signals, []);
        assert.match(logged.join(' '), /not a signal/);
    });

    test('signalling something that is not running is refused', () => {
        const {runner} = setup();
        assert.equal(runner.signal('df', 'SIGTERM'), false);
    });
});

describe('pipe', () => {
    test('writes the payload to stdin', () => {
        // 1.x validated everything and then never wrote: the feature had never worked
        const {runner, children} = setup();
        runner.start('df');
        assert.equal(runner.pipe('df', 'hello\n'), true);
        assert.deepEqual(children[0].child.written, ['hello\n']);
    });

    test('disableStdin refuses it', () => {
        const {runner, children, logged} = setup({df: {path: '/bin/df', disableStdin: true}});
        runner.start('df');
        assert.equal(runner.pipe('df', 'x'), false);
        assert.deepEqual(children[0].child.written, []);
        assert.match(logged.join(' '), /stdin disabled/);
    });

    test('piping to something that is not running is refused', () => {
        const {runner} = setup();
        assert.equal(runner.pipe('df', 'x'), false);
    });

    test('an empty payload closes stdin (from PR #1)', () => {
        // a program reading until EOF never finishes otherwise
        const {runner, children} = setup();
        runner.start('df');
        assert.equal(runner.pipe('df', ''), true);
        assert.equal(children[0].child.stdinEnded, true);
        assert.deepEqual(children[0].child.written, [], 'nothing written, just closed');
    });
});

describe('stopAll', () => {
    test('SIGTERMs everything still running, so a restart orphans nothing', () => {
        const {runner, children} = setup({a: {path: '/a'}, b: {path: '/b'}});
        runner.start('a');
        runner.start('b');
        runner.stopAll();
        assert.deepEqual(
            children.map((c) => c.child.signals),
            [['SIGTERM'], ['SIGTERM']],
        );
    });
});
