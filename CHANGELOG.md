# Changelog

## 2.0.1

### Fixed

- `--ha-discovery` and `--ha-prefix` are gone. They come from the core's shared option set, and
  mqttpc announces no Home Assistant entities, so both configured nothing while still appearing in
  `--help` and in a config UI's form. `--json-payloads` stays: the status items are real.
  Needs mqtt-interfaces-core 0.15.0.

## 2.0.0

A rewrite on [mqtt-interfaces-core](https://github.com/hobbyquaker/mqtt-interfaces-core), plus the
features from [ddlsmurf's PR #1](https://github.com/hobbyquaker/mqttpc/pull/1).

### Fixed

- **`pipe` never wrote anything.** The handler validated everything and then returned without
  touching stdin, so the documented feature had never worked. Found independently by ddlsmurf.
- **The exit signal was never reported.** `typeof code === null` is never true, so a killed process
  published `null` as its exit code instead of the signal that killed it. Also from PR #1.
- **stdout and stderr were published retained**, so the last chunk of every process stayed on the
  broker forever. Output is a stream of events; it is published unretained now, with `stream_retain`
  for the cases that genuinely want otherwise.
- **An invalid signal was logged and then sent anyway**, where `kill()` throws. `set/<proc>/signal`
  now refuses anything that is not a signal name, and an empty payload means `SIGTERM`.

### Breaking

- **Node ≥ 20.19** and ESM. `yalm`, `mqtt@1` and `yargs@4` are gone; the core is the only dependency.
- **`-f, --config` is now `-f, --procs-file`** and is required — the old default `./procs.json`
  resolved relative to the installed package, not the working directory, which was never useful.
- The instance's own topics moved to the fleet layout: `<name>/connected` reports `2`/`0` and
  `<name>/info` replaces nothing that existed before.

### Added

- **`--install` / `--uninstall`** as the systemd template unit `mqttpc@<name>`, running as the
  **`mqttpc` system user** rather than root. The README explains the sudoers arrangement that gives
  it specific privileges instead; **`--root`** keeps the 1.x behaviour, warns at install time and
  logs a warning on every start.
- **`--config-schema`**, and the procs file declared as `x-file` with a JSON schema and an example,
  so a management UI (she) edits it with completion and validation.
- **Output modes** per stream — `stream` (default, as 1.x behaved), `buffer`, `drop` and the
  `_retain` variants — with **`bufferMax`** and a combined **`output`** topic. Buffer mode collects
  a process's output and publishes it as one message when it exits, which is what you want for a
  script whose log is only interesting as a whole. From PR #1, except that `stream` stays the
  default where the PR made it `drop`.
- **`stdinFromSpawnPayload`** (the spawn payload becomes stdin, which is then closed) and
  **`enqueueSpawns`** (a spawn while running waits its turn). Both from PR #1.
- **An empty `pipe` payload closes stdin**, so a program that reads until EOF can finish. From PR #1.
- **The procs file is validated on start**, reporting every problem at once — a missing `path`, args
  that are not an array, a name that is not a usable topic level, an unknown attribute. mqttpc
  refuses to start rather than run with half an allowlist.
- `uid`/`gid` are only passed to `spawn` when mqttpc is actually root, with a warning naming the
  entries that asked; before, spawn failed with a bare `EPERM`.
- Running processes get `SIGTERM` when mqttpc shuts down, instead of being orphaned.
- 59 unit tests, CI on Node 20/22/24. No Docker image: a process controller in a container can only
  control processes in that container.

### Not taken from PR #1

- `drop` as the default for stdout and stderr — it is not backwards compatible, and a process that
  silently publishes nothing is a confusing default.
- The retained-message cleanup timer, and multi-level instance names. See
  [ROADMAP.md](ROADMAP.md).
