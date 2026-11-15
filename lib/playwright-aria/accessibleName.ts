/**
 * Accessible-name (accname) computation for the in-page perception engine.
 *
 * Ported from Microsoft Playwright (packages/injected/src/roleUtils.ts,
 * ariaSnapshot.ts), Apache-2.0, and aligned with the W3C "Accessible Name and
 * Description Computation" + "ARIA in HTML" specs. This is a clean, condensed
 * TypeScript reimplementation of the precedence chain
 * (aria-labelledby > aria-label > native > name-from-content > title) covering
 * the elements exercised by the muk_ai_browser tool schemas. It is a correct
 * subset of the upstream algorithm, not a line-for-line copy.
 *
 * MODIFIED from the original: trimmed to the common element set, recursion is
 * guarded with a visited set, and pseudo-element content is omitted (not
 * reachable from a content script without layout).
 *
 *   Copyright (c) Microsoft Corporation.
 *   Licensed under the Apache License, Version 2.0.
 *
 * The Playwright name is used here only to attribute the derived algorithm.
 */

import { NAME_FROM_CONTENT_ROLES, computeRole, isElementHiddenForAria } from './roles';

/**
 * Collapse runs of ASCII whitespace to single spaces and trim the ends, per the
 * accname flattening rule.
 *
 * @param value - The raw text to normalise.
 * @returns The trimmed, single-spaced string.
 */
export function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

/**
 * Return the upper-cased tag name.
 *
 * @param element - The element to inspect.
 * @returns The upper-cased tag name.
 */
function tagName(element: Element): string {
    return element.tagName.toUpperCase();
}

/**
 * Collect the text of every `<label>` associated with a form control, both via
 * `label[for=id]` and a wrapping `<label>` ancestor.
 *
 * @param element - The labelable control.
 * @returns The concatenated, normalised label text (empty when none).
 */
function labelText(element: Element): string {
    const parts: string[] = [];
    const id = element.getAttribute('id');
    const doc = element.ownerDocument;
    if (id && doc) {
        for (const label of Array.from(doc.querySelectorAll('label'))) {
            if (label.getAttribute('for') === id) {
                parts.push(label.textContent ?? '');
            }
        }
    }
    const wrapping = element.closest('label');
    if (wrapping) {
        parts.push(wrapping.textContent ?? '');
    }
    return normalizeWhitespace(parts.join(' '));
}

/**
 * Accumulate the descendant text of an element for the name-from-content rule,
 * honouring `aria-label`/`alt` overrides on descendants and skipping hidden
 * subtrees. Recursion is bounded by the visited set.
 *
 * @param element - The element whose content to flatten.
 * @param visited - Elements already visited (cycle guard).
 * @returns The raw concatenated text (caller normalises).
 */
function contentText(element: Element, visited: Set<Element>): string {
    if (visited.has(element)) {
        return '';
    }
    visited.add(element);
    const parts: string[] = [];
    for (const node of Array.from(element.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push((node as Text).data);
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
        }
        const child = node as Element;
        if (isElementHiddenForAria(child)) {
            continue;
        }
        const ariaLabel = child.getAttribute('aria-label');
        if (ariaLabel !== null && ariaLabel.trim() !== '') {
            parts.push(ariaLabel);
            continue;
        }
        const tag = tagName(child);
        if (tag === 'IMG' || tag === 'AREA') {
            parts.push(child.getAttribute('alt') ?? '');
            continue;
        }
        parts.push(contentText(child, visited));
    }
    return parts.join(' ');
}

/**
 * Resolve the text referenced by an `aria-labelledby` IDREF list.
 *
 * @param element - The element carrying `aria-labelledby`.
 * @param visited - Elements already visited (cycle guard).
 * @returns The joined referenced text, or null when no IDREF resolves.
 */
function labelledByText(element: Element, visited: Set<Element>): string | null {
    const idrefs = element.getAttribute('aria-labelledby');
    const doc = element.ownerDocument;
    if (!idrefs || !doc) {
        return null;
    }
    const parts: string[] = [];
    let resolvedAny = false;
    for (const id of idrefs.split(/\s+/)) {
        if (id === '') {
            continue;
        }
        const target = doc.getElementById(id);
        if (!target) {
            continue;
        }
        resolvedAny = true;
        const label = target.getAttribute('aria-label');
        if (label !== null && label.trim() !== '') {
            parts.push(label);
        } else {
            parts.push(contentText(target, visited));
        }
    }
    return resolvedAny ? normalizeWhitespace(parts.join(' ')) : null;
}

/**
 * Compute the native (host-language) accessible name for the elements that have
 * one, before falling back to name-from-content.
 *
 * @param element - The element to inspect.
 * @param role - The element's computed role.
 * @param visited - Elements already visited (cycle guard).
 * @returns The native name, or null when the element has none.
 */
function nativeName(
    element: Element,
    role: string | null,
    visited: Set<Element>,
): string | null {
    const tag = tagName(element);
    if (tag === 'INPUT') {
        const input = element as HTMLInputElement;
        const type = (input.getAttribute('type') ?? 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset') {
            const value = input.getAttribute('value');
            if (value) {
                return value;
            }
            return type === 'reset' ? 'Reset' : type === 'submit' ? 'Submit' : '';
        }
        if (type === 'image') {
            return input.getAttribute('alt') ?? input.getAttribute('title') ?? 'Submit';
        }
        const fromLabel = labelText(element);
        if (fromLabel) {
            return fromLabel;
        }
        const placeholder = input.getAttribute('placeholder');
        if (placeholder) {
            return placeholder;
        }
        return input.getAttribute('title');
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') {
        const fromLabel = labelText(element);
        if (fromLabel) {
            return fromLabel;
        }
        const placeholder = element.getAttribute('placeholder');
        if (placeholder) {
            return placeholder;
        }
        return element.getAttribute('title');
    }
    if (tag === 'IMG' || tag === 'AREA') {
        return element.getAttribute('alt') ?? element.getAttribute('title');
    }
    if (tag === 'FIELDSET') {
        const legend = element.querySelector('legend');
        return legend ? normalizeWhitespace(legend.textContent ?? '') : element.getAttribute('title');
    }
    if (tag === 'FIGURE') {
        const caption = element.querySelector('figcaption');
        return caption
            ? normalizeWhitespace(caption.textContent ?? '')
            : element.getAttribute('title');
    }
    if (tag === 'TABLE') {
        const caption = element.querySelector('caption');
        return caption
            ? normalizeWhitespace(caption.textContent ?? '')
            : element.getAttribute('summary');
    }
    if (role && NAME_FROM_CONTENT_ROLES.has(role)) {
        const text = normalizeWhitespace(contentText(element, visited));
        if (text) {
            return text;
        }
    }
    return element.getAttribute('title');
}

/**
 * Compute the accessible name of an element following the accname precedence:
 * aria-labelledby, then aria-label, then native text alternatives, then
 * name-from-content, then title.
 *
 * @param element - The element to name.
 * @param role - The element's computed role (drives name-from-content); when
 *   omitted it is resolved internally.
 * @returns The normalised accessible name (possibly empty).
 */
export function computeAccessibleName(element: Element, role?: string | null): string {
    const visited = new Set<Element>();
    const resolvedRole = role === undefined ? computeRole(element) : role;

    const labelledby = labelledByText(element, visited);
    if (labelledby !== null) {
        return labelledby;
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim() !== '') {
        return normalizeWhitespace(ariaLabel);
    }

    const native = nativeName(element, resolvedRole, visited);
    return native ? normalizeWhitespace(native) : '';
}
