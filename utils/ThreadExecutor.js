export function executeAsync(task) {
    if (typeof task !== 'function') return;

    // Loader generations prevent async work from a previous /ct load from reaching replacement scripts.
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
