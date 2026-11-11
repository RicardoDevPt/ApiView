import * as path from 'path';
import * as vscode from 'vscode';

const KEY = 'favorites';

/** Starred spec files (URIs), kept per workspace in insertion order. */
export class FavoritesProvider implements vscode.TreeDataProvider<string>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private readonly state: vscode.Memento) {}

    private list(): string[] {
        return this.state.get<string[]>(KEY) ?? [];
    }

    has(uri: string): boolean {
        return this.list().includes(uri);
    }

    async toggle(uri: string): Promise<void> {
        const list = this.list();
        await this.state.update(KEY, list.includes(uri) ? list.filter((u) => u !== uri) : [...list, uri]);
        this.changed.fire();
    }

    getChildren(node?: string): string[] {
        return node ? [] : this.list();
    }

    getTreeItem(key: string): vscode.TreeItem {
        const uri = vscode.Uri.parse(key);
        const item = new vscode.TreeItem(path.basename(uri.path));
        item.resourceUri = uri;
        item.tooltip = vscode.workspace.asRelativePath(uri);
        item.contextValue = 'favorite';
        item.command = { command: 'apiview.preview', title: 'Open Preview', arguments: [uri] };
        return item;
    }

    dispose(): void {
        this.changed.dispose();
    }
}
