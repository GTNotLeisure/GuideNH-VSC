export interface NeiCompletionContext {
	start: number;
	end: number;
	prefix: string;
	choices: string[];
	capability?: string;
}

export function findNeiCompletionContext(text: string, offset: number): NeiCompletionContext | undefined {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	let start = -1;
	for (const match of text.slice(lineStart, offset).matchAll(/&\[[^\]\r\n]*\]\(/g)) {
		const actionStart = lineStart + match.index!;
		let escapes = 0;
		for (let index = actionStart - 1; index >= 0 && text[index] === '\\'; index--) { escapes++; }
		if (escapes % 2 === 0) { start = actionStart + match[0].length; }
	}
	if (start < 0) { return undefined; }
	let end = start;
	while (end < text.length && text[end] !== ')' && !/\s/.test(text[end])) { end++; }
	if (offset > end) { return undefined; }
	const uri = text.slice(start, end);
	const typed = text.slice(start, offset);
	const normalized = typed.toLowerCase();
	if (normalized && !'nei:'.startsWith(normalized) && !normalized.startsWith('nei:')) { return undefined; }
	const query = uri.indexOf('?');
	if (query < 0 || offset <= start + query) {
		return { start, end: query < 0 ? end : start + query, prefix: typed,
			choices: ['nei:handler', 'nei:recipes', 'nei:usage'].map(mode => mode + (query < 0 ? '?' : '')) };
	}
	const mode = uri.slice(4, query).toLowerCase();
	const segmentStart = Math.max(start + query, text.lastIndexOf('&', offset - 1)) + 1;
	let segmentEnd = segmentStart;
	while (segmentEnd < end && text[segmentEnd] !== '&') { segmentEnd++; }
	const equals = text.indexOf('=', segmentStart);
	if (equals >= segmentStart && equals < segmentEnd && offset > equals) {
		const key = text.slice(segmentStart, equals);
		const capability = key === 'handlerId' ? 'neiHandlers' : key === 'id' && mode !== 'handler' ? 'items' : undefined;
		let prefix = text.slice(equals + 1, offset);
		try { prefix = decodeURIComponent(prefix); } catch { /* A partially typed escape is completed as raw text. */ }
		return { start: equals + 1, end: segmentEnd, prefix, choices: [], capability };
	}
	const existing = new Set<string>();
	let relativeStart = query + 1;
	for (const segment of uri.slice(query + 1).split('&')) {
		if (relativeStart !== segmentStart - start) { existing.add(segment.split('=', 1)[0]); }
		relativeStart += segment.length + 1;
	}
	const hasEquals = equals >= segmentStart && equals < segmentEnd;
	return { start: segmentStart, end: hasEquals ? equals : segmentEnd, prefix: text.slice(segmentStart, offset),
		choices: (mode === 'handler' ? ['handlerId'] : ['id', 'handlerId']).filter(key => !existing.has(key)).map(key => key + (hasEquals ? '' : '=')) };
}

export function encodeNeiCompletionValue(value: string): string {
	return encodeURIComponent(value).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}
