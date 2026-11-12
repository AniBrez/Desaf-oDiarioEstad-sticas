import { useEffect } from 'react';
import { Dot, Segmented } from './components/ui';
import { PERIODS, playerColor, useApp, type Period } from './data/store';
import { href, navigate, useRoute, useTheme, type ThemeChoice } from './util/hooks';
import { CountriesView } from './views/CountriesView';
import { DataView } from './views/DataView';
import { ExploredView } from './views/ExploredView';
import { LeaderboardView } from './views/LeaderboardView';
import { OddsMapView } from './views/OddsMapView';
import { OverviewView } from './views/OverviewView';
import { TrendsView } from './views/TrendsView';

const TABS: { path: string; label: string }[] = [
  { path: 'overview', label: 'Overview' },
  { path: 'trends', label: 'Learning curve' },
  { path: 'countries', label: 'Countries' },
  { path: 'map', label: 'Odds map' },
  { path: 'explored', label: 'Explored' },
  { path: 'leaderboard', label: 'Leaderboard' },
  { path: 'data', label: 'Data & friends' },
];

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  return (
    <Segmented<ThemeChoice>
      label="Colour theme"
      value={theme}
      onChange={setTheme}
      options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
    />
  );
}

function FilterBar() {
  const app = useApp();
  const everyone = app.bundle.series;
  if (everyone.length === 0) return null;
  const focusId = app.settings.focusId;
  const comparedIds = new Set(app.compare.map((s) => s.player.id));
  const others = everyone.filter((s) => s.player.id !== focusId);
  return (
    <div className="filters">
      <div className="filter">
        <span className="filter-label">Period</span>
        <Segmented<Period> label="Period" value={app.settings.period} onChange={app.setPeriod} options={PERIODS.map((p) => ({ value: p.key, label: p.label }))} />
      </div>
      <div className="filter">
        <label htmlFor="focus-player">Player</label>
        <select id="focus-player" className="select" value={focusId ?? ''} onChange={(e) => app.setFocus(e.target.value)}>
          {everyone.map((s) => <option key={s.player.id} value={s.player.id}>{s.player.nick}</option>)}
        </select>
      </div>
      {others.length > 0 && (
        <div className="filter">
          <span className="filter-label">Compare with</span>
          <div className="chips">
            {others.map((s) => (
              <button key={s.player.id} type="button" className="chip" aria-pressed={comparedIds.has(s.player.id)} onClick={() => app.toggleCompare(s.player.id)}>
                <Dot color={playerColor(s.player)} />
                {s.player.nick}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Welcome() {
  const app = useApp();
  return (
    <section className="card">
      <div className="empty" style={{ paddingBottom: 20 }}>
        <strong>See how your Daily Challenge is really going</strong>
        <p style={{ maxWidth: '62ch', margin: '0 auto 16px' }}>
          Bring in your GeoGuessr Daily Challenge history to chart your scores, fit your learning curve, map where
          you are most likely to score well, see how much of the world you have been dropped in, and compare it all with friends.
        </p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <a className="btn primary" href={href('data')}>Get my data</a>
          <button type="button" className="btn" disabled={!app.geo} onClick={() => { app.loadDemo(); navigate('overview'); }}>
            {app.geo ? 'Explore with demo data' : 'Loading map data…'}
          </button>
        </div>
      </div>
    </section>
  );
}

export function App() {
  const app = useApp();
  const route = useRoute();
  const hasData = app.bundle.series.length > 0;
  const tab = TABS.some((t) => t.path === route.path) ? route.path : 'overview';
  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  let view;
  if (tab === 'data') view = <DataView />;
  else if (!app.ready) view = <div className="empty">Loading…</div>;
  else if (!hasData || !app.focus) view = <Welcome />;
  else if (tab === 'trends') view = <TrendsView />;
  else if (tab === 'countries') view = <CountriesView country={route.params.get('country')} />;
  else if (tab === 'map') view = <OddsMapView />;
  else if (tab === 'explored') view = <ExploredView />;
  else if (tab === 'leaderboard') view = <LeaderboardView />;
  else view = <OverviewView />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Desafío Diario</h1>
          <span>Daily Challenge statistics</span>
        </div>
        <ThemeToggle />
      </header>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <a key={t.path} className="tab" href={href(t.path)} aria-current={t.path === tab ? 'page' : undefined}>{t.label}</a>
        ))}
      </nav>
      {tab !== 'data' ? <FilterBar /> : <div style={{ height: 18 }} />}
      <main>
        {app.hasDemo && tab !== 'data' && (
          <div className="demo-banner" role="note">
            <span><strong>Demo data.</strong> These players are made up so you can try everything out.</span>
            <a href={href('data')}>Bring in your own</a>
          </div>
        )}
        {app.geoError && <div className="message error" style={{ marginBottom: 16 }}><span className="icon">!</span><span>Map data could not be loaded ({app.geoError}). Charts still work; maps and region statistics need a reload.</span></div>}
        {view}
      </main>
      <footer className="footer">
        <p>
          Unofficial fan project, not affiliated with or endorsed by GeoGuessr. Your data stays in this browser.
          {app.geo && <> Street View coverage: <a href="https://geo.emily.bz/coverage-dates" target="_blank" rel="noreferrer">coverage date maps by emily</a> ({app.geo.meta.points.toLocaleString('en-US')} locations, newest imagery {app.geo.meta.newestCapture}). Boundaries: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">Natural Earth</a>.</>}
        </p>
      </footer>
    </div>
  );
}
