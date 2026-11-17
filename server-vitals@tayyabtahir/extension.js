// Server Vitals - live RAM, CPU and network readings for remote Linux
// servers in the top bar, collected over ssh.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ServerCollector, Status} from './collector.js';
import * as Common from './common.js';

const ELLIPSIS = '\u2026';

// Readings that can appear in the bar, in display order.
// [settings key, icon, sample -> text]
const PANEL_READINGS = [
    ['show-ram-used', 'memory', s => Common.formatBytes(s.memUsed)],
    ['show-ram-percent', 'memory', s => Common.formatPercent(s.memPercent)],
    ['show-cpu', 'cpu', s => Common.formatPercent(s.cpuPercent)],
    ['show-net-speed', 'net-up', s => Common.formatRate(s.txRate)],
    ['show-net-speed', 'net-down', s => Common.formatRate(s.rxRate)],
    ['show-net-total', 'total-up', s => Common.formatBytes(s.txTotal)],
    ['show-net-total', 'total-down', s => Common.formatBytes(s.rxTotal)],
];

/** One "small icon + value" pair, the same layout Vitals uses. */
function makePair(gicon, inMenu = false) {
    const box = new St.BoxLayout({
        style_class: 'server-vitals-item',
        y_align: Clutter.ActorAlign.CENTER,
    });
    const icon = new St.Icon({
        gicon,
        style_class: `${inMenu ? 'popup-menu-icon' : 'system-status-icon'} server-vitals-icon`,
    });
    const label = new St.Label({
        text: ELLIPSIS,
        style_class: 'server-vitals-label',
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    label.clutter_text.ellipsize = 0;
    box.add_child(icon);
    box.add_child(label);
    return {box, icon, label};
}

/** Menu entry for one server: name, status and all of its readings. */
const ServerMenuItem = GObject.registerClass(
class ServerMenuItem extends PopupMenu.PopupBaseMenuItem {
    constructor(server, icons) {
        super();
        this.serverId = server.id;

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'server-vitals-row',
            x_expand: true,
        });
        this.add_child(column);

        const header = new St.BoxLayout({style_class: 'server-vitals-row-header', x_expand: true});
        header.add_child(new St.Label({
            text: Common.serverTitle(server),
            style_class: 'server-vitals-row-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (server.name) {
            header.add_child(new St.Label({
                text: Common.serverAddress(server),
                style_class: 'server-vitals-dim',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        this._status = new St.Label({
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._status);
        column.add_child(header);

        this._lineMain = new St.BoxLayout({style_class: 'server-vitals-row-line'});
        this._ram = makePair(icons['memory'], true);
        this._cpu = makePair(icons['cpu'], true);
        this._disk = makePair(icons['disk'], true);
        for (const pair of [this._ram, this._cpu, this._disk])
            this._lineMain.add_child(pair.box);
        column.add_child(this._lineMain);

        this._lineNet = new St.BoxLayout({style_class: 'server-vitals-row-line'});
        this._up = makePair(icons['net-up'], true);
        this._down = makePair(icons['net-down'], true);
        this._totalUp = makePair(icons['total-up'], true);
        this._totalDown = makePair(icons['total-down'], true);
        for (const pair of [this._up, this._down, this._totalUp, this._totalDown])
            this._lineNet.add_child(pair.box);
        column.add_child(this._lineNet);

        this._extra = new St.Label({style_class: 'server-vitals-row-extra'});
        column.add_child(this._extra);

        this._error = new St.Label({style_class: 'server-vitals-row-error'});
        this._error.clutter_text.line_wrap = true;
        column.add_child(this._error);
    }

    setPinned(pinned) {
        this.setOrnament(pinned ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    update(collector) {
        const {status, sample, error} = collector;
        const online = status === Status.ONLINE && sample !== null;

        this._status.text = status;
        this._status.style_class = `server-vitals-status-${status}`;
        this._lineMain.visible = online;
        this._lineNet.visible = online;
        this._extra.visible = online;
        this._error.visible = status === Status.OFFLINE;

        if (status === Status.OFFLINE)
            this._error.text = error ?? 'unreachable';
        if (!online)
            return;

        this._ram.label.text =
            `${Common.formatBytes(sample.memUsed)} / ${Common.formatBytes(sample.memTotal)} (${Common.formatPercent(sample.memPercent)})`;
        this._cpu.label.text = Common.formatPercent(sample.cpuPercent);
        this._disk.label.text = sample.diskTotal === null ? 'n/a'
            : `${Common.formatBytes(sample.diskUsed)} / ${Common.formatBytes(sample.diskTotal)} (${Common.formatPercent(sample.diskPercent)})`;
        this._up.label.text = Common.formatRate(sample.txRate);
        this._down.label.text = Common.formatRate(sample.rxRate);
        this._totalUp.label.text = Common.formatBytes(sample.txTotal);
        this._totalDown.label.text = Common.formatBytes(sample.rxTotal);
        this._extra.text =
            `Load ${sample.load.map(l => l.toFixed(2)).join(' ')} (${sample.cpuCount} CPU)   Uptime ${Common.formatUptime(sample.uptime)}`;
    }
});

const ServerVitalsIndicator = GObject.registerClass(
class ServerVitalsIndicator extends PanelMenu.Button {
    constructor(extension) {
        super(0.0, 'Server Vitals');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._servers = [];
        this._collectors = new Map();   // server id -> ServerCollector
        this._items = new Map();        // server id -> ServerMenuItem
        this._panelPairs = [];          // [{pair, format}]

        this._icons = {};
        for (const name of ['memory', 'cpu', 'net-up', 'net-down', 'total-up', 'total-down', 'server', 'disk']) {
            this._icons[name] = new Gio.FileIcon({
                file: extension.dir.get_child('icons').get_child(`sv-${name}-symbolic.svg`),
            });
        }

        this._box = new St.BoxLayout({
            style_class: 'server-vitals-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._settings.connectObject(
            'changed::servers', () => this._syncServers(),
            'changed::pinned', () => this._onPinnedChanged(),
            'changed::refresh-interval', () => this._onIntervalChanged(),
            this);
        for (const key of ['show-name', ...new Set(PANEL_READINGS.map(r => r[0]))])
            this._settings.connectObject(`changed::${key}`, () => this._rebuildPanel(), this);

        this._syncServers();
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const collector of this._collectors.values())
            collector.destroy();
        this._collectors.clear();
        this._items.clear();
        this._panelPairs = [];
        this._settings = null;
        this._extension = null;
        super.destroy();
    }

    /** The server shown in the bar: the pinned one, else the first. */
    _pinnedServer() {
        const id = this._settings.get_string('pinned');
        return this._servers.find(s => s.id === id) ?? this._servers[0] ?? null;
    }

    _syncServers() {
        const servers = Common.parseServers(this._settings.get_string('servers'));
        const interval = this._settings.get_int('refresh-interval');

        // Stop collectors whose server was removed or now points elsewhere.
        for (const [id, collector] of this._collectors) {
            const now = servers.find(s => s.id === id);
            if (!now || !Common.sameTarget(now, collector.server)) {
                collector.destroy();
                this._collectors.delete(id);
            } else {
                collector.server = now;   // picks up a changed display name
            }
        }

        this._servers = servers;
        for (const server of servers) {
            if (this._collectors.has(server.id))
                continue;
            const collector = new ServerCollector(server, interval, c => this._onCollectorChanged(c));
            this._collectors.set(server.id, collector);
            collector.start();
        }

        this._rebuildMenu();
        this._rebuildPanel();
    }

    _onIntervalChanged() {
        const interval = this._settings.get_int('refresh-interval');
        for (const collector of this._collectors.values())
            collector.setInterval(interval);
    }

    _onPinnedChanged() {
        const pinned = this._pinnedServer();
        for (const [id, item] of this._items)
            item.setPinned(pinned?.id === id);
        this._rebuildPanel();
    }

    _onCollectorChanged(collector) {
        if (this._collectors.get(collector.server.id) !== collector)
            return;
        this._items.get(collector.server.id)?.update(collector);
        if (this._pinnedServer()?.id === collector.server.id)
            this._updatePanel();
    }

    _rebuildMenu() {
        this.menu.removeAll();
        this._items.clear();

        const pinned = this._pinnedServer();
        for (const server of this._servers) {
            const item = new ServerMenuItem(server, this._icons);
            item.setPinned(pinned?.id === server.id);
            item.update(this._collectors.get(server.id));
            item.connect('activate', () => this._settings.set_string('pinned', server.id));
            this.menu.addMenuItem(item);
            this._items.set(server.id, item);
        }

        if (this._servers.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No servers yet. Add one in Settings.', {reactive: false}));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        if (this._servers.length > 0) {
            const reconnect = new PopupMenu.PopupMenuItem('Reconnect all');
            reconnect.connect('activate', () => {
                for (const collector of this._collectors.values())
                    collector.restart();
            });
            this.menu.addMenuItem(reconnect);
        }

        const settings = new PopupMenu.PopupMenuItem('Settings');
        settings.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(settings);
    }

    /** Recreate the widgets in the bar (after a toggle or pin change). */
    _rebuildPanel() {
        this._box.destroy_all_children();
        this._panelPairs = [];

        const server = this._pinnedServer();
        const showName = !server || this._settings.get_boolean('show-name');
        const wanted = server
            ? PANEL_READINGS.filter(([key]) => this._settings.get_boolean(key))
            : [];

        // Always keep something clickable in the bar.
        this._namePair = null;
        if (showName || wanted.length === 0) {
            this._namePair = makePair(this._icons['server']);
            this._namePair.label.text = server ? Common.serverTitle(server) : 'No servers';
            this._namePair.icon.visible = wanted.length === 0 || !server;
            this._box.add_child(this._namePair.box);
        }

        this._statusLabel = new St.Label({
            style_class: 'server-vitals-label server-vitals-dim',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._statusLabel);

        for (const [, iconName, format] of wanted) {
            const pair = makePair(this._icons[iconName]);
            this._box.add_child(pair.box);
            this._panelPairs.push({pair, format});
        }

        this._updatePanel();
    }

    _updatePanel() {
        const server = this._pinnedServer();
        const collector = server ? this._collectors.get(server.id) : null;
        if (!collector) {
            this._statusLabel.visible = false;
            return;
        }

        const online = collector.status === Status.ONLINE && collector.sample !== null;
        for (const {pair, format} of this._panelPairs) {
            pair.box.visible = online;
            if (online)
                pair.label.text = format(collector.sample);
        }

        // Offline or still connecting: say so instead of showing numbers.
        this._statusLabel.visible = !online;
        if (!online) {
            this._statusLabel.text = collector.status === Status.OFFLINE
                ? `offline: ${collector.error ?? 'unreachable'}`
                : `connecting${ELLIPSIS}`;
        }
        if (this._namePair && this._panelPairs.length > 0)
            this._namePair.icon.visible = !online;
    }
});

export default class ServerVitalsExtension extends Extension {
    enable() {
        this._indicator = new ServerVitalsIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
