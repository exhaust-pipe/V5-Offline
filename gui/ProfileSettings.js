import { Categories } from './categories/CategorySystem';
import { GuiState } from './core/GuiState';
import { isGuiClickSoundEnabled, setGuiClickSoundEnabled } from './Utils';

const initProfileSettings = () => {
    let guiScaleSetting;
    let clientCat = Categories.categories.find((category) => category.name === 'Client');
    if (!clientCat) {
        clientCat = {
            name: 'Client',
            items: [],
            subcategories: [],
            directComponents: [],
            hiddenInSidebar: true,
        };
        Categories.categories.push(clientCat);
    } else if (!clientCat.directComponents) {
        clientCat.directComponents = [];
    }

    const hasScrollSpeed = clientCat.directComponents.some((component) => component.title === 'GUI Scroll Speed');
    if (!hasScrollSpeed) {
        Categories.addSettingsSlider(
            'GUI Scroll Speed',
            5,
            45,
            Categories.guiScrollSpeed,
            (value) => {
                Categories.guiScrollSpeed = Math.max(1, Number(value) || 15);
            },
            'Adjusts how fast the GUI panels scroll.',
            'GUI',
            'Client'
        );
    }

    const hasGuiScale = clientCat.directComponents.some((component) => component.title === 'GUI Scale');
    if (!hasGuiScale) {
        guiScaleSetting = Categories.addSettingsSlider(
            'GUI Scale',
            0.5,
            2,
            GuiState.guiScale,
            (value) => {
                if (guiScaleSetting.dragging) GuiState.pendingGuiScale = value;
                else GuiState.setGuiScale(value);
            },
            'Adjusts the size of the V5 GUI.',
            'GUI',
            'Client'
        );
    }

    const hasClickSound = clientCat.directComponents.some((component) => component.title === 'GUI Click Sound');
    if (!hasClickSound) {
        Categories.addSettingsToggle(
            'GUI Click Sound',
            (value) => {
                setGuiClickSoundEnabled(!!value);
            },
            'Plays a click sound when interacting with GUI.',
            isGuiClickSoundEnabled(),
            'GUI',
            'Client'
        );
    }
};

initProfileSettings();
