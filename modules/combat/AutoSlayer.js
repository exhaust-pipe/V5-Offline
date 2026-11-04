import { ArmorStandEntity } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { finiteNumber } from '../../utils/NumberUtils';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { GuiStability } from '../../utils/player/GuiStability';
import { clickSlot, closeInventory, findFirstItem, findItemInHotbar, getGuiName, setItemSlot } from '../../utils/player/Inventory';
import { Rotations } from '../../utils/player/Rotations';
import { Raytrace } from '../../utils/Raytrace';
import { getArea, getTabListNames, resetAreaCache } from '../../utils/TabListUtils';
import { Mouse } from '../../utils/Ungrab';
import { CombatBot } from './CombatBot';
import { AtonedHorrorBoss } from './slayer/AtonedHorrorBoss';
import { GenericSlayerBoss } from './slayer/GenericSlayerBoss';

const STATES = {
    IDLE: 'Idle',
    STARTING: 'Starting in 5 seconds',
    WARP: 'Warping to Hub',
    HUB: 'Checking Hub population',
    TRAVEL: 'Traveling',
    SELECTOR: 'Opening Hub Selector',
    HOP: 'Switching Hub',
    PREPARE_PHONE: 'Moving phone to hotbar',
    CALL: 'Calling Maddox',
    PHONE: 'Selecting Maddox contact',
    SLAYER: 'Waiting for Slayer menu',
    MENU: 'Checking Slayer quest',
    CLAIM: 'Claiming Slayer reward',
    TIERS: 'Selecting Slayer tier',
    CANCEL: 'Confirming quest cancellation',
    CONFIRM: 'Confirming Slayer quest',
    ACCEPT: 'Waiting for quest start',
    MOBS: 'Slayer: killing mobs',
    BOSS: 'Slayer: fighting boss',
    RESTART: 'Waiting for auto restart',
};

const SLAYERS = {
    Zombie: {
        boss: 'Revenant Horror',
        maxTier: 5,
        bossModules: { 5: AtonedHorrorBoss },
        area: 'Crypts',
        destination: [-146, 56, -100],
        names: ['Crypt Ghoul', 'Golden Ghoul', 'Revenant Sycophant', 'Revenant Champion', 'Deformed Revenant', 'Atoned Champion', 'Atoned Revenant'],
        checkVisibility: false,
        boundaryCheck: (x, y, z) => x >= -180 && x <= -30 && y >= 30 && y <= 67 && z >= -160 && z <= -55,
    },
    Wolf: {
        boss: 'Sven Packmaster',
        maxTier: 4,
        area: 'Ruins',
        destination: [-225, 91, 63],
        names: ['Wolf', 'Old Wolf', 'Pack Enforcer', 'Sven Follower', 'Sven Alpha'],
        checkVisibility: false,
        boundaryCheck: (x, y, z) => x >= -300 && x <= -150 && y >= 55 && y <= 155 && z >= 25 && z <= 150,
    },
};
const TIERS = ['I', 'II', 'III', 'IV', 'V'];
const HUB_SELECTOR = [-5.5, 69, -22.5];
const MAX_ATTEMPTS = 4;
const MAX_NO_TARGET_ATTEMPTS = 3;
const RESPONSE_TIMEOUT_MS = 15000;
const NO_TARGET_TIMEOUT_MS = 10000;
const BOSS_NO_TARGET_TIMEOUT_MS = 20000;
const RESPAWN_SETTLE_MS = 1000;
const BOSS_TURN_JITTER_DEGREES = 30;
const clean = (value) => ChatLib.removeFormatting(String(value ?? '')).trim();
const cleanLabel = (value) =>
    clean(value)
        .replace(/^[^a-z0-9]+/i, '')
        .replace(/\s+/g, ' ');
const InventoryScreen = net.minecraft.client.gui.screens.inventory.InventoryScreen;

class AutoSlayer extends ModuleBase {
    constructor() {
        super({
            name: 'Auto Slayer',
            subcategory: 'Combat',
            description: 'Automatically completes Zombie and Wolf Slayer quests.',
            tooltip: 'Completes Zombie tier I-V and Wolf tier I-IV Slayer quests. Toggle with the Auto Slayer keybind.',
            autoDisableOnWorldUnload: false,
            isMacro: true,
        });
        this.bindToggleKey();
        this.ownsCombat = false;
        this.type = 'Zombie';
        this.tier = 1;
        this.phone = 'Maddox Batphone';
        this.maxPlayers = 5;
        this.maxAreaPlayers = 1;
        this.weaponSlot = 1;
        this.clickDelay = { low: 200, high: 400 };
        this.actionDelay = { low: 1, high: 3 };
        this.phoneSwap = null;
        this.pendingBoss = null;
        this.bossModule = null;
        this.menuClickDelay = false;
        this.lastMobTarget = null;
        this.lastKilledMobPosition = null;
        this.recoveringSlayer = false;
        this.questPhase = null;
        this.state = STATES.IDLE;
        this.revision = 0;
        this.guiStability = new GuiStability();
        this.players = null;
        this.areaPlayers = null;
        this.completed = 0;
        this.noTargetAttempts = 0;
        this.restartQuestPending = false;
        this.forceHubWarp = false;

        this.addMultiToggle(
            'Slayer Type',
            Object.keys(SLAYERS),
            true,
            (selected) => (this.type = selected.find((option) => option.enabled)?.name || 'Zombie'),
            'Zombie: Revenant Horror / Atoned Horror in the Crypts. Wolf: Sven Packmaster in the Ruins. Applies on the next start.',
            'Zombie'
        );
        this.addSlider(
            'Slayer Tier',
            1,
            5,
            1,
            (value) => (this.tier = Math.max(1, Math.min(5, Math.round(finiteNumber(value, 1))))),
            'Zombie: tier I-V. Wolf: tier I-IV. Zombie V uses safe-ground combat against Atoned Horror. Applies on the next start.'
        );
        this.addMultiToggle(
            'Slayer Phone',
            ['Maddox Batphone', 'Abiphone'],
            true,
            (selected) => (this.phone = selected.find((option) => option.enabled)?.name || 'Maddox Batphone'),
            'Uses the selected phone from your inventory, moving it to the hotbar if needed. Abiphone requires the Maddox the Slayer contact. Applies on the next start.',
            'Maddox Batphone'
        );
        this.addSlider(
            'Slayer Hub Player Limit',
            0,
            60,
            5,
            (value) => (this.maxPlayers = Math.max(0, Math.min(60, Math.round(finiteNumber(value, 5))))),
            'Maximum Hub population, including yourself. Checked on entering a Hub and after each completed quest. Uses the Hub Selector to find a small random Hub. 0 disables this check.'
        );
        this.addSlider(
            'Slayer Area Player Limit',
            0,
            5,
            1,
            (value) => (this.maxAreaPlayers = Math.max(0, Math.min(5, Math.round(finiteNumber(value, 1))))),
            'Maximum loaded players in the Slayer area, including yourself and excluding NPCs. Checked on arrival and after each completed quest. 0 disables this check.'
        );
        this.addSlider(
            'Slayer Weapon Slot',
            1,
            8,
            1,
            (value) => (this.weaponSlot = Math.max(1, Math.min(8, Math.round(finiteNumber(value, 1))))),
            'Hotbar slot to restore after calling Maddox. Applies on the next start.'
        );
        this.addRangeSlider(
            'Slayer Click Delay (ms)',
            100,
            2000,
            this.clickDelay,
            (value) => (this.clickDelay = value),
            'Random minimum/maximum delay in milliseconds for menu clicks, inventory interactions and phone use. Attacks use Combat Bot CPS.'
        );
        this.addRangeSlider(
            'Slayer Action Delay (s)',
            0,
            10,
            this.actionDelay,
            (value) => (this.actionDelay = value),
            'Random minimum/maximum delay in seconds for commands, travel, slot changes and state changes. Boss transitions randomly keep fighting mobs for this delay or stop and turn toward the last killed mob with a +/-30 degree offset. Returning to the Slayer menu after a kill uses Click Delay.'
        );

        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.state,
                    Quest: () => this.questName || 'None',
                    Target: () => (CombatBot.enabled ? CombatBot.getTargetDisplayName(CombatBot.target) : 'None'),
                    'Hub Players': () => this.players ?? 'Unknown',
                    'Area Players': () => this.areaPlayers ?? 'Unknown',
                    'Bosses Slain': () => this.completed,
                    'No-Target Attempts': () => `${this.noTargetAttempts}/${MAX_NO_TARGET_ATTEMPTS}`,
                },
            },
        ]);

        this.on('tick', () => this.tick());
        this.on('entityDamage', (entity) => {
            if (this.state === STATES.MOBS && !this.pendingBoss && CombatBot.sameTarget(entity, CombatBot.target)) this.lastMobTarget = entity;
        });
        this.on('entityDeath', (entity) => this.rememberMobKill(entity));
        this.on('chat', (event) => this.onChat(clean(event.message.getUnformattedText())));
        this.on('worldUnload', () => this.onWorldUnload());
        this.on('worldLoad', () => {
            if (!this.enabled) return;
            this.stopCombat();
            this.phoneSwap = null;
            resetAreaCache();
            this.players = null;
            this.areaPlayers = null;
            this.populationStableAt = 0;
            this.transition(this.state === STATES.STARTING ? STATES.STARTING : STATES.HUB, 5000);
        });
    }

    onEnable() {
        if (CombatBot.enabled && CombatBot.isParentManaged) return this.fail('Combat Bot is already managed by another macro.');
        if (!Player.getPlayer() || !World.getWorld()) return this.fail('Join SkyBlock before starting Auto Slayer.');
        this.config = SLAYERS[this.type] || SLAYERS.Zombie;
        if (this.tier > this.config.maxTier) return this.fail(`${this.type} Slayer only supports tiers I-${TIERS[this.config.maxTier - 1]}.`);
        this.ownsCombat = true;
        const BossModule = this.config.bossModules?.[this.tier] || GenericSlayerBoss;
        this.bossModule = new BossModule(this.config);
        this.questName = `${this.config.boss} ${TIERS[this.tier - 1]}`;
        this.callMethod = this.phone;
        this.combatSlot = this.weaponSlot - 1;
        this.originalSlot = Player.getHeldItemIndex();
        this.phoneSwap = null;
        this.menuAttempts = 0;
        this.warpAttempts = 0;
        this.hopAttempts = 0;
        this.completed = 0;
        this.noTargetAttempts = 0;
        this.restartQuestPending = false;
        this.forceHubWarp = false;
        this.lastCompletedAt = 0;
        this.players = null;
        this.areaPlayers = null;
        this.populationStableAt = 0;
        this.questVerified = false;
        this.questPhase = null;
        this.restartSeen = false;
        this.recoveringSlayer = false;
        Mouse.ungrab();
        this.stopCombat();
        this.transition(STATES.STARTING, 5000);
        this.message(`&a${this.questName}. Starting in 5 seconds; toggle Auto Slayer off to cancel.`);
    }

    onDisable() {
        this.revision++;
        this.state = STATES.IDLE;
        this.questVerified = false;
        this.questPhase = null;
        this.recoveringSlayer = false;
        if (!this.ownsCombat) return;
        try {
            this.stopCombat();
            this.cancelPhoneSwap();
            this.guiStability.reset();
            if (this.isSlayerGui(getGuiName()) || getGuiName()?.includes('Hub Selector')) closeInventory();
            if (Player.getPlayer()) setItemSlot(this.originalSlot);
        } finally {
            this.ownsCombat = false;
            Mouse.regrab();
        }
        this.message('&cDisabled');
    }

    fail(reason) {
        this.message(`&c${reason} Stopping macro.`);
        this.toggle(false);
    }

    locationDetails(goals = [this.config.destination]) {
        const position = [Player.getX(), Player.getY(), Player.getZ()].map((value) => value.toFixed(1)).join(', ');
        const destinations = goals.map((point) => `(${point.join(', ')})`).join(' / ');
        return `Player XYZ: (${position}); destination XYZ: ${destinations}.`;
    }

    recoverSlayer(reason) {
        if (this.recoveringSlayer && !this.pathPending) return;
        this.recoveringSlayer = true;
        this.questVerified = false;
        this.questPhase = null;
        this.restartSeen = false;
        this.staleScoreboardPhase = null;
        this.menuAttempts = 0;
        this.warpAttempts = 0;
        this.cancelPhoneSwap();
        this.message(`&e${reason} Returning to ${this.config.area} to resume Slayer.`);
        this.pathTo([this.config.destination], STATES.CALL, this.config.area, RESPAWN_SETTLE_MS);
    }

    randomDelay(click = false) {
        const delay = click ? this.clickDelay : this.actionDelay;
        const minimum = click ? 100 : 0;
        const maximum = click ? 2000 : 10;
        const first = Math.max(minimum, Math.min(maximum, finiteNumber(delay?.low, click ? 200 : 1)));
        const second = Math.max(minimum, Math.min(maximum, finiteNumber(delay?.high, click ? 400 : 3)));
        return (Math.min(first, second) + Math.random() * Math.abs(first - second)) * (click ? 1 : 1000);
    }

    defer(minimum = 0, click = false) {
        this.readyAt = Date.now() + minimum + this.randomDelay(click || this.menuClickDelay);
        this.deadline = this.readyAt + RESPONSE_TIMEOUT_MS;
    }

    transition(state, minimum = 0, click = false) {
        this.revision++;
        this.state = state;
        this.noTargetSince = null;
        this.defer(minimum, click);
        this.guiStability.reset();
    }

    stopCombat() {
        this.pendingBoss = null;
        this.menuClickDelay = false;
        this.lastMobTarget = null;
        this.lastKilledMobPosition = null;
        if (!this.ownsCombat) return;
        this.bossModule?.stop();
        CombatBot.toggle(false, true);
        CombatBot.clearExternalTargets();
        Pathfinder.resetPath();
        Client.stopMovement();
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        Rotations.stop();
    }

    tick() {
        if (!this.enabled) return;
        const player = Player.getPlayer();
        if (!player || !World.getWorld()) return this.stopCombat();
        if (player.isDeadOrDying()) {
            this.recoverSlayer('The player died.');
            this.readyAt = Math.max(this.readyAt, Date.now() + RESPAWN_SETTLE_MS);
            this.deadline = this.readyAt + RESPONSE_TIMEOUT_MS;
            return;
        }
        const guiReady = this.guiStability.update();
        if (Date.now() < this.readyAt) return;

        if (this.recoveringSlayer && this.state === STATES.TRAVEL && this.afterTravel === STATES.CALL) {
            if (!player.onGround()) return;
            if (getArea() !== 'Hub') {
                this.transition(STATES.WARP);
                return;
            }
            if (Client.isInGui()) {
                closeInventory();
                this.defer(0, true);
                return;
            }
            this.recoveringSlayer = false;
        }

        if (this.state === STATES.MOBS || this.state === STATES.BOSS) return this.tickCombat(guiReady);

        switch (this.state) {
            case STATES.STARTING: {
                const inventory = Player.getInventory();
                const phoneSlot = findFirstItem(inventory, this.callMethod);
                if (phoneSlot < 0 || phoneSlot >= 36) return this.fail(`${this.callMethod} is missing from the inventory.`);
                if (!inventory?.getStackInSlot(this.combatSlot) || this.isPhone(inventory.getStackInSlot(this.combatSlot))) {
                    return this.fail('Select an occupied Slayer Weapon Slot different from the phone slot.');
                }
                this.transition(STATES.WARP);
                break;
            }
            case STATES.WARP: {
                if (Client.isInGui()) {
                    closeInventory();
                    this.defer(150, true);
                    break;
                }
                if (!this.forceHubWarp && getArea() === 'Hub') {
                    this.transition(STATES.HUB);
                    break;
                }
                if (++this.warpAttempts > MAX_ATTEMPTS) return this.fail('Could not travel to the Hub.');
                const command = this.forceHubWarp ? 'warp hub' : 'hub';
                this.forceHubWarp = false;
                ChatLib.command(command);
                this.transition(STATES.HUB, 3000);
                break;
            }
            case STATES.HUB:
                this.checkHub();
                break;
            case STATES.TRAVEL:
                this.travel();
                break;
            case STATES.SELECTOR:
                if (guiReady) this.openSelector();
                else if (Date.now() >= this.deadline) this.fail('Hub Selector did not finish loading.');
                break;
            case STATES.HOP:
                if (Date.now() >= this.deadline) {
                    if (this.hopAttempts >= MAX_ATTEMPTS) return this.fail('Random Hub did not transfer you. Check small-Hub access.');
                    this.selectorClicks = 0;
                    this.transition(STATES.SELECTOR, 0, true);
                }
                break;
            case STATES.CALL:
                if (!this.restartQuestPending && this.areaPlayers === null && this.checkAreaPopulation()) break;
                if (guiReady) this.callMaddox();
                else if (Date.now() >= this.deadline) this.retryMenu();
                break;
            case STATES.PREPARE_PHONE:
                if (Date.now() >= this.deadline) this.fail('Moving the phone to the hotbar timed out.');
                else if (guiReady) this.preparePhone();
                break;
            case STATES.RESTART:
                this.beginMenu(true);
                break;
            default:
                if (guiReady) this.handleMenu();
                else if (Date.now() >= this.deadline) this.retryMenu();
                break;
        }
    }

    readPopulation() {
        const lines = [...getTabListNames(), TabList.getHeader(), TabList.getFooter()];
        for (const line of lines) {
            for (const text of clean(line).split('\n')) {
                const match = text.trim().match(/^Players\s*[:(]\s*([\d,]+)/i);
                if (match && Number(match[1].replace(/,/g, '')) >= 1) return Number(match[1].replace(/,/g, ''));
            }
        }
        return null;
    }

    checkPopulation() {
        if (getArea() !== 'Hub') return false;
        this.players = this.readPopulation();
        if (this.maxPlayers > 0 && this.players !== null && this.players > this.maxPlayers) {
            this.switchHub();
            return true;
        }
        return this.checkAreaPopulation();
    }

    checkAreaPopulation() {
        this.areaPlayers = World.getAllPlayers().filter(
            (player) => player.getUUID().version() === 4 && this.config.boundaryCheck(player.getX(), player.getY(), player.getZ())
        ).length;
        if (this.maxAreaPlayers <= 0 || this.areaPlayers <= this.maxAreaPlayers) return false;
        this.switchHub(`${this.config.area} has ${this.areaPlayers} players (limit ${this.maxAreaPlayers}).`);
        return true;
    }

    checkHub() {
        if (getArea() !== 'Hub') {
            if (Date.now() >= this.deadline) this.transition(STATES.WARP);
            return;
        }
        if (this.restartQuestPending) {
            this.beginMenu(true);
            return;
        }
        const count = this.readPopulation();
        if (this.maxPlayers > 0) {
            if (count === null) {
                if (Date.now() >= this.deadline) this.fail('Cannot read the Hub player count from Tab. Enable the Players widget.');
                return;
            }
            if (this.players !== count || !this.populationStableAt) {
                this.players = count;
                this.populationStableAt = Date.now() + 1000;
                return;
            }
            if (Date.now() < this.populationStableAt) return;
        }
        this.players = count;
        this.warpAttempts = 0;
        const population = count === null ? 'Hub population check disabled.' : `Hub has ${count} player(s).`;
        if (this.maxPlayers > 0 && count > this.maxPlayers) {
            this.switchHub();
        } else if (!this.recoveringSlayer && this.config.boundaryCheck(Player.getX(), Player.getY(), Player.getZ())) {
            this.message(`&a${population} Already in ${this.config.area}; calling Maddox.`);
            this.beginMenu();
        } else {
            this.message(`&a${population} Traveling to ${this.config.area}.`);
            this.menuAttempts = 0;
            this.pathTo([this.config.destination], STATES.CALL, this.config.area, 0, this.noTargetAttempts === 2);
        }
    }

    switchHub(reason = `Hub has ${this.players} players (limit ${this.maxPlayers}).`) {
        this.message(`${reason} Finding another Hub.`);
        this.questVerified = false;
        this.restartSeen = false;
        this.selectorClicks = 0;
        this.selectorAimed = false;
        if (Client.isInGui()) closeInventory();
        const npc = this.findSelector();
        const position = npc ? CombatBot.getTargetPosition(npc) : { x: HUB_SELECTOR[0], y: HUB_SELECTOR[1], z: HUB_SELECTOR[2] };
        this.pathTo(CombatBot.buildPathGoals(position), STATES.SELECTOR, 'Hub Selector');
    }

    pathTo(goals, nextState, destination, minimum = 0, fromPlayer = false) {
        this.stopCombat();
        this.pathGoals = goals;
        this.afterTravel = nextState;
        this.destination = destination;
        this.pathPending = false;
        this.pathAttempts = 0;
        this.pathFromPlayer = fromPlayer;
        this.transition(STATES.TRAVEL, minimum);
    }

    travel() {
        if (this.pathPending) {
            if (Date.now() >= this.deadline) this.fail(`Travel to ${this.destination} timed out. ${this.locationDetails(this.pathGoals)}`);
            return;
        }
        this.pathPending = true;
        this.pathAttempts++;
        this.deadline = Date.now() + 120000;
        const revision = this.revision;
        Pathfinder.findPath(
            this.pathGoals,
            (success) => {
                if (!this.enabled || this.state !== STATES.TRAVEL || this.revision !== revision) return;
                this.pathPending = false;
                if (success) this.transition(this.afterTravel, 0, this.afterTravel === STATES.SELECTOR);
                else {
                    const reason = `No path to ${this.destination} (${this.pathAttempts}/${MAX_ATTEMPTS}). ${this.locationDetails(this.pathGoals)}`;
                    if (this.pathAttempts >= MAX_ATTEMPTS) this.fail(reason);
                    else {
                        this.message(`&e${reason} Retrying.`);
                        this.defer(1000);
                    }
                }
            },
            { walkArrivalRadius: 2, allowWarpStarts: !this.pathFromPlayer }
        );
    }

    findSelector() {
        const named = World.getAllEntities().find((entity) => clean(entity.getName()).toLowerCase() === 'hub selector');
        if (!named) return null;
        return named.toMC() instanceof ArmorStandEntity ? CombatBot.resolveNametagTarget(named, World.getAllPlayers()) : named;
    }

    openSelector() {
        if (getGuiName()?.includes('Hub Selector')) {
            const random = this.findMenuItem('Random Hub');
            if (random) {
                this.hopAttempts++;
                this.click(random, STATES.HOP, 'RIGHT');
                return;
            }
            if (Date.now() >= this.deadline) this.fail('Random Hub is unavailable in the Hub Selector.');
            return;
        }
        if (Client.isInGui()) {
            closeInventory();
            this.defer(250, true);
            return;
        }
        const npc = this.findSelector();
        if (!npc) {
            if (Date.now() >= this.deadline) this.fail('Cannot find the Hub Selector NPC.');
            return;
        }
        const position = CombatBot.getTargetPosition(npc);
        if (CombatBot.getDistanceToPlayer(position).distance > 3.5) {
            this.pathTo(CombatBot.buildPathGoals(position), STATES.SELECTOR, 'Hub Selector');
            return;
        }
        if (this.selectorAimed) {
            this.selectorAimed = false;
            if (Raytrace.isLookingAtEntity(npc, 4.5)) {
                Client.leftClick();
                this.defer(4000, true);
            }
            return;
        }
        if (this.selectorClicks >= MAX_ATTEMPTS || Date.now() >= this.deadline) return this.fail('Hub Selector did not open.');
        if (Rotations.active) return;
        this.selectorClicks++;
        const revision = this.revision;
        Rotations.lookAtVector([position.x, position.y + 1.5, position.z]);
        Rotations.onComplete(() => {
            if (!this.enabled || this.state !== STATES.SELECTOR || revision !== this.revision) return;
            this.selectorAimed = true;
            this.defer(0, true);
        });
    }

    isSlayerGui(name) {
        name = cleanLabel(name);
        return name === 'Slayer' || name === this.config?.boss || name === 'Confirm' || name?.includes('Abiphone');
    }

    findMenuItem(name) {
        const items = Player.getContainer()?.getItems() || [];
        const target = cleanLabel(name).toLowerCase();
        for (let slot = 0; slot < items.length - 36; slot++) {
            const item = items[slot];
            if (item && cleanLabel(item.getName()).toLowerCase() === target) return { slot, item };
        }
        return null;
    }

    lore(entry) {
        return (entry.item.getLore() || []).map(clean).join('\n');
    }

    click(entry, nextState, button = 'LEFT') {
        if (clickSlot(entry.slot, false, button)) this.transition(nextState, 0, true);
    }

    beginMenu(click = false) {
        this.stopCombat();
        this.menuClickDelay = click;
        this.menuAttempts = 0;
        this.transition(STATES.CALL);
    }

    retryMenu() {
        if (++this.menuAttempts >= MAX_ATTEMPTS) return this.fail(`Timed out during ${this.state.toLowerCase()} after ${MAX_ATTEMPTS} attempts.`);
        this.message(`&e${this.state} timed out; calling Maddox again.`);
        if (Client.isInGui()) closeInventory();
        this.transition(STATES.CALL, 1000);
    }

    isPhone(item) {
        return clean(item?.getName()).toLowerCase().includes(this.callMethod.toLowerCase());
    }

    findPhoneHotbarSlot(inventory) {
        const protectedSlots = [this.combatSlot, 8, findItemInHotbar('Aspect of the End'), findItemInHotbar('Aspect of the Void')];
        for (let slot = 0; slot < 9; slot++) {
            if (protectedSlots.includes(slot)) continue;
            if (!inventory.getStackInSlot(slot)) return slot;
        }

        for (let slot = 0; slot < 9; slot++) {
            if (!protectedSlots.includes(slot)) return slot;
        }

        return -1;
    }

    preparePhone() {
        const mc = Client.getMinecraft();
        const inventory = Player.getInventory();
        if (!inventory) return;
        if (!this.phoneSwap) {
            if (findItemInHotbar(this.callMethod) !== -1) {
                this.transition(STATES.CALL);
                return;
            }
            const source = findFirstItem(inventory, this.callMethod);
            if (source < 9 || source >= 36) return this.fail(`${this.callMethod} is missing from the inventory.`);
            const target = this.findPhoneHotbarSlot(inventory);
            if (target === -1) return this.fail('No hotbar slot is available for the phone.');
            this.phoneSwap = { source, target, step: 0, openAttempts: 0 };
        }

        const swap = this.phoneSwap;
        if (!(Client.currentGui.get() instanceof InventoryScreen)) {
            if (swap.step !== 0) return this.fail('The inventory closed while moving the phone.');
            if (Client.isInGui()) closeInventory();
            else {
                if (++swap.openAttempts > MAX_ATTEMPTS) return this.fail('Could not open the inventory to move the phone.');
                mc.setScreen(new InventoryScreen(mc.player));
            }
            this.guiStability.reset();
            this.defer(0, true);
            return;
        }

        const container = Player.getContainer();
        const carried = mc.player.containerMenu.getCarried();
        if (swap.step === 0) {
            if (!carried.isEmpty()) return this.fail('Clear the inventory cursor before moving the phone.');
            if (!this.isPhone(container.getStackInSlot(swap.source))) return this.fail('The phone moved out of its inventory slot.');
            if (clickSlot(swap.source)) {
                swap.step = 1;
                this.defer(0, true);
            }
            return;
        }
        if (swap.step === 1) {
            if (!this.isPhone(Item.fromMC(carried))) return;
            if (clickSlot(36 + swap.target)) {
                swap.step = 2;
                this.defer(0, true);
            }
            return;
        }
        if (!this.isPhone(inventory.getStackInSlot(swap.target))) return;
        if (!carried.isEmpty()) {
            if (swap.step === 3) return;
            if (container.getStackInSlot(swap.source)) return this.fail('The original phone slot is occupied; cannot finish the swap.');
            if (clickSlot(swap.source)) {
                swap.step = 3;
                this.defer(0, true);
            }
            return;
        }

        this.phoneSwap = null;
        closeInventory();
        setItemSlot(swap.target);
        this.transition(STATES.CALL);
    }

    cancelPhoneSwap() {
        if (!this.phoneSwap) return;
        const mc = Client.getMinecraft();
        if (mc.player && Client.currentGui.get() instanceof InventoryScreen) {
            const container = Player.getContainer();
            if (!mc.player.containerMenu.getCarried().isEmpty() && !container.getStackInSlot(this.phoneSwap.source)) clickSlot(this.phoneSwap.source);
            if (mc.player.containerMenu.getCarried().isEmpty()) closeInventory();
            else this.message('&eAn item is still on the inventory cursor. Place it in a free slot.');
        }
        this.phoneSwap = null;
    }

    callMaddox() {
        if (cleanLabel(getGuiName()) === 'Slayer') {
            this.transition(STATES.MENU);
            return;
        }
        if (Client.isInGui()) {
            closeInventory();
            this.defer(150, true);
            return;
        }
        const slot = findItemInHotbar(this.callMethod);
        if (slot === -1) {
            this.phoneSwap = null;
            this.transition(STATES.PREPARE_PHONE);
            return;
        }
        if (slot === this.combatSlot) return this.fail('The phone is occupying the Slayer Weapon Slot.');
        if (Player.getHeldItemIndex() !== slot) {
            setItemSlot(slot);
            this.defer(150);
            return;
        }
        Client.rightClick();
        this.transition(this.callMethod === 'Abiphone' ? STATES.PHONE : STATES.SLAYER, 0, true);
    }

    handleMenu() {
        const name = cleanLabel(getGuiName());
        const completed = name === 'Slayer' ? this.findMenuItem('Slayer Quest Complete!') : null;
        if (completed && this.state !== STATES.CLAIM) {
            this.questVerified = false;
            this.questPhase = null;
            this.click(completed, STATES.CLAIM);
            return;
        }
        switch (this.state) {
            case STATES.PHONE:
                if (name === 'Slayer') {
                    this.transition(STATES.MENU);
                    return;
                }
                if (name?.includes('Abiphone')) {
                    const maddox = this.findMenuItem('Maddox the Slayer');
                    if (maddox) {
                        this.click(maddox, STATES.SLAYER);
                        return;
                    }
                }
                break;
            case STATES.SLAYER:
                if (name === 'Slayer') {
                    this.transition(STATES.MENU);
                    return;
                }
                break;
            case STATES.MENU:
                if (name === 'Slayer' && this.chooseQuest()) return;
                break;
            case STATES.CLAIM:
                if (name === 'Slayer' && !completed && this.findMenuItem(this.config.boss)) {
                    this.transition(STATES.MENU);
                    return;
                }
                break;
            case STATES.TIERS:
                if (name === this.config.boss) {
                    const tier = this.findMenuItem(this.questName);
                    if (tier) {
                        if (!this.canAfford(tier)) return;
                        if (/not unlocked|requires |must (?:first |reach |complete |slay )/i.test(this.lore(tier))) {
                            this.fail(`${this.questName} is locked. Check the quest requirements.`);
                            return;
                        }
                        this.click(tier, STATES.CONFIRM);
                        return;
                    }
                }
                break;
            case STATES.CANCEL:
            case STATES.CONFIRM:
                if (name === 'Confirm') {
                    const confirm = this.findMenuItem('Confirm');
                    if (confirm) {
                        if (this.state === STATES.CANCEL) this.click(confirm, STATES.SLAYER);
                        else if (this.canAfford(confirm)) {
                            this.questVerified = true;
                            this.click(confirm, STATES.ACCEPT);
                        }
                        return;
                    }
                }
                break;
            case STATES.ACCEPT:
                if (!Client.isInGui()) {
                    this.startCombat(STATES.MOBS, true);
                    return;
                }
                break;
        }
        if (Date.now() >= this.deadline) this.retryMenu();
    }

    canAfford(entry) {
        if (!/cannot afford (?:this )?quest|cannot afford to start this quest/i.test(this.lore(entry))) return true;
        this.fail('Not enough coins to start the Slayer quest.');
        return false;
    }

    chooseQuest() {
        const ongoing = this.findMenuItem('Ongoing Slayer Quest');
        if (ongoing) {
            const lore = this.lore(ongoing);
            const boss = lore.match(/^Boss:\s*(.+?)\s*$/m)?.[1];
            if (!boss) return false;
            if (cleanLabel(boss) === this.questName && !this.restartQuestPending) {
                const detectedPhase = this.scoreboardPhase();
                if (detectedPhase === STATES.RESTART) return false;
                const phase = detectedPhase || this.questPhase;
                if (!phase) return false;
                this.questVerified = true;
                this.startCombat(phase);
            } else {
                this.questVerified = false;
                this.click(ongoing, STATES.CANCEL);
            }
            return true;
        }
        const category = this.findMenuItem(this.config.boss);
        if (!category) return false;
        this.questPhase = null;
        if (this.restartQuestPending) {
            this.stopCombat();
            this.restartQuestPending = false;
            this.recoveringSlayer = false;
            this.forceHubWarp = false;
            this.warpAttempts = 0;
            this.hopAttempts = 0;
            this.players = null;
            this.areaPlayers = null;
            this.populationStableAt = 0;
            closeInventory();
            this.transition(STATES.STARTING, 5000);
            return true;
        }
        this.questVerified = false;
        this.click(category, STATES.TIERS);
        return true;
    }

    startCombat(phase, newQuest = false) {
        this.questPhase = phase;
        const switchingToBoss = this.state === STATES.MOBS && phase === STATES.BOSS;
        if (switchingToBoss) {
            if (!this.pendingBoss) {
                const spawnPoint = this.lastKilledMobPosition;
                const turnToBoss = Math.random() < 0.5 && spawnPoint !== null;
                if (turnToBoss) this.stopCombat();
                this.pendingBoss = {
                    turnToBoss,
                    spawnPoint,
                    rotating: false,
                    readyAt: turnToBoss ? null : Date.now() + this.randomDelay(),
                    deadline: Date.now() + NO_TARGET_TIMEOUT_MS,
                    origin: spawnPoint || { x: Player.getX(), y: Player.getY(), z: Player.getZ() },
                };
            }
            const pending = this.pendingBoss;
            if (pending.turnToBoss && pending.readyAt === null) {
                if (Date.now() >= pending.deadline) {
                    this.questVerified = false;
                    this.message(`&eCould not finish turning toward the last killed mob; returning to ${this.config.area}.`);
                    this.pathTo([this.config.destination], STATES.CALL, this.config.area);
                    return;
                }
                if (!pending.rotating) {
                    const { x, y, z } = pending.spawnPoint;
                    const angles = Rotations.getAnglesFromVector([x, y + 1, z]);
                    if (
                        angles &&
                        Rotations.lookAtAngles(
                            angles.yaw + (Math.random() * 2 - 1) * BOSS_TURN_JITTER_DEGREES,
                            angles.pitch + (Math.random() * 2 - 1) * BOSS_TURN_JITTER_DEGREES
                        )
                    ) {
                        pending.rotating = true;
                        Rotations.onComplete(() => {
                            if (!this.enabled || this.state !== STATES.MOBS || this.pendingBoss !== pending) return;
                            pending.readyAt = Date.now();
                        });
                    }
                }
                return;
            }
            if (Date.now() < pending.readyAt) return;
        }
        const bossOrigin = switchingToBoss ? this.pendingBoss.origin : { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        this.stopCombat();
        if (Client.isInGui()) closeInventory();
        this.menuAttempts = 0;
        this.restartSeen = false;
        this.staleScoreboardPhase = newQuest ? this.scoreboardPhase() : null;
        this.combatOptions = {
            roam: true,
            boundaryCheck: this.config.boundaryCheck,
            travelClicks: true,
            blacklistOnPathFailure: true,
        };
        if (phase === STATES.BOSS) this.bossModule.start(bossOrigin);
        setItemSlot(this.combatSlot);
        this.transition(phase);
        if (switchingToBoss) {
            // The selected delay or turn has already completed before entering boss combat.
            this.readyAt = Date.now();
            this.deadline = this.readyAt + RESPONSE_TIMEOUT_MS;
        }
        this.bossStartedAt = this.readyAt;
    }

    scoreboardPhase() {
        const lines = (Scoreboard.getLines() || []).map((line) => cleanLabel(line?.getName?.() ?? line));
        if (lines.some((line) => /\bBoss slain\s*!/i.test(line))) return STATES.RESTART;
        if (lines.some((line) => /\bSlay\s+the\s+boss\s*!/i.test(line))) return STATES.BOSS;
        if (lines.some((line) => /\b[\d,.]+[kmb]?\s*\/\s*[\d,.]+[kmb]?\s*\)?\s+Combat XP\b/i.test(line))) return STATES.MOBS;
        return null;
    }

    rememberMobKill(entity) {
        if (this.state !== STATES.MOBS || this.pendingBoss) return;
        if (!CombatBot.sameTarget(entity, this.lastMobTarget) && !CombatBot.sameTarget(entity, CombatBot.target)) return;
        const position = CombatBot.getTargetPosition(entity);
        if (position) this.lastKilledMobPosition = position;
        if (CombatBot.sameTarget(entity, this.lastMobTarget)) this.lastMobTarget = null;
    }

    tickCombat(guiReady) {
        if (this.state === STATES.MOBS && !this.pendingBoss) {
            for (const target of [this.lastMobTarget, CombatBot.target]) {
                const entity = target?.toMC ? target.toMC() : target;
                if (entity && (entity.isDeadOrDying?.() || target.isDead?.())) this.rememberMobKill(target);
            }
            if (CombatBot.isCombatTargetCandidate(CombatBot.target, true)) this.lastMobTarget = CombatBot.target;
        }
        let phase = this.scoreboardPhase();
        // Auto-restart chat can arrive before the previous quest disappears from the scoreboard.
        if (phase === this.staleScoreboardPhase) phase = null;
        else this.staleScoreboardPhase = null;
        if (phase === STATES.RESTART) {
            this.finishQuest();
            return;
        }
        if (this.state === STATES.MOBS && (phase === STATES.BOSS || this.pendingBoss)) {
            this.startCombat(STATES.BOSS);
            if (this.state !== STATES.MOBS || this.pendingBoss?.turnToBoss) return;
        }
        if (this.state === STATES.BOSS && Date.now() - this.bossStartedAt > 300000) {
            this.recoverSlayer('The Slayer boss fight timed out.');
            return;
        }
        if (Client.isInGui()) {
            if (this.state === STATES.BOSS) this.bossModule.pause();
            else CombatBot.toggle(false, true);
            this.noTargetSince = null;
            if (guiReady && this.isSlayerGui(getGuiName())) {
                closeInventory();
                this.defer(0, true);
            }
            return;
        }
        if (!Pathfinder.isPathing() && Player.getHeldItemIndex() !== this.combatSlot) {
            if (this.state === STATES.BOSS) this.bossModule.pause();
            else CombatBot.toggle(false, true);
            setItemSlot(this.combatSlot);
            this.defer();
            return;
        }
        if (CombatBot.enabled && !CombatBot.isParentManaged) CombatBot.toggle(false);
        let hasTarget;
        if (this.state === STATES.BOSS) hasTarget = this.bossModule.tick();
        else {
            CombatBot.setExternalTargets(CombatBot.findMob(this.config), this.combatOptions);
            CombatBot.toggle(true, true);
            const targets = CombatBot.getTargets();
            hasTarget = targets.some((target) => CombatBot.isTargetUsable(target, targets));
        }
        if (this.pendingBoss) this.noTargetSince = null;
        else if (hasTarget) {
            this.noTargetSince = null;
            this.noTargetAttempts = 0;
        } else if (this.noTargetSince === null) this.noTargetSince = Date.now();
        else {
            const timeout = this.state === STATES.BOSS ? BOSS_NO_TARGET_TIMEOUT_MS : NO_TARGET_TIMEOUT_MS;
            if (Date.now() - this.noTargetSince >= timeout) this.retryNoTarget(timeout);
        }
    }

    retryNoTarget(timeout) {
        this.questVerified = false;
        this.restartSeen = false;
        this.noTargetAttempts = Math.min(this.noTargetAttempts + 1, MAX_NO_TARGET_ATTEMPTS);
        const reason = `No Slayer target for ${timeout / 1000} seconds (${this.noTargetAttempts}/${MAX_NO_TARGET_ATTEMPTS}). ${this.locationDetails()}`;
        if (this.noTargetAttempts === 1) {
            this.message(`&e${reason} Returning to ${this.config.area} to retry.`);
            this.pathTo([this.config.destination], STATES.CALL, this.config.area, 0, true);
        } else if (this.noTargetAttempts === 2) {
            this.message(`&e${reason} Warping to Hub, then returning to ${this.config.area} to retry.`);
            this.stopCombat();
            this.recoveringSlayer = true;
            this.forceHubWarp = true;
            this.warpAttempts = 0;
            this.transition(STATES.WARP);
        } else {
            this.message(`&e${reason} Cancelling the quest and returning to the initial stage.`);
            this.restartQuestPending = true;
            this.beginMenu(true);
        }
    }

    finishQuest() {
        if (this.state !== STATES.MOBS && this.state !== STATES.BOSS) return;
        if (this.state === STATES.MOBS && !this.pendingBoss && Date.now() - this.lastCompletedAt < 5000) return;
        this.lastCompletedAt = Date.now();
        this.completed++;
        this.questPhase = null;
        if (this.checkPopulation()) return;
        if (this.restartSeen) {
            this.startCombat(STATES.MOBS, true);
            return;
        }
        this.stopCombat();
        this.menuClickDelay = true;
        this.transition(STATES.RESTART);
    }

    onChat(message) {
        if (!this.enabled) return;
        if (/^You cannot afford to start this quest!/i.test(message)) return this.fail('Not enough coins to start the Slayer quest.');
        if (/^☠ You |^SLAYER QUEST FAILED!/i.test(message)) return this.recoverSlayer('The player died or the Slayer quest failed.');
        if (!this.questVerified) return;
        if (message === 'SLAYER QUEST STARTED!') {
            if (this.state === STATES.BOSS || this.pendingBoss) this.restartSeen = true;
            else if ([STATES.RESTART, STATES.ACCEPT, STATES.CALL, STATES.PHONE, STATES.SLAYER, STATES.MENU].includes(this.state)) {
                this.startCombat(STATES.MOBS, true);
            }
        } else if (message === 'NICE! SLAYER BOSS SLAIN!') {
            this.finishQuest();
        }
    }

    onWorldUnload() {
        if (!this.enabled) return;
        const starting = this.state === STATES.STARTING;
        this.stopCombat();
        this.phoneSwap = null;
        this.questVerified = false;
        this.restartSeen = false;
        this.hopAttempts = 0;
        this.players = null;
        this.areaPlayers = null;
        this.populationStableAt = 0;
        resetAreaCache();
        this.transition(starting ? STATES.STARTING : STATES.HUB, 5000);
    }
}

new AutoSlayer();
