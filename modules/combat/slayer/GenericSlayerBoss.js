import { CombatBot } from '../CombatBot';

export class GenericSlayerBoss {
    constructor(config) {
        this.config = config;
        this.target = null;
        this.origin = null;
        this.combatOptions = {
            roam: false,
            boundaryCheck: config.boundaryCheck,
            travelClicks: false,
            rightClickChance: 0,
            blacklistOnPathFailure: false,
        };
    }

    start(origin) {
        this.target = null;
        this.origin = origin;
    }

    tick() {
        CombatBot.setExternalTargets(this.getTargets(), this.combatOptions);
        CombatBot.toggle(true, true);
        const targets = CombatBot.getTargets();
        return targets.some((target) => CombatBot.isTargetUsable(target, targets));
    }

    pause() {
        CombatBot.toggle(false, true);
    }

    stop() {
        this.pause();
        this.target = null;
        this.origin = null;
    }

    getTargets() {
        if (this.target) {
            if (CombatBot.isCombatTargetCandidate(this.target, true)) return [this.target];
            this.target = null;
        }
        let bosses = CombatBot.findMob({ names: [this.config.boss], allowInvisible: true, checkVisibility: false });
        const otherBosses = new Set();
        for (const entity of World.getAllEntities()) {
            const owner = ChatLib.removeFormatting(String(entity.getName()))
                .trim()
                .toLowerCase()
                .match(/^spawned by:\s*(\w+)$/)?.[1];
            if (!owner) continue;
            const boss = CombatBot.resolveNametagTarget(entity, bosses);
            if (!boss) continue;
            if (owner === Player.getName().toLowerCase()) this.target = boss;
            else otherBosses.add(CombatBot.getTargetUuid(boss));
        }
        if (!this.target) {
            bosses = bosses.filter(
                (boss) =>
                    !otherBosses.has(CombatBot.getTargetUuid(boss)) &&
                    CombatBot.getDistanceBetween(CombatBot.getTargetPosition(boss), this.origin).distance < 64
            );
            bosses.sort(
                (first, second) =>
                    CombatBot.getDistanceBetween(CombatBot.getTargetPosition(first), this.origin).distance -
                    CombatBot.getDistanceBetween(CombatBot.getTargetPosition(second), this.origin).distance
            );
            this.target = bosses[0] || null;
        }
        return this.target ? [this.target] : [];
    }
}
