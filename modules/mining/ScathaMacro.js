import { BP, Direction } from '../../utils/Constants';
import { offsetPitch, wrapTo180 } from '../../utils/Math';
import { MiningUtils } from '../../utils/MiningUtils';
import { ModuleBase } from '../../utils/ModuleBase';
import { ClientboundLevelParticlesPacket, ClientboundSystemChatPacket, getLevelParticleData } from '../../utils/Packets';
import { getLookingAt } from '../../utils/Raytrace';
import { registerSkyblockEvent } from '../../utils/SkyblockEvents';
import { getArea } from '../../utils/TabListUtils';
import { Mouse } from '../../utils/Ungrab';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { clickSlot, closeInventory, getGuiName, setItemSlot } from '../../utils/player/Inventory';
import { setKeysForStraightLineCoords } from '../../utils/player/Movement';
import { Rotations } from '../../utils/player/Rotations';
import { CombatBot } from '../combat/CombatBot';

const HORIZONTAL_STATES = new Set(['FORWARD', 'BACKWARD', 'RETURN', 'TURN', 'ALIGN']);
const MINING_STATES = new Set([...HORIZONTAL_STATES, 'DESCEND', 'CHEST', 'RECOVERY_WALK', 'RECOVERY_HEIGHT']);
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:water', 'minecraft:lava']);
const random = (low, high) => low + Math.random() * (high - low);
const randomInt = (low, high) => Math.floor(random(low, high + 1));
const position = () => ({ x: Player.getX(), y: Player.getY(), z: Player.getZ() });
const center = (point) => ({ x: Math.floor(point.x) + 0.5, y: point.y, z: Math.floor(point.z) + 0.5 });
const flatDistance = (point) => Math.hypot(Player.getX() - point.x, Player.getZ() - point.z);
const blockName = (point) => World.getBlockAt(point.x, point.y, point.z)?.type?.getRegistryName();
const key = (point) => `${point.x},${point.y},${point.z}`;
const isChest = (name) => name === 'minecraft:chest' || name === 'minecraft:trapped_chest';
const WORM_WARNING = /\byou hear the sound of something approaching\b/i;
const WORM_SPAWN_TIMEOUT_MS = 60000;
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
            recoverFromLimbo: false,
        });
        this.generation = 0;
        this.state = 'IDLE';
        this.ownsPath = false;
        this.ownsCombat = false;
        this.restoreMouseOnDisable = false;
        this.initSettings();
        this.bindToggleKey();
        this.on('tick', () => this.tick());
        this.on('worldUnload', () => this.onWorldUnload());
        this.on('chat', (event) => {
            const message = cleanChat(event.message.getUnformattedText());
            if (WORM_WARNING.test(message)) this.interruptForWorm();
            if (this.state === 'LOADOUT' && /loadout/i.test(message) && /can't|cannot|can only|cooldown|wait|unable|locked/i.test(message)) {
                this.currentLoadout = null;
                this.loadoutRequest.phase = 'OPEN';
                this.loadoutRequest.dueAt = Date.now() + this.delay(this.actionDelay);
            }
        });
        this.on('packetReceived', (packet) => {
            if (packet.overlay() || !WORM_WARNING.test(cleanChat(packet.content().getString()))) return;
            const generation = this.generation;
            // Packet callbacks run on the network thread; change macro state on the client thread before mining resumes.
            Client.scheduleTask(0, () => {
                if (this.enabled && this.generation === generation) this.interruptForWorm();
            });
        }).setFilteredClass(ClientboundSystemChatPacket);
        this.on('packetReceived', (packet) => {
            if (this.state !== 'CHEST' || !this.chest?.clickedAt) return;
            const data = getLevelParticleData(packet);
            if (data.particle?.getType() !== net.minecraft.core.particles.ParticleTypes.CRIT) return;
            const point = this.chest.point;
            if (Math.abs(data.x - point.x - 0.5) < 0.8 && Math.abs(data.y - point.y - 0.5) < 0.8 && Math.abs(data.z - point.z - 0.5) < 0.8) {
                const distance = Math.hypot(data.x - Player.getX(), data.z - Player.getZ());
                this.chest.particle = offsetPitch({ x: data.x, y: data.y, z: data.z }, 5 / Math.max(1, distance));
                this.chest.particleAt = Date.now();
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
        for (const event of ['death', 'limbo']) {
            registerSkyblockEvent(event, () => {
                if (this.enabled) this.switchLobby(event);
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
        slider('Mining Y', 'targetY', 31, 40, 35, 'Feet height of the 1x2 tunnel. Applied when starting a new lobby.');
        slider('Mining Slot', 'miningSlot', 1, 9, 1, 'Hotbar slot containing the mining tool.');
        slider('Attack Slot', 'attackSlot', 1, 9, 2, 'Hotbar slot containing the combat weapon.');
        slider('Block Slot', 'blockSlot', 1, 9, 3, 'Hotbar slot containing full blocks for height recovery.');
        slider('Forward Loadout', 'forwardLoadout', 1, 12, 1, 'Loadout number for forward mining. Mining Spread must be 0.');
        slider('Backward Loadout', 'backwardLoadout', 1, 12, 2, 'Loadout number for backward mining. Maximize Mining Spread.');
        slider('Combat Loadout', 'combatLoadout', 1, 12, 3, 'Loadout number used to kill Stoneworms and Scathas.');
        range('Forward Mining Time (s)', 'forwardTime', 10, 200, 60, 90, 'Random time before each backward pass. Combat and recovery pause this timer.');
        range('UI Click Delay (ms)', 'clickDelay', 100, 2000, 200, 400, 'Random delay before inventory clicks and chest interactions.');
        range('Action Delay (ms)', 'actionDelay', 500, 5000, 1000, 3000, 'Random delay between macro states.');
        slider('Lobby Failsafe Threshold', 'lobbyThreshold', 1, 1000, 200, 'Chat Mention and Player Grief intensity. Switching lobbies clears this counter.');
        slider('Exit Failsafe Threshold', 'exitThreshold', 1, 1000, 200, 'All other failsafe events. Stops the macro when reached.');
        slider('Intensity Decay per 10s', 'intensityDecay', 0, 50, 5, 'Subtract this amount from both counters every 10 seconds.');
    }

    delay(range) {
        return randomInt(range.low, range.high);
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
        this.resetLobby();
        this.miningSpeed = MiningUtils.getMiningSpeed('Crystal Hollows');
        this.setState('WARP');
        this.message('&aEnabled');
    }

    onDisable() {
        this.generation++;
        try {
            this.stopActivities();
            if (this.state === 'LOADOUT' || this.state === 'CHEST') closeInventory();
            this.state = 'IDLE';
            this.loadoutRequest = null;
            this.combatResume = null;
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
        this.returnJob = null;
        this.recovery = null;
        this.chest = null;
        this.safePoint = null;
        this.guiPausedAt = 0;
        this.cooldownY = null;
        this.openedChests = new Set();
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
    }

    stopActivities() {
        if (this.ownsCombat) {
            CombatBot.toggle(false, true);
            CombatBot.clearExternalTargets();
            this.ownsCombat = false;
        }
        if (this.ownsPath) {
            Pathfinder.resetPath();
            this.ownsPath = false;
        }
        this.stopControls();
    }

    setState(state) {
        this.stopActivities();
        this.mineTarget = null;
        this.state = state;
        this.readyAt = Date.now() + this.delay(this.actionDelay);
        this.startedAt = this.readyAt;
        this.initialized = false;
        if (state === 'COOLDOWN') this.cooldownY = Player.getY();
        this.progressPoint = null;
        this.progressAt = this.readyAt;
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
        if (this.state === 'LOADOUT' || this.state === 'CHEST') closeInventory();
        this.resetLobby();
        this.lobbyIntensity = 0;
        this.setState('HOP');
    }

    tick() {
        this.decayIntensity();
        if (this.exitIntensity >= this.exitThreshold) return this.stop('Exit failsafe threshold reached.');
        if (this.lobbyIntensity >= this.lobbyThreshold && !['HOP', 'WARP'].includes(this.state)) return this.switchLobby('Lobby failsafe threshold reached');
        if (!Player.getPlayer() || !World.isLoaded()) return;
        if (!['HOP', 'WARP'].includes(this.state) && getArea() !== 'Crystal Hollows') return this.switchLobby('Left the Crystal Hollows');
        if (this.checkHeight()) return;
        if (Date.now() < this.readyAt) return;
        if (Client.isInGui() && !['LOADOUT', 'CHEST'].includes(this.state)) {
            this.stopActivities();
            if (!this.guiPausedAt) this.guiPausedAt = Date.now();
            if (Date.now() - this.guiPausedAt > 30000) this.stop('Close the open screen before restarting.');
            return;
        }
        if (this.guiPausedAt) {
            const elapsed = Date.now() - this.guiPausedAt;
            this.startedAt += elapsed;
            this.forwardUntil += elapsed;
            this.progressAt += elapsed;
            this.guiPausedAt = 0;
        }
        if (!this.initialized) {
            this.initialized = true;
            this.startState();
        }
        if (Date.now() < this.readyAt || !this.enabled) return;
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
            case 'RECOVERY_WALK':
                return this.recoverWalk();
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
                this.forwardUntil = Date.now() + (this.forwardRemaining ?? this.delay(this.forwardTime) * 1000);
                this.forwardRemaining = null;
                this.nextTunnelCheck = 0;
                this.randomizeForward();
                break;
            case 'BACKWARD':
                this.backwardYaw = this.yaw(this.lane) + random(-5, 5);
                this.backwardPitch = random(-15, -7);
                break;
            case 'TURN':
                if (!this.turnGoal) {
                    this.turnOrigin = center({ ...position(), y: this.tunnelY });
                    this.turnGoal = this.offset(this.turnOrigin, this.turnDirection(), randomInt(4, 6));
                }
                this.randomizeForward();
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
            case 'RECOVERY_WALK':
                this.randomizeForward();
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

    switchLoadout(number, nextState) {
        if (this.currentLoadout === number) return this.setState(nextState);
        this.loadoutRequest = { number, nextState, phase: 'OPEN', attempts: 0, dueAt: 0 };
        this.setState('LOADOUT');
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
            request.dueAt = now + this.delay(this.actionDelay);
            return;
        }
        this.currentLoadout = request.number;
        this.loadoutRequest = null;
        this.setState(request.nextState);
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
        const point = center(this.lavaTarget.point);
        if (flatDistance(point) <= 0.3 && Player.getY() <= point.y + 1) return this.setState('DESCEND');
        if (Date.now() - this.startedAt > 15000) return this.setState('PATH_LAVA');
        Rotations.lookAtVector({ ...point, y: Player.getY() + 1 });
        setKeysForStraightLineCoords(point.x, point.y, point.z, false);
    }

    descend() {
        if (Player.getY() <= this.tunnelY + 0.08) {
            this.stopControls();
            if (Player.getY() < this.tunnelY - 0.25) return this.switchLobby('The entry shaft opened below the target height');
            if (Player.getPlayer().onGround()) return this.setState('ALIGN');
            return;
        }
        if (Date.now() - this.startedAt > 120000) return this.switchLobby('Entry shaft descent timed out');
        const point = { x: Math.floor(Player.getX()), y: Math.floor(Player.getY() - 0.05), z: Math.floor(Player.getZ()) };
        if (point.y < this.tunnelY) return;
        if (blockName(point) === 'minecraft:bedrock') return this.switchLobby('Bedrock blocks the entry shaft');
        this.mineBlock(point, true);
    }

    align() {
        if (!this.walkTo(this.alignPoint)) return;
        const axis = Math.random() < 0.5 ? 'x' : 'z';
        this.lane = { axis, sign: Math.random() < 0.5 ? -1 : 1, turnSign: Math.random() < 0.5 ? -1 : 1 };
        this.laneStart = { ...this.alignPoint };
        this.turnGoal = null;
        this.setState('FORWARD');
    }

    yaw(direction) {
        return direction.axis === 'x' ? -90 * direction.sign : direction.sign > 0 ? 0 : 180;
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
        let longest = 0;
        let firstRun = null;
        for (let step = 1; step <= 20; step++) {
            const point = this.offset({ x: Math.floor(origin.x), y: Math.floor(y), z: Math.floor(origin.z) }, direction, step);
            if (!this.loaded(point)) return { unknown: true, open: false };
            const low = blockName(point);
            const high = blockName({ ...point, y: point.y + 1 });
            if (low === 'minecraft:bedrock' || high === 'minecraft:bedrock') return { open: false, boundary: step, firstRun };
            run = low && high && !AIR.has(low) && !AIR.has(high) ? run + 1 : 0;
            longest = Math.max(longest, run);
            if (run === 5 && firstRun === null) firstRun = step - 4;
        }
        return { open: longest < 5, firstRun };
    }

    randomizeForward() {
        this.stopDistance = random(1, 2);
        this.advanceDistance = random(Math.max(2, this.stopDistance + 0.1), 4);
        this.advancing = false;
        this.preferHead = Math.random() < 0.5;
    }

    mineForward() {
        if (Date.now() >= this.nextTunnelCheck) {
            const scanOrigin = position();
            const other = this.lane.axis === 'x' ? 'z' : 'x';
            scanOrigin[other] = this.laneStart[other];
            const scan = this.scanTunnel(this.tunnelY, this.lane, scanOrigin);
            if (scan.unknown) {
                this.stopControls();
                return this.checkProgress(10000);
            }
            if (scan.open) return this.switchLobby('Fewer than five consecutive 1x2 solid columns in the next 20 blocks');
            this.nextTunnelCheck = Date.now() + 5000;
        }
        if (Date.now() >= this.forwardUntil) return this.beginBackward(false);
        const result = this.mineCorridor(this.lane, this.tunnelY, this.laneStart);
        if (result === 'BEDROCK') this.beginBackward(true);
    }

    beginBackward(atBoundary) {
        this.breakPoint = position();
        this.breakPoint.y = this.tunnelY;
        this.turnPending = atBoundary;
        this.switchLoadout(this.backwardLoadout, 'BACKWARD');
    }

    mineBackward() {
        const coordinate = this.lane.axis === 'x' ? Player.getX() : Player.getZ();
        const remaining = (coordinate - this.laneStart[this.lane.axis]) * this.lane.sign;
        if (remaining <= 0.45) return this.switchLoadout(this.forwardLoadout, 'RETURN');
        if (!this.selectSlot(this.miningSlot)) return;
        Rotations.lookAtAngles(this.backwardYaw, this.backwardPitch);
        if (Math.abs(wrapTo180(Player.getYaw() - this.backwardYaw)) > 3 || Math.abs(Player.getPitch() - this.backwardPitch) > 2) {
            Client.setKey('s', false);
            Client.setKey('leftclick', false);
            this.checkProgress(15000);
            return;
        }
        Client.setKey('s', true);
        Client.setKey('leftclick', true);
        this.checkProgress(15000);
    }

    returnToFace() {
        if (!this.walkTo(this.breakPoint)) return;
        if (this.turnPending) {
            this.turnGoal = null;
            return this.setState('TURN');
        }
        this.setState('FORWARD');
    }

    turnLane() {
        if (flatDistance(this.turnGoal) <= 0.35) {
            this.lane.sign *= -1;
            this.laneStart = { ...this.turnGoal };
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
        this.checkProgress(this.mineTarget ? Math.max(15000, this.mineTarget.expectedMs * 3) : 15000);
    }

    mineBlock(point, vertical = false) {
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
            const speed = Math.max(1, this.miningSpeed || 1500);
            const ticks = MiningUtils.getBlockInfo(name)
                ? MiningUtils.getMineTimeForBlock(name, MiningUtils.getEffectiveMiningSpeed(speed, false))
                : Math.max(4, Math.round(1500 / speed));
            this.mineTarget = { key: key(point), name, expectedMs: ticks * 50, attackedMs: 0, lastTick: now, changedAt: now + Math.min(ticks * 50, 150) };
        }
        const mining = this.mineTarget;
        // Stay inside the selected face until the server changes it; a timer alone can abandon slow gemstones.
        const wobble = vertical ? 0 : 0.12 * Math.sin(now / 300);
        const aim = { x: point.x + 0.5, y: point.y + 0.5 + wobble, z: point.z + 0.5 };
        Rotations.lookAtVector(aim);
        const looking = getLookingAt(4.5);
        const onTarget = looking && looking.x === point.x && looking.y === point.y && looking.z === point.z;
        Client.setKey('leftclick', !!onTarget);
        if (onTarget) mining.attackedMs += Math.min(100, now - mining.lastTick);
        mining.lastTick = now;
        if (mining.attackedMs > Math.max(15000, mining.expectedMs * 3)) this.switchLobby('A tunnel block did not break within its mining timeout');
    }

    walkTo(point) {
        if (flatDistance(point) <= 0.3) {
            this.stopControls();
            return true;
        }
        Rotations.lookAtVector({ ...point, y: Player.getY() + 1.4 });
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
        return {
            state: this.state,
            point: position(),
            loadout: this.loadoutRequest ? { ...this.loadoutRequest } : null,
            currentLoadout: this.currentLoadout,
            forwardRemaining: this.state === 'FORWARD' ? (this.initialized ? Math.max(0, this.forwardUntil - Date.now()) : this.forwardRemaining) : null,
            cooldownRemaining: this.state === 'COOLDOWN' ? (this.initialized ? Math.max(0, this.cooldownUntil - Date.now()) : this.cooldownDuration) : null,
            recoveryElapsed: this.recovery ? Date.now() - this.recovery.startedAt : null,
            recoveryContext: this.recovery,
            chestContext: this.chest,
        };
    }

    restore(snapshot) {
        this.forwardRemaining = snapshot.forwardRemaining;
        if (snapshot.recoveryContext) this.recovery = snapshot.recoveryContext;
        if (snapshot.chestContext) this.chest = snapshot.chestContext;
        if (this.recovery && snapshot.recoveryElapsed !== null) {
            this.recovery.startedAt = Date.now() - snapshot.recoveryElapsed;
            this.recovery.pillar = null;
        }
        if (snapshot.cooldownRemaining !== null) this.cooldownDuration = snapshot.cooldownRemaining;
        if (snapshot.state === 'LOADOUT') return this.switchLoadout(snapshot.loadout.number, snapshot.loadout.nextState);
        const loadout = snapshot.state === 'BACKWARD' ? this.backwardLoadout : snapshot.currentLoadout || this.forwardLoadout;
        this.switchLoadout(loadout, snapshot.state);
    }

    openChest(point) {
        this.chest = { point: { ...point }, resume: this.snapshot(), clickedAt: 0, particleAt: 0, opened: false, dueAt: 0 };
        this.setState('CHEST');
    }

    tickChest() {
        const chest = this.chest;
        const now = Date.now();
        if (!chest) return this.stop('Missing treasure chest position.');
        if (!isChest(blockName(chest.point))) return this.finishChest();
        if (now - this.startedAt > 25000) return this.switchLobby('Treasure chest did not open');
        const gui = getGuiName();
        if (chest.clickedAt && gui && /chest/i.test(gui)) {
            if (!chest.closeAt) chest.closeAt = now + this.delay(this.clickDelay);
            if (now >= chest.closeAt) {
                closeInventory();
                chest.opened = true;
            }
            return;
        }
        if (chest.opened) return this.finishChest();
        if (Client.isInGui()) return;
        if (chest.particle && now - chest.particleAt < 2000) {
            Rotations.lookAtVector(chest.particle);
            return;
        }
        Rotations.lookAtVector({ x: chest.point.x + 0.5, y: chest.point.y + 0.5, z: chest.point.z + 0.5 });
        const looking = getLookingAt(4.5);
        if (!looking || looking.x !== chest.point.x || looking.y !== chest.point.y || looking.z !== chest.point.z) return;
        if (!chest.dueAt) chest.dueAt = now + this.delay(this.clickDelay);
        if (now < chest.dueAt) return;
        Client.rightClick();
        chest.clickedAt = now;
        chest.dueAt = now + Math.max(1000, this.delay(this.clickDelay));
    }

    finishChest() {
        const chest = this.chest;
        if (chest.opened) this.openedChests.add(key(chest.point));
        this.chest = null;
        this.restore(chest.resume);
    }

    interruptForWorm() {
        if (!this.enabled || this.combatResume) return;
        if (!MINING_STATES.has(this.state) && !(this.state === 'LOADOUT' && MINING_STATES.has(this.loadoutRequest?.nextState))) return;
        this.combatResume = this.snapshot();
        if (this.recovery?.pillar) this.combatResume.point.y = this.recovery.pillar.y;
        if (this.state === 'CHEST' || this.state === 'LOADOUT') closeInventory();
        this.switchLoadout(this.combatLoadout, 'WAIT_WORM');
        this.message('&eWorm warning received. Mining paused; preparing combat and waiting for the spawn.');
    }

    findWormTargets() {
        const origin = this.combatResume.point;
        return CombatBot.findMob({
            names: ['Stoneworm', 'Scatha'],
            allowInvisible: true,
            checkVisibility: false,
            boundaryCheck: (x, y, z) => Math.hypot(x - origin.x, y - origin.y, z - origin.z) <= 32,
        });
    }

    waitForWorm() {
        if (!this.combatResume) return this.stop('Missing combat return position.');
        this.stopControls();
        const targets = this.findWormTargets();
        if (targets.length) {
            this.wormTargets = targets;
            this.setState('WORM');
            this.message('&aWorm spawned. Starting combat.');
            return;
        }
        if (Date.now() - this.startedAt >= WORM_SPAWN_TIMEOUT_MS) return this.switchLobby('No Stoneworm or Scatha appeared within 60 seconds');
        this.selectSlot(this.attackSlot);
    }

    fightWorm() {
        const now = Date.now();
        if (!this.combatResume) return this.stop('Missing combat return position.');
        if (now - this.startedAt > 120000) return this.switchLobby('Worm combat timed out');
        if (!Pathfinder.isPathing() && !this.selectSlot(this.attackSlot)) return;
        let targets = this.findWormTargets();
        if (!targets.length) targets = this.wormTargets.filter((target) => CombatBot.isCombatTargetCandidate(target, true));
        if (targets.length) {
            this.wormTargets = targets;
            this.wormMissingAt = 0;
            CombatBot.setExternalTargets(targets, { roam: false, allowWarpStarts: false, travelClicks: false, rightClickChance: 0 });
            if (!this.ownsCombat) {
                this.ownsCombat = true;
                CombatBot.toggle(true, true);
            }
            return;
        }
        if (this.ownsCombat) this.stopActivities();
        if (!this.wormMissingAt) this.wormMissingAt = now;
        if (now - this.wormMissingAt < 2000) return;
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
            if (!this.lane || this.nearbyPlayer()) return this.switchLobby('Return path ended at the wrong height near a player or outside the tunnel');
            const direction = job.snapshot.state === 'TURN' ? this.turnDirection() : this.lane;
            const scan = this.scanTunnel(job.snapshot.point.y, direction);
            if (scan.open || scan.unknown) return this.switchLobby('The return position is above an open or unloaded tunnel');
            this.recovery = { snapshot: job.snapshot, after: job.after, direction, goalY: job.snapshot.point.y, startedAt: Date.now(), pillar: null };
            this.returnJob = null;
            return this.prepareRecoveryWalk();
        }
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
            this.safePoint = position();
            return false;
        }
        if (this.nearbyPlayer()) {
            this.switchLobby('Height changed with another player within 10 blocks');
            return true;
        }
        if (!this.lane) {
            this.switchLobby('Height changed before the tunnel was established');
            return true;
        }
        const direction = state === 'TURN' ? this.turnDirection() : this.lane;
        const scan = this.scanTunnel(expectedY, direction);
        if (scan.open || scan.unknown) {
            this.switchLobby('Height changed over an open or unloaded tunnel');
            return true;
        }
        const snapshot = this.snapshot();
        const goalY = Math.floor(expectedY);
        snapshot.point = this.safePoint ? { ...this.safePoint, y: goalY } : { ...position(), y: goalY };
        this.recovery = { snapshot, direction, goalY, startedAt: Date.now(), pillar: null };
        if (this.state === 'LOADOUT' || this.state === 'CHEST') closeInventory();
        this.prepareRecoveryWalk();
        return true;
    }

    nearbyPlayer() {
        return World.getAllPlayers().some((player) => {
            if (player.getName() === Player.getName() || player.getUUID()?.version() === 2) return false;
            return Math.hypot(player.getX() - Player.getX(), player.getY() - Player.getY(), player.getZ() - Player.getZ()) <= 10;
        });
    }

    prepareRecoveryWalk() {
        const recovery = this.recovery;
        const origin = center({ ...position(), y: Math.floor(Player.getY()) });
        const scan = this.scanTunnel(origin.y, recovery.direction, origin);
        if (scan.open || scan.unknown) return this.switchLobby('No solid recovery column or bedrock within 20 blocks');
        const stopAt = Math.min(scan.firstRun ?? Infinity, scan.boundary ?? Infinity) - 1;
        recovery.origin = origin;
        recovery.goal = this.offset(origin, recovery.direction, Math.max(0, stopAt));
        this.switchLoadout(this.forwardLoadout, 'RECOVERY_WALK');
    }

    recoverWalk() {
        const recovery = this.recovery;
        if (Date.now() - recovery.startedAt > 90000) return this.switchLobby('Height recovery timed out');
        if (Math.abs(Player.getY() - recovery.origin.y) > 0.8) {
            if (this.nearbyPlayer()) return this.switchLobby('Player interference during height recovery');
            return this.prepareRecoveryWalk();
        }
        if (flatDistance(recovery.goal) <= 0.3) return this.setState('RECOVERY_HEIGHT');
        const result = this.mineCorridor(recovery.direction, recovery.origin.y, recovery.origin, recovery.goal);
        if (result === 'BEDROCK') this.setState('RECOVERY_HEIGHT');
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
            Rotations.lookAtAngles(Player.getYaw(), 90);
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
