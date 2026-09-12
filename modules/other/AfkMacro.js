import { ModuleBase } from '../../utils/ModuleBase';
import { MacroState } from '../../utils/MacroState';
import { Mouse } from '../../utils/Ungrab';

const MOVE_KEYS = ['w', 'a', 's', 'd'];

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

    startAsChild(parent) {
        if (!parent || this.enabled) return false;
        this.parent = parent;
        this.toggle(true, true, 'parent');
        return this.enabled;
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

        Client.setKey('space', false);
        Client.setKey('shift', this.sneak);

        if (this.moveKey) {
            const distance = Math.hypot(Player.getX() - this.moveOrigin.x, Player.getZ() - this.moveOrigin.z);
            if (!this.randomMovement || --this.moveTicks <= 0 || distance >= 0.15) {
                Client.setKey(this.moveKey, false);
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
            Client.setKey(this.moveKey, true);
        }
        if (this.randomJump && Player.getPlayer().onGround()) Client.setKey('space', true);
    }

    releaseKeys() {
        [...MOVE_KEYS, 'space', 'shift'].forEach((key) => Client.setKey(key, false));
        this.moveKey = null;
        this.moveTicks = 0;
        this.moveOrigin = null;
    }

    onEnable() {
        Client.unpressKeys();
        this.scheduleAction();
        Mouse.ungrab();
        this.message('&aEnabled');
    }

    onDisable() {
        this.releaseKeys();
        this.nextActionAt = 0;
        const parent = this.parent;
        this.parent = null;
        if (!MacroState.isMacroRunning()) Mouse.regrab();
        parent?.onAfkStopped?.();
        this.message('&cDisabled');
    }
}

export const Afk = new AfkMacro();
