import { BP, Vec3d } from './Constants';
import { ClientboundSystemChatPacket } from './Packets';
import { getArea } from './TabListUtils';

export const mc = Client.getMinecraft();
export const CONFIG_DIR_NAME = 'V5Config';

const configCache = new Map();
let currentSubArea = 'Unknown';
let subAreaLastChecked = 0;
let currentMana = null;

const readConfig = (fileName) => {
    const content = FileLib.read(CONFIG_DIR_NAME, fileName);
    if (!content?.trim()) return {};

    try {
        return JSON.parse(content);
    } catch (error) {
        console.error('V5 Caught error' + error + error.stack);
        return {};
    }
};

export function getConfigFile(fileName) {
    if (fileName !== 'config.json') return readConfig(fileName);

    const cached = configCache.get(fileName);
    if (cached && Date.now() - cached.timestamp < 200) return cached.data;
    const data = readConfig(fileName);
    configCache.set(fileName, { data, timestamp: Date.now() });
    return data;
}

export function getConfigFileCached(fileName, ttl = 5000) {
    const cached = configCache.get(fileName);
    if (cached && Date.now() - cached.timestamp < ttl) return cached.data;
    const data = readConfig(fileName);
    configCache.set(fileName, { data, timestamp: Date.now() });
    return data;
}

export function writeConfigFile(fileName, data) {
    try {
        FileLib.write(CONFIG_DIR_NAME, fileName, JSON.stringify(data, null, 2), true);
        configCache.set(fileName, { data, timestamp: Date.now() });
        return true;
    } catch (error) {
        console.error('V5 Caught error' + error + error.stack);
        return false;
    }
}

export function clearConfigCache(fileName) {
    if (fileName) configCache.delete(fileName);
    else configCache.clear();
}

export const area = getArea;

export function subArea() {
    const now = Date.now();
    if (now - subAreaLastChecked < 1000) return currentSubArea;
    subAreaLastChecked = now;

    try {
        for (const line of Scoreboard.getLines() || []) {
            const text = ChatLib.removeFormatting(String(line));
            if (!text.includes('')) continue;
            const detected = text.split('')[1]?.trim();
            if (detected) return (currentSubArea = detected);
        }
    } catch (error) {
        console.error('V5 Caught error' + error + error.stack);
    }
    return currentSubArea;
}

export function getDay() {
    const world = mc?.level;
    return world ? Math.floor(world.getOverworldClockTime() / 24000) : 0;
}

export const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
export const randomFloat = (min, max) => Math.random() * (max - min) + min;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (start, end, progress) => start + (end - start) * progress;
export const distance3D = (x1, y1, z1, x2, y2, z2) => Math.hypot(x2 - x1, y2 - y1, z2 - z1);
export const distance2D = (x1, z1, x2, z2) => Math.hypot(x2 - x1, z2 - z1);

export function convertToVector(input) {
    if (!input) return null;

    let coordinates;
    if (typeof input.x === 'number' && typeof input.y === 'number' && typeof input.z === 'number') {
        coordinates = [input.x, input.y, input.z];
    } else if (typeof input.x === 'function' && typeof input.y === 'function' && typeof input.z === 'function') {
        coordinates = [input.x(), input.y(), input.z()];
    } else if (Array.isArray(input) && input.length >= 3) {
        coordinates = input;
    } else if (typeof input.getX === 'function' && typeof input.getY === 'function' && typeof input.getZ === 'function') {
        coordinates = [input.getX(), input.getY(), input.getZ()];
    }

    const vector = coordinates?.slice(0, 3);
    return vector?.every(Number.isFinite) ? new Vec3d(vector[0], vector[1], vector[2]) : null;
}

export function noCollision(blockVec) {
    const world = World.getWorld();
    if (!blockVec || !world) return false;
    const position = new BP(blockVec.x, blockVec.y, blockVec.z);
    const state = world.getBlockState(position);
    return !!state && state.getCollisionShape(world, position).isEmpty();
}

export function playerIsCollided(ignoreBottomSlab = false) {
    const player = Player.getPlayer();
    const world = World.getWorld();
    if (!player || !world) return false;

    const box = player.getBoundingBox().inflate(0.01, 0, 0.01);
    const blocks = World.getBlocksInBox(
        Math.floor(box.minX),
        Math.floor(box.minY),
        Math.floor(box.minZ),
        Math.floor(box.maxX),
        Math.floor(box.maxY),
        Math.floor(box.maxZ)
    );

    for (const block of blocks) {
        if (!block?.type || block.type.getID() === 0) continue;
        const position = new BP(block.x, block.y, block.z);
        const state = world.getBlockState(position);
        const name = block.type.getRegistryName()?.toLowerCase?.();
        if (!state || !name || name.includes('carpet')) continue;
        if (ignoreBottomSlab && (name.includes('farmland') || (name.includes('slab') && state.toString().includes('type=bottom')))) continue;
        if (!state.getCollisionShape(world, position).isEmpty()) return true;
    }
    return false;
}

export function getGardenPestStatus() {
    let gardenPests = null;
    let currentPlot = null;
    let currentPlotPests = null;

    try {
        for (const line of Scoreboard.getLines() || []) {
            const text = ChatLib.removeFormatting(String(line.getName?.() ?? line)).trim();
            const isGarden = text.includes('The Garden');
            const gardenMatch = isGarden && text.match(/\bx\s*(\d+)\s*$/);
            const plotMatch = text.match(/\bPlot\s*-\s*(\d+)\b(?:.*?\bx\s*(\d+))?/);
            if (isGarden) gardenPests = Number(gardenMatch?.[1] || 0);
            if (plotMatch) {
                currentPlot = Number(plotMatch[1]);
                currentPlotPests = Number(plotMatch[2] || 0);
            }
        }
    } catch (error) {
        console.error('V5 Caught error' + error + error.stack);
    }
    return { gardenPests, currentPlot, currentPlotPests };
}

export const getCurrentMana = () => currentMana;
export const checkPlayerCollision = () => playerIsCollided(false);

register('worldLoad', () => {
    currentMana = null;
    currentSubArea = 'Unknown';
    subAreaLastChecked = 0;
});
register('packetReceived', (packet) => {
    if (!packet?.overlay?.()) return;
    const actionBar = packet.content()?.getString();
    if (!actionBar) return;
    const match = actionBar.replace(/\u00A7[0-9A-FK-OR]/gi, '').match(/([\d,]+)\/([\d,]+)(?:\u270E|\uE003)\s*/);
    if (match) currentMana = Number(match[1].replace(/,/g, ''));
}).setFilteredClass(ClientboundSystemChatPacket);

// Compatibility facade for Offline modules that still use Utils.* while 5.2 code uses named exports.
export const Utils = {
    configName: CONFIG_DIR_NAME,
    getConfigFile,
    getConfigFileCached,
    writeConfigFile,
    clearConfigCache,
    area,
    subArea,
    getDay,
    randomInt,
    randomFloat,
    clamp,
    lerp,
    distance3D,
    distance2D,
    convertToVector,
    noCollision,
    playerIsCollided,
    getGardenPestStatus,
    getCurrentMana,
    checkPlayerCollision,
    openBrowser: () => {},
};
