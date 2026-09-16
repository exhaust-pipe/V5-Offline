import { convertToVector } from './Utils';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const point = (x, y, z) => ({ x: x || 0, y: y || 0, z: z || 0 });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const horizontalDistance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

const toPoint = (input, y, z) => {
    if (typeof input === 'number') return point(input, y, z);
    const vec = convertToVector(input);
    return vec ? point(vec.x(), vec.y(), vec.z()) : null;
};

const playerPosition = () => (Player.getPlayer() ? point(Player.getX(), Player.getY(), Player.getZ()) : null);

const playerEyes = () => {
    const eyes = Player.getPlayer()?.getEyePosition();
    return eyes ? point(eyes.x(), eyes.y(), eyes.z()) : null;
};

const distances = (a, b) => ({
    distance: distance(a, b),
    distanceFlat: horizontalDistance(a, b),
    distanceY: a.y - b.y,
    differenceY: a.y - b.y,
});

const emptyDistance = () => ({ distance: 0, distanceFlat: 0, distanceY: 0 });

export function wrapTo180(angle) {
    angle %= 360;
    if (angle >= 180) angle -= 360;
    if (angle < -180) angle += 360;
    return angle;
}

export function distanceToPlayerPoint(targetInput) {
    const eyes = playerEyes();
    const target = toPoint(targetInput);
    return eyes && target ? distance(eyes, target) : 0;
}

export function distanceToPlayerFeet(targetInput) {
    const feet = playerPosition();
    const target = toPoint(targetInput);
    return feet && target ? distances(feet, target) : 0;
}

export function calculateDistance(a, b) {
    const first = toPoint(a);
    const second = toPoint(b);
    return first && second ? distances(first, second) : emptyDistance();
}

export function getDistanceToPlayer(x, y, z) {
    const feet = playerPosition();
    const target = toPoint(x, y, z);
    return feet && target ? distances(feet, target) : emptyDistance();
}

export function getDistanceToPlayerEyes(x, y, z) {
    const eyes = playerEyes();
    const target = toPoint(x, y, z);
    return eyes && target ? distances(eyes, target) : { distance: 0, distanceFlat: 0, differenceY: 0 };
}

export function getDistance(x1, y1, z1, x2, y2, z2) {
    const first = toPoint(x1, y1, z1);
    const second = toPoint(x2, y2, z2);
    return first && second ? distances(first, second) : emptyDistance();
}

export const fastDistance = (x1, y1, z1, x2, y2, z2) => Math.hypot(x1 - x2, y1 - y2, z1 - z2);

export const blockCenter = (x, y, z) => point(x + 0.5, y + 0.5, z + 0.5);

const relativeAngles = (target) => {
    const eyes = Player.getPlayer()?.getEyePosition();
    if (!target || !eyes) return { yaw: 0, pitch: 0 };

    const dx = target.x - eyes.x();
    const dy = target.y - eyes.y();
    const dz = target.z - eyes.z();
    return {
        yaw: wrapTo180(Math.atan2(dz, dx) * RAD_TO_DEG - 90 - Player.getYaw()),
        pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * RAD_TO_DEG - Player.getPitch(),
    };
};

export function angleToPlayer(targetInput) {
    const target = toPoint(targetInput);
    if (!target) return { distance: 0, yaw: 0, pitch: 0, yawAbs: 0, pitchAbs: 0 };
    const { yaw, pitch } = relativeAngles(target);
    return { distance: Math.hypot(yaw, pitch), yaw, pitch, yawAbs: Math.abs(yaw), pitchAbs: Math.abs(pitch) };
}

export const getAngleDifference = (current, target) => wrapTo180(target - current);

export function calculateAngles(vec) {
    const target = toPoint(vec);
    return target ? relativeAngles(target) : { yaw: 0, pitch: 0 };
}

export function calculateAbsoluteAngles(vec) {
    const target = toPoint(vec);
    const eyes = Player.getPlayer()?.getEyePosition();
    if (!target || !eyes) return { yaw: 0, pitch: 0 };

    const dx = target.x - eyes.x();
    const dy = target.y - eyes.y();
    const dz = target.z - eyes.z();
    return {
        yaw: wrapTo180(Math.atan2(dz, dx) * RAD_TO_DEG - 90),
        pitch: Math.max(-90, Math.min(90, -Math.atan2(dy, Math.hypot(dx, dz)) * RAD_TO_DEG)),
    };
}

export const finiteNumber = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
};

export const formatRoundedNumber = (value) => {
    if (!Number.isFinite(value)) return '0';
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

export function offsetPitch(input, degrees) {
    const target = toPoint(input);
    const eyes = playerEyes();
    if (!target || !eyes) return input;
    const horizontal = Math.hypot(target.x - eyes.x, target.z - eyes.z);
    if (!horizontal) return input;
    const pitch = calculateAbsoluteAngles(target).pitch + degrees;
    return { ...input, y: eyes.y - horizontal * Math.tan(pitch * DEG_TO_RAD) };
}

const distanceToPlayerCenter = (targetInput) => {
    const target = toPoint(targetInput);
    if (!target || !Player.getPlayer()) return 0;
    const center = point(Player.getX(), Player.getY() + Player.asPlayerMP().getHeight() / 2, Player.getZ());
    return distances(center, target);
};

const distanceToEntity = (entity) => {
    if (!entity) return 0;
    const eyes = playerEyes();
    const target = point(entity.getX(), entity.getY(), entity.getZ());
    return eyes ? distances(eyes, target) : 0;
};

const distanceToBox = (position, min, max) => {
    const p = toPoint(position);
    const lo = toPoint(min);
    const hi = toPoint(max);
    if (!p || !lo || !hi) return 0;
    return Math.hypot(Math.max(lo.x - p.x, 0, p.x - hi.x), Math.max(lo.y - p.y, 0, p.y - hi.y), Math.max(lo.z - p.z, 0, p.z - hi.z));
};

// Compatibility facade for Offline modules written against the pre-5.2 object API.
export const MathUtils = {
    distanceToPlayerPoint,
    distanceToPlayer: (target) => {
        const eyes = playerEyes();
        const pointTarget = toPoint(target);
        return eyes && pointTarget ? distances(eyes, pointTarget) : 0;
    },
    distanceToPlayerFeet,
    distanceToPlayerCenter,
    distanceToPlayerCT: distanceToEntity,
    distanceToPlayerMC: distanceToEntity,
    calculateDistanceBP: calculateDistance,
    calculateDistance,
    getDistanceToPlayer,
    getDistanceToPlayerEyes,
    getDistance,
    fastDistance,
    blockCenter,
    distanceToBlockCenter: (x, y, z) => distanceToPlayerFeet(blockCenter(x, y, z)),
    distanceToBox,
    toFixed: (value) => Math.round(value * 10) / 10,
    angleToPlayer,
    degreeToRad: (degrees) => degrees * DEG_TO_RAD,
    getAngleDifference,
    wrapTo180,
    calculateAngles,
    calculateAbsoluteAngles,
    offsetPitch,
    getNumbersFromString: (str) => {
        if (!str) return 0;
        const match = String(str).match(/\d+/g);
        return match ? Number.parseInt(match.join('')) : 0;
    },
};
