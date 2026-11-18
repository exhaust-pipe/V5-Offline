import { BazaarMacro } from '../../utils/BazaarMacro';
import { CANCEL_REQUIRES_CLAIM, clean, findBazaarSlot, lore, marketItem, number, sacksFull, sameOrder, skyblockItemId } from '../../utils/BazaarOrders';
import { MacroState } from '../../utils/MacroState';
import { regrab, ungrab } from '../../utils/Ungrab';
import { setSignLine } from '../../utils/Sign';
import { closeInventory, getGuiName } from '../../utils/player/Inventory';

class BuyOrderToSacks extends BazaarMacro {
    constructor() {
        super({
            name: 'Buy Order to Sacks',
            description: 'Claims Bazaar buy orders into sacks.',
            tooltip: 'Requires Cookie Buff, sacks, and access to /viewstash material. Stops when inventory or sacks cannot accept the items.',
        });
        this.whitelist = null;
        this.blacklist = [];
        this.addTextInput(
            'Item Whitelist',
            '',
            (value) => {
                const entries = String(value).split(',').map(clean).filter(Boolean);
                this.whitelist = entries.length ? entries : null;
            },
            'Exact item names or SkyBlock IDs, separated by commas. Empty means all buy orders.'
        );
        this.addTextInput(
            'Item Blacklist',
            '',
            (value) => (this.blacklist = String(value).split(',').map(clean).filter(Boolean)),
            'Exact names or IDs to skip. Blacklist takes priority.'
        );
        this.pendingFlip = null;
        this.pendingTransfer = null;
        this.createOverlay([{ title: 'Status', data: { State: () => this.status, Item: () => this.target?.name || 'None' } }]);
    }

    start(options = {}, callback = null) {
        if (this.enabled) return false;
        this.startOptions = options;
        this.callback = callback;
        this.toggle(true, true);
        return true;
    }

    cancel() {
        if (this.enabled) this.toggle(false);
    }

    onEnable() {
        this.resetActions();
        this.result = null;
        this.orders = [];
        this.cancelledOrders = [];
        this.verifyingCompletion = false;
        this.completionSnapshot = null;
        this.target = null;
        this.awaitingStash = false;
        this.runOptions = this.startOptions || { whitelist: this.whitelist, blacklist: this.blacklist };
        this.startOptions = null;
        this.allowed = this.runOptions.whitelist == null ? null : new Set(Array.from(this.runOptions.whitelist).map(clean));
        this.blocked = new Set(Array.from(this.runOptions.blacklist || []).map(clean));
        if (!this.isParentManaged && (MacroState.getModule('Gemstone Flip')?.enabled || MacroState.getModule('Bazaar to NPC')?.enabled)) {
            return this.fail('Stop the other Bazaar macro before claiming orders.');
        }
        this.ownsGui = true;
        if (!this.isParentManaged) ungrab();
        this.market = this.runOptions.market || null;
        if (this.market && Date.now() - this.market.loadedAt < 60_000) this.openOrders();
        else this.loadMarket(this.openOrders);
    }

    onDisable() {
        const callback = this.callback;
        const result = this.result || { success: false, reason: 'Cancelled', orders: this.orders };
        this.callback = null;
        this.startOptions = null;
        if (this.pendingFlip?.stage === 'preparing') this.pendingFlip = null;
        this.resetActions();
        if (this.ownsGui) closeInventory();
        if (!this.isParentManaged) {
            if (this.ownsGui) regrab();
            this.message(result.success ? '&aNo matching claimable buy orders remain.' : '&cStopped');
        }
        this.ownsGui = false;
        this.runOptions = null;
        if (typeof callback === 'function') callback(result);
    }

    matches(order) {
        const item = marketItem(this.market?.items || [], order);
        const keys = [clean(order.name), clean(order.id), clean(item?.id)].filter(Boolean);
        return !keys.some((key) => this.blocked.has(key)) && (this.allowed === null || keys.some((key) => this.allowed.has(key)));
    }

    shouldCancel(order) {
        return this.runOptions.cancelOrders && (this.runOptions.cancelBelowPrice == null || order.price + 0.001 < this.runOptions.cancelBelowPrice);
    }

    openOrders() {
        this.commandAndWait('managebazaarorders', this.inspectOrders, 'Opening Bazaar orders');
    }

    inspectOrders(rejectedOrder = null) {
        const orders = this.readOrders();
        if (!orders) return;
        this.orders = orders;
        const transfer = this.pendingTransfer;
        if (transfer) {
            this.verifyingCompletion = false;
            this.target = transfer.order;
            if (!this.matches(this.target)) return this.fail('A previous inventory transfer needs recovery with a matching whitelist.');
            if (transfer.stage === 'stash') return this.openStash();
            if (transfer.stage === 'cancelling' && orders.filter((order) => sameOrder(order, this.target)).length < transfer.beforeCount) {
                this.cancelledOrders.push(this.target);
                transfer.stage = 'cancelled';
            }
            return this.openSacks();
        }
        if (this.pendingFlip) {
            this.verifyingCompletion = false;
            if (!this.matches(this.pendingFlip)) return this.fail('A previous temporary sell offer needs recovery with a matching whitelist.');
            this.target = this.pendingFlip;
            if (this.pendingFlip.stage === 'stash') return this.openStash();
            if (this.pendingFlip.stage === 'inventory') return this.openSacks();
            return this.findTemporaryOffer();
        }
        const matches = rejectedOrder ? orders.filter((order) => sameOrder(order, rejectedOrder) && this.matches(order)) : [];
        const toReclaim =
            matches.find((order) => order.slot === rejectedOrder.slot && order.canClaim) ||
            matches.find((order) => order.canClaim) ||
            (matches.length === 1 ? matches[0] : null);
        this.target =
            toReclaim ||
            orders.find(
                (order) =>
                    order.side === 'buy' &&
                    this.matches(order) &&
                    (this.shouldCancel(order) || (order.canClaim && (!this.runOptions.filledOnly || order.completed)))
            );
        if (!this.target) {
            if (!this.verifyingCompletion || this.completionSnapshot !== this.orderSnapshot) {
                this.verifyingCompletion = true;
                this.completionSnapshot = this.orderSnapshot;
                return this.setAction(this.openOrders, 'Verifying remaining orders', 1_000, 0);
            }
            const unreadable = orders.find((order) => order.side === 'buy' && this.matches(order) && !order.claimStateKnown);
            if (unreadable) return this.fail(`Could not read the claim status of ${unreadable.name}; remaining orders were not confirmed empty.`);
            return this.finish();
        }
        this.verifyingCompletion = false;
        if (this.target.completed && this.target.canClaim) {
            if (Date.now() - this.market.loadedAt >= 5_000) return this.loadMarket(() => this.setAction(this.inspectOrders, 'Checking filled order'));
            return this.prepareFlip();
        }
        if (this.target.canClaim || toReclaim) {
            const inventoryBefore = this.inventoryCount();
            if (!Number.isFinite(inventoryBefore)) return;
            this.pendingTransfer = { order: this.target, stage: 'claiming', inventoryBefore };
            return this.clickAndWait(this.target.slot, this.waitForClaim, 'Claiming items');
        }
        this.openCancellation(this.target);
    }

    inventoryCount() {
        const items = Player.getInventory()?.getItems();
        if (!items || items.length < 36) return NaN;
        return items.slice(0, 36).reduce((total, item) => {
            const matches = clean(item?.getName?.()) === clean(this.target?.name) || (this.target?.id && skyblockItemId(item) === this.target.id);
            return total + (matches ? Number(item?.getStackSize?.() || 0) : 0);
        }, 0);
    }

    waitForClaim() {
        const count = this.inventoryCount();
        if (!Number.isFinite(count)) return;
        if (count > this.pendingTransfer.inventoryBefore) return this.openSacks();
        if (clean(getGuiName()).includes('order options')) return this.openOrders();
        const orders = this.readOrders();
        if (!orders || !this.target.canClaim) return;
        const hasGoods = (order) => sameOrder(order, this.target) && (order.canClaim || !order.claimStateKnown);
        if (orders.filter(hasGoods).length < this.orders.filter(hasGoods).length) this.openOrders();
    }

    openSacks() {
        const transfer = this.pendingTransfer || this.pendingFlip;
        const count = this.inventoryCount();
        if (!Number.isFinite(count)) return;
        const inserting = transfer.stage === 'inventory' || transfer.stage === 'inventoryStash';
        if (count <= (inserting ? 0 : transfer.inventoryBefore)) return this.inventoryDone();
        if (!inserting) transfer.stage = transfer.stage === 'cancelled' ? 'inventoryStash' : 'inventory';
        this.commandAndWait('sacks', this.insertInventory, 'Opening sacks');
    }

    insertInventory() {
        if (!clean(getGuiName()).includes('sack')) return;
        const count = this.inventoryCount();
        if (!Number.isFinite(count)) return;
        if (count === 0) return this.inventoryDone();
        const slot = findBazaarSlot('Insert inventory', true);
        if (slot === -1) return;
        this.transferWaitUntil = Date.now() + 1_000;
        this.clickAndWait(slot, this.waitForInventoryInsert, 'Inserting inventory into sacks');
    }

    waitForInventoryInsert() {
        if (Date.now() < this.transferWaitUntil || this.inventoryCount() !== 0) return;
        this.inventoryDone();
    }

    inventoryDone() {
        if (this.pendingTransfer?.stage === 'inventoryStash') {
            this.pendingTransfer.stage = 'stash';
            return this.openStash();
        }
        this.transferDone();
    }

    prepareFlip() {
        const item = marketItem(this.market.items, this.target);
        const product = this.market.bazaar.products[item?.id];
        const prices = (product?.buy_summary || []).map((offer) => Number(offer.pricePerUnit)).filter((price) => Number.isFinite(price) && price > 0);
        if (!prices.length) return this.fail(`Could not read the lowest buy price for ${this.target.name}.`);
        const price = Number((Math.min(...prices) * 1.2).toFixed(1));
        const offer = { name: this.target.name, id: item.id, side: 'sell', amount: this.target.claimable, price, stage: 'preparing' };
        if (!(price > 0) || !Number.isSafeInteger(offer.amount) || offer.amount <= 0)
            return this.fail('Could not read the filled order quantity or flip price.');
        if (this.orders.some((order) => sameOrder(order, offer)))
            return this.fail('An identical sell offer already exists; cannot safely identify the temporary offer.');
        this.pendingFlip = offer;
        this.pendingFlip.source = this.target;
        this.pendingFlip.sourceCount = this.orders.filter((order) => sameOrder(order, this.target)).length;
        this.clickAndWait(this.target.slot, this.chooseFlip, 'Opening filled order', this.clickDelay, 'RIGHT');
    }

    chooseFlip() {
        if (!clean(getGuiName()).includes('order options')) return;
        this.clickNamed('Flip Order', this.enterFlipPrice, 'Opening flip price');
    }

    enterFlipPrice() {
        if (!Client.currentGui?.getClassName?.().includes('Sign')) return;
        this.setAction(
            () => {
                if (!Client.currentGui?.getClassName?.().includes('Sign')) return;
                setSignLine(1, this.pendingFlip.price.toFixed(1));
                this.pendingFlip.stage = 'offer';
                this.pendingFlip.submittedAt = Date.now();
                Client.currentGui.close();
                this.setAction(this.findTemporaryOffer, 'Finding temporary sell offer');
            },
            'Entering flip price',
            this.inputDelay
        );
    }

    findTemporaryOffer() {
        const orders = this.readOrders();
        if (!orders) return;
        const matches = orders.filter((order) => sameOrder(order, this.pendingFlip));
        if (matches.length > 1) return this.fail('Multiple identical sell offers found; leaving them untouched.');
        if (!matches.length) {
            if (this.pendingFlip.stage === 'claimProceeds' || this.pendingFlip.stage === 'claimingProceeds') return this.transferDone();
            if (this.pendingFlip.stage !== 'cancelling') {
                if (
                    Date.now() - this.pendingFlip.submittedAt > 8_000 &&
                    orders.filter((order) => sameOrder(order, this.pendingFlip.source)).length >= this.pendingFlip.sourceCount
                ) {
                    this.pendingFlip = null;
                    return this.fail('The filled buy order is still open; the temporary sell offer was not created.');
                }
                return;
            }
            this.pendingFlip.stage = 'stash';
            return this.openStash();
        }
        this.target = matches[0];
        this.orders = orders;
        if (this.pendingFlip.stage === 'claimProceeds') {
            this.pendingFlip.stage = 'claimingProceeds';
            return this.clickAndWait(this.target.slot, this.openOrders, 'Claiming temporary sell offer proceeds');
        }
        this.openCancellation(this.target);
    }

    openCancellation(order) {
        this.cancelling = order;
        this.cancelCount = this.orders.filter((entry) => sameOrder(entry, order)).length;
        if (!this.cancelCount || !Number.isFinite(order.price) || !Number.isFinite(order.amount)) return this.fail('Could not identify the order to cancel.');
        this.clickAndWait(order.slot, this.cancelOrder, 'Opening order options', this.clickDelay, 'RIGHT');
    }

    cancelOrder() {
        if (!clean(getGuiName()).includes('order options')) return;
        const slot = findBazaarSlot('Cancel Order', true);
        if (slot === -1) return;
        const inventoryBefore = this.inventoryCount();
        if (!Number.isFinite(inventoryBefore)) return;
        if (this.cancelling.side === 'buy') {
            const remaining = number(
                lore(Player.getContainer()?.getStackInSlot(slot))
                    .join('\n')
                    .match(/([\d,]+)x missing items?/i)?.[1]
            );
            if (!Number.isSafeInteger(remaining) || remaining < 0) return this.fail('Could not read the unfilled quantity before cancelling.');
            this.cancelling = { ...this.cancelling, remaining };
            this.pendingTransfer = { order: this.cancelling, stage: 'cancelling', beforeCount: this.cancelCount, inventoryBefore };
        } else {
            this.pendingFlip.inventoryBefore = inventoryBefore;
            this.pendingFlip.stage = 'cancelling';
        }
        this.clickAndWait(slot, this.waitForCancellation, 'Cancelling order');
    }

    waitForCancellation() {
        const orders = this.readOrders();
        if (!orders || orders.filter((order) => sameOrder(order, this.cancelling)).length >= this.cancelCount) return;
        this.orders = orders;
        this.cancelledOrders.push(this.cancelling);
        if (this.pendingFlip) {
            this.pendingFlip.stage = 'stash';
            return this.openStash();
        }
        this.pendingTransfer.stage = 'cancelled';
        this.setAction(this.openSacks, 'Checking returned items', 0);
    }

    openStash() {
        if (this.pendingFlip && this.inventoryCount() - this.pendingFlip.inventoryBefore >= this.pendingFlip.amount) return this.openSacks();
        this.awaitingStash = true;
        this.stashEmpty = false;
        this.commandAndWait('viewstash material', this.insertStash, 'Opening material stash');
    }

    insertStash() {
        if (this.stashEmpty) return this.stashDone();
        if (!clean(getGuiName()).includes('view stash')) return;
        if (findBazaarSlot('No Materials', true) !== -1) return this.stashDone();
        const slot = findBazaarSlot('Insert Into Sacks', true);
        if (slot === -1) {
            if (findBazaarSlot('Empty Stash', true) !== -1) this.stashDone();
            return;
        }
        this.transferWaitUntil = Date.now() + 1_000;
        this.clickAndWait(slot, this.waitForStashInsert, 'Inserting stash into sacks');
    }

    waitForStashInsert() {
        if (Date.now() < this.transferWaitUntil) return;
        if (this.stashEmpty) return this.stashDone();
        this.commandAndWait('viewstash material', this.verifyStash, 'Verifying material transfer');
    }

    verifyStash() {
        if (this.stashEmpty) return this.stashDone();
        if (!clean(getGuiName()).includes('view stash')) return;
        const items = Player.getContainer()?.getItems() || [];
        if (!items.slice(0, Math.max(0, items.length - 36)).some(Boolean)) return;
        const remaining = items.slice(0, Math.max(0, items.length - 36)).some((item) => {
            const name = clean(item?.getName?.())
                .replace(/^(?:[\d,.]+[x×]|[x×][\d,.]+)\s+/i, '')
                .replace(/\s+(?:[x×][\d,.]+|\([\d,.]+[x×]?\))$/i, '');
            return name === clean(this.target.name) || (this.target.id && skyblockItemId(item) === this.target.id);
        });
        if (remaining) return this.fail(`${this.target.name} remains in the stash; sacks could not accept all items.`);
        this.stashDone();
    }

    stashDone() {
        this.awaitingStash = false;
        if (this.pendingFlip) return this.openSacks();
        this.transferDone();
    }

    transferDone() {
        this.pendingFlip = null;
        this.pendingTransfer = null;
        this.openOrders();
    }

    onChat(message) {
        if (this.action === this.waitForCancellation && message === CANCEL_REQUIRES_CLAIM) {
            if (this.pendingFlip) {
                this.pendingFlip.stage = 'claimProceeds';
                return this.openOrders();
            }
            const rejected = this.cancelling;
            this.pendingTransfer = null;
            return this.commandAndWait('managebazaarorders', () => this.inspectOrders(rejected), 'Rechecking order with new fills');
        }
        if (sacksFull(message)) {
            return this.fail(`Inventory or sacks are full: ${message}`);
        }
        if (this.pendingFlip?.stage === 'offer' && /\[Bazaar\].*(?:not enough coins|can't afford|couldn't afford|cannot afford)/i.test(message)) {
            this.pendingFlip = null;
            return this.fail('Not enough coins to create the temporary sell offer.');
        }
        if (
            this.awaitingStash &&
            /(?:you (?:don't|do not) have (?:any (?:items|materials)|anything).*stash|(?:material )?stash is empty|no (?:items|materials).*stash)/i.test(
                message
            )
        ) {
            this.stashEmpty = true;
        }
    }

    finish() {
        this.result = { success: true, orders: this.orders, cancelledOrders: this.cancelledOrders };
        this.toggle(false);
    }

    fail(reason) {
        this.result = { success: false, reason, orders: this.orders };
        super.fail(reason);
    }
}

export const buyOrderToSacks = new BuyOrderToSacks();
