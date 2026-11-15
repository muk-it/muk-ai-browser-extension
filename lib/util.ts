/**
 * Wait a number of milliseconds.
 *
 * @param ms - Milliseconds.
 * @returns A promise resolved after `ms`.
 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Describe an error for a person or a tool result.
 *
 * @param error - Anything thrown.
 * @returns Its message.
 */
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
