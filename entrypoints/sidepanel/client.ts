import { browser } from 'wxt/browser';
import type { PanelToSwMessage, SwToPanelMessage } from '../../lib/messaging';

/**
 * The side panel's channel to the service worker: a long-lived port that
 * keeps polling alive while the panel is open. The worker answers with the
 * status.
 */
export class PanelClient {
    private port: chrome.runtime.Port | null = null;

    /**
     * Open the port and announce the panel with its window.
     *
     * @param onMessage - Called for every message the worker sends.
     */
    open(onMessage: (msg: SwToPanelMessage) => void): void {
        this.port = browser.runtime.connect({ name: 'muk-ai-panel' });
        this.port.onMessage.addListener((msg) => onMessage(msg as SwToPanelMessage));
        this.announce();
    }

    /** Announce the panel with its window; the worker answers and polls at once. */
    announce(): void {
        void browser.windows
            .getCurrent()
            .then((window) =>
                this.send({ type: 'panel/open', windowId: window.id ?? null }),
            );
    }

    /**
     * Send a message to the worker.
     *
     * @param message - The message.
     */
    send(message: PanelToSwMessage): void {
        this.port?.postMessage(message);
    }

    /** Close the port. */
    close(): void {
        this.port?.disconnect();
        this.port = null;
    }
}
