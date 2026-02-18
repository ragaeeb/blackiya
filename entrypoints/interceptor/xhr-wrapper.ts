export type XhrOpenHandler = (method: string, url: string) => void;

export function notifyXhrOpen(method: string, url: string, onOpen: XhrOpenHandler): void {
    onOpen(method, url);
}
