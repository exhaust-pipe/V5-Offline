export function executeAsync(task) {
    if (typeof task !== 'function') return;

    // Loader generations prevent async work created before /ct load from reaching the replacement scripts.
    const generation = ChatTriggers.getScriptGeneration();
    new Thread(() => {
        if (!ChatTriggers.isScriptGenerationCurrent(generation)) return;
        try {
            task();
        } catch (error) {
            if (!ChatTriggers.isScriptGenerationCurrent(generation)) return;
            console.error('[V5 Thread Error]:');
            console.error(error);
        }
    }).start();
}

export const Executor = { execute: executeAsync };
