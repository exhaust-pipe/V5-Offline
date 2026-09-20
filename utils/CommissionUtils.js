import { FastEtherwarp } from './FastEtherwarp';
import { distanceToPlayerPoint, fastDistance } from './Math';
import Pathfinder from './pathfinder/PathFinder';
import { clickSlot, closeInventory, findFirstItem, findItemInHotbar, getGuiName, setItemSlot } from './player/Inventory';
import { Rotations } from './player/Rotations';

const NPC_INTERACTION_RETRY_DELAYS_MS = [3000, 5000, 10000];
const NPC_INTERACTION_FINAL_TIMEOUT_MS = 10000;
const NPC_INTERACTION_DISTANCE = 3;
const GUI_LOAD_TIMEOUT_MS = 10000;
const GUI_SETTLE_MS = 10000;
const COMMISSION_CLAIM_RETRY_DELAYS_MS = [3000, 5000, 10000];
const COMMISSION_CLAIM_FINAL_TIMEOUT_MS = 10000;
const ABIPHONE_UI_RETRY_DELAYS_MS = [3000, 5000, 10000];
const ABIPHONE_UI_FINAL_TIMEOUT_MS = 10000;
const PIGEON_UI_RETRY_DELAYS_MS = [3000, 5000, 10000];
const PIGEON_UI_FINAL_TIMEOUT_MS = 10000;
const CLAIM_METHODS = {
    PIGEON: 'Royal Pigeon',
    ABIPHONE: 'Abiphone (Mismyla)',
    EMISSARY: 'Emissary',
};

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

        this.claimMethod = null;
        this.pigeonSlot = -1;
        this.abiphoneSlot = -1;

        this.setupState = 'IDLE';
        this.setupCallback = null;
        this.setupProtectedHotbarSlots = [];
        this.setupWaitTicks = 0;
        this.setupOriginalAbiphoneSlot = -1;
        this.setupTargetHotbarSlot = -1;
        this.setupPendingMethod = null;
        this.setupAbiphoneOpenAttempts = 0;
        this.setupAbiphoneOpenRetryReadyAt = 0;

        this.pigeonOpenAttempts = 0;
        this.pigeonOpenRetryReadyAt = 0;

        this.abiphoneOpenAttempts = 0;
        this.abiphoneOpenRetryReadyAt = 0;
        this.abiphoneContactAttempts = 0;
        this.abiphoneContactRetryReadyAt = 0;

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

    beginClaimMethodSetup(callback, protectedHotbarSlots = []) {
        this.claimMethod = null;
        this.pigeonSlot = -1;
        this.abiphoneSlot = -1;
        this.setupCallback = callback;
        this.setupProtectedHotbarSlots = (protectedHotbarSlots || []).filter((slot) => slot >= 0 && slot <= 8);
        this.setupWaitTicks = 0;
        this.setupOriginalAbiphoneSlot = -1;
        this.setupTargetHotbarSlot = -1;
        this.setupPendingMethod = null;
        this.setupAbiphoneOpenAttempts = 0;
        this.setupAbiphoneOpenRetryReadyAt = 0;
        this.setupState = 'FIND_METHOD';
    }

    handleClaimMethodSetup() {
        if (!Player.getPlayer() || this.setupState === 'IDLE' || this.setupState === 'DONE') return;
        if (this.setupWaitTicks > 0) {
            this.setupWaitTicks--;
            return;
        }

        switch (this.setupState) {
            case 'FIND_METHOD': {
                const pigeonSlot = findItemInHotbar('Royal Pigeon');
                if (pigeonSlot !== -1) {
                    this.pigeonSlot = pigeonSlot;
                    this.completeClaimMethodSetup(CLAIM_METHODS.PIGEON);
                    return;
                }

                const inventory = Player.getInventory();
                if (!inventory) return;

                const hotbarAbiphone = this.findInventoryItemInRange(inventory, 'Abiphone', 0, 9);
                if (hotbarAbiphone !== -1) {
                    this.abiphoneSlot = hotbarAbiphone;
                    setItemSlot(hotbarAbiphone);
                    this.setupState = 'OPEN_ABIPHONE';
                    this.setupWaitTicks = 5;
                    return;
                }

                const inventoryAbiphone = this.findInventoryItemInRange(inventory, 'Abiphone', 9, 36);
                if (inventoryAbiphone === -1) {
                    this.completeClaimMethodSetup(CLAIM_METHODS.EMISSARY);
                    return;
                }

                const targetSlot = this.findSetupHotbarSlot(inventory);
                if (targetSlot === -1) {
                    this.completeClaimMethodSetup(CLAIM_METHODS.EMISSARY);
                    return;
                }

                this.setupOriginalAbiphoneSlot = inventoryAbiphone;
                this.setupTargetHotbarSlot = targetSlot;
                this.abiphoneSlot = targetSlot;
                this.setupState = 'OPEN_PLAYER_INV_SWAP';
                return;
            }

            case 'OPEN_PLAYER_INV_SWAP':
                Client.getMinecraft().setScreen(new net.minecraft.client.gui.screens.inventory.InventoryScreen(Client.getMinecraft().player));
                this.setupState = 'WAIT_PLAYER_INV_SWAP';
                this.setupWaitTicks = 5;
                return;

            case 'WAIT_PLAYER_INV_SWAP':
                if (Client.isInGui()) {
                    this.setupState = 'SWAP_ABIPHONE_1';
                    this.setupWaitTicks = 5;
                } else {
                    this.setupState = 'OPEN_PLAYER_INV_SWAP';
                    this.setupWaitTicks = 5;
                }
                return;

            case 'SWAP_ABIPHONE_1':
                clickSlot(this.setupOriginalAbiphoneSlot);
                this.setupState = 'SWAP_ABIPHONE_2';
                this.setupWaitTicks = 5;
                return;

            case 'SWAP_ABIPHONE_2':
                clickSlot(36 + this.setupTargetHotbarSlot);
                this.setupState = 'SWAP_ABIPHONE_3';
                this.setupWaitTicks = 5;
                return;

            case 'SWAP_ABIPHONE_3':
                clickSlot(this.setupOriginalAbiphoneSlot);
                this.setupState = 'CLOSE_PLAYER_INV_SWAP';
                this.setupWaitTicks = 5;
                return;

            case 'CLOSE_PLAYER_INV_SWAP':
                closeInventory();
                setItemSlot(this.setupTargetHotbarSlot);
                this.setupState = 'OPEN_ABIPHONE';
                this.setupWaitTicks = 10;
                return;

            case 'OPEN_ABIPHONE':
                if (Player.getHeldItemIndex() !== this.abiphoneSlot) {
                    setItemSlot(this.abiphoneSlot);
                    this.setupWaitTicks = 3;
                    return;
                }
                Client.rightClick();
                this.registerSetupAbiphoneOpenAttempt();
                this.setupState = 'SELECT_CONTACT';
                return;

            case 'SELECT_CONTACT': {
                const now = Date.now();
                if (!getGuiName()?.includes('Abiphone')) {
                    if (now < this.setupAbiphoneOpenRetryReadyAt) return;
                    if (this.setupAbiphoneOpenAttempts >= 4) {
                        this.fallbackSetupToEmissary();
                        return;
                    }

                    if (Client.isInGui()) closeInventory();
                    this.setupState = 'OPEN_ABIPHONE';
                    this.setupWaitTicks = 5;
                    return;
                }

                const contactSlot = findFirstItem(Player.getContainer(), 'Mismyla');
                if (contactSlot === -1 || !Player.getContainer()?.getStackInSlot(contactSlot)) {
                    if (now < this.setupAbiphoneOpenRetryReadyAt) return;
                    this.fallbackSetupToEmissary();
                    return;
                }

                this.resetSetupAbiphoneOpenRetry();
                closeInventory();
                this.completeClaimMethodSetup(CLAIM_METHODS.ABIPHONE);
                return;
            }

            case 'OPEN_PLAYER_INV_RESTORE':
                Client.getMinecraft().setScreen(new net.minecraft.client.gui.screens.inventory.InventoryScreen(Client.getMinecraft().player));
                this.setupState = 'WAIT_PLAYER_INV_RESTORE';
                this.setupWaitTicks = 5;
                return;

            case 'WAIT_PLAYER_INV_RESTORE':
                if (Client.isInGui()) {
                    this.setupState = 'RESTORE_ABIPHONE_1';
                    this.setupWaitTicks = 5;
                } else {
                    this.setupState = 'OPEN_PLAYER_INV_RESTORE';
                    this.setupWaitTicks = 5;
                }
                return;

            case 'RESTORE_ABIPHONE_1':
                clickSlot(this.setupOriginalAbiphoneSlot);
                this.setupState = 'RESTORE_ABIPHONE_2';
                this.setupWaitTicks = 5;
                return;

            case 'RESTORE_ABIPHONE_2':
                clickSlot(36 + this.setupTargetHotbarSlot);
                this.setupState = 'RESTORE_ABIPHONE_3';
                this.setupWaitTicks = 5;
                return;

            case 'RESTORE_ABIPHONE_3':
                clickSlot(this.setupOriginalAbiphoneSlot);
                this.setupState = 'CLOSE_PLAYER_INV_RESTORE';
                this.setupWaitTicks = 5;
                return;

            case 'CLOSE_PLAYER_INV_RESTORE': {
                closeInventory();
                const pendingMethod = this.setupPendingMethod || CLAIM_METHODS.EMISSARY;
                this.setupOriginalAbiphoneSlot = -1;
                this.setupTargetHotbarSlot = -1;
                this.abiphoneSlot = -1;
                this.completeClaimMethodSetup(pendingMethod);
                return;
            }
        }
    }

    findInventoryItemInRange(inventory, name, start, end) {
        const upper = Math.min(end, inventory?.getSize?.() || 0);
        for (let slot = Math.max(0, start); slot < upper; slot++) {
            const item = inventory.getStackInSlot(slot);
            const itemName = item ? ChatLib.removeFormatting(String(item.getName())) : '';
            if (itemName.toLowerCase().includes(name.toLowerCase())) return slot;
        }
        return -1;
    }

    findSetupHotbarSlot(inventory) {
        for (let slot = 0; slot < 9; slot++) {
            if (this.setupProtectedHotbarSlots.includes(slot)) continue;
            if (!inventory.getStackInSlot(slot)) return slot;
        }

        for (let slot = 0; slot < 9; slot++) {
            if (!this.setupProtectedHotbarSlots.includes(slot)) return slot;
        }

        return -1;
    }

    registerSetupAbiphoneOpenAttempt() {
        const now = Date.now();
        this.setupAbiphoneOpenAttempts++;
        this.setupAbiphoneOpenRetryReadyAt =
            now +
            (this.setupAbiphoneOpenAttempts >= 4
                ? ABIPHONE_UI_FINAL_TIMEOUT_MS
                : ABIPHONE_UI_RETRY_DELAYS_MS[this.setupAbiphoneOpenAttempts - 1]);
    }

    resetSetupAbiphoneOpenRetry() {
        this.setupAbiphoneOpenAttempts = 0;
        this.setupAbiphoneOpenRetryReadyAt = 0;
    }

    fallbackSetupToEmissary() {
        this.resetSetupAbiphoneOpenRetry();
        if (Client.isInGui()) closeInventory();

        if (this.setupOriginalAbiphoneSlot !== -1) {
            this.setupPendingMethod = CLAIM_METHODS.EMISSARY;
            this.setupState = 'OPEN_PLAYER_INV_RESTORE';
            this.setupWaitTicks = 5;
            return;
        }

        this.abiphoneSlot = -1;
        this.completeClaimMethodSetup(CLAIM_METHODS.EMISSARY);
    }

    completeClaimMethodSetup(method) {
        this.claimMethod = method;
        this.setupState = 'DONE';
        this.setupWaitTicks = 0;
        this.setupPendingMethod = null;
        const callback = this.setupCallback;
        this.setupCallback = null;
        if (callback) callback(method);
    }

    clearClaimMethod() {
        this.claimMethod = null;
        this.pigeonSlot = -1;
        this.abiphoneSlot = -1;
        this.setupState = 'IDLE';
        this.setupCallback = null;
        this.setupPendingMethod = null;
        this.resetSetupAbiphoneOpenRetry();
        this.resetAbiphoneInteraction();
    }

    handle() {
        if (!Player.getPlayer()) return;

        if (getGuiName() === 'Commissions') {
            this.resetNpcInteraction();
            this.resetPigeonInteraction();
            this.resetAbiphoneInteraction();
            this.handleCommissionsGui();
            return;
        }

        this.resetGuiLoadState();

        if (this.claimMethod === CLAIM_METHODS.PIGEON) {
            this.handlePigeon(this.pigeonSlot);
            return;
        }

        if (this.claimMethod === CLAIM_METHODS.ABIPHONE) {
            this.handleAbiphone();
            return;
        }

        if (this.claimMethod === CLAIM_METHODS.EMISSARY) {
            this.handleEmissary();
            return;
        }

        // Compatibility fallback for callers that do not preselect a claim method.
        const pigeonSlot = findItemInHotbar('Royal Pigeon');
        if (pigeonSlot !== -1) {
            this.handlePigeon(pigeonSlot);
            return;
        }

        this.handleEmissary();
    }

    handlePigeon(slot) {
        const item = Player.getInventory()?.getStackInSlot(slot);
        const itemName = item ? ChatLib.removeFormatting(String(item.getName())) : '';
        if (slot < 0 || !itemName.includes('Royal Pigeon')) {
            this.onClaimFailed('The Royal Pigeon selected when the macro started is no longer available.');
            return;
        }

        const now = Date.now();
        if (this.pigeonOpenAttempts > 0) {
            if (now < this.pigeonOpenRetryReadyAt) return;
            if (this.pigeonOpenAttempts >= 4) {
                const attempts = this.pigeonOpenAttempts;
                this.resetPigeonInteraction();
                this.onClaimFailed(`Royal Pigeon never opened Commissions after ${attempts} attempts.`);
                return;
            }
        }

        if (Player.getHeldItemIndex() !== slot) {
            setItemSlot(slot);
            this.delay(3);
            return;
        }

        Client.rightClick();
        this.registerPigeonOpenAttempt();
    }

    registerPigeonOpenAttempt() {
        const now = Date.now();
        this.pigeonOpenAttempts++;
        this.pigeonOpenRetryReadyAt =
            now +
            (this.pigeonOpenAttempts >= 4
                ? PIGEON_UI_FINAL_TIMEOUT_MS
                : PIGEON_UI_RETRY_DELAYS_MS[this.pigeonOpenAttempts - 1]);
    }

    resetPigeonInteraction() {
        this.pigeonOpenAttempts = 0;
        this.pigeonOpenRetryReadyAt = 0;
    }

    handleAbiphone() {
        const item = Player.getInventory()?.getStackInSlot(this.abiphoneSlot);
        const itemName = item ? ChatLib.removeFormatting(String(item.getName())) : '';
        if (this.abiphoneSlot < 0 || !itemName.includes('Abiphone')) {
            this.onClaimFailed('The Abiphone selected when the macro started is no longer available.');
            return;
        }

        const now = Date.now();
        const guiName = getGuiName();

        // Mismyla has a server-side response delay. After clicking the contact,
        // wait for the configured response window before inspecting the Abiphone
        // GUI again or deciding whether another contact click is needed.
        if (this.abiphoneContactAttempts > 0) {
            if (now < this.abiphoneContactRetryReadyAt) return;
            if (this.abiphoneContactAttempts >= 4) {
                const attempts = this.abiphoneContactAttempts;
                this.resetAbiphoneInteraction();
                this.onClaimFailed(`Failed to open Commissions through Mismyla after ${attempts} contact click attempts.`);
                return;
            }

            if (!guiName?.includes('Abiphone')) {
                if (Client.isInGui()) closeInventory();
                if (Player.getHeldItemIndex() !== this.abiphoneSlot) {
                    setItemSlot(this.abiphoneSlot);
                    this.delay(3);
                    return;
                }

                Client.rightClick();
                this.registerAbiphoneOpenAttempt();
                return;
            }
        }

        if (guiName?.includes('Abiphone')) {
            const contactSlot = findFirstItem(Player.getContainer(), 'Mismyla');
            if (contactSlot === -1 || !Player.getContainer()?.getStackInSlot(contactSlot)) {
                if (now < this.abiphoneOpenRetryReadyAt) return;
                this.onClaimFailed('Mismyla is no longer available in the configured Abiphone.');
                return;
            }

            this.resetAbiphoneOpenRetry();

            if (clickSlot(contactSlot, false, 'LEFT')) this.registerAbiphoneContactAttempt();
            return;
        }

        if (this.abiphoneOpenAttempts > 0) {
            if (now < this.abiphoneOpenRetryReadyAt) return;
            if (this.abiphoneOpenAttempts >= 4) {
                const attempts = this.abiphoneOpenAttempts;
                this.resetAbiphoneInteraction();
                this.onClaimFailed(`Abiphone never opened after ${attempts} attempts.`);
                return;
            }
        }

        if (Client.isInGui()) closeInventory();

        if (Player.getHeldItemIndex() !== this.abiphoneSlot) {
            setItemSlot(this.abiphoneSlot);
            this.delay(3);
            return;
        }

        Client.rightClick();
        this.registerAbiphoneOpenAttempt();
    }

    handleEmissary() {
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

    registerAbiphoneOpenAttempt() {
        const now = Date.now();
        this.abiphoneOpenAttempts++;
        this.abiphoneOpenRetryReadyAt =
            now +
            (this.abiphoneOpenAttempts >= 4
                ? ABIPHONE_UI_FINAL_TIMEOUT_MS
                : ABIPHONE_UI_RETRY_DELAYS_MS[this.abiphoneOpenAttempts - 1]);
    }

    resetAbiphoneOpenRetry() {
        this.abiphoneOpenAttempts = 0;
        this.abiphoneOpenRetryReadyAt = 0;
    }

    registerAbiphoneContactAttempt() {
        const now = Date.now();
        this.abiphoneContactAttempts++;
        this.abiphoneContactRetryReadyAt =
            now +
            (this.abiphoneContactAttempts >= 4
                ? ABIPHONE_UI_FINAL_TIMEOUT_MS
                : ABIPHONE_UI_RETRY_DELAYS_MS[this.abiphoneContactAttempts - 1]);
    }

    resetAbiphoneInteraction() {
        this.resetAbiphoneOpenRetry();
        this.abiphoneContactAttempts = 0;
        this.abiphoneContactRetryReadyAt = 0;
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
        this.resetPigeonInteraction();
        this.resetAbiphoneInteraction();
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
