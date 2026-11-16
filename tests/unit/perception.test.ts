import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    StaleRefError,
    __resetPerceptionState,
    buildSnapshot,
    resolveRef,
} from '../../lib/perception';

const RECT: DOMRect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 20,
    right: 100,
    width: 100,
    height: 20,
    toJSON: () => ({}),
};

/**
 * Snapshot the whole page, without the refs.
 *
 * @param opts - Extra snapshot options.
 * @returns The snapshot lines.
 */
function lines(opts: { interactiveOnly?: boolean } = {}): string[] {
    return buildSnapshot({ viewportOnly: false, ...opts })
        .replace(/ \[ref=e\d+\]/g, '')
        .split('\n')
        .filter(Boolean);
}

beforeEach(() => {
    __resetPerceptionState();
    document.body.innerHTML = '';
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('snapshot', () => {
    it.each([
        ['<button>  Save\n  changes </button>', ['- button "Save changes"']],
        [
            '<a href="https://x.example/">Go <b>home</b></a>',
            ['- link "Go home"', '  /url: https://x.example/'],
        ],
        ['<a>No link</a>', ['- text "No link"']],
        ['<input type="search" placeholder="Search...">', ['- searchbox "Search..."']],
        ['<input title="Tip">', ['- textbox "Tip"']],
        [
            '<label for="m">Email</label><input id="m">',
            ['- text "Email"', '- textbox "Email"'],
        ],
        ['<label>User <input></label>', ['- text "User"', '- textbox "User"']],
        [
            '<input type="checkbox" checked aria-label="Agree">',
            ['- checkbox "Agree" [checked]'],
        ],
        ['<input type="hidden" value="x">', []],
        [
            '<button disabled aria-expanded="true">Menu</button>',
            ['- button "Menu" [disabled] [expanded]'],
        ],
        ['<h3>Title</h3>', ['- heading "Title" [level=3]']],
        ['<input type="file" aria-label="Invoice">', ['- textbox "Invoice" [file]']],
        ['<select multiple aria-label="Tags"></select>', ['- listbox "Tags"']],
        [
            '<span id="l">From labelledby</span><button aria-labelledby="l" aria-label="x">T</button>',
            ['- text "From labelledby"', '- button "From labelledby"'],
        ],
        ['<img alt="Company logo"><img alt="">', ['- img "Company logo"']],
        [
            '<div role="presentation">plain</div><button role="presentation">kept</button>',
            ['- text "plain"', '- button "kept"'],
        ],
        ['<div hidden><button>Hidden</button></div>', []],
    ])('reads %s', (html, expected) => {
        document.body.innerHTML = html;
        expect(lines()).toEqual(expected);
    });

    it('keeps each element on its ref across snapshots', () => {
        document.body.innerHTML =
            '<button>Save</button><a href="https://example.com/x">Home</a>';
        expect(buildSnapshot({ viewportOnly: false })).toBe(
            [
                '- button "Save" [ref=e1]',
                '- link "Home" [ref=e2]',
                '  /url: https://example.com/x',
            ].join('\n'),
        );
        document.body.insertAdjacentHTML('beforeend', '<button>Two</button>');
        expect(buildSnapshot({ viewportOnly: false })).toContain(
            '- button "Save" [ref=e1]\n- link "Home" [ref=e2]',
        );
    });

    it('marks a node that appeared since the last snapshot', () => {
        document.body.innerHTML = '<button>One</button>';
        buildSnapshot();
        document.body.insertAdjacentHTML('beforeend', '<button>Two</button>');
        expect(buildSnapshot({ viewportOnly: false })).toContain(
            '- * button "Two" [ref=e2]',
        );
    });

    it('drops text in interactive-only mode', () => {
        document.body.innerHTML = '<p>Just text</p><button>Click</button>';
        expect(lines()).toEqual(['- text "Just text"', '- button "Click"']);
        expect(lines({ interactiveOnly: true })).toEqual(['- button "Click"']);
    });

    it('cuts a snapshot at its character budget', () => {
        document.body.innerHTML = '<button>Save</button>'.repeat(50);
        const text = buildSnapshot({ viewportOnly: false, maxChars: 200 });
        expect(text.length).toBe(200);
        expect(text).toMatch(/snapshot truncated/);
    });

    it('resolves a live ref and refuses a detached or unknown one', () => {
        document.body.innerHTML = '<button>Save</button>';
        buildSnapshot();
        expect(resolveRef('e1').tagName).toBe('BUTTON');
        document.body.innerHTML = '';
        expect(() => resolveRef('e1')).toThrow(StaleRefError);
        expect(() => resolveRef('e999')).toThrow(StaleRefError);
    });
});
