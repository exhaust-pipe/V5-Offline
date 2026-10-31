import { ModuleBase } from '../../utils/ModuleBase';
import { manager } from '../../utils/SkyblockEvents';
import { clickSlot, closeInventory, getGuiName } from '../../utils/player/Inventory';

const EXTENDED_BOOK_LEVELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const ACTION_TIMEOUT_MS = 5000;

class AutoCombine extends ModuleBase {
    constructor() {
        super({
            name: 'Auto Combine',
            subcategory: 'Other',
            description: 'Automatically combine items in your inventory with an anvil.',
            tooltip: 'Open an anvil manually or use /anvil to combine items in your inventory.',
            theme: '#f1a64b',
            showEnabledToggle: false,
            autoDisableOnWorldUnload: true,
            ignoreFailsafes: true,
        });
        this.bindToggleKey();

        this.STATES = {
            OPEN_ANVIL: 'OPEN_ANVIL',
            WAIT_ANVIL: 'WAIT_ANVIL',
            SEARCH_PAIR: 'SEARCH_PAIR',
            FIRST_BOOK: 'FIRST_BOOK',
            SECOND_BOOK: 'SECOND_BOOK',
            COMBINE_BOOKS: 'COMBINE_BOOKS',
            EXTRACT_BOOK: 'EXTRACT_BOOK',
            WAIT_INVENTORY: 'WAIT_INVENTORY',
        };

        this.state = this.STATES.OPEN_ANVIL;
        this.first = null;
        this.second = null;
        this.resultBook = null;
        this.inventoryBookCount = 0;
        this.deadline = 0;
        this.stuckCount = 0;
        this.stuckLimit = 3;
        this.autoRetry = true;
        this.useAnvilCommand = true;
        this.enableLevelTenBooks = false;
        this.tickCounter = 0;

        this.addToggle(
            'Support Level 10 Books',
            (value) => (this.enableLevelTenBooks = !!value),
            'Combines books up to level 10. Do not enable if your using normal level 5 capped books.',
            false
        );
        this.addSlider(
            'Stuck Limit',
            0,
            10,
            3,
            (value) => (this.stuckLimit = Math.floor(value)),
            'Stops after this many stuck detections per run, even with Auto Retry enabled. 0 disables the limit.'
        );
        this.addToggle(
            'Auto Retry',
            (value) => (this.autoRetry = !!value),
            'Retries after getting stuck until Stuck Limit is reached. When disabled, stops on the first stuck detection.',
            true
        );

        this.on('tick', () => this.onTick());
        manager.subscribe('noboostercookie', () => {
            if (!this.enabled || this.state !== this.STATES.WAIT_ANVIL || !this.useAnvilCommand) return;
            this.useAnvilCommand = false;
            this.resetTimeout();
            this.message('&eCannot use /anvil. Open an anvil manually to continue.');
        });
    }

    onTick() {
        if (!this.enabled) return;
        this.tickCounter = (this.tickCounter + 1) % 5;
        if (this.tickCounter !== 1) return;
        switch (this.state) {
            case this.STATES.OPEN_ANVIL:
                this.openAnvil();
                break;
            case this.STATES.WAIT_ANVIL:
                this.waitForAnvil();
                break;
            case this.STATES.SEARCH_PAIR:
                this.searchForNextPair();
                break;
            case this.STATES.FIRST_BOOK:
                this.clickFirstBook();
                break;
            case this.STATES.SECOND_BOOK:
                this.clickSecondBook();
                break;
            case this.STATES.COMBINE_BOOKS:
                this.clickCombine();
                break;
            case this.STATES.EXTRACT_BOOK:
                this.clickExtractItem();
                break;
            case this.STATES.WAIT_INVENTORY:
                this.waitForInventory();
                break;
        }
    }

    openAnvil() {
        if (getGuiName() === 'Anvil') return this.setState(this.STATES.SEARCH_PAIR);

        this.setState(this.STATES.WAIT_ANVIL);
        if (this.useAnvilCommand) ChatLib.command('anvil');
        else this.message('&eOpen an anvil manually to continue.');
    }

    waitForAnvil() {
        if (getGuiName() === 'Anvil') this.setState(this.STATES.SEARCH_PAIR);
        else if (this.useAnvilCommand) this.timeout();
    }

    getAnvilItems() {
        const container = Player.getContainer();
        return getGuiName() === 'Anvil' ? container.getItems() : null;
    }

    searchForNextPair() {
        const items = this.getAnvilItems();
        if (!items) {
            this.setState(this.STATES.OPEN_ANVIL);
            return;
        }

        const controlLore = items[22]?.getLore()?.join('') || '';
        if (controlLore.includes('Claim the result')) return this.setState(this.STATES.EXTRACT_BOOK);
        if (!controlLore.includes('left and right') || items[29] || items[33]) return this.timeout();

        const pair = this.findNextCombinePair(items);
        if (!pair) {
            this.message('No combineable pair found');
            closeInventory();
            this.toggle(false);
            return;
        }

        [this.first, this.second] = pair;
        this.setState(this.STATES.FIRST_BOOK);
    }

    clickFirstBook() {
        const items = this.getAnvilItems();
        if (!items || !this.first) return this.timeout();
        if (!items[22]?.getLore()?.join('')?.includes('left and right') || items[29] || items[33]) return this.timeout();
        if (this.getBook(items[this.first.slot])?.key !== this.first.key) return this.timeout();

        this.inventoryBookCount = this.countBooks(this.getInventoryBooks(items), this.first.key);
        if (!clickSlot(this.first.slot, true)) return this.timeout();
        this.setState(this.STATES.SECOND_BOOK);
    }

    clickSecondBook() {
        const items = this.getAnvilItems();
        if (!items || !this.first) return this.timeout();
        if (this.getBook(items[29])?.key !== this.first.key || items[33]) return this.timeout();

        const books = this.getInventoryBooks(items);
        const remaining = this.countBooks(books, this.first.key);
        if (remaining >= this.inventoryBookCount) return this.timeout();

        this.second = books.find((book) => book.key === this.first.key);
        if (!this.second) return this.timeout();

        if (!clickSlot(this.second.slot, true)) return this.timeout();
        this.inventoryBookCount = remaining;
        this.setState(this.STATES.COMBINE_BOOKS);
    }

    clickCombine() {
        const items = this.getAnvilItems();
        if (!items || !this.first || !this.second) return this.timeout();
        if (this.getBook(items[29])?.key !== this.first.key || this.getBook(items[33])?.key !== this.second.key) return this.timeout();
        if (this.countBooks(this.getInventoryBooks(items), this.second.key) >= this.inventoryBookCount) return this.timeout();

        const combineItem = items[22];
        if (!combineItem?.getLore()?.join('')?.includes('Cost')) return this.timeout();

        if (!clickSlot(22)) return this.timeout();
        this.setState(this.STATES.EXTRACT_BOOK);
    }

    clickExtractItem() {
        const items = this.getAnvilItems();
        if (!items) return this.timeout();

        const result = this.getBook(items[13]);
        if (!result) return this.timeout();
        if (!items[22]?.getLore()?.join('')?.includes('Claim the result')) return this.timeout();

        this.resultBook = result;
        this.inventoryBookCount = this.countBooks(this.getInventoryBooks(items), result.key);
        if (!clickSlot(13, true)) return this.timeout();
        this.setState(this.STATES.WAIT_INVENTORY);
    }

    waitForInventory() {
        const items = this.getAnvilItems();
        if (!items || !this.resultBook) return this.timeout();
        if (this.getBook(items[13]) || items[29] || items[33]) return this.timeout();
        if (this.countBooks(this.getInventoryBooks(items), this.resultBook.key) <= this.inventoryBookCount) return this.timeout();

        this.reset();
    }

    getInventoryBooks(items) {
        const books = [];
        const size = items.length;
        for (let slot = Math.max(0, size - 36); slot < size; slot++) {
            const book = this.getBook(items[slot]);
            if (book) books.push({ ...book, slot });
        }
        return books;
    }

    getBook(item) {
        if (!item?.getName()?.includes('Enchanted Book')) return null;

        const data = (item.getLore() || []).map((line) => this.getBookData(String(line))).find((book) => book);
        return data ? { ...data, key: `${data.type}|${data.level}`, count: item.getStackSize() } : null;
    }

    countBooks(books, key) {
        return books.reduce((count, book) => count + (book.key === key ? book.count : 0), 0);
    }

    findNextCombinePair(items) {
        const booksByTypeAndLevel = new Map();

        for (const book of this.getInventoryBooks(items)) {
            if (!booksByTypeAndLevel.has(book.key)) booksByTypeAndLevel.set(book.key, { type: book.type, level: book.level, books: [] });
            booksByTypeAndLevel.get(book.key).books.push(book);
        }

        const bookGroups = Array.from(booksByTypeAndLevel.values()).sort((a, b) => a.level - b.level || a.type.localeCompare(b.type));
        const maxPairLevel = this.enableLevelTenBooks ? 9 : 4;
        const group = bookGroups.find((group) => group.level <= maxPairLevel && group.books.length >= 2);
        return group ? group.books.slice(0, 2) : null;
    }

    getBookData(line) {
        if (!line) return null;

        const supportedLevels = EXTENDED_BOOK_LEVELS;
        const cleanedLine = ChatLib.removeFormatting(`${line}`).trim();
        const regex = new RegExp(`^(.*)\\s(${supportedLevels.join('|')})$`);
        const match = cleanedLine.match(regex);
        if (!match) return null;

        const type = match[1].trim();
        return type
            ? {
                  type,
                  level: supportedLevels.indexOf(match[2]) + 1,
              }
            : null;
    }

    setState(state) {
        this.state = state;
        this.resetTimeout();
    }

    timeout() {
        if (Date.now() < this.deadline) return;

        this.stuckCount++;
        if (!this.autoRetry || (this.stuckLimit > 0 && this.stuckCount >= this.stuckLimit)) {
            this.message(`&cStuck detected ${this.stuckCount} times. Automatically disabling.`);
            this.toggle(false);
            closeInventory();
            return;
        }

        this.message(`&eStuck detected ${this.stuckCount} times. Retrying.`);
        this.reset(true);
    }

    resetTimeout() {
        this.deadline = Date.now() + ACTION_TIMEOUT_MS;
    }

    reset(close = false) {
        this.first = null;
        this.second = null;
        this.resultBook = null;
        this.inventoryBookCount = 0;
        this.tickCounter = 0;
        this.setState(this.STATES.OPEN_ANVIL);
        if (close) closeInventory();
    }

    onEnable() {
        this.message('&aEnabled');
        this.stuckCount = 0;
        this.useAnvilCommand = getGuiName() !== 'Anvil';
        this.reset();
    }

    onDisable() {
        this.message('&cDisabled');
        this.reset();
    }
}

new AutoCombine();
