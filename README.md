# Server Vitals

A GNOME Shell extension that shows live readings for your **remote Linux
servers** in the top bar: RAM, CPU, network, disks, temperature and graphics
cards. It looks like the Vitals extension (small icon, then a value), but the
numbers come from other machines.

It supports GNOME Shell 46 to 51, which covers Ubuntu 24.04 and later and
Fedora 42 and later.

- The top bar shows one server at a time (the "pinned" one).
- The menu is laid out like Vitals: **Server**, **Temperature**, **Memory**,
  **Processor**, **System**, **Network**, **Interface**, **Storage** and
  **Graphics** groups, each showing
  its main value and opening to the full list of readings.
- Click a reading to show or hide it in the top bar. Click a server in the
  **Server** group to pin it.
- The round buttons at the bottom reconnect every server and open Preferences.
- A server that cannot be reached is shown as **offline** with the reason
  (timeout, auth failed, connection refused, ...). Old numbers are never shown.

## How it works

Readings are collected over plain SSH, using the keys and `~/.ssh/config` you
already have. **Nothing is installed on the servers** and no passwords are
stored. For each server the extension keeps one `ssh` connection open and runs
a tiny shell loop on the other end that reads `/proc` and `df` every few
seconds. It needs only `sh`, `awk`, `df` and `sleep` on the server, so it works
on old distributions and on busybox.

Readings per server:

| Group | Readings |
| --- | --- |
| Memory | Usage, physical, available, allocated, free, cached, swap |
| Processor | Usage, cores, load averages |
| System | Uptime |
| Network | Upload and download speed and totals of the selected interface, 15 minute graphs |
| Storage | Usage, total, used, free and time left for the main mount, plus every other disk |
| Temperature | Every sensor the server exposes |
| Graphics | NVIDIA and AMD cards |

Any reading can be shown in the top bar by clicking it in the menu. RAM, CPU
and the network readings are shown to begin with.

Open the indicator and use the **Interface** group to
choose one device from its remote `/proc/net/dev` list. Loopback, VLANs,
bridges and tunnels are selectable too. Pinning a server and choosing its
interface are separate actions; each server remembers its own choice.
The extension never adds interfaces together.

When a server has no saved choice, the first connection selects its LAN
uplink: the device carrying the default route with the lowest metric, provided
it is a physical card or a bridge, bond or VLAN built on one. Loopback, Docker,
veth, VPN and tunnel devices are never picked automatically. If two candidates
tie or none qualifies, nothing is selected and you choose yourself. A saved
choice is never replaced.

The interface list has a search field that matches names and labels without
regard to case. Container devices (veth, docker, cni, flannel, br-<id>) are
folded behind the **Containers** button until you search or expand them, and
long lists are shown a page at a time.

## More in the menu

- **15 minute graphs.** Upload and download of the selected interface, one
  bar per 30 seconds. History is kept in memory only and restarts when you
  change interface or the server reboots.
- **Labels and favorites.** In Preferences, edit a server to give its selected
  interface a label and mark it as a favorite. Favorites are listed first.
- **Alerts.** One notification when a server has been offline, the selected
  interface has been dropping packets, or the watched mount has been at least
  90% full for 30 seconds, and one more when it recovers. **Maintenance mute**
  in the server's settings silences them.
- **Temperature.** Every temperature sensor the server exposes under
  `/sys/class/hwmon` (CPU cores, NVMe drives and so on). The group header
  shows the hottest one. The group is hidden when a server has no sensors,
  which is usual for virtual machines.
- **Graphics.** NVIDIA cards through `nvidia-smi` (usage, memory,
  temperature, fan, power) and AMD cards through sysfs (usage, memory,
  temperature). Hidden when the server has neither.
- **Every disk.** The Storage group lists each mounted disk partition on the
  server with used, total and percent. Click one to show it in the top bar.
  Loop, optical and RAM devices, `/boot` partitions and mount points with
  spaces are left out, and at most 16 are listed.
- **Disk mount and runway.** Each server can watch a mount other than `/`.
  After five minutes of falling free space the menu estimates the time left.

The list refreshes with each sample. If the chosen device disappears, the
menu marks it **unavailable** rather than switching devices. Other readings
continue. When it returns, totals resume immediately; rates need two
consecutive readings of that device with increasing uptime and nondecreasing
counters. An ellipsis in the bar means there is no value yet.

## Requirements

- On your computer: GNOME Shell 46 to 51 and the OpenSSH client (`ssh`).
- On each server: Linux, key-based SSH login, and `sh`, `awk`, `df` and
  `sleep`. Temperature and graphics readings appear when the server has the
  sensors or `nvidia-smi`.

## Install

From a release ZIP:

    gnome-extensions install server-vitals@tayyabtahir.shell-extension.zip

Or from source:

    git clone https://github.com/tayyabtahir143/ServerVitals.git
    cd ServerVitals
    ./install.sh

Either way the extension is copied to
`~/.local/share/gnome-shell/extensions/server-vitals@tayyabtahir/`. It is not
enabled yet.

## Enable

On Wayland, GNOME only notices a newly installed extension after you log in
again. So: **log out, log back in**, then run

    gnome-extensions enable server-vitals@tayyabtahir

## Add a server

1. Make sure key login works. If you have never logged in to the server with a
   key, run this once in a terminal (it asks for the password one last time):

       ssh-copy-id user@host

   Then check that this prints `ok` without asking for anything:

       ssh -o BatchMode=yes user@host echo ok

2. Open the settings: click the indicator in the top bar, then the round
   **Preferences** button (or run
   `gnome-extensions prefs server-vitals@tayyabtahir`).
3. Click **Add server** and type the host name or IP address. User, port and a
   display name are optional. You can also type `user@host:port` in the first
   field. A `Host` alias from `~/.ssh/config` works too.

### Import hosts

**Import**, next to **Add server**, opens a list of hosts found on this
computer, each with a switch. Leave on the ones you want and press **Import**.
You can switch on as many as you like and add them in one go; the button
shows how many will be imported. A search field appears when the list is
long, and **Select shown** / **Clear shown** switch every host currently
listed, so you can search for part of a name and select all the matches.

- **SSH config.** Every `Host` entry in `~/.ssh/config`, including files
  pulled in with `Include`. Each is added by its alias, so the user, port, key
  and jump host come from the entry. These are switched on, except Git hosting
  services such as github.com, which do not allow a shell.
- **Known hosts.** Machines you have connected to before, from
  `~/.ssh/known_hosts`. That file records only the address and port, not the
  user or key, so these connect with your SSH defaults and may fail to log in
  until you add a user or an SSH config entry. They are all switched off until
  you choose. Hashed entries cannot be read and are only counted.

Entries with wildcards, `Match` blocks, hosts you have already added and known
hosts already covered by an SSH config entry are skipped. Every imported host
is contacted over SSH straight away and stays connected.

The same window lets you edit or remove servers and change the refresh
interval (default 5 seconds). To choose which readings appear in the bar,
click them in the menu.

### Fields in the server dialog

| Field | Meaning |
| --- | --- |
| Host name or IP address | Where to connect. Also accepts `user@host:port` or a `Host` alias from `~/.ssh/config`. |
| User, Port | Optional. Leave empty to use `~/.ssh/config` or the SSH defaults. |
| Display name | Optional name shown in the bar and menu in place of the address. |
| Mount point | The disk path treated as the server's main disk. Default `/`. |
| Maintenance mute | Silences offline, packet drop and disk alerts for this server. |
| Label, Favorite interface | Shown once an interface is selected; they apply to that interface. |

**Mount point.** The Storage group's Usage, Total, Used, Free and Time left
readings come from this path, and so does the disk alert. `/` is right for most
servers. Change it only when the disk you care about is mounted elsewhere, for
example `/data`. It must be an absolute path made of letters, digits, spaces
and `/ . _ -`. Other disks are listed in the Storage group whatever you enter
here.

### Using a key that is not in `~/.ssh`

The dialog has no key field. The extension runs your normal `ssh`, so tell SSH
which key to use for the host in `~/.ssh/config`:

    Host server1.example.com
        User deploy
        IdentityFile /path/to/private_key
        IdentitiesOnly yes

The key file can stay where it is. With this entry in place the User and Port
fields in the dialog can be left empty. You can also give the entry a short
alias (`Host web1` with a `HostName` line) and type the alias as the host.

Check it from a terminal before adding the server:

    ssh -o BatchMode=yes server1.example.com echo ok

If that prints `ok` without asking for anything, the extension will connect. A
key with a passphrase must already be unlocked in your SSH agent
(`ssh-add /path/to/private_key`), because the extension cannot answer prompts.
A server reached through a jump host works the same way, with `ProxyJump` in
the same entry.

Notes:

- The first time the extension connects to a server, its host key is added to
  `~/.ssh/known_hosts` automatically (`StrictHostKeyChecking=accept-new`). If a
  known host key *changes*, the connection is refused and the server shows as
  offline.
- If your key has a passphrase, it must be unlocked in your SSH agent (GNOME
  does this at login for keys it knows). The extension never asks for one.

## Troubleshooting

Watch the shell log while you reproduce the problem:

    journalctl -f -o cat /usr/bin/gnome-shell

What the offline reasons mean:

| Shown | Meaning / fix |
| --- | --- |
| `auth failed (key not accepted)` | Key login does not work. Run `ssh-copy-id user@host`, check the user name. |
| `timeout` | No answer within 8 seconds: wrong address, server down, firewall, VPN not connected. |
| `connection refused` | The machine answers but nothing listens on that port. Check the port. |
| `unknown host` | The name does not resolve. Check spelling / DNS. |
| `host key changed` / `host key verification failed` | The server's key differs from `~/.ssh/known_hosts`. If that is expected: `ssh-keygen -R host`. |
| `connection lost` | The link dropped. It reconnects by itself (after 2 s, then 4, 8 ... up to 60 s). |
| `timeout (no data received)` | Connected, but readings stopped arriving. It reconnects by itself. |
| `/proc is not readable` | The server is not Linux. |

The round refresh button in the menu retries every server immediately.

To see exactly what the extension sees, run the same collector from a terminal
(prints one line per reading for 15 seconds):

    SV_INTERFACE=eth0 gjs -m tests/collector-test.js 15 user@host

## Tests

    gjs -m tests/validation-test.js
    gjs -m tests/monitor-test.js
    gjs -m tests/interface-test.js
    python3 tests/uplink-test.py
    sh tests/picker-ui-test.sh

The first two check input validation, parsing, graph history, alert timing and
the maths, without any network. `interface-test.js` runs the sampler on this
computer and compares its counters with `/proc/net/dev`. `uplink-test.py`
checks the automatic LAN uplink choice against made-up routing tables.
`picker-ui-test.sh` starts a temporary headless GNOME Shell with a fake `ssh`
and two fixture servers, then exercises the menu, the top bar, Preferences and
the import dialog. It does not touch your session, settings or real servers.

If the indicator does not appear at all: `gnome-extensions info
server-vitals@tayyabtahir` shows the state and any error.

## Uninstall

    gnome-extensions disable server-vitals@tayyabtahir
    rm -rf ~/.local/share/gnome-shell/extensions/server-vitals@tayyabtahir
    dconf reset -f /org/gnome/shell/extensions/server-vitals/

(`./install.sh --uninstall` does the first two steps.) The last line removes
the saved server list and settings.

## Files

    server-vitals@tayyabtahir/
      metadata.json      extension description and supported GNOME Shell versions
      extension.js       top bar indicator and menu
      collector.js       ssh subprocess, remote script, parsing, reconnect
      common.js          validation, server list, number formatting
      monitor.js         graph history, disk runway, alert timing
      prefs.js           settings window
      stylesheet.css
      icons/             symbolic icons
      schemas/           GSettings schema
    tests/
      collector-test.js  run the real collector against a host from a terminal
      validation-test.js input validation, parsing and import self-checks
      monitor-test.js    graph history, runway, alerts, temperature and GPU parsing
      interface-test.js  local sampler against /proc/net/dev
      uplink-test.py     automatic uplink selection
      picker-ui-test.sh  headless GNOME Shell test of the menu and Preferences
      picker-stream.py   fixture server output for the headless test
      prefs-probe.js     drives the Preferences window in the headless test
      print-sampler.js   prints the remote script
    install.sh

## License

Copyright Tayyab Tahir. Licensed under GPL-3.0-or-later; see LICENSE.

## Limitations

GNOME Shell 46 to 51 are declared compatible. Each version was checked with
the headless test in `tests/picker-ui-test.sh`, using local fixtures in place
of real servers:

| GNOME Shell | Tested on |
| --- | --- |
| 46 | Ubuntu 24.04 |
| 47 | Ubuntu 24.10 |
| 48 | Fedora 42 |
| 49 | Fedora 43, Ubuntu 25.10 |
| 50 | Fedora 44, Ubuntu 26.04 |
| 51 | Fedora 45 |

Those sessions have no screen, so layout on versions other than 51 has not
been checked by eye.

- Network totals are kernel counters for the selected device, not a traffic
  history; they may reset when the device is recreated. Devices are identified
  by name, not hardware address.
- Intel integrated graphics are not reported, and there are no voltage or fan
  speed groups.
- The disk alert level (90%) and the alert delay (30 seconds) are fixed.
- Alerts and the time left estimate apply to the main mount only.
- Hosts imported from `known_hosts` carry no user or key.

## Security notes

- `ssh` is started with an argument list, never through a local shell, and the
  host is always passed after `--`.
- Host, user and port are validated; anything starting with `-` or containing
  spaces or shell characters is rejected.
- SSH runs with `BatchMode=yes` (never prompts), with agent/X11/port
  forwarding switched off for these connections.
- Connections are shared through a control socket in
  `$XDG_RUNTIME_DIR/server-vitals/`, readable only by you. Disabling the
  extension kills every ssh process it started and closes those connections.
