// Unit checks for input validation, address parsing, sample maths and error
// wording. Run: gjs -m tests/validation-test.js

import {buildSshArgv, classifyError, computeSample, parseSampleLine, buildRemoteScript}
    from '../server-vitals@tayyabtahir/collector.js';
import * as Common from '../server-vitals@tayyabtahir/common.js';

let failed = 0;
function check(what, got, want) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w)
        failed++;
    print(`${g === w ? 'ok  ' : 'FAIL'} ${what}: ${g}${g === w ? '' : ` (wanted ${w})`}`);
}
const norm = raw => Common.normalizeServer({id: 'x', ...raw});

// Values that must never reach ssh.
for (const host of ['-oProxyCommand=evil', '-v', '', 'a b', 'bad;host', 'x$(id)', 'a`id`', 'h\nx', '"q"', "a'b", 'a/b'])
    check(`host ${JSON.stringify(host)} rejected`, norm({host}).server, null);
for (const user of ['-oProxyCommand=evil', 'a b', 'root;id', '$(id)'])
    check(`user ${JSON.stringify(user)} rejected`, norm({host: 'h', user}).server, null);
for (const port of [-1, 65536, 1.5, '22; id', '-p'])
    check(`port ${JSON.stringify(port)} rejected`, norm({host: 'h', port}).server, null);
check('address "-oProxyCommand=evil" rejected',
    norm(Common.parseAddress('-oProxyCommand=evil')).server, null);
check('address "-lroot@host" rejected',
    norm(Common.parseAddress('-lroot@host')).server, null);

// Values that must be accepted.
check('plain ip', norm({host: '10.0.0.5'}).server, {id: 'x', name: '', host: '10.0.0.5', user: '', port: 0});
check('user@host:port', Common.parseAddress('deploy@web-1.example.com:2222'), {user: 'deploy', host: 'web-1.example.com', port: 2222});
check('[v6]:port', Common.parseAddress('root@[2001:db8::1]:22'), {user: 'root', host: '2001:db8::1', port: 22});
check('bare v6', Common.parseAddress('2001:db8::1'), {user: '', host: '2001:db8::1', port: 0});
check('ssh config alias', norm({host: 'forgejo', name: ' Git box '}).server, {id: 'x', name: 'Git box', host: 'forgejo', user: '', port: 0});
check('settings json with junk entries', Common.parseServers(
    '[{"id":"a","host":"h1"},{"id":"b","host":"-bad"},{"id":"a","host":"dup"},7,{"host":"noid"}]').map(s => s.host), ['h1']);
check('settings not json', Common.parseServers('{oops'), []);

// argv: host always after "--", user/port as separate arguments.
const argv = buildSshArgv({host: 'h', user: 'u', port: 2200}, 'ssh');
check('argv tail', argv.slice(-7), ['-p', '2200', '-l', 'u', '--', 'h', 'sh']);
check('argv has BatchMode', argv.includes('BatchMode=yes'), true);
check('argv has accept-new', argv.includes('StrictHostKeyChecking=accept-new'), true);
check('argv has ControlMaster', argv.includes('ControlMaster=auto'), true);
check('interval forced to integer', /sleep 5; fi/.test(buildRemoteScript('7; rm -rf /')), true);
check('interval clamped', /sleep 300; fi/.test(buildRemoteScript(99999)), true);

// Sample maths.
const a = parseSampleLine('SV1 100.00 0.10 0.20 0.30 8000000 6000000 1000 800 4 1000000 500000 100000 40000 60000');
const b = parseSampleLine('SV1 105.00 0.10 0.20 0.30 8000000 4000000 2000 1300 4 1512000 602400 100000 40000 60000');
const first = computeSample(null, a);
const second = computeSample(a, b);
check('first sample has no cpu/rates', [first.cpuPercent, first.rxRate, first.txRate], [null, null, null]);
check('ram used bytes', second.memUsed, 4000000 * 1024);
check('ram percent', second.memPercent, 50);
check('cpu percent', second.cpuPercent, 50);
check('rx rate B/s', second.rxRate, 102400);
check('tx rate B/s', second.txRate, 20480);
check('disk percent', second.diskPercent, 40);
check('counter reset gives no rate', computeSample(b, a).rxRate, null);
check('junk line ignored', parseSampleLine('Welcome to Ubuntu'), null);
check('short line ignored', parseSampleLine('SV1 1 2 3'), null);

// Formatting.
check('formatBytes', [Common.formatBytes(0), Common.formatBytes(1536), Common.formatBytes(7.19 * 1024 ** 3)], ['0 B', '1.50 KB', '7.19 GB']);
check('formatRate', [Common.formatRate(null), Common.formatRate(512), Common.formatRate(41.9 * 1024)], ['\u2026', '0.50 KB/s', '41.9 KB/s']);
check('formatUptime', [Common.formatUptime(59), Common.formatUptime(3700), Common.formatUptime(90000)], ['0m', '1h 1m', '1d 1h']);

// Error wording.
check('auth', classifyError('user@h: Permission denied (publickey).', 255), 'auth failed (key not accepted)');
check('timeout', classifyError('ssh: connect to host 192.0.2.1 port 22: Connection timed out', 255), 'timeout');
check('refused', classifyError('ssh: connect to host h port 1: Connection refused', 255), 'connection refused');
check('dns', classifyError('ssh: Could not resolve hostname nope: Name or service not known', 255), 'unknown host');
check('silent exit 255', classifyError('', 255), 'connection lost');
check('other exit', classifyError('', 4), 'ssh exited with status 4');

print(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
imports.system.exit(failed === 0 ? 0 : 1);
