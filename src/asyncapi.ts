import { deref, esc, Operation, part, renderSchema } from './render';

type Obj = Record<string, any>;

export function isAsyncApi(spec: unknown): spec is Obj {
    return !!spec && typeof spec === 'object' && 'asyncapi' in spec;
}

/** Channel messages: v3 `channel.messages`, v2 `subscribe`/`publish` `.message` (incl. `oneOf`). */
function messagesOf(channel: Obj, root: Obj): [string, Obj][] {
    if (channel.messages && typeof channel.messages === 'object') {
        return Object.entries(channel.messages).map(([name, m]) => [name, deref(m, root)]);
    }
    const out: [string, Obj][] = [];
    for (const action of ['subscribe', 'publish']) {
        const m = deref(channel[action]?.message, root);
        for (const v of Array.isArray(m.oneOf) ? m.oneOf.map((x: any) => deref(x, root)) : [m]) {
            if (Object.keys(v).length) out.push([v.name ?? v.title ?? action, v]);
        }
    }
    return out;
}

/** One entry per channel; `path` is the MQTT topic (v3 `address`, v2 the channel key). */
export function listChannels(spec: Obj): Operation[] {
    return Object.entries(spec.channels ?? {}).map(([key, raw]) => {
        const ch = deref(raw, spec);
        const v3 = String(spec.asyncapi).startsWith('3');
        return { tag: ch.tags?.[0]?.name ?? 'channels', method: 'mqtt', path: v3 ? (ch.address ?? key) : key, op: ch, pathParams: [], key };
    });
}

/** Address parameters (`{id}`) become single-level wildcards so the default subscription matches all. */
export const topicFilter = (address: string) => address.replace(/\{[^}]*\}/g, '+');

function renderChannel({ path, op: ch, key }: Operation, root: Obj, broker: string): string {
    const id = `mqtt ${path}`;
    let body = '';
    if (ch.description) body += `<div class="desc">${esc(ch.description)}</div>`;
    if (key !== path) body += `<div class="muted">channel: ${esc(key)}</div>`;

    const form =
        `<form class="mqtt" data-id="${esc(id)}"><div class="send"><input class="base" placeholder="mqtt://host:1883" value="${esc(broker)}">` +
        `<input class="topic" value="${esc(topicFilter(path))}"><button type="submit">Subscribe</button></div><pre class="out hidden"></pre></form>`;
    body += part(id, 'Subscribe', 'Subscribe', form);

    for (const [name, m] of messagesOf(ch, root)) {
        let inner = m.description || m.summary ? `<div class="desc">${esc(m.description ?? m.summary)}</div>` : '';
        if (m.headers) inner += `<div class="grp">Headers</div>${renderSchema(m.headers, root)}`;
        if (m.payload) inner += `<div class="grp">Payload</div>${renderSchema(m.payload, root)}`;
        body += part(id, `msg:${name}`, `Message <span class="field">${esc(name)}</span>`, inner);
    }

    const search = ['mqtt', path, key, ch.description, ...Object.keys(ch.messages ?? {})].join(' ').toLowerCase();
    return (
        `<details class="op" data-id="${esc(id)}" data-search="${esc(search)}">` +
        `<summary><span class="method m-mqtt">MQTT</span><span class="path">${esc(path)}</span>` +
        `<span class="summary">${esc(ch.title ?? ch.summary ?? '')}</span></summary><div class="body">${body}</div></details>`
    );
}

export function renderAsyncSpec(spec: Obj, broker = ''): { html: string; count: number } {
    const groups = new Map<string, string[]>();
    const channels = listChannels(spec);
    for (const c of channels) {
        if (!groups.has(c.tag)) groups.set(c.tag, []);
        groups.get(c.tag)!.push(renderChannel(c, spec, broker));
    }
    const sections = [...groups.entries()].map(
        ([tag, items]) => `<section class="tag"><h2>${esc(tag)} <span class="muted">(${items.length})</span></h2>${items.join('')}</section>`,
    );
    const info = spec.info ?? {};
    const header =
        `<header><h1>${esc(info.title ?? 'AsyncAPI')} <span class="muted">${esc(info.version)}</span></h1>` +
        `${info.description ? `<div class="desc">${esc(info.description)}</div>` : ''}` +
        `<div class="toolbar"><input id="filter" placeholder="Filter ${channels.length} channels…">` +
        `<button id="expand">Expand all</button><button id="collapse">Collapse all</button></div></header>`;
    return { html: header + sections.join(''), count: channels.length };
}

/** Default broker URL from the first server: v3 `host`, v2 `url`. */
export function defaultBroker(spec: Obj): string {
    const s: Obj = Object.values(spec.servers ?? {})[0] ?? {};
    const host = s.host ?? s.url;
    if (!host) return '';
    return /^[a-z]+:\/\//i.test(host) ? host : `${s.protocol === 'secure-mqtt' || s.protocol === 'mqtts' ? 'mqtts' : 'mqtt'}://${host}`;
}
