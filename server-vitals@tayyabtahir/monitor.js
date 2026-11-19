export class SustainedAlert {
    update(now, bad, muted) {
        if (muted) {
            this.since = null;
            this.active = false;
            return null;
        }
        if (bad !== true) {
            this.since = null;
            if (bad === false && this.active) {
                this.active = false;
                return 'recovered';
            }
        } else {
            this.since ??= now;
            if (!this.active && now - this.since >= 30) {
                this.active = true;
                return 'warning';
            }
        }
        return null;
    }
}

export class MonitorHistory {
    constructor() {
        this.net = new Map();
        this.disk = [];
        this.last = -1;
    }

    add(s, name) {
        if (s.uptime < this.last) {
            this.net.clear();
            this.disk = [];
        }
        if (this.name !== name)
            this.net.clear();
        this.name = name;
        this.last = s.uptime;
        const bucket = Math.floor(s.uptime / 30);
        for (const key of this.net.keys()) {
            if (key <= bucket - 30)
                this.net.delete(key);
        }
        this.net.set(bucket, {rxRate: s.rxRate, txRate: s.txRate});
        if (s.diskFree === null) {
            this.disk = [];
        } else {
            this.disk = this.disk.filter(p => p.t >= s.uptime - 900 && p.bucket !== bucket);
            this.disk.push({bucket, t: s.uptime, free: s.diskFree});
        }
    }

    graph(key) {
        const end = Math.floor(this.last / 30);
        const values = Array.from({length: 30}, (_, i) => this.net.get(end - 29 + i)?.[key]);
        const peak = Math.max(1, ...values.map(v => v ?? 0));
        return values.map(v => v == null ? '·' : '▁▂▃▄▅▆▇█'[Math.round(7 * v / peak)]).join('');
    }

    runway() {
        const first = this.disk[0], last = this.disk.at(-1);
        if (this.disk.length < 3 || last.t - first.t < 300 || last.free >= first.free)
            return null;
        return last.free * (last.t - first.t) / (first.free - last.free);
    }
}
