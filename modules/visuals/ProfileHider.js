import { ModuleBase } from '../../utils/ModuleBase';

class ProfileHider extends ModuleBase {
    constructor() {
        super({
            name: 'Profile Hider',
            subcategory: 'Visuals',
            description: 'Hides your profile',
        });

        this.HIDE_USERNAME = true;
        this.USERNAME = null;

        this.addToggle('Custom Username', (v) => {
            this.HIDE_USERNAME = v;
            this.updateName();
        }, 'Allows for custom usernames', true);
        this.addTextInput('Username', ' ', (v) => {
            this.USERNAME = v;
            this.updateName();
        }, 'The username you want to use');

        Client.setNameProcessor(null);
        register('gameUnload', () => Client.setNameReplacement(null, null));
    }

    updateName() {
        if (!this.enabled) return;
        const username = this.HIDE_USERNAME ? Player.getName() : null;
        Client.setNameReplacement(username, this.USERNAME?.trim() || 'Hidden');
    }

    onEnable() {
        this.updateName();
    }

    onDisable() {
        Client.setNameReplacement(null, null);
    }
}

new ProfileHider();
