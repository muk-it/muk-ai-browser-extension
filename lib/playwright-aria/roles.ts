/**
 * ARIA role computation for the in-page perception engine.
 *
 * Ported from Microsoft Playwright (packages/injected/src/roleUtils.ts,
 * ariaSnapshot.ts), Apache-2.0. This is a clean, condensed TypeScript
 * reimplementation of the implicit-role table (HTML-AAM) and the
 * presentation/none conflict resolution, covering the elements exercised by the
 * muk_ai_browser tool schemas. It is intentionally a correct subset of the
 * ~2000-line upstream file, not a line-for-line copy.
 *
 * MODIFIED from the original: trimmed to the common real-world element set,
 * restructured for content-script use (no Playwright runtime), and adapted to
 * the muk_ai_browser SnapshotNode shape.
 *
 *   Copyright (c) Microsoft Corporation.
 *   Licensed under the Apache License, Version 2.0.
 *
 * The Playwright name is used here only to attribute the derived algorithm; it
 * does not brand or endorse this extension.
 */

/** Computed ARIA role (a plain string such as `button`, `textbox`, `link`). */
export type AriaRole = string;

/** Roles whose accessible name is derived from descendant text content. */
export const NAME_FROM_CONTENT_ROLES: ReadonlySet<string> = new Set([
    'button',
    'cell',
    'checkbox',
    'columnheader',
    'gridcell',
    'heading',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'row',
    'rowheader',
    'switch',
    'tab',
    'tooltip',
    'treeitem',
]);

/** Roles considered interactive for the `interactive_only` snapshot filter. */
export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
]);

/** Implicit role of an `<input>` keyed by its `type` (HTML-AAM subset). */
const INPUT_ROLE_BY_TYPE: Record<string, AriaRole> = {
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    number: 'spinbutton',
    search: 'searchbox',
    email: 'textbox',
    tel: 'textbox',
    text: 'textbox',
    url: 'textbox',
    password: 'textbox',
};

/** Tags that establish a landmark and so suppress an inner header/footer. */
const LANDMARK_ANCESTORS = 'ARTICLE, ASIDE, MAIN, NAV, SECTION';

/**
 * Return the upper-cased tag name, tolerating non-HTML (e.g. SVG) elements.
 *
 * @param element - The element to inspect.
 * @returns The upper-cased tag name.
 */
function tagName(element: Element): string {
    return element.tagName.toUpperCase();
}

/**
 * Test whether an element carries an explicit accessible-name attribute.
 *
 * @param element - The element to inspect.
 * @returns True when `aria-label`/`aria-labelledby` provides a name.
 */
export function hasExplicitName(element: Element): boolean {
    const label = element.getAttribute('aria-label');
    if (label !== null && label.trim() !== '') {
        return true;
    }
    const labelledby = element.getAttribute('aria-labelledby');
    return labelledby !== null && labelledby.trim() !== '';
}

/**
 * Test whether an element is removed from the accessibility tree (display:none,
 * visibility:hidden/collapse, or an `aria-hidden` ancestor). Layout boxes are
 * checked separately by the perception walker.
 *
 * @param element - The element to inspect.
 * @returns True when the element is hidden for accessibility purposes.
 */
export function isElementHiddenForAria(element: Element): boolean {
    if (element.closest('[aria-hidden="true"]') !== null) {
        return true;
    }
    const tag = tagName(element);
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') {
        return true;
    }
    const view = element.ownerDocument?.defaultView;
    if (view) {
        const style = view.getComputedStyle(element);
        if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse'
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Resolve the implicit ARIA role of an element from its tag and attributes,
 * following the HTML-AAM mapping for the common element set.
 *
 * @param element - The element to map.
 * @returns The implicit role, or null when the tag has none.
 */
function implicitRole(element: Element): AriaRole | null {
    const tag = tagName(element);
    switch (tag) {
        case 'A':
        case 'AREA':
            return element.hasAttribute('href') ? 'link' : null;
        case 'ARTICLE':
            return 'article';
        case 'ASIDE':
            return 'complementary';
        case 'BUTTON':
            return 'button';
        case 'DATALIST':
            return 'listbox';
        case 'DD':
            return 'definition';
        case 'DETAILS':
            return 'group';
        case 'DIALOG':
            return 'dialog';
        case 'DT':
            return 'term';
        case 'FIELDSET':
            return 'group';
        case 'FIGURE':
            return 'figure';
        case 'FOOTER':
            return element.closest(LANDMARK_ANCESTORS) ? null : 'contentinfo';
        case 'HEADER':
            return element.closest(LANDMARK_ANCESTORS) ? null : 'banner';
        case 'FORM':
            return hasExplicitName(element) ? 'form' : null;
        case 'H1':
        case 'H2':
        case 'H3':
        case 'H4':
        case 'H5':
        case 'H6':
            return 'heading';
        case 'HR':
            return 'separator';
        case 'HTML':
            return 'document';
        case 'IMG':
            return element.getAttribute('alt') === '' &&
                !element.getAttribute('title') &&
                !hasExplicitName(element) &&
                !element.hasAttribute('tabindex')
                ? 'presentation'
                : 'img';
        case 'INPUT': {
            const type = (
                (element as HTMLInputElement).getAttribute('type') ?? 'text'
            ).toLowerCase();
            if (type === 'hidden') {
                return null;
            }
            return INPUT_ROLE_BY_TYPE[type] ?? 'textbox';
        }
        case 'LI':
            return 'listitem';
        case 'MAIN':
            return 'main';
        case 'MENU':
        case 'OL':
        case 'UL':
            return 'list';
        case 'METER':
            return 'meter';
        case 'NAV':
            return 'navigation';
        case 'OPTGROUP':
            return 'group';
        case 'OPTION':
            return 'option';
        case 'OUTPUT':
            return 'status';
        case 'PROGRESS':
            return 'progressbar';
        case 'SEARCH':
            return 'search';
        case 'SECTION':
            return hasExplicitName(element) ? 'region' : null;
        case 'SELECT':
            return (element as HTMLSelectElement).multiple ||
                (element as HTMLSelectElement).size > 1
                ? 'listbox'
                : 'combobox';
        case 'SVG':
            return 'img';
        case 'TABLE':
            return 'table';
        case 'TBODY':
        case 'TFOOT':
        case 'THEAD':
            return 'rowgroup';
        case 'TD': {
            const inGrid = element.closest('table')?.matches(
                '[role="grid"], [role="treegrid"]',
            );
            return inGrid ? 'gridcell' : 'cell';
        }
        case 'TH': {
            const scope = element.getAttribute('scope');
            if (scope === 'row') {
                return 'rowheader';
            }
            return 'columnheader';
        }
        case 'TEXTAREA':
            return 'textbox';
        case 'TR':
            return 'row';
        default:
            return null;
    }
}

/**
 * Read the first token of an explicit `role` attribute, if any.
 *
 * @param element - The element to inspect.
 * @returns The first non-empty role token, or null.
 */
function explicitRole(element: Element): AriaRole | null {
    const role = element.getAttribute('role');
    if (role === null) {
        return null;
    }
    const token = role.trim().split(/\s+/)[0];
    return token === '' ? null : token.toLowerCase();
}

/**
 * Test whether an element is focusable or otherwise resists being demoted to
 * `presentation`/`none` (used for the presentation-conflict resolution).
 *
 * @param element - The element to inspect.
 * @returns True when presentation should be ignored.
 */
function preventsPresentation(element: Element): boolean {
    if (element.hasAttribute('tabindex') || hasExplicitName(element)) {
        return true;
    }
    const tag = tagName(element);
    return (
        tag === 'A' ||
        tag === 'AREA' ||
        tag === 'BUTTON' ||
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA'
    );
}

/**
 * Compute the effective ARIA role of an element: an explicit `role` attribute
 * (with presentation/none conflict resolution) wins, otherwise the implicit
 * HTML-AAM role. Returns null for pure-generic nodes that carry no name, so the
 * walker can skip them and promote their children.
 *
 * @param element - The element to classify.
 * @returns The role string, or null when the node is not part of the tree.
 */
export function computeRole(element: Element): AriaRole | null {
    const explicit = explicitRole(element);
    if (explicit !== null) {
        if (explicit === 'presentation' || explicit === 'none') {
            if (!preventsPresentation(element)) {
                return null;
            }
            // Conflict: the element resists presentation; fall back to implicit.
        } else {
            return explicit;
        }
    }
    const implicit = implicitRole(element);
    if (implicit === 'presentation') {
        return null;
    }
    if (implicit !== null) {
        return implicit;
    }
    return hasExplicitName(element) ? 'generic' : null;
}
