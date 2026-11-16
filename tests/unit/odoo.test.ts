import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    OdooError,
    checkOdoo,
    isUnreachable,
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
 * @param body - Response body, sent as JSON unless it is a string.
 */
function respond(status: number, body: unknown = {}): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            const text = typeof body === 'string' ? body : JSON.stringify(body);
            return new Response(text, { status });
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

    it('polls with the session token, the agent tab origin and its tabs', async () => {
        respond(200, { state: 'done', actions: [], plan_origins: [], retry_ms: 5000 });
        const response = await poll(TARGET, 'https://shop.example', [
            { id: 3, origin: 'https://shop.example' },
            { id: 5, origin: '' },
        ]);
        const url = new URL(calls[0].url);
        expect(url.pathname).toBe('/muk_ai_browser/events');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            browser_session_id: 'bs-7',
            origin: 'https://shop.example',
            tabs: '[{"id":3,"origin":"https://shop.example"},{"id":5,"origin":""}]',
        });
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

    it.each([
        [401, { error: 'invalid_key' }, 'invalid_key', 'HTTP 401 (invalid_key)'],
        [404, { error: 'browser_session_not_found' }, 'browser_session_not_found', ''],
        [404, '<h1>Not Found</h1>', 'app_missing', 'app is not installed'],
        [500, '<h1>Internal Server Error</h1>', '', 'HTTP 500.'],
        [200, '<html>Login</html>', 'bad_response', 'does not understand'],
    ])('reads a %s answer as an error', async (code, body, errorCode, message) => {
        respond(code, body);
        const error = await poll(TARGET, '', []).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(OdooError);
        expect(error).toMatchObject({ status: code, code: errorCode });
        expect((error as Error).message).toContain(message);
    });

    it('reads a failed connection as Odoo not answering', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        const error = await poll(TARGET, '', []).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ status: 0, code: 'network' });
        expect(isUnreachable(error)).toBe(true);
    });

    it('refuses a session call while unpaired, without a request', async () => {
        await expect(poll({ ...TARGET, apiKey: null }, '', [])).rejects.toMatchObject({
            status: 401,
        });
        expect(calls).toHaveLength(0);
    });

    it.each([
        [
            { status: 303, body: '' },
            { status: 200, body: { result: { uid: 2 } } },
            'in',
        ],
        [
            { status: 303, body: '' },
            { status: 200, body: { error: { code: 100 } } },
            'out',
        ],
        [{ status: 404, body: '' }, null, 'missing'],
        [{ status: 502, body: '' }, { status: 502, body: {} }, 'unreachable'],
    ])(
        'checks the app and the login of Odoo (%o, %o)',
        async (app, session, expected) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async (url: string, init: RequestInit) => {
                    calls.push({ url, init });
                    const answer = url.endsWith('/ai_browser/chat') ? app : session;
                    return new Response(
                        JSON.stringify(answer?.body ?? ''),
                        answer ?? {},
                    );
                }),
            );
            expect(await checkOdoo('https://odoo.example')).toBe(expected);
            expect(calls[0]).toMatchObject({
                url: 'https://odoo.example/ai_browser/chat',
                init: { credentials: 'omit', redirect: 'manual' },
            });
            expect(calls.slice(1)).toEqual(
                session
                    ? [
                          {
                              url: 'https://odoo.example/web/session/get_session_info',
                              init: expect.objectContaining({ credentials: 'include' }),
                          },
                      ]
                    : [],
            );
        },
    );

    it('treats an unreachable Odoo as unknown, not logged out', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        expect(await checkOdoo('https://odoo.example')).toBe('unreachable');
    });

    it.each([
        [new OdooError(0, 'network'), true],
        [new OdooError(502), true],
        [new OdooError(504), true],
        [new OdooError(500), false],
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
