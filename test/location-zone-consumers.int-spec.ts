import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaReminderRepository } from '../src/modules/reminders/infrastructure/prisma-reminder.repository';
import { PrismaMedicalAlertsRepository } from '../src/modules/medical-history/infrastructure/repositories/prisma-medical-alerts.repository';
import { PatientMedicalAlertFlags } from '../src/modules/medical-history/application/patient-medical-alert-flags';
import { PrismaReceivablesRepository } from '../src/modules/receivables/infrastructure/prisma-receivables.repository';
import { GetReceivablesAgingUseCase } from '../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';
import { PrismaPatientConsentRepository } from '../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import { PrismaDocumentTypeNamesRepository } from '../src/modules/patients/infrastructure/repositories/prisma-document-type-names.repository';
import { PreviewPatientConsentUseCase } from '../src/modules/consents/application/use-cases/patient-consents.use-cases';
import { InMemoryConsentTemplateRepository } from '../src/modules/consents/application/__fixtures__/in-memory-consent-templates';
import { PrismaPatientImportRepository } from '../src/modules/patient-imports/infrastructure/prisma-patient-import.repository';
import { loadNoticeSettings } from '../src/modules/patients/infrastructure/notices/notice-context';
import { civilDateIn } from '../src/shared/time/civil-day';
import { noticeRecipient } from '../src/modules/patients/domain/communication/notice-recipient';
import { startsAtLabel } from '../src/modules/reminders/domain/starts-at-label';
import {
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  legacyLocationInsert,
  locationData,
} from './support/location-fixtures';

/**
 * GLOBAL-G1 (DX-314): cada módulo corta «hoy» en la zona de SU sede, contra
 * Postgres real con el rol de la app. 15:30 UTC del 20/10 ya es el 21/10 en
 * Tokio (UTC+9) y aún el 20/10 en Bogotá: si un módulo usara otra zona, el
 * día saldría mal. Nunca hay zona por defecto.
 */
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const SUBDOMAINS = ['g1-zone-consumers', 'g1-zone-consumers-empty'];
/** 21/10/2026 00:30 en Tokio; 20/10/2026 10:30 en Bogotá. */
const NOW = new Date('2026-10-20T15:30:00.000Z');

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await owner.treatmentPlanItem.deleteMany({ where });
  await owner.treatmentPlan.deleteMany({ where });
  await owner.appointment.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.dentalCatalogItem.deleteMany({ where });
  await owner.clinicMembership.deleteMany({ where });
  await owner.user.deleteMany({
    where: { email: { endsWith: '@g1-zone-consumers.test' } },
  });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { subdomain: { in: SUBDOMAINS } } });
}

async function conflictOf(promise: Promise<unknown>): Promise<object> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as object;
}

describe('consumidores de la zona de la sede: día civil en Tokio (int, G1)', () => {
  let tenantId: string;
  let emptyTenantId: string;
  let tokyo: string;
  let bogota: string;
  let legacy: string;
  let patientId: string;
  let providerId: string;
  let appointmentId: string;

  const inTenant = <T>(locationId: string | undefined, fn: () => Promise<T>) =>
    tenantContext.run(tenantId, locationId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Zonas por módulo', subdomain: SUBDOMAINS[0] },
      })
    ).id;
    emptyTenantId = (
      await owner.tenant.create({
        data: { name: 'Sin sedes activas', subdomain: SUBDOMAINS[1] },
      })
    ).id;
    // Tokio es la principal (la activa más antigua); Bogotá, la otra.
    tokyo = (
      await owner.location.create({
        data: locationData(REGIONAL_TOKYO_FIXTURE, {
          tenantId,
          name: 'Tokio',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      })
    ).id;
    bogota = (
      await owner.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name: 'Bogotá',
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        }),
      })
    ).id;
    // Creada por una réplica antigua: zona NULL hasta que pase el barrido.
    legacy = await legacyLocationInsert(
      owner,
      tenantId,
      'Réplica antigua',
      REGIONAL_BOGOTA_FIXTURE.country,
    );
    await owner.location.create({
      data: locationData(REGIONAL_BOGOTA_FIXTURE, {
        tenantId: emptyTenantId,
        name: 'Inactiva',
        isActive: false,
      }),
    });
    patientId = (
      await owner.patient.create({
        data: {
          tenantId,
          firstName: 'Aiko',
          lastName: 'Sato',
          email: 'aiko@g1-zone-consumers.test',
          // Cumple 18 el 21/10/2026: ya en Tokio a las 15:30 UTC del 20/10, aún
          // no en Bogotá.
          birthDate: new Date('2008-10-21T00:00:00.000Z'),
        },
      })
    ).id;
    providerId = (
      await owner.user.create({
        data: {
          email: 'doc@g1-zone-consumers.test',
          passwordHash: 'x',
          fullName: 'Dra. Tanaka',
        },
      })
    ).id;
    await owner.clinicMembership.create({
      data: { tenantId, userId: providerId, role: 'DENTIST' },
    });
    appointmentId = (
      await owner.appointment.create({
        data: {
          tenantId,
          locationId: tokyo,
          patientId,
          providerId,
          start: new Date('2026-10-21T01:00:00.000Z'),
          end: new Date('2026-10-21T01:30:00.000Z'),
          status: 'SCHEDULED',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('reminder day cut at Tokyo midnight', async () => {
    const repo = new PrismaReminderRepository(prisma, tenantContext);
    const ctx = await inTenant(undefined, () =>
      repo.loadSendContext(appointmentId),
    );
    expect(ctx?.locationTimeZone).toBe('Asia/Tokyo');
    const { recipient, contact, responsibles, majorityAge } = ctx!;
    // Las dos decisiones de fecha del envío, con lo que da el repositorio:
    // ¿es menor HOY en la sede? y la fecha de la cita del email.
    const recipientOn = (timeZone: string) =>
      noticeRecipient({
        patient: { ...recipient, email: contact.email },
        responsibles,
        majorityAge,
        today: civilDateIn(NOW, timeZone),
        automatic: true,
      });
    expect(recipientOn(ctx!.locationTimeZone)).toMatchObject({
      kind: 'PATIENT',
      minor: false,
    });
    // Con la zona de Bogotá aún sería menor: el día de la sede decide.
    expect(recipientOn('America/Bogota').minor).toBe(true);
    // 01:00 UTC del 21/10 = 10:00 del 21 en Tokio (20:00 del 20 en Bogotá).
    expect(
      startsAtLabel(
        ctx!.appointment.start,
        ctx!.locationTimeZone,
        ctx!.locationFormat,
      ),
    ).toMatch(/^miércoles 21 de octubre de 2026 a las 10:00/);
  });

  it('reminder send context carries the clinic majorityAge', async () => {
    const repo = new PrismaReminderRepository(prisma, tenantContext);
    const { majorityAge: before } = await owner.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { majorityAge: true },
    });
    await owner.tenant.update({
      where: { id: tenantId },
      data: { majorityAge: 20 },
    });
    try {
      const ctx = await inTenant(undefined, () =>
        repo.loadSendContext(appointmentId),
      );
      expect(ctx?.majorityAge).toBe(20);
      expect(ctx).not.toHaveProperty('locationCountry');
    } finally {
      await owner.tenant.update({
        where: { id: tenantId },
        data: { majorityAge: before },
      });
    }
  });

  it('medical alert day cut at Tokyo midnight', async () => {
    const flags = new PatientMedicalAlertFlags(
      new PrismaMedicalAlertsRepository(prisma, tenantContext),
      tenantContext,
      () => NOW,
    );
    await expect(inTenant(tokyo, () => flags.todayInSede())).resolves.toEqual({
      date: '2026-10-21',
      timeZone: 'Asia/Tokyo',
    });
    await expect(inTenant(bogota, () => flags.todayInSede())).resolves.toEqual({
      date: '2026-10-20',
      timeZone: 'America/Bogota',
    });
    // Vista consolidada: la sede principal (Tokio), nunca Bogotá por defecto.
    await expect(
      inTenant(undefined, () => flags.todayInSede()),
    ).resolves.toEqual({ date: '2026-10-21', timeZone: 'Asia/Tokyo' });
    // La cita de Tokio se evalúa con la zona de Tokio; una sede sin zona, 409.
    expect(
      await conflictOf(
        inTenant(undefined, () =>
          flags.forAppointments([
            { id: 'a', patientId, start: NOW, locationId: legacy },
          ]),
        ),
      ),
    ).toMatchObject({ code: 'LOCATION_TIMEZONE_REQUIRED', locationId: legacy });
  });

  it('receivables day cut at Tokyo midnight', async () => {
    const catalogItemId = (
      await owner.dentalCatalogItem.create({
        data: {
          tenantId,
          code: 'g1-zone-consumers',
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        },
      })
    ).id;
    // Una deuda por paciente: su plan aceptado, presentado `presentedAt` en
    // `locationId` (o sin sede), con un ítem aceptado sin pagar.
    const debt = async (
      lastName: string,
      presentedAt: string,
      locationId: string | null,
    ) => {
      const debtor = await owner.patient.create({
        data: { tenantId, firstName: 'Deuda', lastName },
      });
      const plan = await owner.treatmentPlan.create({
        data: {
          tenantId,
          patientId: debtor.id,
          currency: 'JPY',
          status: 'ACCEPTED',
          createdAt: new Date(presentedAt),
          presentedAt: new Date(presentedAt),
          presentedLocationId: locationId,
        },
      });
      await owner.treatmentPlanItem.create({
        data: {
          tenantId,
          planId: plan.id,
          toothNumber: '11',
          catalogItemId,
          price: 1000,
          status: 'ACCEPTED',
        },
      });
      return debtor.id;
    };
    // 20/09 23:30 en Tokio (09:30 en Bogotá): hoy (21/10 en Tokio) son 31
    // días; con la zona de Bogotá serían 30.
    const boundary = await debt('Tokio', '2026-09-20T14:30:00.000Z', tokyo);
    // Sin sede: envejece en la zona de la principal (Tokio), igual que arriba.
    const noLocation = await debt('Sin sede', '2026-09-20T14:30:00.000Z', null);

    const aging = new GetReceivablesAgingUseCase(
      new PrismaReceivablesRepository(prisma, tenantContext),
      () => NOW,
    );
    const ageOf = (page: Awaited<ReturnType<typeof aging.execute>>) =>
      new Map(page.items.map((i) => [i.patient.id, i.oldestAgeDays]));
    const scoped = await inTenant(undefined, () =>
      aging.execute({ locationId: tokyo }),
    );
    expect(scoped.asOf).toBe('2026-10-21');
    expect(ageOf(scoped).get(boundary)).toBe(31);
    // Consolidada: el día de la principal. La sede sin zona y sin deudas no
    // tumba la cartera de la clínica.
    const consolidated = await inTenant(undefined, () => aging.execute({}));
    expect(consolidated.asOf).toBe('2026-10-21');
    expect(ageOf(consolidated).get(boundary)).toBe(31);
    expect(ageOf(consolidated).get(noLocation)).toBe(31);
  });

  it('consent date uses the location zone', async () => {
    const templates = new InMemoryConsentTemplateRepository();
    const template = templates.seed({ body: 'Fecha: {{fecha}}.' });
    const preview = new PreviewPatientConsentUseCase(
      templates,
      new PrismaPatientConsentRepository(prisma, tenantContext),
      () => NOW,
      new PrismaDocumentTypeNamesRepository(prisma, tenantContext),
    );
    const body = (location: string | undefined) =>
      inTenant(location, async () => {
        const out = await preview.execute(
          patientId,
          { templateId: template.id },
          providerId,
        );
        return out.body;
      });
    await expect(body(tokyo)).resolves.toBe('Fecha: 21 de octubre de 2026.');
    await expect(body(bogota)).resolves.toBe('Fecha: 20 de octubre de 2026.');
    // Sin sede activa: la principal (Tokio).
    await expect(body(undefined)).resolves.toBe(
      'Fecha: 21 de octubre de 2026.',
    );
  });

  it('patient import uses the batch location zone', async () => {
    const repo = new PrismaPatientImportRepository(prisma, tenantContext);
    await expect(inTenant(tokyo, () => repo.batchLocation())).resolves.toEqual({
      id: tokyo,
      country: 'JP',
      timeZone: 'Asia/Tokyo',
      currency: 'JPY',
      locale: 'ja-JP',
      hourCycle: 'h23',
    });
    await expect(
      inTenant(undefined, () => repo.locationTimeZone(bogota)),
    ).resolves.toBe('America/Bogota');
    // La sede del lote sin zona: 409, nunca la zona de su país.
    expect(
      await conflictOf(
        inTenant(undefined, () => repo.locationTimeZone(legacy)),
      ),
    ).toMatchObject({ code: 'LOCATION_TIMEZONE_REQUIRED', locationId: legacy });
  });

  it('notice context without locations raises LOCATION_REQUIRED', async () => {
    expect(
      await conflictOf(
        prisma.runWithTenant(emptyTenantId, (tx) =>
          loadNoticeSettings(tx, emptyTenantId, null),
        ),
      ),
    ).toMatchObject({
      code: 'LOCATION_REQUIRED',
      message:
        'La clínica no tiene ninguna sede activa. Crea una en Ajustes → Sedes.',
    });
    // Con sedes: la zona de la principal y la mayoría de edad de la clínica.
    await expect(
      prisma.runWithTenant(tenantId, (tx) =>
        loadNoticeSettings(tx, tenantId, null),
      ),
    ).resolves.toEqual({ timeZone: 'Asia/Tokyo', majorityAge: 18 });
  });
});
