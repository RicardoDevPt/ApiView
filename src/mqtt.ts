import { connect, MqttClient } from 'mqtt';

/** MQTT topic-filter match: `+` is one level, a trailing `#` is any remaining levels. */
export function topicMatches(filter: string, topic: string): boolean {
    const f = filter.split('/');
    const t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
    }
    return f.length === t.length;
}

type Post = (msg: object) => void;

/** One preview panel's subscriptions; one client per broker URL. Runs in the extension host. */
export class MqttSessions {
    private readonly clients = new Map<string, MqttClient>();
    private readonly subs = new Map<string, { broker: string; topic: string }>();

    constructor(private readonly post: Post) {}

    private client(broker: string): MqttClient {
        let c = this.clients.get(broker);
        if (c) return c;
        c = connect(broker, { connectTimeout: 10_000, reconnectPeriod: 5_000 });
        c.on('message', (topic, payload) => {
            for (const [id, s] of this.subs) {
                if (s.broker === broker && topicMatches(s.topic, topic)) this.post({ mqttMsg: { id, topic, payload: payload.toString(), ts: Date.now() } });
            }
        });
        c.on('error', (e) => {
            for (const [id, s] of this.subs) if (s.broker === broker) this.post({ mqttStatus: { id, error: e.message } });
        });
        this.clients.set(broker, c);
        return c;
    }

    subscribe(id: string, broker: string, topic: string): void {
        try {
            if (!/^(mqtts?|wss?):\/\//i.test(broker)) throw new Error(`Only mqtt(s):// or ws(s):// brokers are supported: ${broker}`);
            if (!topic) throw new Error('Topic is empty');
            this.unsubscribe(id);
            this.subs.set(id, { broker, topic });
            this.client(broker).subscribe(topic, { qos: 1 }, (err) => this.post({ mqttStatus: err ? { id, error: err.message } : { id, text: `Subscribed to ${topic} on ${broker}` } }));
        } catch (e: any) {
            this.subs.delete(id);
            this.post({ mqttStatus: { id, error: e?.message ?? String(e) } });
        }
    }

    unsubscribe(id: string): void {
        const s = this.subs.get(id);
        if (!s) return;
        this.subs.delete(id);
        // Another channel may share the same filter on this broker; keep it subscribed then.
        if (![...this.subs.values()].some((o) => o.broker === s.broker && o.topic === s.topic)) this.clients.get(s.broker)?.unsubscribe(s.topic);
        if (![...this.subs.values()].some((o) => o.broker === s.broker)) {
            this.clients.get(s.broker)?.end(true);
            this.clients.delete(s.broker);
        }
    }

    dispose(): void {
        this.subs.clear();
        this.clients.forEach((c) => c.end(true));
        this.clients.clear();
    }
}
