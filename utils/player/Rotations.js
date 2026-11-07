import { ModuleBase } from '../ModuleBase';
import { aimModulo360, angleDifference, applyToPlayer, calculateGCD, clampPitch, getCurrentRotation, syncFromPlayer } from './RotationGCD';
import { convertToVector } from '../Utils';
import { v5Command } from '../V5Commands';
import { Rotations as PathRotations } from '../pathfinder/PathWalker/PathRotations';
import { PathFlyer } from '../pathfinder/PathFlyer';
import { getEtherwarpPathHandler } from '../Etherwarp';

class RotationConfig extends ModuleBase {
    constructor() {
        super({
            name: 'Rotations',
            subcategory: 'Core',
            description: 'Rotations settings for all modules - excludes Pathfinder',
            tooltip: 'Rotations settings for all modules - excludes Pathfinder',
            hideInModules: true,
        });

        this.ROTATION_SPEED = 400;
        this.rotationMode = 'Non-linear';
        this.DAMPING_DIST = 60;

        this.addDirectMultiToggle(
            'Rotation Mode',
            ['Linear', 'Non-linear (recommended)', 'Instant'],
            true,
            (value) => {
                this.rotationMode = value?.find((opt) => opt.enabled)?.name;
            },
            '• Non-linear rotations have offsets making them more human-like\n• Linear rotations are smoother and more precise\n• Instant rotations snap to the target immediately.',
            'Non-linear (recommended)',
            'Rotations'
        );

        this.addDirectSlider(
            'Rotation Speed',
            30,
            60,
            40,
            (v) => {
                this.ROTATION_SPEED = v * 10;
            },
            'Degrees per second',
            'Rotations'
        );
    }
}

export const RotationModule = new RotationConfig();

const DEFAULT_PRECISION = 0.1;
const ENTITY_PRECISION = 0.5;
const ENTITY_JITTER_DURATION_MS = 150;
const TARGET_SHIFT_RESET_DEGREES = 5;

export function getRotationCurveOffset(progress, distance, seed) {
    const strength = distance * 0.18 * Math.sin(progress * Math.PI) * (1 - progress);
    return {
        x: Math.cos(seed) * strength,
        y: Math.sin(seed) * strength,
    };
}

class RotationController {
    constructor() {
        this.request = null;
        this.targetAngles = null;
        this.lastTime = 0;
        this.startTime = 0;
        this.initialDistance = 0;
        this.curveSeed = 0;
        this.callbacks = [];

        v5Command('rotations rotateTo', (yaw, pitch) => this.lookAtAngles(yaw, pitch), ['float', 'float']);

        v5Command('rotations rotateTo random', () => this.lookAtAngles(Math.random() * 360 - 180, Math.random() * 180 - 90));

        v5Command('rotations stop', () => this.stop());

        this.renderRegister = register('renderWorld', () => this.update()).unregister();
    }

    get active() {
        return this.request !== null;
    }

    get currentVector() {
        return this.request?.type === 'vector' ? this.request.value : null;
    }

    lookAtAngles(yaw, pitch, options = {}) {
        if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;
        return this.start({ type: 'angles', value: { yaw, pitch: clampPitch(pitch) } }, options);
    }

    lookAtVector(vector, options = {}) {
        const vec = convertToVector(vector);
        if (!vec) return false;
        return this.start({ type: 'vector', value: vec }, options);
    }

    // MAKE SURE YOU ONLY CALL THIS ONCE PER ENTITY. REPEATDLY CALLING trackEntity EVERY TICK CAUSES IT TO BREAK.
    trackEntity(entity, options = {}) {
        if (!this.isEntityUsable(entity)) return false;
        return this.start({ type: 'entity', value: entity }, options);
    }

    isTrackingEntity(entity) {
        return this.request?.type === 'entity' && this.request.value === entity;
    }

    onComplete(callback, name = null) {
        if (typeof callback === 'function') {
            this.callbacks.push({ callback, name });
        }
    }

    stop() {
        this.clearRequest();
        this.callbacks = [];
        syncFromPlayer();
    }

    getAimPoint(entity) {
        try {
            const mcEntity = entity?.toMC ? entity.toMC() : entity;
            if (!mcEntity) return null;

            const box = mcEntity.getBoundingBox?.();
            if (box) {
                const height = box.maxY - box.minY;
                const heightMultiplier = height >= 2.5 ? 0.5 : 0.85;

                return {
                    x: (box.minX + box.maxX) / 2,
                    y: box.minY + height * heightMultiplier,
                    z: (box.minZ + box.maxZ) / 2,
                };
            }

            if (typeof mcEntity.getX === 'function') {
                return {
                    x: mcEntity.getX(),
                    y: mcEntity.getY() + 1.5,
                    z: mcEntity.getZ(),
                };
            }
        } catch (e) {
            console.error(e);
        }

        return null;
    }

    update() {
        if (!this.request) return;
        if (!this.refreshTarget()) return;

        if (PathRotations.rotationActive || PathFlyer.rotationActive || getEtherwarpPathHandler()?.isPathing?.()) {
            this.lastTime = 0;
            return;
        }

        const player = Player.getPlayer();
        if (!player || !this.targetAngles) {
            this.stop();
            return;
        }

        const current = getCurrentRotation(player);
        if (!current) {
            this.stop();
            return;
        }

        const jitter = this.request.jitter;
        if (jitter) {
            current.yaw -= jitter.appliedYaw;
            current.pitch = clampPitch(current.pitch - jitter.appliedPitch);
        }
        const now = Date.now();
        const deltaTime = this.lastTime > 0 ? Math.max(0, (now - this.lastTime) / 1000) : 0;
        this.updateEntityJitter(deltaTime, now);

        const targetYaw = aimModulo360(current.yaw, this.targetAngles.yaw);
        const targetPitch = clampPitch(this.targetAngles.pitch);
        const deltaYaw = targetYaw - current.yaw;
        const deltaPitch = targetPitch - current.pitch;
        const distance = Math.hypot(deltaYaw, deltaPitch);

        if (distance <= this.getPrecision()) {
            if (this.request.jitter) this.applyRotation(current.yaw, current.pitch);
            this.onReachedTarget();
            return;
        }

        if (RotationModule.rotationMode === 'Instant') {
            this.applyRotation(targetYaw, targetPitch);
            this.onReachedTarget();
            return;
        }

        if (this.lastTime === 0) {
            this.resetTiming(now, distance);
            return;
        }

        if (distance > this.initialDistance) {
            this.initialDistance = distance;
        }

        this.lastTime = now;

        const ratio = this.getStepRatio(distance, deltaTime);
        const curve = this.getCurveOffset(this.getProgress(distance));
        const nextYaw = current.yaw + deltaYaw * ratio + curve.x * ratio;
        const nextPitch = clampPitch(current.pitch + deltaPitch * ratio + curve.y * ratio);

        if (Number.isFinite(nextYaw) && Number.isFinite(nextPitch)) {
            const applied = this.applyRotation(nextYaw, nextPitch);
            if (this.request.jitter && applied && Math.hypot(angleDifference(targetYaw, nextYaw), targetPitch - nextPitch) <= this.getPrecision()) {
                this.onReachedTarget();
            }
        }
    }

    updateEntityJitter(deltaTime, now) {
        const request = this.request;
        if (request.type !== 'entity' || request.entityJitter <= 0) return;

        if (!request.jitter) request.jitter = { yaw: 0, pitch: 0, appliedYaw: 0, appliedPitch: 0, nextAt: 0 };
        const jitter = request.jitter;
        if (jitter.nextAt !== null && now >= jitter.nextAt) {
            jitter.fromYaw = jitter.yaw;
            jitter.fromPitch = jitter.pitch;
            jitter.targetYaw = (Math.random() * 2 - 1) * request.entityJitter;
            jitter.targetPitch = (Math.random() * 2 - 1) * request.entityJitter;
            jitter.progress = 0;
            jitter.nextAt = null;
        }

        jitter.progress = Math.min(1, jitter.progress + (deltaTime * 1000) / ENTITY_JITTER_DURATION_MS);
        jitter.yaw = jitter.fromYaw + (jitter.targetYaw - jitter.fromYaw) * jitter.progress;
        jitter.pitch = jitter.fromPitch + (jitter.targetPitch - jitter.fromPitch) * jitter.progress;
    }

    applyRotation(yaw, pitch) {
        const jitter = this.request.jitter;
        const applied = applyToPlayer(yaw + (jitter?.yaw ?? 0), pitch + (jitter?.pitch ?? 0));
        if (jitter && applied) {
            // Keep mouse-step rounding and pitch clamping out of the underlying target tracking.
            jitter.appliedYaw = angleDifference(applied.yaw, yaw);
            jitter.appliedPitch = applied.pitch - pitch;
        }
        return applied;
    }

    start(nextRequest, options = {}) {
        const sameSource = this.isSameSource(nextRequest);
        nextRequest.entityJitter = Number.isFinite(options?.entityJitter) ? Math.max(0, options.entityJitter) : 0;
        nextRequest.jitter = sameSource && this.request.entityJitter === nextRequest.entityJitter ? this.request.jitter : null;
        const nextTarget = this.resolveTarget(nextRequest);
        if (!nextTarget) return false;
        const speedMultiplier = Number.isFinite(options?.speedMultiplier) ? options.speedMultiplier : 1;
        const rotationSpeed = Number.isFinite(options?.rotationSpeed) && options.rotationSpeed > 0 ? options.rotationSpeed : null;
        const precision = Number.isFinite(options?.precision) && options.precision >= 0 ? options.precision : null;

        const shouldReset =
            !sameSource || !this.targetAngles || (nextRequest.type !== 'entity' && this.getTargetShift(nextTarget) > TARGET_SHIFT_RESET_DEGREES);

        if (!this.request || !sameSource) {
            syncFromPlayer();
        }

        this.request = nextRequest;
        if (!this.renderRegister.isRegistered()) this.renderRegister.register();
        this.request.speedMultiplier = speedMultiplier;
        this.request.rotationSpeed = rotationSpeed;
        this.request.precision = precision;
        this.targetAngles = nextTarget;

        if (shouldReset) {
            this.resetTiming();
        }

        return true;
    }

    refreshTarget() {
        if (!this.request) return false;

        if (this.request.type === 'entity' && !this.isEntityUsable(this.request.value)) {
            this.stop();
            return false;
        }

        const target = this.resolveTarget(this.request);
        if (!target) {
            this.stop();
            return false;
        }

        this.targetAngles = target;
        return true;
    }

    resolveTarget(request) {
        if (!request) return null;
        if (request.type === 'angles') return request.value;
        if (request.type === 'vector') return this.getAnglesFromVector(request.value);
        if (request.type === 'entity') {
            const aimPoint = this.getAimPoint(request.value);
            return aimPoint ? this.getAnglesFromVector(aimPoint) : null;
        }
        return null;
    }

    isSameSource(nextRequest) {
        if (!this.request || this.request.type !== nextRequest.type) return false;
        if (nextRequest.type === 'entity') return this.request.value === nextRequest.value;
        return true;
    }

    isEntityUsable(entity) {
        if (!entity) return false;

        try {
            const mcEntity = entity.toMC ? entity.toMC() : entity;
            return !!mcEntity && !mcEntity.isDeadOrDying?.() && !mcEntity.isRemoved?.();
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    getTargetShift(nextTarget) {
        const dYaw = Math.abs(angleDifference(nextTarget.yaw, this.targetAngles.yaw));
        const dPitch = Math.abs(nextTarget.pitch - this.targetAngles.pitch);
        return Math.hypot(dYaw, dPitch);
    }

    getPrecision() {
        let precision = DEFAULT_PRECISION;
        if (Number.isFinite(this.request?.precision)) precision = this.request.precision;
        else if (this.request?.type === 'entity') precision = ENTITY_PRECISION;
        return Math.max(precision, calculateGCD() / Math.SQRT2);
    }

    getStepRatio(distance, deltaTime) {
        if (distance <= 0) return 0;

        const timeAlive = this.startTime > 0 ? (Date.now() - this.startTime) / 1000 : 0;
        const warmup = this.request?.type === 'angles' ? 1 : Math.min(timeAlive * 4, 1);
        const damping = Math.min(distance / RotationModule.DAMPING_DIST, 1);
        const speed = (this.request?.rotationSpeed ?? RotationModule.ROTATION_SPEED) * (this.request?.speedMultiplier ?? 1) * Math.sqrt(damping);
        const step = (speed * warmup + 10) * deltaTime;

        return Math.min(distance, step) / distance;
    }

    getProgress(distance) {
        if (this.initialDistance <= 0) return 1;
        return Math.max(0, Math.min(1, 1 - distance / this.initialDistance));
    }

    getCurveOffset(progress) {
        if (RotationModule.rotationMode === 'Linear' || RotationModule.rotationMode === 'Instant') return { x: 0, y: 0 };
        return getRotationCurveOffset(progress, this.initialDistance, this.curveSeed);
    }

    onReachedTarget() {
        if (this.request?.type === 'entity') {
            this.lastTime = Date.now();
            if (this.startTime === 0) this.startTime = this.lastTime;
            if (this.request.jitter?.nextAt === null && this.request.jitter.progress === 1) {
                this.request.jitter.nextAt = this.lastTime + Math.random() * 3000;
            }
            return;
        }

        this.complete();
    }

    complete() {
        const callbacks = this.callbacks.splice(0);
        this.clearRequest();
        syncFromPlayer();

        for (const action of callbacks) {
            try {
                action.callback();
            } catch (e) {
                console.error(`Rotation ${action.name || 'callback'} error:`);
                console.error(e);
            }
        }
    }

    clearRequest() {
        this.request = null;
        this.targetAngles = null;
        this.lastTime = 0;
        this.startTime = 0;
        this.initialDistance = 0;
        if (this.renderRegister.isRegistered()) this.renderRegister.unregister();
    }

    resetTiming(now = 0, distance = 0) {
        this.lastTime = now;
        this.startTime = now;
        this.initialDistance = distance;
        this.curveSeed = Math.random() * Math.PI * 2;
    }

    getAnglesFromVector(vector) {
        const vec = convertToVector(vector);
        const player = Player.getPlayer();
        if (!vec || !player) return null;

        const dx = vec.x() - player.getX();
        const dy = vec.y() - player.getEyePosition().y();
        const dz = vec.z() - player.getZ();

        return {
            yaw: Math.atan2(-dx, dz) * (180 / Math.PI),
            pitch: clampPitch(Math.atan2(-dy, Math.hypot(dx, dz)) * (180 / Math.PI)),
        };
    }
}

export const Rotations = new RotationController();
