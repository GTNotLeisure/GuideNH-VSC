export function readActionLink(source: string, start: number): { label: string; destination: string; source: string; end: number } | undefined {
	if (!source.startsWith('&[', start)) {return undefined;}
	const close = (offset: number, delimiter: string): number => {
		for (let index = offset; index < source.length; index++) {
			if (source[index] === '\\') {index++;}
			else if (source[index] === delimiter) {return index;}
		}
		return -1;
	};
	const labelEnd = close(start + 2, ']');
	if (labelEnd < 0 || source[labelEnd + 1] !== '(') {return undefined;}
	const destinationEnd = close(labelEnd + 2, ')');
	if (destinationEnd < 0) {return undefined;}
	const unescape = (value: string): string => value.replace(/\\([\[\]()\\])/g, (match, delimiter: string) => delimiter === '\\' ? match : delimiter);
	const label = unescape(source.slice(start + 2, labelEnd));
	const destination = unescape(source.slice(labelEnd + 2, destinationEnd));
	return label && destination ? { label, destination, source: source.slice(start, destinationEnd + 1), end: destinationEnd + 1 } : undefined;
}

export function parseNeiAction(destination: string): Record<string, string> {
	if (!/^nei:/i.test(destination) || destination.includes('#')) {throw new Error('Expected a NEI action without a fragment.');}
	const separator = destination.indexOf('?', 4);
	const attributes: Record<string, string> = { mode: destination.slice(4, separator < 0 ? undefined : separator) };
	if (separator >= 0) {
		for (const pair of destination.slice(separator + 1).split('&')) {
			const equals = pair.indexOf('=');
			if (equals <= 0) {throw new Error('NEI parameters must have a name and value.');}
			const name = decodeURIComponent(pair.slice(0, equals));
			const value = decodeURIComponent(pair.slice(equals + 1));
			if (name !== 'id' && name !== 'handlerId') {throw new Error(`Unknown NEI parameter: ${name}`);}
			if (!value.trim() || Object.hasOwn(attributes, name)) {throw new Error(`Blank or duplicate NEI parameter: ${name}`);}
			attributes[name] = value;
		}
	}
	const error = validateNeiAttributes(attributes);
	if (error) {throw new Error(error);}
	return attributes;
}

export function validateNeiAttributes(attributes: Record<string, unknown>): string | undefined {
	for (const [name, value] of Object.entries(attributes)) {
		if (!['mode', 'id', 'handlerId', 'title'].includes(name) || typeof value !== 'string') {return `Invalid NeiRecipeLink attribute: ${name}`;}
	}
	const id = String(attributes.id || '').trim();
	const handlerId = String(attributes.handlerId || '').trim();
	const mode = attributes.mode === undefined ? (id ? 'recipes' : 'handler') : String(attributes.mode).trim().toLowerCase();
	if (!['handler', 'recipes', 'usage'].includes(mode)) {return `Unknown NEI action: ${mode}`;}
	if (mode === 'handler' && (!handlerId || id)) {return 'NEI handler mode requires handlerId and does not accept id.';}
	if (mode !== 'handler' && !id) {return `NEI ${mode} mode requires id.`;}
	if (/[\u0000-\u001f\u007f-\u009f]/.test(String(attributes.id || '') + String(attributes.handlerId || ''))) {return 'NEI targets must not contain control characters.';}
	if (id) {
		let head = id.split('{', 1)[0];
		if (id.includes('{') && head.endsWith(':')) {head = head.slice(0, -1);}
		const parts = head.split(':');
		if (!head || !(parts.length > 1 ? parts[1] : parts[0])) {return 'NEI item id must not be empty.';}
	}
	return undefined;
}
