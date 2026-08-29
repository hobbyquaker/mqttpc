/**
 * `<name>/set/<proc>/<command>` → the runner.
 *
 * Its own module because it is the seam where index.js used to drop the spawn payload on the
 * floor, so `stdinFromSpawnPayload` received an empty string and the process read EOF immediately.
 * A unit test of the runner cannot see that; a unit test of this can.
 *
 * The **raw** payload is what reaches a process, not the parsed value: stdin is bytes the user
 * chose, and `{"val": …}` unwrapping or number coercion would corrupt it.
 */
export function createDispatch({procs, runner, log}) {
    return function onSet(parts, value, topic, raw) {
        const [name, command] = parts;
        if (!Object.hasOwn(procs, name)) {
            log.warn('no process named', name);
            return;
        }
        switch (command) {
            case 'spawn':
                runner.start(name, raw ?? '');
                break;
            case 'signal':
                runner.signal(name, raw ?? '');
                break;
            case 'pipe':
                runner.pipe(name, raw ?? '');
                break;
            default:
                log.warn('unknown command', command, 'for', name);
        }
    };
}
