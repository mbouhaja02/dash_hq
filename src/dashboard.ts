import { createClient } from '@supabase/supabase-js';

export type GroupKey = 'store_name' | 'shelf_name' | 'category';

export interface AnalysisRow {
  id: string;
  store_name: string;
  shelf_name: string;
  category: string;
  audit_date: string;
  status: string;
  severity: string;
  recommendation: string;
  empty_spaces: number;
  raw_products_detected: number;
  products_analyzed: number;
  front_products: number;
  back_products: number;
  product_groups: number;
  empty_ratio_percent: number;
  back_ratio_percent: number;
  weighted_loss_percent: number;
  weighted_profitability_percent: number;
  shelf_loss_percent: number;
  shelf_profitability_percent: number;
  money_value_available: boolean;
}

export interface DashboardGroup {
  label: string;
  count: number;
  avgProfitability: number;
  emptySpaces: number;
  backProducts: number;
  criticalCount: number;
  lastAudit?: string;
}

const env = import.meta.env as unknown as Record<string, string | undefined>;

const supabaseUrl = (
  env.VITE_SUPABASE_URL ??
  env.NEXT_PUBLIC_SUPABASE_URL ??
  'https://moucagzxoucxytgoamgl.supabase.co'
)?.trim();
const supabaseAnonKey = (
  env.VITE_SUPABASE_ANON_KEY ??
  env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  'sb_publishable_J3uWerqtMwpC9YjA9zC-6g_G1QCBigL'
)?.trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl ?? '', supabaseAnonKey ?? '')
  : null;

export const supabaseClient = supabase;

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalize(row: any): AnalysisRow {
  return {
    id: String(row.id),
    store_name: row.store_name ?? 'Magasin',
    shelf_name: row.shelf_name ?? 'Rayon',
    category: row.category ?? 'Autre',
    audit_date: row.audit_date ?? row.created_at ?? new Date().toISOString(),
    status: row.status ?? 'Moyen',
    severity: row.severity ?? 'medium',
    recommendation: row.recommendation ?? '',
    empty_spaces: numeric(row.empty_spaces),
    raw_products_detected: numeric(row.raw_products_detected),
    products_analyzed: numeric(row.products_analyzed),
    front_products: numeric(row.front_products),
    back_products: numeric(row.back_products),
    product_groups: numeric(row.product_groups),
    empty_ratio_percent: numeric(row.empty_ratio_percent),
    back_ratio_percent: numeric(row.back_ratio_percent),
    weighted_loss_percent: numeric(row.weighted_loss_percent),
    weighted_profitability_percent: numeric(row.weighted_profitability_percent),
    shelf_loss_percent: numeric(row.shelf_loss_percent),
    shelf_profitability_percent: numeric(row.shelf_profitability_percent),
    money_value_available: Boolean(row.money_value_available),
  };
}

export async function loadAnalyses(options: {
  storeName?: string;
  category?: string;
  limit?: number;
}): Promise<AnalysisRow[]> {
  if (!supabase) {
    throw new Error('Variables Supabase manquantes: ajoute VITE_SUPABASE_URL et VITE_SUPABASE_PUBLISHABLE_KEY.');
  }

  let query = supabase
    .from('shelfguide_analyses')
    .select('*')
    .order('audit_date', { ascending: false })
    .limit(options.limit ?? 500);

  if (options.storeName) query = query.eq('store_name', options.storeName);
  if (options.category) query = query.eq('category', options.category);

  const { data, error } = await query;
  if (error) throw error;

  return (data ?? []).map(normalize);
}

export function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function summarize(rows: AnalysisRow[]) {
  return {
    audits: rows.length,
    stores: new Set(rows.map((row) => row.store_name)).size,
    avgProfitability: average(rows.map((row) => row.weighted_profitability_percent)),
    critical: rows.filter((row) => row.status === 'Critique' || row.severity === 'high').length,
    emptySpaces: rows.reduce((sum, row) => sum + row.empty_spaces, 0),
    backProducts: rows.reduce((sum, row) => sum + row.back_products, 0),
    avgEmptyRatio: average(rows.map((row) => row.empty_ratio_percent)),
    avgBackRatio: average(rows.map((row) => row.back_ratio_percent)),
  };
}

export function groupRows(rows: AnalysisRow[], key: GroupKey): DashboardGroup[] {
  const buckets = new Map<string, AnalysisRow[]>();

  for (const row of rows) {
    const label = row[key] || 'Non renseigne';
    buckets.set(label, [...(buckets.get(label) ?? []), row]);
  }

  return Array.from(buckets.entries())
    .map(([label, items]) => ({
      label,
      count: items.length,
      avgProfitability: average(items.map((item) => item.weighted_profitability_percent)),
      emptySpaces: items.reduce((sum, item) => sum + item.empty_spaces, 0),
      backProducts: items.reduce((sum, item) => sum + item.back_products, 0),
      criticalCount: items.filter((item) => item.status === 'Critique' || item.severity === 'high').length,
      lastAudit: items[0]?.audit_date,
    }))
    .sort((a, b) => a.avgProfitability - b.avgProfitability);
}

export function worstRows(rows: AnalysisRow[], count = 8): AnalysisRow[] {
  return [...rows]
    .sort((a, b) => a.weighted_profitability_percent - b.weighted_profitability_percent)
    .slice(0, count);
}

export function formatDate(value?: string): string {
  if (!value) return 'N/A';
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatMAD(value: number): string {
  return new Intl.NumberFormat('fr-MA', {
    style: 'currency',
    currency: 'MAD',
    maximumFractionDigits: 0,
  }).format(Math.round(Math.max(0, value)));
}

export function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return hours >= 10 ? `${Math.round(hours)} h` : `${hours.toFixed(1)} h`;
}
