import { describe, expect, it } from 'vitest';
import { deviceLabel } from '../../lib/device';

const brands = (...names: string[]) => names.map((brand) => ({ brand, version: '1' }));

describe('deviceLabel', () => {
    it.each([
        [
            {
                brands: brands('Not)A;Brand', 'Chromium', 'Google Chrome'),
                platform: 'Windows',
            },
            'Chrome on Windows',
        ],
        [
            { brands: brands('Chromium', 'Microsoft Edge'), platform: 'macOS' },
            'Edge on macOS',
        ],
        [{ brands: brands('Brave', 'Chromium'), platform: 'Linux' }, 'Brave on Linux'],
        [{ brands: brands('Chromium'), platform: 'Chrome OS' }, 'Chromium on ChromeOS'],
        [{ brands: [], platform: '' }, 'Chrome'],
    ])('reads the client hints %o as %s', (hints, label) => {
        expect(deviceLabel(hints, '')).toBe(label);
    });

    it.each([
        [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0',
            'Edge on Windows',
        ],
        [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
            'Chrome on macOS',
        ],
        [
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 OPR/115.0',
            'Opera on Linux',
        ],
        [
            'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
            'Chrome on Android',
        ],
    ])('falls back to the user agent %s', (userAgent, label) => {
        expect(deviceLabel(undefined, userAgent)).toBe(label);
    });
});
