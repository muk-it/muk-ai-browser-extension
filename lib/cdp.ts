import { type KeyChord, type Modifier, modifierBits } from './keys';

/**
 * Trusted input through the Chrome DevTools Protocol, used only when a tool
 * call asks for `trusted: true` (pages that ignore synthetic events). It needs
 * the `debugger` permission, which Chrome does not offer as optional; without
 * it a trusted call is refused. The debugger attaches for one action and
 * detaches right after, so Chrome's debugging bar shows only meanwhile.
 */

/** Sends one CDP command to the attached tab. */
type CdpSend = (method: string, params?: object) => Promise<unknown>;

/** Mouse buttons as CDP names them. */
export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Tell whether trusted input is granted.
 *
 * @returns Whether the `debugger` permission is held.
 */
export async function trustedInputGranted(): Promise<boolean> {
    return chrome.permissions.contains({ permissions: ['debugger'] });
}

/**
 * Attach the debugger to a tab, run `fn`, and always detach.
 *
 * @param tabId - The tab to drive.
 * @param fn - The CDP work.
 * @returns What `fn` returned.
 */
export async function withDebugger<T>(
    tabId: number,
    fn: (send: CdpSend) => Promise<T>,
): Promise<T> {
    const target = { tabId };
    await chrome.debugger.attach(target, '1.3');
    try {
        return await fn((method, params) =>
            chrome.debugger.sendCommand(target, method, params),
        );
    } finally {
        await chrome.debugger.detach(target).catch(() => undefined);
    }
}

/**
 * Build the CDP mouse events of a click at viewport CSS pixel `(x, y)`.
 *
 * @param x - Viewport x.
 * @param y - Viewport y.
 * @param button - Mouse button.
 * @param double - Whether to double-click.
 * @param modifiers - Held modifiers.
 * @returns The `Input.dispatchMouseEvent` parameter objects, in order.
 */
export function clickEvents(
    x: number,
    y: number,
    button: MouseButton,
    double: boolean,
    modifiers: readonly Modifier[],
): object[] {
    const base = { x, y, button, modifiers: modifierBits(modifiers) };
    const events: object[] = [{ type: 'mouseMoved', x, y }];
    for (let count = 1; count <= (double ? 2 : 1); count += 1) {
        events.push({ ...base, type: 'mousePressed', clickCount: count });
        events.push({ ...base, type: 'mouseReleased', clickCount: count });
    }
    return events;
}

/**
 * Build the CDP key events of a chord.
 *
 * @param chord - The parsed chord.
 * @returns The `Input.dispatchKeyEvent` parameter objects, in order.
 */
export function keyEvents(chord: KeyChord): object[] {
    const base = {
        key: chord.key,
        code: chord.code,
        windowsVirtualKeyCode: chord.keyCode,
        modifiers: modifierBits(chord.modifiers),
    };
    return [
        chord.text
            ? { ...base, type: 'keyDown', text: chord.text }
            : { ...base, type: 'rawKeyDown' },
        { ...base, type: 'keyUp' },
    ];
}

/**
 * Send a list of input events in order.
 *
 * @param send - The CDP sender.
 * @param method - `Input.dispatchMouseEvent` or `Input.dispatchKeyEvent`.
 * @param events - The parameter objects.
 */
export async function dispatchAll(
    send: CdpSend,
    method: string,
    events: object[],
): Promise<void> {
    for (const params of events) {
        await send(method, params);
    }
}
