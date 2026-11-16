import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Status } from '../../lib/messaging';
import { checkpointItem, showLauncherItem } from '../../lib/storage';
import { normalizeOdooUrl } from '../../lib/origin';

/** Host access that lets the agent act on every site. */
const ALL_SITES = { origins: ['<all_urls>'] };

/**
 * Options page: a status header and the three setup steps (the Odoo address
 * with its host permission, pairing, access to all sites with the launcher
 * preference), the first open step highlighted. Every permission request runs
 * from a button click, as Chrome requires a user gesture.
 */
export function Options() {
    const [status, setStatus] = useState<Status | null>(null);
    const [allSites, setAllSites] = useState(false);
    const [showLauncher, setShowLauncher] = useState(true);
    const [url, setUrl] = useState('');
    const [message, setMessage] = useState('');

    const refresh = useCallback(async () => {
        const next = (await browser.runtime.sendMessage({
            type: 'options/status',
        })) as Status;
        setStatus(next);
        setUrl((current) => current || next.odooUrl || '');
        setAllSites(await browser.permissions.contains(ALL_SITES));
        setShowLauncher(await showLauncherItem.getValue());
    }, []);

    useEffect(() => {
        void refresh();
        const unwatch = checkpointItem.watch(() => void refresh());
        browser.permissions.onAdded.addListener(refresh);
        browser.permissions.onRemoved.addListener(refresh);
        return () => {
            unwatch();
            browser.permissions.onAdded.removeListener(refresh);
            browser.permissions.onRemoved.removeListener(refresh);
        };
    }, [refresh]);

    const save = async () => {
        const origin = normalizeOdooUrl(url);
        if (!origin) {
            setMessage('Enter an https:// address (http:// only for localhost).');
            return;
        }
        if (!(await browser.permissions.request({ origins: [`${origin}/*`] }))) {
            setMessage(`Access to ${origin} is needed to talk to your Odoo.`);
            return;
        }
        const reply = (await browser.runtime.sendMessage({
            type: 'options/set-url',
            url: origin,
        })) as Status | { ok: false; error: string };
        setMessage('error' in reply && 'ok' in reply ? reply.error : '');
        setUrl(origin);
        await refresh();
    };

    const toggleAllSites = async () => {
        await (allSites
            ? browser.permissions.remove(ALL_SITES)
            : browser.permissions.request(ALL_SITES));
        await refresh();
    };

    if (!status) {
        return null;
    }
    const done = [Boolean(status.odooUrl), status.paired, allSites];
    const current = done.indexOf(false);
    const host = status.odooUrl ? new URL(status.odooUrl).host : null;

    return (
        <main className="mk-options">
            <header className="mk-header">
                <img className="mk-header__icon" src="/icon/128.png" alt="" />
                <div className="mk-header__text">
                    <h1>MuK AI Browser</h1>
                    <p>Your Odoo AI assistant, reading and acting in this browser.</p>
                </div>
                <p className={status.paired ? 'mk-state mk-state--ok' : 'mk-state'}>
                    {status.paired ? `${status.userName} on ${host}` : 'Not connected'}
                </p>
            </header>

            <Step
                number={1}
                title="Odoo address"
                done={done[0]}
                current={current === 0}
            >
                <p>The address of your Odoo with the MuK AI Browser app.</p>
                <div className="mk-row">
                    <input
                        type="url"
                        aria-label="Odoo URL"
                        placeholder="https://mycompany.odoo.com"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                    />
                    <button type="button" onClick={() => void save()}>
                        Save
                    </button>
                </div>
                {message && <p className="mk-message">{message}</p>}
            </Step>

            <Step number={2} title="Connect" done={done[1]} current={current === 1}>
                <p>
                    {status.paired
                        ? 'This browser is paired with your Odoo user.'
                        : 'Opens a page in your Odoo that pairs this browser with your user.'}
                </p>
                {status.error && <p className="mk-message">{status.error}</p>}
                {status.paired ? (
                    <button
                        type="button"
                        className="mk-secondary"
                        onClick={() =>
                            void browser.runtime
                                .sendMessage({ type: 'options/disconnect' })
                                .then(refresh)
                        }
                    >
                        Disconnect
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={!status.odooUrl}
                        onClick={() =>
                            void browser.runtime
                                .sendMessage({ type: 'options/connect' })
                                .then(refresh)
                        }
                    >
                        Connect
                    </button>
                )}
            </Step>

            <Step
                number={3}
                title="Allow on all sites"
                done={done[2]}
                current={current === 2}
            >
                <p>
                    Lets the agent read and act on any page you work on. Without it, the
                    agent only acts on a tab after you click the MuK AI toolbar button
                    on it.
                </p>
                <button
                    type="button"
                    className={allSites ? 'mk-secondary' : ''}
                    onClick={() => void toggleAllSites()}
                >
                    {allSites ? 'Remove access to all sites' : 'Allow on all sites'}
                </button>
                <label className="mk-switch">
                    <span className="mk-switch__text">
                        <strong>Show the MuK AI tab on pages</strong>
                        <small>
                            A tab on the right edge of each page opens the side panel.
                        </small>
                    </span>
                    <input
                        type="checkbox"
                        role="switch"
                        checked={showLauncher}
                        disabled={!allSites}
                        onChange={(event) => {
                            setShowLauncher(event.target.checked);
                            void showLauncherItem.setValue(event.target.checked);
                        }}
                    />
                </label>
            </Step>
        </main>
    );
}

/**
 * One numbered setup step.
 *
 * @param props - Number, title, whether it is done or the current step, content.
 * @returns The step section.
 */
function Step({
    number,
    title,
    done,
    current,
    children,
}: {
    number: number;
    title: string;
    done: boolean;
    current: boolean;
    children: ReactNode;
}) {
    return (
        <section
            className={`mk-step${current ? ' mk-step--current' : ''}`}
            aria-current={current ? 'step' : undefined}
        >
            <span className={`mk-step__badge${done ? ' mk-step__badge--done' : ''}`}>
                {done ? '✓' : number}
            </span>
            <div className="mk-step__body">
                <h2>{title}</h2>
                {children}
            </div>
        </section>
    );
}
