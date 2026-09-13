import { V5ConfigFile } from '../utils/Constants';
import { finiteNumber } from '../utils/NumberUtils';

const DEFAULT_FAILSAFE_SETTINGS = {
    isEnabled: true,
    FailsafeReactionTime: 600,
    playerProximityDistance: 3,
    pingOnCheck: 'None',
    playSoundOnCheck: true,
    ignoreTeleportItems: false,
    notifyMacroIntensity: true,
};

class FailsafeUtils {
    constructor() {
        this.failsafeIntensity = 0;

        this._cache = {
            expiresAt: 0,
            lastModified: -1,
            config: {},
            normalized: null,
        };
        this._utils = null;
    }

    _getConfig() {
        const now = Date.now();
        const lastModified = V5ConfigFile.exists() ? V5ConfigFile.lastModified() : -1;
        const cacheValid = now < this._cache.expiresAt && this._cache.lastModified === lastModified;
        if (cacheValid) {
            return this._cache.config;
        }

        if (!this._utils) this._utils = require('../utils/Utils').Utils;
        const config = this._utils.getConfigFile('config.json');

        this._cache.expiresAt = now + 250;
        this._cache.lastModified = lastModified;
        this._cache.config = config;
        this._cache.normalized = null;

        return config;
    }

    _normalizeFailsafeConfig(failsafesConfig) {
        if (this._cache.normalized) return this._cache.normalized;

        const enabledMap = {};
        const enabledList = failsafesConfig['Enabled Failsafes'];
        if (Array.isArray(enabledList)) {
            for (const entry of enabledList) {
                if (!entry || !entry.name) continue;
                enabledMap[entry.name] = !!entry.enabled;
            }
        }

        const normalized = {
            enabledMap,
            rawEnabledList: enabledList,
            reactionInput: failsafesConfig['Failsafe Detection Delay (ms)'] ?? DEFAULT_FAILSAFE_SETTINGS.FailsafeReactionTime,
            playerProximityDistance: failsafesConfig['Player Proximity Distance'] ?? DEFAULT_FAILSAFE_SETTINGS.playerProximityDistance,
            playSoundOnCheck: failsafesConfig['Play sound on check'] ?? DEFAULT_FAILSAFE_SETTINGS.playSoundOnCheck,
            ignoreTeleportItems: failsafesConfig['Ignore Held Teleport Items'] ?? DEFAULT_FAILSAFE_SETTINGS.ignoreTeleportItems,
            notifyMacroIntensity: failsafesConfig['Notify Macro Intensity'] ?? DEFAULT_FAILSAFE_SETTINGS.notifyMacroIntensity,
            pingOnCheck: 'None',
        };

        this._cache.normalized = normalized;
        return normalized;
    }

    getFailsafeSettings(name) {
        const config = this._getConfig();

        if (!config || !config['Failsafes']) {
            return DEFAULT_FAILSAFE_SETTINGS;
        }

        const normalized = this._normalizeFailsafeConfig(config['Failsafes']);
        const reactionInput = normalized.reactionInput;
        let reactionTime = DEFAULT_FAILSAFE_SETTINGS.FailsafeReactionTime;

        if (typeof reactionInput === 'object' && reactionInput.low !== undefined) {
            const { low, high } = reactionInput;
            const min = Math.min(low, high);
            const max = Math.max(low, high);
            reactionTime = Math.floor(Math.random() * (max - min + 1) + min);
        } else {
            reactionTime = finiteNumber(reactionInput, reactionTime);
        }

        const hasEnabledList = Array.isArray(normalized.rawEnabledList);
        const isEnabled = hasEnabledList
            ? (normalized.enabledMap[name] ?? false)
            : (config['Failsafes'][`${name} Failsafe`] ?? DEFAULT_FAILSAFE_SETTINGS.isEnabled);

        return {
            isEnabled,
            FailsafeReactionTime: reactionTime,
            playerProximityDistance: normalized.playerProximityDistance,
            pingOnCheck: normalized.pingOnCheck,
            playSoundOnCheck: normalized.playSoundOnCheck,
            ignoreTeleportItems: normalized.ignoreTeleportItems,
            notifyMacroIntensity: normalized.notifyMacroIntensity,
        };
    }

    sendFailsafeEmbed(type, severity, description, color) {}

    incrementFailsafeIntensity(amt) {
        const delta = Math.max(0, finiteNumber(amt));
        if (delta === 0) return;
        this.failsafeIntensity += delta;
        setTimeout(() => (this.failsafeIntensity -= delta / 10), 1000);
        if (this.getFailsafeSettings().notifyMacroIntensity) require('../utils/MacroState').MacroState.notifyFailsafeIntensity(delta);
    }

    getIntensity() {
        return this.failsafeIntensity;
    }
}

export default new FailsafeUtils();
