import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  type Clinic,
} from './support/e2e-fixtures';
import { REGIONAL_MADRID_FIXTURE } from './support/location-fixtures';
import { PROFESSIONAL_LICENSE_MISSING_MESSAGE } from '../src/modules/clinical-entries/domain/author-license';
import { CLINICAL_ENTRY_SETTINGS_FORBIDDEN_MESSAGE } from '../src/modules/clinical-entries/presentation/clinical-entry-settings.controller';

/**
 * DX-540: registro profesional del autor al firmar una evolución.
 *
 * - El registro se congela en la evolución y se devuelve al leerla; cambiarlo
 *   después no la toca (la BD además rechaza el UPDATE, DX-038).
 * - El aviso es un ajuste de la clínica (desactivado de fábrica): con él, firmar
 *   sin registro responde `warnings: [PROFESSIONAL_LICENSE_MISSING]` y la
 *   evolución se guarda igual. El país de la sede no decide nada.
 * - Otra clínica no ve ni las evoluciones ni el ajuste.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface EntryBody {
  id: string;
  performedById: string;
  authorProfessionalLicense: string | null;
  warnings?: { code: string; message: string }[];
}

interface SigningBody {
  professionalLicense: string | null;
  warnMissingProfessionalLicense: boolean;
  warnings: { code: string; message: string }[];
}

const MISSING = {
  code: 'PROFESSIONAL_LICENSE_MISSING',
  message: PROFESSIONAL_LICENSE_MISSING_MESSAGE,
};

describe('Registro profesional en la evolución (DX-540, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let patientId: string;
  const http = () => request(app.getHttpServer());

  async function createPatient(c: Clinic, docNumber: string): Promise<string> {
    const res = await http()
      .post('/api/v1/patients')
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${c.adminToken}`)
      .send({
        firstName: 'Registro',
        lastName: 'Profesional',
        docType: 'NATIONAL_ID',
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function sign(c: Clinic, token: string, notes: string, patient = patientId) {
    return http()
      .post(`/api/v1/patients/${patient}/clinical-entries`)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes });
  }

  function setWarning(c: Clinic, token: string, on: unknown) {
    return http()
      .put('/api/v1/clinical-entries/settings')
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${token}`)
      .send({ warnMissingProfessionalLicense: on });
  }

  function setLicense(c: Clinic, userId: string, license: string) {
    return http()
      .patch(`/api/v1/staff/${userId}`)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${c.adminToken}`)
      .send({ professionalLicense: license })
      .expect(200);
  }

  async function listed(c: Clinic, patient = patientId): Promise<EntryBody[]> {
    const res = await http()
      .get(`/api/v1/patients/${patient}/clinical-entries`)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', `Bearer ${c.adminToken}`)
      .expect(200);
    return res.body as EntryBody[];
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    // Sede principal de Caracas (VE) y la otra de Madrid (ES): el aviso
    // sigue al ajuste de cada clínica, nunca al país de su sede.
    clinic = await registerClinic(app, 'dx540-reg');
    other = await registerClinic(app, 'dx540-otra', REGIONAL_MADRID_FIXTURE);
    patientId = await createPatient(clinic, 'DX540-1');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('de fábrica el aviso está desactivado: firma sin registro y sin aviso', async () => {
    const settings = await http()
      .get('/api/v1/clinical-entries/settings')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(200);
    expect(settings.body).toEqual({ warnMissingProfessionalLicense: false });

    const res = await sign(clinic, clinic.adminToken, 'Sin aviso').expect(201);
    expect(res.body).toMatchObject({
      authorProfessionalLicense: null,
      warnings: [],
    });
  });

  it('solo ADMIN cambia el ajuste; el valor tiene que ser sí o no', async () => {
    const dentist = await seedMember(raw, clinic, ClinicRole.DENTIST);
    const dentistToken = await loginAs(app, clinic.host, dentist.email);
    const denied = await setWarning(clinic, dentistToken, true).expect(403);
    expect((denied.body as { message: string }).message).toBe(
      CLINICAL_ENTRY_SETTINGS_FORBIDDEN_MESSAGE,
    );
    await setWarning(clinic, clinic.adminToken, 'sí').expect(400);
    await setWarning(clinic, clinic.adminToken, undefined).expect(400);
  });

  it('activarlo queda auditado y repetirlo no duplica el evento', async () => {
    await setWarning(clinic, clinic.adminToken, true)
      .expect(200)
      .expect({ warnMissingProfessionalLicense: true });
    await setWarning(clinic, clinic.adminToken, true).expect(200);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'CLINIC_SETTINGS',
        metadata: {
          path: ['reason'],
          equals: 'CLINICAL_ENTRY_LICENSE_WARNING',
        },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      statusChange: { from: 'OFF', to: 'ON' },
    });
    expect(events[0].actorUserId).toBe(clinic.adminUserId);
  });

  it('aviso activo y autor sin registro: se guarda y responde el aviso tipado', async () => {
    const signing = await http()
      .get('/api/v1/clinical-entries/signing')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(200);
    expect(signing.body as SigningBody).toEqual({
      professionalLicense: null,
      warnMissingProfessionalLicense: true,
      warnings: [MISSING],
    });

    const res = await sign(clinic, clinic.adminToken, 'Sin registro').expect(
      201,
    );
    const body = res.body as EntryBody;
    expect(body.warnings).toEqual([MISSING]);
    expect(body.authorProfessionalLicense).toBeNull();
    const row = await raw.clinicalEntry.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(row.notes).toBe('Sin registro');
    expect(row.authorProfessionalLicense).toBeNull();
  });

  it('con registro: sin aviso, el número queda en la evolución y se lee en la ficha', async () => {
    await setLicense(clinic, clinic.adminUserId, '  RP-540-A ');
    const signing = await http()
      .get('/api/v1/clinical-entries/signing')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .expect(200);
    expect(signing.body as SigningBody).toMatchObject({
      professionalLicense: 'RP-540-A',
      warnings: [],
    });

    const res = await sign(clinic, clinic.adminToken, 'Con registro').expect(
      201,
    );
    const body = res.body as EntryBody;
    expect(body).toMatchObject({
      authorProfessionalLicense: 'RP-540-A',
      warnings: [],
    });
    const read = (await listed(clinic)).find((e) => e.id === body.id);
    expect(read?.authorProfessionalLicense).toBe('RP-540-A');
    // La lectura no trae avisos: solo viajan en la respuesta del alta.
    expect(read).not.toHaveProperty('warnings');
  });

  it('cambiar el registro después no altera las evoluciones ya firmadas', async () => {
    const before = await listed(clinic);
    await setLicense(clinic, clinic.adminUserId, 'RP-540-B');
    const res = await sign(clinic, clinic.adminToken, 'Registro nuevo').expect(
      201,
    );
    expect((res.body as EntryBody).authorProfessionalLicense).toBe('RP-540-B');

    const after = await listed(clinic);
    for (const entry of before) {
      expect(
        after.find((e) => e.id === entry.id)?.authorProfessionalLicense,
      ).toBe(entry.authorProfessionalLicense);
    }
    expect(after.map((e) => e.authorProfessionalLicense).sort()).toEqual(
      [null, null, 'RP-540-A', 'RP-540-B'].sort(),
    );
  });

  it('la BD rechaza reescribir el registro de una evolución (DX-038), también al dueño', async () => {
    const [entry] = await listed(clinic);
    await expect(
      raw.$executeRaw`UPDATE "clinical_entries" SET "authorProfessionalLicense" = 'FALSO' WHERE "id" = ${entry.id}::uuid`,
    ).rejects.toThrow(/inalterable/);
  });

  it('la BD rechaza un registro en blanco o con espacios en los extremos', async () => {
    const tenantId = clinic.tenantId;
    for (const bad of ['', ' RP-1', 'RP-1 ', 'x'.repeat(61)]) {
      await expect(
        raw.$executeRaw`INSERT INTO "clinical_entries" ("id", "tenantId", "patientId", "entryDate", "notes", "performedById", "authorProfessionalLicense")
          VALUES (gen_random_uuid(), ${tenantId}::uuid, ${patientId}::uuid, now(), 'x', ${clinic.adminUserId}::uuid, ${bad})`,
      ).rejects.toThrow(/clinical_entries_author_professional_license_check/);
    }
  });

  it('otra clínica (sede de otro país) no ve las evoluciones y su ajuste sigue desactivado', async () => {
    // La lista no comprueba el paciente: bajo RLS sale vacía.
    const foreign = await http()
      .get(`/api/v1/patients/${patientId}/clinical-entries`)
      .set('X-Tenant-Host', other.host)
      .set('Authorization', `Bearer ${other.adminToken}`)
      .expect(200);
    expect(foreign.body).toEqual([]);
    await sign(other, other.adminToken, 'Intruso').expect(404);

    const settings = await http()
      .get('/api/v1/clinical-entries/settings')
      .set('X-Tenant-Host', other.host)
      .set('Authorization', `Bearer ${other.adminToken}`)
      .expect(200);
    expect(settings.body).toEqual({ warnMissingProfessionalLicense: false });

    // El registro de la otra clínica no se filtra: su ADMIN no lo tiene.
    const signing = await http()
      .get('/api/v1/clinical-entries/signing')
      .set('X-Tenant-Host', other.host)
      .set('Authorization', `Bearer ${other.adminToken}`)
      .expect(200);
    expect(signing.body).toEqual({
      professionalLicense: null,
      warnMissingProfessionalLicense: false,
      warnings: [],
    });

    const ownPatient = await createPatient(other, 'DX540-2');
    const res = await sign(
      other,
      other.adminToken,
      'Sin aviso',
      ownPatient,
    ).expect(201);
    expect((res.body as EntryBody).warnings).toEqual([]);
    expect(
      await raw.clinicalEntry.count({ where: { tenantId: other.tenantId } }),
    ).toBe(1);
  });

  it('el mismo usuario en dos clínicas: cada evolución lleva el registro de SU clínica', async () => {
    // Miembro de `other` con el registro de esa clínica; en `clinic` no es miembro.
    const dentist = await seedMember(raw, other, ClinicRole.DENTIST);
    await raw.clinicMembership.updateMany({
      where: { tenantId: other.tenantId, userId: dentist.userId },
      data: { professionalLicense: 'RP-OTRA' },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: dentist.userId,
        role: ClinicRole.DENTIST,
      },
    });
    const token = await loginAs(app, clinic.host, dentist.email);
    const res = await sign(clinic, token, 'Registro por clínica').expect(201);
    expect(res.body as EntryBody).toMatchObject({
      authorProfessionalLicense: null,
      warnings: [MISSING],
    });
  });

  it('recepción no lee la firma ni los ajustes (sin acceso clínico)', async () => {
    const reception = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    const token = await loginAs(app, clinic.host, reception.email);
    for (const path of ['signing', 'settings']) {
      await http()
        .get(`/api/v1/clinical-entries/${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    }
  });
});
