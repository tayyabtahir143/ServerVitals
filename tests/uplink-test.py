import subprocess
import tempfile
from pathlib import Path

script = subprocess.check_output(['gjs', '-m', 'tests/print-sampler.js'], text=True)
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    net = root / 'sys/class/net'
    proc = root / 'proc'
    (proc / 'net').mkdir(parents=True)
    for file, text in {'stat': 'cpu 1 2 3 4 5 6 7 8\ncpu0 1', 'uptime': '123 0',
                       'loadavg': '1 2 3', 'meminfo': 'MemTotal: 123 kB'}.items():
        (proc / file).write_text(text)
    names = ['ens3', 'eno2', 'br0', 'bond0', 'lan.20', 'docker0', 'tap0', 'eth0', 'wg0', 'lo']
    for name in names:
        d = net / name
        d.mkdir(parents=True)
        (d / 'type').write_text('1\n')
        (d / 'operstate').write_text('up\n')
    for name in ['ens3', 'eno2']:
        (net / name / 'device').mkdir()
    for name, lower in [('br0', 'bond0'), ('bond0', 'ens3'), ('lan.20', 'br0')]:
        (net / name / ('lower_' + lower)).symlink_to(net / lower)
    (net / 'br0/bridge').mkdir()
    (net / 'bond0/bonding').mkdir()
    (proc / 'net/vlan').mkdir()
    (proc / 'net/vlan/lan.20').touch()
    (proc / 'net/dev').write_text(''.join(f'{n}: ' + '1 ' * 16 + '\n' for n in names))
    sampler = script.replace('/proc/', str(proc) + '/').replace('/sys/class/net', str(net))
    sampler = sampler.replace('while :; do', 'for once in 1; do').replace('sleep 1;', ':;')

    def check(routes, expected):
        (proc / 'net/route').write_text(''.join(
            f'{name} 00000000 01000000 0003 0 0 {metric} 00000000 0 0 0\n'
            for name, metric in routes))
        lines = subprocess.check_output(['sh', '-c', sampler], text=True).splitlines()
        out = next(line for line in lines if line.startswith('SV6 ')).split()
        assert out[:2] == ['SV6', expected], (routes, out[:2], expected)
        print('ok', routes, '=>', expected)

    for name in ['ens3', 'br0', 'bond0', 'lan.20']:
        check([('wg0', 0), ('eth0', 1), (name, 5), ('eno2', 10)], name)
    check([('ens3', 5), ('eno2', 5)], '-')
    for name in ['lo', 'eth0', 'docker0', 'tap0', 'wg0']:
        check([(name, 0)], '-')
    check([], '-')
