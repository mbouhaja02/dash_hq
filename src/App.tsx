import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AnalysisRow,
  average,
  formatDate,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  supabaseClient,
} from './dashboard';
import { dashboardConfig } from './config';
import { generateHqReport } from './report';
import './styles.css';

type Tone = 'danger' | 'warning' | 'success' | 'primary';
type Priority = 'Haute' | 'Moyenne' | 'Faible';

interface StoreScore {
  store: string;
  audits: number;
  shelves: number;
  categories: number;
  conformity: number;
  emptyRatio: number;
  backRatio: number;
  critical: number;
  medium: number;
  issues: number;
  priority: Priority;
  score: number;
  lastAudit: string;
}

interface CategoryScore {
  category: string;
  audits: number;
  conformity: number;
  critical: number;
  emptySpaces: number;
  backProducts: number;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  issues: number;
  corrected: number;
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function dayKey(value: string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function shortDay(value: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(value));
}

function statusOf(row: AnalysisRow): string {
  if (row.status === 'Critique' || row.severity === 'high' || row.weighted_profitability_percent < 65) return 'Critique';
  if (row.status === 'Moyen' || row.weighted_profitability_percent < 85) return 'Moyen';
  return 'Bon';
}

function toneFromPriority(priority: Priority): Tone {
  if (priority === 'Haute') return 'danger';
  if (priority === 'Moyenne') return 'warning';
  return 'success';
}

function issueCount(rows: AnalysisRow[]): number {
  return rows.reduce((sum, row) => sum + row.empty_spaces + row.back_products, 0);
}

function buildStores(rows: AnalysisRow[]): StoreScore[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    buckets.set(row.store_name, [...(buckets.get(row.store_name) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([store, items]) => {
      const sorted = [...items].sort((a, b) => new Date(b.audit_date).getTime() - new Date(a.audit_date).getTime());
      const critical = items.filter((item) => statusOf(item) === 'Critique').length;
      const medium = items.filter((item) => statusOf(item) === 'Moyen').length;
      const conformity = average(items.map((item) => item.weighted_profitability_percent));
      const emptyRatio = average(items.map((item) => item.empty_ratio_percent));
      const backRatio = average(items.map((item) => item.back_ratio_percent));
      const issues = issueCount(items);
      const score = (100 - conformity) + emptyRatio * 1.5 + backRatio * 1.2 + critical * 8 + medium * 3;
      const priority: Priority = score >= 70 || critical >= 3 ? 'Haute' : score >= 35 || medium >= 3 ? 'Moyenne' : 'Faible';

      return {
        store,
        audits: items.length,
        shelves: new Set(items.map((item) => item.shelf_name)).size,
        categories: new Set(items.map((item) => item.category)).size,
        conformity,
        emptyRatio,
        backRatio,
        critical,
        medium,
        issues,
        priority,
        score,
        lastAudit: sorted[0]?.audit_date ?? new Date().toISOString(),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function buildCategories(rows: AnalysisRow[]): CategoryScore[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    buckets.set(row.category, [...(buckets.get(row.category) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([category, items]) => ({
      category,
      audits: items.length,
      conformity: average(items.map((item) => item.weighted_profitability_percent)),
      critical: items.filter((item) => statusOf(item) === 'Critique').length,
      emptySpaces: items.reduce((sum, item) => sum + item.empty_spaces, 0),
      backProducts: items.reduce((sum, item) => sum + item.back_products, 0),
    }))
    .sort((a, b) => a.conformity - b.conformity)
    .slice(0, 6);
}

function buildTimeline(rows: AnalysisRow[], maxPoints = 7): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxPoints)
    .map(([key, items], index, all) => {
      const issues = issueCount(items);
      const previous = index > 0 ? issueCount(all[index - 1][1]) : issues;

      return {
        label: shortDay(key),
        conformity: average(items.map((item) => item.weighted_profitability_percent)),
        issues,
        corrected: Math.max(0, previous - issues),
      };
    });
}

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const escape = (value: string | number) => {
    const text = String(value ?? '');
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers, ...rows].map((row) => row.map(escape).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

type Range = '7d' | '30d' | 'all';
const RANGE_DAYS: Record<Range, number> = { '7d': 7, '30d': 30, all: 36500 };
const RANGE_LABELS: Record<Range, string> = { '7d': '7 jours', '30d': '30 jours', all: 'Tout' };
const DEFAULT_EMPTY = 10;
const DEFAULT_BACK = 7;

function scopeByRange(rows: AnalysisRow[], range: Range): AnalysisRow[] {
  if (range === 'all') return rows;
  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  return rows.filter((row) => new Date(row.audit_date).getTime() >= cutoff);
}

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('range');
  return {
    range: (r === '7d' || r === '30d' || r === 'all' ? r : 'all') as Range,
    query: p.get('q') ?? '',
    emptyTh: Number(p.get('empty')) || DEFAULT_EMPTY,
    backTh: Number(p.get('back')) || DEFAULT_BACK,
  };
}

function buildQuery(range: Range, query: string, emptyTh: number, backTh: number): string {
  const p = new URLSearchParams();
  if (range !== 'all') p.set('range', range);
  if (query) p.set('q', query);
  if (emptyTh !== DEFAULT_EMPTY) p.set('empty', String(emptyTh));
  if (backTh !== DEFAULT_BACK) p.set('back', String(backTh));
  return p.toString();
}

export default function App() {
  const [rows, setRows] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function refresh(showLoading = false) {
    try {
      if (showLoading) setLoading(true);
      else setRefreshing(true);
      setError(null);
      const data = await loadAnalyses({
        storeName: dashboardConfig.storeName,
        category: dashboardConfig.category,
        limit: dashboardConfig.limit,
      });
      setRows(data);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement Supabase.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      setError('Variables Supabase manquantes.');
      return;
    }

    void refresh(true);

    const intervalId = window.setInterval(() => {
      void refresh();
    }, dashboardConfig.refreshMs);

    const channel = supabaseClient
      ?.channel('shelfguide-hq-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'shelfguide_analyses' },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      window.clearInterval(intervalId);
      if (channel) void supabaseClient?.removeChannel(channel);
    };
  }, []);

  const initial = useRef(readParams()).current;
  const [range, setRange] = useState<Range>(initial.range);
  const [query, setQuery] = useState(initial.query);
  const [emptyTh, setEmptyTh] = useState(initial.emptyTh);
  const [backTh, setBackTh] = useState(initial.backTh);
  const [panel, setPanel] = useState<null | 'settings' | 'share'>(null);
  const [copied, setCopied] = useState(false);

  const scopedRows = useMemo(() => scopeByRange(rows, range), [rows, range]);
  const summary = useMemo(() => summarize(scopedRows), [scopedRows]);
  const stores = useMemo(() => buildStores(scopedRows), [scopedRows]);
  const categories = useMemo(() => buildCategories(scopedRows), [scopedRows]);
  const timeline = useMemo(() => buildTimeline(scopedRows, range === '7d' ? 7 : 14), [scopedRows, range]);
  const filteredStores = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return stores;
    return stores.filter((s) => s.store.toLowerCase().includes(q));
  }, [stores, query]);

  const qs = buildQuery(range, query, emptyTh, backTh);
  const snapshotUrl = `${window.location.origin}${window.location.pathname}${qs ? '?' + qs : ''}`;

  useEffect(() => {
    window.history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [qs]);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(id);
  }, [copied]);

  function exportCsv() {
    downloadCsv(
      `shelfguide-hq-magasins-${dayKey(new Date().toISOString())}.csv`,
      ['Magasin', 'Conformite %', 'Critiques', 'Moyens', 'Vide %', 'Back-side %', 'Rayons', 'Categories', 'Audits', 'Priorite', 'Dernier audit'],
      stores.map((s) => [
        s.store, Math.round(s.conformity), s.critical, s.medium,
        Math.round(s.emptyRatio), Math.round(s.backRatio), s.shelves, s.categories, s.audits,
        s.priority, formatDate(s.lastAudit),
      ]),
    );
  }

  function copySnapshot() {
    void navigator.clipboard?.writeText(snapshotUrl).then(() => setCopied(true));
  }

  function exportPdf() {
    generateHqReport({
      periode: RANGE_LABELS[range],
      summary: {
        avgProfitability: summary.avgProfitability,
        avgEmptyRatio: summary.avgEmptyRatio,
        avgBackRatio: summary.avgBackRatio,
        audits: summary.audits,
        stores: summary.stores,
      },
      counts: { stores: stores.length, highRisk: highRiskStores, critical: summary.critical },
      worstStore: worstStore ? { store: worstStore.store, conformity: worstStore.conformity, critical: worstStore.critical } : undefined,
      stores: stores.slice(0, 12).map((s) => ({
        store: s.store, conformity: s.conformity, critical: s.critical, medium: s.medium,
        emptyRatio: s.emptyRatio, backRatio: s.backRatio, shelves: s.shelves, priority: s.priority,
      })),
      categories: categories.map((c) => ({ category: c.category, conformity: c.conformity, critical: c.critical })),
      timeline: timeline.map((t) => ({ label: t.label, conformity: t.conformity })),
      thresholds: { empty: emptyTh, back: backTh },
    });
  }
  const worstStore = stores[0];
  const networkClean = summary.avgProfitability >= 85 && summary.critical === 0;
  const maxIssues = Math.max(1, ...timeline.map((point) => point.issues));
  const latestTimeline = timeline[timeline.length - 1];
  const highRiskStores = stores.filter((store) => store.priority === 'Haute').length;

  return (
    <main className="app-frame">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">HQ</div>
          <div>
            <strong>ShelfGuide HQ</strong>
            <span>Network command</span>
          </div>
        </div>

        <nav className="side-nav" aria-label="Navigation dashboard">
          <a className="active" href="#overview">Reseau</a>
          <a href="#stores">Magasins</a>
          <a href="#categories">Categories</a>
          <a href="#timeline">Evolution</a>
        </nav>

        <div className={`sync-card ${error ? 'offline' : 'online'}`}>
          <span className="sync-dot" />
          <strong>{error ? 'Connexion a verifier' : refreshing ? 'Synchronisation' : 'Supabase live'}</strong>
          <small>{lastUpdated ? formatDate(lastUpdated.toISOString()) : 'En attente'}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="page-header" id="overview">
          <div>
            <p className="eyebrow">Direction reseau</p>
            <h1>Pilotage performance magasins</h1>
            <p className="subtitle">Vue HQ des magasins a risque, categories faibles et pertes commerciales detectees.</p>
          </div>
          <div className="header-actions">
            <div className="seg" role="group" aria-label="Periode d'analyse">
              {(['7d', '30d', 'all'] as Range[]).map((r) => (
                <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>
              ))}
            </div>
            <div className="tool-group">
              <button className="tool-btn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} title="Reglages des seuils d'alerte">⚙</button>
              <button className="tool-btn" onClick={exportCsv} disabled={rows.length === 0} title="Exporter les magasins en CSV">CSV</button>
              <button className="tool-btn" onClick={exportPdf} disabled={rows.length === 0} title="Generer un rapport PDF professionnel">PDF</button>
              <button className="tool-btn" onClick={toggleFullscreen} title="Mode presentation plein ecran">⛶</button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'share' ? null : 'share')} title="Partager / QR code">⤴</button>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>

            {panel ? <div className="popover-backdrop" onClick={() => setPanel(null)} /> : null}
            {panel === 'settings' ? (
              <div className="popover">
                <h3>Seuils d'alerte</h3>
                <label className="field">
                  <span>Vide critique <b>{emptyTh}%</b></span>
                  <input type="range" min={3} max={30} value={emptyTh} onChange={(e) => setEmptyTh(Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Back-side critique <b>{backTh}%</b></span>
                  <input type="range" min={2} max={20} value={backTh} onChange={(e) => setBackTh(Number(e.target.value))} />
                </label>
                <button className="ghost-btn" onClick={() => { setEmptyTh(DEFAULT_EMPTY); setBackTh(DEFAULT_BACK); }}>Reinitialiser</button>
              </div>
            ) : null}
            {panel === 'share' ? (
              <div className="popover share">
                <h3>Partager cette vue</h3>
                <p>Scannez pour ouvrir sur mobile (filtres inclus)</p>
                <div className="qr"><QRCodeSVG value={snapshotUrl} size={148} bgColor="#ffffff" fgColor="#111111" level="M" /></div>
                <div className="share-url">
                  <input readOnly value={snapshotUrl} onFocus={(e) => e.currentTarget.select()} />
                  <button onClick={copySnapshot}>{copied ? 'Copie !' : 'Copier'}</button>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {error ? <div className="notice danger">{error}</div> : null}
        {loading ? <div className="notice">Chargement des analyses Supabase...</div> : null}

        {!loading && rows.length === 0 && !error ? (
          <div className="empty">Aucune analyse disponible pour le reseau.</div>
        ) : null}

        {rows.length > 0 ? (
          <>
            <section className="command-grid">
              <article className="command-card score-card">
                <div className="section-heading">
                  <span>Score reseau</span>
                  <StatusBadge tone={networkClean ? 'success' : 'warning'} label={networkClean ? 'Stable' : 'Sous surveillance'} />
                </div>
                <div className="score-layout">
                  <div>
                    <strong className="score-value"><CountUp value={pct(summary.avgProfitability)} /></strong>
                    <p>{highRiskStores} magasins en priorite haute sur {stores.length} magasins analyses.</p>
                  </div>
                  <div className="score-ring" style={{ '--score': `${clamp(summary.avgProfitability)}%` } as CSSProperties}>
                    <span><CountUp value={pct(summary.avgProfitability)} /></span>
                  </div>
                </div>
              </article>

              <article className="command-card priority-card">
                <div className="section-heading">
                  <span>Magasin prioritaire</span>
                  <StatusBadge tone={worstStore ? toneFromPriority(worstStore.priority) : 'primary'} label={worstStore?.priority ?? 'N/A'} />
                </div>
                <strong className="priority-title">{worstStore?.store ?? 'Aucun magasin'}</strong>
                <p>{worstStore ? `${worstStore.critical} audits critiques, ${pct(worstStore.conformity)} conformite moyenne.` : 'Aucune anomalie reseau detectee.'}</p>
                <div className="mini-metrics">
                  <span>Decision HQ</span>
                  <strong>{worstStore ? `Declencher plan magasin ${worstStore.store}` : 'Maintenir cadence actuelle'}</strong>
                </div>
              </article>

              <article className="command-card execution-card">
                <div className="section-heading">
                  <span>Corrections reseau</span>
                  <StatusBadge tone={(latestTimeline?.corrected ?? 0) > 0 ? 'success' : 'warning'} label={`${latestTimeline?.corrected ?? 0} corrigees`} />
                </div>
                <strong className="priority-title">{summary.emptySpaces + summary.backProducts}</strong>
                <p>Anomalies visibles encore detectees dans les derniers audits.</p>
                <div className="progress-line">
                  <i style={{ width: `${clamp(100 - summary.avgEmptyRatio)}%` }} />
                </div>
              </article>
            </section>

            <section className="metric-grid">
              <MetricCard label="Magasins" value={String(summary.stores)} detail={`${summary.audits} audits`} />
              <MetricCard label="Risque haut" value={String(highRiskStores)} detail="Plan action HQ" tone="danger" />
              <MetricCard label="Alertes critiques" value={String(summary.critical)} detail="Audits non conformes" tone="danger" />
              <MetricCard label="Conformite" value={pct(summary.avgProfitability)} detail="Score moyen reseau" tone="success" />
              <MetricCard label="Vide moyen" value={pct(summary.avgEmptyRatio)} detail={`${summary.emptySpaces} facings vides`} tone="warning" />
              <MetricCard label="Back-side" value={pct(summary.avgBackRatio)} detail={`${summary.backProducts} produits`} />
              <MetricCard label="Categories" value={String(categories.length)} detail="Sous surveillance" />
            </section>

            <section className="content-grid">
              <section className="panel table-panel" id="stores">
                <div className="panel-head">
                  <PanelTitle eyebrow="Priorisation reseau" title="Magasins a corriger en premier" />
                  <input
                    className="search"
                    type="search"
                    placeholder="Rechercher un magasin..."
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                <StoreTable stores={filteredStores.slice(0, 12)} emptyTh={emptyTh} backTh={backTh} />
                {filteredStores.length === 0 ? <p className="muted">Aucun magasin ne correspond a la recherche.</p> : null}
              </section>

              <section className="panel decisions-panel">
                <PanelTitle eyebrow="Decision" title="Lecture executive" />
                <DecisionStack
                  items={[
                    ['Magasin prioritaire', worstStore?.store ?? 'Aucun'],
                    ['Etat reseau', networkClean ? 'Reseau propre' : 'Plan correction requis'],
                    ['Categorie faible', categories[0]?.category ?? 'N/A'],
                    ['Action attendue', worstStore ? 'Aligner manager magasin' : 'Maintenir controle'],
                  ]}
                />
              </section>

              <section className="panel alerts-panel" id="categories">
                <PanelTitle eyebrow="Categories" title="Familles sous performance" />
                <CategoryList categories={categories} />
              </section>

              <section className="panel timeline-panel" id="timeline">
                <PanelTitle eyebrow="Evolution" title="Conformite reseau et anomalies" />
                <Timeline points={timeline} maxIssues={maxIssues} />
              </section>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}

function CountUp({ value }: { value: string }) {
  const match = value.match(/^(\D*)(-?\d+(?:[.,]\d+)?)(.*)$/);
  const target = match ? parseFloat(match[2].replace(',', '.')) : 0;
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(0);

  useEffect(() => {
    if (!match) {
      setDisplay(value);
      return;
    }
    const prefix = match[1];
    const suffix = match[3];
    const decimals = /[.,]/.test(match[2]) ? match[2].split(/[.,]/)[1]?.length ?? 0 : 0;
    const from = fromRef.current;
    fromRef.current = target;
    const duration = 900;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = from + (target - from) * eased;
      setDisplay(`${prefix}${current.toFixed(decimals)}${suffix}`);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setDisplay(value);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);

  return <>{display}</>;
}

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function MetricCard({ label, value, detail, tone = 'primary' }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong><CountUp value={value} /></strong>
      <small>{detail}</small>
    </article>
  );
}

function PanelTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="panel-title">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
    </div>
  );
}

function RatioCell({ value, tone }: { value: number; tone: Tone }) {
  return (
    <div className="ratio-cell">
      <span>{pct(value)}</span>
      <div className={`ratio-track ${tone}`}>
        <i style={{ width: `${clamp(value)}%` }} />
      </div>
    </div>
  );
}

function StoreTable({ stores, emptyTh, backTh }: { stores: StoreScore[]; emptyTh: number; backTh: number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Magasin</th>
            <th>Conformite</th>
            <th>Critiques</th>
            <th>Vide</th>
            <th>Back-side</th>
            <th>Rayons</th>
            <th>Dernier audit</th>
            <th>Priorite</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((store) => (
            <tr key={store.store}>
              <td>
                <strong>{store.store}</strong>
                <small>{store.categories} categories - {store.audits} audits</small>
              </td>
              <td><RatioCell value={store.conformity} tone={store.conformity >= 85 ? 'success' : store.conformity >= 65 ? 'warning' : 'danger'} /></td>
              <td>{store.critical}</td>
              <td><RatioCell value={store.emptyRatio} tone={store.emptyRatio >= emptyTh ? 'danger' : store.emptyRatio >= emptyTh * 0.7 ? 'warning' : 'success'} /></td>
              <td><RatioCell value={store.backRatio} tone={store.backRatio >= backTh ? 'warning' : 'success'} /></td>
              <td>{store.shelves}</td>
              <td>{formatDate(store.lastAudit)}</td>
              <td><StatusBadge tone={toneFromPriority(store.priority)} label={store.priority} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecisionStack({ items }: { items: [string, string][] }) {
  return (
    <div className="decision-stack">
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function CategoryList({ categories }: { categories: CategoryScore[] }) {
  return (
    <div className="recurring-list">
      {categories.map((category, index) => (
        <div key={category.category}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{category.category}</strong>
            <small>{category.critical} critiques - {category.audits} audits</small>
          </div>
          <em>{pct(category.conformity)}</em>
        </div>
      ))}
    </div>
  );
}

function Timeline({ points, maxIssues }: { points: TimelinePoint[]; maxIssues: number }) {
  const [active, setActive] = useState<number | null>(null);
  if (points.length === 0) return <p className="muted">Pas encore assez de donnees temporelles.</p>;

  const W = 720;
  const H = 240;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const baseY = padT + innerH;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const ySec = (v: number) => padT + innerH * (1 - clamp(v / maxIssues, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const secPoints = points.map((p, i) => [x(i), ySec(p.issues)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${baseY} L${padL} ${baseY} Z`;
  const secLine = toPath(secPoints);
  const gridValues = [0, 25, 50, 75, 100];
  const hovered = active !== null ? points[active] : null;

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Anomalies</span>
      </div>

      <div className="chart">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Evolution de la conformite et des anomalies"
          onMouseLeave={() => setActive(null)}
        >
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(34, 227, 196, .26)" />
              <stop offset="100%" stopColor="rgba(34, 227, 196, 0)" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#22e3c4" />
              <stop offset="100%" stopColor="#c2f24a" />
            </linearGradient>
          </defs>

          {gridValues.map((g) => {
            const gy = yConf(g);
            return (
              <g key={g}>
                <line className="grid-line" x1={padL} y1={gy} x2={W - padR} y2={gy} />
                <text className="y-label" x={padL - 8} y={gy + 3}>{g}</text>
              </g>
            );
          })}

          <path className="area" d={areaPath} fill="url(#areaFill)" />
          <path className="line anomaly" d={secLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={active === i ? 0 : 4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {hovered ? (
            <g>
              <line className="cursor-line" x1={x(active!)} y1={padT} x2={x(active!)} y2={baseY} />
              <circle className="cursor-dot" cx={x(active!)} cy={yConf(hovered.conformity)} r={5.5} />
            </g>
          ) : null}

          {points.map((p, i) =>
            i % Math.ceil(points.length / 7) === 0 || i === points.length - 1 ? (
              <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
            ) : null,
          )}

          {points.map((_, i) => (
            <rect
              key={`hit-${i}`}
              className="hit"
              x={x(i) - (stepX || innerW) / 2}
              y={padT}
              width={stepX || innerW}
              height={innerH}
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>

        {hovered ? (
          <div
            className="chart-tooltip"
            style={{ left: `${(x(active!) / W) * 100}%`, top: `${(yConf(hovered.conformity) / H) * 100}%` }}
          >
            <b>{hovered.label}</b>
            <div className="tt-row">
              <span><i style={{ background: 'linear-gradient(90deg,#22e3c4,#c2f24a)' }} />Conformite</span>
              <strong>{pct(hovered.conformity)}</strong>
            </div>
            <div className="tt-row">
              <span><i style={{ background: '#ffb443' }} />Anomalies</span>
              <strong>{hovered.issues}</strong>
            </div>
            <div className="tt-row">
              <span>Corrigees</span>
              <strong>{hovered.corrected}</strong>
            </div>
          </div>
        ) : null}
      </div>

      {points.length <= 8 ? (
        <div className="chart-foot" style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}>
          {points.map((p) => (
            <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
          ))}
        </div>
      ) : null}
    </div>
  );
}
