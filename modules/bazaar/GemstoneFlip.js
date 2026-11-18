import { ToggleButton } from '../../gui/components/Toggle';
import { BazaarMacro } from '../../utils/BazaarMacro';
import {
    clean,
    estimateNpcFlip,
    findBazaarSlot,
    formatCoins,
    lore,
    marketItem,
    number,
    sacksFull,
    topBuyOrderPrice,
    unitPrice,
} from '../../utils/BazaarOrders';
import { chat } from '../../utils/Chat';
import { MacroState } from '../../utils/MacroState';
import { regrab, ungrab } from '../../utils/Ungrab';
import { v5Command } from '../../utils/V5Commands';
import { closeInventory, getGuiName } from '../../utils/player/Inventory';
import { buyOrderToSacks } from './BuyOrderToSacks';

const GEMSTONES = ['Amber', 'Amethyst', 'Jade', 'Jasper', 'Ruby', 'Sapphire', 'Topaz', 'Opal', 'Aquamarine', 'Citrine', 'Onyx', 'Peridot'];
const QUALITIES = ['Rough', 'Flawed', 'Fine', 'Flawless'];

class GemstoneFlip extends BazaarMacro {
    constructor() {
        super({
            name: 'Gemstone Flip',
            description: 'Places profitable gemstone buy orders and collects them into sacks.',
            tooltip: 'Ranks orders by estimated Item Profit/hr using NPC value. Requires Cookie Buff and gemstone sacks. Items stay in sacks for you to sell.',
        });
        this.selectTypes = false;
        this.types = new Set(GEMSTONES);
        this.qualities = new Set(QUALITIES.slice(1));
        this.addToggle(
            'Specify Gemstone Types',
            (value) => {
                this.selectTypes = !!value;
                typeSettings.visible = this.selectTypes;
                if (!value && typeSettings.isOpen) typeSettings.toggleOpen(false, false);
            },
            'Only buy enabled types from Gemstone Types when this is on.'
        );
        const typeSettings = this.addPopup('Gemstone Types', null, 'Select which of the twelve gemstone types to buy.');
        typeSettings.visible = false;
        GEMSTONES.forEach((type) => {
            typeSettings.addComponent(
                new ToggleButton(
                    type,
                    0,
                    0,
                    undefined,
                    undefined,
                    (value) => {
                        if (value) this.types.add(type);
                        else this.types.delete(type);
                    },
                    true
                )
            );
        });
        QUALITIES.forEach((quality) => {
            this.addToggle(
                `Buy ${quality}`,
                (value) => {
                    if (value) this.qualities.add(quality);
                    else this.qualities.delete(quality);
                },
                `Buy ${quality.toLowerCase()} gemstones.`,
                quality !== 'Rough'
            );
        });
        this.minProfitPercent = 5;
        this.addSlider('Minimum Profit (%)', 0, 100, 5, (value) => (this.minProfitPercent = value), 'Minimum profit as a percentage of NPC sell value.');
        this.maxOrders = 14;
        this.addSlider('Order Limit', 14, 28, 14, (value) => (this.maxOrders = Math.round(value)), 'Maximum active Bazaar orders, including unrelated orders.');
        this.maxSpend = 5_000_000;
        this.addSlider('Maximum Order Spend (M)', 0.1, 100, 5, (value) => (this.maxSpend = value * 1_000_000), 'Maximum coins committed to each order.');
        this.checkInterval = { low: 30, high: 60 };
        this.addRangeSlider(
            'Price Check Interval (s)',
            10,
            120,
            this.checkInterval,
            (value) => {
                this.checkInterval = { low: Math.round(value.low), high: Math.round(value.high) };
            },
            'Random wait between price checks. Partial fills are collected only when their orders are outbid.'
        );
        this.managedNames = new Set();
        this.cleanupNames = null;
        this.cleanupOnEnable = false;
        this.collecting = false;
        this.orders = [];
        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => (this.collecting ? buyOrderToSacks.status : this.status),
                    'Active Orders': () =>
                        `${this.orders.filter((order) => order.side === 'buy' && this.managedNames.has(clean(order.name))).length}/${this.maxOrders}`,
                    'Next Price Check': () => (this.checkingPrices ? 'Checking' : `${Math.max(0, Math.ceil((this.nextPriceCheckAt - Date.now()) / 1_000))}s`),
                },
            },
            {
                title: 'Item',
                data: {
                    Item: () => this.target?.name || 'None',
                    'Item Profit/hr': () => `${formatCoins(this.target?.profitPerHour || 0)} coins`,
                    'Profit %': () => `${(this.target?.profitPercent || 0).toFixed(2)}%`,
                },
            },
        ]);
        v5Command('bazaar gemstone cleanup', () => this.startCleanup());
    }

    selectedGems() {
        const gems = [];
        for (const quality of QUALITIES) {
            if (!this.qualities.has(quality)) continue;
            for (const type of GEMSTONES) {
                if (this.selectTypes && !this.types.has(type)) continue;
                gems.push({ id: `${quality}_${type}_GEM`.toUpperCase(), name: `${quality} ${type} Gemstone` });
            }
        }
        return gems;
    }

    scopeNames() {
        return Array.from(new Set([...this.managedNames, ...this.selectedGems().map((item) => clean(item.name))]));
    }

    onEnable() {
        this.resetActions();
        this.cleanupMode = this.cleanupOnEnable;
        this.cleanupOnEnable = false;
        this.cleanupFinished = false;
        this.collecting = false;
        this.orders = [];
        this.target = null;
        this.orderQueue = [];
        this.checkQueue = [];
        this.skippedIds = new Set();
        this.relistQuantities = new Map();
        this.guiPrices = new Map();
        this.placementBlockedUntil = 0;
        this.orderLimitReached = false;
        this.nextPriceCheckAt = 0;
        this.checkingPrices = true;
        if (buyOrderToSacks.enabled || MacroState.getModule('Bazaar to NPC')?.enabled)
            return this.fail('Stop the other Bazaar macro before starting Gemstone Flip.');
        this.ownsGui = true;
        ungrab();
        if (this.cleanupMode) {
            this.loadMarket(() => this.collectOrders({ whitelist: this.cleanupNames || this.scopeNames(), cancelOrders: true }, this.finishCleanup));
        } else {
            this.beginPriceCheck();
        }
    }

    onDisable() {
        this.cleanupNames = this.cleanupFinished ? null : this.cleanupNames || this.scopeNames();
        if (this.collecting) buyOrderToSacks.cancel();
        this.collecting = false;
        this.resetActions();
        if (this.ownsGui) {
            closeInventory();
            regrab();
            this.ownsGui = false;
        }
        this.message(this.cleanupFinished ? '&aCleanup complete; gemstone items are in sacks.' : '&cDisabled');
        if (!this.cleanupFinished) this.offerCleanup();
    }

    startCleanup() {
        if (this.enabled) return this.message('&eStop Gemstone Flip before starting cleanup.');
        this.cleanupOnEnable = true;
        this.toggle(true);
    }

    offerCleanup() {
        chat(
            new TextComponent(
                { text: `${this.name}: `, color: '#5fb0ff' },
                {
                    text: '[Clean up gemstone orders]',
                    color: 'yellow',
                    underline: true,
                    clickEvent: { action: 'run_command', value: '/v5 bazaar gemstone cleanup' },
                    hoverEvent: {
                        action: 'show_text',
                        value: 'Claim and cancel only the selected/managed gemstone buy orders, and move their items into sacks.',
                    },
                }
            )
        );
    }

    finishCleanup() {
        this.cleanupFinished = true;
        this.managedNames.clear();
        this.toggle(false);
    }

    collectOrders(options, next) {
        this.collecting = true;
        this.setAction(null, 'Collecting orders into sacks', 0, 0);
        const started = buyOrderToSacks.start(
            {
                whitelist: this.scopeNames(),
                filledOnly: true,
                market: this.market,
                clickDelayRange: this.clickDelayRange,
                inputDelayRange: this.inputDelayRange,
                ...options,
            },
            (result) => {
                this.collecting = false;
                if (!this.enabled) return;
                if (!result.success) return this.fail(result.reason || 'Could not move orders into sacks.');
                this.updateOrders(result.orders);
                for (const order of result.cancelledOrders || []) {
                    if (order.side !== 'buy') continue;
                    const name = clean(order.name);
                    this.relistQuantities.set(name, (this.relistQuantities.get(name) || 0) + order.remaining);
                }
                this.setAction(next, 'Resuming Gemstone Flip', this.clickDelay, 0);
            }
        );
        if (!started) {
            this.collecting = false;
            this.fail('Buy Order to Sacks is already busy.');
        }
    }

    updateOrders(orders) {
        if (orders.length < this.orders.length) this.orderLimitReached = false;
        this.orders = orders;
        const selected = new Set(this.selectedGems().map((item) => clean(item.name)));
        for (const order of orders) {
            if (order.side === 'buy' && selected.has(clean(order.name))) this.managedNames.add(clean(order.name));
        }
    }

    beginPriceCheck() {
        this.checkingPrices = true;
        this.skippedIds.clear();
        this.relistQuantities.clear();
        this.guiPrices.clear();
        this.cleanupNames = null;
        for (const gem of this.selectedGems()) this.managedNames.add(clean(gem.name));
        this.loadMarket(() => this.collectOrders({ filledOnly: true }, this.prepareOrderChecks));
    }

    prepareOrderChecks() {
        const names = new Set(this.scopeNames());
        this.checkQueue = Array.from(
            new Set(this.orders.filter((order) => order.side === 'buy' && names.has(clean(order.name))).map((order) => clean(order.name)))
        );
        this.checkNextOrder();
    }

    checkNextOrder() {
        const name = this.checkQueue.shift();
        if (!name) return this.fillFreeSlots();
        const orders = this.orders.filter((order) => order.side === 'buy' && clean(order.name) === name);
        if (!orders.length) return this.setAction(this.checkNextOrder, 'Checking next order');
        const item = marketItem(this.market.items, orders[0]);
        if (!item) return this.setAction(this.checkNextOrder, 'Checking next order');
        this.target = { name: orders[0].name, id: item.id, orders };
        this.commandAndWait(`bz ${this.target.name}`, this.openCheckProduct, 'Checking gemstone price');
    }

    openCheckProduct() {
        if (!clean(getGuiName()).includes('bazaar')) return;
        this.clickNamed(this.target.name, this.checkProductOrder, 'Reading buy orders');
    }

    checkProductOrder() {
        const slot = findBazaarSlot('Create Buy Order', true);
        if (slot === -1) return;
        const topPrice = topBuyOrderPrice(Player.getContainer()?.getStackInSlot(slot));
        if (!Number.isFinite(topPrice)) return;
        this.guiPrices.set(this.target.id, Math.round((topPrice + 0.1) * 10) / 10);
        const orders = this.target.orders;
        if (orders.some((order) => topPrice > order.price + 0.001)) {
            return this.cancelTargetOrders(topPrice);
        }
        this.setAction(this.checkNextOrder, 'Checking next order');
    }

    cancelTargetOrders(topPrice) {
        this.message(`&eCollecting outbid buy orders for ${this.target.name}.`);
        this.collectOrders({ whitelist: [this.target.name], cancelOrders: true, cancelBelowPrice: topPrice }, this.checkNextOrder);
    }

    candidate(gem) {
        const item = this.market.items.find((entry) => entry.id === gem.id);
        const npcPrice = Number(item?.npc_sell_price);
        if (!item || !(npcPrice > 0)) return null;
        const maxItems = gem.id.startsWith('FLAWLESS_') ? 256 : 71_680;
        const estimate = estimateNpcFlip(this.market.bazaar.products[gem.id], npcPrice, this.maxSpend, maxItems);
        if (!estimate) return null;
        const price = this.guiPrices.get(gem.id) ?? estimate.orderPrice;
        const remaining = this.relistQuantities.get(clean(gem.name));
        const quantity = Math.min(estimate.quantity, Math.floor(this.maxSpend / price), remaining ?? estimate.quantity);
        if (quantity <= 0 || !this.profitable(npcPrice, price)) return null;
        const profit = (npcPrice - price) * quantity;
        return {
            ...gem,
            npcPrice,
            orderPrice: price,
            expectedOrderPrice: price,
            quantity,
            profit,
            profitPerHour: profit * 2,
            profitPercent: ((npcPrice - price) / npcPrice) * 100,
        };
    }

    profitable(npcPrice, price) {
        return Number.isFinite(price) && price > 0 && npcPrice > price && ((npcPrice - price) / npcPrice) * 100 >= this.minProfitPercent;
    }

    safePrice(price) {
        return (
            this.profitable(this.target.npcPrice, price) &&
            price * this.target.quantity <= this.maxSpend &&
            price <= this.target.expectedOrderPrice + Math.max(1, this.target.expectedOrderPrice * 0.05)
        );
    }

    fillFreeSlots() {
        const active = new Set(this.orders.filter((order) => order.side === 'buy').map((order) => clean(order.name)));
        const freeSlots = Math.max(0, this.maxOrders - this.orders.length);
        this.orderQueue = this.selectedGems()
            .filter((gem) => !active.has(clean(gem.name)) && !this.skippedIds.has(gem.id))
            .map((gem) => this.candidate(gem))
            .filter(Boolean)
            .sort((a, b) => b.profitPerHour - a.profitPerHour || b.profitPercent - a.profitPercent)
            .slice(0, freeSlots);
        if (this.orderLimitReached || Date.now() < this.placementBlockedUntil) this.orderQueue = [];
        this.placeNextOrder();
    }

    placeNextOrder() {
        this.target = this.orderQueue.shift() || null;
        if (!this.target) return this.finishCycle();
        this.managedNames.add(clean(this.target.name));
        this.message(
            `Ordering &b${this.target.quantity.toLocaleString()}x ${this.target.name}&f; estimated &6${formatCoins(this.target.profitPerHour)} coins/hr&f.`
        );
        this.commandAndWait(`bz ${this.target.name}`, this.openProduct, 'Opening gemstone');
    }

    openProduct() {
        if (!clean(getGuiName()).includes('bazaar')) return;
        this.clickNamed(this.target.name, this.chooseBuyOrder, 'Selecting gemstone');
    }

    chooseBuyOrder() {
        this.clickNamed('Create Buy Order', this.chooseAmount, 'Selecting buy order');
    }

    chooseAmount() {
        const slot = findBazaarSlot('Custom Amount', true);
        if (slot === -1) return;
        const limit = number(
            lore(Player.getContainer()?.getStackInSlot(slot))
                .join('\n')
                .match(/buy up to ([\d,]+)x/i)?.[1]
        );
        if (limit > 0) this.target.quantity = Math.min(this.target.quantity, limit);
        this.clickAndWait(slot, this.enterAmount, 'Opening order amount');
    }

    enterAmount() {
        this.enterSign(this.target.quantity, this.choosePrice, 'Selecting order price');
    }

    choosePrice() {
        const slot = findBazaarSlot('Top Order +0.1', true);
        if (slot === -1) return;
        const item = Player.getContainer()?.getStackInSlot(slot);
        if (lore(item).some((line) => /can't afford/i.test(line))) return this.skipTarget('Not enough coins for this order.');
        const price = unitPrice(item);
        if (!this.safePrice(price)) return this.skipTarget('The live price is no longer profitable or moved too far from the estimate.');
        this.target.orderPrice = price;
        this.clickAndWait(slot, this.confirmOrder, 'Confirming buy order');
    }

    confirmOrder() {
        if (!clean(getGuiName()).includes('confirm buy order')) return;
        const slot = findBazaarSlot('Buy Order', true);
        if (slot === -1) return;
        const price = unitPrice(Player.getContainer()?.getStackInSlot(slot));
        if (!this.safePrice(price)) return this.skipTarget('The confirmation price is no longer safe.');
        this.target.orderPrice = price;
        this.target.profit = (this.target.npcPrice - price) * this.target.quantity;
        this.target.profitPerHour = this.target.profit * 2;
        this.target.profitPercent = ((this.target.npcPrice - price) / this.target.npcPrice) * 100;
        this.confirmSlot = slot;
        this.clickAndWait(slot, this.awaitOrderCreated, 'Creating buy order');
    }

    awaitOrderCreated() {
        if (clean(Player.getContainer()?.getStackInSlot(this.confirmSlot)?.getName?.()) === 'warning') {
            this.setAction(this.waitForWarning, 'Waiting for Bazaar warning');
        }
    }

    waitForWarning() {
        if (!clean(getGuiName()).includes('confirm buy order')) return;
        if (clean(Player.getContainer()?.getStackInSlot(this.confirmSlot)?.getName?.()) !== 'buy order') return;
        this.clickAndWait(this.confirmSlot, this.awaitOrderCreated, 'Creating buy order');
    }

    skipTarget(reason) {
        this.message(`&eSkipping ${this.target.name}: ${reason}`);
        this.skippedIds.add(this.target.id);
        this.setAction(this.placeNextOrder, 'Skipping gemstone');
    }

    finishCycle() {
        if (this.checkingPrices) {
            this.checkingPrices = false;
            this.nextPriceCheckAt = Date.now() + this.getDelay({ low: this.checkInterval.low * 1_000, high: this.checkInterval.high * 1_000 });
        }
        closeInventory();
        this.setAction(this.monitorOrders, 'Waiting for filled orders', 2_000, 0);
    }

    monitorOrders() {
        if (Date.now() >= this.nextPriceCheckAt) return this.beginPriceCheck();
        this.commandAndWait('managebazaarorders', this.inspectFills, 'Checking filled orders');
    }

    inspectFills() {
        const orders = this.readOrders();
        if (!orders) return;
        this.updateOrders(orders);
        const names = new Set(this.scopeNames());
        if (orders.some((order) => order.side === 'buy' && order.completed && order.canClaim && names.has(clean(order.name)))) {
            return this.collectOrders({ filledOnly: true }, this.fillFreeSlots);
        }
        this.finishCycle();
    }

    onChat(message) {
        if (this.collecting) return;
        if (sacksFull(message)) return this.fail(`Inventory or sacks are full: ${message}`);
        if (/\[Bazaar\] You reached your maximum of [\d,]+ Bazaar orders!/i.test(message)) {
            this.orderLimitReached = true;
            this.orderQueue = [];
            return this.finishCycle();
        }
        if (message.includes('[Bazaar] Placing orders is on cooldown')) {
            this.placementBlockedUntil = Date.now() + 60_000;
            this.orderQueue = [];
            return this.finishCycle();
        }
        if (this.action !== this.awaitOrderCreated && this.action !== this.waitForWarning) return;
        if (message.includes('[Bazaar] Buy Order Setup!')) {
            this.orders.push({ ...this.target, side: 'buy', price: this.target.orderPrice, amount: this.target.quantity, completed: false, claimable: 0 });
            this.relistQuantities.delete(clean(this.target.name));
            this.setAction(this.placeNextOrder, 'Placing next order');
        } else if (/not enough coins|couldn't afford|cannot afford/i.test(message)) {
            this.skipTarget('Not enough coins for this order.');
        }
    }
}

new GemstoneFlip();
