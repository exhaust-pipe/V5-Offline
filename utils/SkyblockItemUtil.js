import { fetchURL } from './NetworkUtils';
import { Executor } from './ThreadExecutor';

const ITEMS_URL = 'https://api.hypixel.net/v2/resources/skyblock/items';
const BAZAAR_URL = 'https://api.hypixel.net/v2/skyblock/bazaar';

class SkyblockItemUtil {
    constructor() {
        this.items = new Map();
        this.products = {};
        this.refreshing = false;
        this.lastAttempt = 0;
        this.setItems(this.readCache('items.json'));
        const cachedBazaar = this.readCache('bazaar.json');
        this.products = (cachedBazaar && cachedBazaar.products) || {};
        this.loadItems();
    }

    readCache(file) {
        try {
            return JSON.parse(FileLib.read('V5Config', 'public-data/' + file) || '{}');
        } catch (e) {
            return {};
        }
    }

    setItems(data) {
        if (!data || !Array.isArray(data.items)) return;
        this.items = new Map(data.items.map((item) => [this.clean(item.name), item]));
    }

    loadItems() {
        if (this.refreshing || Date.now() - this.lastAttempt < 300000) return;
        this.refreshing = true;
        this.lastAttempt = Date.now();
        Executor.execute(() => {
            try {
                this.setItems(this.refreshResource(ITEMS_URL, 'items.json'));
                const bazaar = this.refreshResource(BAZAAR_URL, 'bazaar.json');
                if (bazaar && bazaar.products) this.products = bazaar.products;
            } finally {
                this.refreshing = false;
            }
        });
    }

    refreshResource(url, file) {
        try {
            const response = fetchURL(url);
            if (!response) return null;
            const data = JSON.parse(response);
            if (data.success !== true) return null;
            FileLib.write('V5Config', 'public-data/' + file, response, true);
            return data;
        } catch (e) {
            console.error('Public Hypixel data refresh failed: ' + e);
            return null;
        }
    }

    get(name) {
        const key = this.clean(name);
        return this.items.get(key) || null;
    }

    getPrice(name) {
        this.loadItems();
        const item = this.get(name);
        if (!item) return null;
        const product = this.products[item.id];
        const status = (product && product.quick_status) || {};
        return {
            NPC: item.npc_sell_price == null ? null : item.npc_sell_price,
            SELL: status.sellPrice == null ? null : status.sellPrice,
            BUY: status.buyPrice == null ? null : status.buyPrice,
        };
    }

    clean(name) {
        return ChatLib.removeFormatting(String(name == null ? '' : name))
            .trim()
            .toLowerCase();
    }
}

export const skyblockItem = new SkyblockItemUtil();
