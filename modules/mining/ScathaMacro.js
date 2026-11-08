import { ArmorStandEntity, BP, ClipContext, Direction, Vec3d } from '../../utils/Constants';
import { calculateAbsoluteAngles, offsetPitch, wrapTo180 } from '../../utils/Math';
import { MiningUtils } from '../../utils/MiningUtils';
import { ModuleBase } from '../../utils/ModuleBase';
import { ClientboundLevelParticlesPacket, getLevelParticleData } from '../../utils/Packets';
import { getLookingAt, getVisiblePoint, testPointNative } from '../../utils/Raytrace';
import { registerSkyblockEvent } from '../../utils/SkyblockEvents';
import { getArea, getPickaxeAbilityStatus } from '../../utils/TabListUtils';
import { Mouse } from '../../utils/Ungrab';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { Aote } from '../../utils/pathfinder/PathWalker/PathAote';
import { clickSlot, closeInventory, getGuiName, setItemSlot } from '../../utils/player/Inventory';
import { setKeysForStraightLineCoords } from '../../utils/player/Movement';
import { applyToPlayer, clampPitch } from '../../utils/player/RotationGCD';
import { getRotationCurveOffset, Rotations } from '../../utils/player/Rotations';
import { CombatBot } from '../combat/CombatBot';

const HORIZONTAL_STATES = new Set(['FORWARD', 'BACKWARD', 'RETURN', 'TURN', 'ALIGN']);
const MINING_STATES = new Set([...HORIZONTAL_STATES, 'DESCEND', 'CHEST', 'RECOVERY_HEIGHT']);
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava']);
const HARDSTONE = 'minecraft:stone';
const BLOCK_NEIGHBORS = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
];
const random = (low, high) => low + Math.random() * (high - low);
const randomInt = (low, high) => Math.floor(random(low, high + 1));
const position = () => ({ x: Player.getX(), y: Player.getY(), z: Player.getZ() });
const center = (point) => ({ x: Math.floor(point.x) + 0.5, y: point.y, z: Math.floor(point.z) + 0.5 });
const flatDistance = (point) => Math.hypot(Player.getX() - point.x, Player.getZ() - point.z);
const blockName = (point) => World.getBlockAt(point.x, point.y, point.z)?.type?.getRegistryName();
const key = (point) => `${point.x},${point.y},${point.z}`;
const isChest = (name) => name === 'minecraft:chest' || name === 'minecraft:trapped_chest';
const WORM_SPAWN_TIMEOUT_MS = 60000;
const WORM_DISAPPEAR_GRACE_MS = 5000;
const WORM_COMBAT_OPTIONS = { roam: false, allowWarpStarts: false, travelClicks: false, rightClickChance: 0, allowArmorStands: true, ignoreArmorStandPickable: true };
const WORM_NAMETAG_HEAD_MAX_DISTANCE = 2;
const WORM_APPROACH_STOP_DISTANCE = 3.5;
const WORM_NAMETAG_GRACE_MS = 3000;
const WORM_SEGMENT_GRACE_MS = 1500;
const WORM_TUNNEL_HALF_LENGTH = 32;
const WORM_TUNNEL_HALF_WIDTH = 1.5;
const FORWARD_STOP_DISTANCE = 2;
const ABILITY_STATES = new Set(['FORWARD', 'BACKWARD', 'TURN', 'DESCEND']);
const ABILITY_FALLBACK_COOLDOWN_MS = 200000;
const ABILITY_RETRY_DELAY_MS = 5000;
const cleanChat = (text) =>
    String(ChatLib.removeFormatting(String(text)))
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

class ScathaMacro extends ModuleBase {
    constructor() {
        super({
            name: 'Scatha Macro',
            subcategory: 'Mining',
            description: 'Mines 1x2 tunnels and hunts Stoneworms and Scathas in the Crystal Hollows.',
            isMacro: true,
        });
        this.generation = 0;
        this.state = 'IDLE';
        this.ownsPath = false;
        this.ownsCombat = false;
        this.returnOriginalSlot = null;
        this.restoreMouseOnDisable = false;
        this.initSettings();
        this.bindToggleKey();
        this.on('tick', () => this.tick());
        this.on('postRenderWorld', () => this.updateRotation());
        this.on('worldUnload', () => this.onWorldUnload());
        this.on('chat', (event) => {
            const message = cleanChat(event.message.getUnformattedText());
            if (/^You hear the sound of something approaching(?:\.{3}|\u2026)?$/i.test(message)) return this.interruptForWorm();
            if (this.state === 'LOADOUT' && /loadout/i.test(message) && /can't|cannot|can only|cooldown|wait|unable|locked/i.test(message)) {
                this.currentLoadout = null;
                this.loadoutRequest.phase = 'OPEN';
                this.loadoutRequest.dueAt = Date.now() + this.delay(this.actionDelay);
            }
        }).triggerIfCanceled(true);
        this.on('packetReceived', (packet) => {
            if (this.state !== 'CHEST' || !this.chest?.clickedAt) return;
            const data = getLevelParticleData(packet);
            if (data.particle?.getType() !== net.minecraft.core.particles.ParticleTypes.CRIT) return;
            const point = this.chest.point;
            if (Math.abs(data.x - point.x - 0.5) < 0.8 && Math.abs(data.y - point.y - 0.5) < 0.8 && Math.abs(data.z - point.z - 0.5) < 0.8) {
                const distance = Math.hypot(data.x - Player.getX(), data.z - Player.getZ());
                this.chest.particle = offsetPitch({ x: data.x, y: data.y, z: data.z }, 5 / Math.max(1, distance));
                this.chest.particleAt = Date.now();
                this.chest.progressAt = this.chest.particleAt;
            }
        }).setFilteredClass(ClientboundLevelParticlesPacket);
        for (const event of ['chestsolve', 'chestopen']) {
            registerSkyblockEvent(event, () => {
                if (this.enabled && this.state === 'CHEST' && this.chest?.clickedAt) this.chest.opened = true;
            });
        }
        registerSkyblockEvent('fasttravellocked', () => {
            if (this.enabled && this.state === 'WARP') this.stop('The Crystal Nucleus warp is not unlocked.');
        });
        registerSkyblockEvent('death', () => {
            if (this.enabled) this.switchLobby('death');
        });
        registerSkyblockEvent('abilityready', () => {
            if (this.enabled && this.useTunnelVision) this.abilityFromChat = true;
        });
        for (const event of ['abilityused', 'abilitycooldown']) {
            registerSkyblockEvent(event, () => {
                if (!this.enabled || !this.useTunnelVision || !ABILITY_STATES.has(this.state) || Player.getHeldItemIndex() !== this.miningSlot - 1) return;
                this.abilityFromChat = false;
                this.abilityUseAt = 0;
                this.abilityClickPending = false;
                this.lastAbilityUseAt = Date.now();
            });
        }
        registerSkyblockEvent('emptydrill', () => {
            if (this.enabled) this.stop('The mining tool is out of fuel. Refuel it before restarting.');
        });
        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.state,
                    'Tunnel Y': () => this.tunnelY ?? this.targetY,
                    Direction: () => (this.lane ? `${this.lane.sign > 0 ? '+' : '-'}${this.lane.axis.toUpperCase()}` : 'None'),
                    'Lobby intensity': () => `${this.lobbyIntensity ?? 0}/${this.lobbyThreshold}`,
                    'Exit intensity': () => `${this.exitIntensity ?? 0}/${this.exitThreshold}`,
                },
            },
        ]);
    }

    initSettings() {
        const slider = (title, field, min, max, value, description) => {
            this[field] = value;
            this.addSlider(title, min, max, value, (input) => (this[field] = Math.max(min, Math.min(max, Math.round(input)))), description);
        };
        const range = (title, field, min, max, low, high, description) => {
            this[field] = { low, high };
            this.addRangeSlider(
                title,
                min,
                max,
                { low, high },
                (value) => {
                    const first = Math.max(min, Math.min(max, Number(value.low) || low));
                    const second = Math.max(min, Math.min(max, Number(value.high) || high));
                    this[field] = { low: Math.min(first, second), high: Math.max(first, second) };
                },
                description
            );
        };
        slider('Mining Y', 'targetY', 31, 40, 31, 'Feet height of the 1x2 tunnel. Applied when starting a new lobby.');
        slider('Mining Slot', 'miningSlot', 1, 9, 1, 'Hotbar slot containing the mining tool.');
        slider('Attack Slot', 'attackSlot', 1, 9, 2, 'Hotbar slot containing the combat weapon.');
        slider('Block Slot', 'blockSlot', 1, 9, 3, 'Hotbar slot containing full blocks for height recovery.');
        this.useTunnelVision = false;
        this.addToggle(
            'Use Tunnel Vision',
            (value) => (this.useTunnelVision = value),
            'Automatically uses the pickaxe ability while mining. Select Tunnel Vision in Heart of the Mountain first.',
            false
        );
        slider('Forward Loadout', 'forwardLoadout', 1, 12, 1, 'Loadout number for forward mining. Mining Spread must be 0.');
        slider('Backward Loadout', 'backwardLoadout', 1, 12, 2, 'Loadout number for backward mining. Maximize Mining Spread.');
        slider('Combat Loadout', 'combatLoadout', 1, 12, 3, 'Loadout number used to kill Stoneworms and Scathas.');
        range('Forward Mining Time (s)', 'forwardTime', 10, 200, 60, 90, 'Random time before each backward pass. Combat and recovery pause this timer.');
        range('UI Click Delay (ms)', 'clickDelay', 100, 2000, 200, 400, 'Random delay before inventory clicks and chest interactions.');
        range('Action Delay (ms)', 'actionDelay', 500, 5000, 1000, 3000, 'Random delay between macro states.');
        range('Rotation Time (ms)', 'rotationTime', 100, 1000, 150, 300, 'Random duration of non-linear mining, turning, movement, and chest rotations.');
        slider('Lobby Failsafe Threshold', 'lobbyThreshold', 1, 1000, 200, 'Chat Mention and Player Grief intensity. Switching lobbies clears this counter.');
        slider('Exit Failsafe Threshold', 'exitThreshold', 1, 1000, 200, 'All other failsafe events. Stops the macro when reached.');
        slider('Intensity Decay per 10s', 'intensityDecay', 0, 50, 5, 'Subtract this amount from both counters every 10 seconds.');
    }

    delay(range) {
        return typeof range === 'number' ? range : randomInt(range.low, range.high);
    }

    onEnable() {
        if (!Player.getPlayer() || !World.isLoaded()) return this.stop('Join SkyBlock before starting.');
        if (CombatBot.enabled || Pathfinder.isPathing()) return this.stop('Stop the active Combat Bot or path before starting.');
        this.restoreMouseOnDisable = !Client.isUngrabbed();
        Mouse.ungrab();
        this.generation++;
        this.lobbyIntensity = 0;
        this.exitIntensity = 0;
        this.nextDecay = Date.now() + 10000;
        this.hopAttempts = 0;
        this.previousServer = null;
        this.lobbyId = null;
        this.abilityFromChat = false;
        this.abilityUseAt = 0;
        this.abilityClickPending = false;
        this.lastAbilityUseAt = 0;
        this.resetLobby();
        this.miningSpeed = MiningUtils.getMiningSpeed('Crystal Hollows');
        if (getArea() === 'Crystal Hollows' && Math.abs(Player.getY() - this.tunnelY) <= 0.12) {
            const directions = [
                { axis: 'z', sign: 1 },
                { axis: 'x', sign: -1 },
                { axis: 'z', sign: -1 },
                { axis: 'x', sign: 1 },
            ];
            const direction = directions[((Math.round(Player.getYaw() / 90) % 4) + 4) % 4];
            this.lane = { ...direction, turnSign: Math.random() < 0.5 ? -1 : 1 };
            this.setLaneStart(position());
            this.safePoint = position();
            this.turnGoal = null;
            this.lobbyId = this.getLobbyId();
            this.switchLoadout(this.forwardLoadout, 'FORWARD');
        } else this.setState('WARP');
        this.message('&aEnabled');
    }

    onDisable() {
        this.generation++;
        try {
            this.stopActivities();
            if (this.state === 'LOADOUT') closeInventory();
            this.state = 'IDLE';
            this.loadoutRequest = null;
            this.combatResume = null;
            this.wormSearch = null;
            this.wormLastStandPosition = null;
            this.wormTargets = [];
            this.wormCandidates?.clear();
            this.wormNametags?.clear();
            this.returnJob = null;
            this.recovery = null;
            this.chest = null;
        } finally {
            const restoreMouse = this.restoreMouseOnDisable;
            this.restoreMouseOnDisable = false;
            if (restoreMouse) Mouse.regrab();
        }
        this.message('&cDisabled');
    }

    stop(reason) {
        this.message(`&c${reason}`);
        this.toggle(false);
    }

    resetLobby() {
        this.tunnelY = this.targetY;
        this.lane = null;
        this.currentLoadout = null;
        this.loadoutRequest = null;
        this.combatResume = null;
        this.wormOrigin = null;
        this.wormSearch = null;
        this.wormWarningAt = 0;
        this.wormLastSeenAt = 0;
        this.wormLastStandPosition = null;
        this.wormTargets = [];
        this.wormCandidates = new Map();
        this.wormNametags = new Map();
        this.returnJob = null;
        this.recovery = null;
        this.chest = null;
        this.safePoint = null;
        this.guiPausedAt = 0;
        this.cooldownY = null;
        this.openedChests = new Set();
        this.forwardStart = null;
        this.forwardObstacle = null;
        this.forwardRemaining = null;
        this.turnPending = false;
        this.lavaCandidates = [];
        this.lavaTarget = null;
        this.lavaAttempts = 0;
    }

    stopControls() {
        Client.stopMovement();
        for (const button of ['leftclick', 'rightclick', 'shift', 'space', 'sprint']) Client.setKey(button, false);
        Rotations.stop();
        this.rotation = null;
        this.forwardAligned = false;
        this.forwardBlocked = null;
        this.correctingLane = false;
        this.freeMiningTarget = null;
    }

    stopActivities() {
        this.abilityUseAt = 0;
        this.abilityClickPending = false;
        this.returnTeleport = null;
        this.returnTeleportBlocked = null;
        if (this.ownsCombat) {
            CombatBot.toggle(false, true);
            CombatBot.clearExternalTargets();
            this.ownsCombat = false;
        }
        if (this.ownsPath) {
            Pathfinder.resetPath();
            this.ownsPath = false;
        }
        if (this.returnOriginalSlot !== null) {
            if (Player.getPlayer()) setItemSlot(this.returnOriginalSlot);
            this.returnOriginalSlot = null;
        }
        this.stopControls();
    }

    setState(state, transitionDelay = this.actionDelay) {
        this.stopActivities();
        this.heightCheckAt = 0;
        this.mineTarget = null;
        this.forwardPitch = null;
        this.forwardYaw = null;
        this.state = state;
        this.readyAt = Date.now() + (state === 'CHEST' ? 0 : this.delay(transitionDelay));
        this.startedAt = this.readyAt;
        this.initialized = false;
        if (state === 'COOLDOWN') this.cooldownY = Player.getY();
        this.progressPoint = null;
        this.progressAt = this.readyAt;
    }

    aimAt(target, targetId = null) {
        if (!this.rotation) {
            Rotations.stop();
            this.rotation = { yaw: Player.getYaw(), pitch: Player.getPitch(), updatedAt: Date.now() };
            if (target.forward && this.forwardPitch) {
                this.forwardYaw = null;
                this.forwardPitch.from = this.rotation.pitch;
                this.forwardPitch.startedAt = this.rotation.updatedAt;
                this.forwardPitch.complete = false;
            }
        }
        this.rotation.target = target;
        this.rotation.targetId = targetId;
    }

    updateRotation() {
        const rotation = this.rotation;
        if (!rotation || !Player.getPlayer() || !World.isLoaded() || Client.isInGui()) return;
        const now = Date.now();
        rotation.updatedAt = now;
        if (rotation.target.forward) {
            rotation.motion = null;
            if (!this.forwardPitch) return;
            if (!this.forwardYaw || (this.forwardAligned && now >= this.forwardYaw.startedAt + this.forwardYaw.duration)) {
                this.forwardYaw = {
                    from: this.forwardYaw?.target ?? rotation.yaw,
                    target: this.yaw(this.lane) + random(-3, 3),
                    startedAt: now,
                    duration: this.delay(this.rotationTime),
                    curveSeed: random(0, Math.PI * 2),
                };
            }
            for (const [axis, motion] of [
                ['yaw', this.forwardYaw],
                ['pitch', this.forwardPitch],
            ]) {
                const progress = Math.max(0, Math.min(1, (now - motion.startedAt) / motion.duration));
                const eased = progress * progress * (3 - 2 * progress);
                const delta = axis === 'yaw' ? wrapTo180(motion.target - motion.from) : motion.target - motion.from;
                const curve = getRotationCurveOffset(eased, Math.abs(delta), motion.curveSeed);
                rotation[axis] = motion.from + delta * eased + (axis === 'yaw' ? curve.x : curve.y);
                motion.complete = progress === 1;
            }
        } else {
            const target = Number.isFinite(rotation.target.yaw) ? rotation.target : calculateAbsoluteAngles(rotation.target);
            this.updateTimedRotation(rotation, target, now);
        }
        applyToPlayer(rotation.yaw, rotation.pitch);
        if (rotation.target.forward && this.forwardAligned && this.forwardPitch.complete) {
            this.setForwardPitch(!this.preferHead);
        }
    }

    updateTimedRotation(rotation, target, now) {
        let motion = rotation.motion;
        if (
            !motion ||
            motion.targetId !== rotation.targetId ||
            (motion.complete && (Math.abs(wrapTo180(target.yaw - motion.yaw)) > 0.1 || Math.abs(target.pitch - motion.pitch) > 0.1))
        ) {
            motion = {
                targetId: rotation.targetId,
                fromYaw: rotation.yaw,
                fromPitch: rotation.pitch,
                yaw: rotation.yaw + wrapTo180(target.yaw - rotation.yaw),
                pitch: clampPitch(target.pitch),
                startedAt: now,
                duration: this.delay(this.rotationTime),
                curveSeed: random(0, Math.PI * 2),
                complete: false,
            };
            rotation.motion = motion;
        }
        const progress = Math.max(0, Math.min(1, (now - motion.startedAt) / motion.duration));
        const eased = progress * progress * (3 - 2 * progress);
        const yaw = motion.yaw - motion.fromYaw;
        const pitch = motion.pitch - motion.fromPitch;
        const curve = getRotationCurveOffset(eased, Math.hypot(yaw, pitch), motion.curveSeed);
        rotation.yaw = motion.fromYaw + yaw * eased + curve.x;
        rotation.pitch = clampPitch(motion.fromPitch + pitch * eased + curve.y);
        motion.complete = progress === 1;
    }

    selectSlot(slot) {
        if (Player.getHeldItemIndex() === slot - 1) return true;
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        setItemSlot(slot - 1);
        return false;
    }

    onFailsafeTrigger(event) {
        if (!this.enabled) return;
        this.decayIntensity();
        const intensity = Number(event?.intensity);
        if (!Number.isFinite(intensity) || intensity <= 0) return;
        if (event.type === 'Chat Mention' || event.type === 'Player Grief') this.lobbyIntensity += intensity;
        else this.exitIntensity += intensity;
    }

    decayIntensity() {
        const now = Date.now();
        if (!this.nextDecay || now < this.nextDecay) return;
        const intervals = Math.floor((now - this.nextDecay) / 10000) + 1;
        this.lobbyIntensity = Math.max(0, this.lobbyIntensity - intervals * this.intensityDecay);
        this.exitIntensity = Math.max(0, this.exitIntensity - intervals * this.intensityDecay);
        this.nextDecay += intervals * 10000;
    }

    onWorldUnload() {
        this.generation++;
        this.stopActivities();
        this.currentLoadout = null;
        if (this.state !== 'WARP' && this.state !== 'HOP') this.switchLobby('Unexpected world change');
    }

    switchLobby(reason) {
        if (this.state === 'HOP') return;
        this.message(`&eSwitching Crystal Hollows lobby: ${reason}`);
        this.previousServer = this.lobbyId || this.getLobbyId() || this.previousServer;
        this.generation++;
        if (this.state === 'LOADOUT') closeInventory();
        this.resetLobby();
        this.lobbyIntensity = 0;
        this.setState('HOP');
    }

    tick() {
        this.decayIntensity();
        if (this.exitIntensity >= this.exitThreshold) return this.stop('Exit failsafe threshold reached.');
        if (this.lobbyIntensity >= this.lobbyThreshold && !['HOP', 'WARP'].includes(this.state)) return this.switchLobby('Lobby failsafe threshold reached');
        if (!Player.getPlayer() || !World.isLoaded()) return;
        if (['HOP', 'WARP'].includes(this.state) && !cleanChat(Scoreboard.getTitle()).includes('SKYBLOCK')) {
            this.initialized = false;
            return;
        }
        if (!['HOP', 'WARP'].includes(this.state) && getArea() !== 'Crystal Hollows') return this.switchLobby('Left the Crystal Hollows');
        if (this.checkHeight()) return;
        // Entity packets can arrive while the combat loadout screen is open.
        // Keep tracking without starting combat or interrupting the GUI transition.
        if (this.state === 'LOADOUT' && this.loadoutRequest?.nextState === 'WAIT_WORM') this.findWormTargets();
        if (Date.now() < this.readyAt) return;
        if (Client.isInGui() && this.state !== 'LOADOUT') {
            this.stopActivities();
            if (!this.guiPausedAt) this.guiPausedAt = Date.now();
            if (Date.now() - this.guiPausedAt > 30000) this.stop('Close the open screen before restarting.');
            return;
        }
        if (this.guiPausedAt) {
            const elapsed = Date.now() - this.guiPausedAt;
            this.startedAt += elapsed;
            if (this.state === 'WAIT_WORM' && this.wormWarningAt) this.wormWarningAt += elapsed;
            if (this.state === 'WORM' && this.wormLastSeenAt) this.wormLastSeenAt += elapsed;
            this.forwardUntil += elapsed;
            this.progressAt += elapsed;
            if (this.chest) {
                this.chest.progressAt += elapsed;
                if (this.chest.approach) this.chest.approach.startedAt += elapsed;
            }
            this.guiPausedAt = 0;
        }
        if (!this.initialized) {
            this.initialized = true;
            this.startState();
        }
        if (Date.now() < this.readyAt || !this.enabled) return;
        if (this.useMiningAbility()) return;
        switch (this.state) {
            case 'HOP':
                return this.tickHop();
            case 'WARP':
                return this.tickWarp();
            case 'LOADOUT':
                return this.tickLoadout();
            case 'SCAN_LAVA':
                return this.scanLava();
            case 'PATH_LAVA':
                return this.tickLavaPath();
            case 'ENTER_LAVA':
                return this.enterLava();
            case 'DESCEND':
                return this.descend();
            case 'ALIGN':
                return this.align();
            case 'FORWARD':
                return this.mineForward();
            case 'BACKWARD':
                return this.mineBackward();
            case 'RETURN':
                return this.returnToFace();
            case 'TURN':
                return this.turnLane();
            case 'CHEST':
                return this.tickChest();
            case 'WAIT_WORM':
                return this.waitForWorm();
            case 'WORM':
                return this.fightWorm();
            case 'COOLDOWN':
                return this.tickCooldown();
            case 'RESUME_PATH':
                return this.tickReturnPath();
            case 'RECOVERY_HEIGHT':
                return this.recoverHeight();
        }
    }

    startState() {
        switch (this.state) {
            case 'HOP':
                ChatLib.command('warp hub');
                this.lastCommandAt = Date.now();
                this.commandAttempts = 1;
                break;
            case 'WARP':
                ChatLib.command('warp nucleus');
                this.lastCommandAt = Date.now();
                this.commandAttempts = 1;
                break;
            case 'SCAN_LAVA': {
                this.scanChunks = [];
                this.lavaSeen = 0;
                const x = Math.floor(Player.getX() / 16);
                const z = Math.floor(Player.getZ() / 16);
                for (let dx = -16; dx <= 16; dx++) for (let dz = -16; dz <= 16; dz++) this.scanChunks.push([16 * (x + dx), 16 * (z + dz)]);
                break;
            }
            case 'PATH_LAVA':
                this.startLavaPath();
                break;
            case 'ALIGN':
                this.alignPoint = center({ ...position(), y: this.tunnelY });
                break;
            case 'FORWARD':
                if (this.forwardRemaining === null || !this.forwardStart) {
                    this.forwardStart = position();
                    this.forwardObstacle = null;
                }
                this.forwardUntil = Date.now() + (this.forwardRemaining ?? this.delay(this.forwardTime) * 1000);
                this.forwardRemaining = null;
                this.nextTunnelCheck = 0;
                this.preferHead = Math.random() < 0.5;
                break;
            case 'BACKWARD':
                this.backwardYaw = this.yaw(this.lane) + random(-3, 3);
                this.backwardPitch = random(-15, -7);
                break;
            case 'TURN':
                if (!this.turnGoal) {
                    this.turnOrigin = center({ ...position(), y: this.tunnelY });
                    this.turnGoal = this.offset(this.turnOrigin, this.turnDirection(), randomInt(4, 6));
                }
                this.randomizeCorridor();
                break;
            case 'WAIT_WORM':
                this.wormTargets = [];
                this.wormMissingAt = 0;
                break;
            case 'COOLDOWN':
                this.cooldownUntil = Date.now() + this.cooldownDuration;
                this.cooldownY = Player.getY();
                break;
            case 'RESUME_PATH':
                this.startReturnPath();
                break;
        }
    }

    retryCommand(command) {
        if (Date.now() - this.lastCommandAt < 10000) return;
        if (++this.commandAttempts > 3) return this.stop(`Timed out waiting for /${command}.`);
        ChatLib.command(command);
        this.lastCommandAt = Date.now();
    }

    tickHop() {
        if (Date.now() - this.lastCommandAt >= 3000 && getArea() !== 'Crystal Hollows' && getArea() !== 'unknown') {
            return this.setState('WARP');
        }
        this.retryCommand('warp hub');
    }

    tickWarp() {
        const inNucleus = Player.getX() >= 472 && Player.getX() <= 554 && Player.getZ() >= 472 && Player.getZ() <= 554 && Player.getY() >= 90;
        if (Date.now() - this.lastCommandAt >= 3000 && getArea() === 'Crystal Hollows' && inNucleus) {
            const server = this.getLobbyId();
            if (this.previousServer && server === this.previousServer) {
                if (++this.hopAttempts >= 5) return this.stop('Could not find a different Crystal Hollows lobby after five attempts.');
                return this.switchLobby('Returned to the previous lobby');
            }
            this.previousServer = null;
            this.lobbyId = server;
            this.hopAttempts = 0;
            return this.switchLoadout(this.forwardLoadout, 'SCAN_LAVA');
        }
        this.retryCommand('warp nucleus');
    }

    getLobbyId() {
        for (const line of Scoreboard.getLines() || []) {
            const match = ChatLib.removeFormatting(String(line.getName())).match(/\b(?:mini|mega)\d+[a-zA-Z]*\b/);
            if (match) return match[0];
        }
        return null;
    }

    switchLoadout(number, nextState, transitionDelay = this.actionDelay) {
        if (nextState === 'WAIT_WORM') transitionDelay = 0;
        if (this.currentLoadout === number) return this.setState(nextState, transitionDelay);
        this.loadoutRequest = { number, nextState, transitionDelay, phase: 'OPEN', attempts: 0, dueAt: 0 };
        this.setState('LOADOUT', transitionDelay);
    }

    tickLoadout() {
        const request = this.loadoutRequest;
        const now = Date.now();
        if (!request) return this.stop('Missing loadout transition.');
        if (now < request.dueAt) return;
        if (request.phase === 'OPEN') {
            if (++request.attempts > 3) return this.stop(`Could not select Loadout ${request.number}. Check that it exists and is unlocked.`);
            closeInventory();
            ChatLib.command('loadout');
            request.phase = 'WAIT';
            request.sentAt = now;
            request.dueAt = now + this.delay(this.clickDelay);
            return;
        }
        const container = Player.getContainer();
        const loadoutOpen = container && /loadout/i.test(String(getGuiName() || ''));
        if (request.phase === 'WAIT') {
            if (now - request.sentAt > 10000) {
                request.phase = 'OPEN';
                request.dueAt = now + this.delay(this.actionDelay);
                return;
            }
            if (!loadoutOpen) return;
            const items = container.getItems() || [];
            const slot = items.findIndex((item, index) => {
                if (!item || index >= items.length - 36) return false;
                const match = ChatLib.removeFormatting(String(item.getName()))
                    .trim()
                    .match(/^Loadout\s*#?\s*(\d+)(?:\s|$)/i);
                return match && Number(match[1]) === request.number;
            });
            if (slot < 0) return;
            request.slot = slot;
            request.phase = 'CLICK';
            request.dueAt = now + this.delay(this.clickDelay);
            return;
        }
        if (request.phase === 'CLICK') {
            if (!loadoutOpen) {
                request.phase = 'WAIT';
                return;
            }
            const item = container.getStackInSlot(request.slot);
            const match = ChatLib.removeFormatting(item ? String(item.getName()) : '')
                .trim()
                .match(/^Loadout\s*#?\s*(\d+)(?:\s|$)/i);
            if (!match || Number(match[1]) !== request.number || !clickSlot(request.slot)) {
                request.phase = 'WAIT';
                return;
            }
            request.phase = 'CLOSE';
            request.dueAt = now + this.delay(this.clickDelay);
            return;
        }
        if (request.phase === 'CLOSE') {
            closeInventory();
            request.phase = 'SETTLE';
            request.dueAt = now + (request.nextState === 'WAIT_WORM' ? 0 : this.delay(this.actionDelay));
            if (now < request.dueAt) return;
        }
        this.currentLoadout = request.number;
        this.loadoutRequest = null;
        this.setState(request.nextState, request.transitionDelay);
    }

    scanLava() {
        const world = World.getWorld();
        // Bound each tick's native scan so a large render distance does not stall movement or failsafes.
        for (let budget = 0; budget < 4 && this.scanChunks.length; budget++) {
            const [x, z] = this.scanChunks.pop();
            if (x > 823 || x + 15 < 202 || z > 823 || z + 15 < 202 || !world.hasChunkAt(new BP(x, 50, z))) continue;
            const blocks = World.getBlocksInBox(x, 46, z, x + 15, 64, z + 15, [new BlockType('minecraft:lava')]);
            for (const block of blocks) {
                const point = { x: block.x, y: block.y, z: block.z };
                if (
                    !world
                        .getBlockState(new BP(point.x, point.y, point.z))
                        .getFluidState()
                        .isSource()
                )
                    continue;
                if (!this.passable({ ...point, y: point.y + 1 }) || !this.passable({ ...point, y: point.y + 2 })) continue;
                const goals = this.lavaShoreGoals(point);
                if (!goals.length) continue;
                const candidate = { point, goals };
                const index = randomInt(0, this.lavaSeen++);
                if (this.lavaCandidates.length < 128) this.lavaCandidates.push(candidate);
                else if (index < 128) this.lavaCandidates[index] = candidate;
            }
        }
        if (this.scanChunks.length) return;
        if (!this.lavaCandidates.length) return this.switchLobby('No reachable source lava found between Y=46 and Y=64 in loaded chunks');
        this.setState('PATH_LAVA');
    }

    lavaShoreGoals(point) {
        const world = World.getWorld();
        const goals = [];
        for (const [dx, dz] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
        ]) {
            for (const dy of [0, 1, -1]) {
                const x = point.x + dx;
                const y = point.y + dy;
                const z = point.z + dz;
                const floor = new BP(x, y - 1, z);
                if (!world.hasChunkAt(floor) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP)) continue;
                if (this.passable({ x, y, z }) && this.passable({ x, y: y + 1, z })) goals.push([x, y - 1, z]);
            }
        }
        return goals;
    }

    startPath(goals, job) {
        const generation = this.generation;
        this.ownsPath = true;
        job.result = null;
        Pathfinder.findPath(
            goals,
            (success) => {
                if (this.enabled && generation === this.generation && this.ownsPath) job.result = !!success;
            },
            { allowWarpStarts: false, walkArrivalRadius: 0.8, silent: true }
        );
    }

    startLavaPath() {
        if (!this.lavaCandidates.length || ++this.lavaAttempts > 8) return this.switchLobby('Could not path to a lava pool');
        const index = randomInt(0, this.lavaCandidates.length - 1);
        this.lavaTarget = this.lavaCandidates.splice(index, 1)[0];
        this.startPath(this.lavaTarget.goals, this.lavaTarget);
    }

    tickLavaPath() {
        if (this.lavaTarget.result === true) return this.setState('ENTER_LAVA');
        if (this.lavaTarget.result === false || Date.now() - this.startedAt > 60000) return this.setState('PATH_LAVA');
        if (!Pathfinder.isPathing()) this.setState('PATH_LAVA');
    }

    enterLava() {
        if (Date.now() - this.startedAt > 15000) return this.setState('PATH_LAVA');
        if (this.alignLavaColumn() && Player.getY() <= this.lavaTarget.point.y + 1) this.setState('DESCEND');
    }

    alignLavaColumn() {
        const point = center(this.lavaTarget.point);
        const player = Player.getPlayer();
        const bounds = player.getBoundingBox();
        const aligned =
            flatDistance(point) <= 0.1 &&
            bounds.minX > point.x - 0.5 &&
            bounds.maxX < point.x + 0.5 &&
            bounds.minZ > point.z - 0.5 &&
            bounds.maxZ < point.z + 0.5;
        if (aligned) Client.stopMovement();
        else {
            this.aimAt({ ...point, y: Player.getY() + 1 });
            setKeysForStraightLineCoords(point.x, point.y, point.z, false);
        }
        Client.setKey('sprint', false);
        const world = World.getWorld();
        const floor = new BP(Math.floor(point.x), Math.floor(Player.getY() - 0.05), Math.floor(point.z));
        // Sneaking on the shore can prevent stepping off its edge into the shaft.
        Client.setKey('shift', !aligned && (!player.onGround() || !world.getBlockState(floor).getCollisionShape(world, floor).isEmpty()));
        const settled = aligned && Math.hypot(Player.getMotionX(), Player.getMotionZ()) < 0.02;
        if (!settled) Client.setKey('leftclick', false);
        return settled;
    }

    descend() {
        if (Player.getY() <= this.tunnelY + 0.08) {
            this.stopControls();
            if (Player.getY() < this.tunnelY - 0.25) return this.switchLobby('The entry shaft opened below the target height');
            if (Player.getPlayer().onGround()) return this.setState('ALIGN');
            return;
        }
        if (Date.now() - this.startedAt > 120000) return this.switchLobby('Entry shaft descent timed out');
        if (!this.alignLavaColumn()) return;
        const point = { x: Math.floor(Player.getX()), y: Math.floor(Player.getY() - 0.05), z: Math.floor(Player.getZ()) };
        if (point.y < this.tunnelY) return;
        if (blockName(point) === 'minecraft:bedrock') return this.switchLobby('Bedrock blocks the entry shaft');
        this.mineBlock(point, true);
    }

    align() {
        if (!this.walkTo(this.alignPoint)) return;
        const axis = Math.random() < 0.5 ? 'x' : 'z';
        this.lane = { axis, sign: Math.random() < 0.5 ? -1 : 1, turnSign: Math.random() < 0.5 ? -1 : 1 };
        this.setLaneStart(position());
        this.turnGoal = null;
        this.setState('FORWARD');
    }

    yaw(direction) {
        return direction.axis === 'x' ? -90 * direction.sign : direction.sign > 0 ? 0 : 180;
    }

    setLaneStart(point) {
        this.laneStart = center({ ...point, y: this.tunnelY });
        this.laneStart[this.lane.axis] = point[this.lane.axis];
    }

    moveAlongLane(direction, origin = this.laneStart, facing = this.lane) {
        const other = direction.axis === 'x' ? 'z' : 'x';
        const coordinate = position()[other];
        const laneBlock = Math.floor(origin[other]);
        const deviation = Math.abs(coordinate - origin[other]);
        if (coordinate < laneBlock + 0.29 || coordinate > laneBlock + 0.71) this.correctingLane = true;
        else if (deviation <= 0.15) this.correctingLane = false;
        if (this.correctingLane) {
            const goal = this.offset(position(), direction, 0.35);
            goal[other] = origin[other];
            setKeysForStraightLineCoords(goal.x, goal.y, goal.z, false);
        } else {
            Client.setKey('a', false);
            Client.setKey('d', false);
            Client.setKey('w', direction.sign === facing.sign);
            Client.setKey('s', direction.sign !== facing.sign);
            Client.setKey('space', false);
        }
        Client.setKey('shift', this.correctingLane);
        Client.setKey('sprint', false);
    }

    overlappingChest() {
        const world = World.getWorld();
        const bounds = Player.getPlayer().getBoundingBox();
        for (let y = Math.floor(bounds.minY + 0.001); y <= Math.floor(bounds.maxY - 0.001); y++) {
            for (let x = Math.floor(bounds.minX + 0.001); x <= Math.floor(bounds.maxX - 0.001); x++) {
                for (let z = Math.floor(bounds.minZ + 0.001); z <= Math.floor(bounds.maxZ - 0.001); z++) {
                    const point = { x, y, z };
                    if (!this.loaded(point) || !isChest(blockName(point)) || this.openedChests.has(key(point))) continue;
                    const pos = new BP(x, y, z);
                    for (const box of world.getBlockState(pos).getCollisionShape(world, pos).toAabbs()) {
                        if (bounds.intersects(box.move(x, y, z))) return point;
                    }
                }
            }
        }
        return null;
    }

    blockingAhead(direction, distance = 0.25, ignoredPoint = null) {
        const player = Player.getPlayer();
        const world = World.getWorld();
        const delta = this.offset({ x: 0, y: 0, z: 0 }, direction, distance);
        const bounds = player.getBoundingBox().expandTowards(delta.x, 0, delta.z);
        let nearest = null;
        for (let y = Math.floor(bounds.maxY - 0.001); y >= Math.floor(bounds.minY + 0.001); y--) {
            for (let x = Math.floor(bounds.minX + 0.001); x <= Math.floor(bounds.maxX - 0.001); x++) {
                for (let z = Math.floor(bounds.minZ + 0.001); z <= Math.floor(bounds.maxZ - 0.001); z++) {
                    const point = { x, y, z };
                    if (ignoredPoint && key(point) === key(ignoredPoint)) continue;
                    if (nearest && (point[direction.axis] - nearest[direction.axis]) * direction.sign >= 0) continue;
                    if (!this.loaded(point)) return { ...point, unknown: true };
                    const pos = new BP(x, y, z);
                    for (const box of world.getBlockState(pos).getCollisionShape(world, pos).toAabbs()) {
                        if (!bounds.intersects(box.move(x, y, z))) continue;
                        nearest = point;
                        break;
                    }
                }
            }
        }
        return nearest;
    }

    turnDirection() {
        return { axis: this.lane.axis === 'x' ? 'z' : 'x', sign: this.lane.turnSign };
    }

    offset(point, direction, distance) {
        const movement = direction.sign * distance;
        // Rhino can lose local scope when evaluating computed keys in object literals.
        return {
            x: point.x + (direction.axis === 'x' ? movement : 0),
            y: point.y,
            z: point.z + (direction.axis === 'z' ? movement : 0),
        };
    }

    loaded(point) {
        return World.getWorld().hasChunkAt(new BP(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)));
    }

    passable(point) {
        if (!this.loaded(point)) return false;
        const world = World.getWorld();
        const pos = new BP(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
        const state = world.getBlockState(pos);
        return state.getFluidState().isEmpty() && state.getCollisionShape(world, pos).isEmpty();
    }

    scanTunnel(y, direction, origin = position()) {
        let run = 0;
        const side = { axis: direction.axis === 'x' ? 'z' : 'x', sign: 1 };
        for (let step = 1; step <= 24; step++) {
            if (step > 20 && run === 0) break;
            const point = this.offset({ x: Math.floor(origin.x), y: Math.floor(y), z: Math.floor(origin.z) }, direction, step);
            const column = [
                { ...point, y: point.y - 1 },
                point,
                { ...point, y: point.y + 1 },
                { ...point, y: point.y + 2 },
                this.offset(point, side, -1),
                this.offset(point, side, 1),
                this.offset({ ...point, y: point.y + 1 }, side, -1),
                this.offset({ ...point, y: point.y + 1 }, side, 1),
            ];
            if (column.some((block) => !this.loaded(block))) return { unknown: true, open: false };
            const names = column.map(blockName);
            if (names[1] === 'minecraft:bedrock' || names[2] === 'minecraft:bedrock') return { open: false, boundary: step };
            run = names.every((name) => name && !AIR.has(name)) ? run + 1 : 0;
            if (run === 5) return { open: false };
        }
        return { open: true };
    }

    randomizeCorridor() {
        this.stopDistance = random(1, 2);
        this.advanceDistance = random(Math.max(2, this.stopDistance + 0.1), 4);
        this.advancing = false;
        this.preferHead = Math.random() < 0.5;
    }

    mineForward() {
        const overlapping = this.overlappingChest();
        if (overlapping) return this.openChest(overlapping);
        if (this.forwardObstacle) {
            const blocker = this.blockingAhead(this.lane, FORWARD_STOP_DISTANCE - Player.getPlayer().getBbWidth() / 2);
            if (blocker && !blocker.unknown && isChest(blockName(blocker)) && !this.openedChests.has(key(blocker))) return this.openChest(blocker);
            if (!this.clearForwardObstacles()) return;
        }
        if (Date.now() >= this.nextTunnelCheck) {
            const scanOrigin = position();
            const other = this.lane.axis === 'x' ? 'z' : 'x';
            scanOrigin[other] = this.laneStart[other];
            const scan = this.scanTunnel(this.tunnelY, this.lane, scanOrigin);
            if (scan.unknown) {
                this.stopControls();
                return this.checkProgress(10000);
            }
            if (scan.open) return this.switchLobby('No five-column enclosed tunnel starts within the next 20 blocks');
            this.nextTunnelCheck = Date.now() + 5000;
        }
        if (Date.now() >= this.forwardUntil) return this.beginBackward(false);
        if (!this.selectSlot(this.miningSlot)) return;
        if (!this.forwardPitch) this.setForwardPitch(this.preferHead);
        this.aimAt({ forward: true });
        if (!this.forwardAligned) {
            Client.stopMovement();
            Client.setKey('leftclick', false);
            if (
                !this.forwardYaw ||
                !this.forwardYaw.complete ||
                !this.forwardPitch.complete ||
                Math.abs(wrapTo180(Player.getYaw() - this.forwardYaw.target)) > 1 ||
                Math.abs(Player.getPitch() - this.forwardPitch.target) > 1
            )
                return;
            this.forwardAligned = true;
            this.progressAt = Date.now();
        }
        const looking = getLookingAt(4.5);
        if (looking && isChest(blockName(looking)) && !this.openedChests.has(key(looking))) return this.openChest(looking);
        const obstacle = this.blockingAhead(this.lane, FORWARD_STOP_DISTANCE - Player.getPlayer().getBbWidth() / 2);
        if (obstacle) {
            if (obstacle.unknown) {
                this.stopControls();
                return this.checkProgress(10000);
            }
            if (isChest(blockName(obstacle)) && !this.openedChests.has(key(obstacle))) return this.openChest(obstacle);
            if (!this.isForwardTunnelBlock(obstacle)) {
                this.forwardBlocked = null;
                Client.setKey('leftclick', false);
                this.correctingLane = true;
                this.moveAlongLane(this.lane);
                return this.checkProgress(15000);
            }
            if (blockName(obstacle) === 'minecraft:bedrock') return this.beginBackward(true);
            Client.stopMovement();
            const now = Date.now();
            const coordinate = position()[this.lane.axis];
            const obstacleKey = key(obstacle);
            const blocked = this.forwardBlocked;
            if (!blocked || blocked.key !== obstacleKey || (coordinate - blocked.coordinate) * this.lane.sign > 0.05) {
                this.forwardBlocked = { key: obstacleKey, coordinate, dueAt: now + this.delay(this.actionDelay) };
            } else if (now >= blocked.dueAt) {
                this.forwardBlocked = null;
                this.forwardObstacle = { target: { ...obstacle, name: blockName(obstacle), aim: null }, candidates: null };
                this.mineTarget = null;
                this.clearForwardObstacles();
                return;
            }
        } else {
            this.forwardBlocked = null;
            this.moveAlongLane(this.lane);
        }
        if (!this.holdMiningAttack(looking)) return;
        this.checkProgress(this.freeMiningTarget ? this.freeMiningTarget.timeoutMs : 15000);
    }

    getMiningAim(point) {
        const player = Player.getPlayer();
        const eye = player.getEyePosition();
        const trace = (aim) => {
            const hit = World.getWorld().clip(new ClipContext(eye, new Vec3d(aim.x, aim.y, aim.z), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
            if (String(hit.getType()) !== 'BLOCK') return null;
            const block = hit.getBlockPos();
            if (block.getX() !== point.x || block.getY() !== point.y || block.getZ() !== point.z) return null;
            const location = hit.getLocation();
            return Math.hypot(location.x() - eye.x(), location.y() - eye.y(), location.z() - eye.z()) <= 4.5 ? aim : null;
        };
        const closest = trace({
            x: Math.max(point.x + 0.1, Math.min(point.x + 0.9, eye.x())),
            y: Math.max(point.y + 0.1, Math.min(point.y + 0.9, eye.y())),
            z: Math.max(point.z + 0.1, Math.min(point.z + 0.9, eye.z())),
        });
        if (closest) return closest;
        const visible = getVisiblePoint(point.x, point.y, point.z);
        return visible ? trace({ x: visible[0], y: visible[1], z: visible[2] }) : null;
    }

    isForwardTunnelBlock(point) {
        const other = this.lane.axis === 'x' ? 'z' : 'x';
        const floorY = Math.floor(this.tunnelY);
        return point[other] === Math.floor(this.laneStart[other]) && (point.y === floorY || point.y === floorY + 1);
    }

    exposedForwardBlocks() {
        const origin = position();
        const eye = Player.getPlayer().getEyePosition();
        const world = World.getWorld();
        const minX = this.lane.axis === 'x' ? Math.floor(eye.x() - 4.5) : Math.floor(this.laneStart.x);
        const maxX = this.lane.axis === 'x' ? Math.floor(eye.x() + 4.5) : minX;
        const minZ = this.lane.axis === 'z' ? Math.floor(eye.z() - 4.5) : Math.floor(this.laneStart.z);
        const maxZ = this.lane.axis === 'z' ? Math.floor(eye.z() + 4.5) : minZ;
        const floorY = Math.floor(this.tunnelY);
        const candidates = [];
        for (let x = minX; x <= maxX; x++) {
            for (let y = floorY; y <= floorY + 1; y++) {
                for (let z = minZ; z <= maxZ; z++) {
                    const point = { x, y, z };
                    if ((point[this.lane.axis] + 0.5 - origin[this.lane.axis]) * this.lane.sign <= 0 || !this.loaded(point)) continue;
                    const distance = Math.hypot(
                        Math.max(x - eye.x(), 0, eye.x() - x - 1),
                        Math.max(y - eye.y(), 0, eye.y() - y - 1),
                        Math.max(z - eye.z(), 0, eye.z() - z - 1)
                    );
                    if (distance > 4.5) continue;
                    const name = blockName(point);
                    if (
                        !name ||
                        AIR.has(name) ||
                        name === HARDSTONE ||
                        name === 'minecraft:bedrock' ||
                        this.passable(point) ||
                        (isChest(name) && this.openedChests.has(key(point)))
                    )
                        continue;
                    const exposed = BLOCK_NEIGHBORS.some(([dx, dy, dz]) => {
                        const neighbor = new BP(x + dx, y + dy, z + dz);
                        return !world.getBlockState(neighbor).isCollisionShapeFullBlock(world, neighbor);
                    });
                    if (exposed) candidates.push({ ...point, name, distance });
                }
            }
        }
        return candidates.sort((a, b) => b.distance - a.distance);
    }

    clearForwardObstacles() {
        const job = this.forwardObstacle;
        Client.stopMovement();
        Client.setKey('shift', false);
        if (job.target && !this.isForwardTunnelBlock(job.target)) {
            job.target = null;
            job.candidates = null;
            this.mineTarget = null;
        }
        if (job.target) {
            const point = job.target;
            if (!this.loaded(point)) {
                this.stopControls();
                this.checkProgress(10000);
                return false;
            }
            const name = blockName(point);
            if (name === 'minecraft:bedrock') {
                this.beginBackward(true);
                return false;
            }
            if (isChest(name) && !this.openedChests.has(key(point))) {
                this.openChest(point);
                return false;
            }
            if (name === point.name && !AIR.has(name) && !this.passable(point) && !(isChest(name) && this.openedChests.has(key(point)))) {
                point.aim ??= this.getMiningAim(point);
                if (point.aim) {
                    this.mineBlock(point, true, point.aim);
                    if (this.state === 'FORWARD') this.checkProgress(this.mineTarget ? this.mineTarget.timeoutMs : 15000);
                    return false;
                }
            }
            job.target = null;
            job.candidates = null;
            this.mineTarget = null;
            this.progressAt = Date.now();
        }
        Client.setKey('leftclick', false);
        job.candidates ??= this.exposedForwardBlocks();
        for (let budget = 0; budget < 2 && job.candidates.length; budget++) {
            const point = job.candidates.pop();
            if (!this.isForwardTunnelBlock(point) || blockName(point) !== point.name) continue;
            if (isChest(point.name) && !this.openedChests.has(key(point))) {
                this.openChest(point);
                return false;
            }
            const aim = this.getMiningAim(point);
            if (!aim) continue;
            job.target = { ...point, aim };
            this.progressAt = Date.now();
            this.mineBlock(point, true, aim);
            return false;
        }
        if (job.candidates.length) return false;
        this.stopControls();
        this.forwardObstacle = null;
        this.forwardPitch = null;
        this.forwardYaw = null;
        this.mineTarget = null;
        this.progressAt = Date.now();
        return true;
    }

    beginBackward(atBoundary) {
        this.forwardObstacle = null;
        this.breakPoint = position();
        this.breakPoint.y = this.tunnelY;
        this.turnPending = atBoundary;
        this.switchLoadout(this.backwardLoadout, 'BACKWARD');
    }

    mineBackward() {
        const coordinate = this.lane.axis === 'x' ? Player.getX() : Player.getZ();
        const remaining = (coordinate - this.forwardStart[this.lane.axis]) * this.lane.sign;
        if (remaining <= 0.45) return this.switchLoadout(this.forwardLoadout, 'RETURN');
        if (!this.selectSlot(this.miningSlot)) return;
        this.aimAt({ yaw: this.backwardYaw, pitch: this.backwardPitch });
        if (Math.abs(wrapTo180(Player.getYaw() - this.backwardYaw)) > 3 || Math.abs(Player.getPitch() - this.backwardPitch) > 2) {
            Client.stopMovement();
            Client.setKey('leftclick', false);
            this.checkProgress(15000);
            return;
        }
        this.moveAlongLane({ ...this.lane, sign: -this.lane.sign });
        if (!this.holdMiningAttack(getLookingAt(4.5))) return;
        this.checkProgress(this.freeMiningTarget ? this.freeMiningTarget.timeoutMs : 15000);
    }

    returnToFace() {
        setKeysForStraightLineCoords(this.breakPoint.x, this.breakPoint.y, this.breakPoint.z, false);
        if (this.tryReturnTeleport()) return;
        if (!this.walkTo(this.breakPoint)) return;
        if (this.turnPending) {
            this.turnGoal = null;
            return this.setState('TURN');
        }
        this.setState('FORWARD');
    }

    tryReturnTeleport() {
        const now = Date.now();
        if (this.returnTeleport) {
            // Walking also changes position, so space out teleports without treating walking as a teleport response.
            if (now - this.returnTeleport.sentAt < 1000 && flatDistance(this.breakPoint) > 0.3) return true;
            this.returnTeleport = null;
        }
        if (this.returnTeleportBlocked && flatDistance(this.returnTeleportBlocked) < 0.5) return false;
        this.returnTeleportBlocked = null;
        const distance = Aote.FINAL_POINT_NO_AOTE_RADIUS;
        const player = Player.getPlayer();
        if (flatDistance(this.breakPoint) <= distance || !player.onGround() || !Aote.hasEnoughMana()) return false;
        const slot = Aote.findAoteSlot();
        if (slot === null) return false;
        const target = calculateAbsoluteAngles({ ...this.breakPoint, y: player.getEyePosition().y() });
        this.aimAt({ yaw: target.yaw, pitch: 0 }, 'return:aote');
        Client.setKey('leftclick', false);
        Client.setKey('shift', false);
        Client.setKey('sprint', false);
        this.checkProgress(15000);
        if (this.state !== 'RETURN') return true;
        if (this.rotation.motion?.targetId !== 'return:aote' || Math.abs(wrapTo180(Player.getYaw() - target.yaw)) > 0.5 || Math.abs(Player.getPitch()) > 0.5)
            return true;
        const direction = Aote.getLookDirection(player);
        const bounds = player.getBoundingBox();
        const world = World.getWorld();
        this.returnTeleportBlocked = position();
        for (let step = 0; step <= distance; step++) {
            const point = { x: Player.getX() + direction.x * step, y: this.tunnelY, z: Player.getZ() + direction.z * step };
            const floor = new BP(Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z));
            if (!this.loaded(point) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP)) return false;
        }
        if (
            world
                .getBlockCollisions(player, bounds.expandTowards(direction.x * distance, 0, direction.z * distance))
                .iterator()
                .hasNext()
        )
            return false;
        this.returnTeleportBlocked = null;
        if (this.returnOriginalSlot === null) this.returnOriginalSlot = Player.getHeldItemIndex();
        if (!this.selectSlot(slot + 1)) return true;
        Client.rightClick();
        this.returnTeleport = { sentAt: now };
        return true;
    }

    turnLane() {
        if (flatDistance(this.turnGoal) <= 0.35) {
            this.lane.sign *= -1;
            this.setLaneStart(position());
            this.turnGoal = null;
            this.turnPending = false;
            return this.setState('FORWARD');
        }
        const result = this.mineCorridor(this.turnDirection(), this.tunnelY, this.turnOrigin, this.turnGoal);
        if (result === 'BEDROCK') this.switchLobby('Bedrock also blocks the lane change');
    }

    mineCorridor(direction, y, origin, limit = null) {
        const other = direction.axis === 'x' ? 'z' : 'x';
        const base = { x: Math.floor(Player.getX()), y: Math.floor(y), z: Math.floor(Player.getZ()) };
        base[other] = Math.floor(origin[other]);
        const current = position();
        const aligned = { x: current.x, y: current.y, z: current.z };
        aligned[other] = origin[other];
        let target = null;
        let boundary = false;
        for (let step = 0; step <= 20 && !target; step++) {
            const point = this.offset(base, direction, step);
            if (limit && (point[direction.axis] - Math.floor(limit[direction.axis])) * direction.sign > 0) break;
            if (!this.loaded(point)) {
                this.stopControls();
                this.checkProgress(10000);
                return;
            }
            const pair = [point, { ...point, y: point.y + 1 }];
            boundary = pair.some((block) => blockName(block) === 'minecraft:bedrock');
            if (boundary) {
                target = point;
                break;
            }
            if (this.preferHead) pair.reverse();
            target = pair.find((block) => !AIR.has(blockName(block)));
        }
        if (!target) {
            this.mineTarget = null;
            Client.setKey('leftclick', false);
            this.walkTo(limit || this.offset(aligned, direction, 3));
            return;
        }
        const distance = (target[direction.axis] + 0.5 - current[direction.axis]) * direction.sign - 0.5;
        if (boundary && distance <= this.advanceDistance) return 'BEDROCK';
        if (distance > this.advanceDistance) this.advancing = true;
        if (distance <= this.stopDistance) this.advancing = false;
        if (this.advancing) {
            const goal = this.offset(aligned, direction, 3);
            setKeysForStraightLineCoords(goal.x, y, goal.z, false);
        } else Client.stopMovement();
        if (!boundary) this.mineBlock(target);
        else Client.setKey('leftclick', false);
        this.checkProgress(this.mineTarget ? this.mineTarget.timeoutMs : 15000);
    }

    setForwardPitch(head) {
        this.preferHead = head;
        this.forwardPitch = {
            from: this.rotation?.pitch ?? Player.getPitch(),
            target: head ? random(5, 10) : random(15, 30),
            startedAt: Date.now(),
            duration: this.delay(this.rotationTime),
            curveSeed: random(0, Math.PI * 2),
            complete: false,
        };
    }

    createMineTarget(point, name) {
        const speed = Math.max(1, this.miningSpeed || 1500);
        const ticks = MiningUtils.getBlockInfo(name)
            ? MiningUtils.getMineTimeForBlock(name, MiningUtils.getEffectiveMiningSpeed(speed, false))
            : Math.max(4, Math.round(1500 / speed));
        const now = Date.now();
        const expectedMs = ticks * 50;
        const retryAfterMs = Math.max(1000, expectedMs * 2 + 500);
        return {
            point,
            key: key(point),
            name,
            expectedMs,
            retryAfterMs,
            timeoutMs: Math.max(15000, retryAfterMs * 3),
            attackedMs: 0,
            attemptMs: 0,
            retryPending: false,
            lastTick: now,
            changedAt: now + Math.min(expectedMs, 150),
        };
    }

    holdMiningAttack(point, mining = null) {
        const now = Date.now();
        if (!mining) {
            const name = point && blockName(point);
            if (name && !AIR.has(name) && name !== HARDSTONE && name !== 'minecraft:bedrock' && !isChest(name)) {
                if (!this.freeMiningTarget || this.freeMiningTarget.key !== key(point) || this.freeMiningTarget.name !== name) {
                    this.freeMiningTarget = this.createMineTarget(point, name);
                }
            } else this.freeMiningTarget = null;
            mining = this.freeMiningTarget;
        }
        const wasAttacking = Client.isKeyDown('leftclick');
        if (mining) {
            if (wasAttacking) {
                const elapsed = Math.max(0, Math.min(100, now - mining.lastTick));
                mining.attackedMs += elapsed;
                mining.attemptMs += elapsed;
            } else mining.attemptMs = 0;
            mining.lastTick = now;
            if (mining.attackedMs > mining.timeoutMs) {
                this.switchLobby('A tunnel block did not break within its mining timeout');
                return false;
            }
            if (mining.name !== HARDSTONE && mining.attemptMs >= mining.retryAfterMs) {
                Client.setKey('leftclick', false);
                mining.attemptMs = 0;
                mining.retryPending = true;
                return true;
            }
        }
        if (Client.setKey('leftclick', true) && !wasAttacking) {
            Client.resumeHeldKeys();
            if (mining && mining.retryPending) {
                Client.leftClick();
                mining.retryPending = false;
            }
        }
        return true;
    }

    useMiningAbility() {
        if (!this.useTunnelVision || !ABILITY_STATES.has(this.state)) {
            this.abilityUseAt = 0;
            this.abilityClickPending = false;
            return false;
        }
        const now = Date.now();
        if (!this.abilityUseAt) {
            if (now - this.lastAbilityUseAt < ABILITY_RETRY_DELAY_MS) return false;
            const available = /\bavailable\b/i.test(getPickaxeAbilityStatus());
            if (!available && !this.abilityFromChat && this.lastAbilityUseAt && now - this.lastAbilityUseAt < ABILITY_FALLBACK_COOLDOWN_MS) return false;
            this.abilityUseAt = now + this.delay(this.actionDelay);
        }
        if (now < this.abilityUseAt) return false;
        const looking = getLookingAt(4.5);
        if (looking && isChest(blockName(looking))) return false;
        this.stopControls();
        if (!this.abilityClickPending) {
            this.abilityClickPending = true;
            return true;
        }
        if (Client.getMinecraft().gameMode.isDestroying() || !this.selectSlot(this.miningSlot)) return true;
        Client.rightClick();
        this.lastAbilityUseAt = now;
        this.abilityFromChat = false;
        this.abilityUseAt = 0;
        this.abilityClickPending = false;
        return true;
    }

    mineBlock(point, vertical = false, aimPoint = null) {
        const name = blockName(point);
        if (!name || AIR.has(name)) {
            Client.setKey('leftclick', false);
            this.mineTarget = null;
            return;
        }
        if (name === 'minecraft:bedrock') return;
        if (isChest(name) && !this.openedChests.has(key(point))) return this.openChest(point);
        if (!this.selectSlot(this.miningSlot)) return;
        const now = Date.now();
        const target = this.mineTarget;
        if (target && (target.key !== key(point) || target.name !== name)) {
            Client.setKey('leftclick', false);
            if (now < target.changedAt) return;
            this.preferHead = !this.preferHead;
            this.mineTarget = null;
            this.progressAt = now;
            return;
        }
        if (!this.mineTarget) {
            this.mineTarget = this.createMineTarget(point, name);
        }
        const mining = this.mineTarget;
        // Stay inside the selected face until the server changes it; a timer alone can abandon slow gemstones.
        const wobble = vertical ? 0 : 0.12 * Math.sin(now / 300);
        const aim = aimPoint || { x: point.x + 0.5, y: point.y + 0.5 + wobble, z: point.z + 0.5 };
        this.aimAt(aim, `mine:${mining.key}`);
        const looking = getLookingAt(4.5);
        const onTarget = looking && looking.x === point.x && looking.y === point.y && looking.z === point.z;
        if (!onTarget) {
            Client.setKey('leftclick', false);
            mining.attemptMs = 0;
            mining.lastTick = now;
            return;
        }
        this.holdMiningAttack(point, mining);
    }

    walkTo(point) {
        if (flatDistance(point) <= 0.3) {
            this.stopControls();
            return true;
        }
        this.aimAt({ ...point, y: Player.getY() + 1.4 });
        setKeysForStraightLineCoords(point.x, point.y, point.z, false);
        this.checkProgress(15000);
        return false;
    }

    checkProgress(timeout) {
        if (!this.progressPoint || flatDistance(this.progressPoint) > 0.2) {
            this.progressPoint = position();
            this.progressAt = Date.now();
        } else if (Date.now() - this.progressAt > timeout) this.switchLobby('Movement or mining stopped making progress');
    }

    snapshot() {
        const forward = this.state === 'FORWARD';
        const resumingForward = this.state === 'LOADOUT' && this.loadoutRequest?.nextState === 'FORWARD';
        return {
            state: this.state,
            point: position(),
            loadout: this.loadoutRequest ? { ...this.loadoutRequest } : null,
            currentLoadout: this.currentLoadout,
            forwardStart: this.forwardStart,
            forwardRemaining:
                forward && this.initialized ? Math.max(0, this.forwardUntil - Date.now()) : forward || resumingForward ? this.forwardRemaining : null,
            cooldownRemaining: this.state === 'COOLDOWN' ? (this.initialized ? Math.max(0, this.cooldownUntil - Date.now()) : this.cooldownDuration) : null,
            recoveryElapsed: this.recovery ? Date.now() - this.recovery.startedAt : null,
            recoveryContext: this.recovery,
            chestContext: this.chest,
        };
    }

    restore(snapshot, transitionDelay = this.actionDelay) {
        this.forwardStart = snapshot.forwardStart;
        this.forwardRemaining = snapshot.forwardRemaining;
        this.recovery = snapshot.recoveryContext;
        this.chest = snapshot.chestContext;
        if (this.chest) {
            this.chest.approach = null;
            this.chest.progressAt = Date.now();
        }
        if (this.recovery && snapshot.recoveryElapsed !== null) {
            this.recovery.startedAt = Date.now() - snapshot.recoveryElapsed;
            this.recovery.pillar = null;
        }
        if (snapshot.cooldownRemaining !== null) this.cooldownDuration = snapshot.cooldownRemaining;
        if (snapshot.state === 'LOADOUT') return this.switchLoadout(snapshot.loadout.number, snapshot.loadout.nextState, transitionDelay);
        const loadout = snapshot.state === 'BACKWARD' ? this.backwardLoadout : snapshot.currentLoadout || this.forwardLoadout;
        this.switchLoadout(loadout, snapshot.state, transitionDelay);
    }

    openChest(point) {
        this.chest = { point: { ...point }, resume: this.snapshot(), clickedAt: 0, particleAt: 0, opened: false, dueAt: 0, progressAt: Date.now() };
        this.setState('CHEST', 0);
    }

    tickChest() {
        const chest = this.chest;
        const now = Date.now();
        if (!chest) return this.stop('Missing treasure chest position.');
        if (!isChest(blockName(chest.point))) return this.finishChest();
        if (chest.opened) return this.finishChest();
        if (Client.isInGui()) return;
        if (now - this.startedAt > 120000) return this.switchLobby('Treasure chest did not open');
        if (chest.approach) return this.tickChestApproach();
        const overlapping = this.overlappingChest();
        if (overlapping && key(overlapping) === key(chest.point)) return this.approachChest(chest.point);
        if (now - chest.progressAt > Math.max(25000, this.mineTarget ? this.mineTarget.timeoutMs : 0))
            return this.switchLobby('Treasure chest stopped making progress');
        const player = Player.getPlayer();
        const eye = player.getEyePosition();
        const particle = chest.particle && now - chest.particleAt < 2000;
        let aim = particle ? chest.particle : { x: chest.point.x + 0.5, y: chest.point.y + 0.5, z: chest.point.z + 0.5 };
        const trace = (point) =>
            World.getWorld().clip(new ClipContext(eye, new Vec3d(point.x, point.y, point.z), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        let hit = trace(aim);
        const hitPoint = (result) => {
            if (String(result?.getType?.()) !== 'BLOCK') return null;
            const pos = result.getBlockPos();
            return { x: pos.getX(), y: pos.getY(), z: pos.getZ() };
        };
        let obstacle = hitPoint(hit);
        if (!particle && (!obstacle || key(obstacle) !== key(chest.point))) {
            if (now >= (chest.nextVisibleCheck || 0)) {
                chest.visiblePoint = getVisiblePoint(chest.point.x, chest.point.y, chest.point.z);
                chest.nextVisibleCheck = now + 250;
            }
            if (chest.visiblePoint) {
                const [x, y, z] = chest.visiblePoint;
                aim = { x, y, z };
                hit = trace(aim);
                obstacle = hitPoint(hit);
            }
        }
        const obstacleKey = obstacle && key(obstacle);
        if (chest.obstacleKey !== obstacleKey) {
            chest.obstacleKey = obstacleKey;
            chest.progressAt = now;
            this.mineTarget = null;
        }
        const hitLocation = hit.getLocation();
        const distance = Math.hypot(hitLocation.x() - eye.x(), hitLocation.y() - eye.y(), hitLocation.z() - eye.z());
        if (obstacle && obstacleKey !== key(chest.point)) {
            chest.dueAt = 0;
            const foot = { x: Math.floor(Player.getX()), y: Math.floor(Player.getY() - 0.01), z: Math.floor(Player.getZ()) };
            const descending = chest.resume.state === 'DESCEND' || (chest.resume.state === 'RECOVERY_HEIGHT' && Player.getY() > this.recovery.goalY + 0.12);
            const name = blockName(obstacle);
            if (name === 'minecraft:bedrock' || (isChest(name) && this.openedChests.has(obstacleKey)) || (!descending && obstacleKey === key(foot)))
                return this.approachChest(chest.point);
            if (distance > 4.5) return this.approachChest(obstacle);
            Client.stopMovement();
            return this.mineBlock(obstacle, true);
        }
        Client.setKey('leftclick', false);
        this.mineTarget = null;
        if (distance > 4.5) return this.approachChest(chest.point);
        Client.stopMovement();
        this.aimAt(aim, `${particle ? 'particle' : 'chest'}:${key(chest.point)}`);
        if (particle) return;
        const looking = getLookingAt(4.5);
        if (!looking || looking.x !== chest.point.x || looking.y !== chest.point.y || looking.z !== chest.point.z) return;
        if (!chest.dueAt) chest.dueAt = now + this.delay(this.clickDelay);
        if (now < chest.dueAt) return;
        Client.rightClick();
        chest.clickedAt = now;
        chest.dueAt = now + Math.max(1000, this.delay(this.clickDelay));
    }

    approachChest(point) {
        this.stopControls();
        this.mineTarget = null;
        const origin = { x: Math.floor(Player.getX()), y: Math.floor(Player.getY()), z: Math.floor(Player.getZ()) };
        this.chest.approach = {
            target: point,
            origin,
            queue: [{ point: origin, parent: null }],
            visited: new Set([key(origin)]),
            index: 0,
            startedAt: Date.now(),
        };
    }

    tickChestApproach() {
        const chest = this.chest;
        const job = chest.approach;
        const world = World.getWorld();
        const now = Date.now();
        Client.stopMovement();
        Client.setKey('leftclick', false);
        Client.setKey('shift', false);
        if (now - job.startedAt > 30000) return this.switchLobby('Could not reach the treasure chest');
        const eyeHeight = Player.getPlayer().getEyePosition().y() - Player.getY();
        const overlapping = this.overlappingChest();
        const escapingChest = overlapping && key(overlapping) === key(chest.point);
        if (!job.points) {
            const target = job.target;
            for (let budget = 0; budget < 64 && job.index < job.queue.length && job.index < 1024; budget++) {
                const node = job.queue[job.index++];
                const point = node.point;
                const eye = { x: point.x + 0.5, y: point.y + eyeHeight, z: point.z + 0.5 };
                if (
                    (!escapingChest || node.parent) &&
                    (node.parent || flatDistance(center(point)) > 0.15) &&
                    this.passable(point) &&
                    this.passable({ ...point, y: point.y + 1 }) &&
                    Math.hypot(target.x + 0.5 - eye.x, target.y + 0.5 - eye.y, target.z + 0.5 - eye.z) <= 3.5 &&
                    testPointNative(target.x, target.y, target.z, [target.x + 0.5, target.y + 0.5, target.z + 0.5], eye)
                ) {
                    job.points = [];
                    for (let cursor = node; cursor; cursor = cursor.parent) job.points.push(center(cursor.point));
                    job.points.reverse();
                    if (escapingChest) job.points.shift();
                    else {
                        const first = job.points[0];
                        job.points.unshift({ x: first.x, y: first.y, z: Player.getZ() });
                    }
                    break;
                }
                for (const [dx, dz] of [
                    [1, 0],
                    [-1, 0],
                    [0, 1],
                    [0, -1],
                ]) {
                    const next = { x: point.x + dx, y: point.y, z: point.z + dz };
                    if (job.visited.has(key(next)) || Math.abs(next.x - job.origin.x) + Math.abs(next.z - job.origin.z) > 24) continue;
                    job.visited.add(key(next));
                    const floor = new BP(next.x, next.y - 1, next.z);
                    if (!this.loaded(next) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP)) continue;
                    if (!this.passable(next) || !this.passable({ ...next, y: next.y + 1 })) continue;
                    job.queue.push({ point: next, parent: node });
                }
            }
            if (!job.points && (job.index >= job.queue.length || job.index >= 1024))
                return this.switchLobby('No clear walking route to the obstructed treasure chest');
            return;
        }
        const goal = job.points[0];
        if (!goal) {
            chest.approach = null;
            chest.progressAt = now;
            return;
        }
        if (flatDistance(goal) <= 0.15) {
            job.points.shift();
            chest.progressAt = now;
            return;
        }
        const axis = Math.abs(goal.x - Player.getX()) > Math.abs(goal.z - Player.getZ()) ? 'x' : 'z';
        const direction = { axis, sign: Math.sign(goal[axis] - position()[axis]) };
        const floor = new BP(Math.floor(goal.x), Math.floor(goal.y) - 1, Math.floor(goal.z));
        if (
            !this.loaded(goal) ||
            !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP) ||
            this.blockingAhead(direction, 0.25, escapingChest ? chest.point : null)
        ) {
            chest.approach = null;
            return;
        }
        const target = calculateAbsoluteAngles({ ...goal, y: Player.getY() + eyeHeight });
        this.aimAt({ yaw: target.yaw, pitch: 10 }, `walk:${key(goal)}`);
        if (Math.abs(wrapTo180(Player.getYaw() - target.yaw)) > 2 || Math.abs(Player.getPitch() - 10) > 2) return;
        Client.setKey('shift', true);
        Client.setKey('w', true);
    }

    finishChest() {
        const chest = this.chest;
        if (chest.opened) this.openedChests.add(key(chest.point));
        this.chest = null;
        this.restore(chest.resume, 0);
    }

    interruptForWorm() {
        if (!this.enabled) return;
        const state = this.state === 'LOADOUT' ? this.loadoutRequest?.nextState : this.state;
        if (state === 'WAIT_WORM' || state === 'WORM') return;
        if (!MINING_STATES.has(state) && state !== 'COOLDOWN' && state !== 'RESUME_PATH') return;
        const interruptedState = state === 'CHEST' ? this.chest?.resume.state : state;
        const recovery = this.recovery;
        const resumingCombat =
            this.combatResume &&
            (state === 'COOLDOWN' ||
                state === 'RESUME_PATH' ||
                (interruptedState === 'RECOVERY_HEIGHT' &&
                    recovery &&
                    (['COOLDOWN', 'COMBAT_RESUME'].includes(recovery.after) || (recovery.snapshot && recovery.snapshot.state === 'COOLDOWN'))));
        if (!resumingCombat) {
            this.combatResume = state === 'RESUME_PATH' ? this.returnJob?.snapshot : this.snapshot();
            if (!this.combatResume) return;
            const pillar = recovery && recovery.pillar;
            if (pillar) this.combatResume.point.y = pillar.y;
        }
        this.wormOrigin = position();
        // The 1x2 mining corridor, expanded one block in both cross-section axes.
        // The search remains anchored to the location of this worm warning.
        const direction = interruptedState === 'TURN' && this.lane ? this.turnDirection() : this.lane;
        const axis = direction?.axis || 'z';
        const crossAxis = axis === 'x' ? 'z' : 'x';
        const crossOrigin = interruptedState === 'TURN' ? this.turnOrigin : this.laneStart;
        this.wormSearch = {
            axis,
            crossAxis,
            along: this.wormOrigin[axis],
            cross: crossOrigin?.[crossAxis] ?? Math.floor(this.wormOrigin[crossAxis]) + 0.5,
            minY: this.tunnelY - 1,
            maxY: this.tunnelY + 3,
        };
        this.wormWarningAt = Date.now();
        this.wormLastSeenAt = 0;
        this.wormLastStandPosition = null;
        this.wormCandidates.clear();
        this.wormNametags.clear();
        if (this.state === 'LOADOUT') {
            this.currentLoadout = null;
            closeInventory();
        }
        this.switchLoadout(this.combatLoadout, 'WAIT_WORM', 0);
        this.message('&eWorm warning received. Mining paused; preparing combat and waiting for the spawn.');
    }

    inWormSearchBounds(point) {
        const search = this.wormSearch;
        return (
            !!search &&
            Math.abs(point[search.axis] - search.along) <= WORM_TUNNEL_HALF_LENGTH &&
            Math.abs(point[search.crossAxis] - search.cross) <= WORM_TUNNEL_HALF_WIDTH &&
            point.y >= search.minY &&
            point.y <= search.maxY
        );
    }

    isWormSegment(entity) {
        try {
            return (
                this.inWormSearchBounds({ x: entity.getX(), y: entity.getY(), z: entity.getZ() }) &&
                CombatBot.isCombatTargetCandidate(entity, true, true, true) &&
                entity.getStackInSlot(5)?.type?.getRegistryName() === 'minecraft:player_head'
            );
        } catch (error) {
            return false;
        }
    }

    findWormTargets() {
        if (!this.wormSearch) return [];

        const now = Date.now();
        const available = new Map();
        const updatedCandidates = new Map();
        let nearestApproachPoint = null;
        let nearestApproachDistance = Infinity;
        let nearestStandPoint = null;
        let nearestStandDistance = Infinity;
        for (const stand of World.getAllEntitiesOfType(ArmorStandEntity)) {
            if (!this.inWormSearchBounds({ x: stand.getX(), y: stand.getY(), z: stand.getZ() })) continue;
            const uuid = CombatBot.getTargetUuid(stand);
            if (!uuid) continue;

            // Only the Scatha/Stoneworm nametag identifies the worm. No health
            // symbol or other worm name is required.
            if (/(?:^|[^a-z])(?:Scatha|Stoneworm)(?![a-z])/i.test(cleanChat(stand.getName()))) {
                // A visible worm nametag means combat is still in progress even
                // if its player-head stand is temporarily missing.
                this.wormLastSeenAt = now;
                this.wormNametags.set(uuid, {
                    point: { x: stand.getX(), y: stand.getY(), z: stand.getZ() },
                    seenAt: now,
                });
            }

            if (!this.isWormSegment(stand)) continue;
            available.set(uuid, stand);
            updatedCandidates.set(uuid, { target: stand, seenAt: now });

            // Remember actual coordinates separately from entity wrappers:
            // unloaded stands must not erase the last place we saw one.
            const point = { x: stand.getX(), y: stand.getY(), z: stand.getZ() };
            const distance = Math.abs(point[this.wormSearch.axis] - position()[this.wormSearch.axis]);
            if (distance < nearestStandDistance) {
                nearestStandPoint = point;
                nearestStandDistance = distance;
            }
            if (distance > WORM_APPROACH_STOP_DISTANCE && distance < nearestApproachDistance) {
                nearestApproachPoint = point;
                nearestApproachDistance = distance;
            }
        }

        // The label and attackable head can appear on different client ticks.
        // Keep recent positions during the combat loadout transition.
        for (const [uuid, marker] of this.wormNametags) {
            if (now - marker.seenAt > WORM_NAMETAG_GRACE_MS) this.wormNametags.delete(uuid);
        }
        for (const [uuid, candidate] of this.wormCandidates) {
            if (available.has(uuid) || now - candidate.seenAt > WORM_SEGMENT_GRACE_MS || !this.isWormSegment(candidate.target)) continue;
            available.set(uuid, candidate.target);
            updatedCandidates.set(uuid, candidate);
        }
        this.wormCandidates = updatedCandidates;
        if (nearestApproachPoint || nearestStandPoint) this.wormLastStandPosition = nearestApproachPoint || nearestStandPoint;

        // Only select the player-head stand nearest a Scatha/Stoneworm
        // nametag within two blocks; no isPickable check is required.
        let nearest = null;
        let nearestDistanceSq = Infinity;
        const maxDistanceSq = WORM_NAMETAG_HEAD_MAX_DISTANCE ** 2;
        for (const marker of this.wormNametags.values()) {
            const point = new Vec3d(marker.point.x, marker.point.y, marker.point.z);
            for (const segment of available.values()) {
                try {
                    const distanceSq = segment.toMC().getBoundingBox().distanceToSqr(point);
                    if (distanceSq > maxDistanceSq || distanceSq >= nearestDistanceSq) continue;
                    nearestDistanceSq = distanceSq;
                    nearest = segment;
                } catch (error) {
                    // The stand may unload while matching entities.
                }
            }
        }
        if (nearest) this.wormLastSeenAt = now;
        return nearest ? [nearest] : [];
    }

    approachLastWormPosition() {
        const search = this.wormSearch;
        const goal = this.wormLastStandPosition;
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        if (!search || !goal || !this.inWormSearchBounds(goal) || !this.lane || !this.selectSlot(this.attackSlot)) return Client.stopMovement();

        const here = position();
        const coordinate = goal[search.axis];
        const distance = Math.abs(coordinate - here[search.axis]);
        if (distance <= WORM_APPROACH_STOP_DISTANCE) return Client.stopMovement();

        const direction = { axis: search.axis, sign: Math.sign(coordinate - here[search.axis]) };
        const yaw = this.yaw(direction);
        const targetId = `wait:worm:${direction.axis}:${direction.sign}`;
        this.aimAt({ yaw, pitch: 0 }, targetId);
        if (
            this.rotation.motion?.targetId !== targetId ||
            !this.rotation.motion.complete ||
            Math.abs(wrapTo180(Player.getYaw() - yaw)) > 2 ||
            Math.abs(Player.getPitch()) > 2 ||
            Math.abs(Player.getY() - this.tunnelY) > 0.25 ||
            !Player.getPlayer().onGround() ||
            this.blockingAhead(direction, 0.8)
        )
            return Client.stopMovement();

        const next = this.offset(here, direction, 0.8);
        const world = World.getWorld();
        const floor = new BP(Math.floor(next.x), Math.floor(this.tunnelY) - 1, Math.floor(next.z));
        if (!this.loaded(next) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP)) return Client.stopMovement();
        const origin = { ...here };
        origin[search.crossAxis] = search.cross;
        this.moveAlongLane(direction, origin, direction);
    }

    waitForWorm() {
        if (!this.combatResume) return this.stop('Missing combat return position.');
        const targets = this.findWormTargets();
        if (targets.length) {
            this.wormTargets = targets;
            this.setState('WORM', 0);
            this.message('&aWorm spawned. Starting combat.');
            return this.fightWorm();
        }
        if (Date.now() - this.wormWarningAt >= WORM_SPAWN_TIMEOUT_MS) return this.switchLobby('No Stoneworm or Scatha appeared within 60 seconds');
        return this.approachLastWormPosition();
    }

    fightWorm() {
        const now = Date.now();
        if (!this.combatResume) return this.stop('Missing combat return position.');
        if (now - this.startedAt > 120000) return this.switchLobby('Worm combat timed out');
        if (!Pathfinder.isPathing() && !this.selectSlot(this.attackSlot)) return;
        const targets = this.findWormTargets();
        if (targets.length) {
            this.wormTargets = targets;
            this.wormMissingAt = 0;
            CombatBot.setExternalTargets(targets, WORM_COMBAT_OPTIONS);
            if (!this.ownsCombat) {
                this.ownsCombat = true;
                CombatBot.toggle(true, true);
            }
            return;
        }
        // When the head or nametag unloads, approach the last observed position
        // during the existing five-second grace period. Do not fight stale entities.
        if (this.ownsCombat) this.stopActivities();
        if (!this.wormMissingAt) this.wormMissingAt = now;
        if (now - Math.max(this.wormMissingAt, this.wormLastSeenAt) < WORM_DISAPPEAR_GRACE_MS) {
            return this.approachLastWormPosition();
        }
        this.cooldownDuration = randomInt(25000, 35000);
        this.waitBeforeReturn = Math.random() < 0.5;
        if (this.waitBeforeReturn) this.setState('COOLDOWN');
        else this.returnToSnapshot(this.combatResume, 'COOLDOWN');
    }

    tickCooldown() {
        if (Date.now() < this.cooldownUntil) return;
        if (this.waitBeforeReturn) this.returnToSnapshot(this.combatResume, 'COMBAT_RESUME');
        else this.finishCombat();
    }

    finishCombat() {
        const snapshot = this.combatResume;
        this.combatResume = null;
        this.wormSearch = null;
        this.wormLastStandPosition = null;
        this.wormCandidates.clear();
        this.wormNametags.clear();
        this.restore(snapshot);
    }

    returnToSnapshot(snapshot, after) {
        this.returnJob = { snapshot, after, result: null };
        this.setState('RESUME_PATH');
    }

    startReturnPath() {
        const job = this.returnJob;
        if (!job) return this.stop('Missing return path.');
        const point = job.snapshot.point;
        if (flatDistance(point) < 0.6 && Math.abs(Player.getY() - point.y) < 0.25) {
            job.result = true;
            return;
        }
        this.startPath([[Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z)]], job);
    }

    tickReturnPath() {
        const job = this.returnJob;
        if (job.result === false || Date.now() - this.startedAt > 60000) return this.switchLobby('Could not return to the mining position');
        if (job.result !== true) {
            if (!Pathfinder.isPathing()) this.startReturnPath();
            return;
        }
        if (Math.abs(Player.getY() - job.snapshot.point.y) > 0.25) {
            if (!this.confirmHeightChange()) return;
            if (!this.lane || this.nearbyPlayer()) return this.switchLobby('Return path ended at the wrong height near a player or outside the tunnel');
            this.recovery = { snapshot: job.snapshot, after: job.after, goalY: job.snapshot.point.y, startedAt: Date.now(), pillar: null };
            this.returnJob = null;
            return this.switchLoadout(this.forwardLoadout, 'RECOVERY_HEIGHT');
        }
        this.heightCheckAt = 0;
        if (this.ownsPath) {
            Pathfinder.resetPath();
            this.ownsPath = false;
        }
        if (!this.walkTo(job.snapshot.point)) return;
        this.returnJob = null;
        if (job.after === 'COOLDOWN') this.setState('COOLDOWN');
        else if (job.after === 'COMBAT_RESUME') this.finishCombat();
        else this.restore(job.snapshot);
    }

    checkHeight() {
        let state = this.state;
        if (state === 'LOADOUT') state = this.loadoutRequest?.nextState;
        if (state === 'CHEST') state = this.chest?.resume.state;
        if (!HORIZONTAL_STATES.has(state) && state !== 'COOLDOWN') return false;
        if (this.state === 'COOLDOWN' && !this.initialized) return false;
        const expectedY = state === 'COOLDOWN' ? this.cooldownY : this.tunnelY;
        if (!Number.isFinite(expectedY)) return false;
        if (Math.abs(Player.getY() - expectedY) <= 0.25) {
            this.heightCheckAt = 0;
            this.safePoint = position();
            return false;
        }
        if (!this.confirmHeightChange()) return true;
        if (this.nearbyPlayer()) {
            this.switchLobby('Height changed with another player within 10 blocks');
            return true;
        }
        if (!this.lane) {
            this.switchLobby('Height changed before the tunnel was established');
            return true;
        }
        const snapshot = this.snapshot();
        const goalY = Math.floor(expectedY);
        snapshot.point = this.safePoint ? { ...this.safePoint, y: goalY } : { ...position(), y: goalY };
        this.recovery = { snapshot, goalY, startedAt: Date.now(), pillar: null };
        if (this.state === 'LOADOUT') closeInventory();
        this.switchLoadout(this.forwardLoadout, 'RECOVERY_HEIGHT');
        return true;
    }

    confirmHeightChange() {
        if (!this.heightCheckAt) {
            this.stopActivities();
            this.heightCheckAt = Date.now() + this.delay(this.actionDelay);
            return false;
        }
        return Date.now() >= this.heightCheckAt;
    }

    nearbyPlayer() {
        return World.getAllPlayers().some((player) => {
            if (player.getName() === Player.getName() || player.getUUID()?.version() === 2) return false;
            return Math.hypot(player.getX() - Player.getX(), player.getY() - Player.getY(), player.getZ() - Player.getZ()) <= 10;
        });
    }

    recoverHeight() {
        const recovery = this.recovery;
        const now = Date.now();
        if (now - recovery.startedAt > 90000) return this.switchLobby('Height recovery timed out');
        const player = Player.getPlayer();
        const y = Player.getY();
        const foot = { x: Math.floor(Player.getX()), y: Math.floor(y - 0.01), z: Math.floor(Player.getZ()) };
        if (recovery.pillar) {
            const pillar = recovery.pillar;
            if (player.onGround() && y >= pillar.y + 0.9) {
                recovery.pillar = null;
                this.stopControls();
                return;
            }
            if (now - pillar.startedAt > 4000) return this.switchLobby('Could not place a recovery block');
            if (!this.selectSlot(this.blockSlot)) return;
            this.aimAt({ yaw: Player.getYaw(), pitch: 90 });
            const placed = { x: foot.x, y: Math.floor(pillar.y), z: foot.z };
            if (!AIR.has(blockName(placed))) {
                Client.setKey('space', false);
                return;
            }
            Client.setKey('space', true);
            if (y >= pillar.y + 1.01 && Player.getPitch() >= 87 && now >= pillar.clickAt) {
                Client.rightClick();
                pillar.clickAt = now + this.delay(this.clickDelay);
            }
            return;
        }
        if (player.onGround() && Math.abs(y - recovery.goalY) <= 0.12) {
            const snapshot = recovery.snapshot;
            const after = recovery.after || 'RESTORE';
            this.recovery = null;
            return this.returnToSnapshot(snapshot, after);
        }
        const supportName = blockName(foot);
        if (supportName?.endsWith('_slab')) {
            this.mineBlock(foot, true);
            return;
        }
        if (y > recovery.goalY + 0.12) {
            if (foot.y < recovery.goalY) return;
            if (supportName === 'minecraft:bedrock') return this.switchLobby('Bedrock prevents downward recovery');
            this.mineBlock(foot, true);
            return;
        }
        if (!player.onGround()) {
            Client.setKey('leftclick', false);
            return;
        }
        const head = { ...foot, y: Math.floor(y) + 2 };
        if (!this.passable(head)) {
            if (blockName(head) === 'minecraft:bedrock') return this.switchLobby('Bedrock prevents upward recovery');
            this.mineBlock(head, true);
            return;
        }
        if (!this.selectSlot(this.blockSlot)) return;
        const item = Player.getHeldItem()?.toMC()?.getItem();
        if (!(item instanceof net.minecraft.world.item.BlockItem)) return this.stop('The recovery block slot must contain placeable full blocks.');
        const block = item.getBlock();
        const world = World.getWorld();
        const pos = new BP(foot.x, foot.y + 1, foot.z);
        if (!block.defaultBlockState().isCollisionShapeFullBlock(world, pos))
            return this.stop('Use full blocks, not slabs or other partial blocks, for recovery.');
        this.stopControls();
        recovery.pillar = { y, startedAt: now, clickAt: now + this.delay(this.clickDelay) };
    }
}

new ScathaMacro();
