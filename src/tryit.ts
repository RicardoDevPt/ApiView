import { esc, part, resolve } from './render';

type Obj = Record<string, any>;
type Loc = 'body' | 'path' | 'query' | 'header';

const MAX_DEPTH = 20;
const REQ = '<span class="req" title="required">*</span>';

/** Resolves `$ref`s and merges `allOf`; returns undefined when the schema refers back to itself. */
function norm(s: any, root: Obj, seen: Set<string>): { s: Obj; seen: Set<string> } | undefined {
    if (!s || typeof s !== 'object') return { s: {}, seen };
    while (typeof s.$ref === 'string') {
        if (seen.has(s.$ref)) return undefined;
        seen = new Set(seen).add(s.$ref);
        s = resolve(root, s.$ref) ?? {};
    }
    if (!Array.isArray(s.allOf)) return { s, seen };
    const merged: Obj = { ...s, allOf: undefined };
    for (const sub of s.allOf) {
        const n = norm(sub, root, seen);
        if (!n) continue;
        merged.properties = { ...merged.properties, ...n.s.properties };
        merged.required = [...(merged.required ?? []), ...(n.s.required ?? [])];
        for (const [k, v] of Object.entries(n.s)) if (merged[k] === undefined) merged[k] = v;
    }
    return { s: merged, seen };
}

function typeOf(s: Obj): string | undefined {
    if (Array.isArray(s.type)) return s.type.find((t: string) => t !== 'null');
    return s.type ?? (s.properties ? 'object' : undefined);
}

export function exampleOf(schema: any, root: Obj, seen: Set<string> = new Set(), depth = 0): unknown {
    const n = depth > MAX_DEPTH ? undefined : norm(schema, root, seen);
    if (!n) return null;
    const s = n.s;
    if (s.default !== undefined) return s.default;
    if (s.example !== undefined) return s.example;
    if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    if ('const' in s) return s.const;
    for (const k of ['oneOf', 'anyOf']) if (Array.isArray(s[k]) && s[k].length) return exampleOf(s[k][0], root, n.seen, depth + 1);

    switch (typeOf(s)) {
        case 'object':
            return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, exampleOf(v, root, n.seen, depth + 1)]));
        case 'array':
            return s.items ? [exampleOf(s.items, root, n.seen, depth + 1)] : [];
        case 'integer':
        case 'number': {
            const step = typeOf(s) === 'integer' ? 1 : 0.1;
            let v = s.minimum ?? (typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + step : 0);
            if (typeof s.maximum === 'number') v = Math.min(v, s.maximum);
            return v;
        }
        case 'string':
            if (s.format === 'date-time') return new Date().toISOString();
            if (s.format === 'date') return new Date().toISOString().slice(0, 10);
            return 'x'.repeat(s.minLength ?? 0);
        case 'boolean':
            return false;
        default:
            return null;
    }
}

function renderField(name: string, schema: any, required: boolean, path: string[], loc: Loc, root: Obj, seen: Set<string>, depth: number): string {
    const n = depth > MAX_DEPTH ? undefined : norm(schema, root, seen);
    const s = n?.s ?? {};
    const type = typeOf(s);
    const attrs = `data-in="${loc}" data-path="${esc(JSON.stringify(path))}"${required ? ' required' : ''}`;
    const value = exampleOf(schema, root, seen, depth);
    const label = (input: string, kind = type) =>
        `<label class="fld"${s.description ? ` title="${esc(s.description)}"` : ''}><span><span class="field">${esc(name)}</span>` +
        `${required ? REQ : ''} <span class="type">${esc(kind ?? 'any')}</span></span>${input}</label>`;

    if (n && (Array.isArray(s.enum) || 'const' in s || type === 'boolean')) {
        const values: unknown[] = Array.isArray(s.enum) ? s.enum : 'const' in s ? [s.const] : [true, false];
        const options = values.map((v) => {
            const json = JSON.stringify(v);
            return `<option value="${esc(json)}"${json === JSON.stringify(value) ? ' selected' : ''}>${esc(String(v))}</option>`;
        });
        return label(`<select data-kind="enum" ${attrs}>${required ? '' : '<option value="">—</option>'}${options.join('')}</select>`);
    }
    if (n && type === 'object' && s.properties && !(s.oneOf || s.anyOf)) {
        const req = new Set<string>(Array.isArray(s.required) ? s.required : []);
        // Children of an optional object are never forced, so the whole object can be left empty.
        const children = Object.entries(s.properties).map(([k, v]) =>
            renderField(k, v, required && req.has(k), [...path, k], loc, root, n.seen, depth + 1),
        );
        if (path.length === 0) return children.join('');
        return `<fieldset><legend><span class="field">${esc(name)}</span>${required ? REQ : ''} <span class="type">object</span></legend>${children.join('')}</fieldset>`;
    }
    if (n && (type === 'integer' || type === 'number')) {
        const limits = [
            typeof s.minimum === 'number' ? ` min="${s.minimum}"` : '',
            typeof s.maximum === 'number' ? ` max="${s.maximum}"` : '',
            typeof s.exclusiveMinimum === 'number' ? ` data-xmin="${s.exclusiveMinimum}"` : '',
            typeof s.exclusiveMaximum === 'number' ? ` data-xmax="${s.exclusiveMaximum}"` : '',
        ].join('');
        return label(`<input type="number" data-kind="number" step="${type === 'integer' ? 1 : 'any'}"${limits} value="${esc(value)}" ${attrs}>`);
    }
    if (n && type === 'string') {
        const limits = [
            typeof s.minLength === 'number' ? ` minlength="${s.minLength}"` : '',
            typeof s.maxLength === 'number' ? ` maxlength="${s.maxLength}"` : '',
            typeof s.pattern === 'string' ? ` pattern="${esc(s.pattern)}"` : '',
        ].join('');
        const kind = s.format ? `string(${s.format})` : 'string';
        return label(`<input type="text" data-kind="string"${limits} value="${esc(value)}" ${attrs}>`, kind);
    }
    const json = JSON.stringify(value, null, 2) ?? 'null';
    return label(`<textarea data-kind="json" rows="${Math.min(12, json.split('\n').length)}" ${attrs}>${esc(json)}</textarea>`, n ? (type ?? 'json') : 'recursive');
}

export function renderTryIt(id: string, method: string, path: string, params: any[], reqBody: Obj | undefined, root: Obj, base: string): string {
    let inner = '';
    const known = params.filter((p) => ['path', 'query', 'header'].includes(p.in));
    if (known.length) {
        inner += '<div class="grp">Parameters</div>';
        inner += known.map((p) => renderField(p.name, p.schema ?? { type: p.type }, p.in === 'path' || !!p.required, [p.name], p.in, root, new Set(), 0)).join('');
    }

    const content: Obj = reqBody?.content ?? {};
    const json = Object.keys(content).find((m) => /json/i.test(m));
    if (json) {
        inner += `<div class="grp">Body <span class="muted">${esc(json)}</span></div>`;
        inner += renderField('body', content[json]?.schema, !!reqBody?.required, [], 'body', root, new Set(), 0);
    } else if (Object.keys(content).length) {
        const ctype = Object.keys(content)[0];
        inner += `<div class="grp">Body <span class="muted">${esc(ctype)}</span></div>`;
        inner += `<textarea class="raw" rows="6" data-in="body" data-kind="raw" data-path="[]" data-ctype="${esc(ctype)}"${reqBody?.required ? ' required' : ''}></textarea>`;
    }

    inner +=
        `<div class="send"><input class="base" placeholder="http://host:port/base" value="${esc(base)}">` +
        `<code>${esc(method.toUpperCase())} ${esc(path)}</code><button type="submit">Send</button></div><pre class="out hidden"></pre>`;
    const form = `<form class="tryit" novalidate data-id="${esc(id)}" data-method="${esc(method)}" data-path="${esc(path)}">${inner}</form>`;
    return part(id, 'Try it', 'Try it', form);
}

export interface Field {
    in: string;
    kind: string;
    path: string[];
    value: string;
    required: boolean;
    ctype?: string;
}

/**
 * Builds the HTTP request from the form fields. Runs inside the webview via `toString()`, so it must
 * stay self-contained (no imports, no outer references).
 */
export function buildRequest(base: string, method: string, path: string, fields: Field[]) {
    let url = path;
    const query: string[] = [];
    const headers: Record<string, string> = {};
    let body: any;
    let bodySet = false;
    let raw: string | undefined;
    let ctype = 'application/json';
    for (const f of fields) {
        if (f.value === '' && !f.required) continue;
        if (f.kind === 'raw') {
            raw = f.value;
            ctype = f.ctype || 'text/plain';
            continue;
        }
        const v = f.kind === 'number' ? Number(f.value) : f.kind === 'enum' || f.kind === 'json' ? JSON.parse(f.value) : f.value;
        const name = f.path[f.path.length - 1];
        if (f.in === 'path') url = url.split('{' + name + '}').join(encodeURIComponent(String(v)));
        else if (f.in === 'query') {
            for (const x of Array.isArray(v) ? v : [v]) {
                query.push(encodeURIComponent(name) + '=' + encodeURIComponent(typeof x === 'object' ? JSON.stringify(x) : String(x)));
            }
        } else if (f.in === 'header') headers[name] = String(v);
        else if (f.path.length === 0) {
            body = v;
            bodySet = true;
        } else {
            body = body ?? {};
            let o = body;
            for (const k of f.path.slice(0, -1)) o = o[k] ??= {};
            o[name] = v;
            bodySet = true;
        }
    }
    if (raw !== undefined || bodySet) headers['Content-Type'] = ctype;
    return {
        method: method.toUpperCase(),
        url: base.replace(/\/+$/, '') + url + (query.length ? '?' + query.join('&') : ''),
        headers,
        body: raw !== undefined ? raw : bodySet ? JSON.stringify(body) : undefined,
    };
}
