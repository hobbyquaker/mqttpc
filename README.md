# mqttpc

[![mqtt-smarthome](https://img.shields.io/badge/mqtt-smarthome-blue.svg)](https://github.com/mqtt-smarthome/mqtt-smarthome)
[![NPM version](https://badge.fury.io/js/mqttpc.svg)](http://badge.fury.io/js/mqttpc)
[![CI](https://github.com/hobbyquaker/mqttpc/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/mqttpc/actions/workflows/ci.yml)
[![License][mit-badge]][mit-url]

> Control processes on a host over MQTT :satellite:

Start a backup script, restart a service, tail a log — by publishing to an MQTT topic. The
processes it may run are listed in a JSON file; **a name that is not in that file cannot be
started**, so the file is the allowlist and MQTT only ever picks an entry from it.

Built on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core), so it has the
same options, `--install`, `<name>/info` and maintenance topics as the rest of the `xyz2mqtt` fleet.

> **Read [Security](#security) before you deploy this.** Anyone who can publish to `<name>/set/#`
> can run every process in your procs file.

## Install

```
npm install -g mqttpc
sudo mqttpc --install -n pc -u mqtt://broker -f /etc/mqttpc/pc.procs.json
```

That creates the `mqttpc` system user, `/etc/mqttpc/pc.env` and the systemd unit `mqttpc@pc`, and
starts it. Put your processes in `/etc/mqttpc/pc.procs.json` — copy `example-procs.json` from the
package to start from.

There is deliberately **no Docker image**: a process controller inside a container can only control
processes inside that container, which is not what anyone wants it for.

## The procs file

```json
{
  "backup": {
    "path": "/usr/local/bin/my-backup.sh",
    "output": "buffer"
  },
  "disk-free": {
    "path": "/bin/df",
    "args": ["-h"]
  }
}
```

`mqttpc --install` writes the path into the instance's env file; a management UI
([she](https://github.com/hobbyquaker/she)) edits the file itself against the JSON schema shipped
with the package, with completion and validation.

| Attribute               | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `path`                  | **required** — absolute path of the program                                                               |
| `args`                  | arguments, **one per array element** (`["-h", "/tmp"]`, never `["-h /tmp"]`)                              |
| `cwd`                   | working directory (default: mqttpc's own)                                                                 |
| `env`                   | environment — **replaces** mqttpc's rather than adding to it                                              |
| `shell`                 | run through a shell. Only needed for pipes and redirections; without it nothing is re-parsed              |
| `uid` / `gid`           | run as another user — **only possible when mqttpc itself runs as root**, otherwise ignored with a warning |
| `stdout` / `stderr`     | `stream` (default) · `buffer` · `drop` · `stream_retain` · `buffer_retain`                                |
| `output`                | the two combined on one topic, same modes; `drop` by default so nothing is published twice                |
| `bufferMax`             | bytes kept in buffer mode (default 131072); older output is dropped and the message says how much         |
| `disableStdin`          | refuse `set/<name>/pipe`, so nothing from MQTT reaches this program's stdin                               |
| `stdinFromSpawnPayload` | the `spawn` payload is written to stdin, which is then closed — a one-shot command with its input         |
| `enqueueSpawns`         | a `spawn` while it is already running waits its turn instead of being refused                             |
| `comment`               | free text, ignored — JSON has no comments                                                                 |

**Output modes.** `stream` publishes each chunk as it arrives, which is what you want for a log you
are watching. `buffer` collects everything and publishes it as **one message when the process
exits**, which is what you want for a backup script whose output is only interesting as a whole.
The `_retain` variants publish retained — only for output that should survive a restart, and note
that changing a process away from a retained mode leaves the old message on the broker.

## Topics

| Topic                                         | Meaning                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `<name>/set/<proc>/spawn`                     | start it (payload ignored, unless `stdinFromSpawnPayload`)             |
| `<name>/set/<proc>/signal`                    | send a signal — `SIGHUP`, `SIGKILL`, …; empty payload means `SIGTERM`  |
| `<name>/set/<proc>/pipe`                      | write the payload to its stdin; **an empty payload closes stdin**      |
| `<name>/status/<proc>/pid`                    | retained; empty once it has exited                                     |
| `<name>/status/<proc>/exit`                   | retained; the exit code, or the signal that killed it                  |
| `<name>/status/<proc>/error`                  | retained; why a start failed, cleared on the next successful start     |
| `<name>/status/<proc>/{stdout,stderr,output}` | output, per the modes above                                            |
| `<name>/connected`                            | `2` running · `0` stopped                                              |
| `<name>/info`                                 | the procs file, the process names, what is running, whether it is root |

## Security

**mqttpc turns "may publish to `<name>/set/#`" into "may run these programs on this host".** That is
its purpose, and it is worth being deliberate about.

The procs file is the allowlist: MQTT chooses _which_ entry runs, never what the command is, and
arguments never come from a message. So the first control is simply **keeping that file small**.
The second is **broker access**: give the instance its own MQTT credentials with an ACL that
restricts who may write to its topic tree. she can create a per-instance Mosquitto dynsec identity
for this.

### Running without root

`--install` runs the service as the **`mqttpc` system user**, not root. Most things you want to
control do not need root at all — a backup script that reads a directory it owns, a build, a
`curl`.

For the few that do, add a **sudoers entry for exactly those commands** rather than running all of
mqttpc as root:

```
# /etc/sudoers.d/mqttpc — install with: sudo visudo -f /etc/sudoers.d/mqttpc
mqttpc ALL=(root) NOPASSWD: /usr/sbin/reboot
mqttpc ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx
```

and call `sudo` from the procs entry:

```json
{
  "reboot": {"path": "/usr/bin/sudo", "args": ["/usr/sbin/reboot"]}
}
```

Now a compromised broker can reboot the machine and restart nginx — and nothing else. Name full
paths and specific arguments; `NOPASSWD: /usr/bin/systemctl` without them grants control of every
unit on the host, and `ALL` grants everything.

> The unit deliberately does **not** set `NoNewPrivileges`, `ProtectSystem`, `ProtectHome` or
> `PrivateTmp`, which every other adapter in the fleet does. A systemd sandbox is inherited by every
> child process, so `ProtectHome` would hide `/home` from a backup script and `NoNewPrivileges`
> would stop `sudo` working at all. A process controller cannot be sandboxed and still do its job —
> which is another reason to keep the procs file short.

### `--root`

`--install --root` runs the service as root, as mqttpc 1.x did. It is supported, it prints a
warning at install time and logs one on every start, and you should not use it unless the sudoers
route genuinely cannot express what you need. It is also the only way `uid` / `gid` in a procs
entry can work, since a process that is not root cannot become another user.

## Options

| Option             | Default            | Meaning                                            |
| ------------------ | ------------------ | -------------------------------------------------- |
| `-f, --procs-file` | **required**       | the JSON file listing what may run                 |
| `-u, --mqtt-url`   | `mqtt://localhost` | broker url                                         |
| `-n, --name`       | `pc`               | instance name = topic prefix                       |
| `--root`           | `false`            | `--install` runs the service as root (discouraged) |
| `-v, --verbosity`  | `info`             | `error`, `warn`, `info`, `debug`                   |

`--help` lists the shared options too, and `--config-schema` prints the JSON Schema a management UI
reads.

## Credits

The output modes, buffering, `stdinFromSpawnPayload` and `enqueueSpawns` come from
[ddlsmurf](https://github.com/ddlsmurf)'s [PR #1](https://github.com/hobbyquaker/mqttpc/pull/1),
which also found the `pipe` and exit-signal bugs independently. Thank you.

[ROADMAP.md](ROADMAP.md) has what is not in yet — a sudoers snippet generator, and specialised
modes for systemd units and journal logs.

## License

MIT © [Sebastian Raff](https://github.com/hobbyquaker)

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
