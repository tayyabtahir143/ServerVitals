// Shared helpers: server-list parsing, input validation and number formatting.
// Only plain JS in here, so it can be imported by the shell extension,
// by the preferences window and by the standalone tests.

export const SCHEMA_ID = 'org.gnome.shell.extensions.server-vitals';

const HOST_RE = /^[A-Za-z0-9_.:%-]+$/;
const USER_RE = /^[A-Za-z0-9_.@\\+-]+$/;

/**
 * Return an error message for a host value, or null when it is acceptable.
 * Values starting with '-' are refused so they can never be read by ssh as
 * an option.
 */
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

/** port: 0 means "not set" (ssh default or ~/.ssh/config). */
export function validatePort(port) {
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        return 'Port must be a number between 1 and 65535';
    return null;
}

/**
 * Split "user@host", "host:port", "user@host:port" or "[v6addr]:port".
 * Returns {user, host, port} where user is '' and port is 0 when absent.
 * No validation is done here.
 */
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
        // Exactly one colon: host:port. More than one: a bare IPv6 address.
        m = rest.match(/^([^:]*):(\d+)$/);
        if (m) {
            rest = m[1];
            port = parseInt(m[2], 10);
        }
    }
    return {user, host: rest, port};
}

/**
 * Clean one server object coming from settings or from the prefs dialog.
 * Returns {server, error}: server is null when the entry is not usable.
 */
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

    return {server: {id, name, host, user, port}, error: null};
}

/** Parse the "servers" settings string. Bad entries are dropped. */
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

/** What to call a server in the UI. */
export function serverTitle(server) {
    return server.name || server.host;
}

/** user@host:port, leaving out the parts that are not set. */
export function serverAddress(server) {
    let host = server.host;
    if (server.port && host.includes(':'))
        host = `[${host}]`;
    return `${server.user ? `${server.user}@` : ''}${host}${server.port ? `:${server.port}` : ''}`;
}

/** True when two entries would open the same ssh connection. */
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

/** 1536 -> "1.50 KB" (1024-based, three significant digits, like Vitals). */
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
    // Rates below 1 KB/s are shown in KB/s so the label does not jump around.
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
