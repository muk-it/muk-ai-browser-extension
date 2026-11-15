/**
 * ARIA state extraction for the in-page perception engine.
 *
 * Ported from Microsoft Playwright (packages/injected/src/roleUtils.ts,
 * ariaSnapshot.ts), Apache-2.0. A condensed reimplementation of the
 * getAriaChecked/Disabled/Expanded/Pressed/Selected/Level helpers plus the
 * `invalid` state, returning the salient states for a node as a flat list of
 * tokens the serializer wraps in `[...]`.
 *
 * MODIFIED from the original: collapsed into a single pass over the common
 * states and adapted to the muk_ai_browser SnapshotNode shape.
 *
 *   Copyright (c) Microsoft Corporation.
 *   Licensed under the Apache License, Version 2.0.
 *
 * The Playwright name is used here only to attribute the derived algorithm.
 */

/** Roles for which a checked/mixed state is meaningful. */
const CHECKABLE_ROLES: ReadonlySet<string> = new Set([
    'checkbox',
    'radio',
    'menuitemcheckbox',
    'menuitemradio',
    'switch',
]);

/** Roles for which a selected state is meaningful. */
const SELECTABLE_ROLES: ReadonlySet<string> = new Set([
    'option',
    'tab',
    'row',
    'gridcell',
    'treeitem',
]);

/**
 * Read a tri-state ARIA boolean attribute (`true`/`false`/`mixed`).
 *
 * @param element - The element to inspect.
 * @param name - The attribute name (e.g. `aria-checked`).
 * @returns The token value, or null when absent.
 */
function ariaToken(element: Element, name: string): string | null {
    const value = element.getAttribute(name);
    if (value === null) {
        return null;
    }
    return value.toLowerCase();
}

/**
 * Test whether a control is disabled, natively or via `aria-disabled`, taking
 * an ancestor `fieldset[disabled]` into account.
 *
 * @param element - The element to inspect.
 * @returns True when the element is disabled.
 */
function isDisabled(element: Element): boolean {
    if ((element as HTMLInputElement).disabled === true) {
        return true;
    }
    if (ariaToken(element, 'aria-disabled') === 'true') {
        return true;
    }
    return element.closest('fieldset[disabled]') !== null;
}

/**
 * Read the heading/listitem level from a native heading tag or `aria-level`.
 *
 * @param element - The element to inspect.
 * @returns The level (>= 1), or 0 when none applies.
 */
function ariaLevel(element: Element): number {
    const match = /^H([1-6])$/.exec(element.tagName.toUpperCase());
    if (match) {
        return Number(match[1]);
    }
    const explicit = Number(element.getAttribute('aria-level'));
    return Number.isInteger(explicit) && explicit >= 1 ? explicit : 0;
}

/**
 * Compute the salient ARIA/DOM states of an element for its role: checked,
 * disabled, expanded/collapsed, pressed, selected, level, and invalid.
 *
 * @param element - The element to inspect.
 * @param role - The element's computed role.
 * @returns The state tokens in a stable order.
 */
export function computeStates(element: Element, role: string | null): string[] {
    const states: string[] = [];

    if (role && CHECKABLE_ROLES.has(role)) {
        const native = element as HTMLInputElement;
        const aria = ariaToken(element, 'aria-checked');
        if (aria === 'mixed' || native.indeterminate === true) {
            states.push('mixed');
        } else if (native.checked === true || aria === 'true') {
            states.push('checked');
        }
    }

    if (isDisabled(element)) {
        states.push('disabled');
    }

    if (element.tagName.toUpperCase() === 'DETAILS') {
        states.push((element as HTMLDetailsElement).open ? 'expanded' : 'collapsed');
    } else {
        const expanded = ariaToken(element, 'aria-expanded');
        if (expanded === 'true') {
            states.push('expanded');
        } else if (expanded === 'false') {
            states.push('collapsed');
        }
    }

    const pressed = ariaToken(element, 'aria-pressed');
    if (pressed === 'true') {
        states.push('pressed');
    } else if (pressed === 'mixed') {
        states.push('pressed mixed');
    }

    if (role && SELECTABLE_ROLES.has(role)) {
        if ((element as HTMLOptionElement).selected === true) {
            states.push('selected');
        } else if (ariaToken(element, 'aria-selected') === 'true') {
            states.push('selected');
        }
    }

    if (role === 'heading') {
        const level = ariaLevel(element);
        if (level > 0) {
            states.push(`level=${level}`);
        }
    }

    const invalidAttr = ariaToken(element, 'aria-invalid');
    const validity = (element as HTMLInputElement).validity;
    if (
        (invalidAttr !== null && invalidAttr !== 'false') ||
        (validity !== undefined && validity.valid === false)
    ) {
        states.push('invalid');
    }

    return states;
}
