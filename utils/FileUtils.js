export function ensureDirectory(dir) {
    if (!dir) return;
    if (typeof dir.mkdirs !== 'function' || typeof dir.exists !== 'function') return;
    if (!dir.exists()) dir.mkdirs();
}

export function findFileRecursive(rootDir, fileName) {
    if (!rootDir || typeof rootDir.listFiles !== 'function') return null;
    const files = rootDir.listFiles();
    if (!files) return null;

    for (const file of files) {
        if (file.isDirectory()) {
            const nested = findFileRecursive(file, fileName);
            if (nested) return nested;
            continue;
        }

        if (file.getName() === fileName) return file;
    }

    return null;
}

export function deleteRecursive(target) {
    if (!target || !target.exists()) return;

    if (target.isDirectory()) {
        const children = target.listFiles();
        if (children) {
            for (const child of children) deleteRecursive(child);
        }
    }

    try {
        target.delete();
    } catch (e) {
        console.error('V5 Caught error' + e + e.stack);
    }
}
