// Mirror of the server-side scope vocabulary in worker/lib/export-scope.ts.
// Kept as a separate type-only file (the worker isn't importable from the
// frontend build) — if a kind is added there, add it here too.

export type ExportScope =
  | { kind: 'folder'; folder_id: string | null } // null = 未分類
  | { kind: 'bookmarks' }
  | { kind: 'notes' }
  | { kind: 'highlights' }
  | { kind: 'wrong'; year?: number; group?: string; tags?: string[] }
  | { kind: 'year'; year: number }
  | { kind: 'exam'; session_id: string; only_wrong?: boolean }
  | { kind: 'ids'; ids: string[]; label?: string };

export type ExportFormat = 'md' | 'csv' | 'html';

export type ExportPreview = {
  count: number;
  ids: string[];
  label: string;
  truncated: boolean;
  max: number;
};
