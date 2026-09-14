import { OverlayManager } from '../../gui/OverlayUtils';
import { GuiState } from '../../gui/core/GuiState';
import { MacroState } from '../../utils/MacroState';
import { ModuleBase } from '../../utils/ModuleBase';
import { Afk } from '../other/AfkMacro';

const TOGGLE_CONTEXT = 'ban-wave';

function parseBanTotal(message) {
    const text = ChatLib.removeFormatting(String(message)).trim();
    const match = text.match(
        /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s*)?在过去的\s*10\s*分钟内\s*[,，]\s*有\s*([\d,]+)\s*人被\s*Staff\s*封禁\s*[,，]\s*([\d,]+)\s*人被\s*Watchdog\s*封禁\s*[。.!！]?$/i
    );
    if (!match) return null;
    const total = Number(match[1].replace(/,/g, '')) + Number(match[2].replace(/,/g, ''));
    return Number.isSafeInteger(total) ? total : null;
}

class SkydiaoAutoAfk extends ModuleBase {
    constructor() {
        super({
            name: 'Skydiao - Auto AFK in Ban Wave',
            subcategory: 'Integrations',
            description: 'Pause running macros during a Skydiao ban wave and resume when the count falls.',
        });

        this.threshold = 20;
        this.previousMacros = [];
        this.afkSession = null;
        this.recoveryToken = null;
        this.pendingTotals = [];
        this.lastTotal = null;
        this.addSlider(
            'Ban Threshold',
            0,
            200,
            20,
            (value) => {
                this.threshold = value;
            },
            '10-minute Staff + Watchdog bans. Above pauses macros; below resumes them; equal keeps the current state.'
        );
        this.createOverlay([
            {
                title: 'Ban Wave',
                data: {
                    Status: () => `AFK: ${Afk.getStatus()}`,
                    'Bans (10m)': () => this.lastTotal ?? 'Unknown',
                    Threshold: () => this.threshold,
                    Resume: () => this.previousMacros.map((entry) => entry.module.name).join(', ') || 'None',
                    'Next Action': () => Afk.getNextAction(),
                },
            },
        ]);

        this.on('skydiaoSystemMessage', (message) => {
            const total = parseBanTotal(message);
            if (total !== null) this.pendingTotals.push(total);
        });
        this.on('tick', () => this.tick());
        this.on('guiOpened', () => {
            if (GuiState.macroToggleOpen) this.clearSession();
        });
        MacroState.subscribe((event) => this.onMacroChange(event));
        this.on('step', () => {
            if (this.recoveryToken && this.recoveryToken !== this.getScheduledAfkToken()) this.clearSession();
        }).setFps(2);
        this.on('gameUnload', () => this.clearSession());
    }

    ownsAfk() {
        return this.afkSession !== null && Afk.session === this.afkSession && Afk.enabled && !Afk.isParentManaged;
    }

    getScheduledAfkToken() {
        return MacroState.getModule('Scheduler')?.getRecoveryToken(Afk.name) || null;
    }

    onMacroChange({ module, enabled, context }) {
        if (!this.enabled) return;
        if (module !== Afk) {
            if (enabled && !module.isParentManaged && (this.afkSession || this.recoveryToken)) this.clearSession();
            return;
        }
        if (context === 'user') {
            this.clearSession();
            return;
        }
        if (enabled) {
            if (context === TOGGLE_CONTEXT) return;
            if (context === 'scheduler' && this.recoveryToken && this.recoveryToken === this.getScheduledAfkToken()) {
                this.afkSession = Afk.session;
                this.recoveryToken = null;
                OverlayManager.startTime(this.oid, false);
            } else this.clearSession();
            return;
        }
        if (!this.afkSession) return;
        const token = this.getScheduledAfkToken();
        if (token && ['game-state', 'world-unload', 'disconnect'].includes(context)) {
            this.afkSession = null;
            this.recoveryToken = token;
            this.pendingTotals = [];
            OverlayManager.pauseTime(this.oid);
        } else this.onAfkStopped();
    }

    tick() {
        if (this.ownsAfk() && MacroState.getEnabledMacros().some((name) => name !== Afk.name)) {
            this.clearSession();
            return;
        }
        const totals = this.pendingTotals;
        this.pendingTotals = [];
        totals.forEach((total) => {
            this.lastTotal = total;
            if (!World.isLoaded() || !Player.getPlayer()) return;
            if (total > this.threshold) this.pauseMacros();
            else if (total < this.threshold) this.resumeMacros();
        });
    }

    pauseMacros() {
        if (GuiState.macroToggleOpen || Afk.enabled || this.recoveryToken) return;
        const running = MacroState.getEnabledMacros().map((name) => MacroState.getModule(name));
        const roots = running.filter((module) => module?.enabled && module.isMacro && !module.isParentManaged && module !== Afk);
        if (!roots.length) return;

        roots.forEach((module) => module.toggle(false, false, TOGGLE_CONTEXT));
        running.forEach((module) => {
            if (module?.enabled && module !== Afk) module.toggle(false, true, TOGGLE_CONTEXT);
        });
        this.previousMacros = roots.map((module) => ({ module, disableMeta: MacroState.getLastDisableMeta(module.name) }));
        Afk.toggle(true, false, TOGGLE_CONTEXT);
        if (!Afk.enabled) {
            this.previousMacros = [];
            return;
        }
        this.afkSession = Afk.session;
        OverlayManager.startTime(this.oid, false);
        this.message(`&e${this.lastTotal} bans in 10 minutes. Macros paused; AFK started.`);
    }

    resumeMacros() {
        if (!this.ownsAfk()) return;
        const previous = this.previousMacros;
        Afk.toggle(false, false, TOGGLE_CONTEXT);
        previous.forEach(({ module, disableMeta }) => {
            if (!module.enabled && MacroState.getLastDisableMeta(module.name) === disableMeta) {
                module.toggle(true, false, TOGGLE_CONTEXT);
            }
        });
        this.message(`&a${this.lastTotal} bans in 10 minutes. AFK stopped; previous macros resumed.`);
    }

    onAfkStopped() {
        this.previousMacros = [];
        this.afkSession = null;
        this.recoveryToken = null;
        this.pendingTotals = [];
        OverlayManager.resetTime(this.oid);
    }

    clearSession() {
        this.pendingTotals = [];
        if (this.recoveryToken) MacroState.getModule('Scheduler')?.cancelScheduledMacro(Afk.name);
        if (this.ownsAfk()) Afk.toggle(false, false, TOGGLE_CONTEXT);
        this.onAfkStopped();
    }

    onEnable() {
        this.lastTotal = null;
        this.clearSession();
        this.message('&aListening for Skydiao 10-minute ban reports.');
    }

    onDisable() {
        this.clearSession();
        this.lastTotal = null;
        this.message('&cDisabled. Resume history cleared.');
    }
}

new SkydiaoAutoAfk();
