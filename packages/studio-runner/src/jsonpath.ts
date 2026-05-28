// JSONPath wrapper — isolates `jsonpath-plus` behind a stable interface so a
// future library swap (e.g. to `jsonpath-rfc9535`) is cheap.
//
// SECURITY: we always pass `eval: false`. The two recent jsonpath-plus CVEs
// (-21534, -1302) only triggered on user-controlled paths into eval mode; we
// evaluate author-controlled paths only, but disable eval defensively anyway.

import { JSONPath } from 'jsonpath-plus';

/**
 * Returns the array of matches. Paths starting without `$.` are normalized to
 * `$.<rest>` for legacy-compatibility with the existing dotted binding syntax
 * (e.g. `result.users[0].id` -> `$.result.users[0].id`). A bare `$` is allowed.
 */
export function evalJsonpath(path: string, doc: unknown): unknown[] {
  const normalized = normalizePath(path);
  try {
    // `wrap: true` ensures the return is always an array (single matches included).
    // jsonpath-plus' `json` type is overly narrow; we cast to satisfy it without
    // pulling in `any` everywhere.
    const result = JSONPath({
      path: normalized,
      json: doc as object,
      eval: false,
      wrap: true,
    });
    return Array.isArray(result) ? result : [];
  } catch {
    // Malformed paths return [] — the evaluator surfaces this as a fail with a
    // clear "path did not match" reason rather than crashing the runner.
    return [];
  }
}

/**
 * Returns the first match, or undefined if the path matched nothing. Useful
 * for value-bearing operators (equals/regex/contains) where we evaluate against
 * a single scalar.
 */
export function evalJsonpathOne(path: string, doc: unknown): unknown | undefined {
  const matches = evalJsonpath(path, doc);
  return matches.length > 0 ? matches[0] : undefined;
}

/**
 * Normalize a JSONPath. Public so the runner's `{{stepN.foo.bar}}` interpolation
 * can call it directly without having to know the rules.
 */
export function normalizePath(path: string): string {
  if (!path) return '$';
  if (path === '$') return '$';
  if (path.startsWith('$')) return path;
  // Bare dotted access -> rooted JSONPath. Handle bracket-first too (`[0].x`).
  if (path.startsWith('[')) return `$${path}`;
  return `$.${path}`;
}
