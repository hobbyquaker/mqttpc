/**
 * The procs file: reading it, and refusing it when it would not do what it looks like it says.
 * This file is the allowlist, so a mistake in it is a security question, not a typo.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {validate, loadProcs, spawnOptions, needsRoot, isSignal} from '../lib/procs.js';

describe('validate', () => {
    test('a minimal entry needs only a path', () => {
        assert.deepEqual(validate({df: {path: '/bin/df'}}), []);
    });

    test('every problem is reported at once, not just the first', () => {
        const problems = validate({a: {}, b: {path: '/x', args: 'not an array'}, 'c d': {path: '/y'}});
        assert.equal(problems.length, 3);
        assert.match(problems.join('\n'), /a: needs a path/);
        assert.match(problems.join('\n'), /b: args must be an array/);
        assert.match(problems.join('\n'), /c d: not a usable process name/);
    });

    test('a name that is not one topic level is refused', () => {
        for (const name of ['a/b', 'a+b', 'a#', '', '.hidden']) {
            assert.equal(validate({[name]: {path: '/x'}}).length, 1, name);
        }
        for (const name of ['df', 'my-backup', 'log.tail', 'a_b', 'X9']) {
            assert.deepEqual(validate({[name]: {path: '/x'}}), [], name);
        }
    });

    test('args must be one argument per element', () => {
        // "-h /tmp" as one string is a single argument containing a space, which never works
        assert.deepEqual(validate({a: {path: '/x', args: ['-h', '/tmp']}}), []);
        assert.equal(validate({a: {path: '/x', args: ['-h', 2]}}).length, 1);
    });

    test('an unknown attribute is reported — a typo would otherwise be silently ignored', () => {
        const problems = validate({a: {path: '/x', dissableStdin: true}});
        assert.match(problems[0], /unknown attribute dissableStdin/);
    });

    test('comment is allowed, since JSON has no comments', () => {
        assert.deepEqual(validate({a: {path: '/x', comment: 'why this exists'}}), []);
    });

    test('the file itself has to be an object of entries', () => {
        assert.equal(validate(null).length, 1);
        assert.equal(validate([{path: '/x'}]).length, 1);
        assert.equal(validate({a: 'ls'}).length, 1);
    });
});

describe('loadProcs', () => {
    const fakeFs = (content) => ({
        readFileSync: () => {
            if (content instanceof Error) throw content;
            return content;
        },
    });

    test('reads and validates', () => {
        const {procs, problems} = loadProcs('/etc/mqttpc/pc.json', {fs: fakeFs('{"df": {"path": "/bin/df"}}')});
        assert.deepEqual(problems, []);
        assert.deepEqual(procs, {df: {path: '/bin/df'}});
    });

    test('a missing file is a problem, not a crash', () => {
        const {problems} = loadProcs('/nope.json', {fs: fakeFs(new Error('ENOENT'))});
        assert.match(problems[0], /cannot read \/nope\.json/);
    });

    test('invalid JSON names the file and the parse error', () => {
        const {problems} = loadProcs('/etc/x.json', {fs: fakeFs('{oops')});
        assert.match(problems[0], /\/etc\/x\.json is not valid JSON/);
    });

    test('an invalid file yields no processes at all', () => {
        // half an allowlist is worse than none: it would run some things and silently not others
        const {procs, problems} = loadProcs('/x', {fs: fakeFs('{"a": {}, "b": {"path": "/ok"}}')});
        assert.deepEqual(procs, {});
        assert.equal(problems.length, 1);
    });
});

describe('spawnOptions', () => {
    test('only what the entry actually sets', () => {
        assert.deepEqual(spawnOptions({path: '/x'}), {stdio: 'pipe'});
        assert.deepEqual(spawnOptions({path: '/x', cwd: '/tmp', shell: true}), {
            stdio: 'pipe',
            cwd: '/tmp',
            shell: true,
        });
    });

    test('uid and gid only when we are root — otherwise spawn fails with EPERM and no reason', () => {
        assert.equal(spawnOptions({uid: 1000, gid: 1000}).uid, undefined);
        assert.equal(spawnOptions({uid: 1000, gid: 1000}, {isRoot: true}).uid, 1000);
        assert.equal(spawnOptions({uid: 1000, gid: 1000}, {isRoot: true}).gid, 1000);
    });

    test('uid 0 is a value, not an absence', () => {
        assert.equal(spawnOptions({uid: 0}, {isRoot: true}).uid, 0);
    });
});

describe('needsRoot', () => {
    test('names the entries whose uid/gid would be ignored', () => {
        assert.deepEqual(needsRoot({a: {path: '/x'}, b: {path: '/y', uid: 1000}, c: {path: '/z', gid: 4}}), ['b', 'c']);
    });
});

describe('isSignal', () => {
    test('accepts signal names and nothing else', () => {
        for (const s of ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGUSR1', ' SIGINT ']) {
            assert.equal(isSignal(s), true, s);
        }
        // kill() throws on anything else, so these must never reach it
        for (const s of ['TERM', 'kill', '9', '', null, undefined, 'SIGTERM; rm -rf /']) {
            assert.equal(isSignal(s), false, String(s));
        }
    });
});
