import { toBase64 } from './util';

/**
 * Screenshot post-processing in the service worker: draw the numbered
 * set-of-mark boxes onto the captured viewport and crop to an element. Rects
 * arrive in viewport CSS pixels and are scaled by the device pixel ratio.
 */

/** A rectangle in viewport CSS pixels. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** A mark: an element ref and its rectangle. */
export interface Mark extends Rect {
    ref: string;
}

/** What the content script measured for a screenshot. */
interface ScreenshotLayout {
    /** `window.devicePixelRatio`. */
    dpr: number;
    /** Marks to draw (empty unless `marks` was asked for). */
    marks: Mark[];
    /** Element to crop to, when `ref` was given. */
    crop: Rect | null;
}

/** Padding around a cropped element, in CSS pixels. */
const CROP_PADDING = 8;

/**
 * Compute the image-pixel box to crop to: the element plus padding, scaled by
 * the pixel ratio and clamped to the image.
 *
 * @param rect - The element rectangle (CSS pixels).
 * @param dpr - Device pixel ratio.
 * @param width - Image width (image pixels).
 * @param height - Image height (image pixels).
 * @returns The crop box in image pixels.
 */
export function cropBox(rect: Rect, dpr: number, width: number, height: number): Rect {
    const x = Math.max(0, Math.floor((rect.x - CROP_PADDING) * dpr));
    const y = Math.max(0, Math.floor((rect.y - CROP_PADDING) * dpr));
    const right = Math.min(width, Math.ceil((rect.x + rect.w + CROP_PADDING) * dpr));
    const bottom = Math.min(height, Math.ceil((rect.y + rect.h + CROP_PADDING) * dpr));
    return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

/**
 * Return the label drawn for a mark: the number of its ref (`e12` -> `12`).
 *
 * @param ref - The element ref.
 * @returns The label.
 */
function markLabel(ref: string): string {
    return ref.replace(/^e/, '');
}

/**
 * Draw marks and crop a captured viewport image.
 *
 * @param dataUrl - The `captureVisibleTab` image.
 * @param layout - Marks, crop and pixel ratio.
 * @returns The processed image as a JPEG data URL.
 */
export async function renderScreenshot(
    dataUrl: string,
    layout: ScreenshotLayout,
): Promise<string> {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const box = layout.crop
        ? cropBox(layout.crop, layout.dpr, bitmap.width, bitmap.height)
        : { x: 0, y: 0, w: bitmap.width, h: bitmap.height };
    const canvas = new OffscreenCanvas(box.w, box.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return dataUrl;
    }
    ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
    const scale = layout.dpr;
    ctx.lineWidth = Math.max(1, Math.round(2 * scale));
    ctx.font = `bold ${Math.round(12 * scale)}px sans-serif`;
    ctx.textBaseline = 'top';
    for (const mark of layout.marks) {
        const x = mark.x * scale - box.x;
        const y = mark.y * scale - box.y;
        ctx.strokeStyle = '#e8590c';
        ctx.strokeRect(x, y, mark.w * scale, mark.h * scale);
        const label = markLabel(mark.ref);
        const pad = 2 * scale;
        const width = ctx.measureText(label).width + 2 * pad;
        const height = 14 * scale;
        ctx.fillStyle = '#e8590c';
        ctx.fillRect(x, Math.max(0, y - height), width, height);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x + pad, Math.max(0, y - height) + pad / 2);
    }
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return `data:${blob.type};base64,${toBase64(await blob.arrayBuffer())}`;
}
