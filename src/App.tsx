import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  AnalysisRow,
  average,
  formatDate,
  formatHours,
  formatMAD,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  supabaseClient,
} from './dashboard';
import { dashboardConfig } from './config';
import { generateHqReport } from './report';
import {
  getComplianceScore,
  getFillRate,
  getMainIssue,
  getPriorityLevel,
  getSeverityLevel,
  issueWeight,
  priorityWeight,
  type MainIssue,
} from './shelfguideCalculations';
import './styles.css';

type Tone = 'danger' | 'warning' | 'success' | 'primary';
type Priority = 'Haute' | 'Moyenne' | 'Faible';
type Theme = 'light' | 'dark';

interface StoreScore {
  store: string;
  audits: number;
  shelves: number;
  categories: number;
  conformity: number;
  fillRate: number;
  emptyRatio: number;
  backRatio: number;
  critical: number;
  medium: number;
  issues: number;
  dominantIssue: MainIssue;
  priority: Priority;
  score: number;
  lastAudit: string;
}

interface CategoryScore {
  category: string;
  audits: number;
  conformity: number;
  fillRate: number;
  stores: number;
  critical: number;
  emptySpaces: number;
  backProducts: number;
  dominantIssue: MainIssue;
}

interface TimelinePoint {
  label: string;
  conformity: number;
  issues: number;
  corrected: number;
}

interface ActivityItem {
  avatar: string;
  title: string;
  meta: string;
  tone: Tone;
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
  return getSeverityLevel(row);
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
      const conformity = average(items.map((item) => getComplianceScore(item)));
      const fillRate = average(items.map((item) => getFillRate(item)));
      const emptyRatio = average(items.map((item) => item.empty_ratio_percent));
      const backRatio = average(items.map((item) => item.back_ratio_percent));
      const issues = issueCount(items);
      const issueCounts = new Map<MainIssue, number>();
      for (const item of items) {
        const issue = getMainIssue(item);
        issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
      }
      const dominantIssue = Array.from(issueCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Rayon conforme';
      const worstPriority = items
        .map(getPriorityLevel)
        .sort((a, b) => priorityWeight(b) - priorityWeight(a))[0] ?? 'Faible';
      const score =
        (100 - conformity) +
        emptyRatio * 1.5 +
        backRatio * 1.2 +
        critical * 8 +
        medium * 3 +
        priorityWeight(worstPriority) * 8 +
        issueWeight(dominantIssue) * 4;
      const priority: Priority = score >= 70 || critical >= 3 ? 'Haute' : score >= 35 || medium >= 3 ? 'Moyenne' : 'Faible';

      return {
        store,
        audits: items.length,
        shelves: new Set(items.map((item) => item.shelf_name)).size,
        categories: new Set(items.map((item) => item.category)).size,
        conformity,
        fillRate,
        emptyRatio,
        backRatio,
        critical,
        medium,
        issues,
        dominantIssue,
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
      conformity: average(items.map((item) => getComplianceScore(item))),
      fillRate: average(items.map((item) => getFillRate(item))),
      stores: new Set(items.map((item) => item.store_name)).size,
      critical: items.filter((item) => statusOf(item) === 'Critique').length,
      emptySpaces: items.reduce((sum, item) => sum + item.empty_spaces, 0),
      backProducts: items.reduce((sum, item) => sum + item.back_products, 0),
      dominantIssue: getMainIssue([...items].sort((a, b) => getComplianceScore(a) - getComplianceScore(b))[0]),
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
        conformity: average(items.map((item) => getComplianceScore(item))),
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

type Range = 'today' | '7d' | '30d' | 'all';
const RANGE_DAYS: Record<Exclude<Range, 'today' | 'all'>, number> = { '7d': 7, '30d': 30 };
const RANGE_LABELS: Record<Range, string> = { today: "Aujourd'hui", '7d': '7 jours', '30d': '30 jours', all: 'Tout' };
const DEFAULT_EMPTY = 10;
const DEFAULT_BACK = 7;

function readTheme(): Theme {
  try {
    const stored = window.localStorage.getItem('shelfguide-theme-v2');
    return stored === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function scopeByRange(rows: AnalysisRow[], range: Range): AnalysisRow[] {
  if (range === 'today') return rows.filter((row) => dayKey(row.audit_date) === dayKey(new Date().toISOString()));
  if (range === 'all') return rows;
  const cutoff = Date.now() - RANGE_DAYS[range] * 86400000;
  return rows.filter((row) => new Date(row.audit_date).getTime() >= cutoff);
}

function readParams() {
  const p = new URLSearchParams(window.location.search);
  const r = p.get('range');
  return {
    range: (r === 'today' || r === '7d' || r === '30d' || r === 'all' ? r : 'all') as Range,
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
  const [boost, setBoost] = useState(5);
  const [showSplash, setShowSplash] = useState(true);
  const [splashProgress, setSplashProgress] = useState(8);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [selectedStore, setSelectedStore] = useState('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedPerformance, setSelectedPerformance] = useState<'all' | 'critical' | 'watch' | 'healthy'>('all');
  const quickSearchRef = useRef<HTMLInputElement>(null);

  // Splash : barre de progression au premier chargement uniquement
  useEffect(() => {
    if (!showSplash) return;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const t = (performance.now() - start) / 1400;
      setSplashProgress((p) => Math.max(p, Math.min(92, 8 + t * 84)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const safety = window.setTimeout(() => setShowSplash(false), 2600);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(safety); };
  }, [showSplash]);

  useEffect(() => {
    if (loading || !showSplash) return;
    setSplashProgress(100);
    const id = window.setTimeout(() => setShowSplash(false), 420);
    return () => window.clearTimeout(id);
  }, [loading, showSplash]);

  // Echap ferme les popovers
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanel(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('shelfguide-theme-v2', theme);
    } catch {
      // Storage can be unavailable in restricted embeds.
    }
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        quickSearchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rangedRows = useMemo(() => scopeByRange(rows, range), [rows, range]);
  const storeOptions = useMemo(
    () => Array.from(new Set(rangedRows.map((row) => row.store_name).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rangedRows],
  );
  const categoryOptions = useMemo(
    () => Array.from(new Set(rangedRows.map((row) => row.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)),
    [rangedRows],
  );
  const scopedRows = useMemo(() => rangedRows.filter((row) => {
    const score = getComplianceScore(row);
    if (selectedStore !== 'all' && row.store_name !== selectedStore) return false;
    if (selectedCategory !== 'all' && row.category !== selectedCategory) return false;
    if (selectedPerformance === 'critical' && !(statusOf(row) === 'Critique' || score < 70)) return false;
    if (selectedPerformance === 'watch' && !(statusOf(row) === 'Moyen' || (score >= 70 && score < 85))) return false;
    if (selectedPerformance === 'healthy' && !(statusOf(row) === 'Bon' && score >= 85)) return false;
    return true;
  }), [rangedRows, selectedStore, selectedCategory, selectedPerformance]);
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
      ['Magasin', 'Conformite %', 'Remplissage %', 'Probleme dominant', 'Critiques', 'Moyens', 'Vide %', 'Back-side %', 'Rayons', 'Categories', 'Audits', 'Priorite', 'Dernier audit'],
      stores.map((s) => [
        s.store, Math.round(s.conformity), Math.round(s.fillRate), s.dominantIssue, s.critical, s.medium,
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
  const underperformingStores = stores.filter((store) => store.priority !== 'Faible').length;
  const riskCategories = categories.filter((category) => category.critical > 0 || category.conformity < 85).length;
  const auditsThisMonth = scopedRows.filter((row) => {
    const audit = new Date(row.audit_date);
    const now = new Date();
    return audit.getMonth() === now.getMonth() && audit.getFullYear() === now.getFullYear();
  }).length;
  const correctionRate = latestTimeline
    ? (latestTimeline.corrected / Math.max(1, latestTimeline.corrected + latestTimeline.issues)) * 100
    : 0;
  const avgFillRate = average(scopedRows.map((row) => getFillRate(row)));
  const alertCount = highRiskStores + riskCategories;
  const activityItems: ActivityItem[] = [
    worstStore
      ? {
          avatar: 'HQ',
          title: `${worstStore.store} place en priorite reseau`,
          meta: `${worstStore.critical} critiques - ${formatDate(worstStore.lastAudit)}`,
          tone: toneFromPriority(worstStore.priority),
        }
      : {
          avatar: 'OK',
          title: 'Aucun magasin prioritaire',
          meta: 'Reseau sous controle',
          tone: 'success',
        },
    categories[0]
      ? {
          avatar: 'CAT',
          title: `${categories[0].category} demande un plan categorie`,
          meta: `${categories[0].critical} critiques - ${pct(categories[0].conformity)} conformite`,
          tone: categories[0].critical > 0 ? 'warning' : 'primary',
        }
      : {
          avatar: 'CAT',
          title: 'Categories stabilisees',
          meta: 'Aucun signal faible detecte',
          tone: 'success',
        },
    {
      avatar: 'LIVE',
      title: `${alertCount} signaux reseau actifs`,
      meta: `${pct(correctionRate)} de correction sur la derniere periode`,
      tone: alertCount > 0 ? 'danger' : 'success',
    },
  ];

  // Valorisation business (hypotheses ajustables dans config.ts)
  const ruptureCostDaily = summary.emptySpaces * dashboardConfig.costPerFacing;
  const hoursSaved = (summary.audits * dashboardConfig.minPerManualAudit) / 60;
  const conformityGap = Math.max(1, 100 - summary.avgProfitability);
  const recovered = ruptureCostDaily * (Math.min(boost, conformityGap) / conformityGap);
  const hasActiveFilters =
    query.trim().length > 0 ||
    selectedStore !== 'all' ||
    selectedCategory !== 'all' ||
    selectedPerformance !== 'all';

  function resetFilters() {
    setQuery('');
    setSelectedStore('all');
    setSelectedCategory('all');
    setSelectedPerformance('all');
  }

  return (
    <>
      {showSplash ? (
        <Splash brand="ShelfGuide HQ" sub={dashboardConfig.networkLabel} progress={splashProgress} onSkip={() => setShowSplash(false)} />
      ) : null}
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
          <a href="#map">Carte</a>
          <a href="#objectives">Objectifs</a>
          <a href="#alerts">Alertes</a>
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
            <p className="eyebrow">ShelfGuide HQ</p>
            <h1>Dashboard HQ</h1>
            <p className="subtitle">Pilotez la performance rayon, les ruptures et l'execution merchandising sur l'ensemble du reseau.</p>
          </div>
          <div className="header-actions">
            <label className="quick-search" aria-label="Recherche rapide">
              <span>Search</span>
              <input
                ref={quickSearchRef}
                type="search"
                placeholder="Magasin, reseau..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>Ctrl K</kbd>
            </label>
            <div className="seg" role="group" aria-label="Periode d'analyse">
              {(['today', '7d', '30d', 'all'] as Range[]).map((r) => (
                <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>
              ))}
            </div>
            <div className="tool-group">
              <button className="tool-btn notify-btn" title="Notifications reseau" aria-label={`${alertCount} notifications reseau`}>
                <span className="notify-dot" aria-hidden="true" />
                {alertCount}
              </button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'settings' ? null : 'settings')} aria-label="Reglages des seuils d'alerte" title="Reglages des seuils d'alerte">⚙</button>
              <button className="tool-btn" onClick={exportCsv} disabled={rows.length === 0} title="Exporter les magasins en CSV">CSV</button>
              <button className="tool-btn" onClick={exportPdf} disabled={rows.length === 0} title="Generer un rapport PDF professionnel">PDF</button>
              <button className="tool-btn" onClick={toggleFullscreen} aria-label="Plein ecran" title="Mode presentation plein ecran">⛶</button>
              <button className="tool-btn" onClick={() => setPanel(panel === 'share' ? null : 'share')} aria-label="Partager / QR code" title="Partager / QR code">⤴</button>
              <button className="tool-btn theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Changer le theme" title="Changer le theme">
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
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
        {loading ? <DashboardSkeleton label="Chargement des analyses reseau..." /> : null}

        {!loading && rows.length === 0 && !error ? (
          <EmptyState
            title="Aucun audit reseau trouve"
            detail="La connexion Supabase est active, mais aucune analyse ne correspond encore au perimetre HQ."
            actionLabel="Reinitialiser les filtres"
            onAction={resetFilters}
          />
        ) : null}

        {rows.length > 0 ? (
          <>
            <section className="command-grid hq-command-grid">
              <article className="command-card score-card network-score-card">
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

              <article className="command-card priority-card priority-store-card">
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

              <article className="command-card execution-card network-corrections-card">
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

            <HqFilterBar
              stores={storeOptions}
              categories={categoryOptions}
              selectedStore={selectedStore}
              selectedCategory={selectedCategory}
              selectedPerformance={selectedPerformance}
              onStore={setSelectedStore}
              onCategory={setSelectedCategory}
              onPerformance={setSelectedPerformance}
              active={hasActiveFilters}
              onReset={resetFilters}
            />

            <section className="metric-grid">
              <MetricCard label="Magasins suivis" value={String(summary.stores)} detail={`${stores.length} magasins analyses`} variant="operational" />
              <MetricCard label="Audits realises ce mois" value={String(auditsThisMonth)} detail={`${summary.audits} audits visibles`} variant="operational" />
              <MetricCard label="Taux moyen de remplissage reseau" value={pct(avgFillRate)} detail="Facings remplis" tone="success" spark={timeline.map((point) => point.conformity)} variant="primary" />
              <MetricCard
                label="Ruptures critiques detectees"
                value={String(summary.critical)}
                detail={summary.critical > 0 ? 'Audits non conformes' : 'Reseau conforme'}
                tone={summary.critical > 0 ? 'danger' : 'success'}
                pulse={summary.critical > 0}
                spark={timeline.map((point) => point.issues)}
                variant="risk"
              />
              <MetricCard label="Categories a risque" value={String(riskCategories)} detail={`${categories.length} categories suivies`} tone={riskCategories > 0 ? 'warning' : 'success'} variant="risk" />
              <MetricCard label="Magasins sous performance" value={String(underperformingStores)} detail={`${highRiskStores} risque haut`} tone={underperformingStores > 0 ? 'warning' : 'success'} variant="insight" />
              <MetricCard label="Taux de correction" value={pct(correctionRate)} detail="Anomalies corrigees" tone="success" spark={timeline.map((point) => point.corrected)} variant="progress" />
            </section>

            <BusinessBand
              ruptureCostDaily={ruptureCostDaily}
              recovered={recovered}
              hoursSaved={hoursSaved}
              boost={boost}
              onBoost={setBoost}
              location={dashboardConfig.networkLabel}
            />

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
                <StoreTable stores={filteredStores.slice(0, 12)} emptyTh={emptyTh} backTh={backTh} onReset={resetFilters} />
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
                <NetworkHealthStrip stores={stores} />
              </section>

              <section className="panel alerts-panel" id="categories">
                <PanelTitle eyebrow="Categories" title="Familles sous performance" />
                <CategoryList categories={categories} />
              </section>

              <section className="panel map-panel" id="map">
                <PanelTitle eyebrow="Carte reseau" title="Region Casablanca" />
                <MoroccoMapPlaceholder stores={stores.slice(0, 6)} />
              </section>

              <section className="panel objectives-panel" id="objectives">
                <PanelTitle eyebrow="Objectifs reseau" title="Pilotage des cibles HQ" />
                <NetworkGoals
                  conformity={summary.avgProfitability}
                  fillRate={avgFillRate}
                  backRate={summary.avgBackRatio}
                  auditsThisMonth={auditsThisMonth}
                />
              </section>

              <section className="panel action-plan-panel">
                <PanelTitle eyebrow="Plan d'action HQ" title="Prochaines decisions" />
                <HqActionPlan worstStore={worstStore} weakCategory={categories[0]} highRiskStores={highRiskStores} />
              </section>

              <section className="panel activity-panel">
                <PanelTitle eyebrow="Activite HQ" title="Signaux qui meritent attention" />
                <ActivityFeed items={activityItems} />
              </section>

              <section className="panel benchmark-panel">
                <PanelTitle eyebrow="Benchmark" title="Top magasins et risques" />
                <BenchmarkList stores={stores} />
              </section>

              <section className="panel network-alerts-panel" id="alerts">
                <PanelTitle eyebrow="Alertes reseau" title="Priorites multi-magasins" />
                <NetworkAlertList stores={stores} categories={categories} />
              </section>

              <section className="panel insights-panel">
                <PanelTitle eyebrow="Insights reseau" title="Messages business" />
                <BusinessInsightList stores={stores} categories={categories} correctionRate={correctionRate} />
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
    </>
  );
}

function Splash({ brand, sub, progress, onSkip }: { brand: string; sub: string; progress: number; onSkip: () => void }) {
  return (
    <div className="splash" onClick={onSkip} role="button" tabIndex={0} aria-label="Passer l'introduction">
      <div className="splash-inner">
        <div className="splash-mark">{brand}</div>
        <p className="splash-sub">{sub}</p>
        <div className="splash-bar"><i style={{ width: `${progress}%` }} /></div>
        <span className="splash-hint">Chargement des analyses…</span>
      </div>
    </div>
  );
}

function DashboardSkeleton({ label }: { label: string }) {
  return (
    <section className="skeleton-shell" aria-label={label}>
      <span>{label}</span>
      <div className="skeleton-grid">
        {Array.from({ length: 7 }).map((_, index) => <i key={index} />)}
      </div>
    </section>
  );
}

function EmptyState({
  title,
  detail,
  actionLabel,
  onAction,
  compact = false,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state${compact ? ' compact' : ''}`} role="status">
      <div className="empty-illustration" aria-hidden="true">
        <span />
        <i />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {actionLabel && onAction ? (
        <button className="ghost-btn reset-btn" type="button" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}

function BusinessBand({
  ruptureCostDaily,
  recovered,
  hoursSaved,
  boost,
  onBoost,
  location,
}: {
  ruptureCostDaily: number;
  recovered: number;
  hoursSaved: number;
  boost: number;
  onBoost: (value: number) => void;
  location: string;
}) {
  return (
    <section className="business-band" aria-label="Valorisation business">
      <article className="biz-card">
        <span className="biz-label">Cout estime des ruptures</span>
        <strong className="biz-value">{formatMAD(ruptureCostDaily)}</strong>
        <small>CA potentiel perdu / jour · {location}</small>
      </article>

      <article className="biz-card biz-sim">
        <div className="biz-sim-head">
          <span className="biz-label">Et si +{boost} pts de conformite ?</span>
          <span className="est-badge">estimation</span>
        </div>
        <strong className="biz-value accent">{formatMAD(recovered)}</strong>
        <small>CA recuperable / jour (simulation)</small>
        <input
          className="biz-slider"
          type="range"
          min={0}
          max={20}
          value={boost}
          onChange={(event) => onBoost(Number(event.target.value))}
          aria-label="Gain de conformite simule en points"
        />
      </article>

      <article className="biz-card">
        <span className="biz-label">Temps gagne vs audit manuel</span>
        <strong className="biz-value"><CountUp value={formatHours(hoursSaved)} /></strong>
        <small>economise sur la periode analysee</small>
      </article>
    </section>
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

function Sparkline({ values }: { values: number[] }) {
  const clean = values.filter((value) => Number.isFinite(value));
  const series = clean.length >= 2
    ? clean
    : clean.length === 1
      ? [clean[0] * 0.86, clean[0], clean[0] * 0.94]
      : [18, 34, 26, 42];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = Math.max(1, max - min);
  const points = series
    .map((value, index) => {
      const x = (index / (series.length - 1)) * 100;
      const y = 30 - ((value - min) / range) * 24;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'primary',
  pulse = false,
  sub,
  spark,
  variant = 'operational',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: Tone;
  pulse?: boolean;
  sub?: string;
  spark?: number[];
  variant?: 'primary' | 'risk' | 'operational' | 'progress' | 'insight';
}) {
  return (
    <article className={`metric-card metric-${variant} ${tone}${pulse ? ' pulse' : ''}`}>
      <span>{label}{pulse ? <i className="live-dot" aria-hidden="true" /> : null}</span>
      <strong><CountUp value={value} /></strong>
      <small>{detail}</small>
      {sub ? <small className="metric-sub">{sub}</small> : null}
      {spark ? <Sparkline values={spark} /> : null}
    </article>
  );
}

function HqFilterBar({
  stores,
  categories,
  selectedStore,
  selectedCategory,
  selectedPerformance,
  onStore,
  onCategory,
  onPerformance,
  active,
  onReset,
}: {
  stores: string[];
  categories: string[];
  selectedStore: string;
  selectedCategory: string;
  selectedPerformance: 'all' | 'critical' | 'watch' | 'healthy';
  onStore: (value: string) => void;
  onCategory: (value: string) => void;
  onPerformance: (value: 'all' | 'critical' | 'watch' | 'healthy') => void;
  active: boolean;
  onReset: () => void;
}) {
  return (
    <section className="filter-bar" aria-label="Filtres reseau">
      <label>
        <span>Magasin</span>
        <select value={selectedStore} onChange={(event) => onStore(event.target.value)}>
          <option value="all">Tous magasins</option>
          {stores.map((store) => <option key={store} value={store}>{store}</option>)}
        </select>
      </label>
      <label>
        <span>Categorie</span>
        <select value={selectedCategory} onChange={(event) => onCategory(event.target.value)}>
          <option value="all">Toutes categories</option>
          {categories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <label>
        <span>Performance</span>
        <select value={selectedPerformance} onChange={(event) => onPerformance(event.target.value as 'all' | 'critical' | 'watch' | 'healthy')}>
          <option value="all">Tout reseau</option>
          <option value="critical">Critique</option>
          <option value="watch">Sous surveillance</option>
          <option value="healthy">Conforme</option>
        </select>
      </label>
      <button className="filter-reset" type="button" onClick={onReset} disabled={!active}>
        Reset filtres
      </button>
    </section>
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

function StoreTable({ stores, emptyTh, backTh, onReset }: { stores: StoreScore[]; emptyTh: number; backTh: number; onReset: () => void }) {
  if (stores.length === 0) {
    return (
      <EmptyState
        compact
        title="Aucun magasin trouve"
        detail="Le filtre courant ne retourne aucun magasin reseau."
        actionLabel="Reset filtres"
        onAction={onReset}
      />
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Magasin</th>
            <th>Conformite</th>
            <th>Remplissage</th>
            <th>Probleme</th>
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
            <tr key={store.store} className={`row-${toneFromPriority(store.priority)}`}>
              <td>
                <strong>{store.store}</strong>
                <small>{store.categories} categories - {store.audits} audits</small>
              </td>
              <td><RatioCell value={store.conformity} tone={store.conformity >= 85 ? 'success' : store.conformity >= 65 ? 'warning' : 'danger'} /></td>
              <td><RatioCell value={store.fillRate} tone={store.fillRate >= 95 ? 'success' : store.fillRate >= 85 ? 'warning' : 'danger'} /></td>
              <td>{store.dominantIssue}</td>
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

function NetworkHealthStrip({ stores }: { stores: StoreScore[] }) {
  const critical = stores.filter((store) => store.priority === 'Haute').length;
  const watch = stores.filter((store) => store.priority === 'Moyenne').length;
  const healthy = stores.filter((store) => store.priority === 'Faible').length;
  const total = Math.max(1, critical + watch + healthy);

  return (
    <div className="network-health-strip" aria-label="Repartition sante magasins">
      <i className="success" style={{ width: `${(healthy / total) * 100}%` }} />
      <i className="warning" style={{ width: `${(watch / total) * 100}%` }} />
      <i className="danger" style={{ width: `${(critical / total) * 100}%` }} />
      <span>{healthy} stables</span>
      <span>{watch} a surveiller</span>
      <span>{critical} critiques</span>
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="activity-feed">
      {items.map((item) => (
        <div className="activity-item" key={`${item.avatar}-${item.title}`}>
          <span className={`activity-avatar ${item.tone}`}>{item.avatar}</span>
          <div>
            <strong>{item.title}</strong>
            <small>{item.meta}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function CategoryList({ categories }: { categories: CategoryScore[] }) {
  if (categories.length === 0) return <p className="muted">Aucune categorie sous performance detectee.</p>;

  return (
    <div className="category-risk-matrix" aria-label="Matrice categories a risque">
      {categories.map((category, index) => (
        <div key={category.category} className={category.critical > 0 || category.conformity < 75 ? 'danger' : category.conformity < 85 ? 'warning' : 'success'}>
          <span>{String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{category.category}</strong>
            <small>{category.dominantIssue} - {category.stores} magasin(s)</small>
          </div>
          <RatioCell value={category.conformity} tone={category.conformity >= 85 ? 'success' : category.conformity >= 70 ? 'warning' : 'danger'} />
          <em>{category.critical} crit.</em>
          <em>{category.emptySpaces} vides</em>
          <em>{pct(category.conformity)}</em>
        </div>
      ))}
    </div>
  );
}

function MoroccoMapPlaceholder({ stores }: { stores: StoreScore[] }) {
  const mapUrl = 'https://www.openstreetmap.org/export/embed.html?bbox=-8.15,33.25,-7.05,34.02&layer=mapnik';
  const fullMapUrl = 'https://www.openstreetmap.org/#map=10/33.5731/-7.5898';
  const positions = [
    { left: 50, top: 49 },
    { left: 57, top: 43 },
    { left: 45, top: 56 },
    { left: 62, top: 55 },
    { left: 38, top: 46 },
    { left: 52, top: 62 },
  ];

  return (
    <div className="morocco-map" aria-label="Carte indicative du reseau autour de Casablanca">
      <div className="map-canvas">
        <iframe
          title="Carte OpenStreetMap de la region Casablanca"
          src={mapUrl}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
        />
        {stores.map((store, index) => {
          const pos = positions[index % positions.length];
          return (
            <div
              className={`map-marker ${store.priority.toLowerCase()}`}
              key={store.store}
              style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
              title={`${store.store} - ${pct(store.conformity)} - ${store.critical} critiques`}
            >
              <span>{index + 1}</span>
              <strong>{store.store}</strong>
              <small>{pct(store.conformity)} - {store.critical} crit.</small>
            </div>
          );
        })}
        <div className="map-overlay">
          <span>Region Casablanca - positions indicatives</span>
          <a href={fullMapUrl} target="_blank" rel="noreferrer">Ouvrir la carte</a>
        </div>
      </div>
      <div className="map-empty">
        <StatusBadge tone="warning" label="Indicatif" />
        <p>Les magasins n'ont pas encore de coordonnees en base. Les points sont des positions indicatives pour aider la lecture reseau.</p>
      </div>
    </div>
  );
}

function NetworkGoals({
  conformity,
  fillRate,
  backRate,
  auditsThisMonth,
}: {
  conformity: number;
  fillRate: number;
  backRate: number;
  auditsThisMonth: number;
}) {
  const auditTarget = 120;
  const goals = [
    {
      label: 'Conformite reseau',
      value: pct(conformity),
      target: 'Objectif 90%',
      progress: clamp((conformity / 90) * 100),
      tone: conformity >= 90 ? 'success' : conformity >= 75 ? 'warning' : 'danger',
    },
    {
      label: 'Remplissage',
      value: pct(fillRate),
      target: 'Objectif 95%',
      progress: clamp((fillRate / 95) * 100),
      tone: fillRate >= 95 ? 'success' : fillRate >= 85 ? 'warning' : 'danger',
    },
    {
      label: 'Back-side reseau',
      value: pct(backRate),
      target: 'Maximum 5%',
      progress: clamp(100 - (backRate / 5) * 100),
      tone: backRate <= 5 ? 'success' : backRate <= 9 ? 'warning' : 'danger',
    },
    {
      label: 'Audits mensuels',
      value: String(auditsThisMonth),
      target: `Objectif ${auditTarget}`,
      progress: clamp((auditsThisMonth / auditTarget) * 100),
      tone: auditsThisMonth >= auditTarget ? 'success' : auditsThisMonth >= auditTarget * 0.6 ? 'warning' : 'danger',
    },
  ] as const;

  return (
    <div className="goal-grid">
      {goals.map((goal) => (
        <div className={`goal-card ${goal.tone}`} key={goal.label}>
          <div>
            <span>{goal.label}</span>
            <strong>{goal.value}</strong>
            <small>{goal.target}</small>
          </div>
          <div className="goal-progress">
            <i style={{ width: `${goal.progress}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function HqActionPlan({
  worstStore,
  weakCategory,
  highRiskStores,
}: {
  worstStore?: StoreScore;
  weakCategory?: CategoryScore;
  highRiskStores: number;
}) {
  const steps = [
    {
      horizon: '24h',
      title: worstStore ? `Aligner ${worstStore.store}` : 'Confirmer la priorite magasin',
      detail: worstStore
        ? `Traiter ${worstStore.critical} audits critiques et relancer un controle cible.`
        : 'Aucun magasin prioritaire detecte sur la periode.',
      tone: worstStore?.priority === 'Haute' ? 'danger' : 'warning',
    },
    {
      horizon: '48h',
      title: weakCategory ? `Focus categorie ${weakCategory.category}` : 'Verifier categories faibles',
      detail: weakCategory
        ? `${weakCategory.emptySpaces} facings vides et ${pct(weakCategory.conformity)} de conformite.`
        : 'Pas de categorie faible identifiee.',
      tone: weakCategory && weakCategory.conformity < 75 ? 'danger' : 'warning',
    },
    {
      horizon: '7j',
      title: 'Standardiser les corrections',
      detail: highRiskStores > 0
        ? `Dupliquer le plan sur ${highRiskStores} magasin(s) en risque haut.`
        : 'Maintenir le rythme actuel de correction terrain.',
      tone: highRiskStores > 0 ? 'warning' : 'success',
    },
    {
      horizon: '30j',
      title: 'Revue execution merchandising',
      detail: 'Comparer les magasins, ajuster les seuils et preparer le rapport reseau.',
      tone: 'primary',
    },
  ] as const;

  return (
    <div className="action-plan">
      {steps.map((step) => (
        <div className={`action-step ${step.tone}`} key={step.horizon}>
          <span>{step.horizon}</span>
          <div>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function BenchmarkList({ stores }: { stores: StoreScore[] }) {
  if (stores.length === 0) return <p className="muted">Aucun magasin disponible pour le benchmark.</p>;

  const best = [...stores].sort((a, b) => b.conformity - a.conformity).slice(0, 5);
  const risk = stores.slice(0, 5);

  return (
    <div className="benchmark-grid">
      <div>
        <h3>Top 5 performants</h3>
        {best.map((store) => (
          <div className="benchmark-row" key={`best-${store.store}`}>
            <span>{store.store}</span>
            <strong>{pct(store.conformity)}</strong>
          </div>
        ))}
      </div>
      <div>
        <h3>Top 5 a risque</h3>
        {risk.map((store) => (
          <div className="benchmark-row" key={`risk-${store.store}`}>
            <span>{store.store}</span>
            <strong>{store.critical} critiques</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function NetworkAlertList({ stores, categories }: { stores: StoreScore[]; categories: CategoryScore[] }) {
  const alerts = [
    ...stores.slice(0, 3).map((store) => ({
      title: store.store,
      detail: `${store.critical} critiques, ${pct(store.emptyRatio)} vide moyen`,
      tone: toneFromPriority(store.priority),
    })),
    ...categories.slice(0, 2).map((category) => ({
      title: category.category,
      detail: `${category.emptySpaces} facings vides, ${pct(category.conformity)} conformite`,
      tone: category.critical > 0 ? 'danger' as Tone : 'warning' as Tone,
    })),
  ];

  if (alerts.length === 0) return <p className="muted">Aucune alerte reseau active.</p>;

  return (
    <div className="alert-list">
      {alerts.map((alert) => (
        <div className="alert-line" key={`${alert.title}-${alert.detail}`}>
          <div>
            <strong>{alert.title}</strong>
            <small>{alert.detail}</small>
          </div>
          <StatusBadge tone={alert.tone} label={alert.tone === 'danger' ? 'Critique' : alert.tone === 'warning' ? 'A surveiller' : 'Correct'} />
        </div>
      ))}
    </div>
  );
}

function BusinessInsightList({
  stores,
  categories,
  correctionRate,
}: {
  stores: StoreScore[];
  categories: CategoryScore[];
  correctionRate: number;
}) {
  const riskyStores = stores.filter((store) => store.priority !== 'Faible').length;
  const weakCategory = categories[0]?.category ?? 'Aucune categorie critique';
  const insights = [
    `${riskyStores} magasin(s) concentrent les priorites d'intervention reseau.`,
    `${weakCategory} presente la plus forte recurrence de ruptures.`,
    `Le taux de correction estime est de ${pct(correctionRate)} sur la derniere periode.`,
  ];

  return (
    <div className="recommendation-list">
      {insights.map((item, index) => (
        <div key={item} className="recommendation-item">
          <span>{String(index + 1).padStart(2, '0')}</span>
          <p>{item}</p>
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
              <stop offset="0%" stopColor="rgba(17, 191, 210, .18)" />
              <stop offset="100%" stopColor="rgba(17, 191, 210, 0)" />
            </linearGradient>
            <linearGradient id="lineGrad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#11bfd2" />
              <stop offset="100%" stopColor="#078da0" />
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
              <span><i style={{ background: '#11bfd2' }} />Conformite</span>
              <strong>{pct(hovered.conformity)}</strong>
            </div>
            <div className="tt-row">
              <span><i style={{ background: '#f59e0b' }} />Anomalies</span>
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
