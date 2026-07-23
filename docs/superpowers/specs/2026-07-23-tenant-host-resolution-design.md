# Tenant resolution by host (subdomain + verified custom domain)

Date: 2026-07-23
Status: Approved

## Problem

Today the tenant (clinic) is resolved from a **manual `subdomain` field in the login body**.
On `localhost` that field is a dev crutch: there is no real subdomain, so the user types it
by hand. This must not exist in production. The tenant must **always** be derived from the
request host, never from user input, and we must support white-label custom domains.

Current behavior:
- `Tenant` has a unique `subdomain` field. No custom-domain support.
- `POST /auth/login` requires `subdomain` in the body (`login.dto.ts`), resolves the tenant
  via `findTenantBySubdomain`, and bakes `tenantId` into the JWT.
- Every authenticated request derives the tenant from the JWT
  (`TenantContextInterceptor` reads `req.user.tenantId`), not from the host.

## Goals

1. Tenant is derived from the request host on **login and every authenticated request**.
2. The JWT's `tenantId` is cross-checked against the host-resolved tenant — a token issued
   for clinic A cannot be used on clinic B's domain.
3. Support white-label custom domains with **DNS TXT verification**; only verified domains
   resolve a tenant.
4. Remove the manual `subdomain` field from login.
5. Local development works with no manual field and no `/etc/hosts` edits.

## Non-goals

- Automated DNS/TLS certificate provisioning for custom domains (out of scope; assume the
  hosting layer/proxy terminates TLS for verified hosts).
- Changing `/auth/register` (clinic signup): it keeps `subdomain` in the body — it is an
  admin signup, not a login, and there is no host to derive from at first creation.

## Design

### 1. Data model

New table `TenantDomain` for white-label custom domains. `Tenant.subdomain` is unchanged and
remains the mechanism for `<sub>.<baseDomain>` hosts.

```prisma
enum TenantDomainStatus {
  PENDING
  VERIFIED
}

model TenantDomain {
  id          String             @id @default(uuid()) @db.Uuid
  tenantId    String             @db.Uuid
  host        String             @unique   // lowercase, no port, e.g. "citas.miclinica.com"
  status      TenantDomainStatus @default(PENDING)
  verifyToken String                        // random token published as a DNS TXT record
  verifiedAt  DateTime?
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  deletedAt   DateTime?
  tenant      Tenant             @relation(fields: [tenantId], references: [id])

  @@index([tenantId])
  @@map("tenant_domains")
}
```

- `Tenant` gains `domains TenantDomain[]`.
- Migration follows the existing RLS convention used by other tenant-scoped tables. A domain
  is only usable for resolution when `status = VERIFIED` and `deletedAt IS NULL`.

### 2. `TenantResolverService` (shared, `src/shared/tenancy/`)

Single responsibility: given a raw host string, return `tenantId | null`. No HTTP concerns.

Algorithm:
1. Normalize: trim, lowercase, strip the port (`acme.dentalix.app:3000` → `acme.dentalix.app`).
2. If the host ends with one of the configured **base domains** (`TENANT_BASE_DOMAINS`,
   comma-separated, e.g. `dentalix.app,localhost`):
   - Extract the left-most label as the subdomain.
   - If the subdomain is empty or in the reserved set (`www, api, app, admin`) → return `null`.
   - Look up `Tenant` by `subdomain` (not soft-deleted) → return its `id` or `null`.
3. Otherwise treat the host as a custom domain: look up `TenantDomain` by exact `host` where
   `status = VERIFIED` and `deletedAt IS NULL` → return `tenantId` or `null`.

Config comes from env: `TENANT_BASE_DOMAINS`. Reserved subdomains are a constant.

### 3. `TenantHostMiddleware` (global)

Computes the effective host once per request and attaches it to `req` (e.g.
`req.tenantHost = { host, tenantId }`), resolving via `TenantResolverService`. It never throws
— it only annotates; enforcement happens downstream.

Host selection:
- **Production** (`NODE_ENV === 'production'`): use `X-Forwarded-Host` **only if**
  `TRUST_PROXY=true`; otherwise use the `Host` header.
- **Development**: if `X-Tenant-Host` is present it takes priority (for curl/Postman/e2e tests).
  `acme.localhost` works via the base-domain branch (browsers resolve `*.localhost` to
  127.0.0.1 with no config). `X-Tenant-Host` is **ignored** in production.

### 4. Login without the manual field

- `login.dto.ts`: remove `subdomain`; keep `email` + `password`.
- `auth.controller.ts`: read the host-resolved `tenantId` from `req.tenantHost`. If it is
  `null` → `401 Unauthorized` (do not reveal whether the tenant or the credentials were wrong).
  Pass the resolved `tenantId` into `LoginUseCase` (its `LoginInput.tenantId` is unchanged).

### 5. Cross-tenant enforcement in `TenantContextInterceptor`

The **host is the authority** for the active tenant.
- Read the host-resolved `tenantId` from `req.tenantHost`.
- If there is no host-resolved tenant → `401` ("No tenant in context").
- If a JWT is present (`req.user`) and `req.user.tenantId !== hostTenantId` → `401`.
- Run the ALS store with the **host-resolved** `tenantId`.

This closes the token-replay-across-tenants gap: a valid token for clinic A presented on
clinic B's host is rejected.

### 6. Custom-domain module (`src/modules/domains/`, OWNER only)

Hexagonal like the existing modules (domain port + prisma repo + use cases + controller).

- `POST /domains` — body `{ host }`. Normalizes the host, rejects a host that ends with a base
  domain (those are subdomains, not custom domains) and duplicates. Creates a `PENDING` record
  with a fresh `verifyToken`. Returns the record plus the TXT instructions:
  `{ name: "_dentalix-verify.<host>", type: "TXT", value: verifyToken }`.
- `POST /domains/:id/verify` — looks up the TXT record via an **injectable DNS resolver port**
  (real impl wraps `node:dns/promises`; tests inject a fake). If a TXT record matches
  `verifyToken` → set `status = VERIFIED`, `verifiedAt = now`. Otherwise stays `PENDING` and
  returns a "not found yet" result.
- `GET /domains` — lists the tenant's domains with status.

All routes are tenant-scoped (subject to the same interceptor) and restricted to `OWNER`.

### 7. Configuration (env)

- `TENANT_BASE_DOMAINS` — comma-separated base domains, e.g. `dentalix.app,localhost`.
- `TRUST_PROXY` — `true`/`false`; gate for honoring `X-Forwarded-Host` in production.
- (`NODE_ENV` already exists and gates the `X-Tenant-Host` dev override.)

## Testing

- **Unit — `TenantResolverService`**: subdomain match; base-domain suffix; port stripping;
  reserved subdomain → null; unknown subdomain → null; verified custom domain → tenantId;
  pending custom domain → null; unknown host → null.
- **Unit — DNS verification use case**: matching TXT → VERIFIED; missing/mismatched TXT →
  stays PENDING (fake DNS resolver).
- **Unit — host selection** in the middleware: `X-Forwarded-Host` honored only with
  `TRUST_PROXY`; `X-Tenant-Host` honored only in dev and ignored in production.
- **e2e**: login by host via `X-Tenant-Host` (no `subdomain` in body); cross-tenant rejection
  (token for tenant A on host B → 401); pending custom domain does not resolve; verified custom
  domain resolves.

## Rollout notes

- Frontend must drop the subdomain input from the login form and rely on the host.
- Set `TENANT_BASE_DOMAINS` (and `TRUST_PROXY` behind the real proxy) in each environment.
- Existing tokens keep working as long as they are presented on the matching tenant host.
