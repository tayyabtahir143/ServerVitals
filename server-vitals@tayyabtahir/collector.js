// Collects readings from one remote Linux server over ssh.
//
// One long-running `ssh host sh` process per server. A small POSIX sh loop is
// fed to the remote `sh` on stdin; it prints one line per sample, which is
// parsed here. Nothing in this file touches the shell UI, so the same module
// is used by the extension and by tests/collector-test.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const Status = {
    CONNECTING: 'connecting',
    ONLINE: 'online',
    OFFLINE: 'offline',
};

const CONNECT_TIMEOUT = 8;        // seconds, ssh ConnectTimeout
const CONTROL_PERSIST = 60;       // seconds the shared connection outlives us
const BACKOFF_FIRST = 2;          // seconds before the first reconnect
const BACKOFF_MAX = 60;
const STDERR_GRACE_MS = 300;      // wait this long for stderr after exit
const STDERR_KEEP_LINES = 8;
const MAX_CONTROL_DIR_LENGTH = 45; // unix socket paths are limited to ~108 bytes

/**
 * The script run on the server. Plain POSIX sh with cat/awk/df/sleep only, so
 * it also works on old distributions and on busybox.
 *
 * Output, one line per sample:
 *   SV1 uptime load1 load5 load15 memTotalKb memAvailKb cpuTotal cpuIdle
 *       cpuCount rxBytes txBytes diskTotalKb diskUsedKb diskAvailKb
 *
 * `interval` is the only value put into the script and it is forced to an
 * integer first.
 */
export function buildRemoteScript(interval) {
    const seconds = Math.min(300, Math.max(1, Math.floor(Number(interval)) || 5));
    return `LC_ALL=C; export LC_ALL
PATH="$PATH:/usr/sbin:/usr/bin:/sbin:/bin"; export PATH
if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then
  echo "SVERR /proc is not readable (not a Linux server?)"
  exit 3
fi
first=1
while :; do
  d=$(df -kP / 2>/dev/null | awk 'NR>1 { t=$2; u=$3; a=$4 } END { printf "%.0f %.0f %.0f", t, u, a }')
  awk -v disk="\${d:-0 0 0}" '
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
      if ($1 == "lo") next
      if ($1 ~ /^(docker|br-|br[0-9]|vmbr|fwbr|fwpr|fwln|veth|virbr|vnet|cni|flannel|cali|kube|tun|tap|wg|wt[0-9]|bond|team|dummy|ifb|lxc|lxd|podman|tailscale|zt|sit|ip6tnl|gre)/) next
      if (index($1, ".") > 0) next
      rx += $2; tx += $10
    }
    END {
      if ("MemAvailable:" in m) avail = m["MemAvailable:"]
      else avail = m["MemFree:"] + m["Buffers:"] + m["Cached:"] + m["SReclaimable:"] - m["Shmem:"]
      if (avail < 0) avail = 0
      printf "SV1 %s %s %s %s %.0f %.0f %.0f %.0f %d %.0f %.0f %s\\n", up, l1, l5, l15, m["MemTotal:"], avail, total, idle, ncpu, rx, tx, disk
    }
  ' /proc/uptime /proc/loadavg /proc/meminfo /proc/stat /proc/net/dev || exit 4
  if [ "$first" = 1 ]; then first=0; sleep 1; else sleep ${seconds}; fi
done </dev/null
`;
}

/** Parse one "SV1 ..." line into raw counters, or null if it is not one. */
export function parseSampleLine(line) {
    if (!line.startsWith('SV1 '))
        return null;
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    if (f.length < 14 || f.some(n => !Number.isFinite(n)))
        return null;
    return {
        uptime: f[0],
        load: [f[1], f[2], f[3]],
        memTotalKb: f[4],
        memAvailKb: f[5],
        cpuTotal: f[6],
        cpuIdle: f[7],
        cpuCount: f[8],
        rxBytes: f[9],
        txBytes: f[10],
        diskTotalKb: f[11],
        diskUsedKb: f[12],
        diskAvailKb: f[13],
    };
}

/**
 * Turn raw counters into readings. CPU % and network speed need the previous
 * sample; they are null on the first one.
 */
export function computeSample(prev, cur) {
    const memTotal = cur.memTotalKb * 1024;
    const memUsed = Math.max(0, cur.memTotalKb - cur.memAvailKb) * 1024;
    const diskSpace = cur.diskUsedKb + cur.diskAvailKb;

    const sample = {
        memTotal,
        memUsed,
        memPercent: memTotal > 0 ? 100 * memUsed / memTotal : null,
        cpuPercent: null,
        cpuCount: cur.cpuCount,
        rxRate: null,
        txRate: null,
        rxTotal: cur.rxBytes,
        txTotal: cur.txBytes,
        diskTotal: cur.diskTotalKb > 0 ? cur.diskTotalKb * 1024 : null,
        diskUsed: cur.diskTotalKb > 0 ? cur.diskUsedKb * 1024 : null,
        diskPercent: diskSpace > 0 ? 100 * cur.diskUsedKb / diskSpace : null,
        load: cur.load,
        uptime: cur.uptime,
    };

    if (prev) {
        // Time is taken from the server's own clock (/proc/uptime), so network
        // lag between samples does not distort the rates.
        const dt = cur.uptime - prev.uptime;
        const dTotal = cur.cpuTotal - prev.cpuTotal;
        const dIdle = cur.cpuIdle - prev.cpuIdle;
        if (dTotal > 0 && dIdle >= 0)
            sample.cpuPercent = Math.min(100, Math.max(0, 100 * (1 - dIdle / dTotal)));
        if (dt > 0) {
            const dRx = cur.rxBytes - prev.rxBytes;
            const dTx = cur.txBytes - prev.txBytes;
            // Negative: counter reset (interface went away, reboot). Skip once.
            if (dRx >= 0)
                sample.rxRate = dRx / dt;
            if (dTx >= 0)
                sample.txRate = dTx / dt;
        }
    }
    return sample;
}

/** Short, plain-English reason from ssh's stderr and exit status. */
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
    // ssh uses 255 for its own failures; with no message that is a dropped link.
    if (exitStatus === 0 || exitStatus === 255)
        return 'connection lost';
    return `ssh exited with status ${exitStatus}`;
}

/** Directory for the ssh control sockets, or null if multiplexing is off. */
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

/**
 * argv for the sampling connection. Always an array handed straight to
 * Gio.Subprocess: no local shell is involved, and `--` stops ssh from reading
 * the host as an option. (Fields are validated in common.js as well.)
 */
export function buildSshArgv(server, sshPath = 'ssh') {
    return [sshPath, '-T', ...commonSshOptions(server), '--', server.host, 'sh'];
}

/** argv that asks the shared (ControlMaster) connection to shut down. */
export function buildSshExitArgv(server, sshPath = 'ssh') {
    return [sshPath, ...commonSshOptions(server), '-O', 'exit', '--', server.host];
}

export class ServerCollector {
    /**
     * @param {object} server - {id, name, host, user, port} from common.js
     * @param {number} interval - seconds between samples
     * @param {Function} onChange - called with this collector on every change
     */
    constructor(server, interval, onChange) {
        this.server = server;
        this.status = Status.CONNECTING;
        this.error = null;
        this.sample = null;

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

    /** Drop the current connection and connect again right away. */
    restart() {
        if (this._destroyed)
            return;
        this._stopRun();
        this._backoff = BACKOFF_FIRST;
        this._setState(Status.CONNECTING, null);
        this._spawn();
    }

    setInterval(interval) {
        if (interval === this._interval)
            return;
        this._interval = interval;
        this.restart();
    }

    /** Kill ssh, remove every timer. The collector cannot be used afterwards. */
    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._stopRun();
        this._closeMaster();
        this._onChange = null;
        this.sample = null;
    }

    _setState(status, error, sample = null) {
        this.status = status;
        this.error = error;
        // Readings are only ever kept while online: no stale numbers.
        this.sample = status === Status.ONLINE ? sample : null;
        if (status !== Status.ONLINE)
            this._prevRaw = null;
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
            // Fire and forget; Gio reaps the child. Fails harmlessly when
            // there is no shared connection.
            Gio.Subprocess.new(buildSshExitArgv(this.server, this._sshPath),
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch {
            // nothing to close
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

    /** Declare the server offline if samples stop arriving. */
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
        };
        this._run = run;

        // Send the script, then close stdin so the remote sh starts running it.
        const stdin = proc.get_stdin_pipe();
        const script = new TextEncoder().encode(buildRemoteScript(this._interval));
        stdin.write_all_async(script, GLib.PRIORITY_DEFAULT, run.cancellable, (stream, res) => {
            try {
                stream.write_all_finish(res);
            } catch {
                // ssh already gone; the exit handler reports why.
            }
            stream.close_async(GLib.PRIORITY_DEFAULT, null, (s, r) => {
                try {
                    s.close_finish(r);
                } catch {
                    // already closed
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
                // fall through with whatever status is available
            }
            run.exited = true;
            run.exitStatus = p.get_if_exited() ? p.get_exit_status() : -1;
            if (run !== this._run)
                return;
            // Give the stderr reader a moment to deliver ssh's last words.
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
                // End of stream (or cancelled).
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
        // Anything else (login banners, shell rc output) is ignored.
        const raw = parseSampleLine(line);
        if (!raw)
            return;

        const sample = computeSample(this._prevRaw, raw);
        this._backoff = BACKOFF_FIRST;
        this._armStaleTimer();
        this._setState(Status.ONLINE, null, sample);
        this._prevRaw = raw;
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
