export function executeAsync(task) {
    if (typeof task !== 'function') return;

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
