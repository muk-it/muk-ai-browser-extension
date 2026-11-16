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

/** A file as the tools exchange it with Odoo: its bytes in base64. */
export interface FileData {
    name: string;
    mimetype: string;
    data: string;
}

/**
 * Encode bytes in base64 without `FileReader`.
 *
 * @param buffer - The bytes.
 * @returns The base64 text.
 */
export function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/**
 * Read a downloaded file: the name from `Content-Disposition`
 * (`filename*=UTF-8''...` before `filename="..."`), the type without its
 * parameters and the bytes in base64.
 *
 * @param response - The download response.
 * @param body - Its body.
 * @param fallback - Name used when the response names no file.
 * @returns The file.
 */
export function downloadedFile(
    response: Response,
    body: ArrayBuffer,
    fallback: string,
): FileData {
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const match =
        /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition) ??
        /filename\s*=\s*"?([^";]+)/i.exec(disposition);
    const type = response.headers.get('Content-Type')?.split(';')[0].trim();
    return {
        name: match ? decodeName(match[1].trim()) : fallback,
        mimetype: type || 'application/octet-stream',
        data: toBase64(body),
    };
}

/**
 * Decode a percent-encoded file name, keeping a malformed one as it is.
 *
 * @param name - The encoded name.
 * @returns The decoded name.
 */
export function decodeName(name: string): string {
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}
