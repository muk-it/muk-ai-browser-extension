import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { failure, isMessage } from '../../lib/messaging';
import { performAction } from '../../lib/actions';

/**
 * Agent content script (ISOLATED world). Never listed in the manifest: the
 * service worker injects it into the agent's tab on the first tool call, so the
 * extension holds no standing access to pages. It runs the page-side tools
 * and holds no secrets; a window flag keeps a second injection inert.
 */
export default defineContentScript({
    registration: 'runtime',
    world: 'ISOLATED',
    main() {
        const w = window as unknown as Record<string, boolean>;
        if (w.__mukAiAgent) {
            return;
        }
        w.__mukAiAgent = true;
        browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!isMessage(message, 'content/tool')) {
                return false;
            }
            void performAction(message.name, message.arguments)
                .catch((error: unknown) => failure('failed', String(error)))
                .then(sendResponse);
            return true;
        });
    },
});
