import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service';
import { TenantLinkBaseService } from './tenant-link-base.service';

describe('TenantLinkBaseService (SEC-033)', () => {
  const findFirst = jest.fn();
  const prisma = { tenant: { findFirst } } as unknown as PrismaService;
  const config = (values: Record<string, string>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const service = new TenantLinkBaseService(
    prisma,
    config({
      TENANT_BASE_DOMAINS: 'dentalix.app,localhost',
      PUBLIC_WEB_PROTOCOL: 'https',
    }),
  );

  beforeEach(() => findFirst.mockReset());

  it('host de plataforma: lo usa sin consultar la BD', async () => {
    await expect(service.forTenant('t1', 'demo.localhost:3000')).resolves.toBe(
      'https://demo.localhost:3000',
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('dominio personalizado o sin petición: subdominio de la clínica + primer dominio base', async () => {
    findFirst.mockResolvedValue({ subdomain: 'demo' });
    await expect(service.forTenant('t1', 'clinica-propia.com')).resolves.toBe(
      'https://demo.dentalix.app',
    );
    await expect(service.forTenant('t1')).resolves.toBe(
      'https://demo.dentalix.app',
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 't1', deletedAt: null },
      select: { subdomain: true },
    });
  });

  it('clínica inexistente o borrada: null', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      service.forTenant('t1', 'clinica-propia.com'),
    ).resolves.toBeNull();
  });
});
