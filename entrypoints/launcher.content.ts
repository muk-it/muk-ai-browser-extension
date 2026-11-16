import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { isMessage } from '../lib/messaging';
import { launcherTopItem, showLauncherItem } from '../lib/storage';

/** Id of the launcher host, so a second injection is a no-op. */
const HOST_ID = 'muk-ai-launcher';

/** Pointer travel in pixels that turns a press into a drag. */
const DRAG_THRESHOLD = 4;

/** Styles of the launcher, inside its shadow root. */
const STYLE = `
    :host { all: initial; }
    .mk-launcher {
        position: fixed;
        right: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 64px;
        padding: 0;
        border: none;
        border-radius: 10px 0 0 10px;
        background: #33627e;
        color: #fff;
        box-shadow: -2px 2px 10px #13181c40;
        cursor: pointer;
        transform: translateY(-50%);
        touch-action: none;
        transition: width 120ms ease;
    }
    .mk-launcher:hover { width: 32px; }
    .mk-launcher:focus-visible { outline: 3px solid #9ebccd; outline-offset: 2px; }
    .mk-launcher[data-dragging] { cursor: grabbing; transition: none; }
    .mk-launcher svg { width: 18px; height: 18px; pointer-events: none; }
    .mk-label {
        position: absolute;
        right: calc(100% + 8px);
        padding: 4px 8px;
        border-radius: 6px;
        background: #1c3a4c;
        color: #fff;
        font: 600 12px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 120ms ease;
    }
    .mk-launcher:hover .mk-label,
    .mk-launcher:focus-visible .mk-label { opacity: 1; }
    .mk-launcher[data-dragging] .mk-label { opacity: 0; }
`;

/**
 * In-page launcher: a slim tab on the right edge that opens the MuK AI side
 * panel. The service worker registers it on every site once the user allowed
 * the extension on all sites, except on the paired Odoo, which has its own
 * chat. It can be dragged up and down (remembered per
 * site), hides while the side panel of its window is open, and shows only
 * while "Show the MuK AI tab on pages" is on. The click sends a message and
 * the service worker opens the panel at once, while the user gesture counts.
 */
export default defineContentScript({
    registration: 'runtime',
    runAt: 'document_idle',
    async main(ctx) {
        if (window.top !== window.self || document.getElementById(HOST_ID)) {
            return;
        }
        const host = document.createElement('div');
        host.id = HOST_ID;
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = STYLE;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mk-launcher';
        button.setAttribute('aria-label', 'Open MuK AI');
        button.innerHTML =
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" ' +
            'd="M12 2l1.9 4.6L18.5 8.5 13.9 10.4 12 15l-1.9-4.6L5.5 8.5l4.6-1.9L12 2z"/>' +
            '<circle cx="18.5" cy="17.5" r="2.3" fill="currentColor" opacity="0.85"/></svg>' +
            '<span class="mk-label" aria-hidden="true">MuK AI</span>';
        shadow.append(style, button);

        const topItem = launcherTopItem(location.host);
        const place = (top: number) => {
            button.style.top = `${Math.round(top * 100)}%`;
        };
        place(await topItem.getValue());

        const state = {
            show: await showLauncherItem.getValue(),
            panelOpen: Boolean(
                await browser.runtime
                    .sendMessage({ type: 'launcher/hello' })
                    .catch(() => false),
            ),
        };
        const render = () => {
            host.style.display = state.show && !state.panelOpen ? '' : 'none';
        };
        render();
        const unwatch = showLauncherItem.watch((show) => {
            state.show = show;
            render();
        });
        const onMessage = (message: unknown) => {
            if (isMessage(message, 'launcher/panel')) {
                state.panelOpen = message.open;
                render();
            }
        };
        browser.runtime.onMessage.addListener(onMessage);

        let drag: { startY: number; moved: boolean } | null = null;
        button.addEventListener('pointerdown', (event) => {
            drag = { startY: event.clientY, moved: false };
            button.setPointerCapture(event.pointerId);
        });
        button.addEventListener('pointermove', (event) => {
            if (!drag) {
                return;
            }
            if (Math.abs(event.clientY - drag.startY) > DRAG_THRESHOLD) {
                drag.moved = true;
                button.toggleAttribute('data-dragging', true);
            }
            if (drag.moved) {
                place(clampTop(event.clientY / window.innerHeight));
            }
        });
        button.addEventListener('pointercancel', () => {
            drag = null;
            button.removeAttribute('data-dragging');
        });
        button.addEventListener('pointerup', (event) => {
            if (drag?.moved) {
                void topItem.setValue(clampTop(event.clientY / window.innerHeight));
            }
        });
        button.addEventListener('click', (event) => {
            const dragged = drag?.moved;
            drag = null;
            button.removeAttribute('data-dragging');
            if (dragged) {
                event.preventDefault();
                return;
            }
            void browser.runtime.sendMessage({ type: 'launcher/open-panel' });
        });

        document.documentElement.append(host);
        ctx.onInvalidated(() => {
            unwatch();
            browser.runtime.onMessage.removeListener(onMessage);
            host.remove();
        });
    },
});

/**
 * Keep the launcher fully on screen.
 *
 * @param top - Wanted centre, as a fraction of the viewport height.
 * @returns The centre between 8% and 92%.
 */
function clampTop(top: number): number {
    return Math.min(0.92, Math.max(0.08, top));
}
