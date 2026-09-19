import { FastEtherwarp } from './FastEtherwarp';
import { distanceToPlayerPoint, fastDistance } from './Math';
import Pathfinder from './pathfinder/PathFinder';
import { clickSlot, findItemInHotbar, getGuiName, setItemSlot } from './player/Inventory';
import { Rotations } from './player/Rotations';

const NPC_INTERACTION_RETRY_DELAYS_MS = [3000, 5000, 10000];
const NPC_INTERACTION_FINAL_TIMEOUT_MS = 10000;
const NPC_INTERACTION_DISTANCE = 3;
const GUI_LOAD_TIMEOUT_MS = 10000;
const GUI_SETTLE_MS = 10000;
const COMMISSION_CLAIM_RETRY_DELAYS_MS = [3000, 5000, 10000];
const COMMISSION_CLAIM_FINAL_TIMEOUT_MS = 10000;

export class CommissionClaimer {
    constructor({
        getLocations,
        ensureToolEquipped,
        isClaiming,
        delay,
        onClaimsExhausted,
        onPathStart = null,
        onPathFailed = null,
        onInteractionFailed = null,
        onClaimFailed = null,
        getTravelMode = null,
    }) {
        this.getLocations = getLocations;
        this.ensureToolEquipped = ensureToolEquipped;
        this.isClaiming = isClaiming;
        this.delay = delay;
        this.onClaimsExhausted = onClaimsExhausted;
        this.onPathStart = onPathStart || (() => {});
        this.onPathFailed = onPathFailed || (() => {});
        this.onInteractionFailed = onInteractionFailed || (() => {});
        this.onClaimFailed = onClaimFailed || (() => {});
        this.getTravelMode = getTravelMode || (() => 'Walk');
        this.npcRotationPending = false;
        this.npcRotationToken = 0;
        this.npcClickAttempts = 0;
        this.npcRetryReadyAt = 0;
        this.guiLoadStartedAt = 0;
        this.guiReadyAt = 0;
        this.commissionClaimSlot = -1;
        this.commissionClaimAttempts = 0;
        this.commissionClaimRetryReadyAt = 0;
        this.commissionClaimLastClickAt = 0;
    }

    handle() {
        if (!Player.getPlayer()) return;

        if (getGuiName() === 'Commissions') {
            this.resetNpcInteraction();
            this.handleCommissionsGui();
            return;
        }

        this.resetGuiLoadState();

        const pigeonSlot = findItemInHotbar('Royal Pigeon');
        if (pigeonSlot !== -1) {
            if (Player.getHeldItemIndex() !== pigeonSlot) {
                setItemSlot(pigeonSlot);
                this.delay(3);
            } else {
                Client.rightClick();
                this.delay(10);
            }
            return;
        }

        const locations = this.getLocations();
        if (!locations.length) return;

        const now = Date.now();
        if (this.npcClickAttempts > 0) {
            if (now < this.npcRetryReadyAt) return;
            if (this.npcClickAttempts >= 4) {
                const attempts = this.npcClickAttempts;
                this.resetNpcInteraction();
                this.onInteractionFailed(attempts);
                return;
            }
        }

        const closest = this.getClosestLocation(locations);
        const closestDist = fastDistance(Player.getX(), Player.getY(), Player.getZ(), ...closest);
        const target = [closest[0] + 0.5, closest[1] + 1.8, closest[2] + 0.5];

        if (closest[1] - Player.getY() > 3 && closestDist < 10) {
            this.pathToNpc(locations);
            return;
        }

        if (distanceToPlayerPoint(target) > NPC_INTERACTION_DISTANCE || this.isPathing()) {
            if (!this.isPathing()) this.pathToNpc(locations);
            return;
        }

        if (!this.ensureToolEquipped()) return;
        if (Math.abs(Player.getMotionX()) + Math.abs(Player.getMotionZ()) >= 0.04) return;

        if (!Rotations.active) {
            this.npcRotationPending = true;
            const token = ++this.npcRotationToken;
            Rotations.lookAtVector(target);
            Rotations.onComplete(() => {
                if (!this.npcRotationPending || this.npcRotationToken !== token) return;
                this.npcRotationPending = false;
                if (!this.isClaiming() || this.isPathing()) return;

                if (distanceToPlayerPoint(target) > NPC_INTERACTION_DISTANCE) {
                    this.pathToNpc(this.getLocations());
                    return;
                }

                Client.leftClick();
                this.registerNpcClickAttempt();
            });
        }
    }

    handleCommissionsGui() {
        const container = Player.getContainer();
        if (!container) return;

        const now = Date.now();
        if (!isCommissionGuiLoaded(container)) {
            if (this.guiLoadStartedAt === 0) this.guiLoadStartedAt = now;
            if (now - this.guiLoadStartedAt >= GUI_LOAD_TIMEOUT_MS) {
                this.resetCommissionClaim();
                this.onClaimFailed('Commissions GUI did not finish loading within 10 seconds.');
            }
            return;
        }

        this.guiLoadStartedAt = 0;
        if (this.guiReadyAt === 0) this.guiReadyAt = now;

        if (this.commissionClaimAttempts > 0) {
            const slotState = getCommissionSlotState(container, this.commissionClaimSlot);
            if (slotState === 'ACTIVE') {
                this.resetCommissionClaimAttempt();

                const nextCompletedSlot = findCompletedCommissionSlot(container);
                if (nextCompletedSlot !== -1) {
                    if (clickSlot(nextCompletedSlot, false)) this.registerCommissionClaimAttempt(nextCompletedSlot);
                    return;
                }

                this.onClaimsExhausted(container);
                return;
            }

            if (slotState === 'LOADING') {
                if (this.commissionClaimLastClickAt > 0 && now - this.commissionClaimLastClickAt >= GUI_LOAD_TIMEOUT_MS) {
                    this.resetCommissionClaim();
                    this.onClaimFailed('Commission slot did not finish updating within 10 seconds after the claim click.');
                }
                return;
            }

            if (now < this.commissionClaimRetryReadyAt) return;
            if (this.commissionClaimAttempts >= 4) {
                const attempts = this.commissionClaimAttempts;
                this.resetCommissionClaim();
                this.onClaimFailed(`Failed to claim a completed commission after ${attempts} GUI click attempts.`);
                return;
            }

            if (clickSlot(this.commissionClaimSlot, false)) this.registerCommissionClaimAttempt(this.commissionClaimSlot);
            return;
        }

        const completedSlot = findCompletedCommissionSlot(container);
        if (completedSlot !== -1) {
            if (clickSlot(completedSlot, false)) this.registerCommissionClaimAttempt(completedSlot);
            return;
        }

        if (now - this.guiReadyAt < GUI_SETTLE_MS) return;

        this.resetCommissionClaim();
        this.onClaimsExhausted(container);
    }

    registerNpcClickAttempt() {
        this.npcClickAttempts++;
        if (this.npcClickAttempts >= 4) {
            this.npcRetryReadyAt = Date.now() + NPC_INTERACTION_FINAL_TIMEOUT_MS;
            return;
        }

        const retryDelay = NPC_INTERACTION_RETRY_DELAYS_MS[this.npcClickAttempts - 1];
        this.npcRetryReadyAt = Date.now() + retryDelay;
    }

    registerCommissionClaimAttempt(slot) {
        const now = Date.now();
        this.commissionClaimSlot = slot;
        this.commissionClaimAttempts++;
        this.commissionClaimLastClickAt = now;
        if (this.commissionClaimAttempts >= 4) {
            this.commissionClaimRetryReadyAt = now + COMMISSION_CLAIM_FINAL_TIMEOUT_MS;
            return;
        }

        const retryDelay = COMMISSION_CLAIM_RETRY_DELAYS_MS[this.commissionClaimAttempts - 1];
        this.commissionClaimRetryReadyAt = now + retryDelay;
    }

    pathToNpc(locations) {
        if (this.isPathing()) return;

        this.onPathStart();
        const walk = () => {
            Pathfinder.findPath(locations, (success) => {
                if (!this.isClaiming()) return;
                if (!success) this.onPathFailed();
            });
        };
        const travelMode = this.getTravelMode();
        if (travelMode === 'Walk') {
            walk();
            return;
        }

        let walking = false;
        const fallback = () => {
            if (walking || !this.isClaiming()) return;
            walking = true;
            walk();
        };
        const started = FastEtherwarp.findPath(locations, {
            silent: true,
            goalRadius: 2,
            onSuccess: fallback,
            onFail: fallback,
        });
        if (!started) fallback();
    }

    isPathing() {
        return Pathfinder.isPathing() || FastEtherwarp.isPathing();
    }

    getClosestLocation(locations) {
        return locations.reduce((closest, location) => {
            const closestDist = fastDistance(Player.getX(), Player.getY(), Player.getZ(), ...closest);
            const locationDist = fastDistance(Player.getX(), Player.getY(), Player.getZ(), ...location);
            return locationDist < closestDist ? location : closest;
        });
    }

    cancelNpcRotationIfPathing() {
        if (this.isPathing()) this.cancelNpcRotation();
    }

    cancelNpcRotation() {
        if (!this.npcRotationPending) return;

        this.npcRotationPending = false;
        this.npcRotationToken++;
        if (Rotations.active) Rotations.stop();
    }

    resetNpcInteraction() {
        this.npcClickAttempts = 0;
        this.npcRetryReadyAt = 0;
    }

    resetGuiLoadState() {
        this.guiLoadStartedAt = 0;
        this.guiReadyAt = 0;
    }

    resetCommissionClaimAttempt() {
        this.commissionClaimSlot = -1;
        this.commissionClaimAttempts = 0;
        this.commissionClaimRetryReadyAt = 0;
        this.commissionClaimLastClickAt = 0;
    }

    resetCommissionClaim() {
        this.resetGuiLoadState();
        this.resetCommissionClaimAttempt();
    }

    reset() {
        this.cancelNpcRotation();
        this.resetNpcInteraction();
        this.resetCommissionClaim();
    }
}

function isCommissionGuiLoaded(container) {
    for (let i = 9; i < 17; i++) {
        const stack = container.getStackInSlot(i);
        if (!stack) continue;
        const name = ChatLib.removeFormatting(String(stack.getName()));
        if (name.startsWith('Commission #')) return true;
    }
    return false;
}

function getCommissionSlotState(container, slot) {
    if (!container || slot < 9 || slot >= 17) return 'LOADING';
    const stack = container.getStackInSlot(slot);
    if (!stack) return 'LOADING';

    const name = ChatLib.removeFormatting(String(stack.getName()));
    if (!name.startsWith('Commission #')) return 'LOADING';

    return (stack.getLore() || []).some((line) => String(line).includes('COMPLETED')) ? 'COMPLETED' : 'ACTIVE';
}

function findCompletedCommissionSlot(container) {
    for (let i = 9; i < 17; i++) {
        if (getCommissionSlotState(container, i) === 'COMPLETED') return i;
    }
    return -1;
}
