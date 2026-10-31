import { ArmorStandEntity } from '../../utils/Constants';
import { finiteNumber } from '../../utils/NumberUtils';
import Pathfinder from '../../utils/pathfinder/PathFinder';
import { GuiStability } from '../../utils/player/GuiStability';
import { clickSlot, closeInventory, findItemInHotbar, getGuiName, setItemSlot } from '../../utils/player/Inventory';
import { Rotations } from '../../utils/player/Rotations';
import { Raytrace } from '../../utils/Raytrace';
import { getArea, getTabListNames, resetAreaCache } from '../../utils/TabListUtils';

const STATES = {
    IDLE: 'Idle',
    STARTING: 'Starting in 5 seconds',
    WARP: 'Warping to Hub',
    HUB: 'Checking Hub population',
    TRAVEL: 'Traveling',
    SELECTOR: 'Opening Hub Selector',
    HOP: 'Switching Hub',
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
        area: 'Crypts',
        destination: [-146, 56, -100],
        names: ['Crypt Ghoul', 'Golden Ghoul', 'Revenant Sycophant', 'Revenant Champion', 'Deformed Revenant'],
        boundaryCheck: (x, y, z) => x >= -240 && x <= -65 && y >= 30 && y <= 67 && z >= -220 && z <= -55,
    },
    Wolf: {
        boss: 'Sven Packmaster',
        area: 'Ruins',
        destination: [-200, 89, 40],
        names: ['Wolf', 'Old Wolf', 'Pack Enforcer', 'Sven Follower', 'Sven Alpha'],
        boundaryCheck: (x, y, z) => x >= -300 && x <= -100 && y >= 55 && y <= 155 && z >= -65 && z <= 180,
    },
};
const TIERS = ['I', 'II', 'III', 'IV'];
const HUB_SELECTOR = [-5.5, 69, -22.5];
const MAX_ATTEMPTS = 4;
const RESPONSE_TIMEOUT_MS = 15000;
const clean = (value) => ChatLib.removeFormatting(String(value ?? '')).trim();

export class AutoSlayer {
    constructor(bot) {
        this.bot = bot;
        this.enabled = false;
        this.active = false;
        this.type = 'Zombie';
        this.tier = 1;
        this.phone = 'Maddox Batphone';
        this.maxPlayers = 1;
        this.weaponSlot = 1;
        this.actionDelay = { low: 1, high: 3 };
        this.state = STATES.IDLE;
        this.revision = 0;
        this.guiStability = new GuiStability();
        this.players = null;
        this.completed = 0;

        bot.addToggle(
            'Auto Slayer',
            (value) => (this.enabled = !!value),
            'Run Slayer quests when Combat Bot is enabled. Mode changes apply on the next start.'
        );
        bot.addMultiToggle(
            'Slayer Type',
            Object.keys(SLAYERS),
            true,
            (selected) => (this.type = selected.find((option) => option.enabled)?.name || 'Zombie'),
            'Zombie: Revenant Horror in the Crypts. Wolf: Sven Packmaster in the Ruins. Applies on the next start.',
            'Zombie'
        );
        bot.addSlider(
            'Slayer Tier',
            1,
            4,
            1,
            (value) => (this.tier = Math.max(1, Math.min(4, Math.round(finiteNumber(value, 1))))),
            'Tier I-IV. Applies on the next start.'
        );
        bot.addMultiToggle(
            'Slayer Phone',
            ['Maddox Batphone', 'Abiphone'],
            true,
            (selected) => (this.phone = selected.find((option) => option.enabled)?.name || 'Maddox Batphone'),
            'Keep the selected phone in your hotbar. Abiphone requires the Maddox the Slayer contact. Applies on the next start.',
            'Maddox Batphone'
        );
        bot.addSlider(
            'Slayer Hub Player Limit',
            1,
            80,
            1,
            (value) => (this.maxPlayers = Math.max(1, Math.min(80, Math.round(finiteNumber(value, 1))))),
            'Maximum Hub population, including yourself. Uses the Hub Selector to find a small random Hub.'
        );
        bot.addSlider(
            'Slayer Weapon Slot',
            1,
            8,
            1,
            (value) => (this.weaponSlot = Math.max(1, Math.min(8, Math.round(finiteNumber(value, 1))))),
            'Hotbar slot to restore after calling Maddox. Applies on the next start.'
        );
        bot.addRangeSlider(
            'Slayer Action Delay (s)',
            0,
            10,
            this.actionDelay,
            (value) => (this.actionDelay = value),
            'Random minimum/maximum delay for travel, phone use, menu clicks and phase changes. Attacks use Combat Bot CPS.'
        );

        bot.on('chat', (event) => this.onChat(clean(event.message.getUnformattedText())));
        bot.on('worldUnload', () => this.onWorldUnload());
        bot.on('worldLoad', () => {
            if (!this.active) return;
            resetAreaCache();
            this.players = null;
            this.populationStableAt = 0;
            this.transition(this.state === STATES.STARTING ? STATES.STARTING : STATES.HUB, 5000);
        });
    }

    start() {
        if (!this.enabled || this.bot.isParentManaged) return;
        this.active = true;
        this.config = SLAYERS[this.type] || SLAYERS.Zombie;
        this.questName = `${this.config.boss} ${TIERS[this.tier - 1]}`;
        this.callMethod = this.phone;
        this.combatSlot = this.weaponSlot - 1;
        this.originalSlot = Player.getHeldItemIndex();
        this.menuAttempts = 0;
        this.warpAttempts = 0;
        this.hopAttempts = 0;
        this.completed = 0;
        this.lastCompletedAt = 0;
        this.players = null;
        this.populationStableAt = 0;
        this.questVerified = false;
        this.restartSeen = false;
        this.stopCombat();
        this.transition(STATES.STARTING, 5000);
        this.bot.message(`&aAuto Slayer: ${this.questName}. Starting in 5 seconds; toggle Combat Bot off to cancel.`);
    }

    stop() {
        if (!this.active) return;
        this.active = false;
        this.revision++;
        this.state = STATES.IDLE;
        this.questVerified = false;
        this.bossTarget = null;
        this.guiStability.reset();
        if (this.isSlayerGui(getGuiName()) || getGuiName()?.includes('Hub Selector')) closeInventory();
        if (Player.getPlayer()) setItemSlot(this.originalSlot);
    }

    fail(reason) {
        this.bot.message(`&cAuto Slayer: ${reason} Stopping macro.`);
        this.bot.toggle(false);
    }

    randomDelay() {
        const first = Math.max(0, Math.min(10, finiteNumber(this.actionDelay?.low, 1)));
        const second = Math.max(0, Math.min(10, finiteNumber(this.actionDelay?.high, 3)));
        return (Math.min(first, second) + Math.random() * Math.abs(first - second)) * 1000;
    }

    defer(minimum = 0) {
        this.readyAt = Date.now() + minimum + this.randomDelay();
        this.deadline = this.readyAt + RESPONSE_TIMEOUT_MS;
    }

    transition(state, minimum = 0) {
        this.revision++;
        this.state = state;
        this.defer(minimum);
        this.guiStability.reset();
    }

    stopCombat() {
        this.bot.cancelPath();
        this.bot.setTarget(null);
        this.bot.pauseMovement();
        Client.stopMovement();
        Client.setKey('leftclick', false);
        Client.setKey('rightclick', false);
        Rotations.stop();
        this.bot.targets = [];
        this.bot.spawnLocations = [];
        this.bot.roamOrigin = null;
        this.bot.blacklistedTargets.clear();
        this.bot.targetFailureCounts.clear();
        this.bossTarget = null;
    }

    tick() {
        if (!this.active) return true;
        const guiReady = this.guiStability.update();
        if (Date.now() < this.readyAt) return false;

        if (this.state === STATES.MOBS || this.state === STATES.BOSS) return this.tickCombat(guiReady);

        switch (this.state) {
            case STATES.STARTING:
                if (findItemInHotbar(this.callMethod) === -1) return this.fail(`${this.callMethod} is missing from the hotbar.`);
                if (!Player.getInventory()?.getStackInSlot(this.combatSlot) || findItemInHotbar(this.callMethod) === this.combatSlot) {
                    return this.fail('Select an occupied Slayer Weapon Slot different from the phone slot.');
                }
                this.transition(STATES.WARP);
                break;
            case STATES.WARP:
                if (Client.isInGui()) {
                    closeInventory();
                    this.defer(150);
                    break;
                }
                if (++this.warpAttempts > MAX_ATTEMPTS) return this.fail('Could not travel to the Hub.');
                ChatLib.command('hub');
                this.transition(STATES.HUB, 3000);
                break;
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
                    this.transition(STATES.SELECTOR);
                }
                break;
            case STATES.CALL:
                if (guiReady) this.callMaddox();
                else if (Date.now() >= this.deadline) this.retryMenu();
                break;
            case STATES.RESTART:
                this.beginMenu();
                break;
            default:
                if (guiReady) this.handleMenu();
                else if (Date.now() >= this.deadline) this.retryMenu();
                break;
        }
        return false;
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

    checkHub() {
        if (getArea() !== 'Hub') {
            if (Date.now() >= this.deadline) this.transition(STATES.WARP);
            return;
        }
        const count = this.readPopulation();
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
        this.warpAttempts = 0;
        if (count > this.maxPlayers) {
            this.bot.message(`Auto Slayer: Hub has ${count} players (limit ${this.maxPlayers}). Finding another Hub.`);
            this.selectorClicks = 0;
            this.selectorAimed = false;
            const npc = this.findSelector();
            const position = npc ? this.bot.getTargetPosition(npc) : { x: HUB_SELECTOR[0], y: HUB_SELECTOR[1], z: HUB_SELECTOR[2] };
            this.pathTo(this.bot.buildPathGoals(position), STATES.SELECTOR, 'Hub Selector');
        } else {
            this.bot.message(`&aAuto Slayer: Hub has ${count} player(s). Traveling to ${this.config.area}.`);
            this.menuAttempts = 0;
            this.pathTo([this.config.destination], STATES.CALL, this.config.area);
        }
    }

    pathTo(goals, nextState, destination) {
        this.stopCombat();
        this.pathGoals = goals;
        this.afterTravel = nextState;
        this.destination = destination;
        this.pathPending = false;
        this.pathAttempts = 0;
        this.transition(STATES.TRAVEL);
    }

    travel() {
        if (this.pathPending) {
            if (Date.now() >= this.deadline) this.fail(`Travel to ${this.destination} timed out.`);
            return;
        }
        this.pathPending = true;
        this.pathAttempts++;
        this.deadline = Date.now() + 120000;
        const revision = this.revision;
        Pathfinder.findPath(
            this.pathGoals,
            (success) => {
                if (!this.active || this.state !== STATES.TRAVEL || this.revision !== revision) return;
                this.pathPending = false;
                if (success) this.transition(this.afterTravel);
                else if (this.pathAttempts >= MAX_ATTEMPTS) this.fail(`No path to ${this.destination}.`);
                else this.defer(1000);
            },
            { walkArrivalRadius: 2 }
        );
    }

    findSelector() {
        const named = World.getAllEntities().find((entity) => clean(entity.getName()).toLowerCase() === 'hub selector');
        if (!named) return null;
        return named.toMC() instanceof ArmorStandEntity ? this.bot.resolveNametagTarget(named, World.getAllPlayers()) : named;
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
            this.defer(250);
            return;
        }
        const npc = this.findSelector();
        if (!npc) {
            if (Date.now() >= this.deadline) this.fail('Cannot find the Hub Selector NPC.');
            return;
        }
        const position = this.bot.getTargetPosition(npc);
        if (this.bot.getDistanceToPlayer(position).distance > 3.5) {
            this.pathTo(this.bot.buildPathGoals(position), STATES.SELECTOR, 'Hub Selector');
            return;
        }
        if (this.selectorAimed) {
            this.selectorAimed = false;
            if (Raytrace.isLookingAtEntity(npc, 4.5)) {
                Client.leftClick();
                this.defer(4000);
            }
            return;
        }
        if (this.selectorClicks >= MAX_ATTEMPTS || Date.now() >= this.deadline) return this.fail('Hub Selector did not open.');
        if (Rotations.active) return;
        this.selectorClicks++;
        const revision = this.revision;
        Rotations.lookAtVector([position.x, position.y + 1.5, position.z]);
        Rotations.onComplete(() => {
            if (!this.active || this.state !== STATES.SELECTOR || revision !== this.revision) return;
            this.selectorAimed = true;
            this.defer();
        });
    }

    isSlayerGui(name) {
        return name === 'Slayer' || name === this.config?.boss || name === 'Confirm' || name?.includes('Abiphone');
    }

    findMenuItem(name) {
        const items = Player.getContainer()?.getItems() || [];
        for (let slot = 0; slot < items.length - 36; slot++) {
            const item = items[slot];
            if (item && clean(item.getName()).toLowerCase() === name.toLowerCase()) return { slot, item };
        }
        return null;
    }

    lore(entry) {
        return (entry.item.getLore() || []).map(clean).join('\n');
    }

    click(entry, nextState, button = 'LEFT') {
        if (clickSlot(entry.slot, false, button)) this.transition(nextState);
    }

    beginMenu() {
        this.stopCombat();
        this.menuAttempts = 0;
        this.transition(STATES.CALL);
    }

    retryMenu() {
        if (++this.menuAttempts >= MAX_ATTEMPTS) return this.fail(`Timed out during ${this.state.toLowerCase()} after ${MAX_ATTEMPTS} attempts.`);
        this.bot.message(`&eAuto Slayer: ${this.state} timed out; calling Maddox again.`);
        if (Client.isInGui()) closeInventory();
        this.transition(STATES.CALL, 1000);
    }

    callMaddox() {
        if (getGuiName() === 'Slayer') {
            this.transition(STATES.MENU);
            return;
        }
        if (Client.isInGui()) {
            closeInventory();
            this.defer(150);
            return;
        }
        const slot = findItemInHotbar(this.callMethod);
        if (slot === -1) return this.fail(`${this.callMethod} is missing from the hotbar.`);
        if (Player.getHeldItemIndex() !== slot) {
            setItemSlot(slot);
            this.defer(150);
            return;
        }
        Client.rightClick();
        this.transition(this.callMethod === 'Abiphone' ? STATES.PHONE : STATES.SLAYER);
    }

    handleMenu() {
        const name = getGuiName();
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
                if (name === 'Slayer' && !this.findMenuItem('Slayer Quest Complete!') && this.findMenuItem(this.config.boss)) {
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
                    this.startCombat(STATES.MOBS);
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
        const reward = this.findMenuItem('Slayer Quest Complete!');
        if (reward) {
            this.questVerified = false;
            this.click(reward, STATES.CLAIM);
            return true;
        }
        const ongoing = this.findMenuItem('Ongoing Slayer Quest');
        if (ongoing) {
            const lore = this.lore(ongoing);
            const boss = lore.match(/^Boss:\s*(.+?)\s*$/m)?.[1];
            if (!boss) return false;
            if (boss === this.questName) {
                this.questVerified = true;
                const phase = /slay the boss|kill the boss/i.test(lore) || this.scoreboardPhase() === STATES.BOSS ? STATES.BOSS : STATES.MOBS;
                this.startCombat(phase);
            } else {
                this.questVerified = false;
                this.click(ongoing, STATES.CANCEL);
            }
            return true;
        }
        const category = this.findMenuItem(this.config.boss);
        if (!category) return false;
        this.questVerified = false;
        this.click(category, STATES.TIERS);
        return true;
    }

    startCombat(phase) {
        this.stopCombat();
        if (Client.isInGui()) closeInventory();
        this.menuAttempts = 0;
        this.restartSeen = false;
        this.bossOrigin = { x: Player.getX(), y: Player.getY(), z: Player.getZ() };
        this.bossStartedAt = Date.now();
        this.staleScoreboardPhase = this.scoreboardPhase();
        setItemSlot(this.combatSlot);
        this.transition(phase, 150);
    }

    scoreboardPhase() {
        const lines = (Scoreboard.getLines() || []).map((line) => clean(line?.getName?.() ?? line));
        if (!lines.includes(this.questName)) return null;
        if (lines.some((line) => /^Boss slain!/i.test(line))) return STATES.RESTART;
        if (lines.some((line) => /^Slay the boss!/i.test(line))) return STATES.BOSS;
        return null;
    }

    tickCombat(guiReady) {
        let phase = this.scoreboardPhase();
        // Auto-restart chat can arrive before the previous quest disappears from the scoreboard.
        if (phase === this.staleScoreboardPhase) phase = null;
        else this.staleScoreboardPhase = null;
        if (phase === STATES.RESTART) {
            this.finishQuest();
            return false;
        }
        if (this.state === STATES.MOBS && phase === STATES.BOSS) {
            this.startCombat(STATES.BOSS);
            return false;
        }
        if (this.state === STATES.BOSS && Date.now() - this.bossStartedAt > 300000) {
            this.fail('The Slayer boss fight timed out.');
            return false;
        }
        if (Client.isInGui()) {
            this.bot.pauseMovement();
            if (guiReady && this.isSlayerGui(getGuiName())) {
                closeInventory();
                this.defer(150);
            }
            return false;
        }
        if (!Pathfinder.isPathing() && Player.getHeldItemIndex() !== this.combatSlot) {
            this.bot.pauseMovement();
            setItemSlot(this.combatSlot);
            this.defer(150);
            return false;
        }
        return true;
    }

    getTargets() {
        if (this.state === STATES.MOBS) return this.bot.findMob(this.config);
        if (this.state !== STATES.BOSS) return [];
        if (this.bossTarget) return this.bot.isCombatTargetCandidate(this.bossTarget, true) ? [this.bossTarget] : [];
        let bosses = this.bot.findMob({ names: [this.config.boss] });
        const otherBosses = new Set();
        for (const entity of World.getAllEntities()) {
            const owner = clean(entity.getName())
                .toLowerCase()
                .match(/^spawned by:\s*(\w+)$/)?.[1];
            if (!owner) continue;
            const boss = this.bot.resolveNametagTarget(entity, bosses);
            if (!boss) continue;
            if (owner === Player.getName().toLowerCase()) this.bossTarget = boss;
            else otherBosses.add(this.bot.getTargetUuid(boss));
        }
        if (!this.bossTarget) {
            if (Date.now() - this.bossStartedAt < 1500) return [];
            bosses = bosses.filter(
                (boss) =>
                    !otherBosses.has(this.bot.getTargetUuid(boss)) &&
                    this.bot.getDistanceBetween(this.bot.getTargetPosition(boss), this.bossOrigin).distance < 64
            );
            bosses.sort((first, second) => {
                return (
                    this.bot.getDistanceBetween(this.bot.getTargetPosition(first), this.bossOrigin).distance -
                    this.bot.getDistanceBetween(this.bot.getTargetPosition(second), this.bossOrigin).distance
                );
            });
            this.bossTarget = bosses[0] || null;
        }
        return this.bossTarget ? [this.bossTarget] : [];
    }

    canRoam(position) {
        return this.state === STATES.MOBS && this.config.boundaryCheck(position.x, position.y, position.z);
    }

    get fightingBoss() {
        return this.active && this.state === STATES.BOSS;
    }

    finishQuest() {
        if (this.state !== STATES.MOBS && this.state !== STATES.BOSS) return;
        if (this.state === STATES.MOBS && Date.now() - this.lastCompletedAt < 5000) return;
        this.lastCompletedAt = Date.now();
        this.completed++;
        if (this.restartSeen) {
            this.startCombat(STATES.MOBS);
            return;
        }
        this.stopCombat();
        this.transition(STATES.RESTART, 5000);
    }

    onChat(message) {
        if (!this.active) return;
        if (/^You cannot afford to start this quest!/i.test(message)) return this.fail('Not enough coins to start the Slayer quest.');
        if (/^☠ You |^SLAYER QUEST FAILED!/i.test(message)) return this.fail('The player died or the Slayer quest failed.');
        if (!this.questVerified) return;
        if (message === 'SLAYER QUEST STARTED!') {
            if (this.state === STATES.BOSS) this.restartSeen = true;
            else if ([STATES.RESTART, STATES.ACCEPT, STATES.CALL, STATES.PHONE, STATES.SLAYER, STATES.MENU].includes(this.state)) {
                this.startCombat(STATES.MOBS);
            }
        } else if (message === `SLAYER BOSS! The ${this.questName} spawned!` && (this.state === STATES.MOBS || this.state === STATES.ACCEPT)) {
            this.startCombat(STATES.BOSS);
        } else if (message === 'NICE! SLAYER BOSS SLAIN!') {
            this.finishQuest();
        }
    }

    onWorldUnload() {
        if (!this.active) return;
        const starting = this.state === STATES.STARTING;
        this.stopCombat();
        this.questVerified = false;
        this.restartSeen = false;
        this.hopAttempts = 0;
        this.players = null;
        this.populationStableAt = 0;
        resetAreaCache();
        this.transition(starting ? STATES.STARTING : STATES.HUB, 5000);
    }
}
