/**
 * Key chords as the agent writes them (`Enter`, `Control+a`, `Shift+Tab`),
 * parsed once for both synthetic DOM events and CDP input.
 */

/** Modifier keys. */
export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** A parsed key chord. */
export interface KeyChord {
    /** `KeyboardEvent.key`. */
    key: string;
    /** `KeyboardEvent.code`. */
    code: string;
    /** Windows virtual key code (CDP `windowsVirtualKeyCode`). */
    keyCode: number;
    /** Held modifiers. */
    modifiers: Modifier[];
    /** Text the key inserts, or `''` for a non-printing key or a shortcut. */
    text: string;
}

/** Named keys: `[code, keyCode, text]`. */
const NAMED: Record<string, [string, number, string]> = {
    Enter: ['Enter', 13, '\r'],
    Tab: ['Tab', 9, ''],
    Escape: ['Escape', 27, ''],
    Backspace: ['Backspace', 8, ''],
    Delete: ['Delete', 46, ''],
    ArrowUp: ['ArrowUp', 38, ''],
    ArrowDown: ['ArrowDown', 40, ''],
    ArrowLeft: ['ArrowLeft', 37, ''],
    ArrowRight: ['ArrowRight', 39, ''],
    Home: ['Home', 36, ''],
    End: ['End', 35, ''],
    PageUp: ['PageUp', 33, ''],
    PageDown: ['PageDown', 34, ''],
    ' ': ['Space', 32, ' '],
};

/** Spellings of modifiers and named keys the agent may use. */
const ALIASES: Record<string, string> = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
    cmd: 'Meta',
    command: 'Meta',
    esc: 'Escape',
    return: 'Enter',
    space: ' ',
    del: 'Delete',
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
};

/** CDP `modifiers` bit per modifier. */
const MODIFIER_BITS: Record<Modifier, number> = {
    Alt: 1,
    Control: 2,
    Meta: 4,
    Shift: 8,
};

/**
 * Canonicalise one chord part.
 *
 * @param part - A part such as `ctrl` or `enter`.
 * @returns The canonical name.
 */
function canonical(part: string): string {
    const alias = ALIASES[part.toLowerCase()];
    if (alias) {
        return alias;
    }
    const named = Object.keys(NAMED).find(
        (name) => name.toLowerCase() === part.toLowerCase(),
    );
    return named ?? part;
}

/**
 * Parse a key chord.
 *
 * @param chord - E.g. `Enter`, `Control+a`, `Shift+Tab`, `+`.
 * @returns The parsed chord.
 */
export function parseKey(chord: string): KeyChord {
    const plus = chord.length > 1 && chord.endsWith('++');
    const body = plus ? chord.slice(0, -2) : chord;
    const parts = chord.length > 1 ? body.split('+').filter(Boolean) : [chord];
    if (plus) {
        parts.push('+');
    }
    const key = canonical(parts.pop() ?? chord);
    const modifiers = parts
        .map(canonical)
        .filter((part): part is Modifier =>
            ['Alt', 'Control', 'Meta', 'Shift'].includes(part),
        );
    const shortcut = modifiers.some((mod) => mod !== 'Shift');
    const named = NAMED[key];
    if (named) {
        const [code, keyCode, text] = named;
        return { key, code, keyCode, modifiers, text: shortcut ? '' : text };
    }
    const char = key.length === 1 ? key : '';
    const upper = char.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(char);
    return {
        key,
        code: isLetter ? `Key${upper}` : isDigit ? `Digit${char}` : key,
        keyCode: char ? upper.charCodeAt(0) : 0,
        modifiers,
        text: shortcut ? '' : char,
    };
}

/**
 * Return the CDP modifier bitmask of a chord.
 *
 * @param modifiers - The held modifiers.
 * @returns The bitmask.
 */
export function modifierBits(modifiers: readonly Modifier[]): number {
    return modifiers.reduce((bits, mod) => bits | MODIFIER_BITS[mod], 0);
}
