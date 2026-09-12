import { AlertUtils } from '../../failsafes/AlertUtils';
import { getSetting } from '../../gui/GuiSave';
import { File, globalAssetsDir } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';

class Failsafes extends ModuleBase {
    constructor() {
        super({
            name: 'Failsafes',
            subcategory: 'Core',
            description: 'Failsafe settings.',
            tooltip: 'Failsafe config.',
            hideInModules: true,
        });

        this.tp = true;
        this.rotation = true;
        this.velocity = true;
        this.slotChange = true;
        this.chatMention = true;
        this.playerGrief = true;
        this.clipOnBan = true;
        this.playerProximityDistance = 3;
        this.actionDelay = { low: 500, high: 2000 };
        this.pingOnCheck = 'None';
        this.playSoundOnCheck = true;
        this.ignoreTeleportItems = false;
        this.notifyMacroIntensity = true;
        this.lastBanLogTime = 0;

        const sectionName = 'Failsafes';

        this.addDirectToggle(
            'Ignore Held Teleport Items',
            (value) => {
                this.ignoreTeleportItems = value;
            },
            'Skip teleport detection while holding Aspect of the Void or Aspect of the End.',
            this.ignoreTeleportItems,
            sectionName
        );
        this.addDirectToggle(
            'Notify Macro Intensity',
            (value) => {
                this.notifyMacroIntensity = value;
            },
            'Notify running macros of the intensity added by each failsafe trigger.',
            this.notifyMacroIntensity,
            sectionName
        );

        this.addDirectMultiToggle(
            'Enabled Failsafes',
            ['TP', 'Rotation', 'Velocity', 'Slot Change', 'Chat Mention', 'Player Grief'],
            false,
            (value) => {
                const enabled = Array.isArray(value) ? value : [];
                this.tp = enabled.includes('TP');
                this.rotation = enabled.includes('Rotation');
                this.velocity = enabled.includes('Velocity');
                this.slotChange = enabled.includes('Slot Change');
                this.chatMention = enabled.includes('Chat Mention');
                this.playerGrief = enabled.includes('Player Grief');
            },
            'Select which failsafes are enabled',
            ['TP', 'Rotation', 'Velocity', 'Slot Change', 'Chat Mention', 'Player Grief'],
            sectionName
        );
        this.addDirectRangeSlider(
            'Failsafe Detection Delay (ms)',
            500,
            5000,
            this.actionDelay,
            (value) => {
                this.actionDelay = value;
            },
            'Delay in milliseconds between detection of failsafe',
            sectionName
        );
        this.addDirectSlider(
            'Player Proximity Distance',
            1,
            10,
            this.playerProximityDistance,
            (value) => {
                this.playerProximityDistance = value;
            },
            'Distance in blocks for player nearby detection',
            sectionName
        );
        this.addDirectToggle(
            'Clip on ban',
            (value) => {
                this.clipOnBan = value;
            },
            'Toggle clip on ban',
            this.clipOnBan,
            sectionName
        );
        this.addDirectToggle(
            'Play sound on check',
            (value) => {
                this.playSoundOnCheck = value;
            },
            'Toggle play sound on check',
            this.playSoundOnCheck,
            sectionName
        );
        this.addDirectMultiToggle(
            'Failsafe sound',
            this.getFilesInDir(),
            true,
            () => {
                const selectedFiles = getSetting('Failsafes', 'Failsafe sound');
                if (!Array.isArray(selectedFiles)) return;
                const enabledNames = selectedFiles.filter((fileObject) => fileObject.enabled).map((fileObject) => fileObject.name);
                if (enabledNames.length === 0) return;

                const singleEnabledName = enabledNames[0] + '.wav';

                AlertUtils.setFailsafeSound(singleEnabledName);
            },
            null,
            false,
            sectionName
        );
    }

    getFilesInDir() {
        const targetPath = new File(globalAssetsDir, 'failsafes/sounds');

        if (!targetPath.exists() || !targetPath.isDirectory()) {
            this.message('&cError: Directory not found.');
            return [];
        }

        const fileArray = targetPath.listFiles();
        const fileNames = [];

        if (!fileArray) return [];

        for (const file of fileArray) {
            const name = file.getName();
            if (name.endsWith('.wav')) fileNames.push(name.slice(0, -4));
        }

        return fileNames.sort((a, b) => a.localeCompare(b));
    }
}

export default new Failsafes();
