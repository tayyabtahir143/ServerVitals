// Preferences window: servers, refresh interval, what appears in the top bar.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as Common from './common.js';

const BAR_TOGGLES = [
    ['show-name', 'Server name', null],
    ['show-ram-percent', 'RAM used (%)', null],
    ['show-ram-used', 'RAM used (amount)', null],
    ['show-cpu', 'CPU usage', null],
    ['show-net-speed', 'Network speed', 'Upload and download right now'],
    ['show-net-total', 'Network totals', 'Uploaded and downloaded since the server booted'],
];

export default class ServerVitalsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({
            title: 'Server Vitals',
            icon_name: 'network-server-symbolic',
        });
        window.add(page);

        // --- Servers ---------------------------------------------------
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
        serversGroup.set_header_suffix(addButton);
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

        // --- Refresh ---------------------------------------------------
        const refreshGroup = new Adw.PreferencesGroup({title: 'Refresh'});
        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between readings',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 300, step_increment: 1, page_increment: 5}),
        });
        settings.bind('refresh-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        refreshGroup.add(intervalRow);
        page.add(refreshGroup);

        // --- Top bar ---------------------------------------------------
        const barGroup = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Readings shown for the pinned server. The menu always shows everything.',
        });
        for (const [key, title, subtitle] of BAR_TOGGLES) {
            const row = new Adw.SwitchRow({title, subtitle: subtitle ?? ''});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            barGroup.add(row);
        }
        page.add(barGroup);
    }

    /** Add (server === null) or edit a server in a small dialog. */
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

        const group = new Adw.PreferencesGroup({
            description: 'Leave user and port empty to use ~/.ssh/config or the SSH defaults. ' +
                'You can also type user@host:port in the first field.',
        });
        for (const row of [hostRow, userRow, portRow, nameRow])
            group.add(row);

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

        const view = new Adw.ToolbarView({content});
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

            // Accept user@host:port typed into the host field.
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

            const {server: clean, error: other} = Common.normalizeServer({
                id: server?.id ?? GLib.uuid_string_random(),
                name: nameRow.text,
                host, user, port,
            });
            if (!clean)
                return fail(hostRow, other);

            const servers = Common.parseServers(settings.get_string('servers'));
            const index = servers.findIndex(s => s.id === clean.id);
            if (index >= 0)
                servers[index] = clean;
            else
                servers.push(clean);
            settings.set_string('servers', JSON.stringify(servers));
            dialog.close();
            return undefined;
        };

        cancel.connect('clicked', () => dialog.close());
        save.connect('clicked', apply);
        for (const row of [hostRow, userRow, portRow, nameRow]) {
            row.connect('entry-activated', apply);
            // Typing again clears the complaint.
            row.connect('changed', () => {
                row.remove_css_class('error');
                errorLabel.visible = false;
            });
        }

        dialog.present(window);
        hostRow.grab_focus();
    }
}
