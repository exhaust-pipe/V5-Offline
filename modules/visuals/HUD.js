import { drawStatsHud, getInventoryHudBounds, getStatsHudBounds, getStatsHudLines } from '../../gui/OverlayRenderers';
import { colorWithAlpha, THEME } from '../../gui/Utils';
import { ModuleBase } from '../../utils/ModuleBase';
import { getConfigFile, writeConfigFile } from '../../utils/Utils';
import { OverlayManager } from '../../gui/OverlayUtils';
import { GuiState } from '../../gui/core/GuiState';

const DrawContextHolder = com.chattriggers.ctjs.api.render.DrawContextHolder;

class HUD extends ModuleBase {
    constructor() {
        super({
            name: 'HUD',
            subcategory: 'Visuals',
            description: 'Different GUI components',
            tooltip: 'GUI overlays like FPS counter or Inventory HUD',
            showEnabledToggle: false,
        });

        this.STATS_HUD = true;
        this.INVENTORY_HUD = true;
        this.INVENTORY_HUD_BACKGROUND = true;
        this.worldLoaded = World.isLoaded();

        this.addToggle('Stats Hud', (v) => (this.STATS_HUD = !!v), 'Shows FPS, TPS, Ping etc.', true);
        this.inventoryHudToggle = this.addToggle(
            'Inventory Hud',
            (v) => {
                this.INVENTORY_HUD = !!v;
                if (this.inventoryBackgroundToggle) this.inventoryBackgroundToggle.visible = this.INVENTORY_HUD;
                this.updateRenderRegistrations();
            },
            'Turns on the inventory Hud',
            true
        );
        this.inventoryBackgroundToggle = this.addToggle(
            'Show Background',
            (v) => (this.INVENTORY_HUD_BACKGROUND = !!v),
            'Show the Inventory Hud background during normal gameplay. The overlay editor always shows the background preview.',
            true
        );
        this.inventoryBackgroundToggle.visible = this.INVENTORY_HUD;

        this.positionConfig = getConfigFile('OverlayPositions/hud_positions.json') || {};
        this.stats = this.loadOverlayState('stats', { x: 10, y: 10, scale: 1.0 });
        this.inventory = this.loadOverlayState('inventory', {
            x: 50,
            y: 100,
            scale: 1.0,
        });

        // Match the v1 HUD lifecycle: inventory contents are submitted with the HUD,
        // before Minecraft screens are extracted. Do not submit them again post-GUI.
        this.when(
            () => this.INVENTORY_HUD,
            'renderOverlay',
            () => this.renderOverlay()
        );
        this.statsCallback = () => this.renderStatsOverlay();
        this.statsRegistration = null;

        register('gameUnload', () => this.savePositions());
        register('guiClosed', () => this.savePositions());
        register('tick', () => {
            this.worldLoaded = World.isLoaded();
            this.updateRenderRegistrations();
        });
        this.updateRenderRegistrations();
    }

    onDisable() {
        this.savePositions();
    }

    loadOverlayState(key, defaults) {
        const saved = this.positionConfig?.[key] || {};
        const x = typeof saved.x === 'number' ? saved.x : defaults.x;
        const y = typeof saved.y === 'number' ? saved.y : defaults.y;
        const rawScale = typeof saved.scale === 'number' ? saved.scale : defaults.scale;
        const scale = this.clamp(rawScale, 0.5, 3.0);

        return {
            x,
            y,
            scale,
            enabled: saved.enabled !== false,

            width: 0,
            height: 0,
        };
    }

    getSaveData(overlay) {
        return {
            x: overlay.x,
            y: overlay.y,
            scale: overlay.scale,
            enabled: overlay.enabled !== false,
        };
    }

    applyOverlayState(overlay, saved = {}) {
        if (typeof saved.x === 'number') overlay.x = saved.x;
        if (typeof saved.y === 'number') overlay.y = saved.y;
        if (typeof saved.scale === 'number') overlay.scale = this.clamp(saved.scale, 0.5, 3.0);
        if (typeof saved.enabled === 'boolean') overlay.enabled = saved.enabled;
    }

    syncFromOverlayEditor() {
        const latest = OverlayManager?.hudSettings;
        if (!latest || typeof latest !== 'object') return;

        if (latest.stats && typeof latest.stats === 'object') {
            this.applyOverlayState(this.stats, latest.stats);
        }

        if (latest.inventory && typeof latest.inventory === 'object') {
            this.applyOverlayState(this.inventory, latest.inventory);
        }

        this.positionConfig = latest;
    }

    savePositions() {
        this.syncFromOverlayEditor();
        this.positionConfig = {
            stats: this.getSaveData(this.stats),
            inventory: this.getSaveData(this.inventory),
        };
        writeConfigFile('OverlayPositions/hud_positions.json', this.positionConfig);
    }

    clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    clampOverlayToScreen(overlay) {
        const sw = Render2D.screen.getWidth();
        const sh = Render2D.screen.getHeight();
        if (sw <= 0 || sh <= 0) return;

        const maxX = Math.max(0, sw - overlay.width);
        const maxY = Math.max(0, sh - overlay.height);
        overlay.x = Math.max(0, Math.min(maxX, overlay.x));
        overlay.y = Math.max(0, Math.min(maxY, overlay.y));
    }

    recalcStatsBounds() {
        const o = this.stats;
        Object.assign(o, getStatsHudBounds(o.scale));

        this.clampOverlayToScreen(o);
    }

    recalcInventoryBounds() {
        const o = this.inventory;
        Object.assign(o, getInventoryHudBounds(o.scale));

        this.clampOverlayToScreen(o);
    }

    prepareOverlay(enabled, recalc) {
        if (Client.isInGui() || GuiState.myGui.isOpen() || OverlayManager.drawingGUI || !enabled || !this.worldLoaded) return false;

        if (Render2D.screen.getWidth() <= 0 || Render2D.screen.getHeight() <= 0) return false;

        recalc.call(this);
        return true;
    }

    updateRenderRegistrations() {
        this.syncFromOverlayEditor();
        const visible = this.worldLoaded && !Client.isInGui() && !GuiState.myGui.isOpen() && !OverlayManager.drawingGUI;
        if (visible && this.STATS_HUD && this.stats.enabled !== false && !this.statsRegistration) {
            this.statsRegistration = Render2D.registerV5Render(this.statsCallback);
        } else if ((!visible || !this.STATS_HUD || this.stats.enabled === false) && this.statsRegistration) {
            Render2D.unregisterV5Render(this.statsRegistration);
            this.statsRegistration = null;
        }
    }

    fillRoundedRect(context, x, y, width, height, radius, color) {
        const left = Math.round(x);
        const top = Math.round(y);
        const right = Math.round(x + width);
        const bottom = Math.round(y + height);
        const maxRadius = Math.max(0, Math.floor(Math.min((right - left) / 2, (bottom - top) / 2)));
        const r = Math.min(maxRadius, Math.max(0, Math.round(radius)));

        if (r <= 1) {
            context.fill(left, top, right, bottom, color);
            return;
        }

        context.fill(left, top + r, right, bottom - r, color);
        context.fill(left + r, top, right - r, bottom, color);

        for (let row = 0; row < r; row++) {
            const dy = r - row - 0.5;
            const inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
            context.fill(left + inset, top + row, right - inset, top + row + 1, color);
            context.fill(left + inset, bottom - row - 1, right - inset, bottom - row, color);
        }
    }

    drawInventoryHudBackground(context) {
        const { x, y, width, height, scale } = this.inventory;
        const border = Math.max(1, Math.round(scale));
        const radius = 6.6 * scale;
        const borderColor = THEME.BORDER.getRGB();
        const backgroundColor = THEME.BG_COMPONENT.getRGB();

        this.fillRoundedRect(context, x - border, y - border, width + border * 2, height + border * 2, radius + border, borderColor);
        this.fillRoundedRect(context, x, y, width, height, radius, backgroundColor);

        const pad = 6 * scale;
        const slot = 18 * scale;
        const gap = 4 * scale;
        const rowWidth = 9 * slot;
        const separatorY = Math.round(y + pad + 3 * slot + gap / 2 - Math.max(1, scale) / 2);
        const separatorHeight = Math.max(1, Math.round(scale));
        const segments = 18;

        for (let i = 0; i < segments; i++) {
            const progress = (i + 0.5) / segments;
            const alpha = 0.3 * (1 - Math.abs(progress * 2 - 1));
            const x1 = Math.round(x + pad + (rowWidth * i) / segments);
            const x2 = Math.round(x + pad + (rowWidth * (i + 1)) / segments);
            context.fill(x1, separatorY, Math.max(x1 + 1, x2), separatorY + separatorHeight, colorWithAlpha(THEME.ACCENT, alpha));
        }
    }

    drawInventoryHudItems(context) {
        const inventory = Player.getPlayer()?.getInventory();
        if (!inventory || !context) return;

        const { x, y, scale } = this.inventory;
        const pose = context.pose();

        pose.pushMatrix();
        pose.translate(x + 7 * scale, y + 7 * scale);
        pose.scale(scale, scale);

        try {
            for (let i = 0; i < 27; i++) {
                const stack = inventory.getItem(i + 9);
                if (!stack.isEmpty()) context.item(stack, (i % 9) * 18, Math.floor(i / 9) * 18);
            }

            for (let i = 0; i < 9; i++) {
                const stack = inventory.getItem(i);
                if (!stack.isEmpty()) context.item(stack, i * 18, 58);
            }
        } finally {
            pose.popMatrix();
        }
    }

    renderOverlay() {
        if (!this.prepareOverlay(this.INVENTORY_HUD && this.inventory.enabled !== false, this.recalcInventoryBounds)) return;

        const context = DrawContextHolder.currentContext;
        if (!context) return;

        try {
            // Submit background first, then item render states, matching the v1 ordering
            // while keeping both in Minecraft's GUI extraction/render pipeline.
            if (this.INVENTORY_HUD_BACKGROUND) this.drawInventoryHudBackground(context);
            this.drawInventoryHudItems(context);
        } catch (e) {
            console.error(e);
        }
    }

    renderStatsOverlay() {
        if (!this.prepareOverlay(this.STATS_HUD && this.stats.enabled !== false, this.recalcStatsBounds)) return;
        try {
            drawStatsHud(this.stats, getStatsHudLines());
        } catch (e) {
            console.error(e);
        }
    }
}

new HUD();
