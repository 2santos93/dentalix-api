import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-170, capa DB: plantillas de evolución (RLS FORCE, FK compuestas, CHECK) y
// la evolución ligada a cita y plantilla (FK compuestas con el paciente) sin
// tocar la inmutabilidad de DX-038. Lo que se prueba va por la MISMA ruta que
// la app (runWithTenant, rol dentalix_app, sujeto a RLS) o por SQL directo
// como dentalix_app; `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx170-int-a', 'dx170-int-b'];
const FK_VIOLATION = { code: 'P2003' };
const IMMUTABLE = /inalterable/;

interface Clinic {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  appointmentId: string;
  otherPatientAppointmentId: string;
  templateId: string;
}

let authorId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, { tenantId, name: 'Sede' }),
  });
  const [patient, other] = await Promise.all(
    ['Ana', 'Otra'].map((firstName) =>
      raw.patient.create({
        data: { tenantId, firstName, lastName: subdomain },
      }),
    ),
  );
  // Horas distintas: el mismo profesional no puede tener dos citas a la vez.
  const appointment = (patientId: string, hour: number) =>
    raw.appointment.create({
      data: {
        tenantId,
        locationId: location.id,
        patientId,
        providerId: authorId,
        start: new Date(Date.UTC(2026, 9, 1, hour)),
        end: new Date(Date.UTC(2026, 9, 1, hour, 30)),
        status: 'COMPLETED',
      },
    });
  const own = await appointment(patient.id, 14);
  const others = await appointment(other.id, 15);
  const template = await raw.clinicalNoteTemplate.create({
    data: {
      tenantId,
      name: 'Resina',
      body: 'Superficie {{Superficie}}',
      prompts: {
        create: [
          {
            label: 'Superficie',
            type: 'ONE',
            options: ['O', 'M'],
            position: 0,
          },
        ],
      },
    },
  });
  return {
    tenantId,
    patientId: patient.id,
    otherPatientId: other.id,
    appointmentId: own.id,
    otherPatientAppointmentId: others.id,
    templateId: template.id,
  };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario: el trigger de DX-038 deja la purga administrativa.
  await raw.clinicalEntry.deleteMany({ where });
  await raw.clinicalNoteTemplate.deleteMany({ where });
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('plantillas de evolución y evolución ligada a la cita (int, DX-170)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: 'dx170-int@example.com' } });
    authorId = (
      await raw.user.create({
        data: {
          email: 'dx170-int@example.com',
          passwordHash: 'x',
          fullName: 'Dra. Ríos',
        },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { id: authorId } });
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  function entry(
    extra: Partial<Prisma.ClinicalEntryUncheckedCreateInput>,
  ): Prisma.ClinicalEntryUncheckedCreateInput {
    return {
      tenantId: a.tenantId,
      patientId: a.patientId,
      entryDate: new Date('2026-10-01T14:00:00Z'),
      notes: 'Superficie O',
      performedById: authorId,
      ...extra,
    };
  }

  describe.each(['clinical_note_templates', 'clinical_note_template_prompts'])(
    '%s',
    (table) => {
      it('tiene RLS ENABLE + FORCE y la política del tenant', async () => {
        const rows = await raw.$queryRawUnsafe<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
        );
        expect(rows[0]).toEqual({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
        const policies = await raw.$queryRaw<{ policyname: string }[]>`
          SELECT policyname FROM pg_policies WHERE tablename = ${table}`;
        expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
      });
    },
  );

  it('cada clínica ve solo sus plantillas y preguntas, y no escribe en otra', async () => {
    const templates = await asA((tx) => tx.clinicalNoteTemplate.findMany());
    expect(templates.map((t) => t.id)).toEqual([a.templateId]);
    const prompts = await asA((tx) => tx.clinicalNoteTemplatePrompt.findMany());
    expect(new Set(prompts.map((p) => p.templateId))).toEqual(
      new Set([a.templateId]),
    );

    await expect(
      asA((tx) =>
        tx.clinicalNoteTemplate.create({
          data: { tenantId: b.tenantId, name: 'Intrusa', body: 'x' },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: una pregunta no cuelga de la plantilla de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.clinicalNoteTemplatePrompt.create({
          data: {
            tenantId: a.tenantId,
            templateId: b.templateId,
            label: 'Robada',
            type: 'TEXT',
            position: 5,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it.each([
    ['ONE sin opciones', { type: 'ONE' as const, options: [] }],
    ['MULTI sin opciones', { type: 'MULTI' as const, options: [] }],
    ['TEXT con opciones', { type: 'TEXT' as const, options: ['x'] }],
    ['etiqueta de más de 50', { type: 'TEXT' as const, label: 'x'.repeat(51) }],
  ])('el CHECK de la pregunta rechaza %s', async (_label, override) => {
    await expect(
      asA((tx) =>
        tx.clinicalNoteTemplatePrompt.create({
          data: {
            tenantId: a.tenantId,
            templateId: a.templateId,
            label: 'Pregunta',
            position: 10,
            ...override,
          },
        }),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  describe('clinical_entries.appointmentId / templateId', () => {
    it('acepta la cita y la plantilla de la misma clínica y paciente', async () => {
      const created = await asA((tx) =>
        tx.clinicalEntry.create({
          data: entry({
            appointmentId: a.appointmentId,
            templateId: a.templateId,
          }),
        }),
      );
      expect(created).toMatchObject({
        appointmentId: a.appointmentId,
        templateId: a.templateId,
      });
    });

    it.each([
      [
        'la cita de otro paciente de la clínica',
        () => ({ appointmentId: a.otherPatientAppointmentId }),
      ],
      ['la cita de otra clínica', () => ({ appointmentId: b.appointmentId })],
      ['la plantilla de otra clínica', () => ({ templateId: b.templateId })],
    ])('la FK compuesta rechaza %s', async (_label, extra) => {
      await expect(
        asA((tx) => tx.clinicalEntry.create({ data: entry(extra()) })),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('la evolución sigue inalterable: no se le puede cambiar la cita ni la plantilla', async () => {
      const created = await asA((tx) =>
        tx.clinicalEntry.create({ data: entry({ templateId: a.templateId }) }),
      );
      for (const sql of [
        `UPDATE "clinical_entries" SET "appointmentId" = NULL WHERE "id" = $1::uuid`,
        `UPDATE "clinical_entries" SET "templateId" = NULL WHERE "id" = $1::uuid`,
        `DELETE FROM "clinical_entries" WHERE "id" = $1::uuid`,
      ]) {
        await expect(
          appRole.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
            return tx.$executeRawUnsafe(sql, created.id);
          }),
        ).rejects.toThrow(IMMUTABLE);
      }
    });

    it('editar o desactivar la plantilla no cambia la evolución guardada', async () => {
      const created = await asA((tx) =>
        tx.clinicalEntry.create({
          data: entry({ templateId: a.templateId, notes: 'Superficie M' }),
        }),
      );
      await asA((tx) =>
        tx.clinicalNoteTemplate.update({
          where: { id: a.templateId },
          data: { body: 'Otro texto {{Superficie}}', active: false },
        }),
      );
      const after = await raw.clinicalEntry.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(after).toEqual(created);
    });

    it('RESTRICT: no se puede borrar una plantilla ni una cita con evoluciones', async () => {
      await expect(
        raw.clinicalNoteTemplate.delete({ where: { id: a.templateId } }),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        raw.appointment.delete({ where: { id: a.appointmentId } }),
      ).rejects.toMatchObject(FK_VIOLATION);
    });
  });
});
