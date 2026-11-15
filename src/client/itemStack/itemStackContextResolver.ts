import * as vscode from 'vscode';
import { PreviewResolvePayload } from '../../common/protocol';

export interface ItemStackContext {
	tagName: string;
	attributeName: string;
	value: string;
	valueRange: vscode.Range;
	tagRange: vscode.Range;
	line: number;
	capability?: 'items' | 'fluids';
	amount?: number;
	nbt?: string;
}

const ItemStackAttributeTargets = new Map<string, ReadonlySet<string>>([
	['fluidlink', new Set(['id'])],
	['fluidimage', new Set(['id'])],
	['fluidicon', new Set(['id'])],
	['inputannotation', new Set(['item', 'fluid'])],
	['contenttabs', new Set(['iconItem', 'icon_item', 'iconFluid', 'icon_fluid'].map(name => name.toLowerCase()))],
	['series', new Set(['icon', 'iconfluid'])],
	['lineseries', new Set(['icon', 'iconfluid'])],
	['slice', new Set(['icon', 'iconfluid'])],
	['recipe', new Set(['id', 'fluid'])],
	['usage', new Set(['id', 'fluid'])],
	['recipefor', new Set(['id', 'fluid'])],
	['recipeusage', new Set(['id', 'fluid'])],
	['recipesfor', new Set(['id', 'fluid'])],
	['recipesusage', new Set(['id', 'fluid'])],
	['itemlink', new Set(['id'])],
	['itemimage', new Set(['id'])],
	['blockimage', new Set(['id'])],
	['block', new Set(['id'])],
	['placeblock', new Set(['id'])],
	['removeblocks', new Set(['id'])],
	['replaceblock', new Set(['from', 'to'])]
]);

export function contentPreviewPayload(context: ItemStackContext, count: number, renderVariant: string, source: string): PreviewResolvePayload {
	const capability = context.capability ?? 'items';
	return { capability, id: context.value.trim(),
		count: capability === 'items' ? count : undefined,
		amount: capability === 'fluids' ? context.amount : undefined, nbt: context.nbt,
		renderVariant, filters: { source } };
}

const TagPattern = /<([A-Za-z][A-Za-z0-9]*)\b[^<>]*?>/g;
const AttributePattern = /([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function isGuideNhPreviewDocument(document: vscode.TextDocument): boolean {
	return document.languageId === 'markdown' || document.languageId === 'guidenh-md';
}

export function findVisibleItemStackContexts(
	document: vscode.TextDocument,
	ranges: readonly vscode.Range[]
): ItemStackContext[] {
	const contexts: ItemStackContext[] = [];
	const seen = new Set<string>();
	for (const range of mergeRanges(ranges)) {
		scanDocumentRange(document, range, seen, contexts);
	}
	return contexts;
}

export function findItemStackContextAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): ItemStackContext | undefined {
	const lineRange = expandRangeToNearbyLines(document, position.line, 8);
	const contexts = findVisibleItemStackContexts(document, [lineRange]);
	return contexts.find((context) => context.valueRange.contains(position));
}

export function findNearestItemStackContextAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position
): ItemStackContext | undefined {
	const lineRange = expandRangeToNearbyLines(document, position.line, 8);
	const contexts = findVisibleItemStackContexts(document, [lineRange]);
	return contexts.find((context) => context.valueRange.contains(position))
		?? contexts.find((context) => context.valueRange.end.isEqual(position));
}

export function findNearestItemStackContextInEditor(
	editor: vscode.TextEditor,
	position?: vscode.Position
): ItemStackContext | undefined {
	const targetPosition = position ?? editor.selection.active;
	return findNearestItemStackContextAtPosition(editor.document, targetPosition)
		?? findItemStackContextAtPosition(editor.document, targetPosition);
}

export function findBestMatchingItemStackContext(
	document: vscode.TextDocument,
	target: ItemStackContext
): ItemStackContext | undefined {
	const range = expandRangeToNearbyLines(document, target.line, 8);
	const nearbyMatches = findVisibleItemStackContexts(document, [range]).filter((context) => {
		return isSameItemStackBinding(context, target);
	});
	const currentRangeText = safeReadRangeText(document, target.valueRange);
	if (currentRangeText !== undefined) {
		const directMatch = nearbyMatches.find((context) => {
			return context.valueRange.start.isEqual(target.valueRange.start)
				&& context.valueRange.end.isEqual(target.valueRange.end);
		});
		if (directMatch) {
			return directMatch;
		}
	}
	return nearbyMatches.find((context) => context.line === target.line)
		?? nearbyMatches.find((context) => context.tagRange.start.isEqual(target.tagRange.start))
		?? undefined;
}

export function isSameItemStackBinding(left: ItemStackContext, right: ItemStackContext): boolean {
	return left.tagName.toLowerCase() === right.tagName.toLowerCase()
		&& left.attributeName.toLowerCase() === right.attributeName.toLowerCase();
}

function scanDocumentRange(
	document: vscode.TextDocument,
	range: vscode.Range,
	seen: Set<string>,
	contexts: ItemStackContext[]
): void {
	const text = document.getText(range);
	const baseOffset = document.offsetAt(range.start);
	TagPattern.lastIndex = 0;
	let tagMatch: RegExpExecArray | null;
	while ((tagMatch = TagPattern.exec(text)) !== null) {
		const tagMarkup = tagMatch[0];
		if (tagMarkup.startsWith('</')) {
			continue;
		}
		const tagName = tagMatch[1];
		const supportedAttributes = ItemStackAttributeTargets.get(tagName.toLowerCase());
		if (!supportedAttributes || supportedAttributes.size === 0) {
			continue;
		}
		const tagOffset = baseOffset + tagMatch.index;
		const tagStart = document.positionAt(tagOffset);
		const tagEnd = document.positionAt(tagOffset + tagMarkup.length);
		const attributeSource = tagMarkup.slice(tagMarkup.indexOf(tagName) + tagName.length);
		AttributePattern.lastIndex = 0;
		let attributeMatch: RegExpExecArray | null;
		while ((attributeMatch = AttributePattern.exec(attributeSource)) !== null) {
			const attributeName = attributeMatch[1];
			if (!supportedAttributes.has(attributeName.toLowerCase())) {
				continue;
			}
			const value = attributeMatch[2] ?? attributeMatch[3] ?? '';
			const valueIndex = attributeMatch[0].indexOf(value);
			const valueOffset = tagOffset + tagMarkup.indexOf(attributeSource) + attributeMatch.index + valueIndex;
			const valueRange = new vscode.Range(
				document.positionAt(valueOffset),
				document.positionAt(valueOffset + value.length)
			);
			const context: ItemStackContext = {
				tagName,
				attributeName,
				value,
				valueRange,
				tagRange: new vscode.Range(tagStart, tagEnd),
				line: valueRange.start.line,
				capability: tagName.toLowerCase().startsWith('fluid') || /fluid/i.test(attributeName) ? 'fluids' : 'items',
				amount: readAmount(tagMarkup),
				nbt: /\bnbt\s*=\s*"((?:\\.|[^"\\])*)"/.exec(tagMarkup)?.[1]?.replace(/\\(["\\])/g, '$1')
			};
			const contextKey = createContextKey(context);
			if (seen.has(contextKey)) {
				continue;
			}
			seen.add(contextKey);
			contexts.push(context);
		}
	}
}

function readAmount(markup: string): number | undefined {
	const raw = /\bamount\s*=\s*(?:\{\s*(\d+)\s*\}|"(\d+)"|'(\d+)')/.exec(markup);
	if (!raw) { return undefined; }
	const amount = Number(raw[1] ?? raw[2] ?? raw[3]);
	return Number.isSafeInteger(amount) && amount <= 2147483647 ? amount : undefined;
}

function mergeRanges(ranges: readonly vscode.Range[]): vscode.Range[] {
	if (ranges.length === 0) {
		return [];
	}
	const sorted = [...ranges].sort((left, right) => {
		if (left.start.line !== right.start.line) {
			return left.start.line - right.start.line;
		}
		return left.start.character - right.start.character;
	});
	const merged: vscode.Range[] = [];
	for (const range of sorted) {
		const previous = merged[merged.length - 1];
		if (!previous || previous.end.isBefore(range.start)) {
			merged.push(range);
			continue;
		}
		merged[merged.length - 1] = new vscode.Range(previous.start, previous.end.isAfter(range.end) ? previous.end : range.end);
	}
	return merged;
}

function expandRangeToNearbyLines(
	document: vscode.TextDocument,
	line: number,
	linePadding: number
): vscode.Range {
	const startLine = Math.max(0, line - linePadding);
	const endLine = Math.min(document.lineCount - 1, line + linePadding);
	return new vscode.Range(
		new vscode.Position(startLine, 0),
		document.lineAt(endLine).range.end
	);
}

function createContextKey(context: ItemStackContext): string {
	return [
		context.line,
		context.tagName.toLowerCase(),
		context.attributeName.toLowerCase(),
		context.valueRange.start.character,
		context.valueRange.end.character
	].join(':');
}

function safeReadRangeText(
	document: vscode.TextDocument,
	range: vscode.Range
): string | undefined {
	try {
		return document.getText(range);
	} catch {
		return undefined;
	}
}
