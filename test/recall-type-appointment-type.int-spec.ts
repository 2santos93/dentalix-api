import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import {
  CreateRecallTypeUseCase,
  UpdateRecallTypeUseCase,
} from '../src/modules/recall/application/use-cases/recall-types.use-cases';
import { RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE } from '../src/modules/recall/domain/recall-type-rules';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import {
  type DefaultRecallTypes,
  seedDefaultRecallTypes,
} from './support/recall-types';

// DX-015-bis (porción 4, D20) · El tipo de cita al agendar de un tipo de
// recall, con el repositorio REAL sobre Postgres como dentalix_app (RLS
// FORCE): la FK compuesta con la clínica (la BD rechaza un tipo de cita de
// otra clínica aunque la API se equivocara) y RESTRICT, y el PATCH (enlazar,
// cambiar, quitar con null; 422 si no existe, es de otra clínica, está
// desactivado o retirado). `raw` (DIRECT_URL, owner) siembra, comprueba y
// limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaRecallRepository(prisma, tenantContext);
const update = new UpdateRecallTypeUseCase(repo);
const create = new CreateRecallTypeUseCase(repo);

const SUBDOMAIN = 'dx015bis4-cita';
const OTHER = 'dx015bis4-cita-otra';
const EMAIL = `admin@${SUBDOMAIN}.test`;
let adminId: string;

interface Clinic {
  tenantId: string;
  types: DefaultRecallTypes;
}
let clinic: Clinic;
let other: Clinic;
let ids: Record<'limpieza' | 'valoracion' | 'inactivo' | 'retirado', string>;
let foreign: string;

const audit = (): AuditRequestContext => ({
  tenantId: clinic.tenantId,
  locationId: null,
  actor: { userId: adminId, role: ClinicRole.ADMIN },
  requestId: 'dx015bis4-int',
  ip: null,
  userAgent: null,
});
const inClinic = <T>(fn: () => Promise<T>) =>
  tenantContext.run(clinic.tenantId, undefined, fn);

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  return {
    tenantId: tenant.id,
    types: await seedDefaultRecallTypes(raw, tenant.id),
  };
}

async function appointmentType(
  tenantId: string,
  name: string,
  extra: { active?: boolean; deletedAt?: Date } = {},
): Promise<string> {
  const row = await raw.appointmentType.create({
    data: { tenantId, name, durationMinutes: 45, color: '#16A34A', ...extra },
  });
  return row.id;
}

const stored = (id: string) =>
  raw.recallType.findUniqueOrThrow({
    where: { id },
    select: { appointmentTypeId: true, name: true },
  });

describe('Tipo de cita al agendar de un tipo de recall (DX-015-bis D20, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    clinic = await seedClinic(SUBDOMAIN);
    const admin = await raw.user.create({
      data: { email: EMAIL, passwordHash: 'x', fullName: 'Lic. Mendoza' },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: admin.id,
        role: ClinicRole.ADMIN,
      },
    });
    adminId = admin.id;
    other = await seedClinic(OTHER);
    ids = {
      limpieza: await appointmentType(clinic.tenantId, 'Limpieza'),
      valoracion: await appointmentType(clinic.tenantId, 'Valoración'),
      inactivo: await appointmentType(clinic.tenantId, 'Desactivado', {
        active: false,
      }),
      retirado: await appointmentType(clinic.tenantId, 'Retirado', {
        deletedAt: new Date(),
      }),
    };
    foreign = await appointmentType(other.tenantId, 'Limpieza');
  }, 60_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER]);
    await raw.user.deleteMany({ where: { email: EMAIL } });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  describe('FK compuesta', () => {
    it('la BD rechaza un tipo de cita de otra clínica (aunque exista)', async () => {
      await expect(
        raw.$executeRaw`UPDATE recall_types SET "appointmentTypeId" = ${foreign}::uuid
                         WHERE id = ${clinic.types.HYGIENE}::uuid`,
      ).rejects.toThrow(/recall_types_appointment_type_fkey/);
      expect((await stored(clinic.types.HYGIENE)).appointmentTypeId).toBeNull();
    });

    it('la FK está validada y es RESTRICT: un tipo de cita enlazado no se borra físicamente', async () => {
      const [fk] = await raw.$queryRaw<
        { validated: boolean; deleteAction: string; cols: string }[]
      >`SELECT c.convalidated AS validated, c.confdeltype::text AS "deleteAction",
               pg_get_constraintdef(c.oid) AS cols
          FROM pg_constraint c
         WHERE c.conname = 'recall_types_appointment_type_fkey'`;
      expect(fk).toMatchObject({ validated: true, deleteAction: 'r' });
      expect(fk.cols).toContain(
        'FOREIGN KEY ("tenantId", "appointmentTypeId") REFERENCES appointment_types("tenantId", id)',
      );

      const temp = await appointmentType(clinic.tenantId, 'Temporal');
      await raw.recallType.update({
        where: { id: clinic.types.PERIO },
        data: { appointmentTypeId: temp },
      });
      await expect(
        raw.$executeRaw`DELETE FROM appointment_types WHERE id = ${temp}::uuid`,
      ).rejects.toThrow(/recall_types_appointment_type_fkey/);
      await raw.recallType.update({
        where: { id: clinic.types.PERIO },
        data: { appointmentTypeId: null },
      });
    });
  });

  describe('PATCH por el repositorio', () => {
    it('enlaza, cambia y quita con null; la auditoría lleva appointmentTypeId', async () => {
      const id = clinic.types.HYGIENE;
      const linked = await inClinic(() =>
        update.execute(id, { appointmentTypeId: ids.limpieza }, audit()),
      );
      expect(linked.appointmentTypeId).toBe(ids.limpieza);
      await inClinic(() =>
        update.execute(id, { appointmentTypeId: ids.valoracion }, audit()),
      );
      expect((await stored(id)).appointmentTypeId).toBe(ids.valoracion);
      const cleared = await inClinic(() =>
        update.execute(id, { appointmentTypeId: null }, audit()),
      );
      expect(cleared.appointmentTypeId).toBeNull();
      expect((await stored(id)).appointmentTypeId).toBeNull();

      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'RECALL_TYPE',
          resourceId: id,
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        select: { metadata: true },
      });
      // Solo lo que cambia va al diff (`configChange`).
      const change = (before: string | null, after: string | null) => ({
        reason: 'RECALL_TYPE_UPDATED',
        changedFields: ['appointmentTypeId'],
        configChange: {
          before: { appointmentTypeId: before },
          after: { appointmentTypeId: after },
        },
      });
      expect(events.map((e) => e.metadata)).toEqual([
        change(null, ids.limpieza),
        change(ids.limpieza, ids.valoracion),
        change(ids.valoracion, null),
      ]);
    });

    it.each([
      ['inexistente', () => '0b7d1c2e-0000-4000-8000-000000000999'],
      ['de otra clínica', () => foreign],
      ['desactivado', () => ids.inactivo],
      ['retirado', () => ids.retirado],
    ])(
      '%s: 422 en español y nada cambia (ni el resto del cuerpo)',
      async (_, pick) => {
        const id = clinic.types.CHECKUP;
        const before = await stored(id);
        await expect(
          inClinic(() =>
            update.execute(
              id,
              { appointmentTypeId: pick(), name: 'No cambia' },
              audit(),
            ),
          ),
        ).rejects.toThrow(
          new UnprocessableEntityException(
            RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE,
          ),
        );
        expect(await stored(id)).toEqual(before);
        await expect(
          inClinic(() =>
            create.execute(
              {
                name: 'Nunca creado',
                defaultIntervalMonths: 6,
                appointmentTypeId: pick(),
              },
              audit(),
            ),
          ),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(
          await raw.recallType.count({
            where: { tenantId: clinic.tenantId, name: 'Nunca creado' },
          }),
        ).toBe(0);
      },
    );

    it('el enlace a uno desactivado después se lee y se conserva al editar otro campo', async () => {
      const cita = await appointmentType(clinic.tenantId, 'Control anual');
      const id = clinic.types.PERIO;
      await inClinic(() =>
        update.execute(id, { appointmentTypeId: cita }, audit()),
      );
      await raw.appointmentType.update({
        where: { id: cita },
        data: { active: false },
      });
      const view = await inClinic(() => repo.findTypeView(id));
      expect(view?.appointmentTypeId).toBe(cita);
      const kept = await inClinic(() =>
        update.execute(id, { appointmentTypeId: cita, sortOrder: 99 }, audit()),
      );
      expect(kept).toMatchObject({ appointmentTypeId: cita, sortOrder: 99 });
    });
  });
});
