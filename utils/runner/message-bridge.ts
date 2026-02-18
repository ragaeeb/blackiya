export type RunnerMessageHandler = (message: unknown) => boolean;

export function dispatchRunnerMessage(message: unknown, handlers: RunnerMessageHandler[]) {
    for (const handler of handlers) {
        if (handler(message)) {
            return true;
        }
    }
    return false;
}
