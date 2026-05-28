// Backward-compat translator for legacy test-case shapes.
//
// Old shape (schemaVersion absent or 1):
//   { kind: 'scripted', steps: [...], expected: { mode: 'exact'|'schema'|'semantic', ... } }
//
// New shape (schemaVersion: 2):
//   { kind: 'scripted', steps: [{ ..., assertions: [...] }], schemaVersion: 2 }
//
// The translator folds the legacy top-level `expected:` block into the last
// step's `assertions:` array (scripted) or into the test-case `assertions:`
// array (agentic). It is idempotent: applying twice yields the same result.

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Map a legacy `expected` block to one AssertionExpr. Returns null on unknown shapes.
function expectedToAssertion(exp: unknown): Record<string, unknown> | null {
  if (!isObj(exp)) return null;
  const mode = exp.mode;
  if (mode === 'exact') {
    return { op: 'equals', path: '$', value: exp.value };
  }
  if (mode === 'schema') {
    return { op: 'schema', path: '$', schema: exp.schema };
  }
  if (mode === 'semantic') {
    return { op: 'semantic', rubric: exp.rubric, judge: exp.judge };
  }
  return null;
}

/**
 * Translates a legacy test case (with `expected:`) into the canonical v2 shape.
 * No-ops for documents already at schemaVersion 2 or for non-test-case inputs.
 */
export function translateLegacy(raw: unknown): unknown {
  if (!isObj(raw)) return raw;
  if (raw.schemaVersion === 2) return raw;

  const kind = raw.kind;
  const expected = raw.expected;

  // Scripted: fold expected into the last step.
  if (kind === 'scripted') {
    const steps = Array.isArray(raw.steps) ? (raw.steps as unknown[]).slice() : [];
    // Normalize each step: ensure `assertions` exists (default []).
    const normalizedSteps = steps.map((s) => {
      if (!isObj(s)) return s;
      if (Array.isArray(s.assertions)) return s;
      return { ...s, assertions: [] };
    });

    if (!expected || normalizedSteps.length === 0) {
      return { ...raw, schemaVersion: 2, steps: normalizedSteps, expected: undefined };
    }

    const lastIdx = normalizedSteps.length - 1;
    const lastStep = normalizedSteps[lastIdx];
    // If the last step already has assertions (mid-migration doc), don't double-add.
    if (
      isObj(lastStep) &&
      Array.isArray(lastStep.assertions) &&
      (lastStep.assertions as unknown[]).length > 0
    ) {
      return { ...raw, schemaVersion: 2, steps: normalizedSteps, expected: undefined };
    }

    const newAssertion = expectedToAssertion(expected);
    if (!newAssertion || !isObj(lastStep)) {
      return { ...raw, schemaVersion: 2, steps: normalizedSteps, expected: undefined };
    }

    normalizedSteps[lastIdx] = { ...lastStep, assertions: [newAssertion] };
    return { ...raw, schemaVersion: 2, steps: normalizedSteps, expected: undefined };
  }

  // Agentic: assertions live at the test-case level (no steps).
  if (kind === 'agentic') {
    const existing = Array.isArray(raw.assertions) ? (raw.assertions as unknown[]) : [];
    if (existing.length > 0 || !expected) {
      return { ...raw, schemaVersion: 2, assertions: existing, expected: undefined };
    }
    const newAssertion = expectedToAssertion(expected);
    return {
      ...raw,
      schemaVersion: 2,
      assertions: newAssertion ? [newAssertion] : [],
      expected: undefined,
    };
  }

  // Unknown kind — leave it alone (Zod will reject downstream with a clear error).
  return raw;
}
