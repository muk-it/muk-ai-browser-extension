/**
 * HTTP client for the `muk_ai_browser` routes. Only the service worker calls
 * these (content scripts cannot bypass CORS). Every route except `/pair` sends
 * the device key as a bearer token.
 */

/** Failed request; `status` drives the 401 / 404 / 409 handling. */
export class OdooError extends Error {
    /**
     * @param status - HTTP status, `0` for a network failure.
     * @param message - Server message or a short description.
     */
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
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
interface OdooTarget {
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
 * Perform a JSON request and decode the response.
 *
 * @param url - Absolute URL.
 * @param apiKey - Bearer key, or `null` for the unauthenticated `/pair`.
 * @param body - JSON body for a POST; a GET is sent when omitted.
 * @returns The decoded JSON (`{}` for an empty body).
 * @throws {OdooError} On a network failure or a non-2xx status.
 */
async function request<T>(
    url: string,
    apiKey: string | null,
    body?: object,
): Promise<T> {
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
    } catch (error) {
        throw new OdooError(0, String(error));
    }
    const text = await response.text();
    if (!response.ok) {
        throw new OdooError(response.status, errorMessage(text, response.status));
    }
    return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Extract a readable message from an error body.
 *
 * @param text - The raw response body.
 * @param status - The HTTP status.
 * @returns The server's `error`/`message`, or a short fallback.
 */
function errorMessage(text: string, status: number): string {
    try {
        const body = JSON.parse(text) as { error?: unknown; message?: unknown };
        const message = body.message ?? body.error;
        if (typeof message === 'string' && message) {
            return message;
        }
    } catch {
        /* not JSON */
    }
    return `HTTP ${status}`;
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

/**
 * Fetch the chat state and the pending browser actions.
 *
 * @param target - The addressing checkpoint subset.
 * @param origin - Origin of the agent's tab, `''` when it has none.
 * @returns The poll response.
 */
export async function poll(target: OdooTarget, origin: string): Promise<PollResponse> {
    const { base, key, session } = bound(target);
    const query = new URLSearchParams({ browser_session_id: session, origin });
    return request(`${base}/muk_ai_browser/events?${query}`, key);
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

/**
 * Ask the Odoo web client whether this browser has a logged-in session. The
 * request carries the Odoo session cookie, unlike the device-key routes.
 *
 * @param odooUrl - The configured Odoo origin.
 * @returns Whether a user is logged in, or `null` when Odoo did not answer.
 */
export async function loggedIn(odooUrl: string): Promise<boolean | null> {
    try {
        const response = await fetch(`${odooUrl}/web/session/get_session_info`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: '{"jsonrpc":"2.0","method":"call","params":{}}',
        });
        if (!response.ok) {
            return null;
        }
        const body = (await response.json()) as { result?: { uid?: unknown } };
        return Boolean(body.result?.uid);
    } catch {
        return null;
    }
}
