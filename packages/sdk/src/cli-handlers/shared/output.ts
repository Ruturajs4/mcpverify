// Shared output helpers — TTY auto-detect, hand-rolled table renderer,
// JSON output. Used by every list/view CLI command.

/**
 * Decide whether to emit JSON or pretty output. Per design D5:
 *  - --json wins over everything → JSON
 *  - --pretty wins next → pretty
 *  - Otherwise, fall back to stdout.isTTY: TTY → pretty, non-TTY → JSON
 */
export function pickOutputFormat(flags: {
  json?: boolean;
  pretty?: boolean;
}): 'json' | 'pretty' {
  if (flags.json) return 'json';
  if (flags.pretty) return 'pretty';
  return process.stdout.isTTY ? 'pretty' : 'json';
}

export function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/**
 * Hand-rolled table renderer. Columns are objects with `header`, `key`
 * (function or string), and optional `width` (min). No deps; no borders.
 * Output is ANSI-color-free by default; pass `colorVerdict: true` to
 * tint pass/fail/warn verdicts.
 */
export interface TableColumn<T> {
  header: string;
  key: (row: T) => string;
  width?: number;
  align?: 'left' | 'right';
}

export function renderTable<T>(rows: T[], cols: TableColumn<T>[]): string {
  if (rows.length === 0) {
    return '(no rows)\n';
  }
  // Compute column widths.
  const widths = cols.map((c) => {
    const headerW = c.header.length;
    const cellW = Math.max(...rows.map((r) => c.key(r).length));
    return Math.max(c.width ?? 0, headerW, cellW);
  });

  const pad = (s: string, width: number, align: 'left' | 'right'): string => {
    if (s.length >= width) return s;
    const filler = ' '.repeat(width - s.length);
    return align === 'right' ? filler + s : s + filler;
  };

  const lines: string[] = [];
  // Header row.
  lines.push(
    cols
      .map((c, i) => pad(c.header.toUpperCase(), widths[i]!, c.align ?? 'left'))
      .join('  '),
  );
  // Data rows.
  for (const row of rows) {
    lines.push(
      cols
        .map((c, i) => pad(c.key(row), widths[i]!, c.align ?? 'left'))
        .join('  '),
    );
  }
  return lines.join('\n') + '\n';
}

/** Truncate a string to `n` chars with a single-char ellipsis. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/** Short hash for IDs in tables ("fc9434f85bf1…"). */
export function shortId(id: string, len = 12): string {
  return id.length <= len ? id : id.slice(0, len) + '…';
}

/** Pretty-print "Xs ago" / "Xm ago" / etc. from a unix-ms timestamp. */
export function relativeTime(epochMs: number | null | undefined): string {
  if (epochMs == null) return '—';
  const delta = Date.now() - epochMs;
  if (delta < 0) return 'just now';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Format `passed/total` with the verdict slug. */
export function verdictSummary(passed: number, total: number, failed: number): string {
  return `${passed}/${total}${failed > 0 ? ` FAIL` : ` PASS`}`;
}
