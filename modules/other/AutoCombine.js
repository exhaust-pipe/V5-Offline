import { ModuleBase } from '../../utils/ModuleBase';
import { manager } from '../../utils/SkyblockEvents';
import { clickSlot, closeInventory, getGuiName } from '../../utils/player/Inventory';

const BASE_BOOK_LEVELS = ['I', 'II', 'III', 'IV'];
const EXTENDED_BOOK_LEVELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

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
        };

        this.state = this.STATES.OPEN_ANVIL;
        this.first = null;
        this.second = null;
        this.timeoutFlags = 0;
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
            'Retries or disables after this many stuck detections, depending on Auto Retry. 0 disables the limit.'
        );
        this.addToggle(
            'Auto Retry',
            (value) => (this.autoRetry = !!value),
            'Automatically starts another attempt when the stuck limit is reached instead of disabling.',
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
        if (getGuiName() !== 'Anvil') {
            this.setState(this.STATES.OPEN_ANVIL);
            return;
        }

        const pair = this.findNextCombinePair();
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
        if (!this.getAnvilItems()?.[22]?.getLore()?.join('')?.includes('left and right')) return this.timeout();

        const firstSlot = this.first?.slot;
        if (firstSlot === undefined || firstSlot === null) {
            this.reset(true);
            return;
        }

        clickSlot(firstSlot, true);
        this.setState(this.STATES.SECOND_BOOK);
    }

    clickSecondBook() {
        if (!this.getAnvilItems()?.[22]?.getLore()?.join('')?.includes('left and right')) return this.timeout();

        const secondSlot = this.second?.slot;
        if (secondSlot === undefined || secondSlot === null) {
            this.reset(true);
            return;
        }

        clickSlot(secondSlot, true);
        this.setState(this.STATES.COMBINE_BOOKS);
    }

    clickCombine() {
        const items = this.getAnvilItems();
        if (!items) return this.timeout();

        const combineItem = items[22];
        if (!combineItem?.getLore()?.join('')?.includes('Cost')) return this.timeout();

        clickSlot(22);
        this.setState(this.STATES.EXTRACT_BOOK);
    }

    clickExtractItem() {
        const items = this.getAnvilItems();
        if (!items) return this.timeout();

        const extractItem = items[13];
        if (!extractItem) return this.timeout();
        if (!items[22]?.getLore()?.join('')?.includes('Claim the result')) return this.timeout();

        clickSlot(13, true);
        this.reset();
    }

    findNextCombinePair() {
        const container = Player.getContainer();
        const booksByTypeAndLevel = new Map();

        for (let slot = 30; slot < container?.getSize(); slot++) {
            const item = container?.getStackInSlot(slot);
            if (!item?.getName()?.includes('Enchanted Book')) continue;

            const lore = item?.getLore?.();
            if (!lore?.length) continue;

            const bookData = lore.map((line) => this.getBookData(line?.toString?.() ?? line)).find((data) => data);
            if (!bookData) continue;

            const key = `${bookData.type}|${bookData.level}`;
            if (!booksByTypeAndLevel.has(key)) booksByTypeAndLevel.set(key, { ...bookData, books: [] });
            booksByTypeAndLevel.get(key).books.push({ item, slot });
        }

        const bookGroups = Array.from(booksByTypeAndLevel.values()).sort((a, b) => a.level - b.level || a.type.localeCompare(b.type));
        const maxPairLevel = this.enableLevelTenBooks ? 9 : 4;
        const group = bookGroups.find((group) => group.level <= maxPairLevel && group.books.length >= 2);
        return group ? group.books.slice(0, 2) : null;
    }

    getBookData(line) {
        if (!line) return null;

        const supportedLevels = this.enableLevelTenBooks ? EXTENDED_BOOK_LEVELS : BASE_BOOK_LEVELS;
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
        this.message('Returned without doing anything? stuck? waiting?');
        this.timeoutFlags++;
        if (this.timeoutFlags > 4) {
            this.stuckCount++;
            if (this.stuckLimit > 0 && this.stuckCount >= this.stuckLimit) {
                if (!this.autoRetry) {
                    this.message(`&cStuck detected ${this.stuckCount} times. Automatically disabling.`);
                    closeInventory();
                    this.toggle(false);
                    return;
                }
                this.message(`&eStuck detected ${this.stuckCount} times. Automatically retrying.`);
                this.stuckCount = 0;
            } else {
                this.message('&cStuck detected. Force resetting.');
            }
            this.reset(true);
        }
    }

    resetTimeout() {
        this.timeoutFlags = 0;
    }

    reset(close = false) {
        this.first = null;
        this.second = null;
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
