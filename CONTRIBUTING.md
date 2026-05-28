# Contributing to `@mcp-verify/sdk`

Thanks for your interest in contributing. The SDK is the protocol relay between your machine and the MCPVerify cloud — it captures the JSON-RPC trace from your MCP server, ships it for scoring, and prints a report URL.

## Quick start

```bash
git clone https://github.com/Ruturajs4/mcpverify.git
cd mcpverify
pnpm install
pnpm -r typecheck
pnpm -r build
node packages/sdk/dist/cli.js --help
```

The SDK has **zero non-dev dependencies**. Please don't add runtime deps without prior discussion — distribution simplicity is a feature.

## Commit messages

Conventional commits:

- `feat(sdk): add --transport http`
- `fix(sdk): handle EPIPE on Windows stdio child kill`
- `chore(sdk): bump version`
- `docs(sdk): clarify --bearer vs --auth oauth`

## Tests

Every behavior change adds or updates a test. The SDK uses smoke scripts at the repo root (`packages/studio-runner/smoke-test.mjs`, `tools/stress-stdio.mjs`) and per-package unit tests where they exist. Run them locally before opening a PR.

## Code style

- TypeScript strict mode is on. Don't loosen it.
- No `any` without an explicit reason in a comment.
- Match the existing file structure: one runtime concern per file (`transport.ts`, `oauth.ts`, `client.ts`).
- Format with the project's Prettier config (`pnpm exec prettier --write <file>`).

## Reporting bugs

File a GitHub issue with: SDK version (`mcpverify --version`), Node version, target MCP server transport + URL/command (redact secrets), the full stderr output. Include the produced `runId` if the SDK reached the cloud.

## Security

Found a vulnerability? Please do not file a public issue. Email `security@mcpverify.dev` with the details and we'll acknowledge within 48 hours.

## License

By contributing you agree your contributions will be licensed under the Apache License 2.0 (the same license that covers the SDK itself).
