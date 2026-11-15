import { storage } from 'wxt/utils/storage';
import { type Checkpoint, DEFAULT_CHECKPOINT } from './checkpoint';

/**
 * Persistence in `chrome.storage.local`: the {@link Checkpoint}, which only
 * the service worker writes, and the launcher preferences, which the options
 * page and the launcher write.
 */

/** WXT storage item backing the checkpoint. */
export const checkpointItem = storage.defineItem<Checkpoint>('local:checkpoint', {
    fallback: DEFAULT_CHECKPOINT,
});

/** Whether the launcher tab shows on pages ("Show the MuK AI tab on pages"). */
export const showLauncherItem = storage.defineItem<boolean>('local:showLauncher', {
    fallback: true,
});

/**
 * Return the storage item of the launcher's vertical position on a site, as
 * a fraction of the viewport height.
 *
 * @param host - The site's host.
 * @returns The storage item.
 */
export function launcherTopItem(host: string) {
    return storage.defineItem<number>(`local:launcherTop:${host}`, { fallback: 0.5 });
}

/**
 * Read the checkpoint, filling fields an older version did not store.
 *
 * @returns The persisted checkpoint.
 */
export async function getCheckpoint(): Promise<Checkpoint> {
    return { ...DEFAULT_CHECKPOINT, ...(await checkpointItem.getValue()) };
}

/**
 * Merge a partial update into the checkpoint and persist it.
 *
 * @param patch - Fields to overwrite.
 * @returns The updated checkpoint.
 */
export async function patchCheckpoint(patch: Partial<Checkpoint>): Promise<Checkpoint> {
    const next = { ...(await getCheckpoint()), ...patch };
    await checkpointItem.setValue(next);
    return next;
}
