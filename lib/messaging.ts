import type { PageCard } from './odoo';

/**
 * Typed messages between the side panel, the options page, the content
 * scripts and the service worker. Every message is keyed on `type`.
 */

/** Result of a browser tool, as posted to `/result`. */
export type ToolResult =
    | ({ ok: true } & Record<string, unknown>)
    | { ok: false; error: string; message: string };

/** Link state between the service worker and Odoo. */
export type LinkState = 'idle' | 'online' | 'offline' | 'unreachable';

/** Everything the side panel and the options page show. */
export interface Status {
    /** The configured Odoo origin. */
    odooUrl: string | null;
    /** A device key is stored. */
    paired: boolean;
    /** Name of the paired Odoo user. */
    userName: string | null;
    /** Link to Odoo. */
    link: LinkState;
    /** The Odoo connect page is open and waits for the user to log in. */
    connecting: boolean;
    /** Last link or pairing error. */
    error: string | null;
    /** The tab the agent acts in. */
    agentTab: { title: string; url: string; favIconUrl: string | null } | null;
    /** Tabs in the agent's "MuK AI" tab group. */
    groupTabs: number;
    /** The agent is working or an action runs. */
    working: boolean;
    /** The chat this device is attached to, reopened in the embedded Odoo. */
    chatId: number | null;
    /** The company in Odoo behind the site of the agent's tab. */
    card: PageCard | null;
}

/** Side panel to service worker, over the panel's port. */
export type PanelToSwMessage =
    /** The panel opened in a window: send the status and resume polling. */
    | { type: 'panel/open'; windowId: number | null }
    /** The embedded Odoo opened a chat: attach this device to it. */
    | { type: 'panel/attach'; chatId: number }
    /** Pair with a pasted code. */
    | { type: 'panel/pair'; code: string }
    /** Open the Odoo connect page (or the options page when unconfigured). */
    | { type: 'panel/connect' }
    /** Bring the agent's tab to the front. */
    | { type: 'panel/focus-tab' }
    /** Show an Odoo page the embedded chat opened in the agent's tab group. */
    | { type: 'panel/show'; path: string };

/** Service worker to side panel, over the panel's port. */
export type SwToPanelMessage =
    /** The status changed. */
    | { type: 'sw/status'; status: Status }
    /** Text from the context menu to put into the chat's composer. */
    | { type: 'sw/compose'; text: string };

/** One-off runtime messages. */
export type RuntimeMessage =
    /** The side panel asks whether Odoo has the app and a user (`OdooAccess`). */
    | { type: 'panel/check' }
    /** The launcher was clicked: open the side panel for its tab. */
    | { type: 'launcher/open-panel' }
    /** The launcher loaded and asks whether the side panel is open (`boolean`). */
    | { type: 'launcher/hello' }
    /** The service worker tells a window's launchers the panel opened or closed. */
    | { type: 'launcher/panel'; open: boolean }
    /** The pairing reader read a code on the Odoo connect page. */
    | { type: 'pairing/code'; code: string }
    /** The options page saved a new Odoo URL (host permission already granted). */
    | { type: 'options/set-url'; url: string }
    /** The options page asks to open the Odoo connect page. */
    | { type: 'options/connect' }
    /** The options page asks to unpair. */
    | { type: 'options/disconnect' }
    /** The options page asks for the current status. */
    | { type: 'options/status' }
    /** The service worker runs a browser tool in a tab's content script. */
    | { type: 'content/tool'; name: string; arguments: Record<string, unknown> };

/** Any message on the bus. */
type Message = PanelToSwMessage | SwToPanelMessage | RuntimeMessage;

/** Reply of `pairing/code`. */
export type PairingReply = { ok: true } | { ok: false; error: string };

/**
 * Narrow a message of unknown shape by its `type`.
 *
 * @param msg - Candidate message.
 * @param type - Expected discriminant.
 * @returns Whether `msg.type` equals `type`.
 */
export function isMessage<T extends Message['type']>(
    msg: unknown,
    type: T,
): msg is Extract<Message, { type: T }> {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { type?: unknown }).type === type
    );
}

/**
 * Build a failed tool result.
 *
 * @param error - Machine-readable code.
 * @param message - Full human-readable message.
 * @returns The result.
 */
export function failure(error: string, message: string): ToolResult {
    return { ok: false, error, message };
}

/** What the embedded Odoo frame tells the panel. */
export type FrameMessage =
    /** The chat it shows; `id` is `null` before its first message. */
    | { type: 'chat'; id: number | null }
    /** A record page the chat opened, as an `/odoo/...` path. */
    | { type: 'show'; path: string };

/** An Odoo web client path, such as `/odoo/product.template/7`. */
const ODOO_PATH = /^\/odoo\/[\w.\-/]+$/;

/**
 * Read a window message of the embedded Odoo frame, accepting it only from
 * that frame on the configured Odoo origin.
 *
 * @param event - The window message.
 * @param odooUrl - The configured Odoo origin.
 * @param frame - The embedded Odoo frame's window.
 * @returns The message, or `null` for any other message.
 */
export function frameMessage(
    event: Pick<MessageEvent, 'origin' | 'source' | 'data'>,
    odooUrl: string,
    frame: Window | null | undefined,
): FrameMessage | null {
    if (!frame || event.source !== frame || event.origin !== new URL(odooUrl).origin) {
        return null;
    }
    const data = event.data as { type?: unknown; id?: unknown; path?: unknown } | null;
    if (data?.type === 'muk_ai_browser.chat') {
        const id =
            Number.isInteger(data.id) && Number(data.id) > 0 ? Number(data.id) : null;
        return { type: 'chat', id };
    }
    if (data?.type === 'muk_ai_browser.show' && typeof data.path === 'string') {
        return ODOO_PATH.test(data.path) ? { type: 'show', path: data.path } : null;
    }
    return null;
}
