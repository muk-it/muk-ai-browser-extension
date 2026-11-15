import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    computeAccessibleName,
    computeRole,
    computeStates,
} from '../../lib/playwright-aria';
import {
    StaleRefError,
    __resetPerceptionState,
    buildSnapshot,
    resolveRef,
} from '../../lib/perception';

/** Build a detached element from an HTML string and return its root. */
function el(html: string): Element {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild as Element;
}

/** Mount HTML into the live document body (so layout/queries resolve). */
function mount(html: string): void {
    document.body.innerHTML = html;
}

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

beforeEach(() => {
    __resetPerceptionState();
    document.body.innerHTML = '';
    // jsdom has no layout: give every element a non-zero box so the visibility
    // filter passes. Role/name/state tests do not depend on this.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('computeRole — implicit roles', () => {
    it('maps native interactive elements', () => {
        expect(computeRole(el('<button>x</button>'))).toBe('button');
        expect(computeRole(el('<a href="/x">x</a>'))).toBe('link');
        expect(computeRole(el('<a>x</a>'))).toBeNull();
        expect(computeRole(el('<textarea></textarea>'))).toBe('textbox');
        expect(computeRole(el('<nav></nav>'))).toBe('navigation');
        expect(computeRole(el('<dialog></dialog>'))).toBe('dialog');
        expect(computeRole(el('<ul></ul>'))).toBe('list');
        expect(computeRole(el('<li></li>'))).toBe('listitem');
    });

    it('maps input types', () => {
        expect(computeRole(el('<input type="text">'))).toBe('textbox');
        expect(computeRole(el('<input>'))).toBe('textbox');
        expect(computeRole(el('<input type="search">'))).toBe('searchbox');
        expect(computeRole(el('<input type="checkbox">'))).toBe('checkbox');
        expect(computeRole(el('<input type="radio">'))).toBe('radio');
        expect(computeRole(el('<input type="number">'))).toBe('spinbutton');
        expect(computeRole(el('<input type="submit">'))).toBe('button');
        expect(computeRole(el('<input type="hidden">'))).toBeNull();
    });

    it('maps select by multiplicity and headings to heading', () => {
        expect(computeRole(el('<select></select>'))).toBe('combobox');
        expect(computeRole(el('<select multiple></select>'))).toBe('listbox');
        expect(computeRole(el('<h2>t</h2>'))).toBe('heading');
        expect(computeRole(el('<h5>t</h5>'))).toBe('heading');
    });

    it('handles img alt and presentation', () => {
        expect(computeRole(el('<img alt="logo">'))).toBe('img');
        // Empty alt with nothing else -> presentation -> dropped (null).
        expect(computeRole(el('<img alt="">'))).toBeNull();
    });

    it('returns null for a generic node with no name', () => {
        expect(computeRole(el('<div></div>'))).toBeNull();
        expect(computeRole(el('<span>hi</span>'))).toBeNull();
        // ...but a named generic surfaces.
        expect(computeRole(el('<div aria-label="region">x</div>'))).toBe('generic');
    });

    it('resolves explicit role and presentation conflicts', () => {
        expect(computeRole(el('<div role="navigation"></div>'))).toBe('navigation');
        // role=presentation on a plain div hides it.
        expect(computeRole(el('<div role="presentation">x</div>'))).toBeNull();
        // role=presentation on a focusable/named element is ignored.
        expect(computeRole(el('<button role="presentation">x</button>'))).toBe(
            'button',
        );
    });
});

describe('computeAccessibleName — precedence', () => {
    it('prefers aria-labelledby over aria-label and content', () => {
        mount(
            '<span id="lbl">From labelledby</span>' +
                '<button id="b" aria-labelledby="lbl" aria-label="From label">Text</button>',
        );
        const button = document.getElementById('b') as Element;
        expect(computeAccessibleName(button)).toBe('From labelledby');
    });

    it('prefers aria-label over native label and content', () => {
        mount('<button aria-label="Close dialog">X</button>');
        const button = document.querySelector('button') as Element;
        expect(computeAccessibleName(button)).toBe('Close dialog');
    });

    it('uses an associated label[for]', () => {
        mount('<label for="email">Email address</label><input id="email">');
        const input = document.getElementById('email') as Element;
        expect(computeAccessibleName(input)).toBe('Email address');
    });

    it('uses a wrapping label', () => {
        mount('<label>Username <input id="u"></label>');
        const input = document.getElementById('u') as Element;
        expect(computeAccessibleName(input)).toBe('Username');
    });

    it('falls back to placeholder then title for inputs', () => {
        expect(computeAccessibleName(el('<input placeholder="Search...">'))).toBe(
            'Search...',
        );
        expect(computeAccessibleName(el('<input title="Tip">'))).toBe('Tip');
    });

    it('derives the name from content for content roles', () => {
        expect(computeAccessibleName(el('<button>  Save\n  changes </button>'))).toBe(
            'Save changes',
        );
        expect(computeAccessibleName(el('<a href="/x">Go <b>home</b></a>'))).toBe(
            'Go home',
        );
    });

    it('uses native alt for images', () => {
        expect(computeAccessibleName(el('<img alt="Company logo">'))).toBe(
            'Company logo',
        );
    });
});

describe('computeStates', () => {
    it('extracts checked, disabled, expanded, pressed, level, invalid', () => {
        expect(
            computeStates(el('<input type="checkbox" checked>'), 'checkbox'),
        ).toContain('checked');
        expect(computeStates(el('<button disabled>x</button>'), 'button')).toContain(
            'disabled',
        );
        expect(
            computeStates(el('<button aria-expanded="true">x</button>'), 'button'),
        ).toContain('expanded');
        expect(
            computeStates(el('<button aria-pressed="true">x</button>'), 'button'),
        ).toContain('pressed');
        expect(computeStates(el('<h3>x</h3>'), 'heading')).toContain('level=3');
        expect(computeStates(el('<input aria-invalid="true">'), 'textbox')).toContain(
            'invalid',
        );
    });

    it('extracts selected for options', () => {
        mount('<select><option selected>A</option><option>B</option></select>');
        const option = document.querySelector('option') as Element;
        expect(computeStates(option, 'option')).toContain('selected');
    });
});

describe('buildSnapshot — refs and serialization', () => {
    it('keeps the same ref for the same element across snapshots', () => {
        mount('<button>Save</button>');
        const first = buildSnapshot({ viewportOnly: false });
        const second = buildSnapshot({ viewportOnly: false });
        const ref1 = /ref=(e\d+)/.exec(first.text)?.[1];
        const ref2 = /ref=(e\d+)/.exec(second.text)?.[1];
        expect(ref1).toBeDefined();
        expect(ref1).toBe(ref2);
        expect(first.refCount).toBe(1);
    });

    it('serializes a small tree in the YAML-ish format', () => {
        mount('<button>Save</button><a href="https://example.com/x">Home</a>');
        const { text, refCount } = buildSnapshot({ viewportOnly: false });
        expect(refCount).toBe(2);
        expect(text).toBe(
            [
                '- button "Save" [ref=e1]',
                '- link "Home" [ref=e2]',
                '  /url: https://example.com/x',
            ].join('\n'),
        );
    });

    it('marks newly-appeared nodes with a leading asterisk', () => {
        mount('<button>One</button>');
        buildSnapshot({ viewportOnly: false });
        document.body.insertAdjacentHTML('beforeend', '<button>Two</button>');
        const { text } = buildSnapshot({ viewportOnly: false });
        expect(text).toContain('- button "One"');
        expect(text).toContain('- * button "Two"');
    });

    it('drops pure-text nodes in interactive-only mode', () => {
        mount('<p>Just text</p><button>Click</button>');
        const all = buildSnapshot({ viewportOnly: false });
        const interactive = buildSnapshot({
            viewportOnly: false,
            interactiveOnly: true,
        });
        expect(all.text).toContain('Just text');
        expect(interactive.text).not.toContain('Just text');
        expect(interactive.text).toContain('- button "Click"');
    });
});

describe('resolveRef + StaleRefError', () => {
    it('resolves a live ref and throws on a detached node', () => {
        mount('<button>Save</button>');
        const { text } = buildSnapshot({ viewportOnly: false });
        const ref = /ref=(e\d+)/.exec(text)?.[1] as string;
        expect(resolveRef(ref).tagName).toBe('BUTTON');

        document.body.innerHTML = '';
        expect(() => resolveRef(ref)).toThrow(StaleRefError);
    });

    it('throws StaleRefError for an unknown ref', () => {
        expect(() => resolveRef('e999')).toThrow(StaleRefError);
    });
});
