export type SeverityLevel = 'Bon' | 'Moyen' | 'Critique';
export type PriorityLevel = 'Haute' | 'Moyenne' | 'Faible';
export type MainIssue =
  | 'Rupture visible'
  | 'Mauvaise orientation'
  | 'Performance faible'
  | 'Audit incomplet'
  | 'Rayon conforme';

export type ShelfGuideMetricRow = {
  status?: string | null;
  severity?: string | null;
  recommendation?: string | null;
  empty_spaces?: number | null;
  raw_products_detected?: number | null;
  products_analyzed?: number | null;
  back_products?: number | null;
  empty_ratio_percent?: number | null;
  back_ratio_percent?: number | null;
  weighted_loss_percent?: number | null;
  weighted_profitability_percent?: number | null;
  shelf_loss_percent?: number | null;
  shelf_profitability_percent?: number | null;
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function metric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function text(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function getComplianceScore(row: ShelfGuideMetricRow): number {
  const weighted = metric(row.weighted_profitability_percent);
  if (weighted !== undefined) return clamp(weighted);

  const shelf = metric(row.shelf_profitability_percent);
  if (shelf !== undefined) return clamp(shelf);

  const empty = metric(row.empty_ratio_percent) ?? 0;
  const back = metric(row.back_ratio_percent) ?? 0;
  return clamp(100 - (empty * 0.72 + back * 0.28));
}

export function getFillRate(row: ShelfGuideMetricRow): number {
  return clamp(100 - (metric(row.empty_ratio_percent) ?? 0));
}

export function getLossRate(row: ShelfGuideMetricRow): number {
  const weighted = metric(row.weighted_loss_percent);
  if (weighted !== undefined) return clamp(weighted);

  const shelf = metric(row.shelf_loss_percent);
  if (shelf !== undefined) return clamp(shelf);

  const empty = metric(row.empty_ratio_percent) ?? 0;
  const back = metric(row.back_ratio_percent) ?? 0;
  return clamp(empty * 0.75 + back * 0.25);
}

export function getSeverityLevel(row: ShelfGuideMetricRow): SeverityLevel {
  const status = text(row.status);
  const severity = text(row.severity);
  const compliance = getComplianceScore(row);
  const empty = metric(row.empty_ratio_percent) ?? 0;
  const back = metric(row.back_ratio_percent) ?? 0;

  if (
    status === 'critique' ||
    severity === 'high' ||
    severity === 'critique' ||
    severity === 'critical' ||
    empty >= 18 ||
    compliance < 65
  ) return 'Critique';

  if (
    status === 'moyen' ||
    severity === 'medium' ||
    severity === 'moyen' ||
    empty >= 8 ||
    back >= 8 ||
    compliance < 85
  ) return 'Moyen';

  return 'Bon';
}

export function getPriorityLevel(row: ShelfGuideMetricRow): PriorityLevel {
  const severity = getSeverityLevel(row);
  const compliance = getComplianceScore(row);
  const empty = metric(row.empty_ratio_percent) ?? 0;
  const back = metric(row.back_ratio_percent) ?? 0;
  const hasRecommendation = text(row.recommendation).length > 0;

  if (severity === 'Critique' || empty >= 15 || back >= 12 || compliance < 70) return 'Haute';
  if (severity === 'Moyen' || empty >= 5 || back >= 5 || compliance < 85 || hasRecommendation) return 'Moyenne';
  return 'Faible';
}

export function getMainIssue(row: ShelfGuideMetricRow): MainIssue {
  const analyzed = metric(row.products_analyzed) ?? 0;
  const detected = metric(row.raw_products_detected) ?? 0;
  const empty = metric(row.empty_ratio_percent) ?? 0;
  const emptySpaces = metric(row.empty_spaces) ?? 0;
  const back = metric(row.back_ratio_percent) ?? 0;
  const backProducts = metric(row.back_products) ?? 0;
  const compliance = getComplianceScore(row);

  if (analyzed <= 0 || detected <= 0) return 'Audit incomplet';
  if (empty >= 10 || emptySpaces >= 4) return 'Rupture visible';
  if (back >= 7 || backProducts >= 4) return 'Mauvaise orientation';
  if (compliance < 75) return 'Performance faible';
  return 'Rayon conforme';
}

export function priorityWeight(priority: PriorityLevel): number {
  if (priority === 'Haute') return 3;
  if (priority === 'Moyenne') return 2;
  return 1;
}

export function issueWeight(issue: MainIssue): number {
  if (issue === 'Rupture visible') return 5;
  if (issue === 'Performance faible') return 4;
  if (issue === 'Mauvaise orientation') return 3;
  if (issue === 'Audit incomplet') return 2;
  return 1;
}
