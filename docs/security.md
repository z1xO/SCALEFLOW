# Security model

What ScaleFlow does, how it is tested, and - just as important - what it does **not** do yet.

## Implemented and tested

| Control              | Implementation                                                                                                                                                                                                                                                                    | Test                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Password storage     | scrypt (N=2^17, r=8, p=1 by default), 16-byte random salt, parameters stored in the hash so the cost can be raised; rehash on login when the stored cost is lower                                                                                                                 | `unit/lib.test.ts`                                             |
| Login enumeration    | Unknown emails are verified against a dummy hash; identical error message for wrong password and unknown user                                                                                                                                                                     | `auth.test.ts`                                                 |
| Sessions             | 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` required when `NODE_ENV=production`); only SHA-256 of the token is stored; logout revokes server-side and evicts the cache                                                                                 | `auth.test.ts`                                                 |
| CSRF                 | Cookie-authenticated `POST/PATCH/DELETE` must carry an `Origin` in `CORS_ORIGINS`; SameSite=Lax as a second layer                                                                                                                                                                 | `auth.test.ts`                                                 |
| API keys             | `sf_` + 256 bits of randomness; shown once; SHA-256 stored (fast hash is appropriate for high-entropy secrets); scopes; expiry; revocation effective immediately (auth cache evicted); rotation with a grace period                                                               | `auth.test.ts`                                                 |
| Tenant isolation     | Every query filters on `project_id`; cross-project access returns 404 so ids cannot be probed; roles `owner`/`developer`/`viewer`; membership cache invalidated on change                                                                                                         | `tenancy.test.ts`, `realtime.test.ts`, E2E                     |
| SQL injection        | Parameterised queries only (node-postgres placeholders); dynamic SQL is built from fixed fragments, never from input                                                                                                                                                              | review + lint                                                  |
| Input validation     | Zod schemas on every route (body, query, params, headers); handler-specific payload schemas; 1 MiB body limit, 64 KiB payload limit                                                                                                                                               | `jobs-api.test.ts`                                             |
| Rate limiting        | Per API key / user / IP in Redis, stricter on auth routes; fails open if Redis is down (availability over strictness - documented trade-off)                                                                                                                                      | `limits.test.ts`                                               |
| SSRF (webhooks)      | Destination resolved and checked against private, loopback, link-local (incl. `169.254.169.254`), CGNAT, multicast and reserved ranges **at connect time** (custom DNS lookup on the HTTP agent, so DNS rebinding cannot bypass the check); IP literals checked too; only http(s) | `unit/lib.test.ts` (ranges)                                    |
| Webhook authenticity | HMAC-SHA256 signature over `timestamp.body`, timestamp header for replay windows                                                                                                                                                                                                  | -                                                              |
| Error hygiene        | Problem-details responses never include stack traces, SQL or internal hostnames; unexpected errors become a generic 500 with a request id                                                                                                                                         | `auth.test.ts` (no password echo), review                      |
| Log hygiene          | pino redaction of `authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `key`, `payload`; job payloads and results are never logged                                                                                                                             | review                                                         |
| Response headers     | API: `x-request-id`; dashboard: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`                                                                                                                                                                              | -                                                              |
| Network exposure     | Local development binds the API, dashboard and metrics servers to `127.0.0.1`; docker compose publishes every port on `127.0.0.1` only; Postgres and Redis are never exposed beyond the host; webhooks to private addresses are blocked by default, even locally                  | verified with `Get-NetTCPConnection` and a LAN-address request |
| Secrets              | Only from environment variables; `.env` is git-ignored; production refuses to start with the development webhook secret or without `COOKIE_SECURE`                                                                                                                                | `config/env.ts`                                                |
| Dependencies         | Exact versions + lockfile; `npm audit --omit=dev --audit-level=high` and dependency review in CI; Dependabot                                                                                                                                                                      | CI                                                             |
| Audit trail          | API key create/revoke/rotate, member changes, manual cancel/retry, schedule changes written to `audit_log` with actor and IP                                                                                                                                                      | `jobs-api.test.ts`                                             |

## Development authentication vs production

The email + password + session cookie flow is **development / self-hosted grade**. It is reasonable
for a single team running ScaleFlow internally. Before offering ScaleFlow to external customers you
would add:

- SSO (OIDC/SAML) and MFA; account lockout / progressive delays per account (rate limits are
  per IP and per principal today, not per target account).
- Email verification and password reset (not implemented - registration accepts any email).
- Session management UI (list and revoke sessions), shorter absolute lifetimes, idle timeouts.
- Per-project webhook signing secrets (today one server-wide secret signs all webhooks).
- A secrets manager / KMS for `WEBHOOK_SIGNING_SECRET` and database credentials, and encryption of
  job payloads at rest if they may contain personal data.
- Fine-grained API key scopes (per queue / per job type), IP allow-lists.
- A content security policy for the dashboard.
- External penetration testing. **No security guarantee beyond the tests listed above is claimed.**

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
