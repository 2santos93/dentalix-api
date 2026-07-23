# Tenant Resolution by Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive the active tenant from the request host (subdomain or verified custom domain) on login and on every authenticated request, and remove the manual `subdomain` field from login.

**Architecture:** A global `TenantHostMiddleware` computes the effective host once per request and resolves it to a `tenantId` via a shared `TenantResolverService` (subdomain → `Tenant.subdomain`; custom domain → verified `TenantDomain`). The host becomes the authority for tenant context: `TenantContextInterceptor` runs the tenant ALS from the host-resolved tenant and rejects any JWT whose `tenantId` disagrees. A new OWNER-only `domains` module lets a clinic register a white-label domain and verify ownership via a DNS TXT record.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL + RLS), `@nestjs/config`, argon2, JWT, Jest + supertest, `node:dns/promises`.

## Global Constraints

- **Hexagonal layout** per module: `domain/` (entities + ports), `application/use-cases/`, `infrastructure/repositories/`, `presentation/` (controller + dto + guards). Follow existing modules (`appointments`, `staff`) exactly.
- **Tenant scoping:** tenant-scoped tables use Postgres RLS driven by `app.current_tenant` (`PrismaService.runWithTenant`). `tenants` and `users` have **no** RLS. `tenant_domains` is host-routing infrastructure queried **before** a tenant is known, so it also has **no RLS** — its repository MUST filter by the context tenant explicitly (see Task 9).
- **Host is authority:** after this change the active tenant always comes from the request host. The JWT `tenantId` is only cross-checked, never trusted as the source.
- **Dev override `X-Tenant-Host`** is honored only when `NODE_ENV !== 'production'`. `X-Forwarded-Host` is honored only when `TRUST_PROXY === 'true'`.
- **Reserved subdomains:** `www`, `api`, `app`, `admin` never resolve to a tenant.
- **Env:** `TENANT_BASE_DOMAINS` (comma-separated, e.g. `dentalix.app,localhost`), `TRUST_PROXY` (`true`/`false`). Tests use `TENANT_BASE_DOMAINS="localhost"`.
- **Commands:** unit tests `npm test`; e2e `npm run test:e2e`; int `npm run test:int`; build `npm run build`. Prisma test DB migrate: `npm run db:test:setup`.
- **Commit style:** end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

Created:
- `src/shared/tenancy/host-parser.ts` — pure host → parsed-host logic + reserved set (Task 2)
- `src/shared/tenancy/host-parser.spec.ts` (Task 2)
- `src/shared/tenancy/tenant-resolver.service.ts` — parsed host → `tenantId` via Prisma (Task 3)
- `src/shared/tenancy/tenant-resolver.service.spec.ts` (Task 3)
- `src/shared/tenancy/select-host.ts` — pure header → effective host (Task 4)
- `src/shared/tenancy/select-host.spec.ts` (Task 4)
- `src/shared/tenancy/tenant-host.middleware.ts` — global middleware (Task 4)
- `src/shared/tenancy/tenant-host-request.ts` — `TenantHostRequest` type (Task 4)
- `test/support/tenant-host.ts` — `hostFor(subdomain)` test helper (Task 5)
- `src/modules/domains/**` — full module (Tasks 9–10)
- `test/tenant-host.e2e-spec.ts` (Task 8)
- `test/domains.e2e-spec.ts` (Task 11)

Modified:
- `prisma/schema.prisma` + new migration (Task 1)
- `src/shared/tenancy/tenant-context.module.ts` — provide resolver + middleware deps (Tasks 3–4)
- `src/app.module.ts` — wire middleware + `DomainsModule` (Tasks 4, 9)
- `src/config/config.module.ts` + `.env` / `.env.test` / `.env.example` (Tasks 2, 4)
- `src/shared/tenancy/tenant-context.interceptor.ts` + `.spec.ts` (Task 6)
- `src/modules/auth/presentation/auth.controller.ts` (Task 7)
- `src/modules/auth/presentation/dto/login.dto.ts` (Task 7)
- All existing `test/*.e2e-spec.ts` + `test/rls.isolation.int-spec.ts` (Tasks 5, 7)

---

### Task 1: `TenantDomain` model + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_tenant_domains/migration.sql`

**Interfaces:**
- Produces: Prisma models `TenantDomain` and enum `TenantDomainStatus`; `Tenant.domains` relation.

- [ ] **Step 1: Add the enum, model, and relation to `prisma/schema.prisma`**

Add the `domains` relation line inside `model Tenant` (after `memberships`):

```prisma
  domains      TenantDomain[]
```

Add at the end of the file:

```prisma
enum TenantDomainStatus {
  PENDING
  VERIFIED
}

model TenantDomain {
  id          String             @id @default(uuid()) @db.Uuid
  tenantId    String             @db.Uuid
  host        String             @unique
  status      TenantDomainStatus @default(PENDING)
  verifyToken String
  verifiedAt  DateTime?
  createdAt   DateTime           @default(now())
  updatedAt   DateTime           @updatedAt
  deletedAt   DateTime?
  tenant      Tenant             @relation(fields: [tenantId], references: [id])

  @@index([tenantId])
  @@map("tenant_domains")
}
```

- [ ] **Step 2: Generate the migration SQL (do not apply through dev shadow DB — hand-author to match the RLS-free convention)**

Create `prisma/migrations/<timestamp>_add_tenant_domains/migration.sql` (use a timestamp later than `20260723160013`, format `YYYYMMDDHHMMSS`):

```sql
-- CreateEnum
CREATE TYPE "TenantDomainStatus" AS ENUM ('PENDING', 'VERIFIED');

-- CreateTable
CREATE TABLE "tenant_domains" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "host" TEXT NOT NULL,
    "status" "TenantDomainStatus" NOT NULL DEFAULT 'PENDING',
    "verifyToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_host_key" ON "tenant_domains"("host");

-- CreateIndex
CREATE INDEX "tenant_domains_tenantId_idx" ON "tenant_domains"("tenantId");

-- AddForeignKey
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota: tenant_domains es infraestructura de ruteo host->tenant. Se consulta
-- ANTES de conocer el tenant (para resolverlo), por lo que NO lleva RLS -- igual
-- que tenants/users. El aislamiento en las rutas de gestion (/domains) lo impone
-- el repositorio filtrando por el tenant del contexto (TenantContextService).
```

- [ ] **Step 3: Apply the migration to the test DB and regenerate the client**

Run: `npm run db:test:setup && npx prisma generate`
Expected: migration `add_tenant_domains` applied; client regenerated with `prisma.tenantDomain`.

- [ ] **Step 4: Verify the client compiles with the new model**

Run: `npm run build`
Expected: build succeeds (confirms schema is valid and the generated client typechecks).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: TenantDomain model + migration (host routing, no RLS)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `host-parser` pure logic + base-domains config

**Files:**
- Create: `src/shared/tenancy/host-parser.ts`
- Test: `src/shared/tenancy/host-parser.spec.ts`
- Modify: `.env`, `.env.test`, `.env.example`

**Interfaces:**
- Produces:
  - `RESERVED_SUBDOMAINS: readonly string[]`
  - `type ParsedHost = { kind: 'subdomain'; subdomain: string } | { kind: 'custom'; host: string } | null`
  - `parseHost(rawHost: string | undefined, baseDomains: string[]): ParsedHost`

- [ ] **Step 1: Write the failing test**

Create `src/shared/tenancy/host-parser.spec.ts`:

```typescript
import { parseHost } from './host-parser';

const BASES = ['dentalix.app', 'localhost'];

describe('parseHost', () => {
  it('extracts the subdomain under a base domain', () => {
    expect(parseHost('acme.dentalix.app', BASES)).toEqual({
      kind: 'subdomain',
      subdomain: 'acme',
    });
  });

  it('strips the port and lowercases', () => {
    expect(parseHost('ACME.localhost:3000', BASES)).toEqual({
      kind: 'subdomain',
      subdomain: 'acme',
    });
  });

  it('returns null for the apex base domain (no subdomain)', () => {
    expect(parseHost('dentalix.app', BASES)).toBeNull();
  });

  it('returns null for reserved subdomains', () => {
    expect(parseHost('www.dentalix.app', BASES)).toBeNull();
    expect(parseHost('api.dentalix.app', BASES)).toBeNull();
  });

  it('returns null for a multi-label subdomain under a base', () => {
    expect(parseHost('a.b.dentalix.app', BASES)).toBeNull();
  });

  it('treats a non-base host as a custom domain', () => {
    expect(parseHost('citas.miclinica.com', BASES)).toEqual({
      kind: 'custom',
      host: 'citas.miclinica.com',
    });
  });

  it('returns null for empty/undefined host', () => {
    expect(parseHost(undefined, BASES)).toBeNull();
    expect(parseHost('', BASES)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- host-parser`
Expected: FAIL — cannot find module `./host-parser`.

- [ ] **Step 3: Implement `host-parser.ts`**

Create `src/shared/tenancy/host-parser.ts`:

```typescript
export const RESERVED_SUBDOMAINS: readonly string[] = [
  'www',
  'api',
  'app',
  'admin',
];

export type ParsedHost =
  | { kind: 'subdomain'; subdomain: string }
  | { kind: 'custom'; host: string }
  | null;

/**
 * Maps a raw request host to either a subdomain (to look up Tenant.subdomain)
 * or a custom domain (to look up a verified TenantDomain). Pure: all config
 * (base domains) is passed in.
 */
export function parseHost(
  rawHost: string | undefined,
  baseDomains: string[],
): ParsedHost {
  if (!rawHost) return null;
  const host = rawHost.trim().toLowerCase().split(':')[0];
  if (!host) return null;

  for (const base of baseDomains) {
    if (host === base) return null; // apex: no subdomain
    if (host.endsWith(`.${base}`)) {
      const subdomain = host.slice(0, host.length - base.length - 1);
      // Only a single left-most label is a valid subdomain.
      if (!subdomain || subdomain.includes('.')) return null;
      if (RESERVED_SUBDOMAINS.includes(subdomain)) return null;
      return { kind: 'subdomain', subdomain };
    }
  }

  return { kind: 'custom', host };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- host-parser`
Expected: PASS (all cases).

- [ ] **Step 5: Add the env var to `.env`, `.env.test`, `.env.example`**

Append to `.env.test`:

```
TENANT_BASE_DOMAINS="localhost"
```

Append to `.env` and `.env.example` (use the real apex plus localhost for `.env`; placeholder for the example):

```
TENANT_BASE_DOMAINS="dentalix.app,localhost"
```

- [ ] **Step 6: Commit**

```bash
git add src/shared/tenancy/host-parser.ts src/shared/tenancy/host-parser.spec.ts .env.test .env.example
git commit -m "feat: pure host parser (subdomain vs custom domain) + base-domains env

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `TenantResolverService`

**Files:**
- Create: `src/shared/tenancy/tenant-resolver.service.ts`
- Test: `src/shared/tenancy/tenant-resolver.service.spec.ts`
- Modify: `src/shared/tenancy/tenant-context.module.ts`

**Interfaces:**
- Consumes: `parseHost`, `PrismaService`, `ConfigService`.
- Produces: `TenantResolverService.resolve(rawHost: string | undefined): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

Create `src/shared/tenancy/tenant-resolver.service.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { TenantResolverService } from './tenant-resolver.service';

function makeService(prisma: {
  tenant: { findFirst: jest.Mock };
  tenantDomain: { findFirst: jest.Mock };
}) {
  const config = {
    get: jest.fn().mockReturnValue('dentalix.app,localhost'),
  } as unknown as ConfigService;
  return new TenantResolverService(prisma as never, config);
}

describe('TenantResolverService', () => {
  it('resolves a subdomain to its tenant id', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue({ id: 't-1' }) },
      tenantDomain: { findFirst: jest.fn() },
    };
    const svc = makeService(prisma);
    await expect(svc.resolve('acme.dentalix.app')).resolves.toBe('t-1');
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: { subdomain: 'acme', deletedAt: null },
      select: { id: true },
    });
  });

  it('returns null for an unknown subdomain', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn().mockResolvedValue(null) },
      tenantDomain: { findFirst: jest.fn() },
    };
    await expect(makeService(prisma).resolve('nope.localhost')).resolves.toBeNull();
  });

  it('resolves a verified custom domain to its tenant id', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: {
        findFirst: jest.fn().mockResolvedValue({ tenantId: 't-2' }),
      },
    };
    const svc = makeService(prisma);
    await expect(svc.resolve('citas.miclinica.com')).resolves.toBe('t-2');
    expect(prisma.tenantDomain.findFirst).toHaveBeenCalledWith({
      where: { host: 'citas.miclinica.com', status: 'VERIFIED', deletedAt: null },
      select: { tenantId: true },
    });
  });

  it('returns null for a pending (unverified) custom domain', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(
      makeService(prisma).resolve('citas.miclinica.com'),
    ).resolves.toBeNull();
  });

  it('returns null for an unparseable host', async () => {
    const prisma = {
      tenant: { findFirst: jest.fn() },
      tenantDomain: { findFirst: jest.fn() },
    };
    await expect(makeService(prisma).resolve(undefined)).resolves.toBeNull();
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tenant-resolver`
Expected: FAIL — cannot find module `./tenant-resolver.service`.

- [ ] **Step 3: Implement `tenant-resolver.service.ts`**

Create `src/shared/tenancy/tenant-resolver.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseHost } from './host-parser';

@Injectable()
export class TenantResolverService {
  private readonly baseDomains: string[];

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.baseDomains = (config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async resolve(rawHost: string | undefined): Promise<string | null> {
    const parsed = parseHost(rawHost, this.baseDomains);
    if (!parsed) return null;

    if (parsed.kind === 'subdomain') {
      const tenant = await this.prisma.tenant.findFirst({
        where: { subdomain: parsed.subdomain, deletedAt: null },
        select: { id: true },
      });
      return tenant?.id ?? null;
    }

    const domain = await this.prisma.tenantDomain.findFirst({
      where: { host: parsed.host, status: 'VERIFIED', deletedAt: null },
      select: { tenantId: true },
    });
    return domain?.tenantId ?? null;
  }
}
```

- [ ] **Step 4: Provide the resolver in `TenantContextModule`**

Modify `src/shared/tenancy/tenant-context.module.ts` to also provide/export the resolver (PrismaService comes from the `@Global` `PrismaModule`; ConfigService from the global config):

```typescript
import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantResolverService } from './tenant-resolver.service';

@Global()
@Module({
  providers: [TenantContextService, TenantResolverService],
  exports: [TenantContextService, TenantResolverService],
})
export class TenantContextModule {}
```

- [ ] **Step 5: Run the test to verify it passes and the build compiles**

Run: `npm test -- tenant-resolver && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/shared/tenancy/tenant-resolver.service.ts src/shared/tenancy/tenant-resolver.service.spec.ts src/shared/tenancy/tenant-context.module.ts
git commit -m "feat: TenantResolverService (host -> tenantId via subdomain/verified domain)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `TenantHostMiddleware` (host selection + global wiring)

**Files:**
- Create: `src/shared/tenancy/select-host.ts`
- Test: `src/shared/tenancy/select-host.spec.ts`
- Create: `src/shared/tenancy/tenant-host-request.ts`
- Create: `src/shared/tenancy/tenant-host.middleware.ts`
- Modify: `src/shared/tenancy/tenant-context.module.ts` (provide/export middleware)
- Modify: `src/app.module.ts` (apply middleware to all routes)
- Modify: `src/config/config.module.ts`, `.env`, `.env.test`, `.env.example` (TRUST_PROXY)

**Interfaces:**
- Consumes: `TenantResolverService`.
- Produces:
  - `selectHost(headers: Record<string, string | string[] | undefined>, opts: { isProd: boolean; trustProxy: boolean }): string | undefined`
  - `type TenantHostRequest = { headers: ...; user?: JwtPayload; tenantHost?: { host?: string; tenantId: string | null } }`
  - `TenantHostMiddleware` (NestMiddleware) that sets `req.tenantHost`.

- [ ] **Step 1: Write the failing test for `selectHost`**

Create `src/shared/tenancy/select-host.spec.ts`:

```typescript
import { selectHost } from './select-host';

describe('selectHost', () => {
  it('prefers X-Tenant-Host in non-production', () => {
    const h = selectHost(
      { 'x-tenant-host': 'acme.dentalix.app', host: '127.0.0.1' },
      { isProd: false, trustProxy: false },
    );
    expect(h).toBe('acme.dentalix.app');
  });

  it('ignores X-Tenant-Host in production', () => {
    const h = selectHost(
      { 'x-tenant-host': 'evil.dentalix.app', host: 'acme.dentalix.app' },
      { isProd: true, trustProxy: false },
    );
    expect(h).toBe('acme.dentalix.app');
  });

  it('uses X-Forwarded-Host only when trustProxy is true', () => {
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app', host: 'internal' },
        { isProd: true, trustProxy: true },
      ),
    ).toBe('acme.dentalix.app');
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app', host: 'internal' },
        { isProd: true, trustProxy: false },
      ),
    ).toBe('internal');
  });

  it('takes the first value of a comma-joined X-Forwarded-Host', () => {
    expect(
      selectHost(
        { 'x-forwarded-host': 'acme.dentalix.app, proxy1', host: 'internal' },
        { isProd: true, trustProxy: true },
      ),
    ).toBe('acme.dentalix.app');
  });

  it('falls back to the Host header', () => {
    expect(
      selectHost({ host: 'acme.localhost' }, { isProd: false, trustProxy: false }),
    ).toBe('acme.localhost');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- select-host`
Expected: FAIL — cannot find module `./select-host`.

- [ ] **Step 3: Implement `select-host.ts`**

Create `src/shared/tenancy/select-host.ts`:

```typescript
type Headers = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v?.split(',')[0]?.trim() || undefined;
}

/**
 * Chooses the effective host for tenant resolution. The X-Tenant-Host dev
 * override is honored only outside production; X-Forwarded-Host only behind a
 * trusted proxy. Otherwise the Host header is used.
 */
export function selectHost(
  headers: Headers,
  opts: { isProd: boolean; trustProxy: boolean },
): string | undefined {
  if (!opts.isProd) {
    const override = first(headers['x-tenant-host']);
    if (override) return override;
  }
  if (opts.trustProxy) {
    const forwarded = first(headers['x-forwarded-host']);
    if (forwarded) return forwarded;
  }
  return first(headers['host']);
}
```

- [ ] **Step 4: Run the `selectHost` test to verify it passes**

Run: `npm test -- select-host`
Expected: PASS.

- [ ] **Step 5: Create the request type**

Create `src/shared/tenancy/tenant-host-request.ts`:

```typescript
import { JwtPayload } from '../crypto/token.service';

export interface TenantHostRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
  tenantHost?: { host?: string; tenantId: string | null };
}
```

- [ ] **Step 6: Implement the middleware**

Create `src/shared/tenancy/tenant-host.middleware.ts`:

```typescript
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantResolverService } from './tenant-resolver.service';
import { selectHost } from './select-host';
import { TenantHostRequest } from './tenant-host-request';

@Injectable()
export class TenantHostMiddleware implements NestMiddleware {
  private readonly isProd: boolean;
  private readonly trustProxy: boolean;

  constructor(
    private readonly resolver: TenantResolverService,
    config: ConfigService,
  ) {
    this.isProd = config.get<string>('NODE_ENV') === 'production';
    this.trustProxy = config.get<string>('TRUST_PROXY') === 'true';
  }

  async use(
    req: TenantHostRequest,
    _res: unknown,
    next: () => void,
  ): Promise<void> {
    const host = selectHost(req.headers, {
      isProd: this.isProd,
      trustProxy: this.trustProxy,
    });
    const tenantId = await this.resolver.resolve(host);
    req.tenantHost = { host, tenantId };
    next();
  }
}
```

- [ ] **Step 7: Provide the middleware in `TenantContextModule`**

Modify `src/shared/tenancy/tenant-context.module.ts` — add `TenantHostMiddleware` to `providers` and `exports` (keep `TenantContextService` and `TenantResolverService`):

```typescript
import { Global, Module } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';
import { TenantResolverService } from './tenant-resolver.service';
import { TenantHostMiddleware } from './tenant-host.middleware';

@Global()
@Module({
  providers: [TenantContextService, TenantResolverService, TenantHostMiddleware],
  exports: [TenantContextService, TenantResolverService, TenantHostMiddleware],
})
export class TenantContextModule {}
```

- [ ] **Step 8: Apply the middleware globally in `AppModule`**

Modify `src/app.module.ts`: implement `NestModule` and register the middleware for all routes. Add imports and the `configure` method:

```typescript
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantHostMiddleware } from './shared/tenancy/tenant-host.middleware';
// ...existing imports unchanged...

@Module({
  // ...existing imports/controllers/providers unchanged...
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantHostMiddleware).forRoutes('*');
  }
}
```

If `forRoutes('*')` throws a path-to-regexp error at boot (Express 5 / newer path
matching), fall back to `forRoutes({ path: '*path', method: RequestMethod.ALL })`
(import `RequestMethod`), or `forRoutes('{*path}')`. Confirm at Step 10 that the app
boots and `req.tenantHost` is populated.

- [ ] **Step 9: Register `TRUST_PROXY` env + config**

Append to `.env.test`:

```
TRUST_PROXY="false"
```

Append to `.env` and `.env.example`:

```
TRUST_PROXY="false"
```

(No change needed to `config.module.ts` `required[]` — both `TENANT_BASE_DOMAINS` and `TRUST_PROXY` have safe defaults in code.)

- [ ] **Step 10: Verify the whole suite still passes (middleware is additive so far)**

Run: `npm test && npm run build && npm run test:e2e`
Expected: all PASS. The middleware only annotates `req.tenantHost`; the interceptor still uses the JWT, so existing behavior is unchanged.

- [ ] **Step 11: Commit**

```bash
git add src/shared/tenancy/select-host.ts src/shared/tenancy/select-host.spec.ts src/shared/tenancy/tenant-host-request.ts src/shared/tenancy/tenant-host.middleware.ts src/shared/tenancy/tenant-context.module.ts src/app.module.ts .env.test .env.example
git commit -m "feat: global TenantHostMiddleware resolves tenant from request host

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Send the tenant host from all existing tests (defensive, pre-cutover)

This task adds the `X-Tenant-Host` header to every existing request that hits a protected route, **before** the interceptor starts enforcing it (Task 6). The header is currently ignored by the interceptor, and the login body still carries `subdomain`, so the suite stays green throughout. This isolates the mechanical test churn from the behavioral cutover.

**Files:**
- Create: `test/support/tenant-host.ts`
- Modify: `test/patients.e2e-spec.ts`, `test/appointments.e2e-spec.ts`, `test/clinical-history.e2e-spec.ts`, `test/odontogram.e2e-spec.ts`, `test/role-matrix.e2e-spec.ts`, `test/auth.e2e-spec.ts`

**Interfaces:**
- Produces: `hostFor(subdomain: string): string` → `${subdomain}.localhost`.

- [ ] **Step 1: Create the test helper**

Create `test/support/tenant-host.ts`:

```typescript
// Maps a tenant subdomain to the host used in tests. `localhost` is a configured
// base domain (.env.test TENANT_BASE_DOMAINS), so `<sub>.localhost` resolves to
// the tenant with that subdomain via TenantHostMiddleware.
export function hostFor(subdomain: string): string {
  return `${subdomain}.localhost`;
}
```

- [ ] **Step 2: Update each `registerAndLogin` helper to return the subdomain and send the host on login**

In each spec that has a `registerAndLogin` helper (`patients`, `appointments`, `clinical-history`, `odontogram`, `role-matrix`), apply this uniform transformation:

- Import the helper: `import { hostFor } from './support/tenant-host';`
- On the **login** request, add `.set('X-Tenant-Host', hostFor(opts.subdomain))` (keep the `subdomain` in the body for now — removed in Task 7).
- Change the return object to include `subdomain: opts.subdomain`.
- Update the return type to `{ tenantId: string; accessToken: string; subdomain: string }`.

Worked example (patients — apply the analogous edit in each file):

```typescript
const login = await request(app.getHttpServer())
  .post('/api/v1/auth/login')
  .set('X-Tenant-Host', hostFor(opts.subdomain))
  .send({
    subdomain: opts.subdomain,
    email: opts.email,
    password: 'S3cret!!',
  })
  .expect(201);
const loginBody = login.body as LoginResponseBody;

return {
  tenantId: registerBody.tenantId,
  accessToken: loginBody.accessToken,
  subdomain: opts.subdomain,
};
```

- [ ] **Step 3: Add the host header to every protected request in the specs**

For **every** `request(app.getHttpServer()).<method>('/api/v1/...')` chain that targets a protected route (i.e. everything except `POST /api/v1/auth/register`), add `.set('X-Tenant-Host', hostFor(<subdomain>))`, where `<subdomain>` is the subdomain of the tenant that owns the token used in that request (available as `clinicA.subdomain`, `clinicB.subdomain`, etc. after Step 2).

Worked example:

```typescript
const create = await request(app.getHttpServer())
  .post('/api/v1/patients')
  .set('X-Tenant-Host', hostFor(clinicA.subdomain))
  .set('Authorization', `Bearer ${clinicA.accessToken}`)
  .send({ /* ...unchanged... */ });
```

For `test/auth.e2e-spec.ts` (no `registerAndLogin` helper): add `.set('X-Tenant-Host', hostFor('sonrisa'))` to each of the three `POST /api/v1/auth/login` calls (leave the `subdomain` body field for now).

Note: this is uniform mechanical work. The gate is the whole e2e suite still green — do not hand-verify each call site individually.

- [ ] **Step 4: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: PASS — identical behavior to before (header ignored, subdomain body still used).

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test: send X-Tenant-Host from all e2e requests (pre-cutover, no behavior change)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Cross-tenant enforcement in `TenantContextInterceptor`

**Files:**
- Modify: `src/shared/tenancy/tenant-context.interceptor.ts`
- Modify: `src/shared/tenancy/tenant-context.interceptor.spec.ts`

**Interfaces:**
- Consumes: `req.tenantHost` (from Task 4), `req.user` (from `JwtAuthGuard`).
- Behavior: host-resolved tenant is authority; ALS runs with it; JWT mismatch → 401.

- [ ] **Step 1: Read the existing interceptor spec to learn its harness**

Run: `cat src/shared/tenancy/tenant-context.interceptor.spec.ts`
(Understand how it builds `ExecutionContext` and asserts on `run`.)

- [ ] **Step 2: Update the spec to the new host-authority behavior**

Replace the spec's request shape so it sets `tenantHost` and `user`, covering three cases. Use the same `ExecutionContext`/`CallHandler` mock style already in the file; the essential assertions:

```typescript
// (a) host resolves + JWT matches -> ALS runs with the host tenant
//     req = { tenantHost: { tenantId: 't-1' }, user: { tenantId: 't-1' } }
//     expect tenantContext.run called with 't-1'

// (b) host resolves + JWT tenant differs -> UnauthorizedException, run NOT called
//     req = { tenantHost: { tenantId: 't-1' }, user: { tenantId: 't-2' } }

// (c) host does not resolve (tenantId null) -> UnauthorizedException
//     req = { tenantHost: { tenantId: null }, user: { tenantId: 't-1' } }
```

Concretely, adapt the existing test cases to build requests with `tenantHost`/`user` as above and assert `UnauthorizedException` is thrown for (b) and (c), and that `run` receives `'t-1'` for (a).

- [ ] **Step 3: Run the spec to verify it fails**

Run: `npm test -- tenant-context.interceptor`
Expected: FAIL (interceptor still reads `req.user.tenantId`).

- [ ] **Step 4: Implement the new interceptor**

Replace `src/shared/tenancy/tenant-context.interceptor.ts`:

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { TenantHostRequest } from './tenant-host-request';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<TenantHostRequest>();
    // The host is the authority for the active tenant.
    const hostTenantId = req.tenantHost?.tenantId;
    if (!hostTenantId) {
      throw new UnauthorizedException('No tenant in context');
    }
    // A token issued for another tenant must not be usable on this host.
    if (req.user && req.user.tenantId !== hostTenantId) {
      throw new UnauthorizedException('Tenant mismatch');
    }
    // run() keeps the ALS store active through the handler's async execution,
    // because we subscribe to next.handle() INSIDE the run callback (enterWith
    // in a guard does not survive the guard->handler async boundary).
    return new Observable((subscriber) => {
      this.tenantContext.run(hostTenantId, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
```

- [ ] **Step 5: Run the spec and the full e2e suite**

Run: `npm test -- tenant-context.interceptor && npm run test:e2e`
Expected: PASS. e2e stays green because Task 5 already sends `X-Tenant-Host` (matching each token's tenant).

- [ ] **Step 6: Commit**

```bash
git add src/shared/tenancy/tenant-context.interceptor.ts src/shared/tenancy/tenant-context.interceptor.spec.ts
git commit -m "feat: host is authority for tenant context; reject cross-tenant JWTs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Remove the manual subdomain from login

**Files:**
- Modify: `src/modules/auth/presentation/dto/login.dto.ts`
- Modify: `src/modules/auth/presentation/auth.controller.ts`
- Modify: `test/auth.e2e-spec.ts` and every spec whose `registerAndLogin` sends `subdomain` in the login body

**Interfaces:**
- Consumes: `req.tenantHost.tenantId`.
- `LoginUseCase.execute` signature is unchanged (still `{ tenantId, email, password }`).

- [ ] **Step 1: Update the login e2e expectations first (add a no-tenant-host case)**

In `test/auth.e2e-spec.ts`:
- Remove `subdomain: 'sonrisa'` from the two successful/`401` login bodies (keep the `X-Tenant-Host` header added in Task 5).
- Add a new test asserting an unresolved host yields 401:

```typescript
it('rejects login when the host resolves to no tenant', async () => {
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor('does-not-exist'))
    .send({ email: 'owner@sonrisa.com', password: 'S3cret!!' })
    .expect(401);
});
```

Add `import { hostFor } from './support/tenant-host';` if not already present.

- [ ] **Step 2: Remove `subdomain` from the login body in all other specs' `registerAndLogin`**

In `patients`, `appointments`, `clinical-history`, `odontogram`, `role-matrix` specs, delete the `subdomain: opts.subdomain,` line from the **login** `.send({...})` (the `.set('X-Tenant-Host', ...)` from Task 5 stays; `subdomain` stays in the **register** body).

- [ ] **Step 3: Run e2e to verify the login tests now fail**

Run: `npm run test:e2e`
Expected: FAIL — `login.dto.ts` still requires `subdomain` (ValidationPipe `whitelist` strips it, so `dto.subdomain` is undefined and `findTenantBySubdomain(undefined...)` / current controller throws). This confirms the tests exercise the new contract.

- [ ] **Step 4: Simplify the login DTO**

Replace `src/modules/auth/presentation/dto/login.dto.ts`:

```typescript
import { IsEmail, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
```

- [ ] **Step 5: Read the host in the auth controller**

Replace `src/modules/auth/presentation/auth.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterClinicUseCase } from '../application/use-cases/register-clinic.use-case';
import { LoginUseCase } from '../application/use-cases/login.use-case';
import { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerClinic: RegisterClinicUseCase,
    private readonly login: LoginUseCase,
  ) {}

  @Post('register')
  register(
    @Body() dto: RegisterDto,
  ): Promise<{ tenantId: string; userId: string }> {
    return this.registerClinic.execute(dto);
  }

  @Post('login')
  async loginHandler(
    @Req() req: TenantHostRequest,
    @Body() dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const tenantId = req.tenantHost?.tenantId;
    if (!tenantId) {
      // Do not disclose whether the tenant or the credentials were wrong.
      throw new UnauthorizedException('Invalid credentials');
    }
    return this.login.execute({
      tenantId,
      email: dto.email,
      password: dto.password,
    });
  }
}
```

Note: the `AUTH_REPOSITORY` injection and `findTenantBySubdomain` call are removed from the controller. `findTenantBySubdomain` stays on the repository/port — `RegisterClinicUseCase` still uses it.

- [ ] **Step 6: Run e2e + build to verify green**

Run: `npm run build && npm run test:e2e`
Expected: PASS (including the new no-tenant-host 401 case).

- [ ] **Step 7: Commit**

```bash
git add src/modules/auth/presentation/dto/login.dto.ts src/modules/auth/presentation/auth.controller.ts test/
git commit -m "feat: login derives tenant from host; drop manual subdomain field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Tenant-host end-to-end coverage

**Files:**
- Create: `test/tenant-host.e2e-spec.ts`

**Interfaces:**
- Consumes: `hostFor`, existing register/login HTTP contract, `GET /api/v1/staff` as a protected probe.

- [ ] **Step 1: Write the e2e spec**

Create `test/tenant-host.e2e-spec.ts` (mirror the harness of `test/patients.e2e-spec.ts` — `raw` admin client for cleanup, `AppModule`, global prefix, ValidationPipe):

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

async function register(app: INestApplication<App>, subdomain: string) {
  await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: subdomain,
      subdomain,
      email: `owner@${subdomain}.com`,
      password: 'S3cret!!',
      fullName: 'Dr. Owner',
    })
    .expect(201);
}

async function login(app: INestApplication<App>, subdomain: string) {
  const res = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(subdomain))
    .send({ email: `owner@${subdomain}.com`, password: 'S3cret!!' })
    .expect(201);
  return (res.body as LoginResponseBody).accessToken;
}

describe('Tenant host resolution (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await register(app, 'tenant-a');
    await register(app, 'tenant-b');
  });

  afterAll(async () => {
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('logs in when the host resolves to a tenant', async () => {
    const token = await login(app, 'tenant-a');
    expect(token).toBeDefined();
  });

  it('rejects login when the host resolves to no tenant', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor('ghost'))
      .send({ email: 'owner@tenant-a.com', password: 'S3cret!!' })
      .expect(401);
  });

  it('accepts a protected request on the token’s own host', async () => {
    const token = await login(app, 'tenant-a');
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor('tenant-a'))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a token presented on another tenant’s host', async () => {
    const token = await login(app, 'tenant-a');
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', hostFor('tenant-b'))
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npm run test:e2e -- tenant-host`
Expected: PASS (4 cases).

- [ ] **Step 3: Commit**

```bash
git add test/tenant-host.e2e-spec.ts
git commit -m "test: e2e host-based login + cross-tenant token rejection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: `domains` module — register + list custom domains

**Files:**
- Create: `src/modules/domains/domain/entities/tenant-domain.entity.ts`
- Create: `src/modules/domains/domain/ports/tenant-domain-repository.port.ts`
- Create: `src/modules/domains/infrastructure/repositories/prisma-tenant-domain.repository.ts`
- Create: `src/modules/domains/application/use-cases/register-domain.use-case.ts`
- Create: `src/modules/domains/application/use-cases/register-domain.use-case.spec.ts`
- Create: `src/modules/domains/application/use-cases/list-domains.use-case.ts`
- Create: `src/modules/domains/presentation/dto/create-domain.dto.ts`
- Create: `src/modules/domains/presentation/domains.controller.ts`
- Create: `src/modules/domains/domains.module.ts`
- Modify: `src/app.module.ts` (import `DomainsModule`)

**Interfaces:**
- Produces:
  - `TenantDomainRecord = { id: string; host: string; status: 'PENDING' | 'VERIFIED'; verifyToken: string; verifiedAt: Date | null; createdAt: Date }`
  - `TENANT_DOMAIN_REPOSITORY` symbol + `TenantDomainRepository` port:
    - `create(input: { host: string; verifyToken: string }): Promise<TenantDomainRecord>`
    - `listByTenant(): Promise<TenantDomainRecord[]>`
    - `findByHostForTenant(host: string): Promise<TenantDomainRecord | null>`
    - `findById(id: string): Promise<TenantDomainRecord | null>` (tenant-scoped)
    - `markVerified(id: string): Promise<void>` (used in Task 10)
  - `RegisterDomainUseCase.execute(input: { host: string }): Promise<{ domain: TenantDomainRecord; dns: { name: string; type: 'TXT'; value: string } }>`
  - `ListDomainsUseCase.execute(): Promise<TenantDomainRecord[]>`

- [ ] **Step 1: Create the entity type**

Create `src/modules/domains/domain/entities/tenant-domain.entity.ts`:

```typescript
export type TenantDomainStatus = 'PENDING' | 'VERIFIED';

export interface TenantDomainRecord {
  id: string;
  host: string;
  status: TenantDomainStatus;
  verifyToken: string;
  verifiedAt: Date | null;
  createdAt: Date;
}
```

- [ ] **Step 2: Create the repository port**

Create `src/modules/domains/domain/ports/tenant-domain-repository.port.ts`:

```typescript
import { TenantDomainRecord } from '../entities/tenant-domain.entity';

export const TENANT_DOMAIN_REPOSITORY = Symbol('TENANT_DOMAIN_REPOSITORY');

export interface TenantDomainRepository {
  create(input: {
    host: string;
    verifyToken: string;
  }): Promise<TenantDomainRecord>;
  listByTenant(): Promise<TenantDomainRecord[]>;
  findByHostForTenant(host: string): Promise<TenantDomainRecord | null>;
  findById(id: string): Promise<TenantDomainRecord | null>;
  markVerified(id: string): Promise<void>;
}
```

- [ ] **Step 3: Write the failing use-case test (register)**

Create `src/modules/domains/application/use-cases/register-domain.use-case.spec.ts`:

```typescript
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RegisterDomainUseCase } from './register-domain.use-case';
import { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';

function makeRepo(
  overrides: Partial<jest.Mocked<TenantDomainRepository>> = {},
): jest.Mocked<TenantDomainRepository> {
  return {
    create: jest.fn(async ({ host, verifyToken }) => ({
      id: 'd-1',
      host,
      status: 'PENDING',
      verifyToken,
      verifiedAt: null,
      createdAt: new Date(0),
    })),
    listByTenant: jest.fn(),
    findByHostForTenant: jest.fn().mockResolvedValue(null),
    findById: jest.fn(),
    markVerified: jest.fn(),
    ...overrides,
  } as jest.Mocked<TenantDomainRepository>;
}

const config = {
  get: jest.fn().mockReturnValue('dentalix.app,localhost'),
} as unknown as ConfigService;

describe('RegisterDomainUseCase', () => {
  it('normalizes the host, creates a PENDING record, and returns DNS instructions', async () => {
    const repo = makeRepo();
    const uc = new RegisterDomainUseCase(repo, config);
    const result = await uc.execute({ host: '  Citas.MiClinica.com  ' });

    expect(repo.create).toHaveBeenCalledWith({
      host: 'citas.miclinica.com',
      verifyToken: expect.any(String),
    });
    expect(result.domain.status).toBe('PENDING');
    expect(result.dns).toEqual({
      name: '_dentalix-verify.citas.miclinica.com',
      type: 'TXT',
      value: result.domain.verifyToken,
    });
  });

  it('rejects a host that is actually a subdomain of a base domain', async () => {
    const uc = new RegisterDomainUseCase(makeRepo(), config);
    await expect(uc.execute({ host: 'acme.dentalix.app' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects a host already registered for this tenant', async () => {
    const repo = makeRepo({
      findByHostForTenant: jest.fn().mockResolvedValue({
        id: 'd-0',
        host: 'citas.miclinica.com',
        status: 'PENDING',
        verifyToken: 'x',
        verifiedAt: null,
        createdAt: new Date(0),
      }),
    });
    const uc = new RegisterDomainUseCase(repo, config);
    await expect(
      uc.execute({ host: 'citas.miclinica.com' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test -- register-domain`
Expected: FAIL — cannot find module `./register-domain.use-case`.

- [ ] **Step 5: Implement the register use case**

Create `src/modules/domains/application/use-cases/register-domain.use-case.ts`:

```typescript
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TENANT_DOMAIN_REPOSITORY,
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';
import { parseHost } from '../../../../shared/tenancy/host-parser';

export interface RegisterDomainResult {
  domain: TenantDomainRecord;
  dns: { name: string; type: 'TXT'; value: string };
}

@Injectable()
export class RegisterDomainUseCase {
  private readonly baseDomains: string[];

  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    config: ConfigService,
  ) {
    this.baseDomains = (config.get<string>('TENANT_BASE_DOMAINS') ?? 'localhost')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  async execute(input: { host: string }): Promise<RegisterDomainResult> {
    const host = input.host.trim().toLowerCase().split(':')[0];
    if (!host || !host.includes('.')) {
      throw new BadRequestException('Invalid domain');
    }
    // A host under a managed base domain is a subdomain, not a custom domain.
    if (parseHost(host, this.baseDomains)?.kind === 'subdomain') {
      throw new BadRequestException(
        'That host is a managed subdomain, not a custom domain',
      );
    }
    if (await this.repo.findByHostForTenant(host)) {
      throw new ConflictException('Domain already registered');
    }
    const verifyToken = `dentalix-verify=${randomBytes(16).toString('hex')}`;
    const domain = await this.repo.create({ host, verifyToken });
    return {
      domain,
      dns: { name: `_dentalix-verify.${host}`, type: 'TXT', value: verifyToken },
    };
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- register-domain`
Expected: PASS.

- [ ] **Step 7: Implement the list use case**

Create `src/modules/domains/application/use-cases/list-domains.use-case.ts`:

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  TENANT_DOMAIN_REPOSITORY,
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';

@Injectable()
export class ListDomainsUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
  ) {}

  execute(): Promise<TenantDomainRecord[]> {
    return this.repo.listByTenant();
  }
}
```

- [ ] **Step 8: Implement the Prisma repository (explicit tenant scoping — no RLS on this table)**

Create `src/modules/domains/infrastructure/repositories/prisma-tenant-domain.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import { TenantDomainRecord } from '../../domain/entities/tenant-domain.entity';

const SELECT = {
  id: true,
  host: true,
  status: true,
  verifyToken: true,
  verifiedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class PrismaTenantDomainRepository implements TenantDomainRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // tenant_domains has NO RLS (it is queried before a tenant is known, for
  // routing). Every management query MUST be scoped by the context tenant.
  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async create(input: {
    host: string;
    verifyToken: string;
  }): Promise<TenantDomainRecord> {
    return this.prisma.tenantDomain.create({
      data: {
        tenantId: this.tenantId(),
        host: input.host,
        verifyToken: input.verifyToken,
      },
      select: SELECT,
    });
  }

  listByTenant(): Promise<TenantDomainRecord[]> {
    return this.prisma.tenantDomain.findMany({
      where: { tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  findByHostForTenant(host: string): Promise<TenantDomainRecord | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { tenantId: this.tenantId(), host, deletedAt: null },
      select: SELECT,
    });
  }

  findById(id: string): Promise<TenantDomainRecord | null> {
    return this.prisma.tenantDomain.findFirst({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      select: SELECT,
    });
  }

  async markVerified(id: string): Promise<void> {
    await this.prisma.tenantDomain.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
  }
}
```

- [ ] **Step 9: Create the DTO**

Create `src/modules/domains/presentation/dto/create-domain.dto.ts`:

```typescript
import { Matches } from 'class-validator';

export class CreateDomainDto {
  // A dotted hostname: labels of alphanumerics/hyphens separated by dots.
  @Matches(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, {
    message: 'host must be a valid domain name',
  })
  host!: string;
}
```

- [ ] **Step 10: Create the controller (OWNER only)**

Create `src/modules/domains/presentation/domains.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { CreateDomainDto } from './dto/create-domain.dto';
import { RegisterDomainUseCase } from '../application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from '../application/use-cases/list-domains.use-case';

@ApiTags('domains')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.OWNER)
@Controller('domains')
export class DomainsController {
  constructor(
    private readonly registerDomain: RegisterDomainUseCase,
    private readonly listDomains: ListDomainsUseCase,
  ) {}

  @Post()
  create(@Body() dto: CreateDomainDto) {
    return this.registerDomain.execute({ host: dto.host });
  }

  @Get()
  list() {
    return this.listDomains.execute();
  }
}
```

- [ ] **Step 11: Create the module**

Create `src/modules/domains/domains.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DomainsController } from './presentation/domains.controller';
import { RegisterDomainUseCase } from './application/use-cases/register-domain.use-case';
import { ListDomainsUseCase } from './application/use-cases/list-domains.use-case';
import { TENANT_DOMAIN_REPOSITORY } from './domain/ports/tenant-domain-repository.port';
import { PrismaTenantDomainRepository } from './infrastructure/repositories/prisma-tenant-domain.repository';
import { TokenService } from '../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';

@Module({
  imports: [JwtModule.register({})],
  controllers: [DomainsController],
  providers: [
    RegisterDomainUseCase,
    ListDomainsUseCase,
    TokenService,
    TenantContextInterceptor,
    { provide: TENANT_DOMAIN_REPOSITORY, useClass: PrismaTenantDomainRepository },
  ],
})
export class DomainsModule {}
```

- [ ] **Step 12: Register `DomainsModule` in `AppModule`**

Modify `src/app.module.ts`: add `import { DomainsModule } from './modules/domains/domains.module';` and append `DomainsModule` to the `imports` array.

- [ ] **Step 13: Verify unit tests + build**

Run: `npm test -- register-domain && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 14: Commit**

```bash
git add src/modules/domains src/app.module.ts
git commit -m "feat: domains module — register + list custom domains (OWNER, tenant-scoped)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: DNS TXT verification

**Files:**
- Create: `src/modules/domains/domain/ports/dns-resolver.port.ts`
- Create: `src/modules/domains/infrastructure/dns/node-dns-resolver.ts`
- Create: `src/modules/domains/application/use-cases/verify-domain.use-case.ts`
- Create: `src/modules/domains/application/use-cases/verify-domain.use-case.spec.ts`
- Modify: `src/modules/domains/presentation/domains.controller.ts` (add `POST :id/verify`)
- Modify: `src/modules/domains/domains.module.ts` (provide DNS resolver + use case)

**Interfaces:**
- Produces:
  - `DNS_RESOLVER` symbol + `DnsResolver` port: `resolveTxt(name: string): Promise<string[]>`
  - `VerifyDomainUseCase.execute(input: { id: string }): Promise<{ status: 'PENDING' | 'VERIFIED' }>`

- [ ] **Step 1: Create the DNS resolver port**

Create `src/modules/domains/domain/ports/dns-resolver.port.ts`:

```typescript
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');

export interface DnsResolver {
  /** Returns the flattened TXT record strings for `name`, or [] if none. */
  resolveTxt(name: string): Promise<string[]>;
}
```

- [ ] **Step 2: Write the failing use-case test**

Create `src/modules/domains/application/use-cases/verify-domain.use-case.spec.ts`:

```typescript
import { NotFoundException } from '@nestjs/common';
import { VerifyDomainUseCase } from './verify-domain.use-case';
import { TenantDomainRepository } from '../../domain/ports/tenant-domain-repository.port';
import { DnsResolver } from '../../domain/ports/dns-resolver.port';

const pending = {
  id: 'd-1',
  host: 'citas.miclinica.com',
  status: 'PENDING' as const,
  verifyToken: 'dentalix-verify=abc123',
  verifiedAt: null,
  createdAt: new Date(0),
};

function makeRepo(
  overrides: Partial<jest.Mocked<TenantDomainRepository>> = {},
): jest.Mocked<TenantDomainRepository> {
  return {
    create: jest.fn(),
    listByTenant: jest.fn(),
    findByHostForTenant: jest.fn(),
    findById: jest.fn().mockResolvedValue(pending),
    markVerified: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<TenantDomainRepository>;
}

describe('VerifyDomainUseCase', () => {
  it('marks the domain VERIFIED when a matching TXT record exists', async () => {
    const repo = makeRepo();
    const dns: jest.Mocked<DnsResolver> = {
      resolveTxt: jest.fn().mockResolvedValue([
        'unrelated',
        'dentalix-verify=abc123',
      ]),
    };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.resolveTxt).toHaveBeenCalledWith(
      '_dentalix-verify.citas.miclinica.com',
    );
    expect(repo.markVerified).toHaveBeenCalledWith('d-1');
  });

  it('stays PENDING when no TXT record matches', async () => {
    const repo = makeRepo();
    const dns: jest.Mocked<DnsResolver> = {
      resolveTxt: jest.fn().mockResolvedValue(['something-else']),
    };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'PENDING',
    });
    expect(repo.markVerified).not.toHaveBeenCalled();
  });

  it('is idempotent for an already-verified domain', async () => {
    const repo = makeRepo({
      findById: jest.fn().mockResolvedValue({ ...pending, status: 'VERIFIED' }),
    });
    const dns: jest.Mocked<DnsResolver> = { resolveTxt: jest.fn() };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'd-1' })).resolves.toEqual({
      status: 'VERIFIED',
    });
    expect(dns.resolveTxt).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown/other-tenant domain', async () => {
    const repo = makeRepo({ findById: jest.fn().mockResolvedValue(null) });
    const dns: jest.Mocked<DnsResolver> = { resolveTxt: jest.fn() };
    const uc = new VerifyDomainUseCase(repo, dns);
    await expect(uc.execute({ id: 'nope' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- verify-domain`
Expected: FAIL — cannot find module `./verify-domain.use-case`.

- [ ] **Step 4: Implement the verify use case**

Create `src/modules/domains/application/use-cases/verify-domain.use-case.ts`:

```typescript
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  TENANT_DOMAIN_REPOSITORY,
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import { DNS_RESOLVER, DnsResolver } from '../../domain/ports/dns-resolver.port';

@Injectable()
export class VerifyDomainUseCase {
  constructor(
    @Inject(TENANT_DOMAIN_REPOSITORY)
    private readonly repo: TenantDomainRepository,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
  ) {}

  async execute(input: { id: string }): Promise<{ status: 'PENDING' | 'VERIFIED' }> {
    const domain = await this.repo.findById(input.id);
    if (!domain) throw new NotFoundException('Domain not found');
    if (domain.status === 'VERIFIED') return { status: 'VERIFIED' };

    const records = await this.dns.resolveTxt(`_dentalix-verify.${domain.host}`);
    if (records.some((r) => r.includes(domain.verifyToken))) {
      await this.repo.markVerified(domain.id);
      return { status: 'VERIFIED' };
    }
    return { status: 'PENDING' };
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- verify-domain`
Expected: PASS.

- [ ] **Step 6: Implement the Node DNS resolver**

Create `src/modules/domains/infrastructure/dns/node-dns-resolver.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { resolveTxt } from 'node:dns/promises';
import { DnsResolver } from '../../domain/ports/dns-resolver.port';

@Injectable()
export class NodeDnsResolver implements DnsResolver {
  async resolveTxt(name: string): Promise<string[]> {
    try {
      // resolveTxt returns string[][] (each record can be chunked); join chunks.
      const records = await resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    } catch {
      // ENOTFOUND / ENODATA / SERVFAIL -> treat as "no record yet".
      return [];
    }
  }
}
```

- [ ] **Step 7: Add the verify route to the controller**

In `src/modules/domains/presentation/domains.controller.ts`:
- Add `Param` to the `@nestjs/common` import.
- Inject `VerifyDomainUseCase` in the constructor (add its import).
- Add the endpoint:

```typescript
  @Post(':id/verify')
  verify(@Param('id') id: string) {
    return this.verifyDomain.execute({ id });
  }
```

(Constructor gains `private readonly verifyDomain: VerifyDomainUseCase`.)

- [ ] **Step 8: Wire the resolver + use case into the module**

In `src/modules/domains/domains.module.ts`, add imports and providers:

```typescript
import { VerifyDomainUseCase } from './application/use-cases/verify-domain.use-case';
import { DNS_RESOLVER } from './domain/ports/dns-resolver.port';
import { NodeDnsResolver } from './infrastructure/dns/node-dns-resolver';
```

Add to `providers`: `VerifyDomainUseCase` and `{ provide: DNS_RESOLVER, useClass: NodeDnsResolver }`.

- [ ] **Step 9: Verify unit tests + build**

Run: `npm test -- verify-domain && npm run build`
Expected: PASS + build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/modules/domains
git commit -m "feat: DNS TXT verification for custom domains (injectable resolver)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Domains end-to-end coverage

**Files:**
- Create: `test/domains.e2e-spec.ts`

**Interfaces:**
- Consumes: `hostFor`, register/login contract, `POST/GET /api/v1/domains`, `raw` admin client to flip a domain to VERIFIED (the app uses real DNS, so e2e verifies *resolution*, not the DNS lookup — that is unit-tested in Task 10).

- [ ] **Step 1: Write the e2e spec**

Create `test/domains.e2e-spec.ts` (same harness as Task 8):

```typescript
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface LoginResponseBody {
  accessToken: string;
}
interface RegisterDomainBody {
  domain: { id: string; host: string; status: string; verifyToken: string };
  dns: { name: string; type: string; value: string };
}

const SUB = 'clinica-domains';
const CUSTOM = 'citas.clinica-domains-white.com';

describe('Domains (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    await raw.tenantDomain.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        clinicName: 'Clinica Domains',
        subdomain: SUB,
        email: `owner@${SUB}.com`,
        password: 'S3cret!!',
        fullName: 'Dr. Owner',
      })
      .expect(201);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUB))
      .send({ email: `owner@${SUB}.com`, password: 'S3cret!!' })
      .expect(201);
    token = (login.body as LoginResponseBody).accessToken;
  });

  afterAll(async () => {
    await raw.tenantDomain.deleteMany();
    await raw.clinicMembership.deleteMany();
    await raw.user.deleteMany();
    await raw.tenant.deleteMany();
    await app.close();
    await raw.$disconnect();
  });

  it('registers a custom domain as PENDING with DNS instructions', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/domains')
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${token}`)
      .send({ host: CUSTOM })
      .expect(201);
    const body = res.body as RegisterDomainBody;
    expect(body.domain.status).toBe('PENDING');
    expect(body.dns).toEqual({
      name: `_dentalix-verify.${CUSTOM}`,
      type: 'TXT',
      value: body.domain.verifyToken,
    });
  });

  it('does NOT resolve a pending custom domain', async () => {
    // Token is valid, but the pending host resolves to no tenant -> 401.
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', CUSTOM)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('resolves a verified custom domain', async () => {
    await raw.tenantDomain.updateMany({
      where: { host: CUSTOM },
      data: { status: 'VERIFIED', verifiedAt: new Date() },
    });
    await request(app.getHttpServer())
      .get('/api/v1/staff')
      .set('X-Tenant-Host', CUSTOM)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('lists the tenant’s domains', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/domains')
      .set('X-Tenant-Host', hostFor(SUB))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<{ host: string }>)[0].host).toBe(CUSTOM);
  });
});
```

- [ ] **Step 2: Run the spec**

Run: `npm run test:e2e -- domains`
Expected: PASS (4 cases).

- [ ] **Step 3: Run the full suite as a final gate**

Run: `npm test && npm run test:e2e && npm run test:int && npm run build`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/domains.e2e-spec.ts
git commit -m "test: e2e custom-domain register/list + pending-vs-verified resolution

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the frontend / ops (out of scope for this plan)

- The web login form must **drop the subdomain input** and rely on the host.
- Set `TENANT_BASE_DOMAINS` per environment; set `TRUST_PROXY=true` only behind a trusted reverse proxy that sets `X-Forwarded-Host`.
- White-label custom domains still need TLS termination + DNS pointing to the app at the infra layer; this plan only covers ownership verification and host→tenant routing.
- Every authenticated request now performs one host→tenant lookup in the middleware. If this ever shows up in profiling, add a short-TTL in-memory cache keyed by host (deliberately omitted now — YAGNI).
