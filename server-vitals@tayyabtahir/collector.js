import {validMount, MonitorHistory, SustainedAlert} from './common.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const Status = {
    CONNECTING: 'connecting',
    ONLINE: 'online',
    OFFLINE: 'offline',
};

const CONNECT_TIMEOUT = 8;
const CONTROL_PERSIST = 60;
const BACKOFF_FIRST = 2;
const BACKOFF_MAX = 60;
const STDERR_GRACE_MS = 300;
const STDERR_KEEP_LINES = 8;
const MAX_CONTROL_DIR_LENGTH = 45;

export function buildRemoteScript(interval, mount = '/') {
    const seconds = Math.min(300, Math.max(1, Math.floor(Number(interval)) || 5));
    return `LC_ALL=C; export LC_ALL
PATH="$PATH:/usr/sbin:/usr/bin:/sbin:/bin"; export PATH
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  echo "SVERR /proc is not readable (not a Linux server?)"
  exit 3
fi
lan_backed() (
  name=$1
  case "$name" in ''|*[!A-Za-z0-9_.-]*|lo|docker*|br-????????????|veth*|virbr*|cni*|flannel*|wg*|tun*|tap*|tailscale*) return 1;; esac
  dev=/sys/class/net/$name
  [ "$2" -lt 8 ] && read -r kind < "$dev/type" && [ "$kind" = 1 ] || return 1
  [ -e "$dev/device" ] && return 0
  [ -d "$dev/bridge" ] || [ -d "$dev/bonding" ] || [ -e "/proc/net/vlan/$name" ] || return 1
  for lower in "$dev"/lower_*; do
    [ -e "$lower" ] && lan_backed "\${lower##*/lower_}" "$(($2 + 1))" && return 0
  done
  return 1
)
uplink=$(awk '$2 == "00000000" && $8 == "00000000" && $4 ~ /[13579bBdDfF]$/ && $7 ~ /^[0-9]+$/ {print $1, $7}' /proc/net/route 2>/dev/null |
  while read -r name metric; do
    if lan_backed "$name" 0 && read -r state < "/sys/class/net/$name/operstate" && [ "$state" = up ]; then
      printf '%s %s\\n' "$name" "$metric"
    fi
  done | awk '!found || $2 < best {found=1; best=$2; name=$1; tied=0; next} $2 == best && $1 != name {tied=1} END {if (found && !tied) print name}')
smi=$(command -v nvidia-smi 2>/dev/null)
limit=$(command -v timeout 2>/dev/null)
[ -n "$limit" ] && limit="$limit 4"
first=1
while :; do
  for f in /sys/class/hwmon/hwmon*/temp*_input; do
    [ -r "$f" ] && read -r v < "$f" || continue
    dir=\${f%/*}; base=\${f##*/}; base=\${base%_input}
    name=; label=
    read -r name < "$dir/name"
    [ -r "$dir/\${base}_label" ] && read -r label < "$dir/\${base}_label"
    echo "SVT $v \${name:-sensor} \${label:-$base}"
  done 2>/dev/null | head -n 40
  if [ -n "$smi" ]; then
    $limit "$smi" --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,name --format=csv,noheader,nounits 2>/dev/null | head -n 8 | sed 's/^/SVG /'
  fi
  for g in /sys/class/drm/card[0-9]*/device; do
    [ -r "$g/gpu_busy_percent" ] && read -r u < "$g/gpu_busy_percent" || continue
    mu=-; mt=-; t=-
    [ -r "$g/mem_info_vram_used" ] && read -r mu < "$g/mem_info_vram_used" && mu=$((mu / 1048576))
    [ -r "$g/mem_info_vram_total" ] && read -r mt < "$g/mem_info_vram_total" && mt=$((mt / 1048576))
    for h in "$g"/hwmon/hwmon*/temp1_input; do
      [ -r "$h" ] && read -r t < "$h" && t=$((t / 1000))
      break
    done
    card=\${g%/device}
    echo "SVG $u, $mu, $mt, $t, -, -, GPU \${card##*/card}"
  done 2>/dev/null | head -n 8
  d=$(df -kP '${validMount(mount) ? mount : '/'}' 2>/dev/null | awk 'NR>1 { t=$2; u=$3; a=$4 } END { printf "%.0f %.0f %.0f", t, u, a }')
  ds=$(df -kP 2>/dev/null | awk 'NR > 1 && NF == 6 && $1 ~ /^\\/dev\\// && $1 !~ /^\\/dev\\/(loop|sr|ram|zram)/ && $6 !~ /^\\/boot/ && $6 ~ /^\\/[A-Za-z0-9_.\\/-]*$/ && !seen[$1]++ && n < 16 { n++; out = out " " $6 " " $2 " " $3 " " $4 } END { printf "%d%s", n, out }')
  awk -v uplink="\${uplink:--}" -v disk="\${d:-0 0 0}" -v disks="\${ds:-0}" '
    FILENAME == "/proc/uptime"  { up = $1; next }
    FILENAME == "/proc/loadavg" { l1 = $1; l5 = $2; l15 = $3; next }
    FILENAME == "/proc/meminfo" { m[$1] = $2; next }
    FILENAME == "/proc/stat" {
      if ($1 == "cpu") {
        total = 0
        for (i = 2; i <= 9 && i <= NF; i++) total += $i
        idle = $5 + $6
      } else if ($1 ~ /^cpu[0-9]/) {
        ncpu++
      }
      next
    }
    FILENAME == "/proc/net/dev" {
      if (index($0, ":") == 0) next
      sub(/:/, " ")
      net = net " " $1 " " $2 " " $10 " " $5 " " $13
    }
    END {
      if ("MemAvailable:" in m) avail = m["MemAvailable:"]
      else avail = m["MemFree:"] + m["Buffers:"] + m["Cached:"] + m["SReclaimable:"] - m["Shmem:"]
      if (avail < 0) avail = 0
      printf "SV6 %s %s %s %s %s %.0f %.0f %.0f %.0f %d %s %.0f %.0f %.0f %.0f %s%s\\n", uplink, up, l1, l5, l15, m["MemTotal:"], avail, total, idle, ncpu, disk, m["MemFree:"], m["Cached:"], m["SwapTotal:"], m["SwapFree:"], disks, net
    }
  ' /proc/uptime /proc/loadavg /proc/meminfo /proc/stat /proc/net/dev || exit 4
  if [ "$first" = 1 ]; then first=0; sleep 1; else sleep ${seconds}; fi
done </dev/null
`;
}

export function parseSampleLine(line) {
    const [version, ...fields] = line.trim().split(/\s+/);
    if (!['SV2', 'SV3', 'SV4', 'SV5', 'SV6'].includes(version))
        return null;
    const uplink = version !== 'SV2' ? fields.shift() : null;
    const stride = version === 'SV2' || version === 'SV3' ? 3 : 5;
    const fixed = version === 'SV5' || version === 'SV6' ? 16 : 12;
    const f = fields.slice(0, fixed).map(Number);
    if (f.length < fixed || f.some(n => !Number.isFinite(n)))
        return null;

    let start = fixed;
    const disks = [];
    if (version === 'SV6') {
        const count = Number(fields[fixed]);
        if (!Number.isInteger(count) || count < 0 || count > 16)
            return null;
        start = fixed + 1 + 4 * count;
        for (let i = fixed + 1; i < start; i += 4) {
            const [mount, ...sizes] = fields.slice(i, i + 4);
            if (!mount?.startsWith('/') || sizes.length < 3 || !sizes.every(value => /^\d+$/.test(value)))
                return null;
            const [totalKb, usedKb, availKb] = sizes.map(Number);
            disks.push({mount, totalKb, usedKb, availKb});
        }
    }
    if (fields.length < start || (fields.length - start) % stride !== 0)
        return null;

    const interfaces = new Map();
    for (let i = start; i < fields.length; i += stride) {
        const [name, rx, tx] = fields.slice(i, i + 3);
        if (!/^\d+$/.test(rx) || !/^\d+$/.test(tx) || interfaces.has(name))
            return null;
        const counters = {rx: Number(rx), tx: Number(tx)};
        if (stride === 5) {
            const drops = fields.slice(i + 3, i + 5);
            if (!drops.every(value => /^\d+$/.test(value)))
                return null;
            [counters.rxDrop, counters.txDrop] = drops.map(Number);
        }
        interfaces.set(name, counters);
    }
    return {
        uptime: f[0],
        load: [f[1], f[2], f[3]],
        memTotalKb: f[4],
        memAvailKb: f[5],
        cpuTotal: f[6],
        cpuIdle: f[7],
        cpuCount: f[8],
        uplink: uplink !== '-' && interfaces.has(uplink) ? uplink : null,
        interfaces,
        disks,
        diskTotalKb: f[9],
        diskUsedKb: f[10],
        diskAvailKb: f[11],
        memFreeKb: f[12] ?? null,
        memCachedKb: f[13] ?? null,
        swapTotalKb: f[14] ?? null,
        swapFreeKb: f[15] ?? null,
    };
}

const cleanText = text => text.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();

export function parseTempLine(line) {
    const match = line.match(/^SVT (-?\d+) (.+)$/);
    if (!match)
        return null;
    const celsius = Number(match[1]) / 1000;
    const label = cleanText(match[2]).slice(0, 48);
    if (!label || celsius < -50 || celsius > 200)
        return null;
    return {label, celsius};
}

export function parseGpuLine(line) {
    if (!line.startsWith('SVG '))
        return null;
    const parts = line.slice(4).split(',');
    if (parts.length < 7)
        return null;
    const [usage, memUsed, memTotal, celsius, fan, power] = parts.slice(0, 6).map(text => {
        const value = parseFloat(text);
        return Number.isFinite(value) && value >= 0 ? value : null;
    });
    const name = cleanText(parts.slice(6).join(',')).slice(0, 48) || 'GPU';
    const mib = value => value === null ? null : value * 1048576;
    return {name, usage, memUsed: mib(memUsed), memTotal: mib(memTotal), celsius, fan, power};
}

export function computeSample(prev, cur, interfaceName) {
    const current = cur.interfaces.get(interfaceName);
    const previous = prev?.interfaces.get(interfaceName);
    const memTotal = cur.memTotalKb * 1024;
    const memUsed = Math.max(0, cur.memTotalKb - cur.memAvailKb) * 1024;
    const diskSpace = cur.diskUsedKb + cur.diskAvailKb;
    const kb = value => value === null ? null : value * 1024;

    const seen = new Map();
    const temps = (cur.temps ?? []).map(temp => {
        const count = (seen.get(temp.label) ?? 0) + 1;
        seen.set(temp.label, count);
        return count > 1 ? {...temp, label: `${temp.label} ${count}`} : temp;
    });

    const sample = {
        uplink: cur.uplink,
        temps,
        gpus: cur.gpus ?? [],
        interfaceNames: [...cur.interfaces.keys()].sort(),
        memTotal,
        memUsed,
        memPercent: memTotal > 0 ? 100 * memUsed / memTotal : null,
        memAvailable: cur.memAvailKb * 1024,
        memFree: kb(cur.memFreeKb),
        memCached: kb(cur.memCachedKb),
        swapTotal: kb(cur.swapTotalKb),
        swapUsed: cur.swapTotalKb === null ? null : Math.max(0, cur.swapTotalKb - cur.swapFreeKb) * 1024,
        cpuPercent: null,
        cpuCount: cur.cpuCount,
        rxRate: null,
        txRate: null,
        rxTotal: current?.rx ?? null,
        txTotal: current?.tx ?? null,
        dropping: null,
        diskFree: cur.diskTotalKb > 0 ? cur.diskAvailKb * 1024 : null,
        diskTotal: cur.diskTotalKb > 0 ? cur.diskTotalKb * 1024 : null,
        diskUsed: cur.diskTotalKb > 0 ? cur.diskUsedKb * 1024 : null,
        diskPercent: diskSpace > 0 ? 100 * cur.diskUsedKb / diskSpace : null,
        disks: cur.disks.map(d => ({
            mount: d.mount,
            total: d.totalKb * 1024,
            used: d.usedKb * 1024,
            free: d.availKb * 1024,
            percent: d.usedKb + d.availKb > 0 ? 100 * d.usedKb / (d.usedKb + d.availKb) : null,
        })),
        load: cur.load,
        uptime: cur.uptime,
    };

    if (prev) {
        const dt = cur.uptime - prev.uptime;
        const dTotal = cur.cpuTotal - prev.cpuTotal;
        const dIdle = cur.cpuIdle - prev.cpuIdle;
        if (dTotal > 0 && dIdle >= 0)
            sample.cpuPercent = Math.min(100, Math.max(0, 100 * (1 - dIdle / dTotal)));
        if (dt > 0 && current && previous) {
            if (current.rxDrop >= previous.rxDrop && current.txDrop >= previous.txDrop)
                sample.dropping = current.rxDrop > previous.rxDrop || current.txDrop > previous.txDrop;
            const dRx = current.rx - previous.rx;
            const dTx = current.tx - previous.tx;

            if (dRx >= 0)
                sample.rxRate = dRx / dt;
            if (dTx >= 0)
                sample.txRate = dTx / dt;
        }
    }
    return sample;
}

export function classifyError(stderrText, exitStatus) {
    const text = stderrText || '';
    const tests = [
        [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, 'host key changed (see ssh-keygen -R)'],
        [/Host key verification failed/i, 'host key verification failed'],
        [/Permission denied/i, 'auth failed (key not accepted)'],
        [/Too many authentication failures/i, 'auth failed (too many keys tried)'],
        [/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i, 'unknown host'],
        [/Connection timed out|Operation timed out|timed out/i, 'timeout'],
        [/Connection refused/i, 'connection refused'],
        [/No route to host/i, 'no route to host'],
        [/Network is unreachable/i, 'network unreachable'],
        [/Connection reset|Connection closed|kex_exchange_identification|Broken pipe/i, 'connection closed'],
        [/Bad configuration option|Bad port|bad permissions/i, 'ssh configuration error'],
        [/command not found|not found/i, 'remote command failed'],
    ];
    for (const [re, reason] of tests) {
        if (re.test(text))
            return reason;
    }

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 0) {
        const last = lines[lines.length - 1].replace(/^ssh: /, '');
        return last.length > 80 ? `${last.slice(0, 79)}\u2026` : last;
    }

    if (exitStatus === 0 || exitStatus === 255)
        return 'connection lost';
    return `ssh exited with status ${exitStatus}`;
}

export function controlDir() {
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'server-vitals']);
    if (dir.length > MAX_CONTROL_DIR_LENGTH)
        return null;
    if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
        return null;
    return dir;
}

function commonSshOptions(server) {
    const args = [
        '-o', 'BatchMode=yes',
        '-o', `ConnectTimeout=${CONNECT_TIMEOUT}`,
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'LogLevel=ERROR',
        '-o', 'ForwardAgent=no',
        '-o', 'ForwardX11=no',
        '-o', 'ClearAllForwardings=yes',
        '-o', 'PermitLocalCommand=no',
        '-o', 'RequestTTY=no',
    ];
    const dir = controlDir();
    if (dir) {
        args.push('-o', 'ControlMaster=auto',
            '-o', `ControlPersist=${CONTROL_PERSIST}`,
            '-o', `ControlPath=${dir}/%C`);
    } else {
        args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
    }
    if (server.port)
        args.push('-p', String(server.port));
    if (server.user)
        args.push('-l', server.user);
    return args;
}

export function buildSshArgv(server, sshPath = 'ssh') {
    return [sshPath, '-T', ...commonSshOptions(server), '--', server.host, 'sh'];
}

export function buildSshExitArgv(server, sshPath = 'ssh') {
    return [sshPath, ...commonSshOptions(server), '-O', 'exit', '--', server.host];
}

export class ServerCollector {
    constructor(server, interval, onChange, onAlert = null) {
        this.server = server;
        this.status = Status.CONNECTING;
        this.error = null;
        this.sample = null;

        this.history = new MonitorHistory();
        this._alerts = new Map();
        this._onAlert = onAlert;
        this._interval = interval;
        this._onChange = onChange;
        this._sshPath = GLib.find_program_in_path('ssh');
        this._decoder = new TextDecoder('utf-8', {fatal: false});
        this._run = null;
        this._prevRaw = null;
        this._backoff = BACKOFF_FIRST;
        this._retryId = 0;
        this._staleId = 0;
        this._destroyed = false;
    }

    start() {
        if (this._destroyed || this._run)
            return;
        this._spawn();
    }

    restart() {
        if (this._destroyed)
            return;
        this._stopRun();
        this._backoff = BACKOFF_FIRST;
        this._setState(Status.CONNECTING, null);
        this._spawn();
    }

    updateServer(server) {
        if (this.server.maintenance !== server.maintenance)
            this._alerts.clear();
        if (this.server.networkInterface !== server.networkInterface) {
            this.history.net.clear();
            this._alerts.delete('Packet drops');
        }
        if (this.sample && this.server.networkInterface !== server.networkInterface) {
            const counters = this._prevRaw.interfaces.get(server.networkInterface);
            this.sample.rxTotal = counters?.rx ?? null;
            this.sample.txTotal = counters?.tx ?? null;
            this.sample.rxRate = null;
            this.sample.txRate = null;
        }
        this.server = server;
    }

    setInterval(interval) {
        if (interval === this._interval)
            return;
        this._interval = interval;
        this.restart();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._offlineCheckId) {
            GLib.source_remove(this._offlineCheckId);
            this._offlineCheckId = 0;
        }
        this._stopRun();
        this._closeMaster();
        this._onChange = null;
        this.sample = null;
    }

    _observe(label, bad, now) {
        if (!this._alerts.has(label))
            this._alerts.set(label, new SustainedAlert());
        const event = this._alerts.get(label).update(now, bad, this.server.maintenance);
        if (event)
            this._onAlert?.(label, event);
    }

    _setState(status, error, sample = null) {
        this.status = status;
        this.error = error;

        this.sample = status === Status.ONLINE ? sample : null;
        if (status !== Status.ONLINE)
            this._prevRaw = null;
        this._observe('Offline', status === Status.CONNECTING ? null : status === Status.OFFLINE,
            GLib.get_monotonic_time() / 1e6);
        if (status === Status.OFFLINE && !this._offlineCheckId && !this._destroyed) {
            this._offlineCheckId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 31, () => {
                this._offlineCheckId = 0;
                if (this.status === Status.OFFLINE)
                    this._observe('Offline', true, GLib.get_monotonic_time() / 1e6);
                return GLib.SOURCE_REMOVE;
            });
        }
        if (sample)
            this.history.add(sample, this.server.networkInterface);
        this._observe('Packet drops', sample?.dropping ?? null, sample?.uptime);
        this._observe('Low disk', sample?.diskPercent == null ? null : sample.diskPercent >= 90, sample?.uptime);
        this._onChange?.(this);
    }

    _removeTimers() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._staleId) {
            GLib.source_remove(this._staleId);
            this._staleId = 0;
        }
    }

    _stopRun() {
        this._removeTimers();
        const run = this._run;
        this._run = null;
        if (!run)
            return;
        if (run.graceId) {
            GLib.source_remove(run.graceId);
            run.graceId = 0;
        }
        run.cancellable.cancel();
        run.proc.force_exit();
    }

    _closeMaster() {
        if (!this._sshPath || !controlDir())
            return;
        try {
            Gio.Subprocess.new(buildSshExitArgv(this.server, this._sshPath),
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
        }
    }

    _scheduleRetry() {
        if (this._destroyed || this._retryId)
            return;
        const delay = this._backoff;
        this._backoff = Math.min(BACKOFF_MAX, this._backoff * 2);
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this._spawn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _armStaleTimer() {
        if (this._staleId)
            GLib.source_remove(this._staleId);
        const seconds = Math.max(15, this._interval * 3 + 5);
        this._staleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._staleId = 0;
            this._stopRun();
            this._closeMaster();
            this._setState(Status.OFFLINE, 'timeout (no data received)');
            this._scheduleRetry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _spawn() {
        if (this._destroyed || this._run)
            return;

        if (!this._sshPath) {
            this._setState(Status.OFFLINE, 'ssh is not installed on this computer');
            return;
        }

        let proc;
        try {
            proc = Gio.Subprocess.new(buildSshArgv(this.server, this._sshPath),
                Gio.SubprocessFlags.STDIN_PIPE |
                Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._setState(Status.OFFLINE, `cannot start ssh: ${e.message}`);
            this._scheduleRetry();
            return;
        }

        const run = {
            proc,
            cancellable: new Gio.Cancellable(),
            stderrLines: [],
            remoteError: null,
            exited: false,
            exitStatus: 0,
            stderrDone: false,
            graceId: 0,
            temps: [],
            gpus: [],
        };
        this._run = run;

        const stdin = proc.get_stdin_pipe();
        const script = new TextEncoder().encode(buildRemoteScript(this._interval, this.server.mount));
        stdin.write_all_async(script, GLib.PRIORITY_DEFAULT, run.cancellable, (stream, res) => {
            try {
                stream.write_all_finish(res);
            } catch {
            }
            stream.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
                try {
                    s.close_finish(r);
                } catch {
                }
            });
        });

        this._readLines(run, new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        }), false);
        this._readLines(run, new Gio.DataInputStream({
            base_stream: proc.get_stderr_pipe(),
            close_base_stream: true,
        }), true);

        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch {
            }
            run.exited = true;
            run.exitStatus = p.get_if_exited() ? p.get_exit_status() : -1;
            if (run !== this._run)
                return;

            run.graceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STDERR_GRACE_MS, () => {
                run.graceId = 0;
                run.stderrDone = true;
                this._maybeFinish(run);
                return GLib.SOURCE_REMOVE;
            });
            this._maybeFinish(run);
        });
    }

    _readLines(run, stream, isStderr) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, run.cancellable, (s, res) => {
            let bytes = null;
            try {
                [bytes] = s.read_line_finish(res);
            } catch {
                bytes = null;
            }

            if (bytes === null) {

                s.close_async(GLib.PRIORITY_DEFAULT, null, null);
                if (isStderr) {
                    run.stderrDone = true;
                    this._maybeFinish(run);
                }
                return;
            }
            if (run !== this._run)
                return;

            const line = this._decoder.decode(bytes).replace(/\r$/, '');
            if (isStderr)
                this._onStderrLine(run, line);
            else
                this._onStdoutLine(run, line);

            if (run === this._run)
                this._readLines(run, stream, isStderr);
        });
    }

    _onStderrLine(run, line) {
        if (line.trim().length === 0)
            return;
        run.stderrLines.push(line);
        if (run.stderrLines.length > STDERR_KEEP_LINES)
            run.stderrLines.shift();
    }

    _onStdoutLine(run, line) {
        if (line.startsWith('SVERR ')) {
            run.remoteError = line.slice(6).trim().slice(0, 80);
            return;
        }

        if (line.startsWith('SVT ')) {
            const temp = parseTempLine(line);
            if (temp && run.temps.length < 40)
                run.temps.push(temp);
            return;
        }
        if (line.startsWith('SVG ')) {
            const gpu = parseGpuLine(line);
            if (gpu && run.gpus.length < 8)
                run.gpus.push(gpu);
            return;
        }

        const raw = parseSampleLine(line);
        if (!raw)
            return;
        raw.temps = run.temps;
        raw.gpus = run.gpus;
        run.temps = [];
        run.gpus = [];

        const sample = computeSample(this._prevRaw, raw, this.server.networkInterface);
        this._backoff = BACKOFF_FIRST;
        this._armStaleTimer();
        this._prevRaw = raw;
        this._setState(Status.ONLINE, null, sample);
    }

    _maybeFinish(run) {
        if (run !== this._run || !run.exited || !run.stderrDone)
            return;
        this._stopRun();
        if (this._destroyed)
            return;
        const reason = run.remoteError ??
            classifyError(run.stderrLines.join('\n'), run.exitStatus);
        this._setState(Status.OFFLINE, reason);
        this._scheduleRetry();
    }
}
