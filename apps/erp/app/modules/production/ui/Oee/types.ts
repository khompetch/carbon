export type OeeGroup = {
  id: string;
  name: string;
  runtimeMs: number;
  plannedMs: number;
  downtimeMs: number;
  earnedMs: number;
  good: number;
  scrap: number;
  rework: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

export type OeeTotals = {
  runtimeMs: number;
  plannedMs: number;
  earnedMs: number;
  good: number;
  scrap: number;
  rework: number;
  availability: number | null;
  performance: number | null;
  quality: number | null;
  oee: number | null;
};

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "–";
  return `${(value * 100).toFixed(1)}%`;
}
