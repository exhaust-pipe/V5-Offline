const HypixelPublicApi = Java.type('com.chattriggers.ctjs.api.client.HypixelPublicApi');

export const fetchURL = (url) => {
    try {
        return String(HypixelPublicApi.read(String(url)));
    } catch (e) {
        console.error('Public Hypixel data unavailable: ' + e);
        return null;
    }
};
