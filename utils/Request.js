import { fetchURL } from './NetworkUtils';

const HYPIXEL_PREFIX = 'https://api.hypixel.net/';

/**
 * Offline compatibility adapter for V5 5.2 modules that consume public Hypixel data.
 * This is deliberately not a general-purpose HTTP client: only unauthenticated GETs
 * to api.hypixel.net are allowed, and the Loader enforces the same boundary again.
 */
export default function requestV2(options) {
    if (typeof options === 'string') options = { url: options };
    const url = String(options?.url || '');
    const method = String(options?.method || 'GET').toUpperCase();

    return new Promise((resolve, reject) => {
        if (method !== 'GET' || !url.startsWith(HYPIXEL_PREFIX)) {
            reject(new Error('V5 Offline only permits GET requests to the public Hypixel API'));
            return;
        }

        const thread = new java.lang.Thread(() => {
            try {
                const body = fetchURL(url);
                if (body == null) throw new Error('Public Hypixel data unavailable');
                const result = options?.json === false ? String(body) : JSON.parse(String(body));
                Client.scheduleTask(0, () => resolve(result));
            } catch (error) {
                Client.scheduleTask(0, () => reject(error));
            }
        });
        thread.setDaemon(true);
        thread.start();
    });
}
