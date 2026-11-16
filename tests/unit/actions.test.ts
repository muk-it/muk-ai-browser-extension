import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performAction, type ActionContext } from '../../lib/actions';
import { __resetPerceptionState } from '../../lib/perception';

/** Fast settle timings so mutating tools do not wait 400 ms. */
const CTX: ActionContext = { settle: { quietMs: 5, maxMs: 30 } };

const RECT = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 20,
    right: 100,
    width: 100,
    height: 20,
    toJSON: () => ({}),
} as DOMRect;

/**
 * Mount HTML, read the page and return the refs of the snapshot in order.
 *
 * @param html - The page body.
 * @returns The refs.
 */
async function refs(html: string): Promise<string[]> {
    document.body.innerHTML = html;
    const read = await performAction(
        'browser_read_page',
        { viewport_only: false },
        CTX,
    );
    const found = [...String(read.ok && read.snapshot).matchAll(/ref=(e\d+)/g)].map(
        (m) => m[1],
    );
    expect(found.length).toBeGreaterThan(0);
    return found;
}

beforeEach(() => {
    __resetPerceptionState();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
    vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('performAction', () => {
    it('reads the whole page unless asked for the viewport only', async () => {
        document.body.innerHTML = '<button>Top</button><button id="far">Far</button>';
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
            function (this: Element) {
                return this.id === 'far'
                    ? ({ ...RECT, y: 5000, top: 5000, bottom: 5020 } as DOMRect)
                    : RECT;
            },
        );
        for (const [args, far] of [
            [{}, true],
            [{ viewport_only: true }, false],
        ] as const) {
            const read = await performAction('browser_read_page', args, CTX);
            expect(String(read.ok && read.snapshot).includes('"Far"')).toBe(far);
        }
    });

    it('clicks an element and returns a fresh snapshot', async () => {
        const [ref] = await refs('<button>Run</button>');
        const button = document.querySelector('button') as HTMLButtonElement;
        button.addEventListener('click', () => (button.textContent = 'Done'));
        const result = await performAction(
            'browser_click',
            { ref, element: 'Run' },
            CTX,
        );
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.snapshot).toContain('button "Done"');
    });

    it('types into a field with input and change events, and submits its form', async () => {
        const [ref] = await refs('<form><input aria-label="Name" value="old"></form>');
        const input = document.querySelector('input') as HTMLInputElement;
        const seen: string[] = [];
        input.addEventListener('input', () => seen.push('input'));
        input.addEventListener('change', () => seen.push('change'));
        const result = await performAction(
            'browser_type',
            { ref, text: 'Jane', submit: true },
            CTX,
        );
        expect(result.ok).toBe(true);
        expect(input.value).toBe('Jane');
        expect(seen).toEqual(['input', 'change']);
        expect(input.form?.requestSubmit).toHaveBeenCalled();
    });

    it.each([
        ['browser_type', '<input type="password">', 'sensitive_field'],
        ['browser_type', '<input name="password">', 'sensitive_field'],
        ['browser_type', '<input autocomplete="cc-number">', 'sensitive_field'],
        ['browser_type', '<input autocomplete="one-time-code">', 'sensitive_field'],
        ['browser_type', '<input autocomplete="new-password">', 'sensitive_field'],
        ['browser_fill_form', '<input autocomplete="cc-csc">', 'sensitive_field'],
        ['browser_fill_form', '<input type="file">', 'file_upload'],
        [
            'browser_select_option',
            '<select autocomplete="cc-exp-month"><option>01</option></select>',
            'sensitive_field',
        ],
    ])('refuses %s into %s', async (tool, field, error) => {
        const [name, ref] = await refs(
            `<input aria-label="Name"><label>F ${field}</label>`,
        );
        const result = await performAction(
            tool,
            {
                ref,
                text: '01',
                values: ['01'],
                fields: [name, ref].map((each) => ({ ref: each, value: '01' })),
            },
            CTX,
        );
        expect(result).toMatchObject({ ok: false, error });
        expect(result.ok || result.message).toMatch(/ask the user/);
        expect((document.querySelector('input') as HTMLInputElement).value).toBe('');
    });

    it('fills a form batch: text, checkbox and select', async () => {
        const [name, agree, size] = await refs(
            '<input aria-label="Name"><input type="checkbox" aria-label="Agree">' +
                '<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>',
        );
        const result = await performAction(
            'browser_fill_form',
            {
                fields: [
                    { ref: name, value: 'Jane' },
                    { ref: agree, value: true },
                    { ref: size, value: 'Large' },
                ],
            },
            CTX,
        );
        expect(result).toMatchObject({ ok: true, filled: 3 });
        expect((document.querySelector('input') as HTMLInputElement).value).toBe(
            'Jane',
        );
        expect(
            (document.querySelector('input[type=checkbox]') as HTMLInputElement)
                .checked,
        ).toBe(true);
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('l');
    });

    it('finds snapshot lines containing every query word, across the whole page', async () => {
        document.body.innerHTML =
            '<button>Save order</button><button>Cancel</button><a href="/x">Save link</a>';
        const result = await performAction(
            'browser_find',
            { query: 'button save' },
            CTX,
        );
        expect(result).toMatchObject({ ok: true, total: 1 });
        expect(result.ok && result.matches).toEqual([
            expect.stringMatching(/^- button "Save order" \[ref=e\d+\]$/),
        ]);
    });

    it('selects an option and rejects an unknown one', async () => {
        const [ref] = await refs(
            '<select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>',
        );
        expect(
            await performAction('browser_select_option', { ref, values: ['l'] }, CTX),
        ).toMatchObject({ ok: true });
        expect((document.querySelector('select') as HTMLSelectElement).value).toBe('l');
        expect(
            await performAction('browser_select_option', { ref, values: ['xl'] }, CTX),
        ).toMatchObject({
            ok: false,
            error: 'no_option',
        });
    });

    it.each([
        ['browser_click', { ref: 'e999' }, 'stale_ref'],
        ['browser_teleport', {}, 'unknown_tool'],
        ['browser_press_key', { key: '' }, 'bad_arguments'],
        ['browser_wait_for', {}, 'bad_arguments'],
    ])('refuses %s %o', async (tool, args, error) => {
        expect(await performAction(tool, args, CTX)).toMatchObject({
            ok: false,
            error,
        });
    });

    it.each([
        ['<input aria-label="Name">', { keyboard: true }, { ok: true, x: 50, y: 10 }],
        ['<input aria-label="Pw" type="password">', {}, { ok: true, x: 50, y: 10 }],
        [
            '<input aria-label="Pw" autocomplete="current-password">',
            { keyboard: true },
            { ok: false, error: 'sensitive_field' },
        ],
        [
            '<input aria-label="Pw" name="user_pwd">',
            { keyboard: true, focusOnly: true },
            { ok: false, error: 'sensitive_field' },
        ],
    ])('locates %s for trusted input', async (html, args, expected) => {
        const [ref] = await refs(html);
        const { focusOnly, ...rest } = args as { focusOnly?: boolean };
        if (focusOnly) {
            (document.querySelector('input') as HTMLInputElement).focus();
        }
        const located = await performAction(
            '_locate',
            { ...rest, ref: focusOnly ? undefined : ref },
            CTX,
        );
        expect(located).toMatchObject(expected);
    });
});
