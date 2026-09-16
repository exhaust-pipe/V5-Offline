import { Chat } from './Chat';
import { TimeUtils } from './TimeUtils';
import { Utils } from './Utils';
import { GameState } from './GameState';

class MacroStateClass {
    constructor() {
        this.running = false;
        this.activeMacro = null;
        this.startTime = 0;
        this.enabledMacros = new Set();
        this.macroStartTimes = new Map();
        this.sessionResumeWindowMs = 5 * 60 * 1000;

        this.modules = new Map();
        this.enabledModulesRevision = 0;
        this.lastDisableMeta = new Map();
        this.lastActiveMacros = [];

        this.lastMacroToggleKey = null;
        this.hasBoundLastMacroToggleKey = false;
        this.lastMacroToggleTitle = 'Global Toggle Last Used Macro';
        this.listeners = [];
        GameState.subscribe((event) => {
            if (event.state !== 'DISCONNECTED') return;
            const running = this.getEnabledMacros()
                .map((name) => this.getModule(name))
                .filter(Boolean);
            running.sort((a, b) => Number(a.isParentManaged) - Number(b.isParentManaged));
            running.forEach((module) => module.toggle(false, module.isParentManaged, 'game-state'));
        });
    }

    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter((listener) => listener !== callback);
        };
    }

    notifyModuleChange(module, enabled, context) {
        this.enabledModulesRevision++;
        const event = { module, enabled, context, meta: enabled ? null : this.getLastDisableMeta(module.name) };
        this.listeners.slice().forEach((listener) => {
            try {
                listener(event);
            } catch (e) {
                console.error(`Macro lifecycle listener: ${e}\n${e.stack}`);
            }
        });
    }

    getLastActiveMacro() {
        return this.lastActiveMacros[0] || null;
    }

    getLastActiveMacros() {
        return this.lastActiveMacros;
    }

    registerModule(module) {
        if (module.name) this.modules.set(module.name, module);
    }

    getModule(name) {
        return this.modules.get(name);
    }

    getMacroNames() {
        const names = [];
        this.modules.forEach((module, name) => {
            if (module.isMacro) names.push(name);
        });
        return names;
    }

    isMacroRunning() {
        return this.running;
    }

    getActiveMacro() {
        return this.activeMacro;
    }

    getStartTime() {
        return this.startTime;
    }

    getEnabledMacros() {
        return Array.from(this.enabledMacros);
    }

    isFailsafeMacroRunning() {
        for (const macroName of this.enabledMacros) {
            const module = this.getModule(macroName);
            if (!module?.isMacro) continue;
            if (module.ignoreFailsafes === true) continue;
            return true;
        }
        return false;
    }

    notifyFailsafeIntensity(delta) {
        for (const name of this.getEnabledMacros()) {
            const module = this.getModule(name);
            if (!module?.enabled || module.ignoreFailsafes || typeof module.onFailsafeIntensity !== 'function') continue;
            try {
                module.onFailsafeIntensity(delta);
            } catch (e) {
                console.error(`Error in ${name}.onFailsafeIntensity: ${e}\n${e.stack}`);
            }
        }
    }

    onModuleEnabled(moduleName) {
        if (!moduleName) return;
        const module = this.getModule(moduleName);
        if (!module || !module.isMacro) return;

        const wasEmpty = this.enabledMacros.size === 0;
        const now = Date.now();
        this.enabledMacros.add(moduleName);
        if (!this.macroStartTimes.has(moduleName)) {
            const lastMeta = this.getLastDisableMeta(moduleName);
            const canResume =
                lastMeta &&
                typeof lastMeta.timestamp === 'number' &&
                typeof lastMeta.durationMs === 'number' &&
                now - lastMeta.timestamp <= this.sessionResumeWindowMs;
            this.macroStartTimes.set(moduleName, canResume ? now - lastMeta.durationMs : now);
        }

        if (wasEmpty) this.startTime = this.getModuleStartTime(moduleName);
        this.running = true;
        this.activeMacro = moduleName;
        this.trackLastActiveMacro(moduleName);
    }

    onModuleDisabled(moduleName, context = 'user') {
        if (!moduleName || !this.enabledMacros.has(moduleName)) return;

        this.lastDisableMeta.set(moduleName, this.captureDisableMeta(moduleName, context));
        this.enabledMacros.delete(moduleName);
        this.macroStartTimes.delete(moduleName);

        if (this.enabledMacros.size === 0) {
            this.running = false;
            this.activeMacro = null;
            this.startTime = 0;
        } else {
            const remaining = Array.from(this.enabledMacros);
            this.activeMacro = remaining[remaining.length - 1];
        }
    }

    getLastDisableMeta(moduleName) {
        return moduleName ? this.lastDisableMeta.get(moduleName) || null : null;
    }

    getModuleStartTime(moduleName) {
        return moduleName ? this.macroStartTimes.get(moduleName) || 0 : 0;
    }

    getModuleDuration(moduleName) {
        const startTime = this.getModuleStartTime(moduleName);
        if (startTime) return TimeUtils.formatUptime(startTime);
        const durationMs = this.getLastDisableMeta(moduleName)?.durationMs || 0;
        return durationMs > 0 ? TimeUtils.formatDurationMs(durationMs) : '';
    }

    getModuleElapsedMs(moduleName) {
        const startTime = this.getModuleStartTime(moduleName);
        if (startTime) return Date.now() - startTime;
        return this.getLastDisableMeta(moduleName)?.durationMs || 0;
    }

    captureDisableMeta(moduleName, context = 'user') {
        const startTime = this.getModuleStartTime(moduleName);
        const now = Date.now();
        return {
            context: context || 'user',
            gameState: GameState.current,
            isParentManaged: this.getModule(moduleName)?.isParentManaged === true,
            timestamp: now,
            durationMs: startTime ? now - startTime : 0,
        };
    }

    trackLastActiveMacro(moduleName) {
        this.lastActiveMacros = this.lastActiveMacros.filter((name) => name !== moduleName);
        this.lastActiveMacros.unshift(moduleName);
    }

    setupLastMacroToggleKey() {
        if (this.hasBoundLastMacroToggleKey) return;
        this.hasBoundLastMacroToggleKey = true;

        const existingKeybinds = Utils.getConfigFile('keybinds.json') || {};
        const savedKeycode = existingKeybinds[this.lastMacroToggleTitle] || Keyboard.KEY_NONE;
        this.lastMacroToggleKey = new KeyBind(this.lastMacroToggleTitle, savedKeycode, 'v5_core');

        this.lastMacroToggleKey.registerKeyPress(() => this.toggleLastUsedMacroFromUser());

        register('gameUnload', () => {
            const keycode = this.lastMacroToggleKey?.getKeyCode();
            if (typeof keycode !== 'number') return;

            const allKeybinds = Utils.getConfigFile('keybinds.json') || {};
            allKeybinds[this.lastMacroToggleTitle] = keycode;
            Utils.writeConfigFile('keybinds.json', allKeybinds);
        });
    }

    toggleLastUsedMacroFromUser() {
        const macroName = this.getLastActiveMacro();
        if (!macroName) {
            Chat.message('&eNo recently used macro to toggle.');
            return false;
        }

        const macroModule = this.getModule(macroName);
        if (!macroModule || !macroModule.isMacro || typeof macroModule.requestToggleFromUser !== 'function') {
            Chat.message(`&cUnable to toggle last macro: ${macroName}.`);
            return false;
        }

        macroModule.requestToggleFromUser();
        return true;
    }
}

export const MacroState = new MacroStateClass();

// V5 5.2 named API. Keep the object facade above for Offline modules that still use it.
export const modules = MacroState.modules;
export const getEnabledModulesRevision = () => MacroState.enabledModulesRevision;
export const markEnabledModulesChanged = () => MacroState.enabledModulesRevision++;
export const getLastActiveMacros = () => MacroState.getLastActiveMacros();
export const getModule = (name) => MacroState.getModule(name);
export const isMacroRunning = () => MacroState.isMacroRunning();
export const getActiveMacro = () => MacroState.getActiveMacro();
export const getStartTime = () => MacroState.getStartTime();
export const getEnabledMacros = () => MacroState.getEnabledMacros();
export const getLastDisableMeta = (name) => MacroState.getLastDisableMeta(name);
export const getModuleStartTime = (name) => MacroState.getModuleStartTime(name);
export const registerModule = (module) => MacroState.registerModule(module);
export const isFailsafeMacroRunning = () => MacroState.isFailsafeMacroRunning();
export const notifyFailsafeIntensity = (delta) => MacroState.notifyFailsafeIntensity(delta);
export const onModuleEnabled = (name) => MacroState.onModuleEnabled(name);
export const onModuleDisabled = (name, context = 'user') => MacroState.onModuleDisabled(name, context);
export const getModuleDuration = (name) => MacroState.getModuleDuration(name);
export const getModuleElapsedMs = (name) => MacroState.getModuleElapsedMs(name);
export const getModuleActiveHours = (name) => MacroState.getModuleElapsedMs(name) / 3600000;
export const setupLastMacroToggleKey = () => MacroState.setupLastMacroToggleKey();
export const subscribe = (callback) => MacroState.subscribe(callback);
