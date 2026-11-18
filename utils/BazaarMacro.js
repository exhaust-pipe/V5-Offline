import { ModuleBase } from './ModuleBase';
import requestV2 from './Request';
import { Promise } from './Promise';
import { randomInt } from './Utils';
import { setSignLine } from './Sign';
import { BAZAAR_URL, ITEMS_URL, findBazaarSlot, readBazaarOrders } from './BazaarOrders';
import { GuiStability } from './player/GuiStability';
import { clickSlot, closeInventory } from './player/Inventory';

const MARKET_TIMEOUT = 25_000;
const MARKET_RETRY_DELAY = { low: 30_000, high: 60_000 };
const MAX_MARKET_RETRIES = 3;

let nextCommandAt = 0;
let itemData = null;
let itemsLoadedAt = 0;

export class BazaarMacro extends ModuleBase {
    constructor(options) {
        super({ subcategory: 'Bazaar', isMacro: true, autoDisableOnWorldUnload: true, recoverFromLimbo: false, ...options });
        this.bindToggleKey();
        this.clickDelayRange = { low: 250, high: 450 };
        this.addRangeSlider(
            'Click Delay (ms)',
            50,
            2_000,
            this.clickDelayRange,
            (value) => (this.clickDelayRange = { low: Math.round(value.low), high: Math.round(value.high) }),
            'Random delay before menu clicks.'
        );
        this.inputDelayRange = { low: 250, high: 450 };
        this.addRangeSlider(
            'Input Delay (ms)',
            50,
            2_000,
            this.inputDelayRange,
            (value) => (this.inputDelayRange = { low: Math.round(value.low), high: Math.round(value.high) }),
            'Random delay before commands and sign input.'
        );
        this.orderGuiStability = new GuiStability();
        this.resetActions();
        this.on('tick', () => this.runSafely(() => this.tick()));
        this.on('chat', (event) =>
            this.runSafely(() => this.onChat(ChatLib.removeFormatting(event?.message?.getUnformattedText?.() ?? event?.message?.getString?.() ?? '').trim()))
        );
    }

    resetActions() {
        this.requestToken = (this.requestToken || 0) + 1;
        this.marketRequest = null;
        this.action = null;
        this.status = 'Idle';
        this.nextActionAt = 0;
        this.deadline = 0;
        this.orderGuiStability.reset();
        this.orderSnapshot = null;
        this.orderSnapshotReadyAt = 0;
    }

    runSafely(action) {
        try {
            action();
        } catch (error) {
            this.fail(`Unexpected error: ${error?.message || error}`);
        }
    }

    tick() {
        if (this.deadline && Date.now() >= this.deadline) {
            if (this.marketRequest) return this.retryMarket('Timed out while loading Hypixel Bazaar data.');
            return this.fail(`Timed out while ${this.status.toLowerCase()}.`);
        }
        if (Date.now() >= this.nextActionAt) this.action?.call(this);
    }

    getDelay(range = this.clickDelayRange) {
        if (typeof range === 'number') return Math.max(0, range);
        const low = Number.isFinite(range?.low) ? Math.max(50, Math.round(range.low)) : 250;
        const high = Number.isFinite(range?.high) ? Math.max(50, Math.round(range.high)) : 450;
        return randomInt(Math.min(low, high), Math.max(low, high));
    }

    get clickDelay() {
        return this.runOptions?.clickDelayRange || this.clickDelayRange;
    }

    get inputDelay() {
        return this.runOptions?.inputDelayRange || this.inputDelayRange;
    }

    setAction(action, status, delay = this.clickDelay, timeout = 10_000) {
        this.action = action;
        this.status = status;
        this.nextActionAt = Date.now() + this.getDelay(delay);
        this.deadline = timeout ? this.nextActionAt + timeout : 0;
    }

    clickAndWait(slot, action, status, delay = this.clickDelay, button = 'LEFT') {
        if (!clickSlot(slot, false, button)) return this.fail(`Could not click while ${status.toLowerCase()}.`);
        this.setAction(action, status, delay);
    }

    clickNamed(name, action, status, delay = this.clickDelay) {
        const slot = findBazaarSlot(name, true);
        if (slot !== -1) this.clickAndWait(slot, action, status, delay);
    }

    readOrders() {
        if (!this.orderGuiStability.update()) return null;
        const orders = readBazaarOrders();
        if (!orders) {
            this.orderSnapshot = null;
            return null;
        }
        const snapshot = JSON.stringify(
            orders.map((order) => [order.slot, order.side, order.name, order.amount, order.price, order.completed, order.canClaim, order.claimStateKnown])
        );
        if (snapshot !== this.orderSnapshot) {
            this.orderSnapshot = snapshot;
            this.orderSnapshotReadyAt = Date.now() + 500;
        }
        return Date.now() >= this.orderSnapshotReadyAt ? orders : null;
    }

    commandAndWait(command, action, status) {
        this.setAction(
            () => {
                if (Date.now() < nextCommandAt) return;
                closeInventory();
                this.orderGuiStability.reset();
                this.orderSnapshot = null;
                nextCommandAt = Date.now() + 1_050;
                ChatLib.command(command);
                this.setAction(action, status);
            },
            status,
            this.inputDelay
        );
    }

    enterSign(value, action, status) {
        if (!Client.currentGui?.getClassName?.().includes('Sign')) return;
        this.setAction(
            () => {
                if (!Client.currentGui?.getClassName?.().includes('Sign')) return;
                setSignLine(1, value);
                Client.currentGui.close();
                this.setAction(action, status);
            },
            'Entering sign',
            this.inputDelay
        );
    }

    loadMarket(callback, retries = 0) {
        if (!this.enabled) return;
        const token = ++this.requestToken;
        this.marketRequest = { callback, retries };
        this.setAction(null, 'Loading prices', 0, MARKET_TIMEOUT);
        const failed = () => {
            if (this.enabled && token === this.requestToken) this.retryMarket('Could not load Hypixel Bazaar or item data.');
        };
        try {
            const items =
                itemData && Date.now() - itemsLoadedAt < 3_600_000
                    ? Promise.resolve(itemData)
                    : requestV2({ url: ITEMS_URL, json: true }).then((data) => {
                          if (!data?.success || !Array.isArray(data.items) || !data.items.length) throw new Error('Item data unavailable');
                          if (this.enabled && token === this.requestToken) {
                              itemData = data;
                              itemsLoadedAt = Date.now();
                          }
                          return data;
                      });
            Promise.all([requestV2({ url: BAZAAR_URL, json: true }), items])
                .then(([bazaar, resources]) => {
                    if (!this.enabled || token !== this.requestToken) return;
                    if (
                        !bazaar?.success ||
                        !bazaar.products ||
                        typeof bazaar.products !== 'object' ||
                        Array.isArray(bazaar.products) ||
                        !Object.keys(bazaar.products).length
                    )
                        throw new Error('Bazaar prices unavailable');
                    this.market = { bazaar, items: resources.items, loadedAt: Date.now() };
                    this.marketRequest = null;
                    this.deadline = 0;
                    this.runSafely(() => callback.call(this));
                })
                .catch(failed);
        } catch (error) {
            failed();
        }
    }

    retryMarket(message) {
        const request = this.marketRequest;
        if (!this.enabled || !request) return;
        this.marketRequest = null;
        this.requestToken++;
        if (request.retries >= MAX_MARKET_RETRIES) return this.fail(`${message} Still failing after ${MAX_MARKET_RETRIES} retries.`);
        const retries = request.retries + 1;
        const delay = this.getDelay(MARKET_RETRY_DELAY);
        const status = `Retrying data in ${(delay / 1_000).toFixed(1)}s (${retries}/${MAX_MARKET_RETRIES})`;
        this.message(`&e${message} ${status}.`);
        this.setAction(() => this.loadMarket(request.callback, retries), status, delay, 0);
    }

    onChat() {}

    fail(message) {
        this.message(`&c${message}`);
        this.toggle(false);
    }
}
