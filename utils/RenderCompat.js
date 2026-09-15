// Narrow compatibility shim for Offline modules that still call the pre-5.2 RenderUtils global.
// New and upstream-synced code should use Render3D directly.
const compat = {
    drawStyledBox(position, fillColor, outlineColor, lineWidth = 1, throughWalls = false) {
        Render3D.drawStyledBoxes([position], fillColor, outlineColor, lineWidth, throughWalls);
    },
    drawFilledBox(position, color, throughWalls = false) {
        Render3D.drawFilledBoxes([position], color, throughWalls);
    },
    drawLine(points, color, lineWidth = 1, throughWalls = false) {
        const list = Array.isArray(points) ? points : [points];
        Render3D.drawLines(list, color, lineWidth, throughWalls);
    },
};

global.RenderUtils = compat;
export const RenderUtils = compat;
