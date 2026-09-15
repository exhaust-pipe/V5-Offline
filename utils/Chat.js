import FailsafeUtils from '../failsafes/FailsafeUtils';
import { isDeveloperModeEnabled } from './DeveloperModeState';

const sendGradient = (prefix, ...args) => {
    if (!args.length) return;
    Client.getMinecraft().execute(() => GradientChat.sendGradientMsg(prefix, 0x05b9f9, 0x0539f9, ...args));
};

export const chat = (message) => sendGradient('V5 »', message);

export function chatDebug(message) {
    if (isDeveloperModeEnabled()) sendGradient('V5 Debug »', message);
}

export function chatFailsafe(message, includeIntensity = true) {
    sendGradient('V5 Failsafes »', message);
    if (includeIntensity) sendGradient('V5 Failsafes »', '&c&lCurrent intensity: ' + FailsafeUtils.getIntensity());
}

export const chatPathfinder = (message) => sendGradient('V5 Pathfinding »', message);

// Compatibility facade for Offline modules written against the pre-5.2 object API.
export const Chat = {
    message: chat,
    debug: chatDebug,
    failsafe: chatFailsafe,
    pathfinder: chatPathfinder,
};
