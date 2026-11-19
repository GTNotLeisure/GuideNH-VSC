import { Location, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { isMap, isScalar, isSeq, parseDocument, Scalar } from 'yaml';
import { extractFrontmatter } from './frontmatter';
import { createGuideNhDocumentModel, findTagContextAtOffset, findOpenTagAttributeValue, GuideNhDocumentModel } from './documentModel';

export interface BindingOccurrence {
    type: string;
    id: string;
    anchor: string;
    start: number;
    end: number;
    definition: boolean;
}

export function bindingIdentity(type: string, id: string): string {
    type = type.trim().toLowerCase();
    id = id.trim();
    if (type === 'betterquesting') {
        if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) { id = id.toLowerCase(); }
        else {
            const bytes = Buffer.from(id, 'base64');
            if (bytes.length === 16) {
                const hex = bytes.toString('hex');
                id = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
            }
        }
    }
    return JSON.stringify([type, id]);
}

export interface BindingValueContext {
    path: string;
    type?: string;
    prefix: string;
    start: number;
    end: number;
    quote?: string;
}

function bindingYamlEntries(text: string): Array<{ type?: string; fields: Map<string, Scalar>; path: string }> {
    const frontmatter = extractFrontmatter(text);
    if (!frontmatter) { return []; }
    const source = frontmatter.text.slice(0, frontmatter.text.lastIndexOf('\n---'));
    const root = parseDocument(source, { keepSourceTokens: true }).contents;
    if (!isMap(root)) { return []; }
    const result: Array<{ type?: string; fields: Map<string, Scalar>; path: string }> = [];
    for (const path of ['research_id', 'research_ids']) {
        const value = root.get(path, true);
        const values = isSeq(value) ? value.items : [value];
        for (const id of values) {
            if (isScalar(id)) { result.push({ type: 'thaumcraft', fields: new Map([['id', id]]), path }); }
        }
    }
    const bindings = root.get('bindings', true);
    if (isSeq(bindings)) {
        for (const entry of bindings.items) {
            if (!isMap(entry)) { continue; }
            const fields = new Map<string, Scalar>();
            for (const name of ['type', 'id', 'anchor']) {
                const node = entry.get(name, true);
                if (isScalar(node)) { fields.set(name, node); }
            }
            const type = fields.get('type')?.value;
            result.push({ type: typeof type === 'string' ? type : undefined, fields, path: 'bindings' });
        }
    }
    return result;
}

export function bindingValueAtOffset(text: string, offset: number): BindingValueContext | undefined {
    for (const entry of bindingYamlEntries(text)) {
        for (const [name, node] of entry.fields) {
            if (!node.range) { continue; }
            let [start, end] = node.range;
            const quote = ['"', "'"].includes(text[start]) ? text[start++] : undefined;
            if (quote && text[end - 1] === quote) { end--; }
            if (offset < start || offset > end) { continue; }
            const raw = text.slice(start, offset);
            const parsed = quote ? parseDocument(quote + raw + quote) : parseDocument(raw);
            const value = parsed.errors.length ? raw : parsed.toJS();
            return { path: entry.path === 'bindings' ? 'bindings.' + name : entry.path,
                type: entry.type, prefix: typeof value === 'string' ? value : raw, start, end, quote };
        }
    }
    return undefined;
}

export function extractBindingOccurrences(text: string, model?: GuideNhDocumentModel): BindingOccurrence[] {
    const result: BindingOccurrence[] = [];
    for (const entry of bindingYamlEntries(text)) {
        const id = entry.fields.get('id');
        const anchor = entry.fields.get('anchor')?.value;
        if (!entry.type || typeof id?.value !== 'string' || !id.value || !id.range) { continue; }
        result.push({ type: entry.type, id: id.value, anchor: typeof anchor === 'string' ? anchor : '',
            start: id.range[0], end: id.range[1], definition: true });
    }
    if (!/<(?:Binding|Research|Quest)(?:Link|Card|Icon)\b/.test(text)) { return result; }
    const document = model ?? createGuideNhDocumentModel(text);
    for (const boundary of document.tagBoundaries) {
        const tag = boundary.tag;
        if (!/^(Binding|Research|Quest)(Link|Card|Icon)$/.test(tag.name) || !tag.attributes.id) { continue; }
        const type = tag.name.startsWith('Research') ? 'thaumcraft' : tag.name.startsWith('Quest') ? 'betterquesting' : tag.attributes.type;
        if (typeof type === 'string' && typeof tag.attributes.id === 'string') { result.push({ type, id: tag.attributes.id, anchor: '', start: tag.attributeRanges.id.start, end: tag.attributeRanges.id.end, definition: false }); }
    }
    return result;
}

export function bindingAtOffset(text: string, offset: number): BindingOccurrence | undefined {
    const occurrence = extractBindingOccurrences(text).find(entry => offset >= entry.start && offset <= entry.end);
    if (!occurrence || occurrence.definition) { return occurrence; }
    const context = findTagContextAtOffset(createGuideNhDocumentModel(text), offset);
    return context?.attribute?.name === 'id' ? occurrence : undefined;
}

export function bindingTypeAtOffset(text: string, offset: number, tagName?: string): string | undefined {
    if (tagName?.startsWith('Research')) { return 'thaumcraft'; }
    if (tagName?.startsWith('Quest')) { return 'betterquesting'; }
    if (tagName?.startsWith('Binding')) { return findOpenTagAttributeValue(text, offset, 'type'); }
    return bindingValueAtOffset(text, offset)?.type ?? bindingAtOffset(text, offset)?.type;
}

export function bindingAnchorOffset(text: string, rawAnchor: string): number | undefined {
    const anchor = rawAnchor.replace(/^#/, '');
    if (!anchor) { return undefined; }
    const normalize = (value: string) => value.trim().toLowerCase().replace(/[\x60*_~]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
    let offset = 0;
    for (const line of text.split('\n')) {
        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading && normalize(heading[1]) === anchor || line.includes('{#' + anchor + '}')
            || new RegExp('\\bid\\s*=\\s*["\']' + anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']').test(line)) { return offset; }
        offset += line.length + 1;
    }
    return undefined;
}

export function bindingLocation(uri: string, text: string, binding: BindingOccurrence, followAnchor = false): Location {
    const anchor = followAnchor ? bindingAnchorOffset(text, binding.anchor) : undefined;
    const document = TextDocument.create(uri, 'markdown', 0, text);
    return Location.create(uri, Range.create(document.positionAt(anchor ?? binding.start), document.positionAt(anchor ?? binding.end)));
}
