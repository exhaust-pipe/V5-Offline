// Narrow compatibility shim for Offline modules that still call the pre-5.2 RenderUtils global.
// New and upstream-synced code should use Render3D directly.
const depthFromThroughWalls = (throughWalls) => !throughWalls;

const compat = {
    drawStyledBox(position, fillColor, outlineColor, lineWidth = 1, throughWalls = false) {
        Render3D.drawStyledBox(position, fillColor, outlineColor, lineWidth, depthFromThroughWalls(throughWalls));
    },

    drawFilledBox(position, color, throughWalls = false) {
        Render3D.drawFilledBox(position, color, depthFromThroughWalls(throughWalls));
    },

    drawHitbox(entity, color, lineWidth = 2, throughWalls = false) {
        Render3D.drawHitbox(entity, color, lineWidth, depthFromThroughWalls(throughWalls));
    },

    drawHitboxes(entities, color, lineWidth = 2, throughWalls = false) {
        Render3D.drawHitboxes(entities, color, lineWidth, depthFromThroughWalls(throughWalls));
    },

    drawLine(startOrPoints, endOrColor, colorOrWidth, lineWidthOrThroughWalls = 1, throughWalls = false) {
        // Legacy RenderUtils primarily used drawLine(start, end, color, width, throughWalls).
        // Keep array support as well for any callers that already pass a polyline.
        if (Array.isArray(startOrPoints)) {
            const points = startOrPoints;
            const color = endOrColor;
            const lineWidth = typeof colorOrWidth === 'number' ? colorOrWidth : 1;
            const drawThroughWalls = typeof lineWidthOrThroughWalls === 'boolean' ? lineWidthOrThroughWalls : false;
            Render3D.drawLines(points, color, lineWidth, depthFromThroughWalls(drawThroughWalls));
            return;
        }

        const start = startOrPoints;
        const end = endOrColor;
        const color = colorOrWidth;
        const lineWidth = typeof lineWidthOrThroughWalls === 'number' ? lineWidthOrThroughWalls : 1;
        const drawThroughWalls = typeof lineWidthOrThroughWalls === 'boolean' ? lineWidthOrThroughWalls : throughWalls;
        Render3D.drawLine(start, end, color, lineWidth, depthFromThroughWalls(drawThroughWalls));
    },
};

global.RenderUtils = compat;
export const RenderUtils = compat;
