import { ModuleBase } from '../../utils/ModuleBase';

const NameReplacement = Java.type('com.chattriggers.ctjs.internal.utils.NameReplacement');

class ProfileHider extends ModuleBase {
    constructor() {
        super({
            name: 'Profile Hider',
            subcategory: 'Visuals',
            description: 'Hides your profile',
        });

        this.HIDE_USERNAME = true;
        this.USERNAME = null;
        this.GRADIENT = true;
        this.BOLD = true;

        this.addToggle(
            'Custom Username',
            (v) => {
                this.HIDE_USERNAME = v;
                this.updateName();
            },
            'Allows for custom usernames',
            true
        );
        this.addTextInput(
            'Username',
            ' ',
            (v) => {
                this.USERNAME = v;
                this.updateName();
            },
            'The username you want to use'
        );
        this.addToggle(
            'Gradient',
            (v) => {
                this.GRADIENT = v;
                this.updateName();
            },
            'Use the animated gradient effect for plain replacement names.',
            true
        );
        this.addToggle(
            'Bold',
            (v) => {
                this.BOLD = v;
                this.updateName();
            },
            'Use bold text for plain replacement names.',
            true
        );

        Client.setNameProcessor(null);
        register('gameUnload', () => Client.setNameReplacement(null, null));
    }

    updateName() {
        if (!this.enabled) return;
        const username = this.HIDE_USERNAME ? Player.getName() : null;
        NameReplacement.configure(username, this.USERNAME?.trim() || 'Hidden', this.GRADIENT, this.BOLD);
    }

    onEnable() {
        this.updateName();
    }

    onDisable() {
        Client.setNameReplacement(null, null);
    }
}

new ProfileHider();
