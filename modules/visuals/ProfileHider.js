import { Mixin } from '../../utils/MixinManager';
import { ModuleBase } from '../../utils/ModuleBase';

class ProfileHider extends ModuleBase {
    constructor() {
        super({
            name: 'Profile Hider',
            subcategory: 'Visuals',
            description: 'Hides your profile',
        });

        this.defaultName = null;
        this.HIDE_USERNAME = true;
        this.USERNAME = null;

        this.addToggle(
            'Custom Username',
            (v) => {
                this.HIDE_USERNAME = v;
                this.updateMixin();
            },
            'Allows for custom usernames',
            true
        );
        this.addTextInput(
            'Username',
            ' ',
            (v) => {
                this.USERNAME = v;
                this.updateMixin();
            },
            'The username you want to use'
        );
    }

    updateMixin() {
        Mixin.set('profileHiderReplacement', (this.HIDE_USERNAME && this.USERNAME?.trim()) || 'Hidden');
    }

    onEnable() {
        this.updateMixin();
        Mixin.set('profileHiderEnabled', true);
    }

    onDisable() {
        Mixin.set('profileHiderEnabled', false);
    }
}

new ProfileHider();
