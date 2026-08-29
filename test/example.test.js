/**
 * The shipped example must itself be valid: it is what "Create from example" puts on disk, and a
 * broken one would greet a new user with a start-up failure.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {validate} from '../lib/procs.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = JSON.parse(fs.readFileSync(path.join(root, 'example-procs.json'), 'utf8'));
const schema = JSON.parse(fs.readFileSync(path.join(root, 'procs.schema.json'), 'utf8'));

describe('example-procs.json', () => {
    test('passes the same validation a real procs file gets', () => {
        assert.deepEqual(validate(example), []);
    });

    test('every attribute it uses is in the json schema, so the editor knows them', () => {
        const known = new Set(Object.keys(schema.patternProperties['^[A-Za-z0-9][A-Za-z0-9._-]*$'].properties));
        for (const [name, proc] of Object.entries(example)) {
            for (const key of Object.keys(proc)) {
                assert.ok(known.has(key), `${name}.${key} is not in procs.schema.json`);
            }
        }
    });

    test('it demonstrates sudo rather than telling people to run as root', () => {
        assert.equal(example.reboot.path, '/usr/bin/sudo');
        assert.match(example.reboot.comment, /sudoers/);
    });
});
