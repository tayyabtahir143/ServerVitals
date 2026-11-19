import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Common from './common.js';

export default class ServerVitalsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Server Vitals',
            icon_name: 'network-server-symbolic',
        });
        window.add(page);

        const serversGroup = new Adw.PreferencesGroup({
            title: 'Servers',
            description: 'Readings are collected over SSH with your existing keys and ~/.ssh/config. ' +
                'Key login must already work: run "ssh-copy-id user@host" in a terminal first.',
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Add server'}),
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._editServer(window, settings, null));
        const importButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'document-open-symbolic', label: 'Import'}),
            tooltip_text: 'Import hosts from ~/.ssh/config and known_hosts',
            css_classes: ['flat'],
            valign: Gtk.Align.CENTER,
        });
        importButton.connect('clicked', () => this._importServers(window, settings));
        const headerButtons = new Gtk.Box({spacing: 6});
        headerButtons.append(importButton);
        headerButtons.append(addButton);
        serversGroup.set_header_suffix(headerButtons);
        page.add(serversGroup);

        let rows = [];
        const rebuild = () => {
            for (const row of rows)
                serversGroup.remove(row);
            rows = [];

            const servers = Common.parseServers(settings.get_string('servers'));
            if (servers.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No servers yet',
                    subtitle: 'Use "Add server" to monitor your first one.',
                });
                serversGroup.add(empty);
                rows.push(empty);
            }
            for (const server of servers) {
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(Common.serverTitle(server), -1),
                    subtitle: GLib.markup_escape_text(Common.serverAddress(server), -1),
                });
                const edit = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    tooltip_text: 'Edit',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                });
                edit.connect('clicked', () => this._editServer(window, settings, server));
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: 'Remove',
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                });
                remove.connect('clicked', () => {
                    const left = Common.parseServers(settings.get_string('servers'))
                        .filter(s => s.id !== server.id);
                    settings.set_string('servers', JSON.stringify(left));
                });
                row.add_suffix(edit);
                row.add_suffix(remove);
                serversGroup.add(row);
                rows.push(row);
            }
        };
        const changedId = settings.connect('changed::servers', rebuild);
        window.connect('close-request', () => {
            settings.disconnect(changedId);
            return false;
        });
        rebuild();

        const refreshGroup = new Adw.PreferencesGroup({title: 'Refresh'});
        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between readings',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 300, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        refreshGroup.add(intervalRow);
        page.add(refreshGroup);

        const barGroup = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Click a reading in the menu to show or hide it in the top bar.',
        });
        const nameRow = new Adw.SwitchRow({title: 'Server name'});
        settings.bind('show-name', nameRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        barGroup.add(nameRow);
        page.add(barGroup);
    }

    _expandInclude(directory, pattern) {
        let path = pattern.startsWith('~/') ? GLib.get_home_dir() + pattern.slice(1) : pattern;
        if (!path.startsWith('/'))
            path = GLib.build_filenamev([directory, path]);
        if (!/[*?[]/.test(path))
            return [path];
        const parent = GLib.path_get_dirname(path);
        const base = GLib.path_get_basename(path);
        if (/[*?[]/.test(parent))
            return [];
        const names = [];
        try {
            const children = Gio.File.new_for_path(parent).enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info = children.next_file(null); info; info = children.next_file(null)) {
                if (GLib.pattern_match_simple(base, info.get_name()))
                    names.push(info.get_name());
            }
            children.close(null);
        } catch {
            return [];
        }
        return names.sort().map(name => GLib.build_filenamev([parent, name]));
    }

    _sshHosts() {
        const directory = GLib.build_filenamev([GLib.get_home_dir(), '.ssh']);
        const files = new Set();
        const found = new Map();
        const read = (path, depth) => {
            if (depth > 3 || files.has(path) || files.size >= 64)
                return;
            files.add(path);
            let text;
            try {
                const [, bytes] = GLib.file_get_contents(path);
                text = new TextDecoder().decode(bytes);
            } catch {
                return;
            }
            const {hosts, includes} = Common.parseSshConfig(text);
            for (const host of hosts) {
                if (!found.has(host.alias))
                    found.set(host.alias, host);
            }
            for (const pattern of includes) {
                for (const file of this._expandInclude(directory, pattern))
                    read(file, depth + 1);
            }
        };
        read(GLib.build_filenamev([directory, 'config']), 0);
        return [...found.values()];
    }

    _knownHosts() {
        const path = GLib.build_filenamev([GLib.get_home_dir(), '.ssh', 'known_hosts']);
        try {
            const [, bytes] = GLib.file_get_contents(path);
            return Common.parseKnownHosts(new TextDecoder().decode(bytes));
        } catch {
            return {hosts: [], hashed: 0};
        }
    }

    _importServers(window, settings) {
        const current = Common.parseServers(settings.get_string('servers'));
        const taken = new Set(current.map(s => s.host));
        const configured = this._sshHosts();
        const known = this._knownHosts();
        for (const host of configured) {
            taken.add(host.alias);
            if (host.hostName)
                taken.add(host.hostName);
        }

        const candidates = [];
        for (const host of configured) {
            if (current.some(s => s.host === host.alias))
                continue;
            candidates.push({
                source: 'config',
                title: host.alias,
                subtitle: `${host.user ? `${host.user}@` : ''}${host.hostName || host.alias}`,
                active: !Common.isGitHost(host),
                server: {host: host.alias, port: 0},
            });
        }
        for (const entry of known.hosts) {
            if (taken.has(entry.host))
                continue;
            candidates.push({
                source: 'known',
                title: entry.host,
                subtitle: entry.port ? `Port ${entry.port}` : '',
                active: false,
                server: entry,
            });
        }

        const dialog = new Adw.Dialog({title: 'Import hosts', content_width: 480});
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 12, margin_bottom: 18, margin_start: 18, margin_end: 18,
        });
        const search = new Gtk.SearchEntry({placeholder_text: 'Search hosts', hexpand: true});
        const selectShown = new Gtk.Button({label: 'Select shown'});
        const clearShown = new Gtk.Button({label: 'Clear shown'});
        const tools = new Gtk.Box({spacing: 6});
        if (candidates.length > 8)
            tools.append(search);
        tools.append(selectShown);
        tools.append(clearShown);
        if (candidates.length > 1)
            content.append(tools);

        const addGroup = (source, title, description) => {
            const items = candidates.filter(item => item.source === source);
            if (!items.length)
                return;
            const group = new Adw.PreferencesGroup({title, description});
            for (const item of items) {
                item.row = new Adw.SwitchRow({
                    title: GLib.markup_escape_text(item.title, -1),
                    subtitle: GLib.markup_escape_text(item.subtitle, -1),
                    active: item.active,
                });
                group.add(item.row);
            }
            content.append(group);
        };
        addGroup('config', 'SSH config',
            'Entries from ~/.ssh/config, added by alias so the user, port and key come from the entry. ' +
            'Git hosting services are switched off because they do not allow a shell.');
        addGroup('known', 'Known hosts',
            'Machines you have connected to before, from ~/.ssh/known_hosts. That file records no user ' +
            'or key, so these connect with your SSH defaults. All are off until you choose.' +
            (known.hashed ? ` ${known.hashed} hashed entries cannot be read.` : ''));
        if (!candidates.length) {
            content.append(new Adw.PreferencesGroup({
                description: 'No new hosts found in ~/.ssh/config or ~/.ssh/known_hosts. ' +
                    'Wildcard entries and hosts already added are skipped.' +
                    (known.hashed ? ` ${known.hashed} hashed known_hosts entries cannot be read.` : ''),
            }));
        }

        search.connect('search-changed', () => {
            const query = search.text.trim().toLowerCase();
            for (const item of candidates)
                item.row.visible = `${item.title} ${item.subtitle}`.toLowerCase().includes(query);
        });

        const setShown = active => {
            for (const item of candidates) {
                if (item.row.visible)
                    item.row.active = active;
            }
        };
        selectShown.connect('clicked', () => setShown(true));
        clearShown.connect('clicked', () => setShown(false));

        const cancel = new Gtk.Button({label: candidates.length ? 'Cancel' : 'Close'});
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancel);
        cancel.connect('clicked', () => dialog.close());
        if (candidates.length) {
            const confirm = new Gtk.Button({label: 'Import', css_classes: ['suggested-action']});
            header.pack_end(confirm);
            const count = () => {
                const chosen = candidates.filter(item => item.row.active).length;
                confirm.label = `Import ${chosen}`;
                confirm.sensitive = chosen > 0;
            };
            for (const item of candidates)
                item.row.connect('notify::active', count);
            count();
            confirm.connect('clicked', () => {
                const servers = Common.parseServers(settings.get_string('servers'));
                for (const {row, server} of candidates) {
                    if (row.active && !servers.some(s => s.host === server.host && s.port === server.port))
                        servers.push({id: GLib.uuid_string_random(), name: '', user: '', ...server});
                }
                settings.set_string('servers', JSON.stringify(servers));
                dialog.close();
            });
        }

        const scroll = new Gtk.ScrolledWindow({
            child: content,
            propagate_natural_height: true,
            max_content_height: 560,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        const view = new Adw.ToolbarView({content: scroll});
        view.add_top_bar(header);
        dialog.set_child(view);
        dialog.present(window);
        if (candidates.length > 8)
            search.grab_focus();
    }

    _editServer(window, settings, server) {
        const dialog = new Adw.Dialog({
            title: server ? 'Edit server' : 'Add server',
            content_width: 440,
        });

        const hostRow = new Adw.EntryRow({title: 'Host name or IP address'});
        const userRow = new Adw.EntryRow({title: 'User (optional)'});
        const portRow = new Adw.EntryRow({
            title: 'Port (optional)',
            input_purpose: Gtk.InputPurpose.DIGITS,
        });
        const nameRow = new Adw.EntryRow({title: 'Display name (optional)'});
        if (server) {
            hostRow.text = server.host;
            userRow.text = server.user;
            portRow.text = server.port ? String(server.port) : '';
            nameRow.text = server.name;
        }

        const mount = new Adw.EntryRow({title: 'Mount point', text: server?.mount || '/'});
        const maintenance = new Adw.SwitchRow({title: 'Maintenance mute', active: !!server?.maintenance});
        const iface = server?.networkInterface;
        const label = new Adw.EntryRow({title: `Label for ${iface || 'interface'}`,
            text: iface && Object.hasOwn(server.labels ?? {}, iface) ? server.labels[iface] : ''});
        const favorite = new Adw.SwitchRow({title: 'Favorite interface', active: !!server?.favorites?.includes(iface)});
        const group = new Adw.PreferencesGroup({
            description: 'Leave user and port empty to use ~/.ssh/config or the SSH defaults. ' +
                'You can also type user@host:port in the first field.',
        });
        for (const row of [hostRow, userRow, portRow, nameRow])
            group.add(row);
        group.add(mount);
        group.add(maintenance);
        if (iface) {
            group.add(label);
            group.add(favorite);
        }

        const errorLabel = new Gtk.Label({
            css_classes: ['error'],
            wrap: true,
            xalign: 0,
            visible: false,
        });

        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: server ? 'Save' : 'Add', css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
        header.pack_start(cancel);
        header.pack_end(save);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12, margin_bottom: 18, margin_start: 18, margin_end: 18,
        });
        content.append(group);
        content.append(errorLabel);

        const scroll = new Gtk.ScrolledWindow({child: content, propagate_natural_height: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER});
        const view = new Adw.ToolbarView({content: scroll});
        view.add_top_bar(header);
        dialog.set_child(view);

        const fail = (row, message) => {
            row.add_css_class('error');
            errorLabel.label = message;
            errorLabel.visible = true;
            row.grab_focus();
        };

        const apply = () => {
            for (const row of [hostRow, userRow, portRow, nameRow])
                row.remove_css_class('error');
            errorLabel.visible = false;

            const parsed = Common.parseAddress(hostRow.text);
            const host = parsed.host;
            const user = userRow.text.trim() || parsed.user;
            const portText = portRow.text.trim();
            let port = parsed.port;
            if (portText !== '') {
                if (!/^\d{1,5}$/.test(portText))
                    return fail(portRow, 'Port must be a number between 1 and 65535');
                port = parseInt(portText, 10);
            }

            let error = Common.validateHost(host);
            if (error)
                return fail(hostRow, error);
            error = Common.validateUser(user);
            if (error)
                return fail(userRow, error);
            error = Common.validatePort(port);
            if (error)
                return fail(portRow, error);

            if (!Common.validMount(mount.text))
                return fail(mount, 'Enter an absolute path using letters, digits, spaces, / . _ or -');
            const {server: clean, error: other} = Common.normalizeServer({
                id: server?.id ?? GLib.uuid_string_random(),
                name: nameRow.text,
                host, user, port, mount: mount.text,
            });
            if (!clean)
                return fail(hostRow, other);

            const servers = Common.parseServers(settings.get_string('servers'));
            const index = servers.findIndex(s => s.id === clean.id);
            const updated = {...servers[index], ...clean, maintenance: maintenance.active};
            if (iface) {
                updated.labels = {...updated.labels, [iface]: label.text.trim().slice(0, 40)};
                updated.favorites = (updated.favorites ?? []).filter(n => n !== iface);
                if (favorite.active)
                    updated.favorites.unshift(iface);
            }
            if (index >= 0)
                servers[index] = updated;
            else if (!server)
                servers.push(updated);
            settings.set_string('servers', JSON.stringify(servers));
            dialog.close();
            return undefined;
        };

        cancel.connect('clicked', () => dialog.close());
        save.connect('clicked', apply);
        for (const row of [hostRow, userRow, portRow, nameRow]) {
            row.connect('entry-activated', apply);

            row.connect('changed', () => {
                row.remove_css_class('error');
                errorLabel.visible = false;
            });
        }

        dialog.present(window);
        hostRow.grab_focus();
    }
}
