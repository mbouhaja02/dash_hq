import { useEffect, useMemo, useState } from 'react';
import {
  AnalysisRow,
  DashboardGroup,
  formatDate,
  groupRows,
  isSupabaseConfigured,
  loadAnalyses,
  summarize,
  worstRows,
} from './dashboard';
import { dashboardConfig } from './config';
import './styles.css';

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function tone(row: AnalysisRow): string {
  if (row.status === 'Critique' || row.weighted_profitability_percent < 65) return 'danger';
  if (row.status === 'Moyen' || row.weighted_profitability_percent < 85) return 'warning';
  return 'success';
}

export default function App() {
  const [rows, setRows] = useState<AnalysisRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setLoading(true);
      setError(null);
      const data = await loadAnalyses({
        storeName: dashboardConfig.storeName,
        category: dashboardConfig.category,
        limit: dashboardConfig.limit,
      });
      setRows(data);
    } catch (err: any) {
      setError(err?.message ?? 'Erreur de chargement Supabase.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isSupabaseConfigured) void refresh();
    else {
      setLoading(false);
      setError('Variables Supabase manquantes.');
    }
  }, []);

  const summary = useMemo(() => summarize(rows), [rows]);
  const primaryGroups = useMemo(() => groupRows(rows, dashboardConfig.primaryGroup).slice(0, 7), [rows]);
  const secondaryGroups = useMemo(() => groupRows(rows, dashboardConfig.secondaryGroup).slice(0, 6), [rows]);
  const riskRows = useMemo(() => worstRows(rows, 8), [rows]);
  const recentRows = useMemo(() => rows.slice(0, 8), [rows]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{dashboardConfig.eyebrow}</p>
          <h1>{dashboardConfig.title}</h1>
          <p className="subtitle">{dashboardConfig.subtitle}</p>
        </div>
        <button className="refresh" onClick={refresh} disabled={loading || !isSupabaseConfigured}>
          Actualiser
        </button>
      </header>

      <section className="scope">
        <div>
          <span>{dashboardConfig.scopeLabel}</span>
          <strong>{dashboardConfig.storeName || 'Tous magasins'}{dashboardConfig.category ? ` / ${dashboardConfig.category}` : ''}</strong>
        </div>
        <div>
          <span>Source</span>
          <strong>Supabase / shelfguide_analyses</strong>
        </div>
      </section>

      {error ? <div className="notice">{error}</div> : null}
      {loading ? <div className="notice">Chargement des resultats...</div> : null}

      {!loading && rows.length === 0 && !error ? (
        <div className="empty">Aucune analyse disponible pour ce perimetre.</div>
      ) : null}

      {rows.length > 0 ? (
        <>
          <section className="kpis">
            <Kpi label="Audits" value={String(summary.audits)} />
            <Kpi label="Profitabilite moyenne" value={pct(summary.avgProfitability)} tone="success" />
            <Kpi label="Alertes critiques" value={String(summary.critical)} tone="danger" />
            <Kpi label="Zones vides" value={String(summary.emptySpaces)} tone="warning" />
            <Kpi label="Back/side" value={String(summary.backProducts)} />
            <Kpi label="Ratio vide moyen" value={pct(summary.avgEmptyRatio)} />
          </section>

          <section className="grid">
            <Panel title={dashboardConfig.riskTitle}>
              <AuditTable rows={riskRows} />
            </Panel>
            <Panel title={dashboardConfig.primaryTitle}>
              <GroupList groups={primaryGroups} />
            </Panel>
            <Panel title={dashboardConfig.secondaryTitle}>
              <GroupList groups={secondaryGroups} />
            </Panel>
            <Panel title={dashboardConfig.recentTitle}>
              <AuditTable rows={recentRows} compact />
            </Panel>
          </section>
        </>
      ) : null}
    </main>
  );
}

function Kpi({ label, value, tone: toneName = 'primary' }: { label: string; value: string; tone?: string }) {
  return (
    <article className={`kpi ${toneName}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function GroupList({ groups }: { groups: DashboardGroup[] }) {
  const max = Math.max(...groups.map((group) => group.avgProfitability), 100);

  return (
    <div className="groups">
      {groups.map((group) => (
        <div className="group-row" key={group.label}>
          <div className="group-head">
            <strong>{group.label}</strong>
            <span>{pct(group.avgProfitability)}</span>
          </div>
          <div className="bar">
            <span style={{ width: `${Math.max(4, (group.avgProfitability / max) * 100)}%` }} />
          </div>
          <small>
            {group.count} audits · {group.emptySpaces} vides · {group.backProducts} back/side
          </small>
        </div>
      ))}
    </div>
  );
}

function AuditTable({ rows, compact = false }: { rows: AnalysisRow[]; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Rayon</th>
            {!compact ? <th>Magasin</th> : null}
            <th>Score</th>
            <th>Vides</th>
            <th>Back</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>{row.shelf_name}</strong>
                <small>{row.category}</small>
              </td>
              {!compact ? <td>{row.store_name}</td> : null}
              <td><span className={`pill ${tone(row)}`}>{pct(row.weighted_profitability_percent)}</span></td>
              <td>{row.empty_spaces}</td>
              <td>{row.back_products}</td>
              <td>{formatDate(row.audit_date)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
