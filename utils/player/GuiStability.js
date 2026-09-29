const GUI_STABILITY_DELAY_MS = 500;

export class GuiStability {
    constructor() {
        this.reset();
    }

    reset() {
        this.screen = null;
        this.windowId = -1;
        this.guiName = null;
        this.readyAt = Date.now() + GUI_STABILITY_DELAY_MS;
    }

    update() {
        const screen = Client.currentGui.get();
        const container = Player.getContainer();
        const windowId = container?.getWindowId() ?? -1;
        const guiName = container ? ChatLib.removeFormatting(String(container.getName())) : null;

        // A single interaction can open multiple screens, including ones with the same title.
        const screenChanged = screen ? !screen.equals(this.screen) : this.screen !== null;
        if (screenChanged || windowId !== this.windowId || guiName !== this.guiName) {
            this.screen = screen;
            this.windowId = windowId;
            this.guiName = guiName;
            this.readyAt = Date.now() + GUI_STABILITY_DELAY_MS;
        }

        return Date.now() >= this.readyAt;
    }
}
