import { ModuleBase } from '../../utils/ModuleBase';
import { getModule, isMacroRunning } from '../../utils/MacroState';
import { getConfigFile, mc } from '../../utils/Utils';

const Perspective = net.minecraft.client.CameraType;

const renderLimiters = {
    Off: Client.RenderLimiter.OFF,
    'Limit Chunks': Client.RenderLimiter.LIMIT_CHUNKS,
    'No Render': Client.RenderLimiter.NO_RENDER,
};

class Controller extends ModuleBase {
    constructor() {
        super({
            name: 'Controller',
            subcategory: 'Core',
            description: 'Various toggles to improve peformance while game is minimized.',
            hideInModules: true,
        });

        let sectionName = 'Macro Controllers';

        this.savedPerspective = null;
        this.activePerspective = 'Off';
        this.startedFreelook = false;
        Client.setForcePerspective(false);

        this.autoPerspective = this.addDirectMultiToggle(
            'Auto-Perspective',
            ['Off', 'Third Person Back', 'Third Person Front', 'Freelook'],
            true,
            () => this.updatePerspective(),
            'Automatically switches camera mode while a macro is running.',
            getConfigFile('config.json')?.['Macro Controllers']?.['Auto-Perspective'] === true ? 'Third Person Back' : 'Off',
            sectionName
        );

        register('tick', () => this.updatePerspective());
        register('worldUnload', () => this.updatePerspective(true));
        register('gameUnload', () => this.updatePerspective(true));

        this.addDirectToggle('Limit FPS', (value) => Client.setLimitFps(value), 'Limits FPS while macro is running.', false, sectionName);
        this.addDirectToggle('Mute Game', (value) => Client.setMuteGame(value), 'Mutes game audio while macro is running.', false, sectionName);

        this.addDirectMultiToggle(
            'Render Limiters',
            ['Off', 'Limit Chunks', 'No Render'],
            true,
            (value) => Client.setRenderLimiter(renderLimiters[value?.find?.((option) => option.enabled)?.name || 'Off']),
            'Limits render distance or cancels rendering while macro is running.',
            'Off',
            sectionName
        );
    }

    updatePerspective(reset = false) {
        const freelook = getModule('Freelook');
        const mode =
            !reset && World.isLoaded() && isMacroRunning() && !Client.isFreecam()
                ? this.autoPerspective.options.find((option) => option.enabled)?.name || 'Off'
                : 'Off';

        if (mode !== this.activePerspective && this.startedFreelook) freelook?.toggle(false);
        if ((mode !== this.activePerspective || mode === 'Off') && this.savedPerspective && !Client.isFreecam() && !Client.isFreelook()) {
            mc.options.setCameraType(this.savedPerspective);
            this.savedPerspective = null;
        }

        if (mode !== this.activePerspective) {
            this.startedFreelook = false;
            this.activePerspective = mode;

            if (mode === 'Freelook' && freelook && !freelook.enabled) {
                freelook.toggle(true);
                this.startedFreelook = freelook.enabled;
            }
        }

        if ((mode === 'Third Person Back' || mode === 'Third Person Front') && !Client.isFreelook()) {
            this.savedPerspective ??= mc.options.getCameraType();
            mc.options.setCameraType(mode === 'Third Person Front' ? Perspective.THIRD_PERSON_FRONT : Perspective.THIRD_PERSON_BACK);
        }
    }
}

new Controller();
