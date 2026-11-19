#!/bin/sh
set -eu
uuid=server-vitals@tayyabtahir
if [ "${1:-}" != --private ]; then
    cd "$(dirname "$0")/.."
    T=$(mktemp -d)
    trap 'sleep 1; rm -rf "$T"' EXIT
    export T HOME=$T XDG_CONFIG_HOME=$T/config XDG_CACHE_HOME=$T/cache XDG_DATA_HOME=$T/data XDG_STATE_HOME=$T/state XDG_RUNTIME_DIR=$T/run
    export XDG_DATA_DIRS=/usr/local/share:/usr/share WAYLAND_DISPLAY=sv-test PATH=$T/bin:/usr/bin:/bin
    unset DISPLAY DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK GSETTINGS_SCHEMA_DIR GSETTINGS_BACKEND
    mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$T/bin"
    mkdir -p -m 700 "$T/.ssh/conf.d"
    printf '%s\n' 'Include conf.d/*.conf' 'Host a.invalid' 'Host web1 *.wild' '  HostName 192.0.2.10' 'Host code' '  HostName github.com' > "$T/.ssh/config"
    printf '%s\n' 'Host db1' '  User postgres' > "$T/.ssh/conf.d/extra.conf"
    printf '%s\n' '192.0.2.10 ssh-ed25519 AAAA' 'old1.invalid,192.0.2.20 ssh-ed25519 AAAA' '[old2.invalid]:2222 ssh-ed25519 AAAA' '|1|abc=|def= ssh-ed25519 AAAA' > "$T/.ssh/known_hosts"
    ext=$XDG_DATA_HOME/gnome-shell/extensions
    mkdir -p "$ext/probe@local"
    cp -R "$uuid" "$ext/"
    python3 - "$ext/$uuid/prefs.js" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('export default class ', 'class ') + Path('tests/prefs-probe.js').read_text())
PY
    glib-compile-schemas "$ext/$uuid/schemas"
    printf '%s\n' '{"uuid":"probe@local","name":"Probe","description":"Private UI test","shell-version":["46","47","48","49","50","51"]}' > "$ext/probe@local/metadata.json"
    printf '%s\n' 'export default class {enable() {global.context.unsafe_mode = true;} disable() {global.context.unsafe_mode = false;}}' > "$ext/probe@local/extension.js"
    cp tests/picker-stream.py "$T/bin/"
    printf '%s\n' '#!/bin/sh' 'case "$*" in *"-O exit"*) exit 0;; esac' 'exec python3 "$T/bin/picker-stream.py" "$@"' > "$T/bin/ssh"
    chmod +x "$T/bin/ssh"
    dbus-run-session -- sh tests/picker-ui-test.sh --private
    exit
fi
[ -n "${T:-}" ] && [ "$HOME" = "$T" ] && [ "$XDG_RUNTIME_DIR" = "$T/run" ] && [ -x "$T/bin/ssh" ] || exit 2
schema=org.gnome.shell.extensions.server-vitals
d=$XDG_DATA_HOME/gnome-shell/extensions/$uuid/schemas
gsettings --schemadir "$d" set "$schema" servers '[{"id":"a","host":"a.invalid","mount":"/srv/data","labels":{"veth126":"backup"},"favorites":["veth126"]},{"id":"b","host":"b.invalid"}]'
gsettings set org.gnome.desktop.media-handling automount false
gsettings set org.gnome.shell welcome-dialog-last-shown-version 99.0
gsettings set org.gnome.shell enabled-extensions "['probe@local', '$uuid']"
gnome-shell --headless --no-x11 --wayland-display sv-test --virtual-monitor 1280x800 > "$T/shell.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || :; wait "$pid" || :' EXIT
gdbus wait --session --timeout 30 org.gnome.Shell
probe() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "(() => {const i = Main.panel.statusArea['$uuid']; const p = i?._picker; const v = key => i._rows.get(key).row.value.text; const net = id => i._collectors.get(id).server.networkInterface; const dyn = kind => i._dynamic.get(kind); $1})()"
}
expect() {
    n=0
    until [ "$(probe "$1")" = "(true, 'true')" ]; do
        n=$((n+1))
        if [ "$n" -ge 30 ]; then printf 'Failed: %s\n' "$1"; probe "$1"; probe 'return [!!i, p?.status.text, i && Array.from(i._rows, ([k, x]) => [k, x.row.value.text]), i && Array.from(i._collectors.values(), c => [c.status,c.error])]'; tail -30 "$T/shell.log"; exit 1; fi
        sleep .25
    done
}
expect 'return i._serverRows.size === 2 && p.status.text === "eth0" && v("network-rx-total") === "101 B" && i._serverGroup.status.text === "a.invalid"'
expect 'const titles = i.menu._getMenuItems().filter(m => m.menu && m.visible).map(m => m.label.text).join(); return titles === "Server,Temperature,Memory,Processor,System,Network,Interface,Storage,Test GPU 9000"'
expect 'return i._groups.get("memory").status.text === "50.0%" && v("memory-physical") === "1.95 MB" && v("memory-free") === "600 KB" && v("memory-swap") === "1.46 MB" && v("processor-cores") === "1" && v("system-load5") === "2.00" && v("storage-mount") === "/srv/data"'
expect 'return [...dyn("disk").rows.keys()].join() === "disk:/,disk:/data" && dyn("disk").rows.get("disk:/data").value.text === "1.95 MB / 4.88 MB (40.0%)"'
expect 'const t = dyn("temperature"), g = dyn("gpu"); return t.group.status.text === "61.5 °C" && t.rows.get("temp:coretemp Package id 0").value.text === "45.0 °C" && g.group.status.text === "37.0%" && g.rows.get("gpu:0:memory").value.text === "1.00 GB / 8.00 GB" && g.rows.get("gpu:0:power").value.text === "55.2 W"'
probe 'dyn("temperature").rows.get("temp:nvme Composite").activate(null);'
expect 'return i._panelPairs.length === 7 && i._panelPairs[6].label.text === "61.5 °C"'
probe 'dyn("temperature").rows.get("temp:nvme Composite").activate(null);'
expect 'return i._panelPairs.length === 6'
probe 'Main.overview.hide(); i.menu.open(); p.item.menu.open();'
expect 'return global.stage.key_focus?.get_parent() === p.search && i._collectors.get("a").sample.interfaceNames.length > 128'
expect 'return p.results._getMenuItems()[0].label.text.includes("backup") && !p.next.visible && v("network-tx-history").length === 30'
probe 'p.containers.emit("clicked",1);'
expect 'return p.results.numMenuItems <= 6 && p.next.visible'
probe 'p.next.emit("clicked", 1);'
expect 'return p.results._getMenuItems()[0].label.text.startsWith("veth") && p.previous.visible'
probe 'p.search.set_text("EtH127");'
touch "$T/route-b"
expect 'return net("b") === "eno2"'
sleep 1
expect 'return p.results._getMenuItems().map(m=>m.label.text).join() === "veth127" && global.stage.key_focus === p.search.clutter_text'
probe 'p.search.set_text("not-there");'
expect 'return p.results._getMenuItems()[0].label.text === "No matches"'
probe 'p.search.set_text("wg"); p.results._getMenuItems()[0].activate(null);'
expect 'return p.status.text === "wg0" && v("network-rx-total") === "303 B" && net("b") === "eno2" && i._panelPairs.some(x => x.label.text === "303 B")'
probe 'i._serverRows.get("b").activate(null);'
expect 'return i._serverGroup.status.text === "b.invalid" && p.status.text === "eno2" && v("network-rx-total") === "505 B" && v("storage-mount") === "/" && i.menu.isOpen'
probe 'p.item.menu.open(); p.search.set_text("eth0"); p.results._getMenuItems().find(m=>m.label.text === "eth0").activate(null);'
expect 'return v("network-rx-total") === "101 B" && net("a") === "wg0" && net("b") === "eth0"'
expect 'return i._panelPairs.length === 6'
probe 'i._rows.get("memory-free").row.activate(null);'
expect 'return i._panelPairs.length === 7 && i._panelPairs[6].label.text === "600 KB" && i.menu.isOpen'
probe 'i._rows.get("memory-free").row.activate(null);'
expect 'return i._panelPairs.length === 6'
expect 'return [...dyn("disk").rows.keys()].join() === "disk:/data" && !dyn("temperature").group.item.visible && !dyn("gpu").group.item.visible'
probe 'dyn("disk").rows.get("disk:/data").activate(null);'
expect 'return i._panelPairs.length === 7 && i._panelPairs[6].label.text === "/data 40.0%"'
probe 'dyn("disk").rows.get("disk:/data").activate(null);'
expect 'return i._panelPairs.length === 6'
probe 'i._serverRows.get("a").activate(null);'
gnome-extensions disable "$uuid"
gnome-extensions enable "$uuid"
expect 'return p.status.text === "wg0" && v("network-rx-total") === "303 B" && net("b") === "eth0"'
touch "$T/unplug"
expect 'return p.status.text.includes("unavailable") && v("network-rx-total") === "…" && v("memory-usage") === "50.0%"'
rm "$T/unplug"
expect 'return v("network-rx-total") === "303 B"'
expect 'return v("storage-runway") !== "…"'
probe 'const c=i._collectors.get("a"), notify=c._onAlert; global.events=[]; c._onAlert=(l,e)=>{global.events.push(`${l}:${e}`); notify(l,e);};'
touch "$T/pressure"
expect 'return global.events.includes("Packet drops:warning") && global.events.includes("Low disk:warning")'
sleep 1
rm "$T/pressure"
expect 'return global.events.includes("Packet drops:recovered") && global.events.includes("Low disk:recovered") && global.events.length===4'
touch "$T/offline"
expect 'return i._collectors.get("a").status === "offline" && i._serverRows.get("a").value.text.startsWith("offline") && i._groups.get("memory").status.text === "No Data"'
sleep 40
expect 'return global.events.includes("Offline:warning")'
rm "$T/offline"
sleep 30
expect 'return global.events.includes("Offline:recovered") && global.events.length===6'
gnome-extensions prefs "$uuid"
expect 'const s=i._collectors.get("a").server; return s.mount === "/data set" && s.maintenance && s.labels.wg0 === "fixture uplink" && s.favorites.includes("wg0") && !i._collectors.get("b").server.maintenance'
expect 'return i._servers.map(s => s.host).join() === "a.invalid,b.invalid,web1,db1,old2.invalid" && i._servers[4].port === 2222 && i._serverRows.size === 5 && i._collectors.get(i._servers[3].id).status === "online"'
probe 'const c=i._collectors.get("a"); c._onAlert=(l,e)=>global.events.push(`${l}:${e}`);'
touch "$T/pressure"
sleep 2
expect 'return i._collectors.get("a").sample.dropping && global.events.length===6'
gnome-extensions disable "$uuid"
expect 'return !i'
if grep -E 'JS ERROR|JS WARNING|Gjs-CRITICAL' "$T/shell.log"; then exit 1; fi
printf 'Isolated menu groups, selection, top bar toggles, persistence and hotplug passed\n'
