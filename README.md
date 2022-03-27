# mqttpc

[![License][mit-badge]][mit-url]

> Advanced process control via MQTT :satellite:

Topic structure follows [mqtt-smarthome](https://github.com/mqtt-smarthome) architecture.

## Documentation

### Installation

Needs Node.js and npm.

````npm install -g mqttpc````

### Command line options

```
Usage: mqttpc [options]

Options:
  -v, --verbosity  possible values: "error", "warn", "info", "debug"
                                                               [default: "info"]
  -n, --name       instance name. used as mqtt client id and as prefix for
                   connected topic                               [default: "pc"]
  -u, --url        mqtt broker url. See
                   https://github.com/mqttjs/MQTT.js#connect-using-a-url
                                                   [default: "mqtt://127.0.0.1"]
  -f, --config     config file                         [default: "./procs.json"]
  -h, --help       Show help
  --version        Show version number

```

### Config file

The config file contains a JSON definition of all processes you want to control via MQTT:

```
{
  "<process_name>": {
    "path": "/usr/bin/example",
    "args": ["-x", "-y"],
    ...
  },
  ...
}

```


#### Availabe attributes

The only mandatory attribute for each process is "path", all others are optional.

* `path` - (string) path to the process
* `args` - (array[string]) arguments
* `cwd` - (string) the working directory (default: the cwd of mqttpc)
* `env` - (object) key-value paired environment (default: the env of mqttpc)
* `uid` - (number) user id
* `gid` - (number) group id
* `shell` - (boolean|string) run command in a shell (default: false). See https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
* `disableStdin` - (boolean) Disable the possibility to send data through MQTT to the process stdin (default: false).
* `stdinFromSpawnPayload` - (boolean) On spawn, send payload to stdin then close it (default: false).
* `enqueueSpawns` - (boolean) If spawn is called when it's already running, enqueue and run after process exits (default: false).
* `bufferMax` - (number default: 128k) Maximum byte size for each buffered output
* `stdout`, `stderr` and `output`: (`output` is the combination of the other two, preserving order as flushed)
    * `drop`: **Default** - Output ignored
    * `buffer` : Output is buffered until the last `bufferMax` bytes, and published when the process exits
    * `buffer_retain` : Same as above but publishes have retain set
    * `stream` : Each block of output is posted immediately (as per the decisions of the gods of buffers and node and os and so on)
    * `stream_retain` : Same as above but publishes have retain set

### Usage example

Let's say we got a backup script located in ```/usr/local/bin/my-backup.sh``` that we want to control via MQTT.

Create a config entry like this:
```Javascript
{
    "my-backup": {
        "path": "/usr/local/bin/my-backup.sh"
    }
}
```
...and (Re)start mqttpc. Now you can start your Backup Script by publishing on ```pc/set/my-backup/spawn``` (payload is irrelevant).
If you want to stop your script via MQTT you could publish ```SIGKILL``` on the topic ```pc/set/my-backup/signal```.

### Topics mqttpc publishes

#### pc/status/&lt;process_name&gt;/pid

After process start the pid is published retained. When process ends an empty payload will be published (removing the retained message).

#### pc/status/&lt;process_name&gt;/exit

After process exit the exit code (or the killing signal) will be published retained.

#### pc/status/&lt;process_name&gt;/error

Errors on process spawn will be published retained on this topic. On next successful process start an empty payload will be published (removing the retained message).

#### pc/status/&lt;process_name&gt;/stdout

The processes `stdout` will be published on this topic.

#### pc/status/&lt;process_name&gt;/stderr

The processes `stderr` will be published on this topic.

#### pc/status/&lt;process_name&gt;/output

The processes' combined `stdout` + `stderr` will be published on this topic.

#### pc/connected

Mqttpc will publish ```1``` on start. Will be reset to ```0``` via last will if broker connection or mqttpc process dies.

### Topics mqttpc subscribes

#### pc/set/&lt;process_name&gt;/spawn

Start the process

#### pc/set/&lt;process_name&gt;/pipe

Pipe payload into stdin of the process. Send an empty payload to close stdin.

#### pc/set/&lt;process_name&gt;/signal

Send a signal to the process (payload should be a string containing the signal name, e.g. "SIGHUP")


## License

MIT (c) Sebastian Raff


[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE