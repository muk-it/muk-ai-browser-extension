import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    OdooError,
    isUnreachable,
    loggedIn,
    openSession,
    pair,
    poll,
    postResult,
    unpair,
} from '../../lib/odoo';

const TARGET = {
    odooUrl: 'https://odoo.example',
    apiKey: 'k-123',
    browserSessionId: 'bs-7',
};

/** Calls the stubbed fetch received. */
let calls: { url: string; init: RequestInit }[];

/**
 * Stub `fetch` with one response for every call.
 *
 * @param status - HTTP status.
 * @param body - Response body.
 */
function respond(status: number, body: unknown = {}): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body), { status });
        }),
    );
}

/**
 * Return the JSON body of the last call.
 *
 * @returns The decoded body.
 */
function lastBody(): Record<string, unknown> {
    return JSON.parse(String(calls.at(-1)?.init.body));
}

beforeEach(() => {
    calls = [];
    respond(200);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('odoo client', () => {
    it('pairs without auth and sends the device label', async () => {
        await pair('https://odoo.example', 'ABC', 'Chrome on win');
        expect(calls[0].url).toBe('https://odoo.example/muk_ai_browser/pair');
        expect(calls[0].init.headers).not.toHaveProperty('Authorization');
        expect(lastBody()).toEqual({
            pairing_code: 'ABC',
            device_label: 'Chrome on win',
        });
    });

    it('attaches to a chat with the device label and the agent tab origin', async () => {
        await openSession(
            'https://odoo.example',
            'k-123',
            42,
            'Chrome',
            'https://shop.example',
        );
        expect(calls[0].url).toBe('https://odoo.example/muk_ai_browser/session');
        expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer k-123' });
        expect(lastBody()).toEqual({
            ai_session_id: 42,
            device_label: 'Chrome',
            origin: 'https://shop.example',
        });
    });

    it('polls with the session token and the agent tab origin', async () => {
        respond(200, { state: 'done', actions: [], plan_origins: [], retry_ms: 5000 });
        const response = await poll(TARGET, 'https://shop.example');
        expect(calls[0].url).toBe(
            'https://odoo.example/muk_ai_browser/events?browser_session_id=bs-7' +
                '&origin=https%3A%2F%2Fshop.example',
        );
        expect(calls[0].init.method).toBe('GET');
        expect(response.retry_ms).toBe(5000);
    });

    it('posts a result with the origin after the action, ignoring a duplicate', async () => {
        const result = { ok: false, error: 'stale_ref', message: 'Ref e4 is stale' };
        await postResult(TARGET, 'c1', 'https://shop.example', result);
        expect(lastBody()).toEqual({
            browser_session_id: 'bs-7',
            call_id: 'c1',
            origin: 'https://shop.example',
            result,
        });
        respond(409, { error: 'duplicate' });
        await expect(
            postResult(TARGET, 'c1', null, { ok: true }),
        ).resolves.toBeUndefined();
    });

    it('raises the status and the server message of a failed request', async () => {
        respond(401, { error: 'invalid_key' });
        await expect(poll(TARGET, '')).rejects.toEqual(
            new OdooError(401, 'invalid_key'),
        );
        respond(404, '');
        await expect(poll(TARGET, '')).rejects.toMatchObject({ status: 404 });
        respond(500, { error: 'x' });
        await expect(
            postResult(TARGET, 'c1', null, { ok: true }),
        ).rejects.toMatchObject({
            status: 500,
        });
    });

    it('refuses a session call while unpaired, without a request', async () => {
        await expect(poll({ ...TARGET, apiKey: null }, '')).rejects.toMatchObject({
            status: 401,
        });
        expect(calls).toHaveLength(0);
    });

    it.each([
        [200, { result: { uid: 2 } }, true],
        [200, { error: { code: 100, message: 'Session expired' } }, false],
        [502, {}, null],
    ])(
        'checks the Odoo login with the session cookie (%s)',
        async (code, body, expected) => {
            respond(code, body);
            expect(await loggedIn('https://odoo.example')).toBe(expected);
            expect(calls[0].url).toBe(
                'https://odoo.example/web/session/get_session_info',
            );
            expect(calls[0].init).toMatchObject({
                method: 'POST',
                credentials: 'include',
            });
        },
    );

    it('treats an unreachable Odoo as unknown, not logged out', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        expect(await loggedIn('https://odoo.example')).toBeNull();
    });

    it.each([
        [new OdooError(0, 'Failed to fetch'), true],
        [new OdooError(502, 'Bad Gateway'), true],
        [new OdooError(504, 'Gateway Timeout'), true],
        [new OdooError(500, 'Server Error'), false],
        [new OdooError(401, 'invalid_key'), false],
        [new Error('other'), false],
    ])('tells whether %s means Odoo is unreachable', (error, expected) => {
        expect(isUnreachable(error)).toBe(expected);
    });

    it('revokes the key on unpair', async () => {
        await unpair('https://odoo.example', 'k-123');
        expect(calls[0].url).toBe('https://odoo.example/muk_ai_browser/unpair');
        expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer k-123' });
    });
});
