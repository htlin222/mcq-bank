// Category labels and per-group badge colours derive from
// `config.toml [groups].list` (parsed at build time in vite.config.ts).
// Everything UI-visible about group categorization flows from here so a
// fork can rebrand by editing config.toml — no .tsx changes required.

import { config, type GroupSpec } from '../config';

export type Group = GroupSpec & {
  // Index in the configured list — drives badge colour assignment.
  index: number;
};

const FALLBACK: GroupSpec[] = [{ label: '全部', count: 0 }];

export const GROUPS: Group[] = (config.groups?.length ? config.groups : FALLBACK).map(
  (g, index) => ({ ...g, index }),
);

export const GROUP_LABELS: string[] = GROUPS.map((g) => g.label);

export const TOTAL_EXAM_COUNT: number = GROUPS.reduce((sum, g) => sum + g.count, 0);

export function isGroupLabel(value: string | null | undefined): value is string {
  return !!value && GROUP_LABELS.includes(value);
}

// Stable colour assignment by index, so the first configured group is
// always amber, the second sky, etc. Wraps after 4 — projects with more
// than 4 categories should extend this palette.
const BADGE_PALETTE = [
  'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
] as const;

export function groupBadgeClass(label: string | null | undefined): string {
  const i = GROUP_LABELS.indexOf(label ?? '');
  if (i < 0) return BADGE_PALETTE[0];
  return BADGE_PALETTE[i % BADGE_PALETTE.length];
}

// Build an Exam.tsx-style {<label>: <count>} record from config — used
// when the UI needs to count questions per category for a selection set.
export function groupCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of GROUPS) out[g.label] = g.count;
  return out;
}
