# mqttpc

[![npm version](https://badge.fury.io/js/mqttpc.svg)](https://badge.fury.io/js/mqttpc) 
[![License][mit-badge]][mit-url]

> Advanced process control via MQTT :satellite:

Topic structure follows [mqtt-smarthome](https://github.com/mqtt-smarthome) architecture.

## Documentation

### Installation

Needs Node.js and npm.

````npm install -g mqttpc````

### Command line options

```
Usage: index.js [options]

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

* path - (string) path to the process
* args - (array[string]) arguments
* cwd - (string) the working directory (default: the cwd of mqttpc)
* env - (object) key-value paired environment (default: the env of mqttpc)
* uid - (number) user id
* gid - (number) group id
* shell - (boolean|string) run command in a shell (default: false). See https://nodejs.org/api/child_process.html#child_process_child_process_spawn_command_args_options
* disableStdin - (boolean) Disable the possibility to send data through MQTT to the process stdin (default: false).
* disableStdout - (boolean) Disable MQTT publish of the process stdout (default: false).
* disableStderr - (boolean) Disable MQTT publish of the process stderr (default: false).

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
...and (Re)start mqttpc. Now you can start your Backup Script by publish on ```pc/set/my-backup/spawn``` (Payload is irrelevant).
If you want to stop your script via MQTT you could publish ```SIGKILL``` on the topic ```pc/set/my-backup/signal```.

### Topics mqttpc publishes

#### pc/status/&lt;process_name&gt;/pid

After process start the pid is published retained. When process ends an empty payload will be published (removing the retained message).

#### pc/status/&lt;process_name&gt;/exit

After process exit the exit code (or the killing signal) will be published retained.

#### pc/status/&lt;process_name&gt;/error

Errors on process spawn will be published retained on this topic. On next successful process start an empty payload will be published (removing the retained message).

#### pc/status/&lt;process_name&gt;/stdout

The processes stdout will be published on this topic (not retained).

#### pc/status/&lt;process_name&gt;/stderr

The processes stderr will be published on this topic (not retained).

#### pc/connected

Mqttpc will publish ```1``` on start. Will be reset to ```0``` via last will if broker connection or mqttpc process dies.

### Topics mqttpc subscribes 

#### pc/set/&lt;process_name&gt;/spawn

Start the process

#### pc/set/&lt;process_name&gt;/pipe

Pipe payload into stdin of the process

#### pc/set/&lt;process_name&gt;/signal

Send a signal to the process (Payload should be a string containing the signal name, e.g. "SIGHUP")


## License

MIT (c) Sebastian Raff


[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE