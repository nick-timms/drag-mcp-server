# DragApp MCP Server

MCP server exposing DragApp shared-inbox tools to AI clients. TypeScript, published to npm as `@dragapp/mcp-server`.

## ⚠️ Guardrails — this repository is PUBLIC

Everything here — every file, every commit, every published npm tarball — is **world-readable**. Treat it that way. The git history was reset once already to remove leaked internal details; do not reintroduce them.

**Never reference internal systems.** Do not mention these internal repository names anywhere in code, comments, tests, docs, or commit messages:

- `Dragsters-backend`
- `drag-web`
- `drag-automations`
- `drag-marketing`
- `Drag-pub-sub`
- `drag-chat`

**Never reference internal implementation symbols.** Do not name internal backend functions/classes such as:

- `CreateCardMapper`
- `fetchTaskDetails`
- `SendAsEmailContent`

When you need to explain *why* the code does something, describe the observable behavior of the public API (`https://app.dragapp.com`) — not the internal system that produces it. "The backend returns X" is fine; "`SomeInternalClass` in `some-internal-repo` returns X" is not.

**Never hardcode credentials.** All secrets come from the environment — always `process.env.DRAG_API_KEY`, never a literal token, key, or `JWTSECRET`. There are no exceptions, including in tests or examples (use obvious placeholders like `your-api-key`).

**Never commit `.env`.** Only `.env.example` (placeholders) is tracked. Real `.env`, `*.pem`, `*.hex`, `*.key`, and `*privkey*` files must never be staged.

## Mechanical enforcement

These guardrails are backed by tooling so they can't be bypassed by accident:

- **`.gitignore`** — blocks `.env`, key material, and build artifacts from ever being staged.
- **Pre-commit hook** (`.pre-commit-config.yaml` + `.gitleaks.toml`) — gitleaks scans staged changes for the forbidden terms above *and* generic secrets (keys, JWTs, tokens). Install with `pip install pre-commit && pre-commit install`.
- **`prepublishOnly` tarball guard** (`scripts/check-tarball.mjs`) — `npm publish` packs the tarball, greps the compiled `dist/` + `package.json` for the forbidden terms, and aborts if any are found. This is the check that would have caught the original npm leak (comments survive into compiled output).
- **CI** (`.github/workflows/secret-scan.yml`) — gitleaks runs on every push and pull request.

If you add a new internal name that must be blocked, add it in **both** `.gitleaks.toml` and `scripts/check-tarball.mjs` (they share one canonical list).
