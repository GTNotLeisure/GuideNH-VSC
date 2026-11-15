export interface ItemStackDropPayload {
	id: string;
	source: 'picker-apply' | 'picker-entry' | 'picker-preview';
	capability?: 'items' | 'fluids';
}

export const GuideNhItemStackDropMime = 'application/vnd.guidenh.itemstack+json';

export function createItemStackDropPayload(id: string, source: ItemStackDropPayload['source'], capability: 'items' | 'fluids' = 'items'): string {
	return JSON.stringify({
		id,
		source,
		capability
	} satisfies ItemStackDropPayload);
}

export function parseItemStackDropPayload(value: string): ItemStackDropPayload | undefined {
	try {
		const payload = JSON.parse(value) as Partial<ItemStackDropPayload>;
		if (typeof payload.id !== 'string' || payload.id.trim().length === 0 || payload.id.length > 512) {
			return undefined;
		}
		if (payload.source !== 'picker-apply' && payload.source !== 'picker-entry' && payload.source !== 'picker-preview') {
			return undefined;
		}
		if (payload.capability !== undefined && payload.capability !== 'items' && payload.capability !== 'fluids') {
			return undefined;
		}
		return {
			id: payload.id,
			source: payload.source,
			capability: payload.capability ?? 'items'
		};
	} catch {
		return undefined;
	}
}
