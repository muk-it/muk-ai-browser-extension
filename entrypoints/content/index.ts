import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { isMessage } from '../../lib/messaging';
import { performAction } from '../../lib/actions';

/**
 * Agent content script (ISOLATED world). Never listed in the manifest: the
 * service worker injects it into the agent's tab on the first tool call, so the
 * extension holds no standing access to pages. It runs the page-side tools
 * and holds no secrets; a window flag keeps a second injection inert until
 * the extension reloads.
 */
export default defineContentScript({
    registration: 'runtime',
    world: 'ISOLATED',
    main(ctx) {
        const w = window as unknown as Record<string, boolean>;
        if (w.__mukAiAgent) {
            return;
        }
        w.__mukAiAgent = true;
        const onMessage = (
            message: unknown,
            _sender: unknown,
            sendResponse: (reply: unknown) => void,
        ) => {
            if (!isMessage(message, 'content/tool')) {
                return false;
            }
            void performAction(message.name, message.arguments).then(sendResponse);
            return true;
        };
        browser.runtime.onMessage.addListener(onMessage);
        ctx.onInvalidated(() => {
            delete w.__mukAiAgent;
            browser.runtime.onMessage.removeListener(onMessage);
        });
    },
});
