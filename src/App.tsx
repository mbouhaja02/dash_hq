import { useEffect, useMemo, useState, type CSSProperties } from 'react';
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

function buildTimeline(rows: AnalysisRow[]): TimelinePoint[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const key = dayKey(row.audit_date);
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
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

  const summary = useMemo(() => summarize(rows), [rows]);
  const stores = useMemo(() => buildStores(rows), [rows]);
  const categories = useMemo(() => buildCategories(rows), [rows]);
  const timeline = useMemo(() => buildTimeline(rows), [rows]);
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
            <div className="store-chip">
              <span>Perimetre</span>
              <strong>Reseau complet</strong>
            </div>
            <button className="refresh" onClick={() => void refresh()} disabled={loading || !isSupabaseConfigured}>
              Actualiser
            </button>
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
                    <strong className="score-value">{pct(summary.avgProfitability)}</strong>
                    <p>{highRiskStores} magasins en priorite haute sur {stores.length} magasins analyses.</p>
                  </div>
                  <div className="score-ring" style={{ '--score': `${clamp(summary.avgProfitability)}%` } as CSSProperties}>
                    <span>{pct(summary.avgProfitability)}</span>
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
                <PanelTitle eyebrow="Priorisation reseau" title="Magasins a corriger en premier" />
                <StoreTable stores={stores.slice(0, 12)} />
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

function StatusBadge({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function MetricCard({ label, value, detail, tone = 'primary' }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <article className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
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

function StoreTable({ stores }: { stores: StoreScore[] }) {
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
              <td>{pct(store.emptyRatio)}</td>
              <td>{pct(store.backRatio)}</td>
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
  if (points.length === 0) return <p className="muted">Pas encore assez de donnees temporelles.</p>;

  const W = 720;
  const H = 240;
  const padL = 34;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const x = (i: number) => padL + stepX * i;
  const yConf = (v: number) => padT + innerH * (1 - clamp(v, 0, 100) / 100);
  const yIssue = (v: number) => padT + innerH * (1 - clamp(v / maxIssues, 0, 1));

  const confPoints = points.map((p, i) => [x(i), yConf(p.conformity)] as const);
  const issuePoints = points.map((p, i) => [x(i), yIssue(p.issues)] as const);

  const toPath = (pts: readonly (readonly [number, number])[]) =>
    pts.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ');

  const confLine = toPath(confPoints);
  const areaPath = `${confLine} L${x(points.length - 1).toFixed(1)} ${padT + innerH} L${padL} ${padT + innerH} Z`;
  const issueLine = toPath(issuePoints);
  const gridValues = [0, 25, 50, 75, 100];

  return (
    <div className="timeline">
      <div className="timeline-legend">
        <span><i className="legend-compliance" /> Conformite</span>
        <span><i className="legend-anomaly" /> Anomalies</span>
      </div>

      <div className="chart">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Evolution de la conformite et des anomalies">
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(99, 102, 241, .28)" />
              <stop offset="100%" stopColor="rgba(99, 102, 241, 0)" />
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
          <path className="line anomaly" d={issueLine} />
          <path className="line compliance" d={confLine} />

          {confPoints.map((pt, i) => (
            <circle
              key={i}
              className="dot"
              cx={pt[0]}
              cy={pt[1]}
              r={4}
              style={{ animationDelay: `${0.9 + i * 0.08}s` }}
            />
          ))}

          {points.map((p, i) => (
            <text key={p.label} className="x-label" x={x(i)} y={H - 8}>{p.label}</text>
          ))}
        </svg>
      </div>

      <div className="chart-foot">
        {points.map((p) => (
          <small key={p.label}>{pct(p.conformity)} · {p.corrected} corr.</small>
        ))}
      </div>
    </div>
  );
}
