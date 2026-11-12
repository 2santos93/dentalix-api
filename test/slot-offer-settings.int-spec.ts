import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaSlotOfferSettingsRepository } from '../src/modules/waitlist/infrastructure/repositories/prisma-slot-offer-settings.repository';
import { GetSlotOfferSettingsUseCase } from '../src/modules/waitlist/application/use-cases/slot-offer-settings.use-cases';

/**
 * DX-448 contra Postgres: el repositorio de los ajustes de la oferta por
 * enlace lee y escribe SOLO la fila de la clínica del contexto, escribe el
 * evento CLINIC_SETTINGS en la misma transacción (sin sede, DX-363; sin
 * evento si nada cambió) y bajo la fila bloqueada: dos cambios a la vez dejan
 * una cadena de antes/después que de verdad ocurrió.
 */
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaSlotOfferSettingsRepository(prisma, tenantContext);
const SUBDOMAINS = ['dx448-int-a', 'dx448-int-b'];

function ctx(tenantId: string): AuditRequestContext {
  return {
    tenantId,
    // La sede activa de la petición: el evento NO debe llevarla.
    locationId: null,
    actor: { userId: '00000000-0000-4000-8000-000000044801', role: 'ADMIN' },
    requestId: 'req-dx448',
    ip: null,
    userAgent: null,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  await owner.auditEvent.deleteMany({ where: { tenantId: { in: ids } } });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('PrismaSlotOfferSettingsRepository (int, DX-448)', () => {
  let a: string;
  let b: string;
  const asTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    tenantContext.run(tenantId, fn);
  const events = (tenantId: string) =>
    owner.auditEvent.findMany({
      where: { tenantId, resourceType: 'CLINIC_SETTINGS' },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = (
      await owner.tenant.create({
        data: { name: 'A', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    b = (
      await owner.tenant.create({
        data: { name: 'B', subdomain: SUBDOMAINS[1] },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('una clínica nueva: sin caducidad elegida (NULL) y 20 minutos; la lectura resuelve la de la instalación', async () => {
    await expect(asTenant(a, () => repo.get())).resolves.toEqual({
      expiryLeadMinutes: null,
      minLeadMinutes: 20,
    });
    const get = new GetSlotOfferSettingsUseCase(repo, {
      expiryLeadMinutes: 15,
    });
    await expect(asTenant(a, () => get.effective())).resolves.toEqual({
      expiryLeadMinutes: 15,
      minLeadMinutes: 20,
    });
  });

  it('escribe solo la clínica del contexto, con el evento en la transacción y sin sede', async () => {
    const result = await asTenant(a, () =>
      repo.set({ expiryLeadMinutes: 90, minLeadMinutes: 25 }, ctx(a)),
    );
    expect(result).toEqual({
      before: { expiryLeadMinutes: null, minLeadMinutes: 20 },
      after: { expiryLeadMinutes: 90, minLeadMinutes: 25 },
    });
    await expect(asTenant(b, () => repo.get())).resolves.toEqual({
      expiryLeadMinutes: null,
      minLeadMinutes: 20,
    });
    const [event] = await events(a);
    expect(event).toMatchObject({
      action: 'UPDATE',
      resourceId: a,
      locationId: null,
      actorRole: 'ADMIN',
      requestId: 'req-dx448',
    });
    expect(event.metadata).toEqual({
      reason: 'SLOT_OFFER_SETTINGS',
      changedFields: ['expiryLeadMinutes', 'minLeadMinutes'],
      configChange: {
        before: { expiryLeadMinutes: null, minLeadMinutes: 20 },
        after: { expiryLeadMinutes: 90, minLeadMinutes: 25 },
      },
    });
    await expect(events(b)).resolves.toHaveLength(0);
  });

  it('sin cambio no hay evento; con un solo campo cambiado, solo ese', async () => {
    await asTenant(a, () =>
      repo.set({ expiryLeadMinutes: 90, minLeadMinutes: 25 }, ctx(a)),
    );
    await expect(events(a)).resolves.toHaveLength(1);
    await asTenant(a, () =>
      repo.set({ expiryLeadMinutes: 90, minLeadMinutes: 40 }, ctx(a)),
    );
    const all = await events(a);
    expect(all).toHaveLength(2);
    expect(all[1].metadata).toEqual({
      reason: 'SLOT_OFFER_SETTINGS',
      changedFields: ['minLeadMinutes'],
      configChange: {
        before: { minLeadMinutes: 25 },
        after: { minLeadMinutes: 40 },
      },
    });
  });

  it('dos cambios a la vez: cada «antes» es el «después» del otro o el original (fila bloqueada)', async () => {
    const [x, y] = await Promise.all([
      asTenant(b, () =>
        repo.set({ expiryLeadMinutes: 10, minLeadMinutes: 20 }, ctx(b)),
      ),
      asTenant(b, () =>
        repo.set({ expiryLeadMinutes: 20, minLeadMinutes: 20 }, ctx(b)),
      ),
    ]);
    const original = { expiryLeadMinutes: null, minLeadMinutes: 20 };
    const chained =
      (JSON.stringify(x.before) === JSON.stringify(original) &&
        JSON.stringify(y.before) === JSON.stringify(x.after)) ||
      (JSON.stringify(y.before) === JSON.stringify(original) &&
        JSON.stringify(x.before) === JSON.stringify(y.after));
    expect(chained).toBe(true);
    await expect(events(b)).resolves.toHaveLength(2);
  });

  it('un valor fuera de rango no entra ni por el repositorio (CHECK) y no deja evento', async () => {
    const before = (await events(b)).length;
    await expect(
      asTenant(b, () =>
        repo.set({ expiryLeadMinutes: 241, minLeadMinutes: 20 }, ctx(b)),
      ),
    ).rejects.toThrow();
    await expect(events(b)).resolves.toHaveLength(before);
  });
});
