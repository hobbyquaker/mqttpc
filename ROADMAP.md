# mqttpc — roadmap

Ideas that are not in yet, with enough of the reasoning to pick them up later.

## Sudoers snippet generation

`--install` (and a `--print-sudoers` flag) could read the procs file, find the entries that invoke
`sudo`, and **print** a ready-to-review `/etc/sudoers.d/mqttpc` block naming exactly those
binaries:

```
# mqttpc@pc — generated, review before use
mqttpc ALL=(root) NOPASSWD: /usr/sbin/reboot
mqttpc ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx
```

Printing, never writing: an installer that grants root privileges as a side effect is not something
this should do. The value is that the snippet is derived from the file rather than hand-copied, so
it cannot drift from what the processes actually call, and it is narrow by construction.

Open: how to render an entry whose command comes from `shell: true`, where there is no single
binary to name.

## Specialised mode: systemd services

Controlling a service through `path: /usr/bin/systemctl, args: [restart, nginx]` works but says
nothing useful back — the exit code of `systemctl restart` is not the state of the unit. A
`type: "systemd"` entry could instead:

- take a unit name and expose `set/<name>/{start,stop,restart,enable,disable}`
- publish the real state as items — `active`, `sub`, `unitFile`, `since`, `pid` — from
  `systemctl show`, refreshed on change rather than only after a command
- report failures as the unit's own `Result=` rather than as an exit code

That turns a fire-and-forget command into an item table, which is what the rest of the fleet
publishes and what a dashboard can actually show.

Open: how to watch for state changes without polling (`systemctl --wait`, a D-Bus subscription, or
just a poll interval); whether the sudoers surface for this should be `systemctl` per unit.

## Specialised mode: journal logs

A `journalctl` mode to go with the above: follow a unit's log and publish the lines, with the
filtering journalctl already does (`--since`, `--priority`, `--unit`). `path: /usr/bin/journalctl,
args: [-f, -u, nginx]` already half works through `stream` output, but:

- the lines arrive as raw text rather than as structured fields, when `-o json` gives priority,
  syslog identifier and timestamp for free
- there is no way to ask for "the last 50 lines of unit X" on demand, which is the common case; a
  `set/<name>/tail` with a count would be
- a follow that runs forever is an odd fit for spawn/exit semantics

Open: how much output to publish and how to bound it (the buffering added in 2.0 helps), and
whether this belongs here or in she, which already reads journals over its own helper.

## Process output as a Home Assistant entity

2.1 gives each process a device with Running / Start / Stop / Kill and the diagnostics, but nothing
for `stdout` or `stderr`. An HA sensor state is capped at **255 characters** and process output
routinely exceeds it, so a naive sensor would log errors more often than it would show output.

A per-entry `haOutput: true` could add one, with a value template that keeps the last line and
truncates to fit. Worth doing for the case it is obviously right for — a script whose whole output
is one short line, a temperature or a status word — and worth keeping off by default for everything
else.

## Reloading the procs file

The file is read once at start, so adding a process means restarting the instance, and the HA
devices are built from that same snapshot. A `set/<name>/maintenance/reload`, or watching the file,
would let a config UI add a process and have it appear without a restart. The discovery publisher
already handles a changing device set (`markDiscoveryDirty()`), so most of the work is deciding what
to do about a process that is running when its entry disappears.

## Retained output left by a previous configuration

Changing a process from `buffer_retain` to `stream` leaves the old retained message on the broker
forever, and nothing clears it. ddlsmurf's PR #1 solved this by subscribing to
`<name>/status/+/{stdout,stderr,output}` for 20 seconds at start-up and republishing an empty
payload wherever the current config no longer says retain.

Not taken in 2.0: a timer that deletes retained topics under its own tree is risky if two instances
ever share a name, and the problem is much smaller now that output is not retained by default. A
deterministic version would be worth having though — clearing the retained output topics of every
process the config _does_ know about, on start, needs no subscription at all. The remaining gap is
processes that have been removed from the file, which is exactly the case that does need a
subscription.
