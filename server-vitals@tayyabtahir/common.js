export {MonitorHistory, SustainedAlert} from './monitor.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.server-vitals';

const HOST_RE = /^[A-Za-z0-9_.:%-]+$/;
const USER_RE = /^[A-Za-z0-9_.@\\+-]+$/;

export function validateHost(host) {
    if (typeof host !== 'string' || host.length === 0)
        return 'Host is required';
    if (host.length > 253)
        return 'Host is too long';
    if (host.startsWith('-'))
        return 'Host must not start with "-"';
    if (!HOST_RE.test(host))
        return 'Host may only contain letters, digits and . - _ : %';
    return null;
}

export function validateUser(user) {
    if (user === '' || user === undefined || user === null)
        return null;
    if (typeof user !== 'string' || user.length > 64)
        return 'User is too long';
    if (user.startsWith('-'))
        return 'User must not start with "-"';
    if (!USER_RE.test(user))
        return 'User contains characters that are not allowed';
    return null;
}

export function validatePort(port) {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        return 'Port must be a number between 1 and 65535';
    return null;
}

export function parseAddress(text) {
    let rest = String(text ?? '').trim();
    let user = '';
    let port = 0;

    const at = rest.lastIndexOf('@');
    if (at >= 0) {
        user = rest.slice(0, at);
        rest = rest.slice(at + 1);
    }

    let m = rest.match(/^\[([^\]]*)\](?::(\d+))?$/);
    if (m) {
        rest = m[1];
        if (m[2])
            port = parseInt(m[2], 10);
    } else {

        m = rest.match(/^([^:]*):(\d+)$/);
        if (m) {
            rest = m[1];
            port = parseInt(m[2], 10);
        }
    }
    return {user, host: rest, port};
}

const GIT_HOSTS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|ssh\.dev\.azure\.com)$/i;

export function isGitHost(host) {
    return GIT_HOSTS.test(host.hostName || host.alias);
}

export function parseSshConfig(text) {
    const hosts = [];
    const includes = [];
    let current = [];
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#'))
            continue;
        const match = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
        if (!match)
            continue;
        const key = match[1].toLowerCase();
        const values = match[2].trim().split(/\s+/).map(value => value.replace(/^"(.*)"$/, '$1'));
        if (key === 'host') {
            current = values
                .filter(value => !/[*?!]/.test(value) && validateHost(value) === null)
                .map(alias => ({alias, hostName: '', user: ''}));
            hosts.push(...current);
        } else if (key === 'match') {
            current = [];
        } else if (key === 'include') {
            includes.push(...values);
        } else if (key === 'hostname' || key === 'user') {
            const field = key === 'user' ? 'user' : 'hostName';
            for (const host of current)
                host[field] ||= values[0];
        }
    }
    return {hosts, includes};
}

export function parseKnownHosts(text) {
    const hosts = [];
    const seen = new Set();
    let hashed = 0;
    for (const raw of String(text).split('\n')) {
        const fields = raw.trim().split(/\s+/);
        if (!fields[0] || fields[0].startsWith('#') || fields[0].startsWith('@'))
            continue;
        if (fields[0].startsWith('|')) {
            hashed++;
            continue;
        }
        const entries = [];
        for (const name of fields[0].split(',')) {
            const match = name.match(/^\[([^\]]+)\]:(\d+)$/);
            const host = match ? match[1] : name;
            const port = match ? Number(match[2]) : 0;
            if (!/[*?!]/.test(host) && validateHost(host) === null && validatePort(port) === null)
                entries.push({host, port});
        }
        const entry = entries.find(item => !/^[\d.]+$/.test(item.host) && !item.host.includes(':')) ?? entries[0];
        const key = entry && `${entry.host} ${entry.port}`;
        if (!entry || seen.has(key))
            continue;
        seen.add(key);
        hosts.push(entry);
    }
    return {hosts, hashed};
}

export function validMount(path) {
    return typeof path === 'string' && path.length <= 256 && /^\/[A-Za-z0-9_./ -]*$/u.test(path) && !/[\r\n]/.test(path);
}

const validInterface = name => typeof name === 'string' && /^[^\s/:\x00-\x1f\x7f]{1,15}$/u.test(name);

export function normalizeServer(raw) {
    if (!raw || typeof raw !== 'object')
        return {server: null, error: 'Not an object'};

    const host = typeof raw.host === 'string' ? raw.host.trim() : '';
    const user = typeof raw.user === 'string' ? raw.user.trim() : '';
    let port = raw.port;
    if (port === '' || port === undefined || port === null)
        port = 0;
    if (typeof port === 'string' && /^\d+$/.test(port))
        port = parseInt(port, 10);

    const error = validateHost(host) ?? validateUser(user) ?? validatePort(port);
    if (error)
        return {server: null, error};

    let name = typeof raw.name === 'string' ? raw.name.trim() : '';
    name = name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 64);

    const id = typeof raw.id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw.id)
        ? raw.id : null;
    if (!id)
        return {server: null, error: 'Missing id'};

    const server = {id, name, host, user, port};
    if (validMount(raw.mount))
        server.mount = raw.mount;
    if (raw.maintenance === true)
        server.maintenance = true;
    if (Array.isArray(raw.favorites))
        server.favorites = [...new Set(raw.favorites.filter(validInterface))].slice(0, 256);
    if (raw.labels && typeof raw.labels === 'object')
        server.labels = Object.fromEntries(Object.entries(raw.labels).filter(([n, v]) =>
            validInterface(n) && typeof v === 'string').slice(0, 256).map(([n,v]) =>
            [n, v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40)]));
    if (validInterface(raw.networkInterface))
        server.networkInterface = raw.networkInterface;
    return {server, error: null};
}

export function parseServers(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];

    const seen = new Set();
    const servers = [];
    for (const raw of list) {
        const {server} = normalizeServer(raw);
        if (!server || seen.has(server.id))
            continue;
        seen.add(server.id);
        servers.push(server);
    }
    return servers;
}

export function serverTitle(server) {
    return server.name || server.host;
}

export function serverAddress(server) {
    let host = server.host;
    if (server.port && host.includes(':'))
        host = `[${host}]`;
    return `${server.user ? `${server.user}@` : ''}${host}${server.port ? `:${server.port}` : ''}`;
}

export function sameTarget(a, b) {
    return a.host === b.host && a.user === b.user && a.port === b.port;
}

function threeDigits(value) {
    if (value >= 100)
        return value.toFixed(0);
    if (value >= 10)
        return value.toFixed(1);
    return value.toFixed(2);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
        return '\u2026';
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1000 && unit < UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    if (unit === 0)
        return `${value.toFixed(0)} B`;
    return `${threeDigits(value)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSecond) {
    if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond))
        return '\u2026';

    if (bytesPerSecond < 1000)
        return `${(Math.max(0, bytesPerSecond) / 1024).toFixed(2)} KB/s`;
    return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(value))
        return '\u2026';
    return `${value.toFixed(1)}%`;
}

export function formatUptime(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds))
        return '\u2026';
    const s = Math.floor(seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0)
        return `${d}d ${h}h`;
    if (h > 0)
        return `${h}h ${m}m`;
    return `${m}m`;
}
