import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPayerRepository } from '../src/modules/payers/infrastructure/repositories/prisma-payer.repository';
import { PrismaAppointmentTypeRepository } from '../src/modules/appointment-types/infrastructure/repositories/prisma-appointment-type.repository';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';

/**
 * DX-360: el «antes» de una edición se lee con la fila bloqueada (FOR UPDATE)
 * en la transacción del cambio. Dos ediciones a la vez del mismo registro se
 * serializan: el antes de la segunda es el después de la primera, nunca el
 * valor que ambas leyeron al empezar.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const payers = new PrismaPayerRepository(prisma, tenantContext);
const types = new PrismaAppointmentTypeRepository(prisma, tenantContext);
const ROUNDS = 6;

interface ConfigMeta {
  configChange?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  };
}

describe('auditoría de configuración: ediciones concurrentes (int, DX-360)', () => {
  let tenantId: string;
  let audit: AuditRequestContext;
  const inTenant = <T>(fn: () => Promise<T>) => tenantContext.run(tenantId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    tenantId = (
      await raw.tenant.create({
        data: {
          name: 'Clínica concurrencia',
          subdomain: `dx360-${Date.now()}`,
        },
        select: { id: true },
      })
    ).id;
    audit = {
      tenantId,
      locationId: null,
      actor: { userId: randomUUID(), role: ClinicRole.ADMIN },
      requestId: null,
      ip: null,
      userAgent: null,
    };
  });

  afterAll(async () => {
    await raw.payer.deleteMany({ where: { tenantId } });
    await raw.appointmentType.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  /** Cada evento empieza donde acabó el anterior. */
  async function expectChained(resourceId: string, field: string) {
    const events = await raw.auditEvent.findMany({
      where: { tenantId, resourceId, action: 'UPDATE' },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { metadata: true },
    });
    expect(events.length).toBeGreaterThan(0);
    const changes = events.map((e) => (e.metadata as ConfigMeta).configChange);
    for (let i = 1; i < changes.length; i++) {
      expect(changes[i]?.before?.[field]).toEqual(
        changes[i - 1]?.after?.[field],
      );
    }
    for (const change of changes) {
      expect(change?.before?.[field]).not.toEqual(change?.after?.[field]);
    }
  }

  it('pagador: dos renombres a la vez dejan una cadena A → B → C, nunca dos eventos desde A', async () => {
    const payer = await raw.payer.create({
      data: { tenantId, name: 'Pagador 0', type: 'INSURER' },
    });
    for (let round = 1; round <= ROUNDS; round++) {
      await Promise.all(
        ['x', 'y'].map((suffix) =>
          inTenant(() =>
            payers.update(
              payer.id,
              { name: `Pagador ${round}${suffix}` },
              audit,
            ),
          ),
        ),
      );
    }
    await expectChained(payer.id, 'name');
  });

  it('tipo de cita: dos cambios de duración a la vez quedan encadenados', async () => {
    const type = await raw.appointmentType.create({
      data: {
        tenantId,
        name: 'Tipo concurrente',
        durationMinutes: 30,
        color: '#123456',
      },
    });
    for (let round = 1; round <= ROUNDS; round++) {
      await Promise.all(
        [5, 10].map((delta) =>
          inTenant(() =>
            types.update(
              type.id,
              { durationMinutes: 30 + round * 20 + delta },
              audit,
            ),
          ),
        ),
      );
    }
    await expectChained(type.id, 'durationMinutes');
  });
});
