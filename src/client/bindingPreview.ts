import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { BindingOccurrence, bindingIdentity, extractBindingOccurrences } from '../server/parser/bindingIndexing';
import { resolveGuideNhDocumentLocation } from '../server/index/guideNhPaths';
import { PreviewResolveResultPayload, RuntimeBridgeStatusParams } from '../common/protocol';
import { RuntimePreviewClient } from './runtimePreviewClient';

export interface BindingPreviewTarget {
    path: string;
    anchor: string;
    title: string;
    locale?: string;
}

const pages = new Map<string, { source: string; keys: Set<string> }>();
const targetsByKey = new Map<string, Map<string, BindingPreviewTarget[]>>();
const previews = new Map<string, PreviewResolveResultPayload>();
const pending = new Map<string, number>();
let previewClient: RuntimePreviewClient | undefined;
let connected = false;
let generation = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

function refreshPreview(): void {
    if (refreshTimer) { return; }
    refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void vscode.commands.executeCommand('markdown.preview.refresh');
    }, 100);
}

function removePage(uri: string): void {
    for (const key of pages.get(uri)?.keys || []) {
        const targets = targetsByKey.get(key)!;
        targets.delete(uri);
        if (!targets.size) { targetsByKey.delete(key); }
    }
    pages.delete(uri);
}

function indexPage(uri: string, source: string, occurrences?: BindingOccurrence[]): void {
    if (pages.get(uri)?.source === source) { return; }
    removePage(uri);
    const definitions = new Map<string, Map<string, BindingPreviewTarget>>();
    const location = resolveGuideNhDocumentLocation(uri);
    for (const binding of occurrences ?? extractBindingOccurrences(source)) {
        if (!binding.definition) { continue; }
        const key = bindingIdentity(binding.type, binding.id);
        const anchor = binding.anchor.replace(/^#/, '');
        let targets = definitions.get(key);
        if (!targets) { targets = new Map(); definitions.set(key, targets); }
        targets.set(anchor, { path: uri, anchor, title: location.relativePath, locale: location.locale });
    }
    for (const [key, definitionsByAnchor] of definitions) {
        let targets = targetsByKey.get(key);
        if (!targets) { targets = new Map(); targetsByKey.set(key, targets); }
        targets.set(uri, [...definitionsByAnchor.values()]);
    }
    pages.set(uri, { source, keys: new Set(definitions.keys()) });
}

export function updateBindingPreviewStatus(status: RuntimeBridgeStatusParams): void {
    connected = status.state === 'connected';
    generation++;
    previews.clear();
    pending.clear();
    refreshPreview();
}

export function registerBindingPreview(context: vscode.ExtensionContext, client: RuntimePreviewClient): void {
    previewClient = client;
    let disposed = false;
    const index = (document: vscode.TextDocument) => {
        if (document.languageId === 'markdown' || document.languageId === 'guidenh-md') {
            indexPage(document.uri.toString(), document.getText());
        }
    };
    const readPage = async (uri: vscode.Uri) => {
        const source = await fs.readFile(uri.fsPath, 'utf8').catch(() => undefined);
        if (disposed) { return; }
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
        if (document) { index(document); }
        else if (source !== undefined) { indexPage(uri.toString(), source); }
        else { removePage(uri.toString()); }
    };
    const readAndRefresh = (uri: vscode.Uri) => { void readPage(uri).then(() => { if (!disposed) { refreshPreview(); } }); };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,mdx}');
    vscode.workspace.textDocuments.forEach(index);
    context.subscriptions.push(watcher,
        watcher.onDidCreate(readAndRefresh), watcher.onDidChange(readAndRefresh),
        watcher.onDidDelete(uri => { removePage(uri.toString()); refreshPreview(); }),
        vscode.workspace.onDidOpenTextDocument(index),
        vscode.workspace.onDidChangeTextDocument(event => { index(event.document); refreshPreview(); }),
        vscode.workspace.onDidCloseTextDocument(document => readAndRefresh(document.uri)),
        vscode.workspace.onDidDeleteFiles(event => {
            for (const file of event.files) {
                const uri = file.toString();
                for (const page of [...pages.keys()]) {
                    if (page === uri || page.startsWith(uri + '/')) { removePage(page); }
                }
            }
            refreshPreview();
        }),
        vscode.workspace.onDidRenameFiles(event => {
            for (const file of event.files) {
                const oldUri = file.oldUri.toString(), newUri = file.newUri.toString();
                for (const [uri, page] of [...pages]) {
                    if (uri !== oldUri && !uri.startsWith(oldUri + '/')) { continue; }
                    removePage(uri);
                    indexPage(newUri + uri.slice(oldUri.length), page.source);
                }
            }
            refreshPreview();
        }),
        { dispose() {
            disposed = true; previewClient = undefined; connected = false; generation++;
            if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
            pages.clear(); targetsByKey.clear(); previews.clear(); pending.clear();
        } });
    void vscode.workspace.findFiles('**/*.{md,mdx}', '**/{node_modules,.git,build,out}/**').then(async files => {
        for (const uri of files) {
            if (disposed) { return; }
            if (!pages.has(uri.toString())) { await readPage(uri); }
        }
        if (!disposed) { refreshPreview(); }
    });
}

export function bindingPreviewContext(source: string, documentUri?: string): string {
    const occurrences = extractBindingOccurrences(source);
    if (documentUri) { indexPage(documentUri, source, occurrences); }
    const locale = documentUri ? resolveGuideNhDocumentLocation(documentUri).locale : undefined;
    const targets: Record<string, BindingPreviewTarget[]> = {};
    const values: Record<string, PreviewResolveResultPayload> = {};
    const seen = new Set<string>();
    for (const binding of occurrences) {
        const key = bindingIdentity(binding.type, binding.id);
        if (seen.has(key)) { continue; }
        seen.add(key);
        targets[key] = [...targetsByKey.get(key)?.values() || []].flat()
            .filter(target => !locale || !target.locale || target.locale === locale);
        const cached = previews.get(key);
        if (cached) { values[key] = cached; }
        else if (previewClient && connected && !pending.has(key)) {
            const requestedGeneration = generation;
            pending.set(key, requestedGeneration);
            void Promise.resolve(previewClient.resolve({ capability: 'bindings', id: binding.id, filters: { type: binding.type } }))
                .then(result => {
                    if (!previewClient || generation !== requestedGeneration) { return; }
                    previews.set(key, result);
                    if (previews.size > 256) { previews.delete(previews.keys().next().value!); }
                    refreshPreview();
                }).catch(() => undefined).finally(() => {
                    if (pending.get(key) === requestedGeneration) { pending.delete(key); }
                });
        }
    }
    return Buffer.from(JSON.stringify({ targets, previews: values }), 'utf8').toString('base64');
}
