/**
 * The collector as the player sees it: a small panel in the corner of geoguessr.com that shows
 * progress and, when done, hands the data to the app (new tab) or saves it as a file.
 *
 * Everything runs in the player's own tab with their existing session. Nothing is sent anywhere
 * except to GeoGuessr (read-only requests) and, on request, to the app the script came from.
 */
import type { ExportFile } from '../data/types';
import { collect, CollectorError, type CollectorCache, type CollectorIO, type CollectorProgress, type CollectorResult } from './core';

declare global {
  interface Window {
    /** URL of the app that issued this script; set by the snippet the app hands out. */
    __DESAFIO_DIARIO_APP__?: string;
  }
}

const HOST_ID = 'desafio-diario-collector';
const READY = 'desafio-diario:ready';
const EXPORT = 'desafio-diario:export';
const RECEIVED = 'desafio-diario:received';

// ---------------------------------------------------------------------------------------------
// Cache (IndexedDB on geoguessr.com), so later runs only fetch what is new
// ---------------------------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('desafio-diario', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCache(): Promise<CollectorCache | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const request = db.transaction('kv', 'readonly').objectStore('kv').get('cache');
      request.onsuccess = () => resolve((request.result as CollectorCache | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeCache(cache: CollectorCache): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(cache, 'cache');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* the cache is an optimisation; carry on without it */
  }
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const io: CollectorIO = {
  async get(path) {
    const res = await fetch(path, { credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    const text = await res.text();
    let data: unknown = null;
    if (text.trim()) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    return { status: res.status, data, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------------------------

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: min(360px, calc(100vw - 32px));
  box-sizing: border-box; padding: 16px; border-radius: 12px;
  background: #1a1a19; color: #f0efec; border: 1px solid rgba(255,255,255,.14);
  box-shadow: 0 12px 40px rgba(0,0,0,.45);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.title { font-weight: 600; font-size: 15px; }
.close { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 6px; color: #c3c2b7; font-size: 18px; line-height: 1; }
.close:hover, .close:focus-visible { background: rgba(255,255,255,.1); color: #fff; }
.status { margin: 0 0 10px; color: #c3c2b7; min-height: 2.9em; }
.status strong { color: #f0efec; font-weight: 600; }
.track { height: 6px; border-radius: 3px; background: #2c2c2a; overflow: hidden; margin-bottom: 12px; }
.bar { height: 100%; width: 0; border-radius: 3px; background: #3987e5; transition: width .2s ease; }
.bar.busy { width: 35%; animation: slide 1.2s ease-in-out infinite alternate; }
@keyframes slide { from { margin-left: 0; } to { margin-left: 65%; } }
@media (prefers-reduced-motion: reduce) { .bar.busy { animation: none; } .bar { transition: none; } }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button.action {
  all: unset; cursor: pointer; box-sizing: border-box; padding: 8px 12px; border-radius: 8px; font-weight: 600; font-size: 13px;
  background: #2c2c2a; color: #f0efec; border: 1px solid rgba(255,255,255,.14);
}
button.action.primary { background: #3987e5; border-color: #3987e5; color: #fff; }
button.action:hover { filter: brightness(1.12); }
button.action:focus-visible, .close:focus-visible { outline: 2px solid #86b6ef; outline-offset: 2px; }
.note { margin: 10px 0 0; font-size: 12px; color: #898781; }
details { margin-top: 10px; font-size: 12px; color: #c3c2b7; }
summary { cursor: pointer; }
ul { margin: 6px 0 0; padding-left: 18px; }
.link { all: unset; cursor: pointer; text-decoration: underline; color: #c3c2b7; font-size: 12px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function runCollectorUi(): void {
  document.getElementById(HOST_ID)?.remove();
  const host = el('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = el('style');
  style.textContent = STYLE;
  const panel = el('section', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Desafío Diario collector');
  root.append(style, panel);
  document.documentElement.appendChild(host);

  const head = el('div', 'head');
  const title = el('div', 'title', 'Desafío Diario');
  const close = el('button', 'close', '×');
  close.setAttribute('aria-label', 'Close');
  head.append(title, close);
  const status = el('p', 'status');
  status.setAttribute('aria-live', 'polite');
  const track = el('div', 'track');
  const bar = el('div', 'bar busy');
  track.append(bar);
  const actions = el('div', 'actions');
  const note = el('p', 'note');
  const extra = el('div');
  panel.append(head, status, track, actions, note, extra);

  const signal = { aborted: false };
  let appWindow: Window | null = null;
  let onMessage: ((event: MessageEvent) => void) | null = null;
  const dispose = () => {
    signal.aborted = true;
    if (onMessage) window.removeEventListener('message', onMessage);
    host.remove();
  };
  close.addEventListener('click', dispose);

  const setStatus = (text: string, strong?: string) => {
    status.textContent = '';
    if (strong) status.append(el('strong', undefined, strong), document.createTextNode(' '));
    status.append(document.createTextNode(text));
  };
  const setProgress = (p: CollectorProgress) => {
    setStatus(p.total ? `${p.message} ${p.done ?? 0} of ${p.total}` : p.message);
    if (p.total) {
      bar.classList.remove('busy');
      bar.style.width = `${Math.round((100 * (p.done ?? 0)) / p.total)}%`;
    } else {
      bar.style.width = '';
      bar.classList.add('busy');
    }
  };
  const button = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = el('button', primary ? 'action primary' : 'action', label);
    b.addEventListener('click', onClick);
    return b;
  };

  const appUrl = (() => {
    try { return window.__DESAFIO_DIARIO_APP__ ? new URL(window.__DESAFIO_DIARIO_APP__) : null; } catch { return null; }
  })();

  const download = (file: ExportFile) => {
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    const nick = file.owner.nick.replace(/[^\w-]+/g, '_').slice(0, 40) || 'player';
    a.download = `desafio-diario-${nick}-${file.exportedAt.slice(0, 10)}.json`;
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const sendToApp = (file: ExportFile) => {
    if (!appUrl) return;
    const target = new URL(appUrl.toString());
    target.hash = '#/data?receive=1';
    if (onMessage) window.removeEventListener('message', onMessage);
    appWindow = window.open(target.toString(), 'desafio-diario-app');
    if (!appWindow) {
      note.textContent = 'Your browser blocked the new tab. Allow pop-ups for this site, or download the file and drop it into the app.';
      return;
    }
    note.textContent = 'Waiting for the app to open…';
    onMessage = (event: MessageEvent) => {
      if (event.origin !== target.origin || event.source !== appWindow || typeof event.data !== 'object' || event.data === null) return;
      const type = (event.data as { type?: unknown }).type;
      if (type === READY) {
        appWindow?.postMessage({ type: EXPORT, file }, target.origin);
        note.textContent = 'Sent. Confirm the import in the app tab.';
      } else if (type === RECEIVED) {
        note.textContent = 'Imported. You can close this panel.';
      }
    };
    window.addEventListener('message', onMessage);
  };

  const showResult = (result: CollectorResult) => {
    const { file, stats, warnings } = result;
    bar.classList.remove('busy');
    bar.style.width = '100%';
    setStatus(
      `${file.players.length} player${file.players.length === 1 ? '' : 's'} · ${stats.fetched} fetched, ${stats.reused} already saved.`,
      `${file.challenges.length} daily challenge${file.challenges.length === 1 ? '' : 's'} collected.`,
    );
    actions.textContent = '';
    if (appUrl) actions.append(button('Open in Desafío Diario', true, () => sendToApp(file)));
    actions.append(button('Download file', !appUrl, () => download(file)));
    note.textContent = appUrl ? '' : 'Drop the downloaded file into the app to see your statistics.';
    extra.textContent = '';
    if (warnings.length > 0) {
      const details = el('details');
      details.append(el('summary', undefined, `${warnings.length} note${warnings.length === 1 ? '' : 's'}`));
      const list = el('ul');
      for (const w of warnings) list.append(el('li', undefined, w));
      details.append(list);
      extra.append(details);
    }
    const again = el('button', 'link', 'Fetch everything again');
    again.addEventListener('click', () => { void start(true); });
    const wrap = el('p', 'note');
    wrap.append(again);
    extra.append(wrap);
  };

  const start = async (full: boolean) => {
    signal.aborted = false;
    actions.textContent = '';
    extra.textContent = '';
    note.textContent = 'Keep this tab open. Only read requests are made; nothing on your account changes.';
    actions.append(button('Stop', false, () => { signal.aborted = true; }));
    setProgress({ phase: 'account', message: 'Starting…' });
    try {
      const cache = full ? null : await readCache();
      const result = await collect(io, { cache, full, signal, onProgress: setProgress });
      await writeCache(result.cache);
      showResult(result);
    } catch (err) {
      bar.classList.remove('busy');
      bar.style.width = '0';
      actions.textContent = '';
      const aborted = err instanceof CollectorError && err.code === 'aborted';
      setStatus(aborted ? 'Nothing was saved.' : err instanceof Error ? err.message : String(err), aborted ? 'Stopped.' : 'Could not collect your data.');
      note.textContent = '';
      actions.append(button('Try again', true, () => { void start(full); }));
    }
  };

  if (!/(^|\.)geoguessr\.com$/.test(location.hostname) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    bar.classList.remove('busy');
    setStatus('Open geoguessr.com, sign in, and run this there.', 'This is not GeoGuessr.');
    return;
  }
  void start(false);
}
