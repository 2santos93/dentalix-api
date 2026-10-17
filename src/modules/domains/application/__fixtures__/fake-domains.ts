import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantDomainRow } from '../../domain/entities/tenant-domain.entity';
import type {
  MarkVerifiedResult,
  RecordCheckResult,
  TenantDomainRepository,
} from '../../domain/ports/tenant-domain-repository.port';
import type {
  DomainRecheckSource,
  VerifiedDomainRef,
} from '../../domain/ports/domain-recheck-source.port';
import {
  DnsLookupError,
  type DnsResolver,
} from '../../domain/ports/dns-resolver.port';
import { DomainClock } from '../domain-clock';

function uniqueViolation(index: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: index },
  });
}

export interface StoredDomain extends TenantDomainRow {
  tenantId: string;
  deletedAt: Date | null;
}

/** Reloj de prueba: avanza a mano. */
export class FakeClock extends DomainClock {
  current = new Date('2026-10-17T12:00:00.000Z');
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * DNS simulado: TXT por nombre; un nombre en `failing` responde como un DNS
 * caído (DnsLookupError).
 */
export class FakeDns implements DnsResolver {
  readonly records = new Map<string, string[]>();
  readonly failing = new Set<string>();
  readonly lookups: string[] = [];

  resolveTxt(name: string): Promise<string[]> {
    this.lookups.push(name);
    if (this.failing.has(name)) {
      return Promise.reject(new DnsLookupError('ESERVFAIL'));
    }
    return Promise.resolve(this.records.get(name) ?? []);
  }
}

/**
 * Repositorio en memoria con la semántica del de Prisma (índices únicos
 * parciales incluidos). Varias clínicas comparten la tabla: `as(tenantId)`
 * da la vista de una de ellas, como el contexto de la petición.
 */
export class InMemoryDomains implements DomainRecheckSource {
  readonly rows: StoredDomain[] = [];

  as(tenantId: string): TenantDomainRepository {
    return new TenantView(this, tenantId);
  }

  seed(
    tenantId: string,
    data: Partial<StoredDomain> & { host: string },
  ): StoredDomain {
    const row: StoredDomain = {
      id: randomUUID(),
      tenantId,
      status: 'PENDING',
      verifyToken: `dentalix-verify=${randomUUID()}`,
      verifiedAt: null,
      expiresAt: null,
      lastCheckedAt: null,
      failedChecks: 0,
      disabledAt: null,
      createdAt: new Date(0),
      deletedAt: null,
      ...data,
    };
    this.assertUnique(row);
    this.rows.push(row);
    return row;
  }

  /** tenant_domains_verified_host_key y tenant_domains_tenant_host_key. */
  assertUnique(candidate: StoredDomain): void {
    for (const r of this.rows) {
      if (r.id === candidate.id || r.deletedAt || candidate.deletedAt) continue;
      if (
        r.host === candidate.host &&
        r.status === 'VERIFIED' &&
        candidate.status === 'VERIFIED'
      ) {
        throw uniqueViolation('tenant_domains_verified_host_key');
      }
      if (r.host === candidate.host && r.tenantId === candidate.tenantId) {
        throw uniqueViolation('tenant_domains_tenant_host_key');
      }
    }
  }

  listVerified(
    afterHost: string | null,
    limit: number,
  ): Promise<VerifiedDomainRef[]> {
    return Promise.resolve(
      this.rows
        .filter(
          (r) =>
            r.status === 'VERIFIED' &&
            !r.deletedAt &&
            (afterHost === null || r.host > afterHost),
        )
        .sort((a, b) => (a.host < b.host ? -1 : 1))
        .slice(0, limit)
        .map((r) => ({ id: r.id, tenantId: r.tenantId, host: r.host })),
    );
  }
}

function view(row: StoredDomain): TenantDomainRow {
  const { tenantId: _t, deletedAt: _d, ...rest } = row;
  return { ...rest };
}

class TenantView implements TenantDomainRepository {
  constructor(
    private readonly store: InMemoryDomains,
    private readonly tenantId: string,
  ) {}

  private live(): StoredDomain[] {
    return this.store.rows.filter(
      (r) => r.tenantId === this.tenantId && !r.deletedAt,
    );
  }

  create(input: {
    host: string;
    verifyToken: string;
    expiresAt: Date;
    replacing?: { id: string; deletedAt: Date };
  }): Promise<TenantDomainRow> {
    const replaced = input.replacing
      ? this.live().find((r) => r.id === input.replacing?.id)
      : undefined;
    if (replaced && input.replacing)
      replaced.deletedAt = input.replacing.deletedAt;
    try {
      return Promise.resolve(
        view(
          this.store.seed(this.tenantId, {
            host: input.host,
            verifyToken: input.verifyToken,
            expiresAt: input.expiresAt,
          }),
        ),
      );
    } catch (error) {
      // Como el rollback de la transacción.
      if (replaced) replaced.deletedAt = null;
      return Promise.reject(error instanceof Error ? error : new Error('x'));
    }
  }

  listByTenant(): Promise<TenantDomainRow[]> {
    return Promise.resolve(this.live().map(view));
  }

  findByHostForTenant(host: string): Promise<TenantDomainRow | null> {
    const row = this.live().find((r) => r.host === host);
    return Promise.resolve(row ? view(row) : null);
  }

  findById(id: string): Promise<TenantDomainRow | null> {
    const row = this.live().find((r) => r.id === id);
    return Promise.resolve(row ? view(row) : null);
  }

  isVerifiedByAnotherTenant(host: string): Promise<boolean> {
    return Promise.resolve(
      this.store.rows.some(
        (r) =>
          r.host === host &&
          r.status === 'VERIFIED' &&
          !r.deletedAt &&
          r.tenantId !== this.tenantId,
      ),
    );
  }

  markVerified(id: string, now: Date): Promise<MarkVerifiedResult> {
    const row = this.live().find((r) => r.id === id);
    const verifiable =
      row &&
      (row.status === 'DISABLED' ||
        (row.status === 'PENDING' &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() > now.getTime()));
    if (!row) return Promise.resolve('unavailable');
    if (!verifiable) {
      return this.isVerifiedByAnotherTenant(row.host).then((taken) =>
        taken ? 'taken' : 'unavailable',
      );
    }
    const next: StoredDomain = {
      ...row,
      status: 'VERIFIED',
      verifiedAt: now,
      expiresAt: null,
      lastCheckedAt: now,
      failedChecks: 0,
      disabledAt: null,
    };
    try {
      this.store.assertUnique(next);
    } catch {
      return Promise.resolve('taken');
    }
    Object.assign(row, next);
    for (const other of this.store.rows) {
      if (
        other.host === row.host &&
        other.tenantId !== this.tenantId &&
        other.status === 'PENDING' &&
        !other.deletedAt &&
        other.expiresAt !== null &&
        other.expiresAt.getTime() > now.getTime()
      ) {
        other.expiresAt = now;
      }
    }
    return Promise.resolve('verified');
  }

  softDelete(id: string, now: Date): Promise<boolean> {
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.resolve(false);
    row.deletedAt = now;
    return Promise.resolve(true);
  }

  findForRecheck(id: string, round: Date): Promise<TenantDomainRow | null> {
    const row = this.live().find(
      (r) =>
        r.id === id &&
        r.status === 'VERIFIED' &&
        (r.lastCheckedAt === null ||
          r.lastCheckedAt.getTime() < round.getTime()),
    );
    return Promise.resolve(row ? view(row) : null);
  }

  recordCheck(input: {
    id: string;
    round: Date;
    expectedFailedChecks: number;
    failedChecks: number;
    disable: boolean;
  }): Promise<RecordCheckResult | null> {
    const row = this.live().find(
      (r) =>
        r.id === input.id &&
        r.status === 'VERIFIED' &&
        r.failedChecks === input.expectedFailedChecks &&
        (r.lastCheckedAt === null ||
          r.lastCheckedAt.getTime() < input.round.getTime()),
    );
    if (!row) return Promise.resolve(null);
    row.lastCheckedAt = input.round;
    row.failedChecks = input.failedChecks;
    if (input.disable) {
      row.status = 'DISABLED';
      row.disabledAt = input.round;
    }
    return Promise.resolve({
      status: input.disable ? 'DISABLED' : 'VERIFIED',
      failedChecks: input.failedChecks,
    });
  }
}
