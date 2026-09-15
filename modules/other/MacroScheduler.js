import { OverlayManager } from '../../gui/OverlayUtils';
import { GameState } from '../../utils/GameState';
import { MacroState } from '../../utils/MacroState';
import { ModuleBase } from '../../utils/ModuleBase';
import { TimeUtils } from '../../utils/TimeUtils';
import { Mouse } from '../../utils/Ungrab';
import { Utils } from '../../utils/Utils';

const STATE = { IDLE: 'Idle', RUNNING: 'Running', PAUSED: 'Paused', RESTING: 'Resting', RETURNING: 'Returning', WORLD: 'Changing world' };

const scheduleForCurrentGeneration = (callback) => {
    const generation = ChatTriggers.getScriptGeneration();
    Client.scheduleTask(() => {
        if (ChatTriggers.isScriptGenerationCurrent(generation)) callback();
    });
};

class MacroScheduler extends ModuleBase {
    constructor() {
        super({
            name: 'Scheduler',
            subcategory: 'Core',
            description: 'Automates macro sessions, breaks, and relogging.',
            theme: '#7c8cff',
            hideInModules: true,
        });
        this.macroTimeMin = 80;
        this.macroTimeMax = 140;
        this.breakTimeMin = 50;
        this.breakTimeMax = 100;
        this.restoreAfterWorldChange = false;
        this.restoreAfterDisconnect = false;
        this.configPath = 'scheduler_data.json';
        this.state = STATE.IDLE;
        this.candidates = new Map();
        this.timerEnd = 0;
        this.remainingMs = 0;
        this.server = '';
        this.returnStep = 0;
        this.readyAt = 0;
        this.overlayShown = false;
        this.manualHold = false;
        this.disconnectRequested = false;
        this.restInputReleased = false;
        this.generation = 0;

        const section = 'Scheduler';
        this.addDirectToggle('Enable Scheduler', (value) => this.toggle(!!value), 'Toggles the scheduler.', true, section);
        this.addDirectToggle(
            'Restore After World Change',
            (value) => {
                this.restoreAfterWorldChange = !!value;
            },
            'Resume macros automatically stopped by changing worlds or server transfers. Applies to pending recovery immediately.',
            false,
            section
        );
        this.addDirectToggle(
            'Restore After Disconnect',
            (value) => {
                this.restoreAfterDisconnect = !!value;
            },
            'Also resume world-unload-sensitive macros after scheduled breaks or unexpected disconnects. Manual disconnects and bans never resume macros.',
            false,
            section
        );
        this.addDirectRangeSlider(
            'Macro Duration (m)',
            1,
            240,
            { low: 80, high: 140 },
            (value) => {
                this.macroTimeMin = value.low;
                this.macroTimeMax = value.high;
            },
            'Minimum and maximum session duration.',
            section
        );
        this.addDirectRangeSlider(
            'Break Duration (m)',
            1,
            180,
            { low: 50, high: 100 },
            (value) => {
                this.breakTimeMin = value.low;
                this.breakTimeMax = value.high;
            },
            'Minimum and maximum break duration.',
            section
        );
        this.createSchedulerOverlay([
            {
                title: 'Scheduler',
                data: {
                    Status: () => this.state,
                    'Time Left': () => this.formatTimeLeft(),
                    Active: () => this.getSchedulableMacros().join(', ') || 'None',
                    Resume: () => this.getRecoveryNames().join(', ') || 'None',
                },
            },
        ]);

        this.loadState();
        GameState.subscribe((event) => this.onGameState(event), 100);
        MacroState.subscribe((event) => this.onMacroChange(event));
        register('gameUnload', () => this.saveState());
        this.on('step', () => this.tick()).setFps(20);
    }

    loadState() {
        const data = Utils.getConfigFile(this.configPath);
        // Old trackedMacros mixed running state with recovery intent and cannot be migrated safely.
        if (data?.version !== 2 || ![STATE.RESTING, STATE.RETURNING].includes(data.state)) return;
        if (typeof data.server !== 'string' || !data.server) return;
        this.server = data.server;
        this.state = data.state;
        this.timerEnd = Number.isFinite(data.timerEnd) ? data.timerEnd : 0;
        this.remainingMs = Number.isFinite(data.remainingMs) ? Math.max(0, data.remainingMs) : 0;
        (Array.isArray(data.candidates) ? data.candidates : []).forEach((entry) => {
            if (typeof entry?.name === 'string')
                this.candidates.set(entry.name, { ...entry, recoveryKind: entry.recoveryKind === 'world' ? 'world' : 'disconnect', persisted: true });
        });
        if (!this.candidates.size) this.state = STATE.IDLE;
    }

    saveState() {
        Utils.writeConfigFile(this.configPath, {
            version: 2,
            state: this.state,
            server: this.server,
            timerEnd: this.timerEnd,
            remainingMs: this.remainingMs,
            candidates: Array.from(this.candidates.values()).map(({ name, worldStopped, recoveryKind, token }) => ({
                name,
                worldStopped,
                recoveryKind,
                token,
            })),
        });
    }

    onEnable() {
        const event = GameState.current;
        if (event.state === 'DISCONNECTED' && ['manual', 'banned'].includes(event.cause)) this.cancelRecovery(true);
        if (event.state === 'PLAYING') this.readyAt = Date.now() + 5000;
        this.updateOverlay();
        this.message('&aStarted.');
    }

    onDisable() {
        this.cancelRecovery();
        this.updateOverlay();
        this.message('&cStopped.');
    }

    isRecovering() {
        return [STATE.RESTING, STATE.RETURNING, STATE.WORLD].includes(this.state);
    }

    onGameState(event) {
        if (!this.enabled) return;
        if (
            (event.state === 'DISCONNECTED' && ['manual', 'banned'].includes(event.cause)) ||
            (event.state === 'CONNECTING' && event.cause !== 'transfer' && event.source !== 'scheduler')
        ) {
            this.cancelRecovery(true);
            if (event.cause === 'banned') this.message('&cBan detected. Automatic recovery cancelled.');
            return;
        }
        if (event.state === 'PLAYING') {
            this.server = event.server || this.server;
            this.readyAt = Date.now() + 5000;
            return;
        }
        if (this.manualHold) return;
        if (event.state === 'TRANSITION') {
            this.generation++;
            this.readyAt = 0;
            if (this.state === STATE.RUNNING) {
                this.remainingMs = Math.max(0, this.timerEnd - Date.now());
                this.state = STATE.WORLD;
            }
            return;
        }
        if (event.state !== 'DISCONNECTED') return;
        if (!this.getSchedulableMacros().length && !this.isRecovering()) return;
        if (this.state === STATE.RUNNING) this.remainingMs = Math.max(0, this.timerEnd - Date.now());
        this.server = event.server || this.server;
        this.disconnectRequested = false;
        this.readyAt = 0;
        this.returnStep = 0;
        this.generation++;
        if (event.cause === 'script') {
            this.state = STATE.RESTING;
            this.remainingMs = 0;
            this.timerEnd = Date.now() + this.randomDuration(this.breakTimeMin, this.breakTimeMax);
            this.message(`&eResting for ${TimeUtils.formatDurationMs(this.timerEnd - Date.now())}.`);
        } else {
            this.state = STATE.RETURNING;
            this.timerEnd = Date.now() + 7000 + Math.random() * 6000;
            this.message('&eUnexpected disconnect. Recovery scheduled.');
        }
        this.releaseInputForRest();
        this.saveState();
    }

    onMacroChange({ module, enabled, context, meta }) {
        this.updateOverlay();
        if (!this.enabled || !module.isMacro) return;
        if (enabled) {
            if (context === 'scheduler' || module.isParentManaged) return;
            if (this.isRecovering()) this.cancelRecovery();
            this.candidates.delete(module.name);
            this.manualHold = false;
            return;
        }
        if (meta?.isParentManaged) return;
        const automatic = ['world-unload', 'game-state', 'disconnect'].includes(context);
        if (automatic && this.isRecovering() && !this.manualHold) {
            this.candidates.set(module.name, {
                name: module.name,
                worldStopped: module.autoDisableOnWorldUnload || context === 'world-unload',
                recoveryKind: meta.gameState.state === 'DISCONNECTED' ? 'disconnect' : 'world',
                meta,
                token: `${meta.timestamp}:${meta.gameState.id}`,
            });
            this.saveState();
        } else if (!automatic) {
            this.candidates.delete(module.name);
            this.saveState();
        }
    }

    getRecoveryNames() {
        return Array.from(this.candidates.values())
            .filter((entry) => {
                const module = MacroState.getModule(entry.name);
                return (
                    module?.isMacro &&
                    !module.isParentManaged &&
                    (!entry.persisted || module.resumeAfterReload !== false) &&
                    (!(entry.worldStopped || module.autoDisableOnWorldUnload) ||
                        (entry.recoveryKind === 'world' ? this.restoreAfterWorldChange : this.restoreAfterDisconnect)) &&
                    (entry.persisted || MacroState.getLastDisableMeta(entry.name) === entry.meta)
                );
            })
            .map((entry) => entry.name);
    }

    getRecoveryToken(name) {
        return this.enabled && this.isRecovering() ? this.candidates.get(name)?.token || null : null;
    }

    cancelScheduledMacro(name) {
        if (!this.enabled || !this.isRecovering() || !this.candidates.has(name)) return false;
        this.candidates.delete(name);
        if (!this.candidates.size) this.cancelRecovery();
        else this.saveState();
        this.message(`&e${name} recovery cancelled.`);
        return true;
    }

    cancelRecovery(manual = false) {
        this.generation++;
        this.restoreRestInput();
        this.state = STATE.IDLE;
        this.candidates.clear();
        this.timerEnd = 0;
        this.remainingMs = 0;
        this.returnStep = 0;
        this.readyAt = 0;
        this.disconnectRequested = false;
        this.manualHold = manual;
        this.saveState();
    }

    tick() {
        this.updateOverlay();
        const now = Date.now();
        if (this.restInputReleased && this.isWorldReady() && !this.restoreRestInput()) return;
        if ([STATE.IDLE, STATE.PAUSED].includes(this.state)) {
            if (!this.manualHold && this.isWorldReady() && GameState.current.server && this.getSchedulableMacros().length) this.beginSession();
            return;
        }
        if (this.state === STATE.RUNNING) {
            if (!this.getSchedulableMacros().length) {
                this.remainingMs = Math.max(0, this.timerEnd - now);
                this.state = STATE.PAUSED;
                this.saveState();
            } else if (now >= this.timerEnd && !this.disconnectRequested) {
                this.disconnectRequested = true;
                const generation = this.generation;
                scheduleForCurrentGeneration(() => {
                    if (this.enabled && generation === this.generation && this.state === STATE.RUNNING)
                        GameState.disconnect('Scheduler: taking a break', 'scheduler');
                });
            }
            return;
        }
        if (this.state === STATE.WORLD) {
            if (this.isWorldReady() && this.readyAt && now >= this.readyAt) this.restoreMacros();
            return;
        }
        if (this.state === STATE.RESTING) {
            this.releaseInputForRest();
            if (now < this.timerEnd) return;
            this.state = STATE.RETURNING;
            this.returnStep = 0;
            this.saveState();
        }
        if (!this.getRecoveryNames().length && now >= this.timerEnd) {
            this.cancelRecovery();
            return;
        }
        if (this.isWorldReady()) {
            if (!this.readyAt || now < this.readyAt) return;
            if (this.isHypixel() && !this.isSkyblock()) {
                if (now < this.timerEnd && this.returnStep === 2) return;
                this.returnStep = 2;
                this.timerEnd = now + 15000;
                const generation = this.generation;
                scheduleForCurrentGeneration(() => {
                    if (this.enabled && this.generation === generation && this.isWorldReady()) ChatLib.command('play skyblock');
                });
                return;
            }
            this.restoreMacros();
            return;
        }
        this.releaseInputForRest();
        if (now < this.timerEnd || !this.server) return;
        this.timerEnd = now + 30000;
        this.returnStep = 1;
        const generation = this.generation;
        scheduleForCurrentGeneration(() => {
            if (this.enabled && this.generation === generation && this.state === STATE.RETURNING && !World.isLoaded())
                GameState.connect(this.server, 'scheduler');
        });
        this.saveState();
    }

    restoreMacros() {
        const generation = this.generation;
        const worldEventId = GameState.current.id;
        const names = this.getRecoveryNames();
        this.readyAt = Date.now() + 5000;
        scheduleForCurrentGeneration(() => {
            if (!this.enabled || generation !== this.generation || worldEventId !== GameState.current.id || !this.isWorldReady()) return;
            names.forEach((name) => {
                if (generation !== this.generation) return;
                if (!this.getRecoveryNames().includes(name)) return;
                const module = MacroState.getModule(name);
                if (!module.enabled) module.toggle(true, false, 'scheduler');
            });
            if (generation !== this.generation) return;
            this.candidates.clear();
            if (this.getSchedulableMacros().length) this.beginSession();
            else {
                this.state = STATE.PAUSED;
                this.saveState();
            }
        });
    }

    beginSession() {
        this.state = STATE.RUNNING;
        this.timerEnd = Date.now() + (this.remainingMs || this.randomDuration(this.macroTimeMin, this.macroTimeMax));
        this.remainingMs = 0;
        this.returnStep = 0;
        this.disconnectRequested = false;
        this.server = GameState.current.server || this.server;
        this.saveState();
    }

    isWorldReady() {
        return GameState.current.state === 'PLAYING' && World.isLoaded() && !!Player.getPlayer();
    }

    isHypixel() {
        return /(^|\.)hypixel\.net(?::\d+)?$/i.test(this.server);
    }

    isSkyblock() {
        return ChatLib.removeFormatting(String(Scoreboard.getTitle())).includes('SKYBLOCK');
    }

    getSchedulableMacros() {
        return MacroState.getEnabledMacros().filter((name) => !MacroState.getModule(name)?.isParentManaged);
    }

    randomDuration(min, max) {
        return (Math.min(min, max) + Math.random() * Math.abs(max - min)) * 60000;
    }

    releaseInputForRest() {
        if (GameState.current.state !== 'DISCONNECTED') return;
        // Macro shutdown callbacks may regrab after the disconnect event, so enforce this while offline.
        this.restInputReleased = true;
        Mouse.ungrab();
    }

    restoreRestInput() {
        if (!this.restInputReleased) return true;
        if (GameState.current.state === 'PLAYING' && Client.getMinecraft().screen != null) return false;
        this.restInputReleased = false;
        Mouse.regrab();
        return true;
    }

    updateOverlay() {
        const visible = this.enabled && ![STATE.IDLE, STATE.PAUSED].includes(this.state) && (this.getSchedulableMacros().length > 0 || this.isRecovering());
        if (visible && !this.overlayShown) OverlayManager.startTime(this.oid, true);
        else if (!visible && (this.overlayShown || OverlayManager.startTimes[this.oid] !== undefined)) OverlayManager.resetTime(this.oid);
        this.overlayShown = visible;
    }

    formatTimeLeft() {
        if (this.state === STATE.IDLE) return this.manualHold ? 'Manual control' : 'Waiting';
        if (this.state === STATE.WORLD) return 'Waiting for world';
        return TimeUtils.formatDurationMs(Math.max(0, this.state === STATE.PAUSED ? this.remainingMs : this.timerEnd - Date.now()));
    }
}

new MacroScheduler();
