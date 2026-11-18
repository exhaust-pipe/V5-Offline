import { DataComponents } from './Constants';
import { getGuiName } from './player/Inventory';

export const BAZAAR_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';
export const ITEMS_URL = 'https://api.hypixel.net/v2/resources/skyblock/items';
export const MAX_ORDER_ITEMS = 4096;
export const clean = (value) =>
    ChatLib.removeFormatting(String(value ?? ''))
        .trim()
        .replace(/^[^a-z0-9]+/i, '')
        .toLowerCase();
export const lore = (item) => (item?.getLore?.() || []).map((line) => ChatLib.removeFormatting(String(line)).trim());
export const number = (value) => (value == null ? NaN : Number(String(value).replace(/,/g, '')));
export const sacksFull = (message) =>
    /\[Bazaar\] You don't have the space required to claim that!/i.test(message) ||
    /\bsacks?\b.*\b(?:is|are) full\b/i.test(message) ||
    /\bsacks?\b.*(?:not enough|don't have.*) space/i.test(message);
export const formatCoins = (value) => {
    const unit = [
        { minimum: 1e6, suffix: 'M' },
        { minimum: 1e3, suffix: 'K' },
    ].find(({ minimum }) => Math.abs(value) >= minimum);
    return unit ? `${(value / unit.minimum).toFixed(2)}${unit.suffix}` : Math.round(value).toLocaleString();
};

export function skyblockItemId(item) {
    let data = '';
    try {
        data = String(item?.toMC?.()?.get?.(DataComponents.CUSTOM_DATA)?.copyTag?.() || '');
    } catch (error) {}
    if (!data) data = String(item?.getNBT?.() || '');
    return data.match(/\bid\s*[:=]\s*"?([^",}\s]+)/i)?.[1] || null;
}

export function findBazaarSlot(name, exact = false) {
    const items = Player.getContainer()?.getItems() || [];
    const target = clean(name);
    for (let slot = 0; slot < Math.max(0, items.length - 36); slot++) {
        const itemName = clean(items[slot]?.getName?.());
        if ((exact && itemName === target) || (!exact && itemName.includes(target))) return slot;
    }
    return -1;
}

export function unitPrice(item) {
    const line = lore(item).find((value) => /^(?:price per unit|unit price):\s*[\d,.]+/i.test(value));
    return number(line?.match(/[\d,.]+/)?.[0]);
}

export function topBuyOrderPrice(item) {
    const prices = lore(item)
        .map((line) => number(line.match(/^- ([\d,.]+) coins? each\b/i)?.[1]))
        .filter(Number.isFinite);
    return prices.length ? Math.max(...prices) : NaN;
}

export function readBazaarOrders() {
    if (!clean(getGuiName()).includes('bazaar orders')) return null;
    const items = Player.getContainer()?.getItems() || [];
    const menu = items.slice(0, Math.max(0, items.length - 36));
    if (!menu.some(Boolean)) return null;
    return menu.map((item, slot) => readBazaarOrder(item, slot)).filter(Boolean);
}

function readBazaarOrder(item, slot) {
    const name = ChatLib.removeFormatting(String(item?.getName?.() || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[^a-z0-9]+/i, '');
    const match = name.match(/^(buy|sell)\s+(.+)$/i);
    if (!match) return null;
    const lines = lore(item).map((line) => line.replace(/\s+/g, ' ').trim());
    const filledLine = lines.find((line) => /^filled\s*:/i.test(line)) || '';
    const filled = filledLine.match(/([\d,]+)x?\s*\/\s*([\d,]+)x?/i);
    const amountLine = lines.find((line) => /^(?:(?:order|offer)\s+)?amount\s*:/i.test(line));
    const amount = number(amountLine?.match(/[\d,]+/)?.[0] ?? filled?.[2]);
    const filledAmount = number(filled?.[1]);
    const completed = /\b100(?:\.0+)?\s*%/.test(filledLine) || (filledAmount >= amount && amount > 0);
    const claimLine = lines.find((line) => /\byou have\b.*\bto claim\b|^(?:claimable(?: items?)?|items? to claim)\s*:/i.test(line));
    const claim =
        claimLine?.match(/\byou have\s+([\d,]+)(?:x)?\s+(?:items?|units?)\s+to claim\b/i) ||
        claimLine?.match(/^(?:claimable(?: items?)?|items? to claim)\s*:\s*([\d,]+)/i);
    const nothingToClaim = lines.some(
        (line) =>
            /\b(?:no items?|nothing)\s+(?:(?:left|available)\s+)?to claim\b/i.test(line) ||
            /\byou (?:don't|do not) have (?:any items?|anything)\s+(?:available\s+)?to claim\b/i.test(line) ||
            /^(?:claimable(?: items?)?|items? to claim)\s*:\s*(?:none|nothing)\b/i.test(line)
    );
    const claimPrompt = lines.some((line) => /\b(?:left[- ]?)?click\b.*\bclaim\b/i.test(line) && !/\b(?:cannot|can't|nothing|no items?)\b/i.test(line));
    const claimedLine = lines.find((line) => /^claimed\s*:/i.test(line));
    const claimed = number(claimedLine?.match(/[\d,]+/)?.[0]);
    const knownRemaining = Number.isFinite(filledAmount) && Number.isFinite(claimed);
    const claimable = claim
        ? number(claim[1])
        : nothingToClaim
          ? 0
          : knownRemaining
            ? Math.max(0, filledAmount - claimed)
            : completed
              ? amount
              : claimPrompt || claimLine
                ? NaN
                : 0;
    const canClaim = Number.isFinite(claimable) ? claimable > 0 : claimPrompt || !!claimLine;
    const price = unitPrice(item);
    const idleOrder =
        Number.isSafeInteger(amount) && amount > 0 && Number.isFinite(price) && price > 0 && !lines.some((line) => /\bclaim(?:able)?\b/i.test(line));
    const claimStateKnown =
        !!claim || nothingToClaim || knownRemaining || completed || claimPrompt || !!claimLine || (Number.isFinite(filledAmount) && amount > 0) || idleOrder;
    return {
        slot,
        side: match[1].toLowerCase(),
        id: skyblockItemId(item),
        name: match[2],
        amount,
        price,
        completed,
        claimable,
        canClaim,
        claimStateKnown,
    };
}

export function marketItem(items, order) {
    const byId = items.find((item) => item.id === order.id && clean(item.name) === clean(order.name));
    if (byId) return byId;
    const matches = items.filter((item) => clean(item.name) === clean(order.name));
    return matches.length === 1 ? matches[0] : null;
}

export function sameOrder(a, b) {
    return a.side === b.side && clean(a.name) === clean(b.name) && Math.abs(a.price - b.price) < 0.001 && a.amount === b.amount;
}

export function estimateNpcFlip(product, npcPrice, maxSpend, maxItems = MAX_ORDER_ITEMS) {
    const prices = (product?.sell_summary || []).map((order) => Number(order.pricePerUnit)).filter((price) => Number.isFinite(price) && price > 0);
    if (!prices.length) return null;
    const orderPrice = Math.round((Math.max(...prices) + 0.1) * 10) / 10;
    const halfHourVolume = Math.floor(Number(product.quick_status?.sellMovingWeek || 0) / (7 * 24 * 2));
    const quantity = Math.min(maxItems, Math.floor(maxSpend / orderPrice), halfHourVolume);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    const profit = (npcPrice - orderPrice) * quantity;
    return {
        orderPrice,
        expectedOrderPrice: orderPrice,
        quantity,
        profit,
        profitPercent: ((npcPrice - orderPrice) / npcPrice) * 100,
        profitPerHour: profit * 2,
    };
}
