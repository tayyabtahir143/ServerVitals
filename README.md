# Server Vitals

A GNOME Shell 50 extension that shows live readings for your **remote Linux
servers** in the top bar: RAM, CPU and network. It looks like the Vitals
extension (small icon, then a value), but the numbers come from other machines.

- The top bar shows one server at a time (the "pinned" one).
- Click it to see every server with all of its readings; click a server to pin
  it to the bar.
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

| Reading | Where |
| --- | --- |
| RAM used (amount and %) | bar + menu |
| CPU % | bar + menu |
| Network speed, up and down | bar + menu |
| Network total up and down since boot | bar + menu |
| Disk usage of `/`, load average, uptime | menu only |

Network numbers are the sum of the real network cards. Loopback, Docker,
bridges, veth, virbr, CNI/flannel/calico, bond/team masters, VLAN
sub-interfaces and tunnels (tun, tap, WireGuard, ...) are left out so traffic
is not counted twice.

## Install

    git clone https://github.com/tayyabtahir143/ServerVitals.git
    cd ServerVitals
    ./install.sh

This copies the extension to
`~/.local/share/gnome-shell/extensions/server-vitals@tayyabtahir/` and compiles
its settings schema. It does not enable it.

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

2. Open the settings: click the indicator in the top bar, then **Settings**
   (or run `gnome-extensions prefs server-vitals@tayyabtahir`).
3. Click **Add server** and type the host name or IP address. User, port and a
   display name are optional. You can also type `user@host:port` in the first
   field. A `Host` alias from `~/.ssh/config` works too.

The same window lets you edit or remove servers, change the refresh interval
(default 5 seconds) and choose which readings appear in the bar.

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

"Reconnect all" in the menu retries every server immediately.

To see exactly what the extension sees, run the same collector from a terminal
(prints one line per reading for 15 seconds):

    gjs -m tests/collector-test.js 15 user@host

`gjs -m tests/validation-test.js` runs the self-checks for input validation
and the maths.

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
      metadata.json      extension description, GNOME Shell 50
      extension.js       top bar indicator and menu
      collector.js       ssh subprocess, remote script, parsing, reconnect
      common.js          validation, server list, number formatting
      prefs.js           settings window
      stylesheet.css
      icons/             symbolic icons
      schemas/           GSettings schema
    tests/
      collector-test.js  run the real collector against a host from a terminal
      validation-test.js self-checks (no network)
    install.sh

## License

Copyright Tayyab Tahir. Licensed under GPL-3.0-or-later; see LICENSE.

## Limitations

Only GNOME Shell 50 is currently declared compatible. Real remote-server
configurations still need testing. Network totals sum the included interfaces;
traffic carried only by excluded bridges, bonds or tunnels is not included.
Totals can drop when interfaces disappear or counters reset.

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
