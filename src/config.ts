import type { GroupKey } from './dashboard';

export const dashboardConfig = {
  title: 'Dashboard HQ',
  subtitle: 'Vue reseau, magasins a risque et categories sous performance.',
  eyebrow: 'ShelfGuide HQ',
  scopeLabel: 'Perimetre reseau',
  storeName: '',
  category: '',
  primaryGroup: 'store_name' as GroupKey,
  primaryTitle: 'Magasins a risque',
  secondaryGroup: 'category' as GroupKey,
  secondaryTitle: 'Categories reseau faibles',
  riskTitle: 'Audits critiques reseau',
  recentTitle: 'Derniers audits synchronises',
  limit: 1000,
};
