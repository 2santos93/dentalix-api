import { createHash, randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientCertificateRepository } from '../src/modules/patient-certificates/infrastructure/prisma-patient-certificate.repository';
import type {
  ArchivePdf,
  NewCertificateInput,
} from '../src/modules/patient-certificates/domain/ports/patient-certificate-repository.port';
import type { CertificateSnapshot } from '../src/modules/patient-certificates/domain/certificate-snapshot';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-306 contra Postgres: patient_certificates con RLS FORCE, FK compuestas a
// paciente (y cita del MISMO paciente), sede y membresía, trigger de
// inmutabilidad (solo se enlaza el PDF y se anula una vez; no se borra),
// número correlativo por sede bajo candado (concurrencia real) y la hora de
// salida de la cita (appointments.completedAt) que pone el trigger.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPatientCertificateRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx306-int-a', 'dx306-int-b'];

interface Clinic {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
  userId: string;
  membershipId: string;
  patientId: string;
}

const snapshot: CertificateSnapshot = {
  version: 1,
  patient: { name: 'Mariela Rondón', document: 'Cédula V-12345678' },
  professional: {
    name: 'Dra. Ana Pérez',
    license: 'MPPS 45678',
    specialty: null,
  },
  location: {
    name: 'Sede Chacao',
    address: null,
    healthRegistrationNumber: null,
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: { name: 'Clínica', legalName: null, taxIdLabel: null, taxId: null },
};

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // El owner es superusuario: el trigger le deja borrar.
  await owner.patientCertificate.deleteMany({ where });
  await owner.$executeRaw`DELETE FROM "patient_documents" WHERE "tenantId" = ANY(${ids}::uuid[])`;
  await owner.appointment.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.clinicMembership.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const other = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Maracaibo',
    }),
  });
  const user = await owner.user.create({
    data: {
      email: `${subdomain}-${randomUUID()}@example.com`,
      fullName: 'Dra. Ana Pérez',
      passwordHash: 'x',
    },
  });
  const membership = await owner.clinicMembership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      role: ClinicRole.DENTIST,
      professionalLicense: 'MPPS 45678',
    },
  });
  const patient = await owner.patient.create({
    data: { tenantId: tenant.id, firstName: 'Mariela', lastName: 'Rondón' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    otherLocationId: other.id,
    userId: user.id,
    membershipId: membership.id,
    patientId: patient.id,
  };
}

let slot = 0;
/** Cita atendida (COMPLETED por UPDATE, como la app) en su propio hueco. */
async function completedAppointment(
  clinic: Clinic,
  opts: { locationId?: string; patientId?: string } = {},
): Promise<{ id: string; completedAt: Date | null }> {
  slot += 1;
  const start = new Date(Date.UTC(2026, 10, 2, 12, 0) + slot * 3_600_000);
  const created = await owner.appointment.create({
    data: {
      tenantId: clinic.tenantId,
      locationId: opts.locationId ?? clinic.locationId,
      patientId: opts.patientId ?? clinic.patientId,
      providerId: clinic.userId,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
  });
  return owner.appointment.update({
    where: { id: created.id },
    data: { status: 'COMPLETED' },
    select: { id: true, completedAt: true },
  });
}

const asClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

const input = (
  clinic: Clinic,
  appointmentId: string,
  over: Partial<NewCertificateInput> = {},
): NewCertificateInput => ({
  patientId: clinic.patientId,
  appointmentId,
  locationId: clinic.locationId,
  professionalMembershipId: clinic.membershipId,
  issuedById: clinic.userId,
  kind: 'ATTENDANCE',
  attendedFrom: new Date('2026-11-02T13:00:00Z'),
  attendedUntil: new Date('2026-11-02T13:30:00Z'),
  timesSource: 'SCHEDULED',
  rest: null,
  snapshot,
  ...over,
});

/** Un PDF falso con contenido único (el índice de sha256 vivo por paciente). */
const archive: ArchivePdf = (certificate) => {
  const documentId = randomUUID();
  return Promise.resolve({
    documentId,
    storageKey: `int/${documentId}.pdf`,
    sha256: createHash('sha256').update(documentId).digest('hex'),
    sizeBytes: 100,
    originalName: `justificante-${certificate.number}.pdf`,
  });
};

async function issue(clinic: Clinic, appointmentId: string, over = {}) {
  const result = await asClinic(clinic, () =>
    repo.issue(input(clinic, appointmentId, over), archive),
  );
  if (result.kind !== 'ISSUED') throw new Error(`no emitido: ${result.kind}`);
  return result.certificate;
}

describe('patient_certificates (int, DX-306)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  describe('appointments.completedAt (salida)', () => {
    it('la pone la BD al entrar en COMPLETED, la conserva y la borra al salir; la app no la fija', async () => {
      const appt = await completedAppointment(a);
      expect(appt.completedAt).toBeInstanceOf(Date);
      expect(Math.abs(appt.completedAt!.getTime() - Date.now())).toBeLessThan(
        60_000,
      );
      const forged = await owner.appointment.update({
        where: { id: appt.id },
        data: { completedAt: new Date('2020-01-01T00:00:00Z'), notes: 'x' },
        select: { completedAt: true },
      });
      expect(forged.completedAt).toEqual(appt.completedAt);
      const reopened = await owner.appointment.update({
        where: { id: appt.id },
        data: { status: 'SCHEDULED' },
        select: { completedAt: true },
      });
      expect(reopened.completedAt).toBeNull();
    });
  });

  it('emite con número 1 de la sede, archiva el PDF (REPORT) y lo enlaza; issuedAt la pone el servidor', async () => {
    const appt = await completedAppointment(a);
    const cert = await issue(a, appt.id);
    expect(cert.number).toBeGreaterThanOrEqual(1);
    expect(cert.documentId).not.toBeNull();
    const doc = await owner.patientDocument.findUniqueOrThrow({
      where: { id: cert.documentId! },
    });
    expect(doc).toMatchObject({
      category: 'REPORT',
      patientId: a.patientId,
      locationId: a.locationId,
    });
    expect(Math.abs(cert.issuedAt.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('numeración concurrente por sede: 8 emisiones a la vez dan números seguidos y sin repetir; otra sede tiene su serie', async () => {
    const before = await owner.patientCertificate.aggregate({
      where: { tenantId: a.tenantId, locationId: a.locationId },
      _max: { number: true },
    });
    const start = before._max.number ?? 0;
    const appts = await Promise.all(
      Array.from({ length: 8 }, () => completedAppointment(a)),
    );
    const certs = await Promise.all(appts.map((appt) => issue(a, appt.id)));
    const numbers = certs.map((c) => c.number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => start + i + 1));

    const otherAppt = await completedAppointment(a, {
      locationId: a.otherLocationId,
    });
    const other = await issue(a, otherAppt.id, {
      locationId: a.otherLocationId,
    });
    expect(other.number).toBe(1);
    // La otra clínica empieza su propia serie.
    const bAppt = await completedAppointment(b);
    expect((await issue(b, bAppt.id)).number).toBe(1);
  });

  it('un vivo por cita y tipo: el segundo es DUPLICATE con el número del vivo; tras anular, se emite otro', async () => {
    const appt = await completedAppointment(a);
    const first = await issue(a, appt.id);
    const again = await asClinic(a, () =>
      repo.issue(input(a, appt.id), archive),
    );
    expect(again).toEqual({ kind: 'DUPLICATE', number: first.number });
    const voided = await asClinic(a, () =>
      repo.voidCertificate(
        a.patientId,
        first.id,
        undefined,
        { userId: a.userId, reason: 'Fecha equivocada' },
        () => undefined,
        archive,
      ),
    );
    expect(voided.kind).toBe('VOIDED');
    if (voided.kind !== 'VOIDED') return;
    expect(voided.certificate.voidedDocumentId).not.toBeNull();
    // El PDF original queda anulado en la ficha con el motivo.
    const original = await owner.patientDocument.findUniqueOrThrow({
      where: { id: first.documentId! },
    });
    expect(original.voidReason).toBe('Certificado anulado: Fecha equivocada');
    const second = await issue(a, appt.id);
    expect(second.number).toBeGreaterThan(first.number);
    // Anular dos veces: la segunda ve la fila anulada.
    const twice = await asClinic(a, () =>
      repo.voidCertificate(
        a.patientId,
        first.id,
        undefined,
        { userId: a.userId, reason: 'Otra vez' },
        () => undefined,
        archive,
      ),
    );
    expect(twice).toEqual({ kind: 'ALREADY_VOIDED' });
  });

  it('RLS: otra clínica no ve, no lee ni anula; no puede insertar con el tenant de A', async () => {
    const appt = await completedAppointment(a);
    const cert = await issue(a, appt.id);
    await expect(asClinic(b, () => repo.list(a.patientId))).resolves.toBeNull();
    await expect(
      asClinic(b, () => repo.get(a.patientId, cert.id)),
    ).resolves.toBeNull();
    await expect(
      asClinic(b, () =>
        repo.voidCertificate(
          a.patientId,
          cert.id,
          undefined,
          { userId: b.userId, reason: 'Intrusa' },
          () => undefined,
          archive,
        ),
      ),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
    const visible = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.patientCertificate.count({ where: { tenantId: a.tenantId } }),
    );
    expect(visible).toBe(0);
    await expect(
      prisma.runWithTenant(
        b.tenantId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "patient_certificates"
          ("tenantId","patientId","appointmentId","locationId","professionalMembershipId",
           "issuedById","kind","number","attendedFrom","attendedUntil","timesSource","snapshot")
          VALUES (${a.tenantId}::uuid, ${a.patientId}::uuid, ${appt.id}::uuid, ${a.locationId}::uuid,
            ${a.membershipId}::uuid, ${a.userId}::uuid, 'ATTENDANCE', 0, now(), now(), 'SCHEDULED', '{}'::jsonb)`,
      ),
      // El trigger de inserción ya no ve la cita de A (RLS) y lo rechaza
      // antes que la política; cualquiera de los dos cierra la puerta.
    ).rejects.toThrow(/row-level security|la sede no es la de la cita/i);
  });

  describe('FK compuestas (owner, sin RLS)', () => {
    const insertRaw = (values: {
      tenantId: string;
      patientId: string;
      appointmentId: string;
      locationId: string;
      membershipId: string;
      userId: string;
    }) => owner.$executeRaw`INSERT INTO "patient_certificates"
        ("tenantId","patientId","appointmentId","locationId","professionalMembershipId",
         "issuedById","kind","number","attendedFrom","attendedUntil","timesSource","snapshot")
        VALUES (${values.tenantId}::uuid, ${values.patientId}::uuid, ${values.appointmentId}::uuid,
          ${values.locationId}::uuid, ${values.membershipId}::uuid, ${values.userId}::uuid,
          'ATTENDANCE', 0, now(), now(), 'SCHEDULED', '{}'::jsonb)`;

    it('la cita de otro paciente de la misma clínica: 23503', async () => {
      const otherPatient = await owner.patient.create({
        data: { tenantId: a.tenantId, firstName: 'Luis', lastName: 'Gómez' },
      });
      const appt = await completedAppointment(a, {
        patientId: otherPatient.id,
      });
      await expect(
        insertRaw({
          tenantId: a.tenantId,
          patientId: a.patientId,
          appointmentId: appt.id,
          locationId: a.locationId,
          membershipId: a.membershipId,
          userId: a.userId,
        }),
      ).rejects.toThrow(/patient_certificates_appointment_fkey/);
    });

    it('la cita, la sede o la membresía de otra clínica: 23503', async () => {
      const apptA = await completedAppointment(a);
      const apptB = await completedAppointment(b);
      // La cita de B no existe en A: el trigger lo para antes que la FK.
      await expect(
        insertRaw({
          tenantId: a.tenantId,
          patientId: a.patientId,
          appointmentId: apptB.id,
          locationId: a.locationId,
          membershipId: a.membershipId,
          userId: a.userId,
        }),
      ).rejects.toThrow(
        /patient_certificates_appointment_fkey|la sede no es la de la cita/,
      );
      const defs = await owner.$queryRaw<{ name: string; def: string }[]>`
        SELECT conname AS name, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
         WHERE conrelid = '"patient_certificates"'::regclass AND contype = 'f'
         ORDER BY conname`;
      const def = (name: string) => defs.find((d) => d.name === name)?.def;
      expect(def('patient_certificates_appointment_fkey')).toContain(
        'FOREIGN KEY ("tenantId", "patientId", "appointmentId") REFERENCES appointments("tenantId", "patientId", id)',
      );
      expect(def('patient_certificates_location_fkey')).toContain(
        'FOREIGN KEY ("tenantId", "locationId") REFERENCES locations("tenantId", id)',
      );
      expect(def('patient_certificates_membership_fkey')).toContain(
        'FOREIGN KEY ("tenantId", "professionalMembershipId") REFERENCES clinic_memberships("tenantId", id)',
      );
      expect(def('patient_certificates_patient_fkey')).toContain(
        'FOREIGN KEY ("tenantId", "patientId") REFERENCES patients("tenantId", id)',
      );
      await expect(
        insertRaw({
          tenantId: a.tenantId,
          patientId: a.patientId,
          appointmentId: apptA.id,
          locationId: a.locationId,
          membershipId: b.membershipId,
          userId: a.userId,
        }),
      ).rejects.toThrow(/patient_certificates_membership_fkey/);
      await expect(
        insertRaw({
          tenantId: a.tenantId,
          patientId: b.patientId,
          appointmentId: apptA.id,
          locationId: a.locationId,
          membershipId: a.membershipId,
          userId: a.userId,
        }),
      ).rejects.toThrow(/patient_certificates_(patient|appointment)_fkey/);
    });

    it('la sede del certificado tiene que ser la de la cita (trigger)', async () => {
      const appt = await completedAppointment(a);
      await expect(
        insertRaw({
          tenantId: a.tenantId,
          patientId: a.patientId,
          appointmentId: appt.id,
          locationId: a.otherLocationId,
          membershipId: a.membershipId,
          userId: a.userId,
        }),
      ).rejects.toThrow(/la sede no es la de la cita/);
    });
  });

  describe('inmutabilidad (como la app, con RLS)', () => {
    it('la foto no cambia aunque cambien el paciente o el profesional, y el contenido no se edita', async () => {
      const appt = await completedAppointment(a);
      const cert = await issue(a, appt.id);
      await owner.patient.update({
        where: { id: a.patientId },
        data: { firstName: 'Marielena' },
      });
      await owner.clinicMembership.update({
        where: { id: a.membershipId },
        data: { professionalLicense: 'MPPS 99999' },
      });
      const reread = await asClinic(a, () => repo.get(a.patientId, cert.id));
      expect(reread?.snapshot.patient.name).toBe('Mariela Rondón');
      expect(reread?.snapshot.professional.license).toBe('MPPS 45678');

      for (const data of [
        { snapshot: { tampered: true } },
        { kind: 'REST' as const },
        { number: 999 },
        { attendedFrom: new Date('2020-01-01T00:00:00Z') },
        { documentId: null },
      ]) {
        await expect(
          prisma.runWithTenant(a.tenantId, (tx) =>
            tx.patientCertificate.update({ where: { id: cert.id }, data }),
          ),
        ).rejects.toThrow(/no cambia/);
      }
    });

    it('no se borra (la app no tiene DELETE; y el trigger lo niega a quien no es superusuario)', async () => {
      const appt = await completedAppointment(a);
      const cert = await issue(a, appt.id);
      await expect(
        prisma.runWithTenant(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "patient_certificates" WHERE "id" = ${cert.id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|no se borra/);
      expect(
        await owner.patientCertificate.count({ where: { id: cert.id } }),
      ).toBe(1);
    });

    it('anulado no cambia; nace sin anular ni PDF', async () => {
      const appt = await completedAppointment(a);
      const cert = await issue(a, appt.id);
      await prisma.runWithTenant(a.tenantId, (tx) =>
        tx.patientCertificate.update({
          where: { id: cert.id },
          data: {
            voidedAt: new Date(),
            voidedById: a.userId,
            voidReason: 'Duplicado',
          },
        }),
      );
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.patientCertificate.update({
            where: { id: cert.id },
            data: { voidReason: 'Otro motivo' },
          }),
        ),
      ).rejects.toThrow(/anulado no cambia/);
      const appt2 = await completedAppointment(a);
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.patientCertificate.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              appointmentId: appt2.id,
              locationId: a.locationId,
              professionalMembershipId: a.membershipId,
              issuedById: a.userId,
              kind: 'ATTENDANCE',
              number: 0,
              attendedFrom: new Date(),
              attendedUntil: new Date(),
              timesSource: 'SCHEDULED',
              snapshot: {},
              voidedAt: new Date(),
              voidedById: a.userId,
              voidReason: 'Ya anulado',
            },
          }),
        ),
      ).rejects.toThrow(/nace sin anular/);
    });

    it('CHECK: el justificante no lleva diagnóstico; el reposo cuadra días y fechas', async () => {
      const appt = await completedAppointment(a);
      await expect(
        asClinic(a, () =>
          repo.issue(
            input(a, appt.id, {
              rest: {
                restDays: 2,
                restStartDate: '2026-11-02',
                restEndDate: '2026-11-03',
                diagnosis: 'Exodoncia',
              },
            }),
            archive,
          ),
        ),
      ).rejects.toThrow(/patient_certificates_kind_check/);
      const rest = await issue(a, appt.id, {
        kind: 'REST',
        rest: {
          restDays: 3,
          restStartDate: '2026-11-02',
          restEndDate: '2026-11-04',
          diagnosis: 'Exodoncia del 38',
        },
      });
      expect(rest).toMatchObject({
        restDays: 3,
        restStartDate: '2026-11-02',
        restEndDate: '2026-11-04',
      });
      const appt2 = await completedAppointment(a);
      await expect(
        issue(a, appt2.id, {
          kind: 'REST',
          rest: {
            restDays: 3,
            restStartDate: '2026-11-02',
            restEndDate: '2026-11-05',
            diagnosis: null,
          },
        }),
      ).rejects.toThrow(/patient_certificates_kind_check/);
    });
  });
});
