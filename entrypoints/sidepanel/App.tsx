import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { type Status, frameMessage } from '../../lib/messaging';
import { PanelClient } from './client';

/** How often the login is checked again while the panel asks to log in. */
const LOGIN_RECHECK_MS = 3_000;

/** First and longest wait before checking an unreachable Odoo again. */
const UNREACHABLE_RECHECK_MS = [2_000, 30_000];

/** How long a loaded frame may stay silent before the Odoo is checked again. */
const SILENT_FRAME_MS = 3_000;

/** How long the chat may take to open before the panel offers a retry. */
const SLOW_FRAME_MS = 45_000;

/** What the service worker's login check found. */
type Access = 'unknown' | 'in' | 'out' | 'unreachable';

/**
 * Side panel. Before pairing it offers the options page, Connect and a field
 * for a pasted pairing code; once paired it embeds the muk_ai chat of the
 * paired Odoo below a bar naming the tab the agent acts in.
 */
export function App() {
    const [status, setStatus] = useState<Status | null>(null);
    const client = useMemo(() => new PanelClient(), []);

    useEffect(() => {
        client.open((msg) => setStatus(msg.status));
        return () => client.close();
    }, [client]);

    return (
        <div className="mk-panel">
            {status && !status.odooUrl && <SetupCta />}
            {status?.odooUrl && !status.paired && (
                <ConnectCta
                    connecting={status.connecting}
                    error={status.error}
                    onConnect={() => client.send({ type: 'panel/connect' })}
                    onCode={(code) => client.send({ type: 'panel/pair', code })}
                />
            )}
            {status?.paired && status.odooUrl && (
                <OdooChat status={status} odooUrl={status.odooUrl} client={client} />
            )}
        </div>
    );
}

/**
 * The paired Odoo's chat in a frame. The service worker checks the Odoo
 * first, and again when a loaded frame stays silent: logged out shows a login
 * card, unreachable a notice; both keep checking and open the chat as soon as
 * Odoo answers with a user. Otherwise the frame loads behind a loading state
 * until it reports the chat it opens, which this device then attaches to.
 * While the chat shows, the worker's polling watches Odoo: unreachable covers
 * the frame, and the frame reloads once Odoo answers again.
 *
 * @param props - The status, the Odoo origin and the worker client.
 * @returns The agent bar and the frame.
 */
function OdooChat({
    status,
    odooUrl,
    client,
}: {
    status: Status;
    odooUrl: string;
    client: PanelClient;
}) {
    const chatUrl = () => `${odooUrl}/odoo/ai-chat/${status.chatId ?? ''}`;
    const [src, setSrc] = useState(chatUrl);
    const [attempt, setAttempt] = useState(0);
    const [loads, setLoads] = useState(0);
    const [access, setAccess] = useState<Access>('unknown');
    const [reported, setReported] = useState(false);
    const [slow, setSlow] = useState(false);
    const frame = useRef<HTMLIFrameElement>(null);
    const wasDown = useRef(false);
    const down = status.link === 'unreachable';

    useEffect(() => {
        if (reported) {
            return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancelled = false;
        let backoff = UNREACHABLE_RECHECK_MS[0];
        const check = async () => {
            const answer = (await browser.runtime.sendMessage({
                type: 'panel/logged-in',
            })) as boolean | null;
            if (cancelled) {
                return;
            }
            if (answer === true) {
                setAccess('in');
                return;
            }
            setAccess(answer === false ? 'out' : 'unreachable');
            const delay = answer === false ? LOGIN_RECHECK_MS : backoff;
            backoff = Math.min(backoff * 2, UNREACHABLE_RECHECK_MS[1]);
            timer = setTimeout(() => void check(), delay);
        };
        timer = setTimeout(() => void check(), loads ? SILENT_FRAME_MS : 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [attempt, loads, reported]);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const message = frameMessage(event, odooUrl, frame.current?.contentWindow);
            if (message?.type === 'show') {
                client.send({ type: 'panel/show', path: message.path });
            } else if (message) {
                setReported(true);
                if (message.id != null) {
                    client.send({ type: 'panel/attach', chatId: message.id });
                }
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [client, odooUrl]);

    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                client.announce();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [client]);

    const blocked = !reported && (access === 'out' || access === 'unreachable');
    const view =
        down || (blocked && access === 'unreachable')
            ? 'unreachable'
            : blocked
              ? 'login'
              : reported
                ? 'chat'
                : 'loading';

    useEffect(() => {
        if (reported || blocked) {
            return;
        }
        setSlow(false);
        const timer = setTimeout(() => setSlow(true), SLOW_FRAME_MS);
        return () => clearTimeout(timer);
    }, [reported, blocked, attempt]);

    const retry = () => {
        setReported(false);
        setLoads(0);
        setSrc(chatUrl());
        setAttempt((value) => value + 1);
    };

    useEffect(() => {
        if (down) {
            wasDown.current = true;
        } else if (wasDown.current) {
            wasDown.current = false;
            retry();
        }
    }, [down]);

    return (
        <>
            <AgentBar
                status={status}
                onFocus={() => client.send({ type: 'panel/focus-tab' })}
            />
            <div className="mk-stage">
                {!blocked && (
                    <iframe
                        key={attempt}
                        ref={frame}
                        className="mk-frame"
                        title="MuK AI chat"
                        src={src}
                        allow="microphone; clipboard-write"
                        onLoad={() => setLoads((value) => value + 1)}
                    />
                )}
                {view === 'login' && (
                    <div className="mk-overlay">
                        <div className="mk-cta">
                            <SparkIcon />
                            <p className="mk-cta__title">Log in to Odoo</p>
                            <p className="mk-cta__sub">
                                Log in to your Odoo in a tab. The chat opens here once
                                you are logged in.
                            </p>
                            <div className="mk-cta__actions">
                                <button
                                    type="button"
                                    className="mk-btn mk-btn--primary"
                                    onClick={() =>
                                        void browser.tabs.create({
                                            url: `${odooUrl}/web/login`,
                                        })
                                    }
                                >
                                    Log in to Odoo
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                {view === 'unreachable' && (
                    <div className="mk-overlay mk-loading" role="status">
                        <SparkIcon />
                        <p className="mk-cta__title">Odoo is not reachable</p>
                        <p>
                            The chat opens as soon as {new URL(odooUrl).host} answers.
                        </p>
                    </div>
                )}
                {view === 'loading' && (
                    <div className="mk-overlay mk-loading" role="status">
                        <SparkIcon />
                        <p>Opening your chat...</p>
                        {slow && (
                            <p>
                                Still loading...{' '}
                                <button
                                    type="button"
                                    className="mk-link"
                                    onClick={retry}
                                >
                                    Retry
                                </button>
                            </p>
                        )}
                    </div>
                )}
            </div>
        </>
    );
}

/**
 * One-line bar naming the site of the agent's tab, with a pulsing dot while
 * the agent works; a click focuses that tab.
 *
 * @param props - The status and the focus handler.
 * @returns The bar.
 */
function AgentBar({ status, onFocus }: { status: Status; onFocus: () => void }) {
    const tab = status.agentTab;
    const error = status.link === 'offline' ? status.error : null;
    return (
        <button
            type="button"
            className="mk-agentbar"
            title={tab ? `${tab.title}\n${tab.url}` : undefined}
            disabled={!tab}
            onClick={onFocus}
        >
            {tab?.favIconUrl ? <img src={tab.favIconUrl} alt="" /> : <SparkIcon />}
            <span className="mk-agentbar__text">
                {error ? (
                    <span className="mk-agentbar__error">{error}</span>
                ) : tab ? (
                    <>
                        Acting in <b>{hostOf(tab.url)}</b>
                        {status.groupTabs > 1 && ` · ${status.groupTabs} tabs`}
                    </>
                ) : (
                    'Open a web page for the agent to act in'
                )}
            </span>
            {status.working && (
                <span className="mk-agentbar__dot" aria-label="Agent working" />
            )}
        </button>
    );
}

// ----------------------------------------------------------
// Onboarding
// ----------------------------------------------------------

/** Shown before an Odoo URL is configured. */
function SetupCta() {
    return (
        <div className="mk-cta">
            <SparkIcon />
            <p className="mk-cta__title">Set up MuK AI Browser</p>
            <p className="mk-cta__sub">
                Enter the address of your Odoo in the extension options.
            </p>
            <div className="mk-cta__actions">
                <button
                    type="button"
                    className="mk-btn mk-btn--primary"
                    onClick={() => void browser.runtime.openOptionsPage()}
                >
                    Open options
                </button>
            </div>
        </div>
    );
}

/**
 * Shown before pairing: open the Odoo connect page, or paste its code. While
 * the page is open, it says to log in there; the panel pairs by itself.
 *
 * @param props - Whether the page is open, the last error and the two actions.
 * @returns The call to action.
 */
function ConnectCta({
    connecting,
    error,
    onConnect,
    onCode,
}: {
    connecting: boolean;
    error: string | null;
    onConnect: () => void;
    onCode: (code: string) => void;
}) {
    const [code, setCode] = useState('');
    return (
        <div className="mk-cta">
            <SparkIcon />
            <p className="mk-cta__title">
                {connecting ? 'Log in to Odoo in the new tab' : 'Connect to your Odoo'}
            </p>
            <p className="mk-cta__sub">
                {connecting
                    ? 'This panel continues by itself once you are logged in, and the tab closes.'
                    : 'Connecting opens a page in Odoo that pairs this browser with your user.'}
            </p>
            {connecting ? (
                <p className="mk-cta__wait" role="status">
                    <span className="mk-spinner" aria-hidden="true" />
                    Waiting for the login
                </p>
            ) : (
                <div className="mk-cta__actions">
                    <button
                        type="button"
                        className="mk-btn mk-btn--primary"
                        onClick={onConnect}
                    >
                        Connect
                    </button>
                </div>
            )}
            <form
                className="mk-pair"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (code.trim()) {
                        onCode(code.trim());
                    }
                }}
            >
                <input
                    type="text"
                    value={code}
                    aria-label="Pairing code"
                    placeholder="Pairing code"
                    onChange={(event) => setCode(event.target.value)}
                />
                <button
                    type="submit"
                    className="mk-btn mk-btn--ghost"
                    disabled={!code.trim()}
                >
                    Pair
                </button>
            </form>
            {error && <p className="mk-error">{error}</p>}
        </div>
    );
}

/**
 * Return the host name of a URL.
 *
 * @param url - The URL.
 * @returns Its host, or the URL itself when it does not parse.
 */
function hostOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

/** Brand spark glyph. */
function SparkIcon() {
    return (
        <svg viewBox="0 0 24 24" className="mk-icon" aria-hidden="true">
            <path
                d="M12 2l1.9 4.6L18.5 8.5 13.9 10.4 12 15l-1.9-4.6L5.5 8.5l4.6-1.9L12 2z"
                fill="currentColor"
            />
            <circle cx="18.5" cy="17.5" r="2.3" fill="currentColor" opacity="0.85" />
        </svg>
    );
}
