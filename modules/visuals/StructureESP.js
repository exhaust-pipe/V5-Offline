import { isDeveloperModeEnabled } from '../../utils/DeveloperModeState';
import { Vec3d } from '../../utils/Constants';
import { ModuleBase } from '../../utils/ModuleBase';
import { getArea } from '../../utils/TabListUtils';

const Objects = Java.type('java.util.Objects');

const GOLD = new RenderColor(255, 215, 0, 100);
const BLUE = new RenderColor(0, 0, 255, 100);
const GREEN = new RenderColor(0, 255, 0, 100);
const RED = new RenderColor(255, 0, 0, 100);
const PURPLE = new RenderColor(180, 70, 255, 110);
const WHITE = new RenderColor(255, 255, 255, 100);
const STRUCTURE_COLORS = {
    'Mines of Divan': GOLD,
    'Precursor Remnants': BLUE,
    'Jungle Temple': GREEN,
    'Goblin King': RED,
    Bal: RED,
    'Fairy Grotto': PURPLE,
    'Key Guardian Spiral': PURPLE,
    'Golden Dragon Nest': GOLD,
};
const DEFAULT_STRUCTURES = Object.keys(STRUCTURE_COLORS);
for (const name of [
    'Odawa',
    'Goblin Hall',
    'Goblin Ring',
    'Grunt Bridge',
    'Corleone Dock',
    'Corleone Hole',
    'Grunt Rails',
    'Grunt Hero Statue',
    'Small Grunt Bridge',
    'Sludge Waterfalls',
    'Sludge Bridges',
    'Yog Bridge',
    'Mini Jungle Temple',
    'Precursor Tripwire Chamber',
    'Precursor Tall Pillars',
    'Goblin Hole Camp',
    'Goblin Hideout',
])
    STRUCTURE_COLORS[name] = WHITE;

class StructureESP extends ModuleBase {
    constructor() {
        super({
            name: 'Structure ESP',
            subcategory: 'Visuals',
            description: 'Structure ESP for Crystal Hollows',
        });
        this.renderData = null;
        this.structureData = null;
        this.selectedStructures = new Set(DEFAULT_STRUCTURES);

        this.addMultiToggle(
            'Structures',
            Object.keys(STRUCTURE_COLORS),
            false,
            (options) => {
                this.selectedStructures = new Set(options.filter((option) => option.enabled).map((option) => option.name));
                this.renderData = null;
            },
            'Choose which structures to show',
            DEFAULT_STRUCTURES
        );

        this.on('tick', () => this.updateRenderData());

        this.on('postRenderWorld', () => this.render());

        this.on('worldUnload', () => {
            StructureFinder.setActive(false);
            this.renderData = null;
            this.structureData = null;
        });

        register('gameUnload', () => {
            StructureFinder.setActive(false);
        });
    }

    onEnable() {
        this.updateRenderData();
    }

    onDisable() {
        StructureFinder.setActive(false);
        this.renderData = null;
        this.structureData = null;
    }

    updateRenderData() {
        try {
            const inHollows = getArea() === 'Crystal Hollows';
            StructureFinder.setActive(inHollows);
            if (!inHollows) {
                this.renderData = null;
                this.structureData = null;
                return;
            }
            const structures = StructureFinder.getRenderStructures();
            if (!structures.length) {
                this.renderData = null;
                return;
            }
            const structuresChanged = !this.structureData || !Objects.equals(structures, this.structureData.structures);
            if (structuresChanged) {
                const entries = [];
                for (let i = 0; i < structures.length; i++) {
                    const structure = structures[i];
                    const name = String(structure.getName());
                    entries.push({ x: structure.getX() + 0.5, y: structure.getY(), z: structure.getZ() + 0.5, name, color: STRUCTURE_COLORS[name] });
                }
                this.structureData = { structures, entries };
            }
            const playerX = Player.getX();
            const playerY = Player.getY() + 1.6;
            const playerZ = Player.getZ();
            const maxDistance = Math.max(16, (Client.getMinecraft().options.getEffectiveRenderDistance() - 1) * 16);

            const previous = this.renderData;
            if (
                !structuresChanged &&
                previous &&
                previous.playerX === playerX &&
                previous.playerY === playerY &&
                previous.playerZ === playerZ &&
                previous.maxDistance === maxDistance
            )
                return;

            const positionsByColor = new Map();
            const names = [];
            const namePositions = [];
            for (const entry of this.structureData.entries) {
                if (!this.selectedStructures.has(entry.name)) continue;
                const { x, y, z } = entry;
                const dx = x - playerX;
                const dy = y - playerY;
                const dz = z - playerZ;
                const distance = Math.hypot(dx, dy, dz);
                const scale = distance > maxDistance ? maxDistance / distance : 1;
                const pos = new Vec3d(playerX + dx * scale, playerY + dy * scale, playerZ + dz * scale);
                if (!positionsByColor.has(entry.color)) positionsByColor.set(entry.color, []);
                positionsByColor.get(entry.color).push(pos);
                names.push(entry.name);
                namePositions.push(pos.add(0, 8.5, 0));
            }
            this.renderData = { positionsByColor, names, namePositions, playerX, playerY, playerZ, maxDistance };
        } catch (e) {
            console.error(e);
        }
    }

    render() {
        const data = this.renderData;
        if (!data) return;
        for (const [color, positions] of data.positionsByColor) Render3D.drawSizedBoxes(positions, 8, 8, 8, color, true, 1, false);
        Render3D.drawTexts(data.names, data.namePositions, 7.5, true, false, true);
    }
}

if (isDeveloperModeEnabled()) new StructureESP();
