import { describe, expect, it } from 'vitest';
import { routeTool, scopeRefusal } from '../../lib/tools';
import { normalizeOdooUrl, originInScope, originOf, webUrl } from '../../lib/origin';
import { parseKey } from '../../lib/keys';
import { clickEvents, keyEvents } from '../../lib/cdp';
import { cropBox } from '../../lib/screenshot';
import { rememberExecuted } from '../../lib/checkpoint';

describe('routeTool', () => {
    it.each([
        ['browser_read_page', {}, 'content'],
        ['browser_find', { query: 'x' }, 'content'],
        ['browser_fill_form', { fields: [] }, 'content'],
        ['browser_click', { ref: 'e1' }, 'content'],
        ['browser_click', { ref: 'e1', trusted: true }, 'trusted'],
        ['browser_type', { ref: 'e1', text: 'x', trusted: true }, 'trusted'],
        ['browser_press_key', { key: 'Enter', trusted: true }, 'trusted'],
        ['browser_hover', { ref: 'e1', trusted: true }, 'content'],
        ['browser_navigate', { url: 'https://x' }, 'navigate'],
        ['browser_navigate_back', {}, 'navigate_back'],
        ['browser_tabs', { action: 'list' }, 'tabs'],
        ['browser_screenshot', { marks: true }, 'screenshot'],
        ['read_page', {}, null],
        ['_locate', {}, null],
    ])('%s %o runs in %s', (name, args, route) => {
        expect(routeTool(name, args)).toBe(route);
    });
});

describe('plan scope', () => {
    const plan = ['https://shop.example', 'https://*.pay.example'];

    it.each([
        ['https://shop.example', true],
        ['https://pay.example', true],
        ['https://eu.pay.example', true],
        ['http://eu.pay.example', false],
        ['https://shop.example:8443', false],
        ['https://evil.example', false],
        [null, false],
    ])('%s in scope: %s', (origin, inScope) => {
        expect(originInScope(origin, plan)).toBe(inScope);
    });

    it('refuses page-changing tools outside an active plan only', () => {
        expect(
            scopeRefusal('browser_click', 'https://evil.example', plan),
        ).toMatchObject({
            ok: false,
            error: 'out_of_plan',
        });
        expect(scopeRefusal('browser_click', 'https://shop.example', plan)).toBeNull();
        expect(
            scopeRefusal('browser_read_page', 'https://evil.example', plan),
        ).toBeNull();
        expect(
            scopeRefusal('browser_navigate', 'https://evil.example', plan),
        ).toBeNull();
        expect(scopeRefusal('browser_click', 'https://evil.example', [])).toBeNull();
    });
});

describe('URLs', () => {
    it.each([
        ['mycompany.odoo.com', 'https://mycompany.odoo.com'],
        ['https://odoo.example/odoo/action-1', 'https://odoo.example'],
        ['http://localhost:8069/web', 'http://localhost:8069'],
        ['localhost:8069', 'http://localhost:8069'],
        ['https://localhost:8069', 'https://localhost:8069'],
        ['http://odoo.example', null],
        ['ftp://odoo.example', null],
        ['', null],
    ])('normalizes the Odoo URL %s to %s', (input, origin) => {
        expect(normalizeOdooUrl(input)).toBe(origin);
    });

    it('parses only http(s) URLs', () => {
        expect(webUrl('https://shop.example/a')?.href).toBe('https://shop.example/a');
        expect(originOf('http://localhost:8069/web')).toBe('http://localhost:8069');
        expect(webUrl('javascript:alert(1)')).toBeNull();
        expect(originOf('chrome://settings')).toBeNull();
        expect(webUrl(42)).toBeNull();
    });
});

describe('input mapping', () => {
    it.each([
        [
            'Enter',
            { key: 'Enter', code: 'Enter', keyCode: 13, modifiers: [], text: '\r' },
        ],
        [
            'ctrl+a',
            { key: 'a', code: 'KeyA', keyCode: 65, modifiers: ['Control'], text: '' },
        ],
        [
            'Shift+Tab',
            { key: 'Tab', code: 'Tab', keyCode: 9, modifiers: ['Shift'], text: '' },
        ],
        ['7', { key: '7', code: 'Digit7', keyCode: 55, modifiers: [], text: '7' }],
        [
            'Shift+a',
            { key: 'A', code: 'KeyA', keyCode: 65, modifiers: ['Shift'], text: 'A' },
        ],
        [
            'Control++',
            { key: '+', code: '+', keyCode: 43, modifiers: ['Control'], text: '' },
        ],
        [
            'esc',
            { key: 'Escape', code: 'Escape', keyCode: 27, modifiers: [], text: '' },
        ],
    ])('parses %s', (chord, expected) => {
        expect(parseKey(chord)).toEqual(expected);
    });

    it('builds CDP key events with text only for printing keys', () => {
        expect(keyEvents(parseKey('Enter'))[0]).toMatchObject({
            type: 'keyDown',
            text: '\r',
        });
        expect(keyEvents(parseKey('Control+a'))).toEqual([
            {
                type: 'rawKeyDown',
                key: 'a',
                code: 'KeyA',
                windowsVirtualKeyCode: 65,
                modifiers: 2,
            },
            {
                type: 'keyUp',
                key: 'a',
                code: 'KeyA',
                windowsVirtualKeyCode: 65,
                modifiers: 2,
            },
        ]);
    });

    it('builds a CDP double click with modifiers', () => {
        const events = clickEvents(10, 20, 'left', true, ['Shift', 'Alt']);
        expect(events.map((e) => (e as { type: string }).type)).toEqual([
            'mouseMoved',
            'mousePressed',
            'mouseReleased',
            'mousePressed',
            'mouseReleased',
        ]);
        expect(events[3]).toMatchObject({
            x: 10,
            y: 20,
            button: 'left',
            clickCount: 2,
            modifiers: 9,
        });
    });
});

describe('screenshot crop', () => {
    it('pads, scales by the pixel ratio and clamps to the image', () => {
        expect(cropBox({ x: 100, y: 50, w: 40, h: 20 }, 2, 1000, 800)).toEqual({
            x: 184,
            y: 84,
            w: 112,
            h: 72,
        });
        expect(cropBox({ x: 2, y: 2, w: 900, h: 10 }, 1, 500, 300)).toEqual({
            x: 0,
            y: 0,
            w: 500,
            h: 20,
        });
    });
});

describe('checkpoint', () => {
    it('remembers executed call ids, newest last and capped', () => {
        let executed: string[] = [];
        for (let i = 0; i < 205; i += 1) {
            executed = rememberExecuted(executed, `c${i}`);
        }
        expect(executed).toHaveLength(200);
        expect(executed[0]).toBe('c5');
        expect(rememberExecuted(['a', 'b'], 'a')).toEqual(['b', 'a']);
    });
});
