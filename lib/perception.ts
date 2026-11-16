/**
 * Page-perception engine. Reconstructs the ARIA role + accessible-name tree in
 * the page and emits a YAML-ish indexed snapshot
 * (`- role "name" [state] [ref=eNN]`), viewport-only and visible by default.
 *
 * The ARIA role/name/state computation is vendored under lib/playwright-aria/
 * (ported from Microsoft Playwright, Apache-2.0: see that directory and the
 * NOTICE file). This module owns the DOM walk, visibility/viewport filtering,
 * the stable-ref scheme, serialization, and the diff marking.
 *
 * Refs are stable across snapshots: a persistent WeakMap keeps the same element
 * on the same ref for its lifetime, and the counter only advances for
 * newly-seen elements.
 * Refs never touch the DOM.
 */

import {
    INTERACTIVE_ROLES,
    NAME_FROM_CONTENT_ROLES,
    computeAccessibleName,
    computeRole,
    computeStates,
    isElementHiddenForAria,
    normalizeWhitespace,
} from './playwright-aria';

/** Stable element reference handed to the agent (e.g. `e42`). Not a DOM attr. */
export type Ref = string;

/** A single node in the accessibility snapshot tree. */
interface SnapshotNode {
    /** Stable ref used by actions to re-resolve the element (empty for text). */
    ref: Ref;
    /** ARIA role (computed, e.g. `button`, `textbox`, `link`, `text`). */
    role: string;
    /** Accessible name. */
    name: string;
    /** Salient ARIA/DOM states (`checked`, `disabled`, `expanded`, ...). */
    states: string[];
    /** Resolved URL for `link` nodes (drives the `/url:` serialization line). */
    url?: string;
    /** Whether the node appeared since the previous snapshot (diff marking). */
    isNew?: boolean;
    /** Child nodes in document order. */
    children: SnapshotNode[];
}

/** Options controlling snapshot scope, mirroring the `browser_read_page` arguments. */
export interface SnapshotOptions {
    /** Restrict to nodes within the viewport. */
    viewportOnly: boolean;
    /** Restrict to interactive roles only. */
    interactiveOnly: boolean;
    /** Hard cap on serialized characters. */
    maxChars: number;
}

/** A Set-of-Mark overlay target: a ref and its current viewport rectangle. */
interface ScreenshotTarget {
    /** The element ref. */
    ref: Ref;
    /** The element's bounding rectangle in viewport coordinates. */
    rect: DOMRect;
}

/** Default snapshot options matching the `browser_read_page` defaults. */
const DEFAULT_SNAPSHOT_OPTIONS: SnapshotOptions = {
    viewportOnly: true,
    interactiveOnly: false,
    maxChars: 20000,
};

/** Marker appended when a snapshot is cut at {@link SnapshotOptions.maxChars}. */
const TRUNCATION_MARKER =
    '\n[... snapshot truncated: use browser_find, or a larger max_chars ...]';

/** Thrown when a ref no longer resolves to a connected element. */
export class StaleRefError extends Error {
    /**
     * Name the stale ref.
     *
     * @param ref - The ref that failed to resolve.
     */
    constructor(public readonly ref: Ref) {
        super(`Ref ${ref} is stale; call browser_read_page for fresh refs.`);
        this.name = 'StaleRefError';
    }
}

// ----------------------------------------------------------
// Ref registry (stable across snapshots)
// ----------------------------------------------------------

/** ref -> weakly-held element, so dead elements can be garbage-collected. */
const refToElement = new Map<Ref, WeakRef<Element>>();

/** element -> ref, persistent so a re-seen element keeps its ref. */
let elementToRef = new WeakMap<Element, Ref>();

/** Monotonic counter; only advances for newly-seen elements. */
let refCounter = 0;

/** Refs present in the previous walk, for diff (`isNew`) marking. */
let previousRefs = new Set<Ref>();

/** False until the first walk completes, so the first snapshot marks nothing. */
let hasPreviousSnapshot = false;

/**
 * Return the stable ref for an element, minting a new one on first sight.
 *
 * @param element - The element to identify.
 * @returns The element's stable ref.
 */
function refFor(element: Element): Ref {
    const existing = elementToRef.get(element);
    if (existing !== undefined) {
        return existing;
    }
    const ref = `e${++refCounter}`;
    elementToRef.set(element, ref);
    refToElement.set(ref, new WeakRef(element));
    return ref;
}

// ----------------------------------------------------------
// Visibility / viewport filtering
// ----------------------------------------------------------

/**
 * Determine the visible viewport rectangle for the current document.
 *
 * @param view - The element's owning window.
 * @returns The viewport width and height.
 */
function viewportSize(view: Window): { width: number; height: number } {
    return {
        width: view.innerWidth || view.document.documentElement.clientWidth || 0,
        height: view.innerHeight || view.document.documentElement.clientHeight || 0,
    };
}

/**
 * Test whether an element is renderable: not aria-hidden, has a layout box, and
 * (when {@link SnapshotOptions.viewportOnly}) intersects the viewport.
 *
 * @param element - The element to test.
 * @param viewportOnly - Whether to require viewport intersection.
 * @returns True when the element should appear in the snapshot.
 */
function isVisible(element: Element, viewportOnly: boolean): boolean {
    if (isElementHiddenForAria(element)) {
        return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return false;
    }
    if (!viewportOnly) {
        return true;
    }
    const view = element.ownerDocument?.defaultView;
    if (!view) {
        return true;
    }
    const { width, height } = viewportSize(view);
    return rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width;
}

// ----------------------------------------------------------
// DOM walk
// ----------------------------------------------------------

/**
 * Resolve the descendant roots of an element, transparently crossing an open
 * shadow root and same-origin iframe bodies (best effort).
 *
 * @param element - The element whose children to enumerate.
 * @returns The child nodes to walk.
 */
function childContainers(element: Element): Node[] {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) {
        return Array.from(shadow.childNodes);
    }
    if (element.tagName.toUpperCase() === 'IFRAME') {
        try {
            const doc = (element as HTMLIFrameElement).contentDocument;
            if (doc?.body) {
                return [doc.body];
            }
        } catch {
            // Cross-origin frame: not reachable from the content script.
        }
        return [];
    }
    return Array.from(element.childNodes);
}

/**
 * Recursively walk a node's children, emitting {@link SnapshotNode}s for
 * elements that carry a role and promoting the children of role-less elements
 * to the parent level.
 *
 * @param parent - The node whose children to walk.
 * @param out - The output array for this level.
 * @param opts - The active snapshot options.
 * @param suppressText - True inside a name-from-content subtree (text already
 *   captured by the ancestor's accessible name).
 * @param seen - Set collecting every ref emitted in this walk.
 */
function walk(
    parent: Node,
    out: SnapshotNode[],
    opts: SnapshotOptions,
    suppressText: boolean,
    seen: Set<Ref>,
): void {
    for (const node of childContainers(parent as Element)) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (suppressText || opts.interactiveOnly) {
                continue;
            }
            const text = normalizeWhitespace((node as Text).data);
            if (text !== '') {
                out.push({
                    ref: '',
                    role: 'text',
                    name: text,
                    states: [],
                    children: [],
                });
            }
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
            continue;
        }
        const element = node as Element;
        if (!isVisible(element, opts.viewportOnly)) {
            continue;
        }
        const role = computeRole(element);
        const included =
            role !== null &&
            role !== 'text' &&
            (!opts.interactiveOnly || INTERACTIVE_ROLES.has(role));
        if (!included) {
            walk(element, out, opts, suppressText, seen);
            continue;
        }
        const ref = refFor(element);
        seen.add(ref);
        const childSuppress = NAME_FROM_CONTENT_ROLES.has(role as string);
        const snapshotNode: SnapshotNode = {
            ref,
            role: role as string,
            name: computeAccessibleName(element, role),
            states: computeStates(element, role),
            children: [],
            isNew: hasPreviousSnapshot && !previousRefs.has(ref),
        };
        if (role === 'link') {
            const href = (element as HTMLAnchorElement).href;
            if (href) {
                snapshotNode.url = href;
            }
        }
        walk(element, snapshotNode.children, opts, childSuppress, seen);
        out.push(snapshotNode);
    }
}

/**
 * Walk the live document into a forest of {@link SnapshotNode}s, updating the
 * diff baseline.
 *
 * @param opts - The active snapshot options.
 * @returns The root nodes and the count of element refs emitted.
 */
function buildForest(opts: SnapshotOptions): {
    roots: SnapshotNode[];
    seen: Set<Ref>;
} {
    const roots: SnapshotNode[] = [];
    const seen = new Set<Ref>();
    const body = document.body ?? document.documentElement;
    if (body) {
        walk(body, roots, opts, false, seen);
    }
    previousRefs = seen;
    hasPreviousSnapshot = true;
    return { roots, seen };
}

// ----------------------------------------------------------
// Serialization
// ----------------------------------------------------------

/**
 * Append the serialized lines for a node and its subtree to a buffer.
 *
 * @param node - The node to serialize.
 * @param depth - The indentation depth.
 * @param lines - The accumulating line buffer.
 */
function serializeNode(node: SnapshotNode, depth: number, lines: string[]): void {
    const indent = '  '.repeat(depth);
    const parts: string[] = ['-'];
    if (node.isNew) {
        parts.push('*');
    }
    parts.push(node.role);
    if (node.name !== '') {
        parts.push(`"${node.name}"`);
    }
    for (const state of node.states) {
        parts.push(`[${state}]`);
    }
    if (node.ref !== '') {
        parts.push(`[ref=${node.ref}]`);
    }
    lines.push(indent + parts.join(' '));
    if (node.url) {
        lines.push(`${indent}  /url: ${node.url}`);
    }
    for (const child of node.children) {
        serializeNode(child, depth + 1, lines);
    }
}

/**
 * Cut serialized text to a character budget, appending a marker when truncated.
 *
 * @param text - The full serialized text.
 * @param maxChars - The character budget.
 * @returns The text, truncated when it exceeds the budget.
 */
function truncate(text: string, maxChars: number): string {
    if (maxChars <= 0 || text.length <= maxChars) {
        return text;
    }
    const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
    return text.slice(0, keep) + TRUNCATION_MARKER;
}

// ----------------------------------------------------------
// Public API
// ----------------------------------------------------------

/**
 * Build and serialize the accessibility snapshot of the current page, assigning
 * stable refs and marking nodes new since the previous snapshot.
 *
 * @param opts - Partial snapshot options; missing fields use the defaults.
 * @returns The serialized snapshot text.
 */
export function buildSnapshot(opts: Partial<SnapshotOptions> = {}): string {
    const options: SnapshotOptions = { ...DEFAULT_SNAPSHOT_OPTIONS, ...opts };
    const { roots } = buildForest(options);
    const lines: string[] = [];
    for (const root of roots) {
        serializeNode(root, 0, lines);
    }
    return truncate(lines.join('\n'), options.maxChars);
}

/**
 * Resolve a ref to its live element.
 *
 * @param ref - The ref to resolve.
 * @returns The connected element.
 * @throws {StaleRefError} When the ref is unknown, collected, or detached.
 */
export function resolveRef(ref: Ref): Element {
    const element = refToElement.get(ref)?.deref();
    if (!element || !element.isConnected) {
        throw new StaleRefError(ref);
    }
    return element;
}

/**
 * Collect the set-of-mark targets: every interactive element in the viewport,
 * with a ref minted for it, and its viewport rectangle.
 *
 * @returns The ref/rectangle pairs to draw.
 */
export function markScreenshotTargets(): ScreenshotTarget[] {
    const { seen } = buildForest({
        viewportOnly: true,
        interactiveOnly: true,
        maxChars: 0,
    });
    const targets: ScreenshotTarget[] = [];
    for (const ref of seen) {
        const element = refToElement.get(ref)?.deref();
        if (element?.isConnected) {
            targets.push({ ref, rect: element.getBoundingClientRect() });
        }
    }
    return targets;
}

/** Forget every ref and the diff baseline, as a fresh page does. */
export function __resetPerceptionState(): void {
    refToElement.clear();
    elementToRef = new WeakMap<Element, Ref>();
    refCounter = 0;
    previousRefs = new Set<Ref>();
    hasPreviousSnapshot = false;
}
