export default class ProbePrefs extends ServerVitalsPreferences {
    fillPreferencesWindow(window) {
        super.fillPreferencesWindow(window);
        const settings = this.getSettings();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const server = Common.parseServers(settings.get_string('servers'))[0];
            this._editServer(window, settings, server);
            const dialog = window.visible_dialog;
            const walk = function* (widget) {
                yield widget;
                for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
                    yield* walk(child);
            };
            const widgets = [...walk(dialog)];
            const row = title => widgets.find(w => w.title === title);
            row('Mount point').text = '/data set';
            row(`Label for ${server.networkInterface}`).text = 'fixture uplink';
            row('Favorite interface').active = true;
            row('Maintenance mute').active = true;
            widgets.find(w => w instanceof Gtk.Button && w.label === 'Save').emit('clicked');
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                this._importServers(window, settings);
                const found = [...walk(window.visible_dialog)];
                const titles = found.filter(w => w instanceof Adw.SwitchRow).map(w => `${w.title}:${w.active}`).join();
                if (titles === 'web1:true,code:false,db1:true,old1.invalid:false,old2.invalid:false') {
                    const button = label => found.find(w => w instanceof Gtk.Button && w.label === label);
                    const rows = found.filter(w => w instanceof Adw.SwitchRow);
                    button('Select shown').emit('clicked');
                    const all = button('Import 5') ? 'all' : 'not all';
                    button('Clear shown').emit('clicked');
                    const none = !found.find(w => w instanceof Gtk.Button && w.label === 'Import 0').sensitive;
                    for (const row of rows)
                        row.active = ['web1', 'db1', 'old2.invalid'].includes(row.title);
                    if (all === 'all' && none)
                        button('Import 3').emit('clicked');
                    else
                        printerr(`import selection: ${all} ${none}`);
                } else {
                    printerr(`import dialog rows: ${titles}`);
                }
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }
}
