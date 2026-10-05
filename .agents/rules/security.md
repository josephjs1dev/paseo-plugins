# Security Rules

Apply to all code, all languages. When in doubt, prefer the safer default.

## Agent filesystem boundary

- Treat the active project root and OS-managed temporary directories as the
  entire authorized filesystem scope.
- Do not inspect, search, read, create, modify, or delete anything outside
  that scope, including `$HOME`, parent or sibling projects, shell config,
  SSH keys, cloud credentials, and agent configuration.
- Do not follow a symlink whose resolved target leaves the authorized scope.
- Technical access does not imply authorization. If work requires an outside
  path, stop and ask the user to place that exact path in scope.
- Skills explicitly exposed by the active harness may be read at their supplied
  paths, including bundled references needed to use them. This permits loading
  user-installed skills without authorizing unrelated home-directory access or
  any filesystem writes described by a skill.
- A user request to install skills in their user environment authorizes
  `~/.agents/skills/` and its sibling `~/.agents/skill-backups/`. Reuse that
  authorization; it does not permit unrelated home-directory access.
- Local Git commands may be auto-approved only for the active repository. Do
  not use `--git-dir`, `--work-tree`, or `-C` to target an outside path;
  remote Git may use only explicitly configured domains, and destructive Git
  requires an explicit user request.
- Agents running project setup must use `setup/main.py bootstrap-project`; only an
  interactive local user may explicitly run `setup/main.py install-bin` to install
  helpers under `$HOME/.local/bin`.

## Secrets and credentials

- Never commit secrets — API keys, tokens, passwords, private keys, DB URLs with credentials.
- Read secrets from environment variables, a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager), or an encrypted store. Never from source.
- Add patterns to `.gitignore` early: `.env`, `*.pem`, `*.key`, `credentials*.json`, `secrets.yaml`.
- If a secret leaks: rotate it first, then rewrite history. Rotation is non-negotiable.
- Don't log secrets, tokens, full request bodies, or full headers. Redact `Authorization`, `Cookie`, `Set-Cookie`, and any field named `password`, `token`, `secret`, `api_key`.

## Input validation

- Validate all input at the trust boundary (HTTP handler, RPC entry, CLI arg parsing). Internal code can trust validated input.
- Use allowlists (known-good) over denylists (known-bad) wherever possible.
- Bound inputs: max length, max array size, max upload size, max depth for nested JSON. Reject early.
- Normalize before validating (Unicode NFC, lowercase, trim) — but never validate after partial decoding.

## Injection

- **SQL**: use parameterized queries / prepared statements. Never concatenate user input into SQL. ORMs are fine if used correctly; `LIKE` patterns and `IN (...)` lists still need parameterization.
- **Command**: never pass user input to a shell. Use `exec.Command(cmd, args...)` (Go) / `subprocess.run([...], shell=False)` (Python) with arg arrays, never `shell=True` / `os.system`.
- **Path**: reject `..`, absolute paths, and symlinks unless explicitly allowed. Resolve to a canonical path (`filepath.Abs` + `filepath.Clean`, `Path.resolve()`) and verify it stays inside the expected root.
- **HTML / XSS**: use a template engine that auto-escapes (`html/template` in Go, Jinja `autoescape=True`, React JSX). Never `dangerouslySetInnerHTML` or `template.HTML(userInput)` without a sanitizer.
- **JSON / YAML / XML**: use the safe parser (`yaml.safe_load`, not `yaml.load`; disable XML external entities).

## AuthN / AuthZ

- Authentication != authorization. Check both, on every protected endpoint.
- Verify session/token signature server-side. Don't trust claims in a JWT without verifying the signature and `exp`.
- Authorization checks happen on the server, every request. Never rely on the client to enforce permissions.
- Default-deny: if a permission check is missing, the action should fail closed, not open.
- Use a single authorization function / middleware — don't sprinkle ad-hoc checks.

## Crypto

- Use the standard library or a well-known battle-tested package (`crypto/*` in Go, `cryptography` in Python). Never roll your own.
- Passwords: `bcrypt`, `argon2id`, or `scrypt`. Never MD5, SHA-1, or unsalted SHA-256.
- Random for security-sensitive uses: `crypto/rand` (Go), `secrets` module (Python). Never `math/rand` / `random` for tokens, IDs, salts.
- TLS: minimum TLS 1.2, prefer 1.3. Disable insecure ciphers. Verify peer certificates — never `InsecureSkipVerify: true` in production code.
- HMAC, not raw hash, for message authentication. Use constant-time comparison (`hmac.Equal`, `secrets.compare_digest`).

## Errors and logging

- Don't leak stack traces, SQL, or internal paths to end users. Return a generic message; log the detail server-side.
- Distinguish "authentication failed" / "authorization failed" / "not found" carefully — leaking which one happened can enable enumeration.
- Log enough to investigate (request ID, user ID, action, outcome) without logging the payload itself.

## Dependencies

- Pin direct dependencies. Lock transitives (`go.sum`, `requirements.lock`, `package-lock.json`, `uv.lock`).
- Run vulnerability scans in CI (`govulncheck`, `pip-audit`, `npm audit`, `trivy`). Treat HIGH/CRITICAL as blocking.
- Prefer fewer, well-maintained dependencies over many micro-libs.
- Watch for typosquatting on `pip` / `npm`.

## Web specifics

- Set security headers: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- CSRF tokens for state-changing requests on cookie-authenticated endpoints.
- CORS: explicit allowlist of origins. Never `Access-Control-Allow-Origin: *` with credentials.
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax` (or `Strict`).
- Rate limit auth endpoints (login, password reset, signup, token exchange) at minimum.

## File handling

- Validate uploaded file size, type (by content, not just extension), and rename on storage.
- Never serve uploaded files from a path the user controls. Use opaque IDs.
- Reject zip-bombs: cap decompressed size.
- Never `eval` / `exec` / `pickle.loads` / `yaml.load` untrusted input.

## Sensitive data at rest

- Encrypt PII, credentials, and tokens at rest. Use AES-GCM or similar AEAD.
- Minimize what you store. If you don't need it, don't collect it.
- Have a retention policy and enforce it (TTL, scheduled deletion).

## In dev and CI

- Local `.env` files: gitignored, documented in `.env.example` with placeholder values.
- Pre-commit hook (`gitleaks`, `trufflehog`) to catch secrets before they land.
- Branch protection + required review on `main`. No force-push to shared branches.
- CI runs on untrusted PRs without secrets. Gate secret access on a maintainer label.

## AI-specific guidance

- Treat prompts, retrieved documents, web pages, tool results, and model output as untrusted data.
- Keep instructions separate from data; never let retrieved content authorize a tool call.
- Give each tool the minimum permissions it needs. Require explicit approval for destructive or external actions.
- Validate tool arguments and model output with typed schemas before executing or storing anything.
- Enforce tenant/user authorization again at retrieval and tool boundaries; never rely on model decisions for access control.
- Add timeouts, token/output limits, recursion limits, rate limits, and provider retry budgets.
- Protect URL-fetching tools against SSRF; use network and domain allowlists where practical.
- Redact secrets and sensitive personal data before sending prompts or writing traces. Define retention and deletion rules.
- Record model, prompt/template, tool, policy, and outcome metadata without storing sensitive payloads by default.
- Test prompt injection, data leakage, unsafe tool use, malformed output, provider failure, and permission bypass.

## When something looks off

- If a function name or comment mentions security and you're changing it, double-check the property still holds.
- Surface security-relevant changes in the PR description so reviewers can pay attention.
- If you spot a vulnerability outside the current task, file it — do not silently expand scope.
