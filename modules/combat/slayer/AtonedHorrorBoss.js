import { BP, ClipContext, Vec3d } from '../../../utils/Constants';
import Pathfinder from '../../../utils/pathfinder/PathFinder';
import { Aote } from '../../../utils/pathfinder/PathWalker/PathAote';
import { Rotations } from '../../../utils/player/Rotations';
import { CombatBot } from '../CombatBot';
import { GenericSlayerBoss } from './GenericSlayerBoss';

const DANGEROUS_BLOCKS = [
    'minecraft:white_terracotta',
    'minecraft:orange_terracotta',
    'minecraft:red_terracotta',
    'minecraft:light_gray_terracotta',
    'minecraft:acacia_planks',
    'minecraft:acacia_slab',
    'minecraft:acacia_stairs',
    'minecraft:quartz_block',
    'minecraft:quartz_slab',
    'minecraft:quartz_stairs',
    'minecraft:smooth_quartz_slab',
].map((name) => new BlockType(name));
const SEARCH_INTERVAL_MS = 250;
const PATH_TIMEOUT_MS = 6000;
const FAILED_GOAL_RETRY_MS = 5000;
const OUT_OF_REACH_GRACE_MS = 1000;
const DANGEROUS_GROUND_GRACE_MS = 250;
const DANGEROUS_RECOVERY_DELAY_MS = 2000;
const DANGEROUS_HORIZONTAL_RADIUS = 1;
const ESCAPE_SEARCH_RADIUS = 8;

export class AtonedHorrorBoss extends GenericSlayerBoss {
    constructor(config) {
        super({ ...config, boss: 'Atoned Horror' });
        this.combatOptions.tickTarget = (target) => this.fightTarget(target);
        this.goal = null;
        this.pathToken = 0;
        this.nextSearchAt = 0;
        this.failedGoals = new Map();
        this.hasSafeGoal = true;
        this.dangerousSince = null;
        this.outOfReachSince = null;
        this.dangerousColumns = new Map();
        this.dangerousColumnsTick = null;
        this.dangerousColumnSafeSince = new Map();
    }

    tick() {
        return super.tick() && this.hasSafeGoal;
    }

    pause() {
        this.cancelNavigation();
        this.nextSearchAt = 0;
        this.dangerousSince = null;
        this.outOfReachSince = null;
        this.dangerousColumns.clear();
        this.dangerousColumnsTick = null;
        super.pause();
    }

    stop() {
        super.stop();
        this.failedGoals.clear();
        this.dangerousColumnSafeSince.clear();
        this.hasSafeGoal = true;
    }

    cancelNavigation() {
        this.pathToken++;
        if (this.goal || Pathfinder.isPathing()) Pathfinder.resetPath();
        this.goal = null;
        Client.stopMovement();
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
    }

    fightTarget(target) {
        const position = CombatBot.getTargetPosition(target);
        if (!position) {
            this.cancelNavigation();
            this.dangerousSince = null;
            this.outOfReachSince = null;
            return;
        }
        const now = Date.now();
        CombatBot.trackTarget();
        if (Aote.originalSlot === -1 && now >= CombatBot.nextAttackAt) CombatBot.clickMouse(now);

        const playerPosition = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        const dangerous = this.isNearDangerousBlocks();
        const canAttack = this.canAttackFrom(playerPosition, target);
        this.dangerousSince = dangerous ? (this.dangerousSince ?? now) : null;
        this.outOfReachSince = canAttack ? null : (this.outOfReachSince ?? now);
        const leaveDanger = dangerous && now - this.dangerousSince >= DANGEROUS_GROUND_GRACE_MS;
        const holdPosition = !this.goal && !leaveDanger && (dangerous || canAttack || now - this.outOfReachSince < OUT_OF_REACH_GRACE_MS);
        const reachedFightPosition = Player.getPlayer().onGround() && this.isSafePosition(playerPosition) && (canAttack || this.goal?.escape);
        if (holdPosition || reachedFightPosition) {
            this.cancelNavigation();
            this.hasSafeGoal = true;
            CombatBot.setState('FIGHTING');
            return;
        }

        if (this.goal) {
            const safe = this.isSafePosition(this.goal);
            this.goal.outOfReachSince = this.goal.escape || this.canAttackFrom(this.goal, target) ? null : (this.goal.outOfReachSince ?? now);
            const bossMovedAway = this.goal.outOfReachSince !== null && now - this.goal.outOfReachSince >= OUT_OF_REACH_GRACE_MS;
            if (safe && !bossMovedAway && Pathfinder.isPathing() && now - this.pathStartedAt < PATH_TIMEOUT_MS) return;
            if (safe && !bossMovedAway) this.failedGoals.set(this.goal.key, now + FAILED_GOAL_RETRY_MS);
            this.cancelNavigation();
        }
        if (now < this.nextSearchAt) return;
        this.nextSearchAt = now + SEARCH_INTERVAL_MS;
        for (const [key, expiry] of this.failedGoals) {
            if (now >= expiry) this.failedGoals.delete(key);
        }

        let { goals, avoidPoints } = this.findSafeGoals(target, position);
        if (dangerous && !goals.length) ({ goals, avoidPoints } = this.findSafeGoals(target, playerPosition, true));
        this.hasSafeGoal = goals.length > 0;
        if (!this.hasSafeGoal) {
            CombatBot.setState('WAITING_FOR_SAFE_GROUND');
            Client.stopMovement();
            return;
        }

        const goal = goals[0];
        this.goal = goal;
        this.pathStartedAt = now;
        const token = ++this.pathToken;
        CombatBot.setState('PATHING');
        Pathfinder.findPath(
            [[goal.x, goal.groundY, goal.z]],
            (success) => {
                if (token !== this.pathToken) return;
                const current = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
                this.hasSafeGoal = success && this.isSafePosition(current);
                if (!this.hasSafeGoal) this.failedGoals.set(goal.key, Date.now() + FAILED_GOAL_RETRY_MS);
                else this.outOfReachSince = null;
                this.goal = null;
                this.nextSearchAt = Date.now() + SEARCH_INTERVAL_MS;
            },
            {
                allowWarpStarts: false,
                walkArrivalRadius: 0.2,
                pitchJitter: () => CombatBot.pathPitchJitter,
                avoidPoints,
                avoidRadius: 1,
                pathValidator: (path) => this.validatePath(path),
                silent: true,
            }
        );
    }

    findSafeGoals(target, position, escape = false) {
        const goals = [];
        const avoidPoints = [];
        const radius = escape ? ESCAPE_SEARCH_RADIUS : Math.ceil(Math.min(CombatBot.attackRange, Player.getPlayer().entityInteractionRange())) + 1;
        for (let x = Math.floor(position.x) - radius; x <= Math.floor(position.x) + radius; x++) {
            for (let z = Math.floor(position.z) - radius; z <= Math.floor(position.z) + radius; z++) {
                const dangerous = this.isDangerousColumn(x, z);
                for (let y = Math.floor(position.y) - 3; y <= Math.floor(position.y) + 2; y++) {
                    if (dangerous) {
                        avoidPoints.push([x, y + 1, z]);
                        continue;
                    }
                    const key = `${x},${y},${z}`;
                    if (this.failedGoals.has(key)) continue;
                    const goal = this.getStandingPosition(x, y, z);
                    if (!goal || (!escape && !this.canAttackFrom(goal, target)) || !this.isSafePosition(goal)) continue;
                    goals.push({ ...goal, key, escape });
                }
            }
        }
        goals.sort((first, second) => CombatBot.getDistanceToPlayer(first).distance - CombatBot.getDistanceToPlayer(second).distance);
        return { goals, avoidPoints };
    }

    getStandingPosition(x, y, z) {
        const world = World.getWorld();
        const blockPos = new BP(x, y, z);
        if (!world.hasChunkAt(blockPos)) return null;
        const radius = Player.getPlayer().getBbWidth() / 2;
        let top = 0;
        for (const box of world.getBlockState(blockPos).getCollisionShape(world, blockPos).toAabbs()) {
            if (box.minX > 0.5 - radius || box.maxX < 0.5 + radius || box.minZ > 0.5 - radius || box.maxZ < 0.5 + radius) continue;
            top = Math.max(top, box.maxY);
        }
        return top > 0 ? { x: x + 0.5, y: y + top, z: z + 0.5, groundY: y } : null;
    }

    isDangerousColumn(x, z) {
        const tick = World.getTime();
        if (this.dangerousColumnsTick !== tick) {
            this.dangerousColumns.clear();
            this.dangerousColumnsTick = tick;
        }
        const key = `${x},${z}`;
        if (!this.dangerousColumns.has(key)) {
            const world = World.getWorld();
            const blocks = World.getBlocksInBox(
                x - DANGEROUS_HORIZONTAL_RADIUS,
                world.getMinY(),
                z - DANGEROUS_HORIZONTAL_RADIUS,
                x + DANGEROUS_HORIZONTAL_RADIUS,
                world.getMaxY(),
                z + DANGEROUS_HORIZONTAL_RADIUS,
                DANGEROUS_BLOCKS
            );
            const activeColumns = new Set();
            for (const block of blocks) activeColumns.add(`${block.x},${block.z}`);
            const now = Date.now();
            let dangerous = false;
            for (let blockX = x - DANGEROUS_HORIZONTAL_RADIUS; blockX <= x + DANGEROUS_HORIZONTAL_RADIUS; blockX++) {
                for (let blockZ = z - DANGEROUS_HORIZONTAL_RADIUS; blockZ <= z + DANGEROUS_HORIZONTAL_RADIUS; blockZ++) {
                    const blockKey = `${blockX},${blockZ}`;
                    if (activeColumns.has(blockKey)) {
                        this.dangerousColumnSafeSince.set(blockKey, null);
                    } else if (this.dangerousColumnSafeSince.has(blockKey)) {
                        const safeSince = this.dangerousColumnSafeSince.get(blockKey) ?? now;
                        if (now - safeSince >= DANGEROUS_RECOVERY_DELAY_MS) this.dangerousColumnSafeSince.delete(blockKey);
                        else this.dangerousColumnSafeSince.set(blockKey, safeSince);
                    }
                    if (this.dangerousColumnSafeSince.has(blockKey)) dangerous = true;
                }
            }
            this.dangerousColumns.set(key, dangerous);
        }
        return this.dangerousColumns.get(key);
    }

    isNearDangerousBlocks(position = { x: Player.getX(), z: Player.getZ() }) {
        const player = Player.getPlayer();
        const body = player.getBoundingBox().move(position.x - player.getX(), 0, position.z - player.getZ());
        for (let x = Math.floor(body.minX + 0.001); x <= Math.floor(body.maxX - 0.001); x++) {
            for (let z = Math.floor(body.minZ + 0.001); z <= Math.floor(body.maxZ - 0.001); z++) {
                if (this.isDangerousColumn(x, z)) return true;
            }
        }
        return false;
    }

    validatePath(path) {
        if (!path?.length) return false;
        const avoidPoints = [];
        // Allow escape from an unsafe starting area, but never re-enter danger after reaching safe ground.
        let reachedSafeGround = !this.isNearDangerousBlocks();
        for (const point of path) {
            if (this.isNearDangerousBlocks({ x: point.x + 0.5, z: point.z + 0.5 })) {
                if (reachedSafeGround) avoidPoints.push([point.x, point.y + 1, point.z]);
            } else {
                reachedSafeGround = true;
            }
        }
        if (avoidPoints.length) Pathfinder.addAvoidPoints(avoidPoints, 1);
        return reachedSafeGround && avoidPoints.length === 0;
    }

    isSafePosition(position) {
        if (this.config.boundaryCheck && !this.config.boundaryCheck(position.x, position.y, position.z)) return false;
        if (this.isNearDangerousBlocks(position)) return false;
        const player = Player.getPlayer();
        const world = World.getWorld();
        const body = player.getBoundingBox().move(position.x - player.getX(), position.y - player.getY(), position.z - player.getZ());
        if (!world.noCollision(player, body)) return false;

        const groundY = Math.floor(position.y - 0.01);
        let supported = false;
        for (let x = Math.floor(body.minX + 0.001); x <= Math.floor(body.maxX - 0.001); x++) {
            for (let z = Math.floor(body.minZ + 0.001); z <= Math.floor(body.maxZ - 0.001); z++) {
                const blockPos = new BP(x, groundY, z);
                if (!world.hasChunkAt(blockPos)) return false;
                for (const box of world.getBlockState(blockPos).getCollisionShape(world, blockPos).toAabbs()) {
                    if (x + box.maxX <= body.minX || x + box.minX >= body.maxX || z + box.maxZ <= body.minZ || z + box.minZ >= body.maxZ) continue;
                    if (Math.abs(groundY + box.maxY - position.y) < 0.05) supported = true;
                }
            }
        }
        return supported;
    }

    canAttackFrom(position, target) {
        const player = Player.getPlayer();
        const point = Rotations.getAimPoint(target);
        const targetPosition = CombatBot.getTargetPosition(target);
        if (!point || !targetPosition || CombatBot.getDistanceBetween(position, targetPosition).distance > CombatBot.attackRange) return false;
        const eye = new Vec3d(position.x, position.y + player.getEyeHeight(), position.z);
        const aim = new Vec3d(point.x, point.y, point.z);
        if (eye.distanceTo(aim) > Math.min(CombatBot.attackRange, player.entityInteractionRange()) - 0.15) return false;
        const hit = World.getWorld().clip(new ClipContext(eye, aim, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
        return !!hit && String(hit.getType()) === 'MISS';
    }
}
