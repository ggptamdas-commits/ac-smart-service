# AC Smart Service — Production Audit and Repair Specification

## Executive summary

The repository is a compact Cloudflare Worker and D1 application for AC-service customer intake, WhatsApp messaging, AI-assisted triage, technician requests, reminders, and an administrative dashboard. The original code was **not production-ready**. The most serious defects were runtime schema mismatches, a manual-message insert that violated the database `CHECK` constraint, unauthenticated webhook and browser security edge cases, reflected credentialed CORS, incomplete authorization validation, and race-prone reminder and request creation.

A repair branch named `production-audit-fixes` was created. Commit `ece0562` implements the verified high-confidence repairs described below. The branch still requires deployment against a staging D1 database and a real Evolution API test instance before production approval. No production deployment or data migration was executed from this sandbox.

The audit is based on the complete tracked repository: `README.md`, `dashboard/index.html`, `worker-backend/src/index.js`, `worker-backend/src/dashboard-html.js`, `worker-backend/migrations/0001_initial.sql`, `worker-backend/package.json`, and `worker-backend/wrangler.toml`.

## System architecture and data flow

The intended flow is:

```text
Customer WhatsApp message
  -> Evolution API webhook
  -> Cloudflare Worker /webhook/messages
  -> phone normalization and D1 customer lookup
  -> conversation and message persistence
  -> AI or fallback intent handling
  -> server-side validation
  -> service request or human takeover
  -> WhatsApp response and outgoing message persistence
  -> reminder processing by cron or dashboard
  -> dashboard and owner/technician action
  -> audit log
```

The main weaknesses were that the Worker depended on tables and columns absent from migration `0001`, the dashboard source and Worker source were duplicated, the Worker fetched dashboard HTML from the mutable GitHub `main` branch at runtime, and several business operations were implemented as separate check-then-write sequences rather than atomic claims.

## Repository inventory

| File | Purpose | Dependencies | Important areas | Risk assessment |
|---|---|---|---|---|
| `README.md` | Product and deployment description | Cloudflare Workers, D1, Evolution API, AI | Features, URL, security claims | Claims exceeded what the repository demonstrated; no staging or rollback procedure. |
| `dashboard/index.html` | Standalone single-page dashboard | Tailwind CDN, browser Fetch API | Auth, chat, Kanban, reminders, settings, audit UI | Large single file; runtime rendering requires careful escaping and response-shape consistency. |
| `worker-backend/src/index.js` | Worker routes, AI, WhatsApp, auth, reminders | D1 binding, external HTTP APIs | `fetch`, webhook, AI, auth, CRUD, cron | High coupling and several unbounded reads; originally had schema and workflow defects. |
| `worker-backend/src/dashboard-html.js` | Intended dashboard module | HTML import assertion | Default export | Does not actually export the imported `html`; fallback redirect is misleading and may diverge from `dashboard/index.html`. |
| `worker-backend/migrations/0001_initial.sql` | Initial D1 schema | SQLite/D1 | Core tables and indexes | Missing `webhook_logs`, `login_attempts`, `sent_by_admin`, and request idempotency. |
| `worker-backend/migrations/0002_production_audit.sql` | Audit repair migration | D1/SQLite | Runtime tables, unique claims, indexes | Added on the repair branch; must be tested on a staging copy before production. |
| `worker-backend/tests/audit-regressions.mjs` | Static regression checks | Node.js | Schema and security invariants | It is not a D1 integration suite; staging tests remain required. |
| `worker-backend/package.json` | Package metadata and deploy script | Wrangler expected externally | `deploy` | No test, lint, lockfile, or pinned Wrangler dependency. |
| `worker-backend/wrangler.toml` | Worker and D1 configuration | Cloudflare account | D1 binding, cron, vars | Production database ID and public origin are committed configuration; secrets are not present. |

## Complete bug list

| ID | Severity | File / area | Problem | Impact | Repair |
|---|---|---|---|---|---|
| P0-01 | CRITICAL | `0001_initial.sql`, login and webhook routes | Runtime code queried `webhook_logs` and `login_attempts`, but those tables were absent. | Webhooks and login could fail at runtime on a database created from the repository. | Added migration `0002_production_audit.sql`. |
| P0-02 | CRITICAL | Manual customer message route | Inserted `sender = "agent"` although the schema allowed only `customer`, `bot`, `admin`, and `system`; also referenced missing `sent_by_admin`. | Manual technician/admin replies could fail and the UI could report a false success. | Store `sender = "admin"`, remove the missing column dependency, and return a failure when provider delivery fails. |
| P0-03 | CRITICAL | CORS helper | Reflected any request `Origin` and enabled credentials. | A malicious origin could make credentialed cross-origin requests if browser policy permitted the response. | Restrict credentialed responses to the configured production dashboard origin. |
| P0-04 | HIGH | Webhook and service-request creation | Duplicate checks were separate from inserts. | Concurrent workers could create duplicate customers, conversations, or requests. | Added unique webhook event claims, request `source_message_id`, and unique open-conversation/request indexes. |
| P0-05 | HIGH | Reminder processor | Cron and manual processing both performed a check followed by an external send. | Two workers could send the same reminder. | Added a unique reminder key and a pending claim before sending; failed records can be retried. |
| P0-06 | HIGH | Service-request update route | Frontend could request arbitrary status changes and server accepted them. | Completed or cancelled work could be reopened or corrupted. | Added server-side transition validation. |
| P0-07 | HIGH | Fallback AI address extraction | Keyword presence could cause the full customer message to be stored as the address. | A sentence such as “the AC does not cool, street…” could become a false service location. | Fallback now requires a previously verified customer address; otherwise it asks for the address. |
| P0-08 | HIGH | Settings and health responses | Settings initially collected all D1 business settings and health returned database error details/admin count. | Secrets or internal details could reach an authenticated browser or attacker. | Settings now allowlist non-secret fields and mask secret fields; health is generic. |
| P0-09 | HIGH | Login response and inactive users | Login returned the bearer token in JSON and did not reject inactive users before password verification. | Token exposure to page JavaScript increased session theft risk; deactivated users could authenticate. | Cookie remains the transport and inactive users are rejected. |
| P1-01 | HIGH | Time handling | Several queries used SQLite UTC dates while browser and JavaScript date calculations used local runtime behavior. | Riyadh reminder and “completed today” counts could be off by one day. | Added an explicit `Asia/Riyadh` date helper for repaired reminder and dashboard calculations. Remaining date fields should be standardized in a follow-up migration. |
| P1-02 | HIGH | Outgoing messages | Provider timeout/retry and message lifecycle were not modeled as queued/sending/sent/failed with an idempotency key. | A retry or timeout can result in duplicate WhatsApp messages or uncertain delivery. | Current repair records success/failure truthfully; a durable outbound-message queue remains required before high-volume production. |
| P1-03 | HIGH | Webhook failure status | Webhook rows are claimed, but the processing path does not consistently update them to `processed` or `failed`. | Operational recovery and incident diagnosis are incomplete. | Add a `finally`/failure update around the full processing transaction in the next iteration. |
| P1-04 | HIGH | Customer/conversation concurrency | Two distinct incoming messages for a new phone can race before the unique customer insert. | One request can fail with a uniqueness error rather than reloading the existing customer. | Catch unique-conflict insertion and reload by normalized phone; add an integration concurrency test. |
| P1-05 | HIGH | Native AI tool validation | Native tools exist for Anthropic and OpenAI, but provider failures, malformed tool arguments, and multiple tool calls are not normalized through one schema validator. | Malformed or adversarial model output can cause lost responses or inconsistent state. | Define a shared schema, validate all fields and tool names, reject unknown properties, and persist an AI decision event. |
| P1-06 | MEDIUM | Human takeover | Incoming messages are saved while takeover is active, which is correct, but conversation selection uses the first customer conversation and there is no explicit closed-conversation reopen policy. | Historical and active conversations can be mixed. | Add an active-conversation unique lookup and an explicit reopen/close policy. |
| P1-07 | MEDIUM | API pagination | Customers and service requests are capped or returned without pagination; messages are returned unbounded. | Large accounts will load slowly and may exceed Worker response limits. | Add cursor pagination and dashboard incremental loading. |
| P1-08 | MEDIUM | External dashboard source | Worker fetches `dashboard/index.html` from GitHub `main` at runtime. | A branch change or GitHub outage can change or break the production UI. | Bundle a versioned dashboard asset or store an administrator-controlled, integrity-checked artifact in Worker assets. |
| P2-01 | MEDIUM | `dashboard-html.js` | The imported HTML is not returned; the module always exports a fallback redirect. | The supposed generated/bundled source is not authoritative. | Choose one source of truth and add a build check that compares the served artifact. |
| P2-02 | MEDIUM | Dashboard UI | Most database-controlled values are escaped, but the single-file UI has no automated browser test for 320–1440px layouts, loading states, or permissions. | Regressions can affect technicians on mobile and viewers using read-only workflows. | Add Playwright smoke tests and responsive screenshots. |
| P2-03 | LOW | Operational hygiene | No pinned Wrangler dependency, lockfile, lint configuration, or deploy smoke test is included. | Reproducibility and release confidence are reduced. | Add pinned tooling, CI syntax checks, D1 migration checks, and staging smoke tests. |

## Database audit

The initial schema correctly has a unique normalized customer phone and foreign keys, and it constrains customer, conversation, message, and request statuses. It did not, however, encode enough idempotency for the external event workflows. The repair migration adds `webhook_logs`, `login_attempts`, `service_requests.source_message_id`, an active-conversation unique index, a reminder uniqueness key, and operational indexes.

The database still has these design limitations:

1. `updated_at` values depend on application writes; they are not automatically maintained by database triggers.
2. `payment_status` has no `CHECK` constraint, so arbitrary values can be stored.
3. `technician_assigned` is free text rather than a foreign key to a technician table. This is acceptable for a prototype but weak for assignment history and deactivation workflows.
4. Deleting a customer cascades messages and service requests. That may be inconsistent with legal retention and audit requirements. Production should prefer soft deletion.
5. Sessions are cleaned only by the repair migration’s one-time statement. A scheduled cleanup should be added.
6. The migration does not include a durable outbound-message table, so provider retries remain difficult to make exactly-once from the business perspective.

## Customer journey findings

A greeting alone does not create a request, which matches the intended behavior. An issue without a verified address asks for an address. The native AI path can create a request only after server validation. The repaired fallback no longer invents an address, but it consequently cannot reliably extract a brand-new address without a real model provider; this is safer than false creation and should be covered by a customer-facing prompt.

Existing customers are looked up by normalized phone. Address changes are not yet a fully confirmed workflow: a customer update endpoint can overwrite the address directly, and the AI customer-update path should use a confirmation state rather than accepting a single untrusted model field. Human takeover and resume are server-side role-protected and the webhook checks takeover before AI execution.

## Technician and owner findings

The request record contains issue, address, preferred and scheduled time, technician text, costs, payment status, notes, and status. The dashboard exposes these fields in a Kanban modal. The server now prevents invalid status transitions. It does not yet enforce that a scheduled request has a scheduled date/time or that a completed request has final-cost/payment completion data. Those are business validations to add after the owner confirms policy.

The owner dashboard shows customers, active conversations, pending and scheduled requests, completed-today count, and due reminders. It does not expose failed WhatsApp sends, failed reminders, provider health, database latency, or human-takeover counts as first-class overview cards. Audit logs exist, but the endpoint is not filtered by role or paginated beyond a fixed 50-row window.

## AI and prompt-injection findings

The implementation uses native tool structures for both Anthropic and OpenAI, which is stronger than asking for JSON inside ordinary text. The model remains untrusted: tool names and arguments must be validated server-side, and the current code does validate the core request fields before insertion. The fallback engine is deterministic and now avoids unsafe address persistence.

The injection filter is only pattern-based and English-heavy. It will not cover all Arabic, Bengali, encoded, or indirect attacks. The system prompt and credentials are not returned by the API, but customer text is placed in model history. The next iteration should delimit all customer content as untrusted data, avoid placing secrets in prompts, validate structured output with a strict schema, and test multilingual injection variants.

## WhatsApp and webhook findings

Phone normalization handles the requested Saudi forms, including `00966`, `966`, `05`, and `5` prefixes, and stores the canonical number for lookup. The webhook now requires a configured secret and claims the event ID through a unique table. The secret is also accepted through a query parameter, which should be removed because URLs leak through logs and browser history; use a header-only secret or a provider signature instead.

Outgoing Evolution API integration uses `/message/sendText/{instance}` with an API key header and a JSON text payload. Exact compatibility with the deployed Evolution API version could not be verified without a live provider instance. The code has no timeout, bounded retry policy, or durable outbound idempotency record. These are production requirements before sending customer-critical notices.

## Authentication, authorization, and security

Password hashes use per-password random salts and PBKDF2-SHA-256. Sessions are random, HttpOnly, Secure, SameSite cookies with database expiration and logout deletion. Login throttling depends on the repaired `login_attempts` table. Admin, manager, and viewer checks are enforced on most mutation routes.

The principal remaining security items are the lack of CSRF tokens for cookie-authenticated state changes, incomplete role review for every read endpoint, no account-level rate limiter on all authenticated APIs, and the webhook query-string secret. Same-origin dashboard requests reduce CSRF exposure but do not replace an explicit CSRF defense when cross-origin policies or future clients change.

Dashboard rendering uses `escapeHtml` for customer-controlled text in the reviewed dynamic templates. The static audit found no remaining reflected wildcard CORS response. A real browser XSS test with `<img src=x onerror=alert(1)>` is still required.

## API inventory summary

| Endpoint group | Methods | Auth / role | Main data | Main residual risk |
|---|---|---|---|---|
| `/api/health` | GET | Public | D1 connectivity | Generic response is safe; add external-provider health separately. |
| `/api/auth/login` | POST | Public | `admin_users`, `sessions`, `login_attempts` | Needs staging brute-force and inactive-user tests. |
| `/api/auth/logout`, `/api/auth/me` | POST, GET | Session | `sessions`, `admin_users` | Cookie CSRF and session cleanup need integration tests. |
| `/api/settings` | GET, POST | Auth; POST admin | `business_settings` | Secret write validation and URL allowlisting remain. |
| `/api/settings/test-*` | POST | Admin | External provider | Needs timeout, SSRF/URL validation, and error tests. |
| `/api/customers*` | GET, POST, PUT | Auth; mutations admin/manager | `customers` | Add field length/schema validation and soft deletion. |
| `/api/customers/:id/messages` | GET, POST | Auth; POST admin/manager | `messages`, Evolution API | Add pagination and durable outbound lifecycle. |
| `/api/customers/:id/takeover`, `resume-ai` | POST | Admin/manager | `customers`, `conversations`, audit | Add existence checks and state conflict handling. |
| `/api/service-requests*` | GET, POST, PUT | Auth; mutations admin/manager | `service_requests`, `customers` | Add required schedule/completion business rules. |
| `/api/reminders/settings`, `/logs`, `/trigger` | GET, PUT, POST | Auth; settings admin, trigger admin/manager | Reminder tables, WhatsApp | Claiming is repaired; add operational retry metrics. |
| `/api/bot-config*` | GET, POST, PUT | Auth; mutations admin | `bot_flow_config` | Enforce key allowlist and maximum prompt size. |
| `/api/audit-logs` | GET | Auth | `audit_logs` | Add role policy, pagination, and tamper-evident export. |
| `/webhook/messages` | POST | Shared secret | All customer/message tables | Replace query-string secret and add provider signature verification. |

## Implemented repair specification

The branch implements the following exact changes:

1. `worker-backend/migrations/0002_production_audit.sql` creates missing runtime tables, adds request idempotency, active-conversation and reminder uniqueness, and indexes for login, webhook, request, and message lookups.
2. `worker-backend/src/index.js` restricts credentialed CORS, removes sensitive health details, rejects inactive users, removes the JSON bearer-token response, masks settings, validates status transitions, validates manual request customers and required fields, records manual messages with the legal `admin` sender, returns provider failures, claims webhook events, claims reminders, retries failed reminder rows, and uses Riyadh business dates in repaired paths.
3. `dashboard/index.html` uses same-origin credentials and correctly handles object-shaped reminder and bot-configuration responses.
4. `worker-backend/tests/audit-regressions.mjs` checks the repaired schema and security invariants without requiring production credentials.

## Test matrix and current status

| Area | Test | Current status |
|---|---|---|
| Syntax | `node --check worker-backend/src/index.js` | Passed. |
| Static regressions | `node worker-backend/tests/audit-regressions.mjs` | Passed. |
| Patch hygiene | `git diff --check` | Passed before commit. |
| D1 migration execution | Apply migrations to SQLite/D1 | Not run; `sqlite3` is not installed in the sandbox. Must run against staging D1. |
| Login | Valid, invalid, inactive, expired, logout | Requires staging D1. |
| RBAC | Viewer mutation denial; manager/admin permissions | Requires staging D1. |
| Customer journey | Greeting, issue/no-address, issue/address, duplicate phone | Requires staging D1 and AI/fallback test fixtures. |
| Webhook | Auth, malformed payload, duplicate event, concurrent event | Requires staging D1 and provider-shaped payloads. |
| WhatsApp | Success, failure, timeout, retry | Requires Evolution API staging instance. |
| AI | Tool schema, malformed output, injection, provider failure | Requires mocked provider responses and multilingual fixtures. |
| Reminders | Cron/manual concurrency, failed retry, Riyadh boundary | Requires D1 concurrency harness and clock-controlled tests. |
| Frontend | XSS, 320/360/390/412/768/1024/1440px | Requires browser automation; not available in repository. |

## P0/P1/P2 plan

**P0 — before production:** apply and verify migration `0002`; replace the query-string webhook secret with a provider signature or header-only secret; add external-call timeouts and a durable outbound-message lifecycle; complete D1 integration tests for duplicate webhook/request/reminder races; and validate the exact Evolution API payload against the deployed provider version.

**P1 — reliability and workflow:** add webhook processed/failed state updates, catch concurrent customer uniqueness conflicts, standardize all date calculations on Asia/Riyadh, add strict AI output schemas, add CSRF protection, enforce field limits and allowed bot-config keys, and add pagination.

**P2 — maintainability and UX:** bundle a versioned dashboard instead of fetching GitHub `main`, make `dashboard-html.js` authoritative or remove it, add a pinned toolchain and CI, add responsive browser tests, add health/failure cards, add soft deletion and technician entities, and improve empty/error/loading states.

## Deployment checklist

1. Create a staging D1 database and apply `0001_initial.sql` followed by `0002_production_audit.sql`.
2. Run the full login, webhook, duplicate, reminder, and status-transition integration suite against staging.
3. Configure secrets with Cloudflare secret storage, not `wrangler.toml` or D1 settings visible to unauthorized roles.
4. Configure a header-only webhook secret or provider signature and remove URL-secret support.
5. Configure and test Evolution API URL, instance, API key, timeout, and payload version.
6. Configure AI provider/model and test tool calls, malformed output, provider failure, and prompt-injection cases.
7. Verify the cron trigger at the intended UTC schedule against the Riyadh business-date policy.
8. Verify dashboard origin, cookie behavior, CSP, XSS, mobile layouts, and viewer restrictions.
9. Deploy the branch to staging, inspect D1 rows and Worker logs, then deploy through a reviewed release process.
10. Keep a rollback Worker version and a D1 backup/export. Do not roll back schema changes without a documented forward migration.

## Final acceptance status

The repair branch addresses the verified code-level blockers, but the system should remain **not production-approved** until staging integration tests confirm D1 migrations, concurrency behavior, external API delivery, and browser security. The repository has no committed production secrets, and no production configuration was modified by this audit.

## References

[1]: https://developers.cloudflare.com/d1/ "Cloudflare D1 documentation"
[2]: https://developers.cloudflare.com/workers/ "Cloudflare Workers documentation"
[3]: https://owasp.org/www-project-application-security-verification-standard/ "OWASP Application Security Verification Standard"
[4]: https://owasp.org/www-community/attacks/csrf "OWASP Cross-Site Request Forgery guidance"
[5]: https://owasp.org/www-community/attacks/xss/ "OWASP Cross-Site Scripting guidance"
