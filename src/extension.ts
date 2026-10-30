import * as path from 'path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { renderError, renderPage } from './render';
import { EndpointsProvider, OpNode } from './sidebar';

const baseKey = (doc: vscode.TextDocument) => `baseUrl:${doc.uri.toString()}`;

function build(doc: vscode.TextDocument, state: vscode.Memento): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
        const spec = parse(doc.getText());
        const base = state.get<string>(baseKey(doc)) ?? spec?.servers?.[0]?.url ?? '';
        return renderPage(spec, nonce, base);
    } catch (e) {
        return renderError(e instanceof Error ? e.message : String(e), nonce);
    }
}

interface SendRequest {
    reqId: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

// Runs in the extension host, which under Remote-SSH is the remote machine (extensionKind: workspace).
async function send(req: SendRequest): Promise<object> {
    const start = Date.now();
    try {
        if (!/^https?:\/\//i.test(req.url)) throw new Error(`Only http(s) URLs are supported: ${req.url}`);
        const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(30_000) });
        return { reqId: req.reqId, status: res.status, statusText: res.statusText, ms: Date.now() - start, body: await res.text() };
    } catch (e: any) {
        return { reqId: req.reqId, error: e?.cause?.message ?? e?.message ?? String(e) };
    }
}

// One preview per document; re-running the command focuses the existing panel.
const panels = new Map<string, vscode.WebviewPanel>();
// Endpoint to reveal once a panel's webview script reports ready (a new webview drops earlier messages).
const pendingReveal = new Map<string, string>();

function showPreview(doc: vscode.TextDocument, state: vscode.Memento): void {
    const key = doc.uri.toString();
    const existing = panels.get(key);
    if (existing) {
        existing.reveal(undefined, true);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'openapi_view',
        `OpenAPI: ${path.basename(doc.fileName)}`,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true },
    );
    panels.set(key, panel);
    const update = () => (panel.webview.html = build(doc, state));

    // Debounced so typing in a large spec doesn't re-parse on every keystroke.
    let timer: NodeJS.Timeout | undefined;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== doc) return;
        clearTimeout(timer);
        timer = setTimeout(update, 300);
    });
    const messages = panel.webview.onDidReceiveMessage(async (m) => {
        if (typeof m?.setBase === 'string') await state.update(baseKey(doc), m.setBase);
        if (m?.send) {
            const response = await send(m.send);
            if (panels.get(key) === panel) panel.webview.postMessage({ response });
        }
        const id = pendingReveal.get(key);
        if (!m?.ready || id === undefined) return;
        pendingReveal.delete(key);
        panel.webview.postMessage({ reveal: id });
    });
    panel.onDidDispose(() => {
        clearTimeout(timer);
        sub.dispose();
        messages.dispose();
        panels.delete(key);
        pendingReveal.delete(key);
    });
    update();
}

export function activate(context: vscode.ExtensionContext): void {
    const endpoints = new EndpointsProvider();
    context.subscriptions.push(
        endpoints,
        vscode.window.registerTreeDataProvider('openapi_view.endpoints', endpoints),
        vscode.commands.registerCommand('openapi_view.preview', async (uri?: vscode.Uri) => {
            const doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
            if (!doc) {
                vscode.window.showWarningMessage('Open an OpenAPI YAML/JSON file first.');
                return;
            }
            showPreview(doc, context.globalState);
        }),
        vscode.commands.registerCommand('openapi_view.reveal', async (uri: vscode.Uri, id: string) => {
            const existing = panels.get(uri.toString());
            if (existing) {
                existing.reveal(undefined, true);
                existing.webview.postMessage({ reveal: id });
                return;
            }
            pendingReveal.set(uri.toString(), id);
            showPreview(await vscode.workspace.openTextDocument(uri), context.globalState);
        }),
        vscode.commands.registerCommand('openapi_view.goToSource', async (node: OpNode) => {
            const pos = new vscode.Position(node.line, 0);
            await vscode.window.showTextDocument(node.uri, { selection: new vscode.Range(pos, pos) });
        }),
    );
}

export function deactivate(): void {}
