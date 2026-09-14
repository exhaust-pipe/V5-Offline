const NativeGameState = Java.type('com.chattriggers.ctjs.api.client.GameState');

class GameStateTracker {
    constructor() {
        this.listeners = [];
        this.current = this.normalize(NativeGameState.getCurrent());
        register('gameStateChanged', (event) => {
            const snapshot = this.normalize(event);
            this.current = snapshot;
            this.listeners.slice().forEach(({ callback }) => {
                try {
                    callback(snapshot);
                } catch (e) {
                    console.error(`Game state listener: ${e}\n${e.stack}`);
                }
            });
        });
    }

    normalize(event) {
        return Object.freeze({
            id: Number(event.id),
            state: String(event.state),
            cause: String(event.cause),
            source: String(event.source),
            reason: String(event.reason),
            server: String(event.server),
        });
    }

    subscribe(callback, priority = 0) {
        const entry = { callback, priority };
        this.listeners.push(entry);
        this.listeners.sort((a, b) => b.priority - a.priority);
        return () => {
            this.listeners = this.listeners.filter((listener) => listener !== entry);
        };
    }

    disconnect(reason, source = 'script') {
        Client.disconnect(String(reason), String(source));
    }

    connect(address, source = 'script') {
        const parsed = net.minecraft.client.multiplayer.resolver.ServerAddress.parseString(address);
        Client.connect(String(parsed.getHost()), parsed.getPort(), source);
    }
}

export const GameState = new GameStateTracker();
