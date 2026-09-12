import { ModuleBase } from '../../utils/ModuleBase';
import { GLFW } from '../../utils/Constants';

const MOVE_KEYS = ['w', 'a', 's', 'd'];
const KEY_MAPPINGS = { w: 'keyUp', a: 'keyLeft', s: 'keyDown', d: 'keyRight', space: 'keyJump', shift: 'keyShift' };
const InputConstants = com.mojang.blaze3d.platform.InputConstants;

class AfkMacro extends ModuleBase {
    constructor() {
        super({
            name: 'AFK',
            subcategory: 'Other',
            description: 'Stay idle with occasional small movements and optional jumping or sneaking.',
            isMacro: true,
            recoverFromLimbo: false,
        });

        this.randomMovement = true;
        this.randomJump = false;
        this.sneak = false;
        this.interval = { low: 30, high: 60 };
        this.nextActionAt = 0;
        this.moveKey = null;
        this.moveTicks = 0;
        this.moveOrigin = null;
        this.parent = null;
        this.allowManualStop = false;
        this.session = null;
        this.heldKeys = new Set();

        this.bindToggleKey();
        this.addToggle(
            'Random Movement',
            (value) => {
                this.randomMovement = value;
            },
            'Occasionally tap a random movement key.',
            true
        );
        this.addToggle(
            'Random Jump',
            (value) => {
                this.randomJump = value;
            },
            'Jump once at each random interval.',
            false
        );
        this.addRangeSlider(
            'Action Interval (s)',
            1,
            600,
            this.interval,
            (value) => {
                this.interval = { low: value.low, high: value.high };
                if (this.enabled) this.scheduleAction();
            },
            'Minimum and maximum random delay between movements or jumps.'
        );
        this.addToggle(
            'Always Sneak',
            (value) => {
                this.sneak = value;
            },
            'Continuously hold sneak while AFK is active.',
            false
        );

        this.createOverlay([
            {
                title: 'Status',
                data: {
                    State: () => this.getStatus(),
                    'Next Action': () => this.getNextAction(),
                    Sneaking: () => (this.sneak ? 'On' : 'Off'),
                },
            },
        ]);

        this.on('tick', () => this.tick());
        this.on('worldUnload', () => {
            this.releaseKeys();
            this.scheduleAction();
        });
        this.on('serverDisconnect', () => this.toggle(false, true, 'disconnect'));
        this.on('gameUnload', () => this.toggle(false, true, 'unload'));
    }

    startAsChild(parent, allowManualStop = false) {
        if (!parent || this.enabled) return false;
        this.parent = parent;
        this.allowManualStop = allowManualStop;
        this.toggle(true, true, 'parent');
        return this.enabled;
    }

    requestToggleFromUser() {
        if (this.enabled && this.isParentManaged && this.allowManualStop) {
            this.toggle(false, false, 'user');
            return false;
        }
        return super.requestToggleFromUser();
    }

    stopAsChild(parent) {
        if (!parent || !this.enabled || !this.isParentManaged || this.parent !== parent) return false;
        this.toggle(false, true, 'parent');
        return true;
    }

    scheduleAction() {
        const low = Math.max(1, Math.min(this.interval.low, this.interval.high));
        const high = Math.max(low, this.interval.low, this.interval.high);
        this.nextActionAt = Date.now() + (low + Math.random() * (high - low)) * 1000;
    }

    getStatus() {
        if (!World.isLoaded() || !Player.getPlayer()) return 'Waiting for world';
        if (Client.isInGui()) return 'Paused in GUI';
        return this.moveKey ? 'Moving' : 'Idle';
    }

    getNextAction() {
        if (!this.randomMovement && !this.randomJump) return 'Off';
        return `${Math.max(0, Math.ceil((this.nextActionAt - Date.now()) / 1000))}s`;
    }

    tick() {
        if (this.parent?.enabled === false) {
            this.stopAsChild(this.parent);
            return;
        }
        if (!World.isLoaded() || !Player.getPlayer() || Client.isInGui()) {
            this.releaseKeys();
            this.scheduleAction();
            return;
        }

        this.setKey('space', false);
        this.setKey('shift', this.sneak);

        if (this.moveKey) {
            const distance = Math.hypot(Player.getX() - this.moveOrigin.x, Player.getZ() - this.moveOrigin.z);
            if (!this.randomMovement || --this.moveTicks <= 0 || distance >= 0.15) {
                this.setKey(this.moveKey, false);
                this.moveKey = null;
                this.moveOrigin = null;
            }
        }

        if (Date.now() < this.nextActionAt) return;
        this.scheduleAction();
        if (this.randomMovement) {
            this.moveKey = MOVE_KEYS[Math.floor(Math.random() * MOVE_KEYS.length)];
            this.moveTicks = 2;
            this.moveOrigin = { x: Player.getX(), z: Player.getZ() };
            this.setKey(this.moveKey, true);
        }
        if (this.randomJump && Player.getPlayer().onGround()) this.setKey('space', true);
    }

    setKey(key, pressed) {
        if (pressed) {
            if (Client.setKey(key, true)) this.heldKeys.add(key);
            return;
        }
        if (!this.heldKeys.delete(key)) return;

        Client.setKey(key, false);
        const mc = Client.getMinecraft();
        if (!World.isLoaded() || !Player.getPlayer() || Client.isInGui() || !mc.isWindowActive()) return;

        // Ending an AFK key press must preserve a key the player is still physically holding.
        const mapping = mc.options[KEY_MAPPINGS[key]];
        const input = InputConstants.getKey(mapping.saveString());
        const window = mc.getWindow();
        if (input.getType().equals(InputConstants.Type.MOUSE)) {
            if (GLFW.glfwGetMouseButton(window.handle(), input.getValue()) === GLFW.GLFW_PRESS) mapping.setDown(true);
        } else if (input.getType().equals(InputConstants.Type.KEYSYM) && input.getValue() >= 0) {
            if (InputConstants.isKeyDown(window, input.getValue())) mapping.setDown(true);
        }
    }

    releaseKeys() {
        Array.from(this.heldKeys).forEach((key) => this.setKey(key, false));
        this.moveKey = null;
        this.moveTicks = 0;
        this.moveOrigin = null;
    }

    onEnable() {
        this.session = {};
        this.scheduleAction();
        this.message('&aEnabled');
    }

    onDisable() {
        this.releaseKeys();
        this.nextActionAt = 0;
        const parent = this.parent;
        this.parent = null;
        this.allowManualStop = false;
        this.session = null;
        parent?.onAfkStopped?.();
        this.message('&cDisabled');
    }
}

export const Afk = new AfkMacro();
