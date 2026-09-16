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
export const chatClip = (message) => sendGradient('V5 Clipping »', message);
export const chatScheduler = (message) => sendGradient('V5 Scheduler »', message);

export function sendAnnouncement(message) {
    if (!message) return;
    Client.getMinecraft().execute(() => GradientChat.sendGradientMsg('V5 Announcement »', 0xf4a261, 0xe76f51, message));
}

export function log(message) {
    if (!message) return;
    console.log('V5 » ' + message);
}

export function formatLink(...args) {
    if (args.length === 3 && typeof args[2] === 'string' && args[2].includes('http')) {
        const [message, label, url] = args;
        return new TextComponent(
            `${message} `,
            new TextComponent({
                text: `§9§n${label}§r`,
                clickEvent: { action: 'open_url', value: url },
                hoverEvent: { action: 'show_text', value: '§7Click to open' },
            })
        );
    }

    const components = [];
    for (const [index, component] of args.entries()) {
        if (typeof component === 'string' && !component.includes('http')) {
            components.push(component);
        } else {
            components.push(
                new TextComponent({
                    text: `§9§n${component}§r`,
                    clickEvent: { action: 'open_url', value: component },
                    hoverEvent: { action: 'show_text', value: '§7Click to open' },
                })
            );
        }
        if (index < args.length - 1) components.push(' ');
    }
    return new TextComponent(...components);
}

export function clickAction(message, actionText, actionValue, hoverText = '§7Click to open', actionType = 'open_file') {
    return new TextComponent(
        `${message} `,
        new TextComponent({
            text: `§9§n${actionText}§r`,
            clickEvent: { action: actionType, value: actionValue },
            hoverEvent: { action: 'show_text', value: hoverText },
        })
    );
}

// Compatibility facade for Offline modules written against the pre-5.2 object API.
export const Chat = {
    // Current short names.
    message: chat,
    debug: chatDebug,
    failsafe: chatFailsafe,
    pathfinder: chatPathfinder,

    // Legacy Offline method names.
    messageDebug: chatDebug,
    messageClip: chatClip,
    messageFailsafe: chatFailsafe,
    messagePathfinder: chatPathfinder,
    messageScheduler: chatScheduler,
    sendAnnouncement,
    log,
    formatLink,
    clickAction,
};
