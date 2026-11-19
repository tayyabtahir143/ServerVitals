import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {buildRemoteScript, parseSampleLine} from '../server-vitals@tayyabtahir/collector.js';

function equal(label, actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    print(`ok ${label}`);
}

function counters() {
    const [, bytes] = GLib.file_get_contents('/proc/net/dev');
    return new Map(new TextDecoder().decode(bytes).trim().split('\n').slice(2).map(line => {
        const [name, fields] = line.trim().split(':');
        const values = fields.trim().split(/\s+/).map(Number);
        return [name, [values[0], values[8]]];
    }));
}

const before = counters();
const proc = Gio.Subprocess.new(['sh', '-c', buildRemoteScript(1).replace('while :; do', 'for once in 1; do')],
    Gio.SubprocessFlags.STDOUT_PIPE);
const [, output] = proc.communicate_utf8(null, null);
const after = counters();
const raw = parseSampleLine(output.trim().split('\n').at(-1));
equal('live interface names', [...(raw?.interfaces?.keys() ?? [])].sort(), [...after.keys()].sort());
for (const [name, {rx, tx}] of raw.interfaces) {
    equal(`live RX/TX bounds for ${name}`, [rx, tx].every((n, i) =>
        n >= before.get(name)[i] && n <= after.get(name)[i]), true);
}
