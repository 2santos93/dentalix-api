import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetTenantBrandingByHostUseCase } from './get-tenant-branding-by-host.use-case';
import { TenantBranding } from '../../domain/entities/tenant-branding.entity';
import { TenantBrandingRepository } from '../../domain/ports/tenant-branding-repository.port';
import { TenantResolverService } from '../../../../shared/tenancy/tenant-resolver.service';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

const BRANDING: TenantBranding = {
  name: 'Clínica Ávila',
  primaryColor: '#0E7490',
  logoUrl: 'https://cdn.example.com/avila.png',
  currencyTexts: { USD: 'US$', VES: 'Bs.' },
};

interface DomainRow {
  host: string;
  tenantId: string;
  status: 'PENDING' | 'VERIFIED' | 'DISABLED';
  deletedAt: Date | null;
  tenantDeleted: boolean;
}

/**
 * Prisma en memoria con SOLO lo que lee el resolutor real
 * (`TenantResolverService`): así el test ejercita sus reglas (VERIFIED, borrados,
 * etiquetas reservadas, apex, varias etiquetas) en lugar de copiarlas.
 */
function fakePrisma(opts: {
  tenants: { id: string; subdomain: string; deleted?: boolean }[];
  domains: DomainRow[];
}) {
  const calls = { tenant: 0, domain: 0 };
  const prisma = {
    tenant: {
      findFirst: ({
        where,
      }: {
        where: { subdomain: string; deletedAt: null };
      }) => {
        calls.tenant += 1;
        const t = opts.tenants.find(
          (x) => x.subdomain === where.subdomain && !x.deleted,
        );
        return Promise.resolve(t ? { id: t.id } : null);
      },
    },
    tenantDomain: {
      findFirst: ({
        where,
      }: {
        where: {
          host: string;
          status: string;
          deletedAt: null;
          tenant: { deletedAt: null };
        };
      }) => {
        calls.domain += 1;
        expect(where.status).toBe('VERIFIED');
        expect(where.tenant).toEqual({ deletedAt: null });
        const d = opts.domains.find(
          (x) =>
            x.host === where.host &&
            x.status === 'VERIFIED' &&
            x.deletedAt === null &&
            !x.tenantDeleted,
        );
        return Promise.resolve(d ? { tenantId: d.tenantId } : null);
      },
    },
  };
  return { prisma: prisma as unknown as PrismaService, calls };
}

function build(
  opts: Parameters<typeof fakePrisma>[0],
  repoImpl?: TenantBrandingRepository,
) {
  const { prisma, calls } = fakePrisma(opts);
  const config = {
    get: (k: string) =>
      k === 'TENANT_BASE_DOMAINS' ? 'dentalix.app,localhost' : undefined,
  } as unknown as ConfigService;
  const resolver = new TenantResolverService(prisma, config);
  const resolveSpy = jest.spyOn(resolver, 'resolve');
  const repo: TenantBrandingRepository = repoImpl ?? {
    findById: (id: string) =>
      Promise.resolve(id === 't-avila' ? BRANDING : null),
  };
  return {
    uc: new GetTenantBrandingByHostUseCase(resolver, repo),
    calls,
    resolveSpy,
  };
}

const WORLD = {
  tenants: [
    { id: 't-avila', subdomain: 'avila' },
    { id: 't-borrada', subdomain: 'borrada', deleted: true },
  ],
  domains: [
    {
      host: 'clinica-avila.com.ve',
      tenantId: 't-avila',
      status: 'VERIFIED',
      deletedAt: null,
      tenantDeleted: false,
    },
    {
      host: 'pendiente.com.ve',
      tenantId: 't-avila',
      status: 'PENDING',
      deletedAt: null,
      tenantDeleted: false,
    },
    {
      host: 'desactivado.com.ve',
      tenantId: 't-avila',
      status: 'DISABLED',
      deletedAt: null,
      tenantDeleted: false,
    },
    {
      host: 'borrado.com.ve',
      tenantId: 't-avila',
      status: 'VERIFIED',
      deletedAt: new Date('2026-10-01T00:00:00Z'),
      tenantDeleted: false,
    },
    {
      host: 'de-clinica-borrada.com.ve',
      tenantId: 't-borrada',
      status: 'VERIFIED',
      deletedAt: null,
      tenantDeleted: true,
    },
  ] as DomainRow[],
};

describe('GetTenantBrandingByHostUseCase (DX-517-ter)', () => {
  it('resuelve un subdominio de TENANT_BASE_DOMAINS (también con puerto)', async () => {
    const { uc } = build(WORLD);
    await expect(uc.execute('avila.dentalix.app')).resolves.toBe(BRANDING);
    await expect(uc.execute('AVILA.localhost:3001')).resolves.toBe(BRANDING);
  });

  it('resuelve un dominio propio VERIFIED', async () => {
    const { uc } = build(WORLD);
    await expect(uc.execute('clinica-avila.com.ve')).resolves.toBe(BRANDING);
  });

  it.each([
    ['dominio PENDING', 'pendiente.com.ve'],
    ['dominio DISABLED', 'desactivado.com.ve'],
    ['dominio borrado', 'borrado.com.ve'],
    ['dominio de una clínica borrada', 'de-clinica-borrada.com.ve'],
    ['subdominio de una clínica borrada', 'borrada.localhost'],
    ['subdominio que no existe', 'nadie.dentalix.app'],
    ['apex', 'dentalix.app'],
    ['etiqueta reservada', 'api.dentalix.app'],
    ['www', 'www.dentalix.app'],
    ['varias etiquetas', 'a.avila.dentalix.app'],
  ])('404 para %s', async (_label, host) => {
    const { uc } = build(WORLD);
    await expect(uc.execute(host)).rejects.toThrow(NotFoundException);
  });

  it.each([
    ['vacío', ''],
    ['credenciales', 'demo.dentalix.app:443@evil.com'],
    ['a..b', 'a..b'],
    ['%00', 'avila.localhost%00'],
    ['300 caracteres', `${'a'.repeat(296)}.com`],
    ['lista', ['avila.localhost', 'otra.localhost']],
    ['ausente', undefined],
  ])(
    'host inválido (%s): 404 SIN llamar al resolutor ni a la BD',
    async (_label, host) => {
      const findById = jest.fn(() =>
        Promise.reject(new Error('no debe llamarse')),
      );
      const { uc, calls, resolveSpy } = build(WORLD, { findById });
      await expect(uc.execute(host)).rejects.toThrow(NotFoundException);
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(calls).toEqual({ tenant: 0, domain: 0 });
      expect(findById).not.toHaveBeenCalled();
    },
  );

  it('un host inválido y uno desconocido dan el MISMO 404 (sin oráculo)', async () => {
    const { uc } = build(WORLD);
    const invalid = await uc.execute('a..b').catch((e: unknown) => e);
    const unknown = await uc
      .execute('nadie.dentalix.app')
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(NotFoundException);
    expect((invalid as NotFoundException).getResponse()).toEqual(
      (unknown as NotFoundException).getResponse(),
    );
  });

  it('404 si el resolutor da una clínica que el repositorio ya no encuentra', async () => {
    const { uc } = build(WORLD, { findById: () => Promise.resolve(null) });
    await expect(uc.execute('avila.localhost')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('un fallo de la BD NO se convierte en 404 (la web distingue «ninguna» de «desconocida»)', async () => {
    const boom = new Error('connection terminated');
    const { uc } = build(WORLD, { findById: () => Promise.reject(boom) });
    await expect(uc.execute('avila.localhost')).rejects.toBe(boom);
  });

  it('no depende del contexto de clínica (ni cabeceras ni ALS): solo resolutor y repositorio', () => {
    const deps = (
      Reflect.getMetadata(
        'design:paramtypes',
        GetTenantBrandingByHostUseCase,
      ) as unknown[] | undefined
    )?.filter(Boolean);
    expect(deps).toEqual([TenantResolverService, Object]);
    expect(deps).not.toContain(TenantContextService);
    expect(GetTenantBrandingByHostUseCase.length).toBe(2);
  });
});
