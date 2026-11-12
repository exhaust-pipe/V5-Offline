import { OverlayManager } from '../../gui/OverlayUtils';
import { ArmorStandEntity, BP, ClipContext, Direction, Vec3d } from '../../utils/Constants';
import { calculateAbsoluteAngles, offsetPitch, wrapTo180 } from '../../utils/Math';
import { MiningUtils, refuel } from '../../utils/MiningUtils';
import { ModuleBase } from '../../utils/ModuleBase';
import { ClientboundLevelParticlesPacket, getLevelParticleData } from '../../utils/Packets';
import { getLookingAt, getVisiblePoint, testPointNative } from '../../utils/Raytrace';
import { registerSkyblockEvent } from '../../utils/SkyblockEvents';
import { getArea, getPickaxeAbilityStatus } from '../../utils/TabListUtils';
import { Mouse } from '../../utils/Ungrab';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { Aote } from '../../utils/pathfinder/PathWalker/PathAote';
import { GuiStability } from '../../utils/player/GuiStability';
import { clickSlot, closeInventory, getGuiName, setItemSlot } from '../../utils/player/Inventory';
import { setKeysForStraightLineCoords } from '../../utils/player/Movement';
import { applyToPlayer, clampPitch } from '../../utils/player/RotationGCD';
import { getRotationCurveOffset, RotationModule, Rotations } from '../../utils/player/Rotations';
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
const CHEST_OVERLAP_CONFIRM_MS = 1200;
const WORM_SPAWN_TIMEOUT_MS = 60000;
const WORM_CONFIRM_DELAY_MS = 500;
const WORM_DISAPPEAR_GRACE_MS = 5000;
const WORM_COMBAT_OPTIONS = {
    roam: false,
    allowWarpStarts: false,
    travelClicks: false,
    rightClickChance: 0,
    allowArmorStands: true,
    ignoreArmorStandPickable: true,
};
// Stop moving in shafts and while solving chests. Ordinary tunnel mining may
// chase a fleeing goblin, then return to the saved mining position.
const GOBLIN_STATIONARY_COMBAT_OPTIONS = {
    roam: false,
    allowWarpStarts: false,
    travelClicks: false,
    rightClickChance: 0,
    tickTarget: (target) => {
        Client.stopMovement();
        if (!target) return;
        CombatBot.trackTarget();
        const point = CombatBot.getTargetPosition(target);
        if (point) CombatBot.tryAttack(CombatBot.getDistanceToPlayer(point).distance);
    },
};
const GOBLIN_CHASE_COMBAT_OPTIONS = {
    roam: false,
    allowWarpStarts: false,
    travelClicks: false,
    rightClickChance: 0,
    blacklistOnPathFailure: false,
};
const AREA_MISSING_CONFIRM_MS = 6000;
const AREA_WARP_GRACE_MS = 10000;
const GOBLIN_MISSING_GRACE_MS = 2000;
const GOBLIN_SPAWN_WAIT_MS = 12000;
const GOBLIN_COMBAT_TIMEOUT_MS = 35000;
const WORM_NAMETAG_HEAD_MAX_DISTANCE = 2;
const WORM_APPROACH_STOP_DISTANCE = 3.5;
const WORM_NAMETAG_GRACE_MS = 3000;
const WORM_SEGMENT_GRACE_MS = 1500;
const WORM_MOTION_MIN_DISTANCE = 0.01;
const WORM_DEBUG_INTERVAL_MS = 2000;
const WORM_DEBUG_NEARBY_INTERVAL_MS = 5000;
const WORM_DEBUG_NEARBY_RADIUS = 8;
const WORM_DEBUG_NEARBY_MAX_ENTITIES = 12;
const WORM_TUNNEL_HALF_LENGTH = 32;
const WORM_TUNNEL_HALF_WIDTH = 1.5;
const BACKWARD_STOP_DISTANCE = 2;
const LANE_CORRECTION_MIN = 0.29;
const LANE_CORRECTION_MAX = 0.71;
const BACKWARD_ARRIVAL_DISTANCE = 0.45;
const RETURN_STALL_TIMEOUT_MS = 20000;
const RETURN_TIMEOUT_MS = 120000;
const TUNNEL_RETURN_ALIGN_MAX_DISTANCE = 6;
const TUNNEL_RETURN_ALIGN_TIMEOUT_MS = 6000;
const TUNNEL_DIRECT_RETURN_TIMEOUT_MS = 12000;
const TUNNEL_DIRECT_RETURN_STALL_MS = 2000;
// Search for source lava only in four square horizontal regions; the Y=46..64 bounds are unchanged.
const LAVA_SCAN_CENTERS = [
    [565, 565],
    [465, 535],
    [470, 500],
    [565, 490],
];
const LAVA_SCAN_HALF_SIZE = 30;
const LAVA_REACH_TIMEOUT_MS = 20000;
const LAVA_MAX_RESELECTS = 3;
const LAVA_NEARBY_CANDIDATES = 5;
const LAVA_TARGET_FILL = new RenderColor(255, 120, 20, 70);
const LAVA_TARGET_WIRE = new RenderColor(255, 120, 20, 255);
const isInLavaScanRegion = (point) =>
    LAVA_SCAN_CENTERS.some(([x, z]) => Math.abs(point.x - x) < LAVA_SCAN_HALF_SIZE && Math.abs(point.z - z) < LAVA_SCAN_HALF_SIZE);
const ABILITY_STATES = new Set(['FORWARD', 'BACKWARD', 'TURN', 'DESCEND']);
const ABILITY_FALLBACK_COOLDOWN_MS = 200000;
const ABILITY_RETRY_DELAY_MS = 5000;
const HOTM_PERKS = ['Efficient Miner', 'Mole'];
const HOTM_OPEN_TIMEOUT_MS = 10000;
const HOTM_PERK_TIMEOUT_MS = 4000;
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
        this.on('postRenderWorld', () => this.renderLavaTarget());
        this.on('worldUnload', () => this.onWorldUnload());
        this.on('chat', (event) => {
            const message = cleanChat(event.message.getUnformattedText());
            if (this.enabled && /^CHARM! You charmed the Scatha and received \d[\d,]* Scatha Shards?!$/i.test(message)) {
                OverlayManager.incrementTrackedValue(this.oid, 'scathaKills');
            }
            if (this.enabled && /^You did not discover this treasure chest\.$/i.test(message)) {
                const chest = this.state === 'CHEST' ? this.chest : this.goblinResume?.state === 'CHEST' ? this.goblinResume.chestContext : null;
                if (chest) chest.unavailable = true;
            }
            if (/^You hear the sound of something approaching(?:\.{3}|\u2026)?$/i.test(message)) return this.interruptForWorm();
            const goblin = message.match(/^A (Golden|Diamond) Goblin has spawned!$/i);
            if (goblin) return this.interruptForGoblin(goblin[1].toLowerCase());
            if (this.state === 'LOADOUT' && /loadout/i.test(message) && /can't|cannot|can only|cooldown|wait|unable|locked/i.test(message)) {
                this.currentLoadout = null;
                this.loadoutRequest.phase = 'OPEN';
                this.loadoutRequest.dueAt = Date.now() + this.delay(this.actionDelay);
            }
        }).triggerIfCanceled(true);
        this.on('packetReceived', (packet) => {
            if (!this.enabled) return;
            const goblinResume = this.goblinResume;
            const chest = this.state === 'CHEST' ? this.chest : goblinResume && goblinResume.state === 'CHEST' ? goblinResume.chestContext : null;
            if (!chest || !chest.clickedAt || !chest.point) return;
            const data = getLevelParticleData(packet);
            if (data.particle?.getType() !== net.minecraft.core.particles.ParticleTypes.CRIT) return;
            const point = chest.point;
            if (Math.abs(data.x - point.x - 0.5) < 0.8 && Math.abs(data.y - point.y - 0.5) < 0.8 && Math.abs(data.z - point.z - 0.5) < 0.8) {
                const distance = Math.hypot(data.x - Player.getX(), data.z - Player.getZ());
                chest.particle = offsetPitch({ x: data.x, y: data.y, z: data.z }, 5 / Math.max(1, distance));
                chest.particleAt = Date.now();
                chest.progressAt = chest.particleAt;
            }
        }).setFilteredClass(ClientboundLevelParticlesPacket);
        for (const event of ['chestsolve', 'chestopen']) {
            registerSkyblockEvent(event, () => {
                if (!this.enabled) return;
                const goblinResume = this.goblinResume;
                const chest = this.state === 'CHEST' ? this.chest : goblinResume && goblinResume.state === 'CHEST' ? goblinResume.chestContext : null;
                if (chest && chest.clickedAt) chest.opened = true;
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
                if (!this.enabled || !this.useTunnelVision || !ABILITY_STATES.has(this.state) || Player.getHeldItemIndex() !== this.getMiningSlot() - 1) return;
                this.abilityFromChat = false;
                this.abilityUseAt = 0;
                this.abilityClickPending = false;
                this.lastAbilityUseAt = Date.now();
            });
        }
        registerSkyblockEvent('emptydrill', () => this.beginRefueling());
        this.createOverlay(
            [
                {
                    title: 'Status',
                    data: {
                        State: () => (this.refueling ? 'REFUEL' : this.state),
                        'Tunnel Y': () => this.tunnelY ?? this.targetY,
                        Direction: () => (this.lane ? `${this.lane.sign > 0 ? '+' : '-'}${this.lane.axis.toUpperCase()}` : 'None'),
                        'Worm spawns': () => OverlayManager.getTrackedValue(this.oid, 'wormSpawns', 0),
                        'Scatha kills': () => OverlayManager.getTrackedValue(this.oid, 'scathaKills', 0),
                        'Lobby intensity': () => `${this.lobbyIntensity ?? 0}/${this.lobbyThreshold}`,
                        'Exit intensity': () => `${this.exitIntensity ?? 0}/${this.exitThreshold}`,
                    },
                },
            ],
            {
                sessionTrackedValues: {
                    wormSpawns: 0,
                    scathaKills: 0,
                },
            }
        );
    }

    initSettings() {
        const slider = (title, field, min, max, value, description) => {
            this[field] = value;
            return this.addSlider(title, min, max, value, (input) => (this[field] = Math.max(min, Math.min(max, Math.round(input)))), description);
        };
        const range = (title, field, min, max, low, high, description) => {
            this[field] = { low, high };
            return this.addRangeSlider(
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
        slider('Mining Slot', 'miningSlot', 1, 8, 1, 'Hotbar slot containing the mining tool.');
        slider('Backward Mining Slot', 'backwardMiningSlot', 0, 8, 0, 'Mining tool for backward passes. 0 follows Mining Slot.');
        slider('Attack Slot', 'attackSlot', 1, 8, 2, 'Hotbar slot containing the combat weapon.');
        slider('Block Slot', 'blockSlot', 1, 8, 3, 'Hotbar slot containing full blocks for height recovery.');
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
        this.autoToggleHotmPerks = false;
        this.addToggle(
            'Auto Toggle HOTM Perks',
            (value) => {
                this.autoToggleHotmPerks = value;
                this.hotmPerksEnabled = null;
            },
            'When enabled, disable Mole and Efficient Miner for forward mining and turns, and enable them for backward mining, regardless of loadout. Requires both perks unlocked.',
            false
        );
        range('Forward Mining Time (s)', 'forwardTime', 10, 200, 60, 90, 'Random time before each backward pass. Combat and recovery pause this timer.');
        slider(
            'Skip Backward Under (blocks)',
            'skipBackwardUnder',
            0,
            20,
            10,
            'Skip backward mining and turn immediately when the forward distance is below this value. 0 always mines backward.'
        );
        range('UI Click Delay (ms)', 'clickDelay', 100, 2000, 200, 400, 'Random delay before inventory clicks and chest interactions.');
        range('Action Delay (ms)', 'actionDelay', 500, 5000, 1000, 3000, 'Random delay between macro states.');
        this.overrideRotationSpeed = false;
        this.scathaRotationSpeed = 400;
        let rotationSpeedSlider;
        this.addToggle(
            'Override Rotation Speed',
            (value) => {
                this.overrideRotationSpeed = !!value;
                rotationSpeedSlider.visible = this.overrideRotationSpeed;
            },
            'Use a Scatha Macro-specific rotation speed instead of the global setting.',
            false
        );
        rotationSpeedSlider = this.addSlider('Scatha Rotation Speed', 30, 60, 40, (value) => (this.scathaRotationSpeed = value * 10), 'Degrees per second.');
        rotationSpeedSlider.visible = this.overrideRotationSpeed;

        this.switchForwardPitch = true;
        this.fixedForwardPitch = null;
        let forwardRotationTimeSlider;
        let forwardBlockDistanceSlider;
        this.addToggle(
            'Switch Forward Pitch',
            (value) => {
                this.switchForwardPitch = !!value;
                forwardRotationTimeSlider.visible = this.switchForwardPitch;
                forwardBlockDistanceSlider.visible = this.switchForwardPitch;
                this.forwardPitch = null;
                this.forwardYaw = null;
                this.forwardAligned = false;
                if (!this.switchForwardPitch) {
                    this.fixedForwardPitch ??= random(15, 20);
                    this.fixedForwardYaw ??= this.lane ? this.yaw(this.lane) + random(-3, 3) : null;
                }
            },
            'Alternate between upward and downward mining pitches. When disabled, hold one downward pitch between 15 and 20 degrees.',
            true
        );
        forwardRotationTimeSlider = range(
            'Forward Rotation Time (ms)',
            'forwardRotationTime',
            100,
            1000,
            150,
            300,
            'Random duration of forward-mining pitch changes when Switch Forward Pitch is enabled.'
        );
        forwardRotationTimeSlider.visible = this.switchForwardPitch;
        forwardBlockDistanceSlider = slider(
            'Forward Block Distance (blocks)',
            'forwardBlockDistance',
            0,
            5,
            3,
            'How far ahead to stop for blocks during forward mining. 0 disables early stopping, but still clears blocks that obstruct movement.'
        );
        forwardBlockDistanceSlider.visible = this.switchForwardPitch;
        slider('Lobby Failsafe Threshold', 'lobbyThreshold', 1, 1000, 200, 'Chat Mention and Player Grief intensity. Switching lobbies clears this counter.');
        slider('Exit Failsafe Threshold', 'exitThreshold', 1, 1000, 200, 'All other failsafe events. Stops the macro when reached.');
        slider('Intensity Decay per 10s', 'intensityDecay', 0, 50, 5, 'Subtract this amount from both counters every 10 seconds.');
        this.wormDebug = false;
        this.addToggle(
            'Worm Detection Debug',
            (value) => (this.wormDebug = !!value),
            'Report WAIT_WORM targets, motion samples, verification failures, and nearby entity display names / TextDisplay server text in chat.',
            false
        );
    }

    delay(range) {
        return typeof range === 'number' ? range : randomInt(range.low, range.high);
    }

    onEnable() {
        if (!Player.getPlayer() || !World.isLoaded()) return this.stop('Join SkyBlock before starting.');
        if (CombatBot.enabled || Pathfinder.isPathing()) return this.stop('Stop the active Combat Bot or path before starting.');
        const inventory = Player.getInventory();
        for (const slot of new Set([this.miningSlot, this.backwardMiningSlot || this.miningSlot])) {
            const item = inventory?.getStackInSlot(slot - 1);
            if (!MiningUtils.isMiningTool(item)) {
                const itemName = item ? cleanChat(item.getName()) : 'empty';
                return this.stop(`Mining slot ${slot} must contain a mining tool (found: ${itemName}).`);
            }
        }
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
        const refueling = this.refueling;
        this.refueling = null;
        try {
            this.stopActivities();
            refueling?.cancel?.();
            if (this.state === 'LOADOUT' || this.hotmRequest) closeInventory();
            this.hotmRequest = null;
            this.state = 'IDLE';
            this.loadoutRequest = null;
            this.combatResume = null;
            this.wormSearch = null;
            this.wormLastStandPosition = null;
            this.wormTargetUuid = null;
            this.wormTargetFromMotion = false;
            this.wormConfirmation = null;
            this.wormTargets = [];
            this.wormCandidates?.clear();
            this.wormNametags?.clear();
            this.returnJob = null;
            this.recovery = null;
            this.chest = null;
            this.resetGoblin();
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
        this.refueling = null;
        this.tunnelY = this.targetY;
        this.lane = null;
        this.currentLoadout = null;
        this.loadoutRequest = null;
        this.hotmRequest = null;
        this.hotmPerksEnabled = null;
        this.combatResume = null;
        this.wormOrigin = null;
        this.wormSearch = null;
        this.wormWarningAt = 0;
        this.wormLastSeenAt = 0;
        this.wormLastStandPosition = null;
        this.wormTargetUuid = null;
        this.wormTargetFromMotion = false;
        this.wormConfirmation = null;
        this.wormTargets = [];
        this.wormCandidates = new Map();
        this.wormNametags = new Map();
        this.wormDebugScan = null;
        this.wormDebugLastAt = 0;
        this.wormDebugLastEvent = null;
        this.wormDebugNearbyAt = 0;
        this.returnJob = null;
        this.recovery = null;
        this.chest = null;
        this.safePoint = null;
        this.guiPausedAt = 0;
        this.cooldownY = null;
        this.cooldownUntil = 0;
        this.openedChests = new Set();
        this.forwardStart = null;
        this.forwardObstacle = null;
        this.backwardObstacle = null;
        this.backwardBlocked = null;
        this.forwardRemaining = null;
        this.turnPending = false;
        this.lavaCandidates = [];
        this.lavaTarget = null;
        this.lavaAttempts = 0;
        this.cliffAngles = null;
        this.areaMissingSince = 0;
        this.areaWarpGraceUntil = 0;
        this.resetGoblin();
    }

    stopControls() {
        Client.stopMovement();
        for (const button of ['leftclick', 'rightclick', 'shift', 'space', 'sprint']) Client.setKey(button, false);
        Rotations.stop();
        this.rotation = null;
        this.forwardAligned = false;
        this.forwardBlocked = null;
        this.backwardBlocked = null;
        this.correctingLane = false;
        this.freeMiningTarget = null;
    }

    stopActivities() {
        this.abilityUseAt = 0;
        this.abilityClickPending = false;
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
        if (this.hotmRequest && /heart of the mountain/i.test(String(getGuiName() || ''))) closeInventory();
        this.hotmRequest = null;
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
        // Perk toggling is controlled only by its setting and the mining state;
        // loadout changes do not invalidate this verified state.
        if (this.autoToggleHotmPerks && (state === 'FORWARD' || state === 'BACKWARD' || state === 'TURN')) {
            const enabled = state === 'BACKWARD';
            if (this.hotmPerksEnabled !== enabled) {
                this.hotmRequest = {
                    enabled,
                    phase: 'OPEN',
                    dueAt: 0,
                    attempts: 0,
                    clickAttempts: {},
                    missingSince: 0,
                    stability: new GuiStability(),
                };
            }
        }
    }

    aimAt(target, targetId = null) {
        if (!this.rotation) {
            Rotations.stop();
            this.rotation = { yaw: Player.getYaw(), pitch: Player.getPitch(), updatedAt: Date.now() };
            if (target.forward && this.forwardPitch) {
                this.forwardYaw.from = this.rotation.yaw;
                this.forwardYaw.lastAt = this.rotation.updatedAt;
                this.forwardYaw.initialDistance = Math.abs(wrapTo180(this.forwardYaw.target - this.rotation.yaw));
                this.forwardYaw.complete = false;
                this.forwardPitch.from = this.rotation.pitch;
                this.forwardPitch.startedAt = this.rotation.updatedAt;
                this.forwardPitch.lastAt = this.rotation.updatedAt;
                this.forwardPitch.initialDistance = Math.abs(this.forwardPitch.target - this.rotation.pitch);
                this.forwardPitch.complete = false;
            }
        }
        this.rotation.target = target;
        this.rotation.targetId = targetId;
    }

    updateRotation() {
        const rotation = this.rotation;
        if (!rotation || !Player.getPlayer() || !World.isLoaded()) return;
        if (Client.isInGui()) {
            // The shared rotation controller otherwise continues to turn behind open GUIs.
            if (!rotation.target.forward && Rotations.active) Rotations.stop();
            return;
        }
        const now = Date.now();
        rotation.updatedAt = now;
        if (rotation.target.forward) {
            if (Rotations.active) Rotations.stop();
            rotation.motion = null;
            if (!this.forwardPitch || !this.forwardYaw) return;
            if (this.switchForwardPitch) {
                // Pitch and yaw share one randomized duration, easing curve, and start time.
                // The yaw offset changes only when the pitch switches, never independently.
                const pitch = this.forwardPitch;
                const yaw = this.forwardYaw;
                const progress = Math.max(0, Math.min(1, (now - pitch.startedAt) / pitch.duration));
                const eased = progress * progress * (3 - 2 * progress);
                const yawDelta = wrapTo180(yaw.target - yaw.from);
                const pitchDelta = pitch.target - pitch.from;
                const curve = getRotationCurveOffset(eased, Math.hypot(yawDelta, pitchDelta), pitch.curveSeed);
                rotation.yaw = yaw.from + yawDelta * eased + curve.x;
                rotation.pitch = clampPitch(pitch.from + pitchDelta * eased + curve.y);
                yaw.complete = pitch.complete = progress === 1;
            } else {
                // Fixed random yaw and pitch for the whole forward pass.
                // Both axes use global/overridden rotation speed only for initial alignment.
                this.advanceForwardAxis(rotation, this.forwardYaw, 'yaw', now);
                this.advanceForwardAxis(rotation, this.forwardPitch, 'pitch', now);
            }
            applyToPlayer(rotation.yaw, rotation.pitch);
            if (this.switchForwardPitch && this.forwardAligned && this.forwardPitch.complete && this.forwardYaw.complete) {
                this.setForwardPitch(!this.preferHead);
            }
        } else {
            const target = Number.isFinite(rotation.target.yaw) ? rotation.target : calculateAbsoluteAngles(rotation.target);
            this.updateSpeedRotation(rotation, target);
        }
    }

    advanceForwardAxis(rotation, motion, axis, now) {
        const delta = axis === 'yaw' ? wrapTo180(motion.target - rotation.yaw) : motion.target - rotation.pitch;
        const distance = Math.abs(delta);
        if (distance <= 0.1 || RotationModule.rotationMode === 'Instant') {
            rotation[axis] = motion.target;
            motion.complete = true;
        } else {
            const elapsed = Math.max(0, (now - motion.lastAt) / 1000);
            const speed = this.overrideRotationSpeed ? this.scathaRotationSpeed : RotationModule.ROTATION_SPEED;
            const damping = Math.min(distance / RotationModule.DAMPING_DIST, 1);
            const ratio = Math.min(1, ((speed * Math.sqrt(damping) + 10) * elapsed) / distance);
            if (ratio >= 1) {
                rotation[axis] = motion.target;
                motion.complete = true;
            } else {
                const progress = motion.initialDistance > 0 ? Math.max(0, Math.min(1, 1 - distance / motion.initialDistance)) : 1;
                const curve =
                    RotationModule.rotationMode === 'Linear' ? { x: 0, y: 0 } : getRotationCurveOffset(progress, motion.initialDistance, motion.curveSeed);
                rotation[axis] += delta * ratio + (axis === 'yaw' ? curve.x : curve.y) * ratio;
                if (axis === 'pitch') rotation.pitch = clampPitch(rotation.pitch);
                motion.complete = false;
            }
        }
        motion.lastAt = now;
    }

    updateSpeedRotation(rotation, target) {
        rotation.yaw = Player.getYaw();
        rotation.pitch = Player.getPitch();
        const yaw = rotation.yaw + wrapTo180(target.yaw - rotation.yaw);
        const pitch = clampPitch(target.pitch);
        let motion = rotation.motion;
        if (
            !motion ||
            motion.targetId !== rotation.targetId ||
            (motion.complete && (Math.abs(wrapTo180(yaw - motion.yaw)) > 0.1 || Math.abs(pitch - motion.pitch) > 0.1))
        ) {
            motion = { targetId: rotation.targetId, yaw, pitch, started: false, complete: false };
            rotation.motion = motion;
        }
        if (motion.complete) return;

        if (motion.started && !Rotations.active) {
            // The shared controller clears its request once it reaches the target.
            // Preserve the completion flag used by return/attack movement checks.
            if (Math.hypot(wrapTo180(yaw - rotation.yaw), pitch - rotation.pitch) <= 0.75) {
                motion.complete = true;
                return;
            }
        }

        const options = this.overrideRotationSpeed ? { rotationSpeed: this.scathaRotationSpeed } : {};
        if (Rotations.lookAtAngles(yaw, pitch, options)) {
            motion.started = true;
            motion.yaw = yaw;
            motion.pitch = pitch;
        }
    }

    getMiningSlot() {
        const state = this.state === 'LOADOUT' ? this.loadoutRequest?.nextState : this.state;
        const backward = state === 'BACKWARD' || (state === 'CHEST' && this.chest?.resume?.state === 'BACKWARD');
        return backward ? this.backwardMiningSlot || this.miningSlot : this.miningSlot;
    }

    beginRefueling() {
        if (!this.enabled || this.refueling) return;
        const request = {
            snapshot: this.snapshot(),
            toolSlot: MiningUtils.isMiningTool(Player.getHeldItem()) ? Player.getHeldItemIndex() : this.getMiningSlot() - 1,
            startedAt: Date.now(),
        };
        this.refueling = request;
        if (this.state === 'LOADOUT' || this.hotmRequest) closeInventory();
        this.hotmRequest = null;
        this.guiPausedAt = 0;
        this.stopActivities();
        this.message('&eThe mining tool has insufficient fuel. Refueling...');
        request.cancel = refuel(
            (success) => {
                if (!this.enabled || this.refueling !== request) return;
                if (!success) return this.stop('Refueling failed.');
                if (!MiningUtils.isMiningTool(Player.getInventory()?.getStackInSlot(request.toolSlot)))
                    return this.stop('The mining tool is missing from its slot after refueling.');
                const elapsed = Date.now() - request.startedAt;
                for (const field of ['wormWarningAt', 'wormLastSeenAt', 'wormMissingAt', 'goblinSpawnedAt', 'goblinMissingAt']) {
                    if (this[field]) this[field] += elapsed;
                }
                this.refueling = null;
                setItemSlot(request.toolSlot);
                this.message('&aRefueling successful. Resuming the previous state.');
                if (request.snapshot.state === 'RESUME_PATH' && this.returnJob) this.returnToSnapshot(this.returnJob.snapshot, this.returnJob.after);
                else this.restore(request.snapshot, 0);
                if (request.wormPending) this.interruptForWorm();
                else if (request.goblinPending) this.interruptForGoblin(request.goblinPending);
            },
            { allowNpc: false, toolSlot: request.toolSlot }
        );
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
        if (this.refueling) return this.stop('World changed while refueling.');
        this.generation++;
        this.stopActivities();
        this.currentLoadout = null;
        if (this.state !== 'WARP' && this.state !== 'HOP') this.switchLobby('Unexpected world change');
    }

    switchLobby(reason) {
        if (this.refueling) return this.stop(`Refueling interrupted: ${reason}.`);
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
        if (this.refueling) {
            if (Date.now() - this.refueling.startedAt > 120000) return this.stop('Refueling timed out.');
            Client.stopMovement();
            return;
        }
        if (!Player.getPlayer() || !World.isLoaded()) return;
        if (['HOP', 'WARP'].includes(this.state) && !cleanChat(Scoreboard.getTitle()).includes('SKYBLOCK')) {
            this.initialized = false;
            return;
        }
        if (!['HOP', 'WARP'].includes(this.state)) {
            if (getArea() === 'Crystal Hollows') this.areaMissingSince = 0;
            else {
                const now = Date.now();
                if (!this.areaMissingSince) this.areaMissingSince = now;
                // Tab-list area data briefly disappears after warps and during lag.
                // Require sustained evidence before abandoning an otherwise valid lobby.
                if (now >= Math.max(this.areaMissingSince + AREA_MISSING_CONFIRM_MS, this.areaWarpGraceUntil))
                    return this.switchLobby('Left the Crystal Hollows');
                Client.stopMovement();
                Client.setKey('leftclick', false);
                return;
            }
        }
        if (this.checkHeight()) return;
        // Entity packets can arrive while the combat loadout screen is open.
        // Keep tracking without starting combat or interrupting the GUI transition.
        if (this.state === 'LOADOUT' && this.loadoutRequest?.nextState === 'WAIT_WORM') this.findWormTargets();
        if (this.state === 'LOADOUT' && this.loadoutRequest?.nextState === 'WAIT_GOBLIN') this.lockGoblinTarget();
        if (Date.now() < this.readyAt) return;
        if (Client.isInGui() && this.state !== 'LOADOUT' && !this.hotmRequest) {
            this.stopActivities();
            if (!this.guiPausedAt) this.guiPausedAt = Date.now();
            if (Date.now() - this.guiPausedAt > 30000) {
                const guiName = getGuiName();
                const guiClass = Client.currentGui.getClassName();
                const guiInfo = guiName ? `"${guiName}" (${guiClass})` : guiClass;
                this.stop(`Close the open screen before restarting. Open GUI: ${guiInfo}.`);
            }
            return;
        }
        if (this.guiPausedAt) {
            const elapsed = Date.now() - this.guiPausedAt;
            this.startedAt += elapsed;
            if (['PATH_LAVA', 'ENTER_LAVA'].includes(this.state) && this.lavaTarget?.pathStartedAt != null) this.lavaTarget.pathStartedAt += elapsed;
            if (this.state === 'WAIT_WORM' && this.wormWarningAt) this.wormWarningAt += elapsed;
            if (this.state === 'WAIT_WORM' && this.wormConfirmation) this.wormConfirmation.startedAt += elapsed;
            if (this.state === 'WORM' && this.wormLastSeenAt) this.wormLastSeenAt += elapsed;
            this.forwardUntil += elapsed;
            this.progressAt += elapsed;
            if (this.state === 'RESUME_PATH') {
                for (const tracker of [this.returnJob, this.returnJob?.alignment, this.returnJob?.directReturn]) {
                    if (tracker?.progressAt != null) tracker.progressAt += elapsed;
                    if (tracker?.startedAt != null) tracker.startedAt += elapsed;
                }
            }
            if (this.chest) {
                this.chest.progressAt += elapsed;
                if (this.chest.overlapClickedAt) this.chest.overlapClickedAt += elapsed;
                if (this.chest.approach) this.chest.approach.startedAt += elapsed;
            }
            this.guiPausedAt = 0;
        }
        if (this.hotmRequest) return this.tickHotm();
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
            case 'JUMP_CLIFF':
                return this.jumpCliff();
            case 'PATH_LAVA':
                return this.tickLavaPath();
            case 'ENTER_LAVA':
                return this.enterLava();
            case 'DESCEND':
                return this.descend();
            case 'WAIT_GOBLIN':
                return this.waitForGoblin();
            case 'GOBLIN':
                return this.fightGoblin();
            case 'ALIGN':
                return this.align();
            case 'FORWARD':
                return this.mineForward();
            case 'BACKWARD':
                return this.mineBackward();
            case 'RETURN':
                return this.returnToSnapshot({ ...this.snapshot(), point: { ...this.breakPoint } }, 'RETURN_RESUME');
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
                const seenChunks = new Set();
                for (const [x, z] of LAVA_SCAN_CENTERS) {
                    const minX = Math.floor((x - LAVA_SCAN_HALF_SIZE + 1) / 16);
                    const maxX = Math.floor((x + LAVA_SCAN_HALF_SIZE - 1) / 16);
                    const minZ = Math.floor((z - LAVA_SCAN_HALF_SIZE + 1) / 16);
                    const maxZ = Math.floor((z + LAVA_SCAN_HALF_SIZE - 1) / 16);
                    for (let cx = minX; cx <= maxX; cx++)
                        for (let cz = minZ; cz <= maxZ; cz++) {
                            const chunkKey = `${cx},${cz}`;
                            if (seenChunks.has(chunkKey)) continue;
                            seenChunks.add(chunkKey);
                            this.scanChunks.push([16 * cx, 16 * cz]);
                        }
                }
                break;
            }
            case 'JUMP_CLIFF':
                this.cliffAngles = {
                    yaw: Math.random() < 0.5 ? random(-180, -150) : random(150, 180),
                    pitch: random(-30, 30),
                };
                break;
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
                this.fixedForwardPitch = random(15, 20);
                this.fixedForwardYaw = this.yaw(this.lane) + random(-3, 3);
                break;
            case 'BACKWARD':
                this.backwardYaw = this.yaw(this.lane) + random(-3, 3);
                this.backwardPitch = random(-15, -7);
                this.backwardObstacle = null;
                this.backwardBlocked = null;
                break;
            case 'TURN':
                if (!this.turnGoal) {
                    this.turnOrigin = center({ ...position(), y: this.tunnelY });
                    this.turnGoal = this.offset(this.turnOrigin, this.turnDirection(), randomInt(5, 7));
                }
                this.randomizeCorridor();
                break;
            case 'WAIT_WORM':
                this.wormConfirmation = null;
                this.wormTargets = [];
                this.wormMissingAt = 0;
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
            this.areaMissingSince = 0;
            this.areaWarpGraceUntil = Date.now() + AREA_WARP_GRACE_MS;
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
        // Loadout switching is independent of automatic HOTM perk toggling.
        // Preserve the last verified perk state across all loadout changes.
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

    findHotmPerks(container) {
        const items = container.getItems() || [];
        const perks = {};
        for (let slot = 0; slot < items.length - 36; slot++) {
            const item = items[slot];
            if (!item) continue;
            const name = cleanChat(item.getName());
            if (!HOTM_PERKS.includes(name)) continue;
            const status = (item.getLore() || []).map(cleanChat).find((line) => /^(ENABLED|DISABLED)$/i.test(line));
            perks[name] = { slot, enabled: status ? /^ENABLED$/i.test(status) : null };
        }
        return perks;
    }

    retryHotm(request, reason) {
        if (request.attempts >= 3) return this.stop(`Could not toggle HOTM perks: ${reason}. Check /hotm and unlock both perks.`);
        request.phase = 'OPEN';
        request.dueAt = Date.now() + this.delay(this.actionDelay);
        request.missingSince = 0;
        request.stability.reset();
    }

    tickHotm() {
        const request = this.hotmRequest;
        if (!request) return;
        const now = Date.now();
        Client.stopMovement();
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        if (now < request.dueAt) return;
        if (request.phase === 'OPEN') {
            request.attempts++;
            closeInventory();
            ChatLib.command('hotm');
            request.phase = 'WAIT';
            request.sentAt = now;
            request.dueAt = now + this.delay(this.clickDelay);
            request.stability.reset();
            return;
        }
        const container = Player.getContainer();
        const guiOpen = container && /heart of the mountain/i.test(String(getGuiName() || ''));
        if (!guiOpen) {
            request.stability.reset();
            if (now - request.sentAt >= HOTM_OPEN_TIMEOUT_MS) this.retryHotm(request, 'the HOTM menu did not open');
            return;
        }
        if (!request.stability.update()) return;
        if (request.phase === 'WAIT') {
            request.phase = 'CHECK';
            request.dueAt = now + this.delay(this.clickDelay);
            return;
        }

        const perks = this.findHotmPerks(container);
        if (request.phase === 'VERIFY') {
            const perk = perks[request.clickedName];
            if (perk?.enabled === request.enabled) {
                request.phase = 'CHECK';
                request.dueAt = now + this.delay(this.clickDelay);
            } else if (now - request.clickedAt >= HOTM_PERK_TIMEOUT_MS) {
                if (!perk || perk.enabled === null) return this.retryHotm(request, `cannot read ${request.clickedName}`);
                request.phase = 'CHECK';
                request.dueAt = now + this.delay(this.clickDelay);
            }
            return;
        }

        const missing = HOTM_PERKS.find((name) => !perks[name] || perks[name].enabled === null);
        if (missing) {
            if (!request.missingSince) request.missingSince = now;
            if (now - request.missingSince >= HOTM_PERK_TIMEOUT_MS) this.retryHotm(request, `cannot find or read ${missing}`);
            return;
        }
        request.missingSince = 0;
        const name = HOTM_PERKS.find((name) => perks[name].enabled !== request.enabled);
        if (!name) {
            closeInventory();
            this.hotmPerksEnabled = request.enabled;
            this.hotmRequest = null;
            this.readyAt = now + this.delay(this.actionDelay);
            return;
        }
        request.clickAttempts[name] = (request.clickAttempts[name] || 0) + 1;
        if (request.clickAttempts[name] > 3) return this.stop(`Could not verify HOTM perk ${name} after three right-clicks.`);
        if (!clickSlot(perks[name].slot, false, 'RIGHT')) return this.retryHotm(request, `could not click ${name}`);
        request.clickedName = name;
        request.clickedAt = now;
        request.sentAt = now;
        request.phase = 'VERIFY';
        request.dueAt = now + this.delay(this.clickDelay);
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
                if (!isInLavaScanRegion(point)) continue;
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
        if (!this.selectLavaTarget()) return;
        this.setState('JUMP_CLIFF');
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
                if (this.passable({ x, y, z }) && this.passable({ x, y: y + 1, z })) goals.push([x + 0.5, y - 1, z + 0.5]);
            }
        }
        return goals;
    }

    selectLavaTarget(reason = null) {
        const directions = [
            { axis: 'z', sign: 1 },
            { axis: 'x', sign: -1 },
            { axis: 'z', sign: -1 },
            { axis: 'x', sign: 1 },
        ];
        let previous = this.lavaTarget?.point;
        while (this.lavaCandidates.length && this.lavaAttempts <= LAVA_MAX_RESELECTS) {
            if (this.lavaAttempts) this.lavaCandidates.sort((a, b) => flatDistance(center(a.point)) - flatDistance(center(b.point)));
            const count = this.lavaAttempts ? Math.min(LAVA_NEARBY_CANDIDATES, this.lavaCandidates.length) : this.lavaCandidates.length;
            const target = this.lavaCandidates.splice(randomInt(0, count - 1), 1)[0];
            this.lavaAttempts++;
            target.goals = this.lavaShoreGoals(target.point);
            const start = randomInt(0, directions.length - 1);
            for (let i = 0; target.goals.length && i < directions.length; i++) {
                const direction = directions[(start + i) % directions.length];
                if (!this.canStartTunnelBelowLava(target.point, direction)) continue;
                this.lavaTarget = target;
                this.lane = { ...direction, turnSign: Math.random() < 0.5 ? -1 : 1 };
                const selection = previous
                    ? `Switching lava target (${this.lavaAttempts - 1}/${LAVA_MAX_RESELECTS}): ${reason}; (${key(previous)}) ->`
                    : 'Selected lava target:';
                this.message(`&e${selection} (${key(target.point)}), direction ${direction.sign > 0 ? '+' : '-'}${direction.axis.toUpperCase()}.`);
                return true;
            }
            this.message(`&eLava at (${key(target.point)}) failed the shore/shaft/direction precheck.`);
            previous = target.point;
            reason = 'Precheck failed';
        }
        const failure = this.lavaAttempts > LAVA_MAX_RESELECTS ? 'Lava target failed after three reselections' : 'No viable lava candidates remain';
        this.switchLobby(reason ? `${failure}: ${reason}` : failure);
        return false;
    }

    renderLavaTarget() {
        if (!this.lavaTarget || !World.isLoaded() || !['JUMP_CLIFF', 'PATH_LAVA'].includes(this.state)) return;
        const { x, y, z } = this.lavaTarget.point;
        const point = new Vec3d(x, y, z);
        Render3D.drawStyledBox(point, LAVA_TARGET_FILL, LAVA_TARGET_WIRE, 3, false);
        Render3D.drawTracer(point.add(0.5, 0.5, 0.5), LAVA_TARGET_WIRE, 2, false);
        Render3D.drawText(`Lava (${x}, ${y}, ${z})`, point.add(0.5, 1.5, 0.5), 1.2, true, false, true);
    }

    canStartTunnelBelowLava(point, direction) {
        // Validate the entire descending shaft before committing to a tunnel direction.
        for (let y = point.y; y >= this.tunnelY; y--) {
            const below = { ...point, y };
            if (!this.loaded(below) || blockName(below) === 'minecraft:bedrock') return false;
        }
        const scan = this.scanTunnel(this.tunnelY, direction, point);
        return !scan.unknown && !scan.open && !scan.boundary;
    }

    jumpCliff() {
        if (Player.getY() < 80) return this.setState('PATH_LAVA', 0);
        if (Date.now() - this.startedAt > 20000) return this.switchLobby('Could not jump below Y=80');
        this.aimAt(this.cliffAngles, 'lava:jump');
        const aligned = Math.abs(wrapTo180(Player.getYaw() - this.cliffAngles.yaw)) <= 3 && Math.abs(Player.getPitch() - this.cliffAngles.pitch) <= 3;
        Client.setKey('w', aligned);
        Client.setKey('space', aligned);
    }

    startPath(goals, job, options = {}) {
        const generation = this.generation;
        this.ownsPath = true;
        job.result = null;
        Pathfinder.findPath(
            goals,
            (success) => {
                if (this.enabled && generation === this.generation && this.ownsPath) job.result = !!success;
            },
            { allowWarpStarts: false, walkArrivalRadius: 0.8, silent: true, ...options }
        );
    }

    startLavaPath() {
        if (!this.lavaTarget && !this.selectLavaTarget()) return;
        this.lavaTarget.pathStartedAt ??= Date.now();
        this.startPath(this.lavaTarget.goals, this.lavaTarget, { walkArrivalHeightTolerance: 1.5 });
    }

    tickLavaPath() {
        const target = this.lavaTarget;
        const atShore = target.goals.some(([x, y, z]) => flatDistance({ x, z }) <= 0.8 && Math.abs(Player.getY() - y - 1) <= 0.6);
        const atLava = flatDistance(center(target.point)) <= 0.45 && Math.abs(Player.getY() - target.point.y) <= 1.5;
        if (atShore || atLava) return this.setState('ENTER_LAVA', 0);
        if (this.checkLavaTimeout()) return;
        if (target.result !== null || !Pathfinder.isPathing()) this.setState('PATH_LAVA');
    }

    checkLavaTimeout() {
        if (Date.now() - this.lavaTarget.pathStartedAt < LAVA_REACH_TIMEOUT_MS) return false;
        if (this.selectLavaTarget('Could not reach lava within 20 seconds')) this.setState('PATH_LAVA');
        return true;
    }

    enterLava() {
        if (this.alignLavaColumn() && Player.getY() <= this.lavaTarget.point.y + 1) return this.setState('DESCEND');
        this.checkLavaTimeout();
    }

    alignLavaColumn() {
        const point = center(this.lavaTarget.point);
        const player = Player.getPlayer();
        const enteringFromBelow = this.state === 'ENTER_LAVA' && Player.getY() < point.y;
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
            setKeysForStraightLineCoords(point.x, point.y, point.z, enteringFromBelow);
        }
        Client.setKey('sprint', false);
        const world = World.getWorld();
        const floor = new BP(Math.floor(point.x), Math.floor(Player.getY() - 0.05), Math.floor(point.z));
        // Sneaking on the shore can prevent stepping off its edge into the shaft.
        Client.setKey('shift', !enteringFromBelow && !aligned && (!player.onGround() || !world.getBlockState(floor).getCollisionShape(world, floor).isEmpty()));
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
        // Use the actual supporting block: walls/fences can extend above their block Y.
        const point = this.miningBlockBelowPlayer();
        if (blockName(point) === 'minecraft:bedrock') return this.switchLobby('Bedrock blocks the entry shaft');
        this.mineBlock(point, true);
    }

    interruptForGoblin(type) {
        if (!this.enabled || !['golden', 'diamond'].includes(type) || this.goblinResume) return;
        const pendingState = this.state === 'LOADOUT' ? this.loadoutRequest?.nextState : this.state;
        if (!MINING_STATES.has(pendingState)) return;
        if (this.refueling) {
            this.refueling.goblinPending = type;
            return;
        }

        // Keep the exact interrupted state (including any open treasure chest).
        // This snapshot also freezes the remaining forward mining time.
        this.goblinResume = this.snapshot();
        this.goblinType = type;
        this.goblinOrigin = position();
        this.goblinSearch = this.createTunnelSearch(this.goblinOrigin, pendingState);
        this.goblinSpawnedAt = Date.now();
        this.goblinTargetUuid = null;
        this.goblinMissingAt = 0;
        if (this.state === 'LOADOUT') {
            this.currentLoadout = null;
            closeInventory();
        }
        this.lockGoblinTarget();
        this.switchLoadout(this.combatLoadout, 'WAIT_GOBLIN', 0);
        this.message(`&e${type === 'golden' ? 'Golden' : 'Diamond'} Goblin spawned. Pausing mining to attack.`);
    }

    lockGoblinTarget() {
        if (!this.goblinType || !this.goblinOrigin || this.goblinTargetUuid) return;
        // Resolve the matching nametag to an actual damageable mob; do not
        // attack armor stands, other goblin types or nearby unrelated mobs.
        const origin = this.goblinOrigin;
        const candidates = CombatBot.findMob({
            names: [`${this.goblinType} Goblin`],
            allowInvisible: true,
            boundaryCheck: (x, y, z) => this.inTunnelSearchBounds({ x, y, z }, this.goblinSearch),
        });
        const target = candidates.sort(
            (a, b) =>
                Math.hypot(a.getX() - origin.x, a.getY() - origin.y, a.getZ() - origin.z) -
                Math.hypot(b.getX() - origin.x, b.getY() - origin.y, b.getZ() - origin.z)
        )[0];
        if (target) this.goblinTargetUuid = CombatBot.getTargetUuid(target);
    }

    findLockedGoblinTarget() {
        if (!this.goblinTargetUuid) return null;
        const target = World.getAllEntities().find((entity) => CombatBot.getTargetUuid(entity) === this.goblinTargetUuid);
        if (!target || !CombatBot.isCombatTargetCandidate(target, true)) return null;
        return this.inTunnelSearchBounds({ x: target.getX(), y: target.getY(), z: target.getZ() }, this.goblinSearch) ? target : null;
    }

    waitForGoblin() {
        if (!this.goblinResume) return this.stop('Missing goblin resume state.');
        this.lockGoblinTarget();
        if (this.findLockedGoblinTarget()) {
            this.setState('GOBLIN', 0);
            this.message('&aGoblin located. Starting combat.');
            return this.fightGoblin();
        }
        if (Date.now() - this.startedAt >= GOBLIN_SPAWN_WAIT_MS || Date.now() - this.goblinSpawnedAt >= GOBLIN_COMBAT_TIMEOUT_MS) {
            this.message('&eSpawned goblin not found nearby. Resuming the previous state.');
            this.finishGoblinCombat();
        }
    }

    fightGoblin() {
        const now = Date.now();
        if (!this.goblinResume) return this.stop('Missing goblin resume state.');
        if (now - this.goblinSpawnedAt >= GOBLIN_COMBAT_TIMEOUT_MS) {
            this.message('&eGoblin combat timed out. Resuming the previous state.');
            return this.finishGoblinCombat();
        }
        const target = this.findLockedGoblinTarget();
        if (!target) {
            if (this.ownsCombat) this.stopActivities();
            if (!this.goblinMissingAt) this.goblinMissingAt = now;
            if (now - this.goblinMissingAt >= GOBLIN_MISSING_GRACE_MS) {
                this.message('&aGoblin disappeared. Resuming the previous state.');
                this.finishGoblinCombat();
            }
            return;
        }
        this.goblinMissingAt = 0;
        if (!Pathfinder.isPathing() && !this.selectSlot(this.attackSlot)) return;
        const snapshot = this.goblinResume;
        const interruptedState = snapshot.state === 'LOADOUT' ? snapshot.loadout?.nextState : snapshot.state;
        const stayInPlace = ['DESCEND', 'CHEST', 'RECOVERY_HEIGHT'].includes(interruptedState);
        CombatBot.setExternalTargets([target], stayInPlace ? GOBLIN_STATIONARY_COMBAT_OPTIONS : GOBLIN_CHASE_COMBAT_OPTIONS);
        if (!this.ownsCombat) {
            this.ownsCombat = true;
            CombatBot.toggle(true, true);
        }
    }

    resetGoblin() {
        this.goblinResume = null;
        this.goblinType = null;
        this.goblinOrigin = null;
        this.goblinSearch = null;
        this.goblinSpawnedAt = 0;
        this.goblinTargetUuid = null;
        this.goblinMissingAt = 0;
    }

    finishGoblinCombat() {
        const snapshot = this.goblinResume;
        if (!snapshot) return this.stop('Missing goblin resume state.');
        const interruptedState = snapshot.state === 'LOADOUT' ? snapshot.loadout?.nextState : snapshot.state;
        const stayInPlace = ['DESCEND', 'CHEST', 'RECOVERY_HEIGHT'].includes(interruptedState);
        this.stopActivities();
        this.resetGoblin();

        // Chasing a fleeing goblin may move away from the original mining lane.
        // Return first when that happened, rather than mining from the wrong spot.
        if (!stayInPlace && (flatDistance(snapshot.point) > 0.6 || Math.abs(Player.getY() - snapshot.point.y) > 0.25))
            return this.returnToSnapshot(snapshot, 'GOBLIN_RESUME');
        this.restore(snapshot, 0);
    }

    align() {
        if (!this.walkTo(this.alignPoint)) return;
        if (!this.lane) return this.switchLobby('No initial mining direction was selected');
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

    inLaneRange(coordinate, laneCenter) {
        const laneBlock = Math.floor(laneCenter);
        return coordinate >= laneBlock + LANE_CORRECTION_MIN && coordinate <= laneBlock + LANE_CORRECTION_MAX;
    }

    moveAlongLane(direction, origin = this.laneStart, facing = this.lane) {
        const other = direction.axis === 'x' ? 'z' : 'x';
        const coordinate = position()[other];
        const deviation = Math.abs(coordinate - origin[other]);
        if (!this.inLaneRange(coordinate, origin[other])) this.correctingLane = true;
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

    miningBlockBelowPlayer(offset = 0.05) {
        const feetY = Player.getY();
        const point = { x: Math.floor(Player.getX()), y: Math.floor(feetY - offset), z: Math.floor(Player.getZ()) };
        if (!AIR.has(blockName(point))) return point;
        const below = { ...point, y: point.y - 1 };
        if (!this.loaded(below)) return point;
        const world = World.getWorld();
        const pos = new BP(below.x, below.y, below.z);
        const bounds = Player.getPlayer().getBoundingBox();
        // Walls, fences and similar blocks can support the player 1.5 blocks above their base.
        // Their block above is air even though the player is standing on their collision shape.
        for (const box of world.getBlockState(pos).getCollisionShape(world, pos).toAabbs()) {
            if (box.maxY <= 1 || Math.abs(below.y + box.maxY - feetY) > 0.12) continue;
            if (
                bounds.maxX <= below.x + box.minX ||
                bounds.minX >= below.x + box.maxX ||
                bounds.maxZ <= below.z + box.minZ ||
                bounds.minZ >= below.z + box.maxZ
            )
                continue;
            return below;
        }
        return point;
    }

    scanTunnel(y, direction, origin = position()) {
        let run = 0;
        const side = { axis: direction.axis === 'x' ? 'z' : 'x', sign: 1 };
        for (let step = 1; step <= 34; step++) {
            if (step > 30 && run === 0) break;
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
        const earlyStopDistance = this.switchForwardPitch ? this.forwardBlockDistance : 0;
        const obstacleScanDistance = Math.max(0.05, earlyStopDistance - Player.getPlayer().getBbWidth() / 2);
        const overlapping = this.overlappingChest();
        if (overlapping) return this.openChest(overlapping);
        if (this.forwardObstacle) {
            const blocker = this.blockingAhead(this.lane, obstacleScanDistance);
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
            if (scan.open) return this.switchLobby('No five-column enclosed tunnel starts within the next 30 blocks');
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
        const obstacle = this.blockingAhead(this.lane, obstacleScanDistance);
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
            if (earlyStopDistance > 4 && !this.getMiningAim(obstacle)) {
                this.forwardBlocked = null;
                this.moveAlongLane(this.lane);
                if (!this.holdMiningAttack(looking)) return;
                return this.checkProgress(this.freeMiningTarget ? this.freeMiningTarget.timeoutMs : 15000);
            }
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
        const world = World.getWorld();
        const pos = new BP(point.x, point.y, point.z);
        // A partial block may have no selectable surface at the cube center.
        for (const box of world.getBlockState(pos).getCollisionShape(world, pos).toAabbs()) {
            const aim = trace({
                x: point.x + (box.minX + box.maxX) / 2,
                y: point.y + (box.minY + box.maxY) / 2,
                z: point.z + (box.minZ + box.maxZ) / 2,
            });
            if (aim) return aim;
        }
        const visible = getVisiblePoint(point.x, point.y, point.z);
        return visible ? trace({ x: visible[0], y: visible[1], z: visible[2] }) : null;
    }

    isForwardTunnelBlock(point) {
        const other = this.lane.axis === 'x' ? 'z' : 'x';
        const floorY = Math.floor(this.tunnelY);
        return point[other] === Math.floor(this.laneStart[other]) && (point.y === floorY || point.y === floorY + 1);
    }

    exposedForwardBlocks(direction = this.lane) {
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
                    if ((point[direction.axis] + 0.5 - origin[direction.axis]) * direction.sign <= 0 || !this.loaded(point)) continue;
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
                        (name === HARDSTONE && direction.sign === this.lane.sign) ||
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

    clearForwardObstacles(direction = this.lane, obstacleField = 'forwardObstacle') {
        const job = this[obstacleField];
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
                if (obstacleField === 'backwardObstacle') this.switchLobby('Bedrock blocks backward mining');
                else this.beginBackward(true);
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
                    if (this.state === 'FORWARD' || this.state === 'BACKWARD') this.checkProgress(this.mineTarget ? this.mineTarget.timeoutMs : 15000);
                    return false;
                }
            }
            job.target = null;
            job.candidates = null;
            this.mineTarget = null;
            this.progressAt = Date.now();
        }
        Client.setKey('leftclick', false);
        job.candidates ??= this.exposedForwardBlocks(direction);
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
        this[obstacleField] = null;
        if (obstacleField === 'forwardObstacle') {
            this.forwardPitch = null;
            this.forwardYaw = null;
        }
        this.mineTarget = null;
        this.progressAt = Date.now();
        return true;
    }

    beginBackward(atBoundary) {
        // A short forward pass can turn directly, whether it ended on time or at bedrock.
        // A threshold of zero disables skipping backward mining entirely.
        if (this.skipBackwardUnder > 0 && this.forwardStart && flatDistance(this.forwardStart) < this.skipBackwardUnder) {
            this.forwardObstacle = null;
            this.forwardBlocked = null;
            this.turnPending = false;
            this.turnGoal = null;
            return this.setState('TURN', 0);
        }
        this.forwardObstacle = null;
        this.breakPoint = position();
        this.breakPoint.y = this.tunnelY;
        this.turnPending = atBoundary;
        this.switchLoadout(this.backwardLoadout, 'BACKWARD');
    }

    mineBackward() {
        const coordinate = this.lane.axis === 'x' ? Player.getX() : Player.getZ();
        const remaining = (coordinate - this.forwardStart[this.lane.axis]) * this.lane.sign;
        if (remaining <= BACKWARD_ARRIVAL_DISTANCE) return this.switchLoadout(this.forwardLoadout, 'RETURN');
        const direction = { ...this.lane, sign: -this.lane.sign };
        // Never scan beyond the return point. Bedrock on the far side of the
        // original start is not an obstacle to this backward pass.
        const scanDistance = Math.max(0, Math.min(BACKWARD_STOP_DISTANCE - Player.getPlayer().getBbWidth() / 2, remaining - BACKWARD_ARRIVAL_DISTANCE));
        const overlapping = this.overlappingChest();
        if (overlapping) return this.openChest(overlapping);
        if (this.backwardObstacle) {
            const blocker = this.blockingAhead(direction, scanDistance);
            if (blocker && !blocker.unknown && isChest(blockName(blocker)) && !this.openedChests.has(key(blocker))) return this.openChest(blocker);
            this.clearForwardObstacles(direction, 'backwardObstacle');
            return;
        }
        if (!this.selectSlot(this.getMiningSlot())) return;
        const obstacle = this.blockingAhead(direction, scanDistance);
        if (obstacle) {
            if (obstacle.unknown) {
                this.stopControls();
                return this.checkProgress(10000);
            }
            const obstacleName = blockName(obstacle);
            if (isChest(obstacleName) && !this.openedChests.has(key(obstacle))) return this.openChest(obstacle);
            if (!this.isForwardTunnelBlock(obstacle)) {
                this.backwardBlocked = null;
                Client.setKey('leftclick', false);
                this.correctingLane = true;
                this.moveAlongLane(direction);
                return this.checkProgress(15000);
            }
            Client.stopMovement();
            Client.setKey('leftclick', false);
            const now = Date.now();
            const obstacleKey = key(obstacle);
            const blocked = this.backwardBlocked;
            if (!blocked || blocked.key !== obstacleKey || blocked.name !== obstacleName || (coordinate - blocked.coordinate) * direction.sign > 0.05) {
                this.backwardBlocked = { key: obstacleKey, name: obstacleName, coordinate, dueAt: now + this.delay(this.actionDelay) };
            } else if (now >= blocked.dueAt) {
                this.backwardBlocked = null;
                // Recheck after the action delay, including bedrock. A one-tick
                // collision or a block beyond the stop point must not cause a lobby hop.
                if (obstacleName === 'minecraft:bedrock') return this.switchLobby('Bedrock blocks backward mining');
                this.backwardObstacle = { target: { ...obstacle, name: obstacleName, aim: null }, candidates: null };
                this.mineTarget = null;
                this.clearForwardObstacles(direction, 'backwardObstacle');
                return;
            }
            return this.checkProgress(15000);
        }
        this.backwardBlocked = null;
        this.aimAt({ yaw: this.backwardYaw, pitch: this.backwardPitch });
        if (Math.abs(wrapTo180(Player.getYaw() - this.backwardYaw)) > 3 || Math.abs(Player.getPitch() - this.backwardPitch) > 2) {
            Client.stopMovement();
            Client.setKey('leftclick', false);
            this.checkProgress(15000);
            return;
        }
        this.moveAlongLane(direction);
        if (!this.holdMiningAttack(getLookingAt(4.5))) return;
        this.checkProgress(this.freeMiningTarget ? this.freeMiningTarget.timeoutMs : 15000);
    }

    turnLane() {
        if (flatDistance(this.turnGoal) <= 0.35) {
            this.lane.sign *= -1;
            this.setLaneStart(position());
            this.turnGoal = null;
            this.turnPending = false;
            return this.setState('FORWARD', 0);
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
        const now = Date.now();
        const duration = this.switchForwardPitch ? this.delay(this.forwardRotationTime) : 0;
        const curveSeed = random(0, Math.PI * 2);
        const pitchFrom = this.rotation?.pitch ?? Player.getPitch();
        const pitchTarget = this.switchForwardPitch ? (head ? random(5, 10) : random(15, 20)) : (this.fixedForwardPitch ??= random(15, 20));
        const yawFrom = this.rotation?.yaw ?? Player.getYaw();
        const yawTarget = this.switchForwardPitch ? this.yaw(this.lane) + random(-3, 3) : (this.fixedForwardYaw ??= this.yaw(this.lane) + random(-3, 3));
        this.forwardPitch = {
            from: pitchFrom,
            target: pitchTarget,
            startedAt: now,
            lastAt: now,
            initialDistance: Math.abs(pitchTarget - pitchFrom),
            duration,
            curveSeed,
            complete: false,
        };
        this.forwardYaw = {
            from: yawFrom,
            target: yawTarget,
            startedAt: now,
            lastAt: now,
            initialDistance: Math.abs(wrapTo180(yawTarget - yawFrom)),
            duration,
            curveSeed,
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
            aim: null,
            nextAimCheckAt: now + 350,
        };
    }

    holdMiningAttack(point, mining = null) {
        const now = Date.now();
        if (!mining) {
            const name = point && blockName(point);
            if (name && !AIR.has(name) && name !== 'minecraft:bedrock' && !isChest(name)) {
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
            if (mining.attemptMs >= mining.retryAfterMs) {
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
        if (Client.getMinecraft().gameMode.isDestroying() || !this.selectSlot(this.getMiningSlot())) return true;
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
        if (!this.selectSlot(this.getMiningSlot())) return;
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
        const aim = aimPoint || mining.aim || { x: point.x + 0.5, y: point.y + 0.5 + wobble, z: point.z + 0.5 };
        this.aimAt(aim, `mine:${mining.key}`);
        const looking = getLookingAt(4.5);
        const onTarget = looking && looking.x === point.x && looking.y === point.y && looking.z === point.z;
        if (!onTarget) {
            // Only ray-trace alternatives after the default aim has settled and missed.
            if (!aimPoint && now >= mining.nextAimCheckAt) {
                const angles = calculateAbsoluteAngles(aim);
                if (Math.abs(wrapTo180(Player.getYaw() - angles.yaw)) < 4 && Math.abs(Player.getPitch() - angles.pitch) < 4) {
                    mining.aim = this.getMiningAim(point);
                    mining.nextAimCheckAt = now + 600;
                }
            }
            Client.setKey('leftclick', false);
            mining.attemptMs = 0;
            mining.lastTick = now;
            return;
        }
        this.holdMiningAttack(point, mining);
    }

    walkTo(point, onStuck) {
        if (flatDistance(point) <= 0.3) {
            this.stopControls();
            return true;
        }
        this.aimAt({ ...point, y: Player.getY() + 1.4 });
        setKeysForStraightLineCoords(point.x, point.y, point.z, false);
        this.checkProgress(15000, onStuck);
        return false;
    }

    checkProgress(timeout, onStuck, tracker = this) {
        if (!tracker.progressPoint || flatDistance(tracker.progressPoint) > 0.2) {
            tracker.progressPoint = position();
            tracker.progressAt = Date.now();
        } else if (Date.now() - tracker.progressAt > timeout) {
            if (onStuck) onStuck();
            else this.switchLobby('Movement or mining stopped making progress');
            return true;
        }
        return false;
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
        if (snapshot.state === 'COOLDOWN' && Date.now() >= this.cooldownUntil) return this.tickCooldown();
        if (snapshot.state === 'LOADOUT') return this.switchLoadout(snapshot.loadout.number, snapshot.loadout.nextState, transitionDelay);
        const loadout = snapshot.state === 'BACKWARD' ? this.backwardLoadout : snapshot.currentLoadout || this.forwardLoadout;
        this.switchLoadout(loadout, snapshot.state, transitionDelay);
    }

    openChest(point) {
        this.chest = {
            point: { ...point },
            resume: this.snapshot(),
            clickedAt: 0,
            overlapClickedAt: 0,
            particleAt: 0,
            opened: false,
            dueAt: 0,
            progressAt: Date.now(),
        };
        this.setState('CHEST', 0);
    }

    tickChest() {
        const chest = this.chest;
        const now = Date.now();
        if (!chest) return this.stop('Missing treasure chest position.');
        if (!isChest(blockName(chest.point))) return this.finishChest();
        if (chest.opened || chest.unavailable) return this.finishChest();
        if (Client.isInGui()) return;
        if (now - this.startedAt > 120000) return this.switchLobby('Treasure chest did not open');
        if (chest.approach) return this.tickChestApproach();
        const overlapping = this.overlappingChest();
        const descentChest = chest.resume.state === 'DESCEND' && Math.floor(Player.getX()) === chest.point.x && Math.floor(Player.getZ()) === chest.point.z;
        if (overlapping && key(overlapping) === key(chest.point) && !descentChest) {
            Client.stopMovement();
            Client.setKey('leftclick', false);
            if (!chest.overlapClickedAt) {
                if (!chest.overlapAim) {
                    const visible = getVisiblePoint(chest.point.x, chest.point.y, chest.point.z);
                    chest.overlapAim = visible
                        ? { x: visible[0], y: visible[1], z: visible[2] }
                        : { x: chest.point.x + 0.5, y: chest.point.y + 0.85, z: chest.point.z + 0.5 };
                }
                this.aimAt(chest.overlapAim, `overlap-chest:${key(chest.point)}`);
                const angles = calculateAbsoluteAngles(chest.overlapAim);
                if (Math.abs(wrapTo180(Player.getYaw() - angles.yaw)) > 3 || Math.abs(Player.getPitch() - angles.pitch) > 3) return;
                Client.rightClick();
                chest.clickedAt = now;
                chest.overlapClickedAt = now;
                chest.progressAt = now;
            }
            if (now - chest.overlapClickedAt < CHEST_OVERLAP_CONFIRM_MS) return;
            return this.approachChest(chest.point);
        }
        if (now - chest.progressAt > Math.max(25000, this.mineTarget ? this.mineTarget.timeoutMs : 0))
            return this.switchLobby('Treasure chest stopped making progress');
        const player = Player.getPlayer();
        const eye = player.getEyePosition();
        const particle = chest.particle && now - chest.particleAt < 2000;
        let aim = particle
            ? chest.particle
            : {
                  x: chest.point.x + 0.5,
                  y: chest.point.y + (descentChest ? 0.85 : 0.5),
                  z: chest.point.z + 0.5,
              };
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
        if (descentChest && obstacleKey !== key(chest.point)) {
            // A chest generated inside the player has no walking route from the
            // one-block lava shaft. Try its upper face; rise above it if needed.
            Client.stopMovement();
            Client.setKey('leftclick', false);
            Client.setKey('space', Player.getY() < chest.point.y + 1.05);
            this.aimAt({ x: chest.point.x + 0.5, y: chest.point.y + 0.85, z: chest.point.z + 0.5 }, `shaft-chest:${key(chest.point)}`);
            return;
        }
        Client.setKey('space', false);
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
        if (escapingChest && chest.resume.state === 'DESCEND') {
            chest.approach = null;
            chest.progressAt = now;
            return;
        }
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
        if (chest.opened || chest.unavailable) this.openedChests.add(key(chest.point));
        this.chest = null;
        this.restore(chest.resume, 0);
    }

    interruptForWorm() {
        if (!this.enabled) return;
        const state = this.state === 'LOADOUT' ? this.loadoutRequest?.nextState : this.state;
        if (state === 'WAIT_WORM' || state === 'WORM') return;
        const goblinActive = state === 'WAIT_GOBLIN' || state === 'GOBLIN';
        if (!MINING_STATES.has(state) && state !== 'COOLDOWN' && state !== 'RESUME_PATH' && !goblinActive) return;
        if (this.refueling) {
            this.refueling.wormPending = true;
            return;
        }
        if (goblinActive && !this.goblinResume) return this.stop('Missing goblin resume state.');
        const miningState = goblinActive ? (this.goblinResume.state === 'LOADOUT' ? this.goblinResume.loadout?.nextState : this.goblinResume.state) : state;
        const interruptedState = miningState === 'CHEST' ? this.chest?.resume.state : miningState;
        const recovery = this.recovery;
        const resumingCombat =
            this.combatResume &&
            (state === 'COOLDOWN' ||
                state === 'RESUME_PATH' ||
                (interruptedState === 'RECOVERY_HEIGHT' &&
                    recovery &&
                    (['COOLDOWN', 'COMBAT_RESUME'].includes(recovery.after) || (recovery.snapshot && recovery.snapshot.state === 'COOLDOWN'))));
        if (!resumingCombat) {
            this.combatResume = goblinActive ? this.goblinResume : state === 'RESUME_PATH' ? this.returnJob?.snapshot : this.snapshot();
            if (!this.combatResume) return;
            const pillar = recovery && recovery.pillar;
            if (pillar) this.combatResume.point.y = pillar.y;
        }
        this.wormOrigin = position();
        this.wormSearch = this.createTunnelSearch(this.wormOrigin, interruptedState);
        if (goblinActive) this.resetGoblin();
        this.wormWarningAt = Date.now();
        this.cooldownUntil = this.wormWarningAt + randomInt(25000, 35000);
        OverlayManager.incrementTrackedValue(this.oid, 'wormSpawns');
        this.wormLastSeenAt = 0;
        this.wormLastStandPosition = null;
        this.wormTargetUuid = null;
        this.wormTargetFromMotion = false;
        this.wormConfirmation = null;
        this.wormCandidates.clear();
        this.wormNametags.clear();
        this.wormDebugScan = null;
        this.wormDebugLastAt = 0;
        this.wormDebugLastEvent = null;
        this.wormDebugNearbyAt = 0;
        if (this.state === 'LOADOUT') {
            this.currentLoadout = null;
            closeInventory();
        }
        this.switchLoadout(this.combatLoadout, 'WAIT_WORM', 0);
        this.message('&eWorm warning received. Mining paused; preparing combat and waiting for the spawn.');
    }

    createTunnelSearch(origin, state) {
        const interruptedState = state === 'CHEST' ? this.chest?.resume.state : state;
        const direction = interruptedState === 'TURN' && this.lane ? this.turnDirection() : this.lane;
        const axis = direction?.axis || 'z';
        const crossAxis = axis === 'x' ? 'z' : 'x';
        const crossOrigin = interruptedState === 'TURN' ? this.turnOrigin : this.laneStart;
        return {
            axis,
            crossAxis,
            along: origin[axis],
            cross: crossOrigin?.[crossAxis] ?? Math.floor(origin[crossAxis]) + 0.5,
            minY: this.tunnelY - 1,
            maxY: this.tunnelY + 3,
        };
    }

    inTunnelSearchBounds(point, search) {
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
                this.inTunnelSearchBounds({ x: entity.getX(), y: entity.getY(), z: entity.getZ() }, this.wormSearch) &&
                CombatBot.isCombatTargetCandidate(entity, true, true, true) &&
                entity.getStackInSlot(5)?.type?.getRegistryName() === 'minecraft:player_head'
            );
        } catch (error) {
            return false;
        }
    }

    findMovingWormHead(segments, now, debug = null) {
        const search = this.wormSearch;
        const coordinates = new Map();
        for (const [uuid, segment] of segments) coordinates.set(uuid, search.axis === 'x' ? segment.getX() : segment.getZ());
        const sample = search.motionSample;
        const sampleAge = sample ? now - sample.seenAt : null;
        if (!segments.size || !sample || sampleAge > WORM_SEGMENT_GRACE_MS) {
            search.motionPreviousSample = null;
            search.motionSample = segments.size ? { coordinates, seenAt: now } : null;
        } else if (sampleAge >= WORM_CONFIRM_DELAY_MS) {
            search.motionPreviousSample = sample;
            search.motionSample = { coordinates, seenAt: now };
        }
        const previous = search.motionPreviousSample;
        const motion = debug
            ? (debug.motion = {
                  ageMs: now - (previous?.seenAt ?? search.motionSample?.seenAt ?? now),
                  status: !segments.size ? 'no-segments' : !previous ? 'sampling' : 'no-moving-segments',
                  direction: 0,
                  newSegments: 0,
                  stationary: 0,
                  positive: 0,
                  negative: 0,
                  headUuid: null,
                  segments: new Map(),
              })
            : null;

        let direction = 0;
        let head = null;
        let headUuid = null;
        let front = 0;
        let conflicting = false;
        for (const [uuid, segment] of segments) {
            const coordinate = coordinates.get(uuid);
            const before = previous ? previous.coordinates.get(uuid) : undefined;
            const delta = before === undefined ? null : coordinate - before;
            const sign = delta !== null && Math.abs(delta) >= WORM_MOTION_MIN_DISTANCE ? Math.sign(delta) : 0;
            const status = !previous ? 'sampling' : before === undefined ? 'new-segment' : sign ? 'moving' : 'stationary';
            if (motion) {
                motion.segments.set(uuid, { coordinate, before, delta, sign, status });
                if (status === 'new-segment') motion.newSegments++;
                if (status === 'stationary') motion.stationary++;
                if (sign > 0) motion.positive++;
                if (sign < 0) motion.negative++;
            }
            if (!sign) continue;
            if (direction && sign !== direction) conflicting = true;
            if (!direction) direction = sign;
            if (sign !== direction) continue;
            if (!head || (coordinate - front) * direction > 0) {
                head = segment;
                headUuid = uuid;
                front = coordinate;
            }
        }
        if (conflicting) head = null;
        if (motion) {
            motion.direction = conflicting ? 0 : direction;
            motion.headUuid = head ? headUuid : null;
            if (previous)
                motion.status = conflicting
                    ? 'conflicting-directions'
                    : head
                      ? 'selected'
                      : motion.newSegments === segments.size
                        ? 'no-shared-segments'
                        : 'no-moving-segments';
        }
        return head;
    }

    findWormTargets(requireFresh = false) {
        if (!this.wormSearch) return [];

        const now = Date.now();
        const available = new Map();
        const freshSegments = new Map();
        const freshNametags = new Map();
        const updatedCandidates = new Map();
        let nearestApproachPoint = null;
        let nearestApproachDistance = Infinity;
        let nearestStandPoint = null;
        let nearestStandDistance = Infinity;
        const debug =
            this.wormDebug && this.state === 'WAIT_WORM'
                ? { scanned: 0, inBounds: 0, withinTwoBlocks: 0, closestSq: Infinity, pairErrors: 0, headPoints: [] }
                : null;
        for (const stand of World.getAllEntitiesOfType(ArmorStandEntity)) {
            if (debug) debug.scanned++;
            if (!this.inTunnelSearchBounds({ x: stand.getX(), y: stand.getY(), z: stand.getZ() }, this.wormSearch)) continue;
            if (debug) debug.inBounds++;
            const uuid = CombatBot.getTargetUuid(stand);
            if (!uuid) continue;

            if (/(?:^|[^a-z])(?:Scatha|Stoneworm)(?![a-z])/i.test(cleanChat(stand.getName()))) {
                // A visible worm nametag means combat is still in progress even
                // if its player-head stand is temporarily missing.
                this.wormLastSeenAt = now;
                const marker = {
                    point: { x: stand.getX(), y: stand.getY(), z: stand.getZ() },
                    seenAt: now,
                };
                this.wormNametags.set(uuid, marker);
                freshNametags.set(uuid, marker);
            }

            if (!this.isWormSegment(stand)) continue;
            available.set(uuid, stand);
            freshSegments.set(uuid, stand);
            updatedCandidates.set(uuid, { target: stand, seenAt: now });

            // Remember actual coordinates separately from entity wrappers:
            // unloaded stands must not erase the last place we saw one.
            const point = { x: stand.getX(), y: stand.getY(), z: stand.getZ() };
            if (debug) debug.headPoints.push(point);
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
        const movingHead = this.findMovingWormHead(freshSegments, now, debug);

        let nearest = null;
        let nearestDistanceSq = Infinity;
        const maxDistanceSq = WORM_NAMETAG_HEAD_MAX_DISTANCE ** 2;
        for (const marker of (requireFresh ? freshNametags : this.wormNametags).values()) {
            const point = new Vec3d(marker.point.x, marker.point.y, marker.point.z);
            for (const segment of (requireFresh ? freshSegments : available).values()) {
                try {
                    const distanceSq = segment.toMC().getBoundingBox().distanceToSqr(point);
                    if (debug) {
                        debug.closestSq = Math.min(debug.closestSq, distanceSq);
                        if (distanceSq <= maxDistanceSq) debug.withinTwoBlocks++;
                    }
                    if (distanceSq > maxDistanceSq || distanceSq >= nearestDistanceSq) continue;
                    nearestDistanceSq = distanceSq;
                    nearest = segment;
                } catch (error) {
                    // The stand may unload while matching entities.
                    if (debug) debug.pairErrors++;
                }
            }
        }
        if (!freshNametags.size) nearest = movingHead;
        this.wormSearch.targetFromMotion = !!nearest && !freshNametags.size;
        if (debug) {
            this.wormDebugScan = {
                ...debug,
                fresh: requireFresh,
                heads: freshSegments.size,
                nametags: freshNametags.size,
                cachedHeads: available.size,
                cachedNametags: this.wormNametags.size,
                source: freshNametags.size ? 'nametag' : 'motion',
                matchedUuid: nearest ? CombatBot.getTargetUuid(nearest) : null,
            };
        }
        if (nearest) this.wormLastSeenAt = now;
        return nearest ? [nearest] : [];
    }

    reportWormDebug(now, stage, expectedUuid = null, observedUuid = null) {
        if (!this.wormDebug || this.state !== 'WAIT_WORM' || !this.wormDebugScan) return;
        const scan = this.wormDebugScan;
        let reason = '';
        if (stage === 'verify-failed') {
            if (!scan.heads) reason = 'no fresh player-head stand';
            else if (!scan.nametags && !observedUuid) reason = 'motion ' + (scan.motion?.status || 'unavailable');
            else if (scan.nametags && !scan.withinTwoBlocks)
                reason = scan.pairErrors ? 'no pair within 2 blocks (bounding-box check errors)' : 'nametag/head distance exceeds 2 blocks';
            else if (!observedUuid) reason = 'no selected target UUID';
            else if (observedUuid !== expectedUuid) reason = 'head UUID changed';
            else reason = 'second confirmation unsuccessful';
        }
        const event = `${stage}:${reason}:${expectedUuid || ''}:${observedUuid || ''}`;
        if (stage === 'waiting') {
            if (now - this.wormDebugLastAt < WORM_DEBUG_INTERVAL_MS) return;
        } else if (event === this.wormDebugLastEvent && now - this.wormDebugLastAt < WORM_DEBUG_INTERVAL_MS) {
            return;
        }
        this.wormDebugLastAt = now;
        this.wormDebugLastEvent = event;

        const shortId = (uuid) => (uuid ? String(uuid).slice(0, 8) : '-');
        const closest = Number.isFinite(scan.closestSq) ? Math.sqrt(scan.closestSq).toFixed(2) : '-';
        const goal = this.wormLastStandPosition;
        const distance = goal && this.wormSearch ? Math.abs(goal[this.wormSearch.axis] - position()[this.wormSearch.axis]).toFixed(1) : '-';
        const reasonSuffix = reason ? ' reason=' + reason : '';
        const motion = scan.motion;
        const motionSuffix =
            !scan.nametags && motion
                ? ` motion=${motion.status} sample=${motion.ageMs}ms ` +
                  `dir=${motion.direction ? (motion.direction > 0 ? '+' : '-') + this.wormSearch.axis : '-'} ` +
                  `moving=+${motion.positive}/-${motion.negative} still=${motion.stationary} new=${motion.newSegments}`
                : '';
        this.message(
            `&8[Worm Debug] &7${stage} ${scan.fresh ? '[fresh]' : '[cached]'} ` +
                `stands=${scan.scanned}/${scan.inBounds} heads=${scan.heads}/${scan.cachedHeads} ` +
                `source=${scan.source} ` +
                `tags=${scan.nametags}/${scan.cachedNametags} pairs<=2=${scan.withinTwoBlocks} ` +
                `nearest=${closest} match=${shortId(scan.matchedUuid)} ` +
                `expected=${shortId(expectedUuid)} actual=${shortId(observedUuid)} ` +
                `approach=${distance}${motionSuffix}${reasonSuffix}`
        );
    }

    // Read TextDisplay's server-synced text rather than its ordinary entity name.
    // getText() and DATA_TEXT_ID are private in Minecraft's TextDisplay class.
    getWormDebugTextDisplay(mc) {
        try {
            const field = mc.getClass().getDeclaredField('DATA_TEXT_ID');
            field.setAccessible(true);
            const accessor = field.get(null);
            const component = mc.getEntityData().get(accessor);
            return { text: component ? String(component.getString()) : '<null>', source: 'synced-data' };
        } catch (fieldError) {
            try {
                const methods = mc.getClass().getDeclaredMethods();
                for (const method of methods) {
                    if (String(method.getName()) !== 'getText' || method.getParameterCount() !== 0) continue;
                    method.setAccessible(true);
                    const component = method.invoke(mc);
                    return { text: component ? String(component.getString()) : '<null>', source: 'getText' };
                }
                return { text: null, source: 'unavailable: ' + String(fieldError) };
            } catch (methodError) {
                return {
                    text: null,
                    source: 'failed synced-data: ' + String(fieldError) + '; getText: ' + String(methodError),
                };
            }
        }
    }

    // Diagnostic only: inspect server-backed entity names and displays near a head,
    // without applying the tunnel bounds used by the real Worm detector.
    reportWormNearbyEntities(now) {
        if (!this.wormDebug || this.state !== 'WAIT_WORM') return;
        const scan = this.wormDebugScan;
        if (!scan || !scan.heads || scan.nametags || !scan.headPoints?.length) return;
        if (this.wormDebugNearbyAt && now - this.wormDebugNearbyAt < WORM_DEBUG_NEARBY_INTERVAL_MS) return;
        this.wormDebugNearbyAt = now;

        const search = this.wormSearch;
        if (!search) return;
        const format = (value) =>
            JSON.stringify(String(value))
                .replace(/&/g, String.fromCharCode(92) + 'u0026')
                .replace(/§/g, String.fromCharCode(92) + 'u00a7');
        const boundFailures = (point) => {
            const failures = [];
            const along = Math.abs(point[search.axis] - search.along);
            const cross = Math.abs(point[search.crossAxis] - search.cross);
            if (along > WORM_TUNNEL_HALF_LENGTH) failures.push(search.axis + ':' + along.toFixed(2) + '>' + WORM_TUNNEL_HALF_LENGTH);
            if (cross > WORM_TUNNEL_HALF_WIDTH) failures.push(search.crossAxis + ':' + cross.toFixed(2) + '>' + WORM_TUNNEL_HALF_WIDTH);
            if (point.y < search.minY) failures.push('y:' + point.y.toFixed(2) + '<' + search.minY);
            if (point.y > search.maxY) failures.push('y:' + point.y.toFixed(2) + '>' + search.maxY);
            return failures.length ? failures.join(',') : 'inside';
        };

        const nearby = [];
        let errors = 0;
        for (const entity of World.getAllEntities()) {
            try {
                const point = { x: entity.getX(), y: entity.getY(), z: entity.getZ() };
                let distanceSq = Infinity;
                for (const head of scan.headPoints) {
                    distanceSq = Math.min(distanceSq, (point.x - head.x) ** 2 + (point.y - head.y) ** 2 + (point.z - head.z) ** 2);
                }
                if (distanceSq > WORM_DEBUG_NEARBY_RADIUS ** 2) continue;

                const name = String(entity.getName());
                let componentText;
                try {
                    const component = entity.getNameComponent();
                    componentText = component ? String(component.getUnformattedText()) : '<null>';
                } catch (error) {
                    componentText = '<error: ' + String(error) + '>';
                }
                const mc = entity.toMC();
                const type = String(entity.getClassName());
                const uuid = CombatBot.getTargetUuid(entity) || '-';
                const getComponentText = (component) => (component ? String(component.getString()) : '<null>');
                let displayName = '<unavailable>';
                let customName = '<unavailable>';
                let customVisible = '<unavailable>';
                let scoreboardName = '<unavailable>';
                try {
                    displayName = getComponentText(mc.getDisplayName());
                } catch (error) {
                    displayName = '<error: ' + String(error) + '>';
                }
                try {
                    customName = getComponentText(mc.getCustomName());
                } catch (error) {
                    customName = '<error: ' + String(error) + '>';
                }
                try {
                    customVisible = String(mc.isCustomNameVisible());
                } catch (error) {
                    customVisible = '<error: ' + String(error) + '>';
                }
                try {
                    scoreboardName = String(mc.getScoreboardName());
                } catch (error) {
                    scoreboardName = '<error: ' + String(error) + '>';
                }
                const isTextDisplay = type.indexOf('TextDisplay') >= 0;
                const displayText = isTextDisplay ? this.getWormDebugTextDisplay(mc) : null;
                const wormName = /(?:^|[^a-z])(?:Scatha|Stoneworm)(?![a-z])/i;
                const isWormName = [name, componentText, displayName, customName, displayText?.text].some((text) => text && wormName.test(cleanChat(text)));
                const isStand = mc instanceof ArmorStandEntity;
                const bounds = boundFailures(point);
                const motion = scan.motion ? scan.motion.segments.get(uuid) : null;
                const combatCandidate = isStand && CombatBot.isCombatTargetCandidate(entity, true, true, true);
                let helmet = '-';
                if (isStand) {
                    try {
                        helmet = String(entity.getStackInSlot(5)?.type?.getRegistryName() || '<empty>');
                    } catch (error) {
                        helmet = '<error: ' + String(error) + '>';
                    }
                }
                const segmentStatus = motion
                    ? 'included'
                    : !isStand
                      ? 'not-armor-stand'
                      : uuid === '-'
                        ? 'no-uuid'
                        : bounds !== 'inside'
                          ? 'out-of-bounds'
                          : !combatCandidate
                            ? 'not-combat-candidate'
                            : helmet !== 'minecraft:player_head'
                              ? 'no-player-head'
                              : 'not-in-motion-scan';
                nearby.push({
                    point,
                    distance: Math.sqrt(distanceSq),
                    type,
                    uuid,
                    name,
                    componentText,
                    displayName,
                    customName,
                    customVisible,
                    scoreboardName,
                    displayText,
                    bounds,
                    helmet,
                    combatCandidate,
                    segmentStatus,
                    motion,
                    rank: isWormName ? 0 : isTextDisplay ? 1 : uuid === scan.motion?.headUuid ? 2 : motion ? 3 : isStand ? 4 : 5,
                });
            } catch (error) {
                errors++;
            }
        }
        nearby.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
        this.message(
            '&8[Worm Debug] &7Nearby head scan (8 blocks, no tunnel bounds): ' +
                nearby.length +
                ' entities, showing ' +
                Math.min(nearby.length, WORM_DEBUG_NEARBY_MAX_ENTITIES) +
                ' axis=' +
                search.axis +
                ' motion=' +
                scan.motion?.status +
                ' sample=' +
                scan.motion?.ageMs +
                'ms min_delta=' +
                WORM_MOTION_MIN_DISTANCE +
                ' head=' +
                (scan.motion?.headUuid || '-') +
                (errors ? ', errors=' + errors : '')
        );
        const count = Math.min(nearby.length, WORM_DEBUG_NEARBY_MAX_ENTITIES);
        for (let i = 0; i < count; i++) {
            const entity = nearby[i];
            const point = entity.point;
            this.message(
                '&8[Worm Debug] &7#' +
                    (i + 1) +
                    ' type=' +
                    entity.type +
                    ' uuid=' +
                    entity.uuid +
                    ' pos=(' +
                    point.x.toFixed(2) +
                    ',' +
                    point.y.toFixed(2) +
                    ',' +
                    point.z.toFixed(2) +
                    ')' +
                    ' dist=' +
                    entity.distance.toFixed(2) +
                    ' bounds=' +
                    entity.bounds +
                    ' helmet=' +
                    format(entity.helmet) +
                    ' combat=' +
                    entity.combatCandidate +
                    ' segment=' +
                    entity.segmentStatus +
                    (entity.motion
                        ? ' motion=' +
                          entity.motion.status +
                          ' axis_pos=' +
                          entity.motion.coordinate.toFixed(4) +
                          ' prev=' +
                          (entity.motion.before === undefined ? '-' : entity.motion.before.toFixed(4)) +
                          ' delta=' +
                          (entity.motion.delta === null ? '-' : entity.motion.delta.toFixed(4)) +
                          ' dir=' +
                          (entity.motion.sign ? (entity.motion.sign > 0 ? '+' : '-') + search.axis : '-') +
                          ' selected=' +
                          (entity.uuid === scan.motion.headUuid)
                        : '') +
                    ' name=' +
                    format(entity.name) +
                    ' component=' +
                    format(entity.componentText) +
                    ' display=' +
                    format(entity.displayName) +
                    ' custom=' +
                    format(entity.customName) +
                    ' visible=' +
                    entity.customVisible +
                    ' scoreboard=' +
                    format(entity.scoreboardName) +
                    (entity.displayText ? ' text_display=' + format(entity.displayText.text) + ' text_source=' + format(entity.displayText.source) : '')
            );
        }
    }

    approachLastWormPosition() {
        const search = this.wormSearch;
        const goal = this.wormLastStandPosition;
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        if (!search || !goal || !this.inTunnelSearchBounds(goal, search) || !this.lane || !this.selectSlot(this.attackSlot)) return Client.stopMovement();

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

        const now = Date.now();
        const verifying = !!this.wormConfirmation && now - this.wormConfirmation.startedAt >= WORM_CONFIRM_DELAY_MS;
        const targets = this.findWormTargets(verifying);
        const target = targets[0] || null;
        const uuid = target ? CombatBot.getTargetUuid(target) : null;

        if (verifying) {
            if (uuid && uuid === this.wormConfirmation.uuid) {
                this.reportWormDebug(now, 'verified', this.wormConfirmation.uuid, uuid);
                this.wormTargetUuid = uuid;
                this.wormTargetFromMotion = this.wormSearch.targetFromMotion;
                this.wormTargets = [target];
                this.wormConfirmation = null;
                this.setState('WORM', 0);
                this.message('&aWorm confirmed. Starting combat.');
                return this.fightWorm();
            }
            // Restart the 500 ms check for a new head, or wait until one returns.
            this.reportWormDebug(now, 'verify-failed', this.wormConfirmation.uuid, uuid);
            this.wormConfirmation = uuid ? { uuid, startedAt: now } : null;
        } else if (!this.wormConfirmation && uuid) {
            this.wormConfirmation = { uuid, startedAt: now };
            this.reportWormDebug(now, 'first-match', uuid, uuid);
        }
        this.reportWormDebug(now, 'waiting', this.wormConfirmation?.uuid || null, uuid);
        this.reportWormNearbyEntities(now);

        if (now - this.wormWarningAt >= WORM_SPAWN_TIMEOUT_MS) return this.switchLobby('No Stoneworm or Scatha appeared within 60 seconds');
        // Approach the latest observed head while confirmation is pending or
        // its nametag is hidden. Movement never waits for a second sample.
        return this.approachLastWormPosition();
    }

    findLockedWormTarget() {
        const uuid = this.wormTargetUuid;
        if (!uuid) return null;

        // The nametag and player-head equipment are needed only for initial
        // detection. Follow the same armor stand by UUID during combat.
        const loaded = World.getAllEntitiesOfType(ArmorStandEntity).find((entity) => CombatBot.getTargetUuid(entity) === uuid);
        const target = loaded || this.wormTargets.find((entity) => CombatBot.getTargetUuid(entity) === uuid);
        return target && CombatBot.isCombatTargetCandidate(target, true, true, true) ? target : null;
    }

    fightWorm() {
        const now = Date.now();
        if (!this.combatResume) return this.stop('Missing combat return position.');
        if (now - this.startedAt > 120000) return this.switchLobby('Worm combat timed out');
        if (this.wormTargetFromMotion) {
            const targets = this.findWormTargets(true);
            if (targets.length && !this.wormSearch.targetFromMotion) {
                this.wormTargetUuid = CombatBot.getTargetUuid(targets[0]);
                this.wormTargets = targets;
                this.wormTargetFromMotion = false;
            }
        }
        if (!Pathfinder.isPathing() && !this.selectSlot(this.attackSlot)) return;
        const target = this.findLockedWormTarget();
        if (target) {
            this.wormTargets = [target];
            this.wormLastSeenAt = now;
            this.wormLastStandPosition = { x: target.getX(), y: target.getY(), z: target.getZ() };
            this.wormMissingAt = 0;
            CombatBot.setExternalTargets([target], WORM_COMBAT_OPTIONS);
            if (!this.ownsCombat) {
                this.ownsCombat = true;
                CombatBot.toggle(true, true);
            }
            return;
        }
        // If the locked entity unloads or dies, approach its last position
        // during the five-second grace period. Nametag changes do not lose the target.
        if (this.ownsCombat) this.stopActivities();
        if (!this.wormMissingAt) this.wormMissingAt = now;
        if (now - Math.max(this.wormMissingAt, this.wormLastSeenAt) < WORM_DISAPPEAR_GRACE_MS) {
            return this.approachLastWormPosition();
        }
        const cooldownPending = now < this.cooldownUntil;
        this.waitBeforeReturn = Math.random() < 0.5;
        if (this.waitBeforeReturn && cooldownPending) this.setState('COOLDOWN', 0);
        else this.returnToSnapshot(this.combatResume, cooldownPending && !this.waitBeforeReturn ? 'COOLDOWN' : 'COMBAT_RESUME');
    }

    tickCooldown() {
        if (Date.now() < this.cooldownUntil) return;
        if (this.waitBeforeReturn) this.returnToSnapshot(this.combatResume, 'COMBAT_RESUME');
        else this.finishCombat();
    }

    finishCombat() {
        const snapshot = this.combatResume;
        this.combatResume = null;
        this.cooldownUntil = 0;
        this.wormSearch = null;
        this.wormLastStandPosition = null;
        this.wormTargetUuid = null;
        this.wormTargetFromMotion = false;
        this.wormConfirmation = null;
        this.wormTargets = [];
        this.wormCandidates.clear();
        this.wormNametags.clear();
        this.restore(snapshot);
    }

    returnToSnapshot(snapshot, after) {
        let state = snapshot.state === 'LOADOUT' ? snapshot.loadout?.nextState : snapshot.state;
        if (state === 'CHEST') state = snapshot.chestContext?.resume.state;
        const direction = state === 'TURN' && this.lane ? this.turnDirection() : this.lane;
        const origin = state === 'TURN' ? this.turnOrigin : this.laneStart;
        const crossAxis = direction?.axis === 'x' ? 'z' : 'x';
        const tunnel = direction
            ? {
                  axis: direction.axis,
                  crossAxis,
                  cross: origin?.[crossAxis] ?? Math.floor(snapshot.point[crossAxis]) + 0.5,
              }
            : null;
        this.returnJob = { snapshot, after, tunnel, startedAt: Date.now(), result: null, alignmentAttempted: false, alignment: null };
        this.setState('RESUME_PATH', after === 'RETURN_RESUME' ? 0 : this.actionDelay);
    }

    startReturnPath() {
        const job = this.returnJob;
        if (!job) return this.stop('Missing return path.');
        const point = job.snapshot.point;
        if (flatDistance(point) < 0.6 && Math.abs(Player.getY() - point.y) < 0.25) {
            job.result = true;
            return;
        }
        if (!job.alignmentAttempted) {
            job.alignmentAttempted = true;
            job.alignment = this.createTunnelReturnAlignment(point, job.tunnel);
            if (job.alignment) return;
        }
        this.startPath([[Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z)]], job);
    }

    createTunnelReturnAlignment(returnPoint, tunnel) {
        const here = position();
        if (!tunnel || !Player.getPlayer().onGround() || Math.abs(returnPoint.y - this.tunnelY) > 0.25) return null;

        const axis = tunnel.crossAxis;
        const delta = tunnel.cross - here[axis];
        if (Math.abs(delta) > TUNNEL_RETURN_ALIGN_MAX_DISTANCE) return null;
        const goal = { ...here };
        goal[axis] = tunnel.cross;
        const alignment = { point: goal, startedAt: Date.now() };
        // Already within the normal mining corridor's no-correction range:
        // turn toward the return point without moving to the exact center.
        if (this.inLaneRange(here[axis], tunnel.cross)) return alignment;

        const direction = { axis, sign: Math.sign(delta) };
        const laneBlock = Math.floor(tunnel.cross);
        const nearestEdge = direction.sign > 0 ? laneBlock + LANE_CORRECTION_MIN : laneBlock + LANE_CORRECTION_MAX;
        const travel = Math.abs(nearestEdge - here[axis]);
        const world = World.getWorld();
        // Check only as far as the nearest point inside the no-correction
        // range, not all the way to the center of the tunnel.
        for (let step = 0; step <= travel + 0.5; step += 0.5) {
            const test = this.offset(here, direction, Math.min(step, travel));
            const floor = new BP(Math.floor(test.x), Math.floor(test.y) - 1, Math.floor(test.z));
            if (!this.passable(test) || !this.passable({ ...test, y: test.y + 1 }) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP))
                return null;
        }
        if (this.blockingAhead(direction, travel)) return null;
        return alignment;
    }

    tickTunnelReturnAlignment(job) {
        const alignment = job.alignment;
        const now = Date.now();
        const distance = flatDistance(alignment.point);
        if (
            now - alignment.startedAt > TUNNEL_RETURN_ALIGN_TIMEOUT_MS ||
            !Player.getPlayer().onGround() ||
            Math.abs(Player.getY() - alignment.point.y) > 0.25
        ) {
            return this.fallbackTunnelReturnPath(job);
        }
        const axis = job.tunnel.crossAxis;
        if (!this.inLaneRange(position()[axis], job.tunnel.cross)) {
            const direction = { axis, sign: Math.sign(alignment.point[axis] - position()[axis]) };
            if (direction.sign === 0 || this.blockingAhead(direction, Math.min(distance, 0.8))) return this.fallbackTunnelReturnPath(job);
            if (this.checkProgress(1500, () => this.fallbackTunnelReturnPath(job), alignment)) return;
            Client.setKey('leftclick', false);
            setKeysForStraightLineCoords(alignment.point.x, alignment.point.y, alignment.point.z, false);
            return;
        }
        Client.stopMovement();
        const point = job.snapshot.point;
        const returnAxis = job.tunnel.axis;
        const delta = point[returnAxis] - position()[returnAxis];
        if (Math.abs(delta) <= BACKWARD_ARRIVAL_DISTANCE) {
            job.alignment = null;
            job.result = true;
            return;
        }
        const target = calculateAbsoluteAngles({ ...job.snapshot.point, y: Player.getY() + 1.4 });
        // Match the +/-3 degree yaw variation used by forward/backward mining.
        // Keep one offset per alignment so the target does not jitter each tick.
        alignment.faceYaw ??= target.yaw + random(-3, 3);
        this.aimAt({ yaw: alignment.faceYaw, pitch: 0 }, 'return:face');
        if (
            this.rotation.motion?.targetId !== 'return:face' ||
            !this.rotation.motion.complete ||
            Math.abs(wrapTo180(Player.getYaw() - alignment.faceYaw)) > 3 ||
            Math.abs(Player.getPitch()) > 3
        )
            return;
        job.alignment = null;
        job.directReturn = {
            yaw: alignment.faceYaw,
            direction: { axis: returnAxis, sign: Math.sign(delta) },
            startedAt: now,
        };
    }

    tickDirectTunnelReturn(job) {
        const direct = job.directReturn;
        const point = job.snapshot.point;
        const now = Date.now();
        const axis = direct.direction.axis;
        const remaining = (point[axis] - position()[axis]) * direct.direction.sign;
        const crossAxis = job.tunnel.crossAxis;
        const inTunnel = this.inLaneRange(position()[crossAxis], job.tunnel.cross);

        if (inTunnel && remaining <= BACKWARD_ARRIVAL_DISTANCE && Math.abs(Player.getY() - point.y) <= 0.25) {
            Client.stopMovement();
            job.directReturn = null;
            job.result = true;
            return;
        }
        if (
            now - direct.startedAt > TUNNEL_DIRECT_RETURN_TIMEOUT_MS ||
            !Player.getPlayer().onGround() ||
            Math.abs(Player.getY() - point.y) > 0.25 ||
            !inTunnel ||
            this.blockingAhead(direct.direction, Math.min(0.6, Math.max(0, remaining)))
        ) {
            return this.fallbackTunnelReturnPath(job);
        }

        // Avoid moving into unloaded blocks, obstacles, or missing floor.
        const next = this.offset(position(), direct.direction, Math.min(0.6, remaining));
        const floor = new BP(Math.floor(next.x), Math.floor(this.tunnelY) - 1, Math.floor(next.z));
        const world = World.getWorld();
        if (!this.passable(next) || !this.passable({ ...next, y: this.tunnelY + 1 }) || !world.getBlockState(floor).isFaceSturdy(world, floor, Direction.UP)) {
            return this.fallbackTunnelReturnPath(job);
        }
        if (this.checkProgress(TUNNEL_DIRECT_RETURN_STALL_MS, () => this.fallbackTunnelReturnPath(job), direct)) return;

        // Keep the single +/-3 degree yaw chosen during alignment, and press
        // W directly instead of asking Pathfinder to navigate the tunnel.
        this.aimAt({ yaw: direct.yaw, pitch: 0 }, 'return:face');
        Client.setKey('leftclick', false);
        Client.setKey('a', false);
        Client.setKey('d', false);
        Client.setKey('s', false);
        Client.setKey('space', false);
        Client.setKey('shift', false);
        Client.setKey('sprint', false);
        const facing = Math.abs(wrapTo180(Player.getYaw() - direct.yaw)) <= 3 && Math.abs(Player.getPitch()) <= 3;
        Client.setKey('w', facing);
        if (facing && job.after === 'RETURN_RESUME') this.tryReturnTeleport(job);
    }

    tryReturnTeleport(job) {
        const slot = Aote.findAoteSlot();
        if (slot === null || !Aote.hasEnoughMana()) return;
        const now = Date.now();
        const direct = job.directReturn;
        if (this.returnOriginalSlot === null) this.returnOriginalSlot = Player.getHeldItemIndex();
        if (!this.selectSlot(slot + 1)) {
            direct.teleportDueAt = now + this.delay(this.clickDelay);
            return;
        }
        direct.teleportDueAt ??= now + this.delay(this.clickDelay);
        if (now < direct.teleportDueAt) return;
        Client.rightClick();
        direct.teleportDueAt = now + Math.max(1000, this.delay(this.clickDelay));
    }

    fallbackTunnelReturnPath(job) {
        this.stopActivities();
        job.alignmentAttempted = true;
        job.alignment = null;
        job.directReturn = null;
        this.progressPoint = null;
        const point = job.snapshot.point;
        this.startPath([[Math.floor(point.x), Math.floor(point.y) - 1, Math.floor(point.z)]], job);
    }

    tickReturnPath() {
        const job = this.returnJob;
        const point = job.snapshot.point;
        if (flatDistance(point) < 0.6 && Math.abs(Player.getY() - point.y) < 0.25) {
            job.alignment = null;
            job.directReturn = null;
            job.result = true;
        }
        if (job.result !== true) {
            if (Date.now() - job.startedAt >= RETURN_TIMEOUT_MS) return this.switchLobby('Return timed out after 120 seconds');
            if (this.checkProgress(RETURN_STALL_TIMEOUT_MS, () => this.switchLobby('Return stopped making progress for 20 seconds'), job)) return;
        }
        if (job.result === false) return this.setState('RESUME_PATH');
        if (job.alignment) return this.tickTunnelReturnAlignment(job);
        if (job.directReturn) return this.tickDirectTunnelReturn(job);
        if (job.result !== true) {
            if (!Pathfinder.isPathing()) this.startReturnPath();
            return;
        }
        if (this.checkHeight()) return;
        if (this.ownsPath) {
            Pathfinder.resetPath();
            this.ownsPath = false;
        }
        this.returnJob = null;
        if (job.after === 'COOLDOWN') {
            if (Date.now() < this.cooldownUntil) this.setState('COOLDOWN', 0);
            else this.finishCombat();
        } else if (job.after === 'COMBAT_RESUME') this.finishCombat();
        else if (job.after === 'RETURN_RESUME') {
            if (this.turnPending) this.turnGoal = null;
            this.setState(this.turnPending ? 'TURN' : 'FORWARD');
        } else this.restore(job.snapshot);
    }

    checkHeight() {
        let state = this.state;
        if (state === 'LOADOUT') state = this.loadoutRequest?.nextState;
        if (state === 'CHEST') state = this.chest?.resume.state;
        const returning = state === 'RESUME_PATH' ? this.returnJob : null;
        if (returning && returning.result !== true && (!returning.tunnel || !this.inLaneRange(position()[returning.tunnel.crossAxis], returning.tunnel.cross)))
            return false;
        if (!HORIZONTAL_STATES.has(state) && state !== 'COOLDOWN' && !returning) return false;
        if (this.state === 'COOLDOWN' && !this.initialized) return false;
        const expectedY = returning ? returning.snapshot.point.y : state === 'COOLDOWN' ? this.cooldownY : this.tunnelY;
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
        const snapshot = returning ? returning.snapshot : this.snapshot();
        const goalY = returning ? expectedY : Math.floor(expectedY);
        if (!returning) snapshot.point = this.safePoint ? { ...this.safePoint, y: goalY } : { ...position(), y: goalY };
        this.recovery = { snapshot, after: returning?.after, goalY, startedAt: Date.now(), pillar: null };
        if (returning) this.returnJob = null;
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
        const support = this.miningBlockBelowPlayer(0.01);
        const supportName = blockName(support);
        if (supportName?.endsWith('_slab')) {
            this.mineBlock(support, true);
            return;
        }
        if (y > recovery.goalY + 0.12) {
            if (foot.y < recovery.goalY) return;
            if (supportName === 'minecraft:bedrock') return this.switchLobby('Bedrock prevents downward recovery');
            this.mineBlock(support, true);
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
