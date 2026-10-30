import * as vscode from 'vscode';
import { Document, parseDocument } from 'yaml';
import { isOpenApi, listOperations, Operation } from './render';

const METHOD_COLORS: Record<string, string> = {
    get: 'charts.blue',
    post: 'charts.green',
    put: 'charts.orange',
    patch: 'charts.purple',
    delete: 'charts.red',
};

interface TagNode {
    kind: 'tag';
    tag: string;
    ops: OpNode[];
}

export interface OpNode {
    kind: 'op';
    uri: vscode.Uri;
    operation: Operation;
    line: number;
}

type Node = TagNode | OpNode;

export class EndpointsProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private tags: TagNode[] = [];
    private doc: vscode.TextDocument | undefined;
    private timer: NodeJS.Timeout | undefined;
    private readonly subs: vscode.Disposable[];

    constructor() {
        this.subs = [
            // Focusing the preview webview clears activeTextEditor; keep showing the last spec then.
            vscode.window.onDidChangeActiveTextEditor((e) => e && this.track(e.document)),
            vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document !== this.doc) return;
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.refresh(), 300);
            }),
        ];
        const active = vscode.window.activeTextEditor?.document;
        if (active) this.track(active);
    }

    private track(doc: vscode.TextDocument): void {
        if (doc.uri.scheme === 'output') return;
        this.doc = doc;
        this.refresh();
    }

    private refresh(): void {
        const doc = this.doc;
        if (!doc) return;
        const yamlDoc = parseDocument(doc.getText());
        // Keep the previous tree while the file is mid-edit and doesn't parse.
        if (yamlDoc.errors.length && this.tags.length) return;
        const spec = yamlDoc.errors.length ? undefined : yamlDoc.toJS();

        const groups = new Map<string, OpNode[]>();
        if (isOpenApi(spec)) {
            for (const operation of listOperations(spec)) {
                if (!groups.has(operation.tag)) groups.set(operation.tag, []);
                groups.get(operation.tag)!.push({ kind: 'op', uri: doc.uri, operation, line: lineOf(yamlDoc, doc, operation) });
            }
        }
        this.tags = [...groups.entries()].map(([tag, ops]) => ({ kind: 'tag', tag, ops }));
        this.changed.fire();
    }

    getChildren(node?: Node): Node[] {
        if (!node) return this.tags;
        return node.kind === 'tag' ? node.ops : [];
    }

    getTreeItem(node: Node): vscode.TreeItem {
        if (node.kind === 'tag') {
            const item = new vscode.TreeItem(node.tag, vscode.TreeItemCollapsibleState.Collapsed);
            item.description = String(node.ops.length);
            return item;
        }
        const { method, path, op } = node.operation;
        const item = new vscode.TreeItem(`${method.toUpperCase()} ${path}`);
        item.description = (op.deprecated ? '(deprecated) ' : '') + (op.summary ?? '');
        item.tooltip = [op.summary, op.operationId && `operationId: ${op.operationId}`].filter(Boolean).join('\n');
        const color = METHOD_COLORS[method];
        item.iconPath = new vscode.ThemeIcon('symbol-method', color ? new vscode.ThemeColor(color) : undefined);
        item.contextValue = 'operation';
        item.command = { command: 'openapi_view.reveal', title: 'Show in Preview', arguments: [node.uri, `${method} ${path}`] };
        return item;
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.subs.forEach((s) => s.dispose());
        this.changed.dispose();
    }
}

function lineOf(yamlDoc: Document, doc: vscode.TextDocument, { path, method }: Operation): number {
    // Jump to the `method:` key rather than its value, which starts on the following line.
    const item: any = yamlDoc.getIn(['paths', path], true);
    const key = item?.items?.find((pair: any) => pair.key?.value === method)?.key ?? item;
    return key?.range ? doc.positionAt(key.range[0]).line : 0;
}
