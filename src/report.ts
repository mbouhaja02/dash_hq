import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/* ============================================================
   ShelfGuide HQ — generateur de rapport PDF (reseau)
   Document professionnel, branche, 2 a 3 pages max.
   ============================================================ */

type RGB = [number, number, number];

const ACCENT: RGB = [13, 122, 120];     // deep teal
const INK: RGB = [15, 23, 32];
const MUTED: RGB = [110, 122, 132];
const RULE: RGB = [214, 224, 228];
const ZEBRA: RGB = [240, 247, 247];
const OK: RGB = [15, 128, 96];
const WARN: RGB = [180, 120, 20];
const BAD: RGB = [200, 50, 60];

export interface ReportStore {
  store: string;
  conformity: number;
  critical: number;
  medium: number;
  emptyRatio: number;
  backRatio: number;
  shelves: number;
  priority: string;
}

export interface HqReport {
  periode: string;
  summary: { avgProfitability: number; avgEmptyRatio: number; avgBackRatio: number; audits: number; stores: number };
  counts: { stores: number; highRisk: number; critical: number };
  worstStore?: { store: string; conformity: number; critical: number };
  stores: ReportStore[];
  categories: { category: string; conformity: number; critical: number }[];
  timeline: { label: string; conformity: number }[];
  thresholds: { empty: number; back: number };
}

const pct = (v: number) => `${Math.round(v)}%`;

function nowLabel(): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

function header(doc: jsPDF, M: number, W: number, title: string, meta: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('ShelfGuide HQ', M, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text('RAPPORT DIRECTION RESEAU', W - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.setTextColor(...INK);
  doc.text(title, M, 66);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(meta, M, 84);
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.line(M, 94, W - M, 94);
}

function sectionTitle(doc: jsPDF, M: number, y: number, label: string) {
  doc.setFillColor(...ACCENT);
  doc.rect(M, y - 9, 3, 12, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...INK);
  doc.text(label, M + 9, y);
}

function kpiRow(doc: jsPDF, M: number, y: number, W: number, items: { label: string; value: string; tone?: RGB }[]) {
  const gap = 12;
  const h = 60;
  const n = items.length;
  const w = (W - M * 2 - gap * (n - 1)) / n;
  items.forEach((it, i) => {
    const x = M + i * (w + gap);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.8);
    doc.setFillColor(248, 251, 251);
    doc.roundedRect(x, y, w, h, 4, 4, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(it.label.toUpperCase(), x + 12, y + 18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(...(it.tone ?? INK));
    doc.text(it.value, x + 12, y + 44);
  });
  return y + h;
}

function sparkline(doc: jsPDF, M: number, y: number, W: number, points: { label: string; conformity: number }[]) {
  const h = 96;
  const x = M;
  const w = W - M * 2;
  doc.setDrawColor(...RULE);
  doc.setLineWidth(0.8);
  doc.setFillColor(248, 251, 251);
  doc.roundedRect(x, y, w, h, 4, 4, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('EVOLUTION DE LA CONFORMITE RESEAU', x + 12, y + 16);

  const padL = x + 34;
  const padR = x + w - 14;
  const top = y + 26;
  const bottom = y + h - 20;
  const innerH = bottom - top;
  [0, 50, 100].forEach((g) => {
    const gy = bottom - (g / 100) * innerH;
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.4);
    doc.line(padL, gy, padR, gy);
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.text(String(g), padL - 6, gy + 2, { align: 'right' });
  });
  if (points.length === 0) return y + h;
  const span = padR - padL;
  const step = points.length > 1 ? span / (points.length - 1) : 0;
  const px = (i: number) => padL + step * i;
  const py = (v: number) => bottom - (Math.max(0, Math.min(100, v)) / 100) * innerH;
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(1.6);
  for (let i = 1; i < points.length; i++) doc.line(px(i - 1), py(points[i - 1].conformity), px(i), py(points[i].conformity));
  doc.setFillColor(...ACCENT);
  points.forEach((p, i) => {
    doc.circle(px(i), py(p.conformity), 1.8, 'F');
    if (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) {
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
      doc.text(p.label, px(i), bottom + 12, { align: 'center' });
    }
  });
  return y + h;
}

function bullets(doc: jsPDF, M: number, y: number, W: number, lines: string[]) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  let cy = y;
  lines.forEach((line) => {
    doc.setFillColor(...ACCENT);
    doc.circle(M + 3, cy - 3, 1.6, 'F');
    doc.setTextColor(...INK);
    const wrapped = doc.splitTextToSize(line, W - M * 2 - 14);
    doc.text(wrapped, M + 12, cy);
    cy += wrapped.length * 13 + 6;
  });
  return cy;
}

function footer(doc: jsPDF, M: number, W: number, H: number) {
  const total = doc.getNumberOfPages();
  const stamp = nowLabel();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setDrawColor(...RULE);
    doc.setLineWidth(0.6);
    doc.line(M, H - 30, W - M, H - 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text('ShelfGuide HQ — Rapport confidentiel', M, H - 18);
    doc.text(`Genere le ${stamp}`, W / 2, H - 18, { align: 'center' });
    doc.text(`Page ${i} / ${total}`, W - M, H - 18, { align: 'right' });
  }
}

function recommendations(data: HqReport): string[] {
  const out: string[] = [];
  if (data.counts.highRisk > 0 && data.worstStore) {
    out.push(`${data.counts.highRisk} magasin(s) en priorite haute : declencher un plan d'action, en commencant par "${data.worstStore.store}" (${pct(data.worstStore.conformity)} de conformite, ${data.worstStore.critical} audits critiques).`);
  } else {
    out.push('Aucun magasin en priorite haute : reseau stable, maintenir le pilotage actuel.');
  }
  const weak = data.categories[0];
  if (weak) out.push(`Categorie la plus faible du reseau : "${weak.category}" (${pct(weak.conformity)} de conformite) — aligner les directeurs concernes.`);
  if (data.summary.avgEmptyRatio >= data.thresholds.empty * 0.7) {
    out.push(`Vide moyen reseau eleve (${pct(data.summary.avgEmptyRatio)}) : standardiser les tournees de reapprovisionnement.`);
  }
  out.push(`Perimetre analyse : ${data.counts.stores} magasins, ${data.summary.audits} audits sur la periode "${data.periode}".`);
  return out;
}

export function generateHqReport(data: HqReport): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;

  header(doc, M, W, 'Pilotage performance reseau', `Perimetre : Reseau complet   •   Periode : ${data.periode}   •   Edite le ${nowLabel()}`);

  let y = 122;
  sectionTitle(doc, M, y, 'Synthese reseau');
  y += 14;
  y = kpiRow(doc, M, y, W, [
    { label: 'Conformite', value: pct(data.summary.avgProfitability), tone: data.summary.avgProfitability >= 85 ? OK : data.summary.avgProfitability >= 65 ? WARN : BAD },
    { label: 'Risque haut', value: String(data.counts.highRisk), tone: data.counts.highRisk > 0 ? BAD : OK },
    { label: 'Alertes critiques', value: String(data.counts.critical), tone: data.counts.critical > 0 ? BAD : OK },
    { label: 'Vide moyen', value: pct(data.summary.avgEmptyRatio), tone: WARN },
  ]);

  y += 22;
  y = sparkline(doc, M, y, W, data.timeline);

  y += 30;
  sectionTitle(doc, M, y, 'Magasins prioritaires');
  y += 8;
  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [['Magasin', 'Conformite', 'Critiques', 'Vide', 'Back', 'Rayons', 'Priorite']],
    body: data.stores.map((s) => [s.store, pct(s.conformity), String(s.critical), pct(s.emptyRatio), pct(s.backRatio), String(s.shelves), s.priority]),
    theme: 'plain',
    headStyles: { fillColor: ACCENT, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
    didParseCell: (h) => {
      if (h.section === 'body' && h.column.index === 6) {
        const v = String(h.cell.raw);
        h.cell.styles.textColor = v === 'Haute' ? BAD : v === 'Moyenne' ? WARN : OK;
        h.cell.styles.fontStyle = 'bold';
      }
    },
  });

  // @ts-expect-error lastAutoTable is augmented by jspdf-autotable at runtime
  y = (doc.lastAutoTable?.finalY ?? y) + 30;
  if (y > H - 220) { doc.addPage(); y = 60; }

  sectionTitle(doc, M, y, 'Recommandations');
  y += 18;
  y = bullets(doc, M, y, W, recommendations(data));

  if (data.categories.length > 0) {
    y += 14;
    if (y > H - 160) { doc.addPage(); y = 60; }
    sectionTitle(doc, M, y, 'Categories sous performance');
    y += 8;
    autoTable(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [['#', 'Categorie', 'Conformite', 'Critiques']],
      body: data.categories.map((c, i) => [String(i + 1), c.category, pct(c.conformity), String(c.critical)]),
      theme: 'plain',
      headStyles: { fillColor: INK, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
      styles: { fontSize: 8.5, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.4 },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles: { 0: { cellWidth: 28 }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
  }

  footer(doc, M, W, H);
  doc.save(`rapport-reseau-${new Date().toISOString().slice(0, 10)}.pdf`);
}
