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

check('plain ip', norm({host: '10.0.0.5'}).server, {id: 'x', name: '', host: '10.0.0.5', user: '', port: 0});
check('user@host:port', Common.parseAddress('deploy@web-1.example.com:2222'), {user: 'deploy', host: 'web-1.example.com', port: 2222});
check('[v6]:port', Common.parseAddress('root@[2001:db8::1]:22'), {user: 'root', host: '2001:db8::1', port: 22});
check('bare v6', Common.parseAddress('2001:db8::1'), {user: '', host: '2001:db8::1', port: 0});
check('ssh config alias', norm({host: 'forgejo', name: ' Git box '}).server, {id: 'x', name: 'Git box', host: 'forgejo', user: '', port: 0});
check('settings json with junk entries', Common.parseServers(
    '[{"id":"a","host":"h1"},{"id":"b","host":"-bad"},{"id":"a","host":"dup"},7,{"host":"noid"}]').map(s => s.host), ['h1']);
check('settings not json', Common.parseServers('{oops'), []);

const saved = Common.parseServers('[{"id":"a","host":"h","networkInterface":"wg0"},{"id":"b","host":"h"}]');
check('per-server choice survives settings round trip', Common.parseServers(JSON.stringify(saved)).map(s => s.networkInterface ?? null), ['wg0', null]);

const argv = buildSshArgv({host: 'h', user: 'u', port: 2200}, 'ssh');
check('argv tail', argv.slice(-7), ['-p', '2200', '-l', 'u', '--', 'h', 'sh']);
check('argv has BatchMode', argv.includes('BatchMode=yes'), true);
check('argv has accept-new', argv.includes('StrictHostKeyChecking=accept-new'), true);
check('argv has ControlMaster', argv.includes('ControlMaster=auto'), true);
check('interval forced to integer', /sleep 5; fi/.test(buildRemoteScript('7; rm -rf /')), true);
check('interval clamped', /sleep 300; fi/.test(buildRemoteScript(99999)), true);

const a = parseSampleLine('SV2 100.00 0.10 0.20 0.30 8000000 6000000 1000 800 4 100000 40000 60000 eth0 1000000 500000 wg0 100 900');
const b = parseSampleLine('SV2 105.00 0.10 0.20 0.30 8000000 4000000 2000 1300 4 100000 40000 60000 wg0 120 950 eth0 1512000 602400');
const first = computeSample(null, a);
const second = computeSample(a, b, 'eth0');
check('without selection no totals', [first.rxTotal, first.txTotal], [null, null]);
const tunnel = computeSample(a, b, 'wg0');
check('reordered tunnel counters', [tunnel.rxTotal, tunnel.txTotal, tunnel.rxRate, tunnel.txRate], [120, 950, 4, 10]);
const absent = {...b, interfaces: new Map()};
const missing = computeSample(a, absent, 'wg0');
check('absent interface', [missing.rxTotal, missing.txRate, missing.cpuPercent], [null, null, 50]);
check('return has no rate', computeSample({...absent, uptime: 99}, b, 'wg0').rxRate, null);
check('reset while uptime increases', computeSample({...b, uptime: 99}, a, 'wg0').rxRate, null);
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

check('formatBytes', [Common.formatBytes(0), Common.formatBytes(1536), Common.formatBytes(7.19 * 1024 ** 3)], ['0 B', '1.50 KB', '7.19 GB']);
check('formatRate', [Common.formatRate(null), Common.formatRate(512), Common.formatRate(41.9 * 1024)], ['\u2026', '0.50 KB/s', '41.9 KB/s']);
check('formatUptime', [Common.formatUptime(59), Common.formatUptime(3700), Common.formatUptime(90000)], ['0m', '1h 1m', '1d 1h']);

check('auth', classifyError('user@h: Permission denied (publickey).', 255), 'auth failed (key not accepted)');
check('timeout', classifyError('ssh: connect to host 192.0.2.1 port 22: Connection timed out', 255), 'timeout');
check('refused', classifyError('ssh: connect to host h port 1: Connection refused', 255), 'connection refused');
check('dns', classifyError('ssh: Could not resolve hostname nope: Name or service not known', 255), 'unknown host');
check('silent exit 255', classifyError('', 255), 'connection lost');
check('other exit', classifyError('', 4), 'ssh exited with status 4');

const parsed = Common.parseSshConfig([
    '# Host commented',
    'Host web1 db-1',
    '  HostName 10.0.0.5',
    '  User deploy',
    'Host *.internal !bastion jump?',
    '  User nobody',
    'Host=git',
    '  hostname = github.com',
    'Include conf.d/*.conf ~/.ssh/extra',
    'Match host other',
    '  User ignored',
    'Host bad;name "quoted"',
].join('\n'));
check('ssh config aliases', parsed.hosts.map(h => h.alias), ['web1', 'db-1', 'git', 'quoted']);
check('ssh config host details', parsed.hosts[1], {alias: 'db-1', hostName: '10.0.0.5', user: 'deploy'});
check('ssh config includes', parsed.includes, ['conf.d/*.conf', '~/.ssh/extra']);
check('git hosts recognised', parsed.hosts.map(h => Common.isGitHost(h)), [false, false, true, false]);
check('git alias without HostName', Common.isGitHost({alias: 'gitlab.com', hostName: ''}), true);

const knownHosts = Common.parseKnownHosts([
    '# note',
    'web1.example.com,192.0.2.10 ssh-ed25519 AAAA',
    'web1.example.com,192.0.2.10 ssh-rsa AAAA',
    '192.0.2.44 ssh-ed25519 AAAA',
    '[bastion.example.com]:2222 ssh-ed25519 AAAA',
    '|1|abc=|def= ssh-ed25519 AAAA',
    '@cert-authority *.example.com ssh-ed25519 AAAA',
    '*.wild.example.com ssh-ed25519 AAAA',
    'bad;host ssh-ed25519 AAAA',
].join('\n'));
check('known hosts', knownHosts.hosts, [
    {host: 'web1.example.com', port: 0}, {host: '192.0.2.44', port: 0}, {host: 'bastion.example.com', port: 2222}]);
check('hashed known hosts counted', knownHosts.hashed, 1);

print(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`);
imports.system.exit(failed === 0 ? 0 : 1);
