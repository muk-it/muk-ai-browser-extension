import { type FileData, downloadedFile } from './util';

/**
 * HTTP client for the `muk_ai_browser` routes. Only the service worker calls
 * these (content scripts cannot bypass CORS). Every route except `/pair` sends
 * the device key as a bearer token.
 */

/** Readable messages of the error codes the extension shows. */
const MESSAGES: Record<string, string> = {
    network: 'Odoo did not answer.',
    app_missing:
        'The MuK AI Browser app is not installed in this Odoo. Install it from ' +
        'Apps, then try again.',
    bad_response: 'Odoo sent an answer the extension does not understand.',
    not_paired: 'This browser is not connected to Odoo.',
    invalid_or_expired_code:
        'The pairing code is invalid or expired. Open the connect page again.',
    ai_session_not_found: 'The chat no longer exists in Odoo. Start a new one.',
};

/** Failed request; `status` and `code` drive the handling, the message is shown. */
export class OdooError extends Error {
    /**
     * @param status - HTTP status, `0` when Odoo did not answer.
     * @param code - The server's `error` code, or the extension's own.
     */
    constructor(
        public readonly status: number,
        public readonly code = '',
    ) {
        super(
            MESSAGES[code] ??
                `Odoo answered with HTTP ${status}${code ? ` (${code})` : ''}.`,
        );
        this.name = 'OdooError';
    }
}

/**
 * Tell whether a failed request means Odoo did not answer: a network error,
 * or a proxy's 502, 503 or 504 while Odoo restarts.
 *
 * @param error - Anything thrown.
 * @returns Whether Odoo is unreachable.
 */
export function isUnreachable(error: unknown): boolean {
    return error instanceof OdooError && (error.status === 0 || error.status >= 502);
}

/** What a session-bound call needs to address the server. */
export interface OdooTarget {
    odooUrl: string | null;
    apiKey: string | null;
    browserSessionId: string | null;
}

/** Response of `/pair`. */
interface PairResponse {
    api_key: string;
    user: { id: number; name: string };
}

/** Response of `/session`. */
interface SessionResponse {
    browser_session_id: string;
    ai_session_id: number;
}

/** A browser action the agent waits on. */
export interface PendingAction {
    call_id: string;
    name: string;
    arguments: Record<string, unknown>;
    /** The site origin the server judged the call on; absent when its target is a URL. */
    origin?: string;
}

/** Response of `/events`. */
export interface PollResponse {
    state: string;
    actions: PendingAction[];
    plan_origins: string[];
    retry_ms: number;
}

/**
 * Send a request to Odoo. A 404 without an error code comes from an Odoo that
 * lacks the route, so without the app.
 *
 * @param url - Absolute URL.
 * @param apiKey - Bearer key, or `null` for the unauthenticated `/pair`.
 * @param body - JSON body for a POST; a GET is sent when omitted.
 * @returns The successful response.
 * @throws {OdooError} When Odoo does not answer or fails.
 */
async function send(
    url: string,
    apiKey: string | null,
    body?: object,
): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
    }
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
    let response: Response;
    try {
        response = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers,
            body: body ? JSON.stringify(body) : undefined,
            credentials: 'omit',
        });
    } catch {
        throw new OdooError(0, 'network');
    }
    if (!response.ok) {
        const data = parseJson(await response.text().catch(() => ''));
        const code = (data as { error?: unknown } | null)?.error;
        throw new OdooError(
            response.status,
            typeof code === 'string'
                ? code
                : response.status === 404
                  ? 'app_missing'
                  : '',
        );
    }
    return response;
}

/**
 * Perform a JSON request and decode the response.
 *
 * @param url - Absolute URL.
 * @param apiKey - Bearer key, or `null` for the unauthenticated `/pair`.
 * @param body - JSON body for a POST; a GET is sent when omitted.
 * @returns The decoded JSON (`{}` for an empty body).
 * @throws {OdooError} When Odoo does not answer, fails, or answers no JSON.
 */
async function request<T>(
    url: string,
    apiKey: string | null,
    body?: object,
): Promise<T> {
    const response = await send(url, apiKey, body);
    let text: string;
    try {
        text = await response.text();
    } catch {
        throw new OdooError(0, 'network');
    }
    const data = parseJson(text);
    if (data === undefined) {
        throw new OdooError(response.status, 'bad_response');
    }
    return data as T;
}

/**
 * Decode a response body.
 *
 * @param text - The raw body.
 * @returns The JSON value, `{}` for an empty body, `undefined` for no JSON.
 */
function parseJson(text: string): unknown {
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Return the session-bound base URL and key.
 *
 * @param target - The addressing checkpoint subset.
 * @returns The Odoo origin, the key and the browser session id.
 * @throws {OdooError} With status 401 when the extension is not paired.
 */
function bound(target: OdooTarget): { base: string; key: string; session: string } {
    if (!target.odooUrl || !target.apiKey || target.browserSessionId == null) {
        throw new OdooError(401, 'not_paired');
    }
    return {
        base: target.odooUrl,
        key: target.apiKey,
        session: target.browserSessionId,
    };
}

/**
 * Exchange a one-time pairing code for a device key.
 *
 * @param odooUrl - The configured Odoo origin.
 * @param code - The code from the connect page.
 * @param deviceLabel - Human name of this browser.
 * @returns The device key and the paired user.
 */
export function pair(
    odooUrl: string,
    code: string,
    deviceLabel: string,
): Promise<PairResponse> {
    return request(`${odooUrl}/muk_ai_browser/pair`, null, {
        pairing_code: code,
        device_label: deviceLabel,
    });
}

/**
 * Revoke the device key.
 *
 * @param odooUrl - The configured Odoo origin.
 * @param apiKey - The key to revoke.
 * @returns The server reply.
 */
export function unpair(odooUrl: string, apiKey: string): Promise<unknown> {
    return request(`${odooUrl}/muk_ai_browser/unpair`, apiKey, {});
}

/**
 * Attach this device to a chat as its browser session.
 *
 * @param odooUrl - The configured Odoo origin.
 * @param apiKey - The device key.
 * @param aiSessionId - The chat open in the embedded Odoo.
 * @param deviceLabel - Human name of this browser.
 * @param origin - Origin of the agent's tab.
 * @returns The browser session id and the chat id.
 */
export function openSession(
    odooUrl: string,
    apiKey: string,
    aiSessionId: number,
    deviceLabel: string,
    origin: string | null,
): Promise<SessionResponse> {
    return request(`${odooUrl}/muk_ai_browser/session`, apiKey, {
        ai_session_id: aiSessionId,
        device_label: deviceLabel,
        origin,
    });
}

/** A tab the agent may use, with its origin (`''` for a page without one). */
export interface TabOrigin {
    id: number;
    origin: string;
}

/**
 * Fetch the chat state and the pending browser actions.
 *
 * @param target - The addressing checkpoint subset.
 * @param origin - Origin of the agent's tab, `''` when it has none.
 * @param tabs - The agent's tabs, on which Odoo judges calls with a `tab_id`.
 * @returns The poll response.
 */
export async function poll(
    target: OdooTarget,
    origin: string,
    tabs: TabOrigin[],
): Promise<PollResponse> {
    const { base, key, session } = bound(target);
    const query = new URLSearchParams({
        browser_session_id: session,
        origin,
        tabs: JSON.stringify(tabs),
    });
    return request(`${base}/muk_ai_browser/events?${query}`, key);
}

/**
 * Download the Odoo file of a `browser_upload_file` call.
 *
 * @param target - The addressing checkpoint subset.
 * @param callId - The call id.
 * @returns The file.
 * @throws {OdooError} When Odoo does not answer or refuses the file.
 */
export async function downloadFile(
    target: OdooTarget,
    callId: string,
): Promise<FileData> {
    const { base, key, session } = bound(target);
    const query = new URLSearchParams({ browser_session_id: session, call_id: callId });
    const response = await send(`${base}/muk_ai_browser/file?${query}`, key);
    let body: ArrayBuffer;
    try {
        body = await response.arrayBuffer();
    } catch {
        throw new OdooError(0, 'network');
    }
    return downloadedFile(response, body, 'download');
}

/**
 * Post the result of a browser action. A duplicate post (409) is ignored.
 *
 * @param target - The addressing checkpoint subset.
 * @param callId - The answered call id.
 * @param origin - Origin of the tab after the action ran.
 * @param result - `{ok: true, ...}` or `{ok: false, error, message}`.
 */
export async function postResult(
    target: OdooTarget,
    callId: string,
    origin: string | null,
    result: object,
): Promise<void> {
    const { base, key, session } = bound(target);
    try {
        await request(`${base}/muk_ai_browser/result`, key, {
            browser_session_id: session,
            call_id: callId,
            origin,
            result,
        });
    } catch (error) {
        if (!(error instanceof OdooError && error.status === 409)) {
            throw error;
        }
    }
}

/** The company in Odoo behind the site of a page, as its card shows it. */
export interface PageCard {
    host: string;
    partner: { name: string; path: string; details: string[] } | null;
    actions: { label: string; prompt: string }[];
}

/**
 * Fetch the card of a page: the company in Odoo behind its site.
 *
 * @param odooUrl - The configured Odoo origin.
 * @param apiKey - The device key.
 * @param url - The page.
 * @returns The card, or `null` for a page without one, such as the Odoo itself.
 */
export async function fetchCard(
    odooUrl: string,
    apiKey: string,
    url: string,
): Promise<PageCard | null> {
    const query = new URLSearchParams({ url });
    const card = await request<Partial<PageCard>>(
        `${odooUrl}/muk_ai_browser/card?${query}`,
        apiKey,
    );
    return card.host ? (card as PageCard) : null;
}

/** What a check of the configured Odoo found. */
export type OdooAccess = 'in' | 'out' | 'missing' | 'unreachable';

/**
 * Check the configured Odoo before showing one of its pages: whether it has
 * the app, which redirects its chat route, and whether this browser is logged
 * in to it. Both requests read only; the login check carries the Odoo session
 * cookie, unlike the device-key routes.
 *
 * @param odooUrl - The configured Odoo origin.
 * @returns Logged in, logged out, without the app, or not answering.
 */
export async function checkOdoo(odooUrl: string): Promise<OdooAccess> {
    try {
        const app = await fetch(`${odooUrl}/ai_browser/chat`, {
            credentials: 'omit',
            redirect: 'manual',
        });
        if (app.status === 404) {
            return 'missing';
        }
        const response = await fetch(`${odooUrl}/web/session/get_session_info`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: '{"jsonrpc":"2.0","method":"call","params":{}}',
        });
        if (!response.ok) {
            return 'unreachable';
        }
        const body = (await response.json()) as { result?: { uid?: unknown } };
        return body.result?.uid ? 'in' : 'out';
    } catch {
        return 'unreachable';
    }
}
