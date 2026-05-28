// Deprecation banner printer for legacy CLI command invocations.
//
// Used by the top-level dispatcher when the user types `mcpverify run ...`
// (legacy alias) — prints exactly one line to stderr explaining the
// canonical form, then forwards to the new handler.

export function printDeprecationWarning(detail: string): void {
  process.stderr.write(`[deprecation] ${detail}\n`);
}
