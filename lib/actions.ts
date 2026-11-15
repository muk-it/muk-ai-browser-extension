import { type ToolResult, failure } from './messaging';
import { type KeyChord, type Modifier, parseKey } from './keys';
import type { MouseButton } from './cdp';
import type { Mark, Rect } from './screenshot';
import {
    type Ref,
    buildSnapshot,
    markScreenshotTargets,
    resolveRef,
    StaleRefError,
} from './perception';
import { errorText, sleep } from './util';

/**
 * Browser tools that run in the page's ISOLATED content world. Each resolves a
 * {@link Ref} from the latest snapshot and dispatches synthetic DOM events.
 * Mutating tools wait for the DOM to settle and return a fresh snapshot.
 *
 * Tools prefixed `_` are steps of tools the service worker drives (trusted
 * input, screenshots); the agent never calls them by name.
 */

/** One field of `browser_fill_form`. */
interface FormField {
    ref: Ref;
    element?: string;
    value: unknown;
}

/** Overridable timings (tests). */
export interface ActionContext {
    settle?: { quietMs: number; maxMs: number };
}

/** Tools that change the page and return a fresh snapshot. */
export const MUTATING_TOOLS = new Set([
    'browser_click',
    'browser_type',
    'browser_fill_form',
    'browser_select_option',
    'browser_press_key',
    'browser_hover',
    'browser_scroll',
    'browser_navigate',
    'browser_navigate_back',
]);

/** `autocomplete` tokens of fields the extension never fills. */
const SENSITIVE_AUTOCOMPLETE = /^(cc-.+|current-password|new-password|one-time-code)$/;

/** Arguments as the agent sends them. */
type Args = Record<string, unknown>;

/**
 * Run one tool against the current page.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @param ctx - Overridable timings.
 * @returns The tool result.
 */
export async function performAction(
    name: string,
    args: Args,
    ctx: ActionContext = {},
): Promise<ToolResult> {
    try {
        const result = await run(name, args, ctx);
        if (result.ok && MUTATING_TOOLS.has(name)) {
            await settle(ctx.settle);
            return { ...result, snapshot: snapshotText() };
        }
        return result;
    } catch (error) {
        if (error instanceof StaleRefError) {
            return failure('stale_ref', error.message);
        }
        return failure('failed', errorText(error));
    }
}

/**
 * Dispatch a tool to its executor.
 *
 * @param name - Tool name.
 * @param args - Tool arguments.
 * @param ctx - Overridable timings.
 * @returns The raw result, before the post-action snapshot.
 */
async function run(name: string, args: Args, ctx: ActionContext): Promise<ToolResult> {
    switch (name) {
        case 'browser_read_page':
            return readPage(args);
        case 'browser_find':
            return find(String(args.query ?? ''), Number(args.max_results ?? 20));
        case 'browser_click':
            return click(args);
        case 'browser_type':
            return typeInto(
                resolveRef(String(args.ref)),
                String(args.text ?? ''),
                Boolean(args.submit),
            );
        case 'browser_fill_form':
            return fillForm(
                Array.isArray(args.fields) ? (args.fields as FormField[]) : [],
            );
        case 'browser_select_option':
            return select(resolveRef(String(args.ref)), toList(args.values));
        case 'browser_press_key':
            return pressKey(String(args.key ?? ''), args.ref);
        case 'browser_hover':
            return hover(resolveRef(String(args.ref)));
        case 'browser_scroll':
            return scroll(args);
        case 'browser_wait_for':
            return waitFor(args);
        case '_locate':
            return locate(args);
        case '_layout':
            return layout(args);
        case '_settle':
            await settle(ctx.settle);
            return { ok: true, snapshot: snapshotText() };
        default:
            return failure(
                'unknown_tool',
                `The browser does not know the tool ${name}.`,
            );
    }
}

// ----------------------------------------------------------
// Safety
// ----------------------------------------------------------

/**
 * Refuse fields the user must fill in: passwords, payment cards, one-time
 * codes and file uploads.
 *
 * @param el - The target element.
 * @returns A refusal, or `null` when the field may be filled.
 */
function refuseField(el: Element): ToolResult | null {
    if (el instanceof HTMLInputElement && el.type === 'file') {
        return failure(
            'file_upload',
            'The browser agent never uploads files: ask the user to choose the file.',
        );
    }
    const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
    if (
        (el instanceof HTMLInputElement && el.type === 'password') ||
        tokens.some((token) => SENSITIVE_AUTOCOMPLETE.test(token))
    ) {
        return failure(
            'sensitive_field',
            'This field holds a password, payment card or one-time code. ' +
                'The browser agent does not fill it in: ask the user to fill it in.',
        );
    }
    return null;
}

// ----------------------------------------------------------
// Executors
// ----------------------------------------------------------

/**
 * Snapshot the page with the `browser_read_page` scope.
 *
 * @param args - `viewport_only`, `interactive_only`, `max_chars`.
 * @returns URL, title and snapshot text.
 */
function readPage(args: Args): ToolResult {
    const text = buildSnapshot({
        viewportOnly: args.viewport_only === true,
        interactiveOnly: args.interactive_only === true,
        ...(args.max_chars != null && { maxChars: Number(args.max_chars) }),
    }).text;
    return { ok: true, url: location.href, title: document.title, snapshot: text };
}

/**
 * Search the whole page snapshot for lines containing every query word.
 *
 * @param query - Words to find (role, name or state).
 * @param maxResults - Cap on returned lines.
 * @returns The matching snapshot lines.
 */
export function find(query: string, maxResults: number): ToolResult {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return failure('bad_arguments', 'browser_find needs a non-empty query.');
    }
    const lines = buildSnapshot({
        viewportOnly: false,
        interactiveOnly: false,
        maxChars: 0,
    })
        .text.split('\n')
        .map((line) => line.trim())
        .filter((line) => words.every((word) => line.toLowerCase().includes(word)));
    return { ok: true, matches: lines.slice(0, maxResults), total: lines.length };
}

/**
 * Click an element with synthetic pointer and mouse events.
 *
 * @param args - `ref`, `button`, `double`, `modifiers`.
 * @returns The click result.
 */
function click(args: Args): ToolResult {
    const el = resolveRef(String(args.ref));
    reveal(el);
    const button = (args.button as MouseButton) ?? 'left';
    const init = mouseInit(
        button === 'right' ? 2 : button === 'middle' ? 1 : 0,
        toList(args.modifiers) as Modifier[],
    );
    if (el instanceof HTMLElement) {
        el.focus();
    }
    pointer(el, 'pointerdown', init);
    el.dispatchEvent(new MouseEvent('mousedown', init));
    pointer(el, 'pointerup', init);
    el.dispatchEvent(new MouseEvent('mouseup', init));
    if (button === 'right') {
        el.dispatchEvent(new MouseEvent('contextmenu', init));
    } else {
        el.dispatchEvent(new MouseEvent('click', init));
        if (args.double) {
            el.dispatchEvent(new MouseEvent('dblclick', init));
        }
    }
    return { ok: true };
}

/**
 * Replace the text of a field, optionally submitting its form.
 *
 * @param el - The field.
 * @param text - The new text.
 * @param submit - Whether to submit afterwards.
 * @returns The typing result.
 */
function typeInto(el: Element, text: string, submit: boolean): ToolResult {
    const refusal = refuseField(el);
    if (refusal) {
        return refusal;
    }
    if (el instanceof HTMLElement) {
        el.focus();
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setValue(el, text);
        if (submit) {
            submitForm(el);
        }
        return { ok: true };
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return { ok: true };
    }
    return failure('not_editable', 'The element does not accept text.');
}

/**
 * Fill several fields at once. Nothing is filled when any field is refused.
 *
 * @param fields - The fields and their values.
 * @returns The fill result.
 */
function fillForm(fields: FormField[]): ToolResult {
    const targets = fields.map((field) => ({
        field,
        el: resolveRef(String(field.ref)),
    }));
    for (const { el } of targets) {
        const refusal = refuseField(el);
        if (refusal) {
            return refusal;
        }
    }
    for (const { field, el } of targets) {
        const result = fillOne(el, field.value);
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true, filled: targets.length };
}

/**
 * Fill one field by its kind: checkbox, radio, select or text.
 *
 * @param el - The field.
 * @param value - The value (boolean-like for checkboxes and radios).
 * @returns The fill result.
 */
function fillOne(el: Element, value: unknown): ToolResult {
    if (
        el instanceof HTMLInputElement &&
        (el.type === 'checkbox' || el.type === 'radio')
    ) {
        const want = truthy(value);
        if (el.checked !== want && (want || el.type === 'checkbox')) {
            el.click();
        }
        return { ok: true };
    }
    if (el instanceof HTMLSelectElement) {
        return select(el, toList(value));
    }
    return typeInto(el, value == null ? '' : String(value), false);
}

/**
 * Select options of a `<select>` by value or label.
 *
 * @param el - The select.
 * @param values - Values or labels.
 * @returns The selection result.
 */
function select(el: Element, values: string[]): ToolResult {
    if (!(el instanceof HTMLSelectElement)) {
        return failure('not_a_select', 'The element is not a select box.');
    }
    const wanted = new Set(values);
    const options = Array.from(el.options);
    const hits = options.filter(
        (option) => wanted.has(option.value) || wanted.has(option.label),
    );
    if (hits.length === 0) {
        return failure('no_option', `No option matches ${values.join(', ')}.`);
    }
    for (const option of options) {
        option.selected = hits.includes(option) || (el.multiple && option.selected);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: hits.length };
}

/**
 * Press a key chord on an element or the focused element.
 *
 * @param key - The chord, e.g. `Enter` or `Control+a`.
 * @param ref - Optional element to focus first.
 * @returns The key result.
 */
function pressKey(key: string, ref: unknown): ToolResult {
    const target = ref
        ? resolveRef(String(ref))
        : (document.activeElement ?? document.body);
    if (ref && target instanceof HTMLElement) {
        target.focus();
    }
    const chord = parseKey(key);
    const init = keyInit(chord);
    const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    if (
        proceed &&
        chord.key === 'Enter' &&
        target instanceof HTMLInputElement &&
        target.form
    ) {
        target.form.requestSubmit();
    }
    return { ok: true };
}

/**
 * Hover an element.
 *
 * @param el - The element.
 * @returns The hover result.
 */
function hover(el: Element): ToolResult {
    reveal(el);
    const init = mouseInit(0, []);
    pointer(el, 'pointerover', init);
    el.dispatchEvent(new MouseEvent('mouseover', init));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
    pointer(el, 'pointermove', init);
    el.dispatchEvent(new MouseEvent('mousemove', init));
    return { ok: true };
}

/**
 * Scroll the page or a scroll container by pages.
 *
 * @param args - `ref`, `direction`, `amount_pages`.
 * @returns The scroll result.
 */
function scroll(args: Args): ToolResult {
    const pages = Number(args.amount_pages ?? 1);
    const box = args.ref ? (resolveRef(String(args.ref)) as HTMLElement) : null;
    const direction = String(args.direction ?? 'down');
    const sign = direction === 'up' || direction === 'left' ? -1 : 1;
    const horizontal = direction === 'left' || direction === 'right';
    const step = horizontal
        ? (box?.clientWidth ?? window.innerWidth)
        : (box?.clientHeight ?? window.innerHeight);
    const delta = {
        left: horizontal ? sign * step * pages : 0,
        top: horizontal ? 0 : sign * step * pages,
    };
    (box ?? window).scrollBy(delta);
    return { ok: true };
}

/**
 * Wait for text to appear or disappear, or for a fixed time.
 *
 * @param args - `text`, `text_gone`, `time_ms`, `timeout_ms`.
 * @returns Whether the condition held, with a fresh snapshot.
 */
async function waitFor(args: Args): Promise<ToolResult> {
    const timeout = Number(args.timeout_ms ?? 10000);
    if (args.time_ms != null) {
        await sleep(Math.min(Number(args.time_ms), timeout));
        return { ok: true, snapshot: snapshotText() };
    }
    const text = args.text == null ? null : String(args.text);
    const gone = args.text_gone == null ? null : String(args.text_gone);
    if (text == null && gone == null) {
        return failure(
            'bad_arguments',
            'browser_wait_for needs text, text_gone or time_ms.',
        );
    }
    const deadline = Date.now() + timeout;
    for (;;) {
        const body = document.body?.innerText ?? '';
        if (
            (text == null || body.includes(text)) &&
            (gone == null || !body.includes(gone))
        ) {
            return { ok: true, matched: true, snapshot: snapshotText() };
        }
        if (Date.now() >= deadline) {
            return failure(
                'timeout',
                `The page did not change as expected within ${timeout} ms.`,
            );
        }
        await sleep(150);
    }
}

/**
 * Bring an element into view, optionally focus and select its text, and
 * return its centre for trusted input.
 *
 * @param args - `ref`, `focus`, `select`, `editable` (refuse sensitive fields).
 * @returns The centre in viewport CSS pixels.
 */
function locate(args: Args): ToolResult {
    const el = resolveRef(String(args.ref));
    if (args.editable) {
        const refusal = refuseField(el);
        if (refusal) {
            return refusal;
        }
    }
    reveal(el);
    if (args.focus && el instanceof HTMLElement) {
        el.focus();
    }
    if (args.select) {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.select();
        } else {
            window.getSelection()?.selectAllChildren(el);
        }
    }
    const rect = el.getBoundingClientRect();
    return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Measure what a screenshot needs: pixel ratio, marks and the crop element.
 *
 * @param args - `marks`, `ref`.
 * @returns The screenshot layout.
 */
function layout(args: Args): ToolResult {
    let crop: Rect | null = null;
    if (args.ref) {
        const el = resolveRef(String(args.ref));
        reveal(el);
        crop = toRect(el.getBoundingClientRect());
    }
    const marks: Mark[] = args.marks
        ? markScreenshotTargets().map(({ ref, rect }) => ({ ref, ...toRect(rect) }))
        : [];
    return { ok: true, dpr: window.devicePixelRatio || 1, marks, crop };
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------

/**
 * Serialise the default-scope snapshot, never throwing.
 *
 * @returns The snapshot text, or `''` when perception fails.
 */
function snapshotText(): string {
    try {
        return buildSnapshot().text;
    } catch {
        return '';
    }
}

/**
 * Convert a DOM rect to a plain rect.
 *
 * @param rect - The DOM rect.
 * @returns The plain rect.
 */
function toRect(rect: DOMRect): Rect {
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

/**
 * Coerce a value to a list of strings.
 *
 * @param value - A string, a list or nothing.
 * @returns The list.
 */
function toList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(String);
    }
    return value == null ? [] : [String(value)];
}

/**
 * Read a boolean-like form value.
 *
 * @param value - `true`, `"true"`, `"on"`, `"yes"`, `"1"`, ...
 * @returns The boolean.
 */
function truthy(value: unknown): boolean {
    if (typeof value === 'string') {
        return ['true', '1', 'on', 'yes', 'checked'].includes(value.toLowerCase());
    }
    return Boolean(value);
}

/**
 * Scroll an element into view (not implemented in jsdom).
 *
 * @param el - The element.
 */
function reveal(el: Element): void {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
}

/**
 * Build a mouse event init.
 *
 * @param button - Numeric button.
 * @param modifiers - Held modifiers.
 * @returns The init.
 */
function mouseInit(button: number, modifiers: readonly Modifier[]): MouseEventInit {
    return {
        bubbles: true,
        cancelable: true,
        composed: true,
        button,
        ...modifierFlags(modifiers),
    };
}

/**
 * Build a keyboard event init from a chord.
 *
 * @param chord - The parsed chord.
 * @returns The init.
 */
function keyInit(chord: KeyChord): KeyboardEventInit {
    return {
        key: chord.key,
        code: chord.code,
        bubbles: true,
        cancelable: true,
        ...modifierFlags(chord.modifiers),
    };
}

/**
 * Map held modifiers to the event init flags.
 *
 * @param modifiers - The held modifiers.
 * @returns `altKey`, `ctrlKey`, `metaKey` and `shiftKey`.
 */
function modifierFlags(modifiers: readonly Modifier[]): EventModifierInit {
    return {
        altKey: modifiers.includes('Alt'),
        ctrlKey: modifiers.includes('Control'),
        metaKey: modifiers.includes('Meta'),
        shiftKey: modifiers.includes('Shift'),
    };
}

/**
 * Dispatch a pointer event where supported (not in jsdom).
 *
 * @param el - Target.
 * @param type - Event type.
 * @param init - Mouse init reused for the pointer event.
 */
function pointer(el: Element, type: string, init: MouseEventInit): void {
    if (typeof PointerEvent !== 'undefined') {
        el.dispatchEvent(new PointerEvent(type, { ...init, pointerType: 'mouse' }));
    }
}

/**
 * Set a field's value through the native setter so React/Owl value trackers
 * see it, then fire `input` and `change`.
 *
 * @param el - The input or textarea.
 * @param value - The new value.
 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
        el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Submit the form of a field, or press Enter on it when it has none.
 *
 * @param el - The field.
 */
function submitForm(el: HTMLInputElement | HTMLTextAreaElement): void {
    if (el.form) {
        el.form.requestSubmit();
        return;
    }
    const init = keyInit(parseKey('Enter'));
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
}

/**
 * Resolve once the DOM was quiet for `quietMs`, at most after `maxMs`.
 *
 * @param timing - Debounce timings (default 400 ms quiet, 2 s cap).
 * @returns A promise resolved when the page settled.
 */
function settle(timing?: { quietMs: number; maxMs: number }): Promise<void> {
    const quietMs = timing?.quietMs ?? 400;
    const maxMs = timing?.maxMs ?? 2000;
    return new Promise((resolve) => {
        let quiet: ReturnType<typeof setTimeout>;
        const finish = (): void => {
            clearTimeout(quiet);
            clearTimeout(hard);
            observer.disconnect();
            resolve();
        };
        const observer = new MutationObserver(() => {
            clearTimeout(quiet);
            quiet = setTimeout(finish, quietMs);
        });
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
        quiet = setTimeout(finish, quietMs);
        const hard = setTimeout(finish, maxMs);
    });
}
