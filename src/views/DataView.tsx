import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, Dot } from '../components/ui';
import { parseExport, toExport, type MergeSummary } from '../data/dataset';
import { playerColor, useApp } from '../data/store';
import type { ExportFile } from '../data/types';
import { fmtDate, fmtInt, plural } from '../util/format';
import { navigate, useRoute } from '../util/hooks';

const READY = 'desafio-diario:ready';
const EXPORT = 'desafio-diario:export';
const RECEIVED = 'desafio-diario:received';

/** Windows allowed to hand data to the app: GeoGuessr itself, and a local mock while developing. */
function trustedOrigin(origin: string): boolean {
  if (origin === 'https://www.geoguessr.com' || origin === 'https://geoguessr.com') return true;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  return local.test(origin) && local.test(window.location.origin);
}

interface Notice { kind: 'ok' | 'error' | 'info'; text: string }

function describe(summary: MergeSummary): string {
  if (summary.newChallenges === 0 && summary.newResults === 0) return `Nothing new in ${summary.owner.nick}'s file: everything in it was already here.`;
  const parts = [
    summary.newChallenges ? plural(summary.newChallenges, 'new challenge') : null,
    summary.newResults ? plural(summary.newResults, 'new result') : null,
    summary.newPlayers ? plural(summary.newPlayers, 'new player') : null,
  ].filter(Boolean);
  return `Imported ${summary.owner.nick}'s data: ${parts.join(', ')}.`;
}

function download(name: string, file: ExportFile): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function DataView() {
  const app = useApp();
  const route = useRoute();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [incoming, setIncoming] = useState<{ file: ExportFile; origin: string } | null>(null);
  const [over, setOver] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const bookmarkRef = useRef<HTMLAnchorElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const appUrl = `${window.location.origin}${window.location.pathname}`;
  const note = useCallback((n: Notice) => setNotices((list) => [n, ...list].slice(0, 4)), []);

  const importFile = useCallback((file: ExportFile) => {
    // Real data replaces the demo players rather than mixing with them.
    if (file.source !== 'demo' && app.hasDemo) app.removeDemo();
    const summary = app.importFile(file);
    note({ kind: 'ok', text: describe(summary) });
  }, [app, note]);

  // ---- The collector script ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}collector.js`)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => { if (!cancelled) setScript(text); })
      .catch(() => { if (!cancelled) setScript(''); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // React refuses javascript: URLs in JSX, rightly; a bookmarklet is the one place we want one.
    const loader = `javascript:(function(){window.__DESAFIO_DIARIO_APP__=${JSON.stringify(appUrl)};var s=document.createElement('script');s.src=${JSON.stringify(`${appUrl}collector.js`)}+'?t='+Date.now();s.onerror=function(){alert('The Desafío Diario collector could not be loaded from '+${JSON.stringify(appUrl)})};document.documentElement.appendChild(s);})();`;
    bookmarkRef.current?.setAttribute('href', loader);
  }, [appUrl]);

  const copyScript = async () => {
    if (!script) return;
    const text = `window.__DESAFIO_DIARIO_APP__ = ${JSON.stringify(appUrl)};\n${script}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      note({ kind: 'error', text: 'The browser did not allow copying. Open collector.js from this site and copy its contents instead.' });
    }
  };

  // ---- Data arriving from the GeoGuessr tab --------------------------------------------------
  const receiving = route.params.get('receive') === '1';
  useEffect(() => {
    if (!receiving) return;
    const opener = window.opener as Window | null;
    const onMessage = (event: MessageEvent) => {
      if (!trustedOrigin(event.origin) || typeof event.data !== 'object' || event.data === null) return;
      const data = event.data as { type?: unknown; file?: unknown };
      if (data.type !== EXPORT) return;
      try {
        setIncoming({ file: parseExport(data.file), origin: event.origin });
        (event.source as Window | null)?.postMessage({ type: RECEIVED }, event.origin);
      } catch (err) {
        note({ kind: 'error', text: err instanceof Error ? err.message : 'The data that arrived could not be read.' });
      }
    };
    window.addEventListener('message', onMessage);
    // Tell the collector we are listening. No data in this message, so any origin may see it.
    opener?.postMessage({ type: READY }, '*');
    return () => window.removeEventListener('message', onMessage);
  }, [receiving, note]);

  // ---- Files ---------------------------------------------------------------------------------
  const readFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        importFile(parseExport(JSON.parse(await file.text())));
      } catch (err) {
        const reason = err instanceof SyntaxError ? 'it is not valid JSON' : err instanceof Error ? err.message : 'it could not be read';
        note({ kind: 'error', text: `${file.name}: ${reason}` });
      }
    }
  };

  const players = Object.values(app.dataset.players).sort((a, b) => a.slot - b.slot);
  const focusId = app.settings.focusId;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {notices.map((n, i) => (
        <div key={`${i}-${n.text}`} className={`message ${n.kind === 'info' ? '' : n.kind}`} role={n.kind === 'error' ? 'alert' : 'status'}>
          <span className="icon" aria-hidden="true">{n.kind === 'ok' ? '✓' : n.kind === 'error' ? '!' : 'i'}</span>
          <span>{n.text}</span>
        </div>
      ))}

      {incoming && (
        <Card title={`Data received for ${incoming.file.owner.nick}`} subtitle={`${plural(incoming.file.challenges.length, 'daily challenge')} and ${plural(incoming.file.players.length, 'player')}, sent from ${new URL(incoming.origin).hostname}.`}>
          <div className="row">
            <button type="button" className="btn primary" onClick={() => { importFile(incoming.file); setIncoming(null); navigate('overview'); }}>Import</button>
            <button type="button" className="btn" onClick={() => setIncoming(null)}>Discard</button>
          </div>
        </Card>
      )}
      {receiving && !incoming && notices.length === 0 && (
        <div className="message" role="status"><span className="icon" aria-hidden="true">…</span><span>Waiting for the data from your GeoGuessr tab. If nothing arrives, download the file there and drop it below.</span></div>
      )}

      <Card title="Get your Daily Challenge history" subtitle="GeoGuessr has no export button, so a small script reads your history from inside your own signed-in GeoGuessr tab. Nothing is installed, and your login never leaves that tab.">
        <ol className="steps">
          <li>
            <div>
              <h3>Open GeoGuessr and sign in</h3>
              <p>In this browser, on a computer: <a href="https://www.geoguessr.com/" target="_blank" rel="noreferrer">geoguessr.com</a>.</p>
            </div>
          </li>
          <li>
            <div>
              <h3>Run the collector there</h3>
              <p style={{ marginBottom: 8 }}>
                Either drag this button to your bookmarks bar and click it while on GeoGuessr, or copy the script and paste it into the browser console on GeoGuessr
                (press F12, choose "Console", paste, Enter; Chrome asks you to type "allow pasting" the first time).
              </p>
              <div className="row">
                <a ref={bookmarkRef} className="bookmarklet" href="#/data" onClick={(e) => { e.preventDefault(); note({ kind: 'info', text: 'Drag that button to your bookmarks bar, then click the bookmark while you are on geoguessr.com.' }); }} title="Drag me to the bookmarks bar">
                  ⇪ Desafío Diario collector
                </a>
                <button type="button" className="btn" disabled={!script} onClick={copyScript}>{copied ? 'Copied ✓' : 'Copy script'}</button>
                <a className="btn quiet" href={`${import.meta.env.BASE_URL}collector.js`} target="_blank" rel="noreferrer">Read the script</a>
              </div>
              {script === '' && <p className="note" style={{ marginTop: 8 }}>The collector script is missing from this build (run <code className="inline">npm run build:collector</code>).</p>}
            </div>
          </li>
          <li>
            <div>
              <h3>Send the result here</h3>
              <p>
                A panel in the corner shows progress: a first run takes a few minutes for a long history (roughly two requests per game); later runs only fetch what is new.
                When it finishes, choose "Open in Desafío Diario" to bring the data straight here, or download the file and drop it below.
              </p>
            </div>
          </li>
        </ol>
        <details className="explain">
          <summary>What the script does, exactly</summary>
          <ul>
            <li>It only sends read requests to GeoGuessr, the same ones the site itself makes: your profile, your activity feed (to find which challenges were Daily Challenges), the Daily Challenge calendar, and the results of each of those challenges. It cannot start games or change anything on your account.</li>
            <li>For each challenge it keeps the five locations and, per player, the five guesses with score, distance and time.</li>
            <li>Your GeoGuessr friends' results on the challenges you played come along, which is what the leaderboard uses. Days they played and you did not are only in their own export.</li>
            <li>It paces itself (about seven requests a second at most) and backs off if GeoGuessr asks it to.</li>
            <li>The data goes nowhere except this browser tab (or the file you download). This site has no server and stores everything in your browser.</li>
            <li>GeoGuessr's internal interface is not a public API and can change; if the collector stops working, the script will say what failed.</li>
          </ul>
        </details>
      </Card>

      <Card title="Add a file" subtitle="Your own export, or one a friend sent you. Files merge: importing the same thing twice is harmless.">
        <div
          className={`dropzone${over ? ' over' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void readFiles(e.dataTransfer.files); }}
        >
          <strong>Drop export files here</strong>
          <span>or click to choose (.json)</span>
          <input ref={fileRef} type="file" accept="application/json,.json" multiple hidden onChange={(e) => { if (e.target.files) void readFiles(e.target.files); e.target.value = ''; }} />
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          To compare with someone who is not your GeoGuessr friend, or to see the days they played without you, ask them to run the collector on their own account and send you the downloaded file.
        </p>
      </Card>

      <Card
        title="Players"
        subtitle={players.length ? 'Each player keeps their colour everywhere. Choose whose statistics to look at with "View".' : 'Nobody yet.'}
        actions={(
          <>
            {app.hasDemo
              ? <button type="button" className="btn small" onClick={() => { app.removeDemo(); note({ kind: 'ok', text: 'Demo players removed.' }); }}>Remove demo players</button>
              : <button type="button" className="btn small" disabled={!app.geo} onClick={() => { app.loadDemo(); note({ kind: 'ok', text: 'Four demo players added. Have a look around.' }); }}>Add demo players</button>}
          </>
        )}
      >
        {players.map((p) => {
          const series = app.bundle.byId.get(p.id);
          const days = series?.days ?? [];
          return (
            <div className="player-row" key={p.id}>
              <span className="who"><Dot color={playerColor(p)} />{p.nick}{p.demo && <span className="tag">demo</span>}{p.id === focusId && <span className="tag">viewing</span>}</span>
              <span className="meta">{days.length ? `${plural(days.length, 'game')} · ${fmtDate(days[0].t)} – ${fmtDate(days[days.length - 1].t)}` : 'no finished games'}</span>
              <span className="row">
                <button type="button" className="btn small" disabled={!days.length} onClick={() => { app.setFocus(p.id); navigate('overview'); }}>View</button>
                <button type="button" className="btn small danger" onClick={() => { if (window.confirm(`Remove ${p.nick} and their results from this browser?`)) app.removePlayer(p.id); }}>Remove</button>
              </span>
            </div>
          );
        })}
      </Card>

      <Card title="Backup" subtitle={`Everything lives in this browser's storage${players.length ? `: ${fmtInt(Object.keys(app.dataset.challenges).length)} challenges` : ''}. Clearing site data or switching browser loses it, so keep a file.`}>
        <div className="row">
          <button type="button" className="btn" disabled={!players.length} onClick={() => download(`desafio-diario-backup-${new Date().toISOString().slice(0, 10)}.json`, toExport(app.dataset, focusId ?? players[0]?.id ?? ''))}>Download everything</button>
          <button type="button" className="btn danger" disabled={!players.length} onClick={() => { if (window.confirm('Delete all players and results from this browser? This cannot be undone.')) { app.clearAll(); note({ kind: 'ok', text: 'Everything was deleted.' }); } }}>Delete everything</button>
        </div>
      </Card>
    </div>
  );
}
