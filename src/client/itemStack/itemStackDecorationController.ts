import {
	commands,
	DecorationOptions,
	DecorationRangeBehavior,
	Disposable,
	MarkdownString,
	Position,
	Range,
	TextDocument,
	TextEditor,
	TextEditorDecorationType,
	window,
	workspace
} from 'vscode';
import { localize } from '../localization';
import { PreviewResolveResultPayload } from '../../common/protocol';
import { ItemStackContextCache } from './itemStackContextCache';
import { createFallbackInlineIconUri, createPreviewDataUri } from './itemStackDecorationAssets';
import { renderMinecraftFormattingHtml, stripMinecraftFormatting } from './itemStackTextFormatting';
import {
	isGuideNhPreviewDocument,
	contentPreviewPayload,
	ItemStackContext
} from './itemStackContextResolver';
import { ItemStackPickerPanel } from './itemStackPickerPanel';
import { ItemStackPreviewClient } from './itemStackPreviewClient';

interface ItemStackDecorationState {
	context: ItemStackContext;
	preview?: PreviewResolveResultPayload;
}

export class ItemStackDecorationController implements Disposable {
	private static readonly maxVisibleContexts = 24;
	private static readonly resolveConcurrency = 4;
	private readonly disposables: Disposable[] = [];
	private readonly refreshByUri = new Map<string, NodeJS.Timeout>();
	private readonly gutterDecorationType: TextEditorDecorationType;
	private readonly hoverDecorationType: TextEditorDecorationType;
	private readonly refreshVersionByEditor = new WeakMap<TextEditor, number>();
	private isDisposed = false;

	public constructor(
		private readonly previewClient: ItemStackPreviewClient,
		private readonly pickerPanel: ItemStackPickerPanel,
		private readonly contextCache: ItemStackContextCache
	) {
		this.gutterDecorationType = window.createTextEditorDecorationType({
			rangeBehavior: DecorationRangeBehavior.ClosedClosed,
			gutterIconPath: createFallbackInlineIconUri(),
			gutterIconSize: 'contain'
		});
		this.hoverDecorationType = window.createTextEditorDecorationType({
			rangeBehavior: DecorationRangeBehavior.ClosedClosed
		});
		this.disposables.push(this.gutterDecorationType, this.hoverDecorationType);
		this.disposables.push(
			window.onDidChangeVisibleTextEditors((editors) => {
				for (const editor of editors) {
					this.scheduleRefresh(editor, 20);
				}
			}),
			window.onDidChangeTextEditorVisibleRanges((event) => {
				this.scheduleRefresh(event.textEditor, 50);
			}),
			window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.scheduleRefresh(editor, 20);
				}
			}),
			workspace.onDidChangeTextDocument((event) => {
				for (const editor of window.visibleTextEditors) {
					if (editor.document.uri.toString() !== event.document.uri.toString()) {
						continue;
					}
					this.scheduleRefresh(editor, 90);
				}
			}),
			commands.registerCommand('guide-vsc.openItemStackPicker', async (position?: unknown) => {
				await this.openPickerForActiveEditor(normalizePosition(position));
			})
		);
		for (const editor of window.visibleTextEditors) {
			this.scheduleRefresh(editor, 20);
		}
	}

	public dispose(): void {
		this.isDisposed = true;
		for (const timeout of this.refreshByUri.values()) {
			clearTimeout(timeout);
		}
		this.refreshByUri.clear();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	public async openPickerForActiveEditor(position?: Position): Promise<void> {
		const editor = window.activeTextEditor;
		if (!editor || !isGuideNhPreviewDocument(editor.document)) {
			await window.showInformationMessage(localize('Open a GuideNH document and place the cursor inside an ItemStack id first.'));
			return;
		}
		const targetPosition = position ?? editor.selection.active;
		const stateContext = this.contextCache.findNearestContext(editor, targetPosition)
			?? this.contextCache.findContextAt(editor, targetPosition);
		if (!stateContext) {
			await window.showInformationMessage(localize('Move the cursor into an ItemStack id before opening the picker.'));
			return;
		}
		await this.pickerPanel.show(stateContext, editor);
	}

	private scheduleRefresh(editor: TextEditor, delayMs: number): void {
		if (this.isDisposed) {
			return;
		}
		this.refreshVersionByEditor.set(editor, (this.refreshVersionByEditor.get(editor) ?? 0) + 1);
		if (!isGuideNhPreviewDocument(editor.document)) {
			this.clearDecorations(editor);
			return;
		}
		const uri = editor.document.uri.toString();
		const existing = this.refreshByUri.get(uri);
		if (existing) {
			clearTimeout(existing);
		}
		const timeout = setTimeout(() => {
			this.refreshByUri.delete(uri);
			void this.refreshEditor(editor);
		}, delayMs);
		this.refreshByUri.set(uri, timeout);
	}

	private async refreshEditor(editor: TextEditor): Promise<void> {
		const documentVersion = editor.document.version;
		const refreshVersion = this.refreshVersionByEditor.get(editor);
		const contexts = this.contextCache.getVisibleContexts(editor)
			.slice(0, ItemStackDecorationController.maxVisibleContexts);
		const states = await this.resolveDecorationStates(contexts);
		if (this.isDisposed || editor.document.version !== documentVersion || this.refreshVersionByEditor.get(editor) !== refreshVersion) {
			return;
		}
		this.applyDecorations(editor, states);
	}

	private applyDecorations(editor: TextEditor, states: ItemStackDecorationState[]): void {
		editor.setDecorations(this.gutterDecorationType, states.map((state) => {
			const position = state.context.valueRange.start;
			return new Range(position, position);
		}));
		editor.setDecorations(this.hoverDecorationType, states.map((state) => this.createDecorationOption(editor.document, state)));
	}

	private clearDecorations(editor: TextEditor): void {
		editor.setDecorations(this.gutterDecorationType, []);
		editor.setDecorations(this.hoverDecorationType, []);
	}

	private createDecorationOption(document: TextDocument, state: ItemStackDecorationState): DecorationOptions {
		const valueRange = state.context.valueRange;
		return {
			range: new Range(
				document.positionAt(document.offsetAt(valueRange.start) - 1),
				document.positionAt(document.offsetAt(valueRange.end) + 1)
			),
			hoverMessage: this.createHoverMessage(state)
		};
	}

	private createHoverMessage(state: ItemStackDecorationState): MarkdownString {
		const message = new MarkdownString(undefined, true);
		message.isTrusted = true;
		message.supportHtml = true;
		const pickerCommandUri = createPickerCommandUri(state.context.valueRange.end);
		if (state.preview) {
			message.appendMarkdown(`<img src="${createPreviewDataUri(state.preview)}" width="32" height="32" /><br/>`);
			appendFormattedHoverLine(message, state.preview.displayName || state.preview.id);
			if (state.preview.detail && state.preview.detail !== state.preview.id) {
				appendFormattedHoverLine(message, state.preview.detail);
			}
			for (const line of state.preview.tooltipLines.slice(0, 8)) {
				appendFormattedHoverLine(message, line);
			}
			message.appendMarkdown(`\n**ID** \`${escapeMarkdown(stripMinecraftFormatting(state.preview.id))}\``);
			if (state.preview.meta !== undefined) {
				message.appendMarkdown(`  \n**Meta** \`${String(state.preview.meta)}\``);
			}
			if (state.preview.count !== undefined) {
				message.appendMarkdown(`  \n**Count** \`${String(state.preview.count)}\``);
			}
			if (state.preview.nbt) {
				message.appendMarkdown(`  \n**NBT** \`${escapeMarkdown(stripMinecraftFormatting(state.preview.nbt))}\``);
			}
		} else {
			message.appendMarkdown(`${escapeMarkdown(localize('Runtime preview unavailable for this ItemStack id.'))}  \n`);
		}
		message.appendMarkdown(`\n[${escapeMarkdown(localize('Open ItemStack picker'))}](${pickerCommandUri})`);
		return message;
	}

	private async resolveDecorationStates(contexts: ItemStackContext[]): Promise<ItemStackDecorationState[]> {
		const states = new Array<ItemStackDecorationState>(contexts.length);
		let nextIndex = 0;
		const workerCount = Math.min(ItemStackDecorationController.resolveConcurrency, contexts.length);
		const workers: Promise<void>[] = [];
		for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
			workers.push((async () => {
				while (nextIndex < contexts.length) {
					const currentIndex = nextIndex;
					nextIndex++;
					states[currentIndex] = await this.resolveDecorationState(contexts[currentIndex]);
				}
			})());
		}
		await Promise.all(workers);
		return states;
	}

	private async resolveDecorationState(context: ItemStackContext): Promise<ItemStackDecorationState> {
		try {
			const preview = context.value.trim().length === 0
				? undefined
				: await this.previewClient.resolve(contentPreviewPayload(context, 1, 'inline', 'inline'));
			return {
				context,
				preview
			};
		} catch {
			return {
				context,
				preview: undefined
			};
		}
	}
}

function escapeMarkdown(value: string): string {
	return value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}

function appendFormattedHoverLine(message: MarkdownString, value: string): void {
	message.appendMarkdown(`${renderMinecraftFormattingHtml(value)}<br/>`);
}

function createPickerCommandUri(position: Position): string {
	const argument = encodeURIComponent(JSON.stringify([{
		line: position.line,
		character: position.character
	}]));
	return `command:guide-vsc.openItemStackPicker?${argument}`;
}

function normalizePosition(value: unknown): Position | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as { line?: unknown; character?: unknown };
	if (typeof candidate.line !== 'number' || typeof candidate.character !== 'number') {
		return undefined;
	}
	return new Position(candidate.line, candidate.character);
}
