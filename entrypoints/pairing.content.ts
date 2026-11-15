import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import type { PairingReply } from '../lib/messaging';

/** Meta tag the Odoo connect page renders the one-time code into. */
const PAIRING_META = 'meta[name="muk-ai-browser-pairing"]';

/** Check mark in a circle, in Odoo's success green. */
const CHECK_ICON =
    '<svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="11" fill="#28a745"/>' +
    '<path d="M7 12.5l3.2 3.2L17.5 8.5" fill="none" stroke="#fff" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Pairing reader. The service worker registers it at runtime for
 * `<odoo>/muk_ai_browser/connect*` only, once the user configured that Odoo and
 * granted its host permission. It hands the one-time code to the service
 * worker and turns the page's card into the outcome: connected, after which
 * the service worker closes the tab, or an error with a retry.
 */
export default defineContentScript({
    registration: 'runtime',
    runAt: 'document_idle',
    async main() {
        const code = document
            .querySelector(PAIRING_META)
            ?.getAttribute('content')
            ?.trim();
        const card = document.querySelector('.card-body');
        if (!code || !card) {
            return;
        }
        const status = card.querySelector('.mk_browser_status');
        status?.replaceChildren('Connecting this browser...');
        const reply = (await browser.runtime
            .sendMessage({ type: 'pairing/code', code })
            .catch(() => undefined)) as PairingReply | undefined;
        if (reply?.ok) {
            card.replaceChildren(connected());
        } else {
            (status ?? card).replaceWith(
                failed(reply?.error ?? 'The extension did not answer.'),
            );
        }
    },
});

/**
 * Build the connected state of the card.
 *
 * @returns The card content.
 */
function connected(): HTMLElement {
    const box = element('div', 'text-center py-2');
    box.setAttribute('role', 'status');
    const icon = element('div', 'mb-3');
    icon.innerHTML = CHECK_ICON;
    box.append(
        icon,
        element('h1', 'h4 mb-2', 'This browser is connected to Odoo'),
        element(
            'p',
            'text-muted mb-0',
            'This tab closes by itself. Continue in the MuK AI side panel.',
        ),
    );
    return box;
}

/**
 * Build the inline error that replaces the status line. Retry reloads the
 * page, which mints a fresh one-time code.
 *
 * @param error - What went wrong.
 * @returns The error block.
 */
function failed(error: string): HTMLElement {
    const box = element('div', 'alert alert-danger d-flex flex-wrap gap-2');
    box.setAttribute('role', 'alert');
    box.style.alignItems = 'center';
    const retry = element('button', 'btn btn-sm btn-outline-danger ms-auto', 'Retry');
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => location.reload());
    box.append(element('span', '', `This browser could not connect: ${error}`), retry);
    return box;
}

/**
 * Create an element with Bootstrap classes and optional text.
 *
 * @param tag - The tag name.
 * @param className - The classes.
 * @param text - The text content.
 * @returns The element.
 */
function element(tag: string, className: string, text?: string): HTMLElement {
    const node = document.createElement(tag);
    node.className = className;
    if (text) {
        node.textContent = text;
    }
    return node;
}
