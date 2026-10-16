import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaPlanQuoteRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-quote.repository';
import { PrismaPlanOptionsRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-plan-options.repository';
import { UpdateTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/update-treatment-plan.use-case';
import { PresentTreatmentPlanUseCase } from '../src/modules/treatment-plans/application/use-cases/present-treatment-plan.use-case';
import { CreatePlanAlternativeUseCase } from '../src/modules/treatment-plans/application/use-cases/create-plan-alternative.use-case';
import { ListPendingFollowUpUseCase } from '../src/modules/treatment-plans/application/use-cases/list-pending-follow-up.use-case';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
} from '../src/modules/treatment-plans/application/use-cases/plan-quote.use-cases';

// DX-040 sobre Postgres: aceptar una opción rechaza a sus hermanas en la MISMA
// transacción (también la aceptación firmada de DX-012 y con dos aceptaciones
// a la vez), la lista de presupuestos por seguir (antigüedad, cita futura,
// sede, clínica, paginación, monto) y las restricciones de la base (FK
// compuesta del grupo, CHECK, trigger del plan firmado). Todo por los
// repositorios reales (rol dentalix_app, RLS); `raw` (owner) siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const quotes = new PrismaPlanQuoteRepository(prisma, tenantContext);
const options = new PrismaPlanOptionsRepository(prisma, tenantContext);
const whitelist = { has: (code: string) => Promise.resolve(code === 'COP') };

const DAY = 24 * 60 * 60 * 1000;
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DENTIST = { role: ClinicRole.DENTIST };

interface Clinic {
  tenantId: string;
  userId: string;
  mainLocationId: string;
  northLocationId: string;
  catalogItemId: string;
}

const clinics: Clinic[] = [];
let a: Clinic;
let b: Clinic;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const user = await raw.user.create({
    data: {
      email: `${subdomain}@example.com`,
      passwordHash: 'x',
      fullName: `Dra ${subdomain}`,
    },
  });
  const main = await raw.location.create({
    data: { tenantId: tenant.id, name: 'Sede principal' },
  });
  const north = await raw.location.create({
    data: {
      tenantId: tenant.id,
      name: 'Sede norte',
      createdAt: new Date(Date.now() + 1000),
    },
  });
  const catalog = await raw.dentalCatalogItem.create({
    data: {
      tenantId: tenant.id,
      code: `c-${subdomain}`,
      kind: 'PROCEDURE',
      labelEs: 'Implante',
      color: '#123456',
    },
  });
  const clinic = {
    tenantId: tenant.id,
    userId: user.id,
    mainLocationId: main.id,
    northLocationId: north.id,
    catalogItemId: catalog.id,
  };
  clinics.push(clinic);
  return clinic;
}

async function patient(
  c: Clinic,
  firstName: string,
  extra: Partial<Prisma.PatientUncheckedCreateInput> = {},
): Promise<string> {
  const row = await raw.patient.create({
    data: {
      tenantId: c.tenantId,
      firstName,
      lastName: 'Prueba',
      phone: '+57 300 000 0000',
      ...extra,
    },
  });
  return row.id;
}

async function plan(
  c: Clinic,
  patientId: string,
  data: Partial<Prisma.TreatmentPlanUncheckedCreateInput> = {},
  items: { price: number; discount?: number }[] = [{ price: 100 }],
): Promise<string> {
  const row = await raw.treatmentPlan.create({
    data: { tenantId: c.tenantId, patientId, currency: 'COP', ...data },
  });
  for (const item of items) {
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: c.tenantId,
        planId: row.id,
        toothNumber: '46',
        catalogItemId: c.catalogItemId,
        price: item.price,
        discount: item.discount ?? 0,
      },
    });
  }
  return row.id;
}

/** Plan presentado hace `days` días en `locationId`. */
function presented(days: number, locationId: string) {
  return {
    status: 'PRESENTED' as const,
    presentedAt: new Date(Date.now() - days * DAY),
    presentedLocationId: locationId,
  };
}

async function appointment(
  c: Clinic,
  patientId: string,
  startOffsetDays: number,
  status: 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' = 'SCHEDULED',
): Promise<void> {
  const start = new Date(Date.now() + startOffsetDays * DAY);
  await raw.appointment.create({
    data: {
      tenantId: c.tenantId,
      locationId: c.mainLocationId,
      patientId,
      providerId: c.userId,
      start,
      end: new Date(start.getTime() + 30 * 60 * 1000),
      status,
    },
  });
}

function inClinic<T>(c: Clinic, fn: () => Promise<T>, locationId?: string) {
  return tenantContext.run(c.tenantId, locationId, fn);
}

async function statusOf(id: string) {
  return raw.treatmentPlan.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      rejectionReason: true,
      rejectedAt: true,
      optionGroupId: true,
    },
  });
}

/** Grupo A (raíz) + B + C del mismo paciente. */
async function group(
  c: Clinic,
  patientId: string,
): Promise<{ a: string; b: string; c: string }> {
  const rootId = await plan(c, patientId, presented(1, c.mainLocationId));
  await raw.treatmentPlan.update({
    where: { id: rootId },
    data: { optionGroupId: rootId, optionLabel: 'Opción A' },
  });
  const bId = await plan(c, patientId, {
    ...presented(1, c.mainLocationId),
    optionGroupId: rootId,
    optionLabel: 'Opción B',
  });
  const cId = await plan(c, patientId, {
    optionGroupId: rootId,
    optionLabel: 'Opción C',
  });
  return { a: rootId, b: bId, c: cId };
}

describe('alternativas de plan y seguimiento (DX-040, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    a = await seedClinic('tpl-alternatives-a-int');
    b = await seedClinic('tpl-alternatives-b-int');
  });

  afterAll(async () => {
    const where = { tenantId: { in: clinics.map((c) => c.tenantId) } };
    // Sin `app.current_tenant` (owner): los triggers dejan borrar.
    await raw.treatmentPlanAcceptance.deleteMany({ where });
    await raw.treatmentPlanItem.deleteMany({ where });
    await raw.treatmentPlan.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
    await raw.dentalCatalogItem.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({
      where: { id: { in: clinics.map((c) => c.tenantId) } },
    });
    await raw.user.deleteMany({
      where: { id: { in: clinics.map((c) => c.userId) } },
    });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('aceptar una opción rechaza a sus hermanas en la misma transacción', () => {
    it('PATCH a ACCEPTED: las hermanas abiertas pasan a REJECTED «otra opción aceptada»', async () => {
      const p = await patient(a, 'Grupo');
      const g = await group(a, p);
      const loose = await plan(a, p);
      const update = new UpdateTreatmentPlanUseCase(
        plans,
        whitelist,
        () => new Date('2026-10-16T15:00:00.000Z'),
      );

      await inClinic(a, () =>
        update.execute(g.a, { status: 'ACCEPTED' }, DENTIST),
      );

      expect(await statusOf(g.a)).toMatchObject({ status: 'ACCEPTED' });
      for (const id of [g.b, g.c]) {
        expect(await statusOf(id)).toEqual({
          status: 'REJECTED',
          rejectionReason: 'OTHER_OPTION_ACCEPTED',
          rejectedAt: new Date('2026-10-16T15:00:00.000Z'),
          optionGroupId: g.a,
        });
      }
      expect((await statusOf(loose)).status).toBe('DRAFT');
    });

    it('si otra opción ya estaba aceptada: 409 y no cambia NADA (ni la propia ni las hermanas)', async () => {
      const p = await patient(a, 'Conflicto');
      const g = await group(a, p);
      // Estado imposible por la API (ya se habría rechazado), forzado por
      // owner para probar que el rechazo de hermanas y la aceptación son una
      // sola transacción: si una parte falla, no queda nada a medias.
      await raw.treatmentPlan.update({
        where: { id: g.b },
        data: { status: 'ACCEPTED' },
      });
      const update = new UpdateTreatmentPlanUseCase(
        plans,
        whitelist,
        () => new Date(),
      );

      await expect(
        inClinic(a, () => update.execute(g.a, { status: 'ACCEPTED' }, DENTIST)),
      ).rejects.toMatchObject({ status: 409 });

      expect((await statusOf(g.a)).status).toBe('PRESENTED');
      expect((await statusOf(g.c)).status).toBe('DRAFT');
    });

    it('la aceptación FIRMADA (DX-012) también rechaza a las hermanas', async () => {
      const p = await patient(a, 'Firma');
      const g = await group(a, p);
      const now = () => new Date();
      const get = new GetPlanQuoteUseCase(quotes, now);
      const accept = new AcceptTreatmentPlanUseCase(quotes, now);

      await inClinic(
        a,
        async () => {
          const quote = await get.execute(p, g.b);
          await accept.execute(
            p,
            g.b,
            {
              signerName: 'Grupo Prueba',
              signature: PNG,
              contentHash: quote.contentHash,
            },
            { acceptedById: a.userId, ipAddress: null, userAgent: null },
          );
        },
        a.mainLocationId,
      );

      expect((await statusOf(g.b)).status).toBe('ACCEPTED');
      for (const id of [g.a, g.c]) {
        expect(await statusOf(id)).toMatchObject({
          status: 'REJECTED',
          rejectionReason: 'OTHER_OPTION_ACCEPTED',
        });
      }
    });

    it('dos aceptaciones a la vez de opciones del mismo grupo: gana una y la otra queda rechazada (409)', async () => {
      const p = await patient(a, 'Carrera');
      const g = await group(a, p);
      const update = new UpdateTreatmentPlanUseCase(
        plans,
        whitelist,
        () => new Date(),
      );
      const results = await Promise.allSettled(
        [g.a, g.b].map((id) =>
          inClinic(a, () =>
            update.execute(id, { status: 'ACCEPTED' }, DENTIST),
          ),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { status: 409 } });
      const finals = [await statusOf(g.a), await statusOf(g.b)].map(
        (s) => s.status,
      );
      expect(finals.sort()).toEqual(['ACCEPTED', 'REJECTED']);
    });

    it('presentar guarda la sede del request; la alternativa copia los ítems y abre el grupo', async () => {
      const p = await patient(a, 'Alternativa');
      const source = await plan(a, p, {}, [
        { price: 3500000, discount: 100000 },
        { price: 1200000 },
      ]);
      const alt = new CreatePlanAlternativeUseCase(options);
      const present = new PresentTreatmentPlanUseCase(plans, () => new Date());

      const created = await inClinic(a, () =>
        alt.execute(source, { createdById: a.userId }),
      );
      await inClinic(a, () => present.execute(source), a.northLocationId);

      expect(
        await raw.treatmentPlan.findUniqueOrThrow({ where: { id: source } }),
      ).toMatchObject({
        optionGroupId: source,
        optionLabel: 'Opción A',
        status: 'PRESENTED',
        presentedLocationId: a.northLocationId,
      });
      expect(created).toMatchObject({
        optionGroupId: source,
        optionLabel: 'Opción B',
        patientId: p,
        status: 'DRAFT',
      });
      const copied = await raw.treatmentPlanItem.findMany({
        where: { planId: created.id },
        orderBy: { price: 'desc' },
      });
      expect(
        copied.map((i) => [
          i.price.toNumber(),
          i.discount.toNumber(),
          i.status,
        ]),
      ).toEqual([
        [3500000, 100000, 'PROPOSED'],
        [1200000, 0, 'PROPOSED'],
      ]);
    });
  });

  describe('restricciones de la base', () => {
    it('un plan no entra en el grupo de OTRO paciente ni de otra clínica (FK compuesta)', async () => {
      const p1 = await patient(a, 'Uno');
      const p2 = await patient(a, 'Dos');
      const root = await plan(a, p1);
      await raw.treatmentPlan.update({
        where: { id: root },
        data: { optionGroupId: root },
      });
      await expect(plan(a, p2, { optionGroupId: root })).rejects.toMatchObject({
        code: 'P2003',
      });
      const pb = await patient(b, 'Ajena');
      await expect(plan(b, pb, { optionGroupId: root })).rejects.toMatchObject({
        code: 'P2003',
      });
    });

    it('REJECTED exige motivo y fecha; OTHER exige nota; PRESENTED exige fecha y sede (CHECK)', async () => {
      const p = await patient(a, 'Checks');
      const id = await plan(a, p);
      const fails = (data: Prisma.TreatmentPlanUncheckedUpdateInput) =>
        expect(
          raw.treatmentPlan.update({ where: { id }, data }),
        ).rejects.toThrow(/check constraint|violates check/i);
      await fails({ status: 'REJECTED' });
      await fails({
        status: 'REJECTED',
        rejectedAt: new Date(),
        rejectionReason: 'OTHER',
      });
      await fails({ status: 'PRESENTED' });
      await fails({ optionLabel: '   ' });
    });

    it('un plan aceptado con firma no pasa a REJECTED ni a PRESENTED ni por fuera de la API (trigger)', async () => {
      const p = await patient(a, 'Trigger');
      const id = await plan(a, p, { status: 'ACCEPTED' });
      await raw.treatmentPlanAcceptance.create({
        data: {
          tenantId: a.tenantId,
          planId: id,
          patientId: p,
          locationId: a.mainLocationId,
          signerName: 'Trigger',
          signature: PNG.split(',')[1],
          content: { version: 1 },
          contentHash: 'a'.repeat(64),
          acceptanceHash: 'b'.repeat(64),
          acceptedAt: new Date(),
          acceptedById: a.userId,
        },
      });
      await expect(
        raw.treatmentPlan.update({
          where: { id },
          data: {
            status: 'REJECTED',
            rejectedAt: new Date(),
            rejectionReason: 'PRICE',
          },
        }),
      ).rejects.toThrow(/aceptado y firmado/);
      await expect(
        raw.treatmentPlan.update({
          where: { id },
          data: {
            status: 'PRESENTED',
            presentedAt: new Date(),
            presentedLocationId: a.mainLocationId,
          },
        }),
      ).rejects.toThrow(/aceptado y firmado/);
      await expect(
        raw.treatmentPlan.update({
          where: { id },
          data: { status: 'COMPLETED' },
        }),
      ).resolves.toMatchObject({ status: 'COMPLETED' });
    });
  });

  describe('presupuestos por seguir', () => {
    const list = new ListPendingFollowUpUseCase(options, () => new Date());
    let expected: string;
    let north: string;
    let pastAppointmentOnly: string;
    let f: Clinic;

    beforeAll(async () => {
      // Clínica propia para esta lista: lo de los demás tests no se cuela.
      const c = await seedClinic('tpl-follow-up-int');
      f = c;
      const due = await patient(c, 'Debe', { phone: '+57 301 111 2222' });
      expected = await plan(c, due, presented(10, c.mainLocationId), [
        { price: 3500000, discount: 100000 },
        { price: 900000 },
      ]);

      const booked = await patient(c, 'Agendado');
      await plan(c, booked, presented(10, c.mainLocationId));
      await appointment(c, booked, 3);

      const confirmed = await patient(c, 'Confirmado');
      await plan(c, confirmed, presented(10, c.mainLocationId));
      await appointment(c, confirmed, 5, 'CONFIRMED');

      const past = await patient(c, 'Pasado');
      pastAppointmentOnly = await plan(
        c,
        past,
        presented(12, c.mainLocationId),
      );
      await appointment(c, past, -20, 'COMPLETED');
      await appointment(c, past, 4, 'CANCELLED');

      const recent = await patient(c, 'Reciente');
      await plan(c, recent, presented(3, c.mainLocationId));

      const draft = await patient(c, 'Borrador');
      await plan(c, draft);

      const elsewhere = await patient(c, 'Norte');
      north = await plan(c, elsewhere, presented(15, c.northLocationId));

      const gone = await patient(c, 'Retirado', { deletedAt: new Date() });
      await plan(c, gone, presented(10, c.mainLocationId));

      // Otra clínica con un presupuesto igual de vencido: nunca aparece.
      const other = await patient(b, 'Ajena');
      await plan(b, other, presented(30, b.mainLocationId));
    });

    it('solo PRESENTED con más de N días, sin cita futura, de esta clínica; los más antiguos primero', async () => {
      const page = await inClinic(f, () => list.execute({}));
      expect(page.items.map((i) => i.planId)).toEqual([
        north,
        pastAppointmentOnly,
        expected,
      ]);
      expect(page.total).toBe(3);
    });

    it('cada fila trae paciente, teléfono, monto (precio − descuento) y moneda, y días', async () => {
      const page = await inClinic(f, () => list.execute({}));
      expect(page.items.find((i) => i.planId === expected)).toMatchObject({
        patientName: 'Debe Prueba',
        patientPhone: '+57 301 111 2222',
        total: 4300000,
        currency: 'COP',
        itemCount: 2,
        daysSincePresented: 10,
      });
    });

    it('con sede activa: solo los presentados en esa sede', async () => {
      const page = await inClinic(f, () => list.execute({}), f.northLocationId);
      expect(page.items.map((i) => i.planId)).toEqual([north]);
      expect(page.total).toBe(1);
    });

    it('olderThanDays mueve el corte', async () => {
      const page = await inClinic(f, () => list.execute({ olderThanDays: 11 }));
      expect(page.items.map((i) => i.planId)).toEqual([
        north,
        pastAppointmentOnly,
      ]);
      const all = await inClinic(f, () => list.execute({ olderThanDays: 0 }));
      expect(all.total).toBe(4);
    });

    it('pagina: el total es el de todas las páginas', async () => {
      const second = await inClinic(f, () =>
        list.execute({ page: 2, pageSize: 2 }),
      );
      expect(second).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(second.items.map((i) => i.planId)).toEqual([expected]);
    });

    it('la otra clínica no ve nada de esta (y esta, nada de la otra)', async () => {
      const page = await inClinic(b, () => list.execute({}));
      expect(page.items.every((i) => i.planId !== expected)).toBe(true);
      expect(page.items).toHaveLength(1);
    });
  });
});
