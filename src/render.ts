import { isAsyncApi, renderAsyncSpec } from './asyncapi';
import { buildRequest, renderTryIt } from './tryit';

type Obj = Record<string, any>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const MAX_DEPTH = 40;

export function esc(v: unknown): string {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(v ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

/** Resolves a local JSON pointer ref (`#/a/b`). External refs are not supported. */
export function resolve(root: Obj, ref: string): any {
    if (!ref.startsWith('#/')) return undefined;
    return ref
        .slice(2)
        .split('/')
        .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
        .reduce<any>((node, key) => node?.[key], root);
}

/** Follows a `$ref` chain for non-schema objects (parameters, responses, request bodies). */
export function deref(node: any, root: Obj): any {
    for (let i = 0; i < 10 && node?.$ref; i++) node = resolve(root, node.$ref);
    return node ?? {};
}

export function renderSchema(s: any, root: Obj, seen: Set<string> = new Set(), depth = 0): string {
    if (!s || typeof s !== 'object') return '';
    if (depth > MAX_DEPTH) return '<span class="muted">…</span>';
    if (typeof s.$ref === 'string') {
        const name = s.$ref.split('/').pop();
        if (seen.has(s.$ref)) return `<span class="ref">↻ ${esc(name)}</span>`;
        const target = resolve(root, s.$ref);
        if (!target) return `<span class="err">unresolved ${esc(s.$ref)}</span>`;
        return `<span class="ref">${esc(name)}</span> ` + renderSchema(target, root, new Set(seen).add(s.$ref), depth + 1);
    }

    const parts: string[] = [];
    const type = Array.isArray(s.type) ? s.type.join(' | ') : s.type;
    if (type) parts.push(`<span class="type">${esc(type)}${s.format ? `<span class="muted">(${esc(s.format)})</span>` : ''}</span>`);
    if (s.nullable) parts.push('<span class="muted">nullable</span>');
    if ('const' in s) parts.push(`<span class="enum">= ${esc(JSON.stringify(s.const))}</span>`);
    if (Array.isArray(s.enum)) parts.push(`<span class="enum">enum: ${esc(s.enum.map((v: unknown) => JSON.stringify(v)).join(', '))}</span>`);
    if (s.default !== undefined) parts.push(`<span class="muted">default: ${esc(JSON.stringify(s.default))}</span>`);
    if (s.example !== undefined) parts.push(`<span class="muted">example: ${esc(JSON.stringify(s.example))}</span>`);
    if (s.description) parts.push(`<div class="desc">${esc(s.description)}</div>`);

    if (s.properties && typeof s.properties === 'object') {
        const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
        const rows = Object.entries(s.properties).map(
            ([name, prop]) =>
                `<li><span class="field">${esc(name)}</span>${required.has(name) ? '<span class="req" title="required">*</span>' : ''} ${renderSchema(prop, root, seen, depth + 1)}</li>`,
        );
        parts.push(`<ul>${rows.join('')}</ul>`);
    }
    if (s.items) parts.push(`<div class="sub">items: ${renderSchema(s.items, root, seen, depth + 1)}</div>`);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
        parts.push(`<div class="sub">additionalProperties: ${renderSchema(s.additionalProperties, root, seen, depth + 1)}</div>`);
    }
    for (const k of ['allOf', 'oneOf', 'anyOf']) {
        if (!Array.isArray(s[k])) continue;
        const variants = s[k].map((v: any) => `<li>${renderSchema(v, root, seen, depth + 1)}</li>`);
        parts.push(`<div class="sub">${k}:<ul>${variants.join('')}</ul></div>`);
    }
    return parts.join(' ');
}

function renderContent(content: any, root: Obj): string {
    if (!content || typeof content !== 'object') return '';
    return Object.entries(content)
        .map(([mime, media]: [string, any]) => `<div class="mime">${esc(mime)}</div>${renderSchema(media?.schema, root)}`)
        .join('');
}

function renderParams(params: any[], root: Obj): string {
    if (params.length === 0) return '';
    const rows = params.map(
        (p) =>
            `<tr><td><span class="field">${esc(p.name)}</span>${p.required ? '<span class="req" title="required">*</span>' : ''}</td>` +
            `<td>${esc(p.in)}</td><td>${renderSchema(p.schema ?? (p.type ? { type: p.type } : undefined), root)}</td>` +
            `<td>${esc(p.description)}</td></tr>`,
    );
    return `<table><tr><th>Name</th><th>In</th><th>Schema</th><th>Description</th></tr>${rows.join('')}</table>`;
}

export function part(opId: string, name: string, title: string, inner: string): string {
    return `<details class="part" data-id="${esc(`${opId}|${name}`)}"><summary>${title}</summary><div>${inner}</div></details>`;
}

function renderOperation(path: string, method: string, op: Obj, pathParams: any[], root: Obj, base: string): string {
    // Operation-level parameters override path-level ones with the same name + location.
    const byKey = new Map<string, any>();
    for (const p of [...pathParams, ...(op.parameters ?? [])].map((p) => deref(p, root))) byKey.set(`${p.in}:${p.name}`, p);

    const id = `${method} ${path}`;
    let body = '';
    if (op.description) body += `<div class="desc">${esc(op.description)}</div>`;
    if (op.operationId) body += `<div class="muted">operationId: ${esc(op.operationId)}</div>`;
    const params = [...byKey.values()];
    const reqBody = op.requestBody ? deref(op.requestBody, root) : undefined;
    body += renderTryIt(id, method, path, params, reqBody, root, base);
    if (params.length) body += part(id, 'Parameters', `Parameters <span class="muted">(${params.length})</span>`, renderParams(params, root));

    if (reqBody) {
        const title = `Request body${reqBody.required ? '<span class="req" title="required">*</span>' : ''}`;
        const desc = reqBody.description ? `<div class="desc">${esc(reqBody.description)}</div>` : '';
        body += part(id, 'Request body', title, desc + renderContent(reqBody.content, root));
    }

    const responses = Object.entries(op.responses ?? {});
    if (responses.length) {
        const rows = responses.map(([code, r]) => {
            const res = deref(r, root);
            return `<div class="resp"><span class="code c${esc(code[0])}">${esc(code)}</span> ${esc(res.description)}${renderContent(res.content, root)}${renderSchema(res.schema, root)}</div>`;
        });
        body += part(id, 'Responses', `Responses <span class="muted">(${responses.length})</span>`, rows.join(''));
    }

    const search = [method, path, op.summary, op.operationId, ...(op.tags ?? [])].join(' ').toLowerCase();
    return (
        `<details class="op${op.deprecated ? ' deprecated' : ''}" data-id="${esc(id)}" data-search="${esc(search)}">` +
        `<summary><span class="method m-${method}">${method.toUpperCase()}</span><span class="path">${esc(path)}</span>` +
        `<span class="summary">${esc(op.summary)}</span></summary><div class="body">${body}</div></details>`
    );
}

export interface Operation {
    tag: string;
    method: string;
    path: string;
    op: Obj;
    pathParams: any[];
    /** AsyncAPI channel name (the `channels` key); `path` is then the topic. */
    key?: string;
}

export function listOperations(spec: Obj): Operation[] {
    const ops: Operation[] = [];
    for (const [path, rawItem] of Object.entries(spec.paths ?? {})) {
        const item = deref(rawItem, spec);
        for (const method of METHODS) {
            const op = item[method];
            if (!op || typeof op !== 'object') continue;
            ops.push({ tag: op.tags?.[0] ?? 'default', method, path, op, pathParams: item.parameters ?? [] });
        }
    }
    return ops;
}

export function isOpenApi(spec: unknown): spec is Obj {
    return !!spec && typeof spec === 'object' && ('paths' in spec || 'openapi' in spec || 'swagger' in spec);
}

/** Renders the spec body; returns the endpoint count alongside so callers/tests can check it. */
export function renderSpec(spec: Obj, base = ''): { html: string; count: number } {
    const groups = new Map<string, string[]>();
    const ops = listOperations(spec);
    for (const { tag, method, path, op, pathParams } of ops) {
        if (!groups.has(tag)) groups.set(tag, []);
        groups.get(tag)!.push(renderOperation(path, method, op, pathParams, spec, base));
    }
    const count = ops.length;

    const tagDescriptions = new Map<string, string>((spec.tags ?? []).map((t: Obj) => [t.name, t.description]));
    const sections = [...groups.entries()].map(
        ([tag, ops]) =>
            `<section class="tag"><h2>${esc(tag)} <span class="muted">(${ops.length})</span></h2>` +
            `${tagDescriptions.get(tag) ? `<div class="desc">${esc(tagDescriptions.get(tag))}</div>` : ''}${ops.join('')}</section>`,
    );

    const info = spec.info ?? {};
    const header =
        `<header><h1>${esc(info.title ?? 'OpenAPI')} <span class="muted">${esc(info.version)}</span></h1>` +
        `${info.description ? `<div class="desc">${esc(info.description)}</div>` : ''}` +
        `<div class="toolbar"><input id="filter" placeholder="Filter ${count} endpoints…">` +
        `<button id="expand">Expand all</button><button id="collapse">Collapse all</button></div></header>`;
    return { html: header + sections.join(''), count };
}

function page(body: string, nonce: string, starred = false): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 32px; }
header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 8px 36px 8px 0; z-index: 1; border-bottom: 1px solid var(--vscode-panel-border); }
#star { position: fixed; top: 10px; right: 16px; z-index: 2; background: none; padding: 0 4px; font-size: 20px; line-height: 1; color: var(--vscode-foreground); opacity: .6; }
#star:hover { background: none; opacity: 1; } #star.on { color: var(--vscode-charts-yellow, #f5c518); opacity: 1; }
h1 { margin: 8px 0; } h2 { margin: 24px 0 8px; }
.toolbar { display: flex; gap: 6px; margin-top: 8px; }
input { flex: 1; padding: 4px 6px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 4px 10px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
details.op { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 4px 0; }
details.op.deprecated > summary { opacity: .6; text-decoration: line-through; }
summary { cursor: pointer; padding: 6px; display: flex; gap: 10px; align-items: baseline; }
summary { list-style: none; } summary::-webkit-details-marker { display: none; }
summary::before { content: '▸'; opacity: .6; width: 10px; } details[open] > summary::before { content: '▾'; }
details.part { margin-top: 8px; }
details.part > summary { padding: 2px 0; font-weight: bold; }
details.part > div { padding-left: 16px; }
.body { padding: 4px 12px 12px; border-top: 1px solid var(--vscode-panel-border); }
.method { font-weight: bold; color: #fff; border-radius: 3px; padding: 1px 6px; min-width: 52px; text-align: center; font-size: .85em; }
.m-get { background: #2f80ed; } .m-post { background: #27ae60; } .m-put { background: #e67e22; } .m-patch { background: #16a085; }
.m-delete { background: #c0392b; } .m-head, .m-options, .m-trace { background: #7f8c8d; } .m-mqtt { background: #8e44ad; }
.path { font-family: var(--vscode-editor-font-family); font-weight: bold; }
.summary, .muted { opacity: .7; }
.desc { opacity: .85; margin: 2px 0; white-space: pre-wrap; }
.field { font-family: var(--vscode-editor-font-family); font-weight: bold; }
.type { color: var(--vscode-symbolIcon-typeParameterForeground, #4ec9b0); font-family: var(--vscode-editor-font-family); }
.ref { color: var(--vscode-textLink-foreground); }
.enum { color: var(--vscode-symbolIcon-enumeratorForeground, #b8d7a3); }
.req { color: var(--vscode-errorForeground); margin-left: 2px; }
.err { color: var(--vscode-errorForeground); }
.mime { font-family: var(--vscode-editor-font-family); opacity: .7; margin-top: 4px; }
.resp { margin: 6px 0; }
.code { font-weight: bold; font-family: var(--vscode-editor-font-family); }
.c2 { color: #27ae60; } .c3 { color: #2f80ed; } .c4 { color: #e67e22; } .c5 { color: #c0392b; }
ul { margin: 2px 0; padding-left: 20px; } li { margin: 2px 0; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; vertical-align: top; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.hidden { display: none; }
.flash { outline: 2px solid var(--vscode-focusBorder); }
select, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; }
.grp { font-weight: bold; opacity: .8; margin: 8px 0 2px; }
form.tryit fieldset { border: 1px solid var(--vscode-panel-border); margin: 4px 0; padding: 2px 8px 4px; }
.fld { display: grid; grid-template-columns: minmax(140px, 30%) 1fr; gap: 8px; align-items: start; margin: 3px 0; }
.fld input, .fld select, .fld textarea, textarea.raw { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); }
form.tryit :invalid { border-color: var(--vscode-inputValidation-errorBorder, #be1100); }
.send { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.send code { white-space: nowrap; opacity: .8; }
form.mqtt input.topic { flex: 1; font-family: var(--vscode-editor-font-family); }
pre.out { background: var(--vscode-textCodeBlock-background); padding: 8px; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
pre.out.ok { border-left: 3px solid #27ae60; } pre.out.bad { border-left: 3px solid #c0392b; }
</style></head><body>${body}
<button id="star"${starred ? ' class="on" title="Remove from favorites">★' : ' title="Add to favorites">☆'}</button>
<script nonce="${nonce}">
const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const state = vscode?.getState() ?? { open: [], filter: '', scroll: 0 };
const ops = [...document.querySelectorAll('details.op')];
const filter = document.getElementById('filter');
// Endpoints and their sections; open state is kept across re-renders by data-id.
const collapsibles = [...document.querySelectorAll('details[data-id]')];
const save = () => vscode?.setState({ open: collapsibles.filter(d => d.open).map(d => d.dataset.id), filter: filter.value, scroll: window.scrollY });
const apply = () => {
  const q = filter.value.toLowerCase().trim();
  ops.forEach(d => d.classList.toggle('hidden', !!q && !d.dataset.search.includes(q)));
  document.querySelectorAll('section.tag').forEach(s => s.classList.toggle('hidden', !s.querySelector('details.op:not(.hidden)')));
};
const open = new Set(state.open);
collapsibles.forEach(d => { d.open = open.has(d.dataset.id); d.addEventListener('toggle', save); });
filter.value = state.filter;
filter.addEventListener('input', () => { apply(); save(); });
document.getElementById('expand').onclick = () => ops.forEach(d => { if (!d.classList.contains('hidden')) d.open = true; });
document.getElementById('collapse').onclick = () => ops.forEach(d => d.open = false);
window.addEventListener('scroll', save, { passive: true });
apply();
window.scrollTo(0, state.scroll);
${buildRequest.toString()}
const checkField = (el) => {
  if (el.dataset.kind === 'json') {
    try { if (el.value !== '' || el.required) JSON.parse(el.value); el.setCustomValidity(''); }
    catch (err) { el.setCustomValidity('Invalid JSON: ' + err.message); }
  } else if (el.dataset.kind === 'number') {
    const v = Number(el.value), { xmin, xmax } = el.dataset;
    el.setCustomValidity(el.value !== '' && xmin !== undefined && v <= +xmin ? 'Must be greater than ' + xmin
      : el.value !== '' && xmax !== undefined && v >= +xmax ? 'Must be less than ' + xmax : '');
  }
};
document.querySelectorAll('form.tryit [data-in]').forEach(checkField);
document.addEventListener('input', (e) => { if (e.target.dataset?.in) checkField(e.target); });
const bases = [...document.querySelectorAll('input.base')];
bases.forEach(b => b.addEventListener('change', () => {
  bases.forEach(o => { o.value = b.value; });
  vscode?.postMessage({ setBase: b.value });
}));
const forms = [...document.querySelectorAll('form.tryit')];
forms.forEach(form => form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const out = form.querySelector('.out');
  out.className = 'out';
  try {
    const fields = [...form.querySelectorAll('[data-in]')].map(el => ({ in: el.dataset.in, kind: el.dataset.kind, path: JSON.parse(el.dataset.path), value: el.value, required: el.required, ctype: el.dataset.ctype }));
    const req = buildRequest(form.querySelector('.base').value.trim(), form.dataset.method, form.dataset.path, fields);
    out.textContent = req.method + ' ' + req.url + (req.body !== undefined ? '\\n' + req.body : '') + '\\n\\nSending…';
    vscode?.postMessage({ send: { reqId: form.dataset.id, ...req } });
  } catch (err) { out.classList.add('bad'); out.textContent = String(err); }
}));
const showResponse = (r) => {
  const out = forms.find(f => f.dataset.id === r.reqId)?.querySelector('.out');
  if (!out) return;
  if (r.error) { out.className = 'out bad'; out.textContent = 'Request failed: ' + r.error; return; }
  let text = r.body;
  try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch {}
  out.className = 'out ' + (r.status < 400 ? 'ok' : 'bad');
  out.textContent = r.status + ' ' + r.statusText + ' · ' + r.ms + ' ms\\n\\n' + text;
};
const mqttForms = [...document.querySelectorAll('form.mqtt')];
const MAX_LOG = 200;
mqttForms.forEach(form => form.addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = form.querySelector('button'), out = form.querySelector('.out');
  if (form.dataset.subscribed) {
    delete form.dataset.subscribed;
    btn.textContent = 'Subscribe';
    vscode?.postMessage({ mqtt: { action: 'unsub', id: form.dataset.id } });
    return;
  }
  form.dataset.subscribed = '1';
  btn.textContent = 'Unsubscribe';
  out.className = 'out';
  out.textContent = 'Connecting…';
  vscode?.postMessage({ mqtt: { action: 'sub', id: form.dataset.id, broker: form.querySelector('.base').value.trim(), topic: form.querySelector('.topic').value.trim() } });
}));
const mqttOut = (id) => mqttForms.find(f => f.dataset.id === id)?.querySelector('.out');
const showMqttMsg = (m) => {
  const out = mqttOut(m.id);
  if (!out) return;
  let text = m.payload;
  try { text = JSON.stringify(JSON.parse(m.payload), null, 2); } catch {}
  const entry = document.createElement('div');
  entry.textContent = new Date(m.ts).toLocaleTimeString() + '  ' + m.topic + '\\n' + text + '\\n';
  out.className = 'out ok';
  out.prepend(entry);
  while (out.children.length > MAX_LOG) out.lastChild.remove();
};
const showMqttStatus = (s) => {
  const out = mqttOut(s.id);
  if (!out) return;
  if (s.error) {
    const form = out.closest('form');
    delete form.dataset.subscribed;
    form.querySelector('button').textContent = 'Subscribe';
    out.className = 'out bad'; out.textContent = 'MQTT error: ' + s.error;
  } else { out.className = 'out ok'; out.textContent = s.text + '\\nWaiting for messages…'; }
};
window.addEventListener('message', (e) => {
  if (e.data?.response) return showResponse(e.data.response);
  if (e.data?.mqttMsg) return showMqttMsg(e.data.mqttMsg);
  if (e.data?.mqttStatus) return showMqttStatus(e.data.mqttStatus);
  if (typeof e.data?.starred === 'boolean') {
    star.classList.toggle('on', e.data.starred);
    star.textContent = e.data.starred ? '★' : '☆';
    star.title = e.data.starred ? 'Remove from favorites' : 'Add to favorites';
    return;
  }
  const d = ops.find(o => o.dataset.id === e.data?.reveal);
  if (!d) return;
  if (d.classList.contains('hidden')) { filter.value = ''; apply(); }
  d.open = true;
  d.scrollIntoView({ block: 'start' });
  window.scrollBy(0, -document.querySelector('header').offsetHeight);
  d.classList.add('flash');
  setTimeout(() => d.classList.remove('flash'), 1200);
  save();
});
const star = document.getElementById('star');
star.onclick = () => vscode?.postMessage({ star: true });
vscode?.postMessage({ ready: true });
</script></body></html>`;
}

export function renderPage(spec: unknown, nonce: string, base = '', starred = false): string {
    if (isAsyncApi(spec)) return page(renderAsyncSpec(spec, base).html, nonce, starred);
    if (!isOpenApi(spec)) {
        return renderError('Not an OpenAPI/AsyncAPI document (no "openapi", "swagger", "asyncapi" or "paths" key).', nonce, starred);
    }
    return page(renderSpec(spec, base).html, nonce, starred);
}

export function renderError(message: string, nonce: string, starred = false): string {
    return page(`<header><h1>OpenAPI View</h1></header><pre class="err">${esc(message)}</pre><input id="filter" class="hidden"><button id="expand" class="hidden"></button><button id="collapse" class="hidden"></button>`, nonce, starred);
}
