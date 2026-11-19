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
const NO_DATA = 'No Data';
const PAGE_SIZE = 5;

const bytes = Common.formatBytes;
const rate = Common.formatRate;
const percent = Common.formatPercent;
const load = value => Number.isFinite(value) ? value.toFixed(2) : ELLIPSIS;

const GROUPS = [
    {
        id: 'memory', title: 'Memory', icon: 'memory', summary: 'usage', sensors: [
            ['usage', 'Usage', s => percent(s.memPercent)],
            ['physical', 'Physical', s => bytes(s.memTotal)],
            ['allocated', 'Allocated', s => bytes(s.memUsed)],
            ['available', 'Available', s => bytes(s.memAvailable)],
            ['free', 'Free', s => bytes(s.memFree)],
            ['cached', 'Cached', s => bytes(s.memCached)],
            ['swap', 'Swap used', s => s.swapTotal === 0 ? 'None' : bytes(s.swapUsed)],
        ],
    },
    {
        id: 'processor', title: 'Processor', icon: 'cpu', summary: 'usage', sensors: [
            ['usage', 'Usage', s => percent(s.cpuPercent)],
            ['cores', 'Cores', s => String(s.cpuCount)],
        ],
    },
    {
        id: 'system', title: 'System', icon: 'system', summary: 'uptime', sensors: [
            ['uptime', 'Uptime', s => Common.formatUptime(s.uptime)],
            ['load1', 'Load 1m', s => load(s.load[0])],
            ['load5', 'Load 5m', s => load(s.load[1])],
            ['load15', 'Load 15m', s => load(s.load[2])],
        ],
    },
    {
        id: 'network', title: 'Network', icon: 'net-down', summary: 'rx', sensors: [
            ['rx', 'Download', s => rate(s.rxRate), 'net-down'],
            ['tx', 'Upload', s => rate(s.txRate), 'net-up'],
            ['rx-total', 'Total download', s => bytes(s.rxTotal), 'total-down'],
            ['tx-total', 'Total upload', s => bytes(s.txTotal), 'total-up'],
        ],
        details: [
            ['rx-history', 'Download, 15 min', (s, c) => c.history.graph('rxRate'), 'net-down'],
            ['tx-history', 'Upload, 15 min', (s, c) => c.history.graph('txRate'), 'net-up'],
        ],
    },
    {
        id: 'storage', title: 'Storage', icon: 'disk', summary: 'usage', sensors: [
            ['usage', 'Usage', s => percent(s.diskPercent)],
            ['total', 'Total', s => bytes(s.diskTotal)],
            ['used', 'Used', s => bytes(s.diskUsed)],
            ['free', 'Free', s => bytes(s.diskFree)],
            ['runway', 'Time left', (s, c) => Common.formatUptime(c.history.runway())],
        ],
        details: [
            ['mount', 'Mount', (s, c) => c.server.mount || '/'],
        ],
    },
];

const DYNAMIC = /^(disk|temp|gpu):/;
const degrees = value => value === null ? ELLIPSIS : `${value.toFixed(1)} \u00b0C`;
const diskText = disk => `${bytes(disk.used)} / ${bytes(disk.total)} (${percent(disk.percent)})`;

const isContainer = name => /^(veth|docker|cni|flannel|br-[0-9a-f]{12}$)/i.test(name);

const Row = GObject.registerClass(
class Row extends PopupMenu.PopupBaseMenuItem {
    constructor(gicon, title, onActivate = null) {
        super({reactive: !!onActivate, can_focus: !!onActivate});
        this._onActivate = onActivate;
        this.add_child(new St.Icon({style_class: 'popup-menu-icon', gicon}));
        this.add_child(new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER}));
        this.value = new St.Label({
            text: ELLIPSIS,
            style_class: 'server-vitals-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.value);
    }

    setChecked(checked) {
        this.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    }

    activate() {
        this._onActivate?.();
    }
});

class InterfacePicker {
    constructor(item, status, onSelect) {
        this.item = item;
        this.status = status;
        this._onSelect = onSelect;
        this._names = [];
        this._favorites = [];
        this._labels = {};
        this._page = 0;
        this._expanded = false;

        const field = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this.search = new St.Entry({
            hint_text: 'Search interfaces',
            accessible_name: 'Search interfaces',
            can_focus: true,
            x_expand: true,
        });
        field.add_child(this.search);
        this.containers = this._button(field, 'Containers', () => {
            this._expanded = !this._expanded;
            this._page = 0;
        });
        this.previous = this._button(field, 'Previous', () => this._page--);
        this.next = this._button(field, 'Next', () => this._page++);
        item.menu.addMenuItem(field);
        this.results = new PopupMenu.PopupMenuSection();
        item.menu.addMenuItem(this.results);

        this.search.clutter_text.connect('text-changed', () => {
            this._page = 0;
            this._filter();
        });
        item.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this.search.grab_key_focus();
            else
                this.search.set_text('');
        });
    }

    _button(parent, label, action) {
        const button = new St.Button({label, can_focus: true, style_class: 'button'});
        button.connect('clicked', () => {
            action();
            this._filter();
            this.search.grab_key_focus();
        });
        parent.add_child(button);
        return button;
    }

    reset() {
        this._page = 0;
        this._expanded = false;
        this._key = null;
        this.search.set_text('');
    }

    update(collector) {
        const online = collector?.status === Status.ONLINE && collector.sample !== null;
        const selected = collector?.server.networkInterface;
        const names = collector?.sample?.interfaceNames ?? [];
        if (selected)
            this.status.text = names.includes(selected) || !online ? selected : `${selected} (unavailable)`;
        else if (online)
            this.status.text = names.length ? 'Select interface' : 'No interfaces';
        else
            this.status.text = NO_DATA;
        this.item.setSensitive(names.length > 0);
        this._labels = collector?.server.labels ?? {};
        this._favorites = collector?.server.favorites ?? [];
        const key = JSON.stringify([selected, names, this._labels, this._favorites]);
        if (key === this._key)
            return;
        this._key = key;
        this._names = names;
        this._selected = selected;
        this._filter();
    }

    _filter() {
        const query = this.search.get_text().toLowerCase();
        const starred = name => this._favorites.includes(name);
        const label = name => Object.hasOwn(this._labels, name) ? this._labels[name] : '';
        this.containers.visible = !query && this._names.some(isContainer);
        this.containers.label = this._expanded ? 'Hide containers' : 'Containers';
        const matches = this._names.filter(name => query
            ? [name, label(name)].some(text => text.toLowerCase().includes(query))
            : this._expanded || !isContainer(name) || starred(name) || name === this._selected)
            .sort((a, b) => Number(starred(b)) - Number(starred(a)));
        this._page = Math.max(0, Math.min(this._page, Math.ceil(matches.length / PAGE_SIZE) - 1));
        const start = this._page * PAGE_SIZE;
        const visible = matches.slice(start, start + PAGE_SIZE);
        this.previous.visible = start > 0;
        this.next.visible = start + PAGE_SIZE < matches.length;
        let note = '';
        if (matches.length > PAGE_SIZE)
            note = `${start + 1}\u2013${start + visible.length} of ${matches.length}`;
        else if (!matches.length)
            note = 'No matches';
        const key = JSON.stringify([visible.map(n => [n, label(n), starred(n)]), note, this._selected]);
        if (key === this._resultKey)
            return;
        this._resultKey = key;
        this.results.removeAll();
        for (const name of visible) {
            const text = `${starred(name) ? '\u2605 ' : ''}${name}${label(name) ? ` \u2014 ${label(name)}` : ''}`;
            const option = this.results.addAction(text, () => this._onSelect(name));
            option.setOrnament(name === this._selected ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        if (note)
            this.results.addMenuItem(new PopupMenu.PopupMenuItem(note, {reactive: false}));
    }
}

const ServerVitalsIndicator = GObject.registerClass(
class ServerVitalsIndicator extends PanelMenu.Button {
    constructor(extension) {
        super(0.0, 'Server Vitals');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._servers = [];
        this._collectors = new Map();
        this._serverRows = new Map();
        this._groups = new Map();
        this._rows = new Map();
        this._dynamic = new Map();
        this._dynamicValues = new Map();
        this._panelPairs = [];

        this._icons = {};
        for (const name of ['memory', 'cpu', 'net-up', 'net-down', 'total-up', 'total-down', 'server', 'disk', 'temperature', 'gpu']) {
            this._icons[name] = new Gio.FileIcon({
                file: extension.dir.get_child('icons').get_child(`sv-${name}-symbolic.svg`),
            });
        }
        this._icons['system'] = new Gio.ThemedIcon({name: 'utilities-system-monitor-symbolic'});
        this._icons['interface'] = new Gio.ThemedIcon({name: 'network-wired-symbolic'});

        this._box = new St.BoxLayout({
            style_class: 'server-vitals-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._buildMenu();

        this._settings.connectObject(
            'changed::servers', () => this._syncServers(),
            'changed::pinned', () => this._onPinnedChanged(),
            'changed::refresh-interval', () => this._onIntervalChanged(),
            'changed::hot-sensors', () => this._onHotChanged(),
            'changed::show-name', () => this._rebuildPanel(),
            this);

        this._syncServers();
    }

    destroy() {
        this._settings.disconnectObject(this);
        for (const collector of this._collectors.values())
            collector.destroy();
        this._collectors.clear();
        this._serverRows.clear();
        this._groups.clear();
        this._rows.clear();
        this._dynamic.clear();
        this._dynamicValues.clear();
        this._panelPairs = [];
        this._picker = null;
        this._settings = null;
        this._extension = null;
        super.destroy();
    }

    _makeGroup(title, gicon) {
        const item = new PopupMenu.PopupSubMenuMenuItem(title, true);
        item.icon.gicon = gicon;
        const status = new St.Label({
            text: NO_DATA,
            style_class: 'server-vitals-label',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.insert_child_at_index(status, 4);
        this.menu.addMenuItem(item);
        return {item, status};
    }

    _buildMenu() {
        this._serverGroup = this._makeGroup('Server', this._icons['server']);
        const dynamicGroup = (kind, title) => {
            const group = this._makeGroup(title, this._icons[kind]);
            group.item.visible = false;
            this._dynamic.set(kind, {section: group.item.menu, rows: new Map(), gicon: this._icons[kind], group});
        };
        dynamicGroup('temperature', 'Temperature');

        for (const group of GROUPS) {
            const entry = this._makeGroup(group.title, this._icons[group.icon]);
            entry.summary = `${group.id}-${group.summary}`;
            this._groups.set(group.id, entry);
            const add = ([id, title, format, icon], hot) => {
                const key = `${group.id}-${id}`;
                const gicon = this._icons[icon ?? group.icon];
                const row = new Row(gicon, title, hot ? () => this._toggleHot(key) : null);
                entry.item.menu.addMenuItem(row);
                this._rows.set(key, {row, format, gicon, hot});
            };
            for (const sensor of group.sensors)
                add(sensor, true);
            for (const detail of group.details ?? [])
                add(detail, false);
            if (group.id === 'storage') {
                const section = new PopupMenu.PopupMenuSection();
                entry.item.menu.addMenuItem(section);
                this._dynamic.set('disk', {section, rows: new Map(), gicon: this._icons['disk']});
            }
            if (group.id === 'network') {
                const picker = this._makeGroup('Interface', this._icons['interface']);
                this._picker = new InterfacePicker(picker.item, picker.status, name => {
                    const server = this._pinnedServer();
                    if (server)
                        this._saveInterface(server, name);
                });
            }
        }

        dynamicGroup('gpu', 'Graphics');

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const actions = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({
            style_class: 'server-vitals-button-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        actions.add_child(box);
        const round = (iconName, name, action) => {
            const button = new St.Button({
                style_class: 'button server-vitals-button-action',
                accessible_name: name,
                can_focus: true,
                child: new St.Icon({icon_name: iconName}),
            });
            button.connect('clicked', action);
            box.add_child(button);
            return button;
        };
        this._refreshButton = round('view-refresh-symbolic', 'Reconnect all', () => {
            for (const collector of this._collectors.values())
                collector.restart();
        });
        this._prefsButton = round('preferences-system-symbolic', 'Preferences', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(actions);
    }

    _hot() {
        return this._settings.get_strv('hot-sensors').filter(key =>
            this._rows.get(key)?.hot || DYNAMIC.test(key));
    }

    _toggleHot(key) {
        const hot = this._hot();
        const next = hot.includes(key) ? hot.filter(k => k !== key) : [...hot, key];
        this._settings.set_strv('hot-sensors', next);
    }

    _onHotChanged() {
        const hot = this._hot();
        for (const [key, {row, hot: toggles}] of this._rows) {
            if (toggles)
                row.setChecked(hot.includes(key));
        }
        for (const {rows} of this._dynamic.values()) {
            for (const [key, row] of rows)
                row.setChecked(hot.includes(key));
        }
        this._rebuildPanel();
    }

    _pinnedServer() {
        const id = this._settings.get_string('pinned');
        return this._servers.find(s => s.id === id) ?? this._servers[0] ?? null;
    }

    _pinnedCollector() {
        const server = this._pinnedServer();
        return server ? this._collectors.get(server.id) ?? null : null;
    }

    _syncServers() {
        const servers = Common.parseServers(this._settings.get_string('servers'));
        const interval = this._settings.get_int('refresh-interval');

        for (const [id, collector] of this._collectors) {
            const now = servers.find(s => s.id === id);
            if (!now || !Common.sameTarget(now, collector.server) || now.mount !== collector.server.mount) {
                collector.destroy();
                this._collectors.delete(id);
            } else {
                collector.updateServer(now);
            }
        }

        this._servers = servers;
        for (const server of servers) {
            if (this._collectors.has(server.id))
                continue;
            const collector = new ServerCollector(server, interval, c => this._onCollectorChanged(c),
                (label, event) => Main.notify(Common.serverTitle(collector.server), `${label}: ${event}`));
            this._collectors.set(server.id, collector);
            collector.start();
        }

        this._rebuildServers();
        this._onHotChanged();
    }

    _rebuildServers() {
        const menu = this._serverGroup.item.menu;
        menu.removeAll();
        this._serverRows.clear();
        const pinned = this._pinnedServer();
        for (const server of this._servers) {
            const title = server.name ? `${server.name} (${Common.serverAddress(server)})` : Common.serverAddress(server);
            const row = new Row(this._icons['server'], title, () => this._settings.set_string('pinned', server.id));
            row.setChecked(pinned?.id === server.id);
            menu.addMenuItem(row);
            this._serverRows.set(server.id, row);
            this._updateServerRow(this._collectors.get(server.id));
        }
        if (this._servers.length === 0) {
            menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No servers yet. Add one in Preferences.', {reactive: false}));
        }
    }

    _updateServerRow(collector) {
        const row = this._serverRows.get(collector.server.id);
        if (!row)
            return;
        row.value.text = collector.status === Status.OFFLINE
            ? `offline: ${collector.error ?? 'unreachable'}` : collector.status;
        row.value.style_class = `server-vitals-label server-vitals-status-${collector.status}`;
    }

    _onIntervalChanged() {
        const interval = this._settings.get_int('refresh-interval');
        for (const collector of this._collectors.values())
            collector.setInterval(interval);
    }

    _onPinnedChanged() {
        const pinned = this._pinnedServer();
        for (const [id, row] of this._serverRows)
            row.setChecked(pinned?.id === id);
        this._picker.reset();
        this._rebuildPanel();
    }

    _onCollectorChanged(collector) {
        if (this._collectors.get(collector.server.id) !== collector)
            return;
        if (!collector.server.networkInterface && collector.sample?.uplink)
            this._saveInterface(collector.server, collector.sample.uplink, true);
        this._updateServerRow(collector);
        if (this._pinnedServer()?.id === collector.server.id)
            this._updateReadings();
    }

    _saveInterface(server, name, onlyIfUnset = false) {
        const servers = Common.parseServers(this._settings.get_string('servers'));
        const current = servers.find(s => s.id === server.id);
        if (!current || !Common.sameTarget(current, server) || current.networkInterface === name ||
            (onlyIfUnset && current.networkInterface))
            return;
        current.networkInterface = name;
        this._settings.set_string('servers', JSON.stringify(servers));
    }

    _rebuildPanel() {
        this._box.destroy_all_children();
        this._panelPairs = [];

        const server = this._pinnedServer();
        const hot = server ? this._hot() : [];

        this._nameIcon = null;
        if (!server || hot.length === 0 || this._settings.get_boolean('show-name')) {
            this._nameIcon = new St.Icon({
                gicon: this._icons['server'],
                style_class: 'system-status-icon server-vitals-icon',
            });
            const item = new St.BoxLayout({style_class: 'server-vitals-item', y_align: Clutter.ActorAlign.CENTER});
            item.add_child(this._nameIcon);
            item.add_child(new St.Label({
                text: server ? Common.serverTitle(server) : 'No servers',
                style_class: 'server-vitals-label',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            this._box.add_child(item);
        }

        this._statusLabel = new St.Label({
            style_class: 'server-vitals-label server-vitals-dim',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._statusLabel);

        for (const key of hot) {
            const kind = key.match(DYNAMIC)?.[1];
            const {format, gicon} = kind ? {
                gicon: this._icons[kind === 'temp' ? 'temperature' : kind],
                format: () => this._dynamicValues.get(key) ?? ELLIPSIS,
            } : this._rows.get(key);
            const item = new St.BoxLayout({style_class: 'server-vitals-item', y_align: Clutter.ActorAlign.CENTER});
            item.add_child(new St.Icon({gicon, style_class: 'system-status-icon server-vitals-icon'}));
            const label = new St.Label({
                text: ELLIPSIS,
                style_class: 'server-vitals-label',
                y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.ellipsize = 0;
            item.add_child(label);
            this._box.add_child(item);
            this._panelPairs.push({key, item, label, format});
        }

        this._updateReadings();
    }

    _syncDynamic(kind, entries) {
        const {section, rows, gicon, group} = this._dynamic.get(kind);
        if (entries.map(entry => entry.key).join('\n') !== [...rows.keys()].join('\n')) {
            section.removeAll();
            rows.clear();
            const hot = this._hot();
            for (const {key, title} of entries) {
                const row = new Row(gicon, title, () => this._toggleHot(key));
                row.setChecked(hot.includes(key));
                section.addMenuItem(row);
                rows.set(key, row);
            }
        }
        for (const {key, text, panel} of entries) {
            rows.get(key).value.text = text;
            this._dynamicValues.set(key, panel ?? text);
        }
        if (group)
            group.item.visible = entries.length > 0;
    }

    _updateDynamic(collector) {
        const sample = collector?.sample;
        const watched = collector?.server.mount || '/';
        this._dynamicValues.clear();

        this._syncDynamic('disk', (sample?.disks ?? []).filter(disk => disk.mount !== watched).map(disk => ({
            key: `disk:${disk.mount}`,
            title: disk.mount,
            text: diskText(disk),
            panel: `${disk.mount} ${percent(disk.percent)}`,
        })));

        const temps = sample?.temps ?? [];
        this._syncDynamic('temperature', temps.map(temp => ({
            key: `temp:${temp.label}`,
            title: temp.label,
            text: degrees(temp.celsius),
        })));
        if (temps.length)
            this._dynamic.get('temperature').group.status.text = degrees(Math.max(...temps.map(t => t.celsius)));

        const gpus = sample?.gpus ?? [];
        const entries = [];
        gpus.forEach((gpu, index) => {
            const prefix = gpus.length > 1 ? `${gpu.name} ` : '';
            const add = (id, title, value, text) => {
                if (value !== null)
                    entries.push({key: `gpu:${index}:${id}`, title: prefix + title, text});
            };
            add('usage', 'Usage', gpu.usage, percent(gpu.usage));
            add('memory', 'Memory', gpu.memUsed, `${bytes(gpu.memUsed)} / ${bytes(gpu.memTotal)}`);
            add('temperature', 'Temperature', gpu.celsius, degrees(gpu.celsius));
            add('fan', 'Fan', gpu.fan, percent(gpu.fan));
            add('power', 'Power', gpu.power, `${gpu.power?.toFixed(1)} W`);
        });
        this._syncDynamic('gpu', entries);
        if (gpus.length) {
            const {group} = this._dynamic.get('gpu');
            group.item.label.text = gpus.length === 1 ? gpus[0].name : 'Graphics';
            group.status.text = gpus[0].usage === null ? degrees(gpus[0].celsius) : percent(gpus[0].usage);
        }
    }

    _updateReadings() {
        const collector = this._pinnedCollector();
        const sample = collector?.sample ?? null;
        const online = collector?.status === Status.ONLINE && sample !== null;

        for (const {row, format} of this._rows.values())
            row.value.text = online ? format(sample, collector) : ELLIPSIS;
        for (const {status, summary} of this._groups.values())
            status.text = online ? this._rows.get(summary).row.value.text : NO_DATA;

        this._updateDynamic(online ? collector : null);

        const server = collector?.server;
        if (!server)
            this._serverGroup.status.text = 'None';
        else if (online)
            this._serverGroup.status.text = Common.serverTitle(server);
        else
            this._serverGroup.status.text = `${Common.serverTitle(server)}: ${collector.status}`;
        this._picker.update(collector);

        for (const {item, label, format} of this._panelPairs) {
            item.visible = online;
            if (online)
                label.text = format(sample, collector);
        }
        this._statusLabel.visible = !!collector && !online;
        if (collector && !online) {
            this._statusLabel.text = collector.status === Status.OFFLINE
                ? `offline: ${collector.error ?? 'unreachable'}`
                : `connecting${ELLIPSIS}`;
        }
        if (this._nameIcon)
            this._nameIcon.visible = !online || this._panelPairs.length === 0;
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
