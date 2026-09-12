import { Chat } from '../../utils/Chat';
import { File, globalAssetsDir } from '../../utils/Constants';
import { Failsafe } from '../Failsafe';
import FailsafeUtils from '../FailsafeUtils';

const warpPoints = (() => {
    try {
        return JSON.parse(FileLib.read(new File(globalAssetsDir, 'WarpPoints.json').getPath()) || '{}').warps || [];
    } catch (e) {
        console.error('V5 Caught error' + e + e.stack);
        return [];
    }
})();

class PlayerGriefFailsafe extends Failsafe {
    constructor() {
        super();
        this.settings = FailsafeUtils.getFailsafeSettings('Player Grief');
        this.detectionWindows = new Map();
        this.registerGriefListeners();
        this.whitelistedPlayers = ['']; // TODO: add gui textbox, i have no clue how it works so im not touching it
        this.whitelistedPlayerSet = new Set(this.whitelistedPlayers);
    }

    registerGriefListeners() {
        register('worldUnload', () => this.detectionWindows.clear());
        register('tick', () => {
            this.settings = FailsafeUtils.getFailsafeSettings('Player Grief');
            if (!this.isActive() || this.disabled || !World.isLoaded() || !Player.asPlayerMP() || !this.settings.isEnabled || this.isNearWarpPoint()) {
                this.detectionWindows.clear();
                return;
            }
            this.checkPlayers(Date.now());
        });
    }

    _setDisabled(durationMs) {
        this.detectionWindows?.clear();
        super._setDisabled(durationMs);
    }

    isNearWarpPoint() {
        const px = Player.getX();
        const py = Player.getY();
        const pz = Player.getZ();
        return warpPoints.some((warp) => {
            const dx = warp.x - px;
            const dy = warp.y - py;
            const dz = warp.z - pz;
            return dx * dx + dy * dy + dz * dz <= 25;
        });
    }

    checkPlayers(now) {
        const maxDistance = this.settings.playerProximityDistance || 3;
        const maxDistanceSq = maxDistance * maxDistance;
        const px = Player.getX();
        const py = Player.getY();
        const pz = Player.getZ();
        const selfName = Player.getName();
        const playerBox = Player.getPlayer().getBoundingBox();
        const candidates = { inside: new Map(), nearby: new Map() };

        World.getAllPlayers().forEach((player) => {
            const playerName = player.getName();
            if (playerName === selfName || player.getUUID()?.version() === 2) return;
            if (this.whitelistedPlayerSet.has(playerName)) return;

            const lx = player.getX();
            const ly = player.getY();
            const lz = player.getZ();

            const dx = lx - px;
            const dy = ly - py;
            const dz = lz - pz;
            const distanceSq = dx * dx + dy * dy + dz * dz;
            const inside = playerBox.intersects(player.toMC().getBoundingBox());
            const kind = inside ? 'inside' : distanceSq <= maxDistanceSq ? 'nearby' : null;
            if (!kind) return;

            const id = player.getUUID().toString();
            candidates[kind].set(id, { name: playerName, distance: Math.sqrt(distanceSq) });
        });
        this.checkInterference('inside', candidates.inside, now);
        this.checkInterference('nearby', candidates.nearby, now);
    }

    checkInterference(kind, players, now) {
        const inside = kind === 'inside';
        const detectionMs = inside ? 500 : 3000;
        const cooldownMs = inside ? 5000 : 3000;
        const window = this.detectionWindows.get(kind);

        if (window) {
            if (window.recheckAt !== null && now >= window.recheckAt) {
                window.recheckAt = null;
                for (const [id, player] of players) {
                    if (!window.playerIds.has(id)) continue;
                    const description = inside
                        ? `${player.name} is standing inside you!`
                        : `${player.name} is ${player.distance.toFixed(1)} blocks away from you!`;
                    Chat.messageFailsafe(`&c&l${description}`);
                    FailsafeUtils.incrementFailsafeIntensity(inside ? 120 : 20);
                    FailsafeUtils.sendFailsafeEmbed('Player Grief', inside ? 'very high' : 'medium', description, inside ? 16711680 : 16776960);
                }
            }
            if (now < window.cooldownUntil) return;
            this.detectionWindows.delete(kind);
        }

        if (players.size === 0) return;
        this.detectionWindows.set(kind, {
            recheckAt: now + detectionMs,
            cooldownUntil: now + detectionMs + cooldownMs,
            playerIds: new Set(players.keys()),
        });
    }
}

export default new PlayerGriefFailsafe();
