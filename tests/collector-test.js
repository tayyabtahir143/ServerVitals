// Standalone test for the collector the extension uses.
//
//   gjs -m tests/collector-test.js [seconds] target [target...]
//
// target is [user@]host[:port]. Every state change is printed as one line.
// Example: gjs -m tests/collector-test.js 15 127.0.0.1:22222 192.0.2.1 127.0.0.1:1

import GLib from 'gi://GLib';

import {ServerCollector, Status, buildSshArgv} from '../server-vitals@tayyabtahir/collector.js';
import * as Common from '../server-vitals@tayyabtahir/common.js';

const args = [...ARGV];
let seconds = 15;
if (args.length > 0 && /^\d+$/.test(args[0]))
    seconds = parseInt(args.shift(), 10);
if (args.length === 0) {
    printerr('usage: gjs -m tests/collector-test.js [seconds] [user@]host[:port] ...');
    imports.system.exit(2);
}

const interval = parseInt(GLib.getenv('SV_INTERVAL') ?? '3', 10);
const loop = new GLib.MainLoop(null, false);
const start = GLib.get_monotonic_time();
const elapsed = () => ((GLib.get_monotonic_time() - start) / 1e6).toFixed(1).padStart(5);

const collectors = [];
let n = 0;
for (const target of args) {
    const {server, error} = Common.normalizeServer({
        id: `t${n++}`, name: '', ...Common.parseAddress(target),
    });
    if (!server) {
        print(`[${elapsed()}s] ${target}: REJECTED by validation: ${error}`);
        continue;
    }
    print(`argv for ${target}: ${JSON.stringify(buildSshArgv(server))}`);

    const collector = new ServerCollector(server, interval, c => {
        const who = Common.serverAddress(c.server).padEnd(18);
        if (c.status === Status.ONLINE) {
            const s = c.sample;
            print(`[${elapsed()}s] ${who} ONLINE  ` +
                `ram ${Common.formatBytes(s.memUsed)}/${Common.formatBytes(s.memTotal)} (${Common.formatPercent(s.memPercent)})  ` +
                `cpu ${Common.formatPercent(s.cpuPercent)} of ${s.cpuCount}  ` +
                `up ${Common.formatRate(s.txRate)} down ${Common.formatRate(s.rxRate)}  ` +
                `total up ${Common.formatBytes(s.txTotal)} [${s.txTotal}] down ${Common.formatBytes(s.rxTotal)} [${s.rxTotal}]  ` +
                `disk ${Common.formatBytes(s.diskUsed)}/${Common.formatBytes(s.diskTotal)} (${Common.formatPercent(s.diskPercent)})  ` +
                `load ${s.load.join(' ')}  uptime ${Common.formatUptime(s.uptime)} [${s.uptime}]`);
        } else {
            print(`[${elapsed()}s] ${who} ${c.status.toUpperCase()}  ${c.error ?? ''}  sample=${c.sample}`);
        }
    });
    collectors.push(collector);
    collector.start();
}

GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
    for (const c of collectors)
        c.destroy();
    print(`[${elapsed()}s] destroyed all collectors`);
    // Let the "ssh -O exit" helpers finish before leaving.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
});

loop.run();
