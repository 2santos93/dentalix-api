import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-120 · odontograma fase 2 de punta a punta: dentición por edad,
// exfoliar 55 → erupcionar 15 → registrar → anular → carta a una fecha
// (asOf), con permisos (autor o ADMIN), IDOR entre clínicas y rastro de
// auditoría. DIRECT_URL (superusuario) solo para sembrar, leer y limpiar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REASON = 'Registrado en el diente equivocado';
const DAY_MS = 24 * 60 * 60 * 1000;

interface PositionBody {
  position: string;
  dentition: string;
  source: string;
}
interface DentitionBody {
  basis: string;
  ageYears: number | null;
  overall: string;
  asOf: string | null;
  positions: PositionBody[];
}
interface RecordBody {
  id: string;
  toothNumber: string;
  origin: string;
  voidsRecordId: string | null;
  voidReason: string | null;
  performedById: string | null;
}
interface TimelineBody extends RecordBody {
  performedByName: string | null;
  void: {
    id: string;
    reason: string;
    performedById: string | null;
    performedByName: string | null;
  } | null;
}
interface GroupBody {
  toothNumber: string;
  records: RecordBody[];
}

/** Día civil en Bogotá (zona por defecto de la clínica) `daysAgo` días atrás. */
function bogotaDay(daysAgo = 0): string {
  return new Date(Date.now() - 5 * 60 * 60 * 1000 - daysAgo * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Fecha de nacimiento de alguien que tiene `years` años (y un mes) hoy. */
function birthDateFor(years: number): string {
  const [y, m, d] = bogotaDay(31).split('-').map(Number);
  return `${y - years}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

describe('Odontograma fase 2: dentición, anulación y asOf (DX-120, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentistA: { token: string; userId: string };
  let child: string;
  let toddler: string;
  let adult: string;

  const http = () => request(app.getHttpServer());

  function call(
    clinic: Clinic,
    verb: 'get' | 'post',
    path: string,
    token = clinic.adminToken,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }

  async function createPatient(
    clinic: Clinic,
    name: string,
    birthDate: string | null,
  ): Promise<string> {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: name,
        lastName: 'Prueba',
        birthDate: birthDate ? new Date(`${birthDate}T00:00:00.000Z`) : null,
      },
    });
    return patient.id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx120-a');
    b = await registerClinic(app, 'dx120-b');
    const dentist = await seedMember(raw, a, ClinicRole.DENTIST);
    dentistA = {
      userId: dentist.userId,
      token: await loginAs(app, a.host, dentist.email),
    };
    child = await createPatient(a, 'Sofía', birthDateFor(7));
    toddler = await createPatient(a, 'Tomás', birthDateFor(4));
    adult = await createPatient(a, 'Laura', birthDateFor(34));
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  describe('dentición por edad (sin eventos, sin escribir nada)', () => {
    it.each([
      ['7 años: mixta', () => child, 'MIXED'],
      ['4 años: temporal', () => toddler, 'PRIMARY'],
      ['adulto: permanente', () => adult, 'PERMANENT'],
    ])('%s', async (_label, patient, overall) => {
      const res = await call(
        a,
        'get',
        `/patients/${patient()}/dentition`,
      ).expect(200);
      const body = res.body as DentitionBody;
      expect(body.overall).toBe(overall);
      expect(body.basis).toBe('AGE');
      expect(body.positions).toHaveLength(32);
      expect(body.asOf).toBeNull();
    });

    it('no escribe eventos al consultar', async () => {
      expect(await raw.patientDentitionEvent.count()).toBe(0);
    });
  });

  describe('flujo: exfoliar 55 → erupcionar 15 → registrar → anular → asOf', () => {
    let record55: RecordBody;
    let record64: RecordBody;

    it('registra en el 55 mientras la posición 15 es temporal', async () => {
      const res = await call(
        a,
        'post',
        `/patients/${child}/tooth-records`,
        dentistA.token,
      )
        .send({ toothNumber: '55', kind: 'DIAGNOSIS', notes: 'Caries' })
        .expect(201);
      record55 = res.body as RecordBody;
      expect(record55.origin).toBe('THIS_CLINIC');
    });

    it('exfolia el 55 y erupciona el 15: la posición pasa a permanente', async () => {
      await call(
        a,
        'post',
        `/patients/${child}/dentition-events`,
        dentistA.token,
      )
        .send({
          positions: ['15'],
          dentition: 'PERMANENT',
          reason: 'EXFOLIATION',
        })
        .expect(201);
      const erupted = await call(
        a,
        'post',
        `/patients/${child}/dentition-events`,
        dentistA.token,
      )
        .send({ positions: ['15'], dentition: 'PERMANENT', reason: 'ERUPTION' })
        .expect(201);
      expect(erupted.body).toEqual([
        expect.objectContaining({
          position: '15',
          reason: 'ERUPTION',
          performedById: dentistA.userId,
        }),
      ]);

      const res = await call(a, 'get', `/patients/${child}/dentition`).expect(
        200,
      );
      const p15 = (res.body as DentitionBody).positions.find(
        (p) => p.position === '15',
      );
      expect(p15).toMatchObject({ dentition: 'PERMANENT', source: 'EVENT' });
    });

    it('el 55 ya no admite registros (422 en español) y su historial sigue visible', async () => {
      const res = await call(a, 'post', `/patients/${child}/tooth-records`)
        .send({ toothNumber: '55', kind: 'DIAGNOSIS' })
        .expect(422);
      expect((res.body as { message: string }).message).toMatch(
        /temporal.*permanente/,
      );
      const history = await call(
        a,
        'get',
        `/patients/${child}/teeth/55/history`,
      ).expect(200);
      expect((history.body as TimelineBody[]).map((r) => r.id)).toEqual([
        record55.id,
      ]);
    });

    it('valida los cambios de dentición: 400 y 422', async () => {
      await call(a, 'post', `/patients/${child}/dentition-events`)
        .send({ positions: ['55'], dentition: 'PERMANENT', reason: 'MANUAL' })
        .expect(400);
      await call(a, 'post', `/patients/${child}/dentition-events`)
        .send({ positions: ['16'], dentition: 'MIXED', reason: 'MANUAL' })
        .expect(422);
    });

    it('registra en el 64 con origen «otro profesional» y la carta lo pinta', async () => {
      const res = await call(
        a,
        'post',
        `/patients/${child}/tooth-records`,
        dentistA.token,
      )
        .send({
          toothNumber: '64',
          kind: 'PROCEDURE',
          origin: 'OTHER_PROVIDER',
        })
        .expect(201);
      record64 = res.body as RecordBody;
      expect(record64.origin).toBe('OTHER_PROVIDER');

      const chart = await call(
        a,
        'get',
        `/patients/${child}/odontogram`,
      ).expect(200);
      expect((chart.body as GroupBody[]).map((g) => g.toothNumber)).toEqual([
        '55',
        '64',
      ]);
    });

    it('anular sin motivo: 400', async () => {
      await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${record64.id}/void`,
        dentistA.token,
      )
        .send({ reason: '   ' })
        .expect(400);
      await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${record64.id}/void`,
        dentistA.token,
      )
        .send({})
        .expect(400);
    });

    it('anular el registro de otro siendo DENTIST: 403', async () => {
      const other = await raw.toothRecord.create({
        data: {
          tenantId: a.tenantId,
          patientId: child,
          toothNumber: '65',
          kind: 'DIAGNOSIS',
          performedById: a.adminUserId,
        },
      });
      await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${other.id}/void`,
        dentistA.token,
      )
        .send({ reason: REASON })
        .expect(403);
    });

    it('el autor anula con motivo: deja de pintarse, queda tachado y no se toca ninguna fila', async () => {
      const before = await raw.toothRecord.findMany({
        where: { tenantId: a.tenantId },
        orderBy: { id: 'asc' },
      });

      const res = await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${record64.id}/void`,
        dentistA.token,
      )
        .send({ reason: REASON })
        .expect(200);
      const voidRow = res.body as RecordBody;
      expect(voidRow).toMatchObject({
        voidsRecordId: record64.id,
        voidReason: REASON,
        performedById: dentistA.userId,
      });

      const after = await raw.toothRecord.findMany({
        where: { tenantId: a.tenantId, id: { in: before.map((r) => r.id) } },
        orderBy: { id: 'asc' },
      });
      expect(after).toEqual(before);

      const chart = await call(
        a,
        'get',
        `/patients/${child}/odontogram`,
      ).expect(200);
      expect(
        (chart.body as GroupBody[]).some((g) => g.toothNumber === '64'),
      ).toBe(false);

      const history = await call(
        a,
        'get',
        `/patients/${child}/teeth/64/history`,
      ).expect(200);
      const entries = history.body as TimelineBody[];
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(record64.id);
      expect(entries[0].void).toMatchObject({
        reason: REASON,
        performedById: dentistA.userId,
        performedByName: 'Miembro DENTIST',
      });
    });

    it('una segunda anulación del mismo registro: 409, aunque la intente un ADMIN', async () => {
      const res = await call(
        a,
        'post',
        `/patients/${child}/tooth-records/${record64.id}/void`,
      )
        .send({ reason: 'Otra vez' })
        .expect(409);
      expect((res.body as { message: string }).message).toBe(
        'Este registro ya está anulado',
      );
    });

    it('cada cambio de dentición y cada anulación dejan su audit_event', async () => {
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          patientId: child,
          resourceType: 'ODONTOGRAM',
        },
      });
      const voids = events.filter((e) => e.action === 'VOID');
      const changes = events.filter(
        (e) =>
          e.action === 'UPDATE' &&
          (e.metadata as { reason?: string } | null)?.reason ===
            'DENTITION_CHANGED',
      );
      expect(voids.map((e) => e.resourceId)).toEqual([record64.id]);
      expect(changes).toHaveLength(2);
    });
  });

  describe('carta a una fecha (asOf)', () => {
    let older: string;

    beforeAll(async () => {
      // Un registro de hace 10 días (por SQL: la API no antedata) que se anula
      // hoy por la API.
      const row = await raw.toothRecord.create({
        data: {
          tenantId: a.tenantId,
          patientId: adult,
          toothNumber: '36',
          kind: 'DIAGNOSIS',
          performedById: a.adminUserId,
          recordedAt: new Date(Date.now() - 10 * DAY_MS),
        },
      });
      older = row.id;
      await call(a, 'post', `/patients/${adult}/tooth-records/${older}/void`)
        .send({ reason: REASON })
        .expect(200);
      await call(a, 'post', `/patients/${adult}/tooth-records`)
        .send({ toothNumber: '46', kind: 'DIAGNOSIS' })
        .expect(201);
    });

    it('hace 5 días: incluye lo anulado después y excluye lo posterior', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${adult}/odontogram?asOf=${bogotaDay(5)}`,
      ).expect(200);
      const groups = res.body as GroupBody[];
      expect(groups.map((g) => g.toothNumber)).toEqual(['36']);
      expect(groups[0].records[0].id).toBe(older);
    });

    it('hoy: la carta actual', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${adult}/odontogram?asOf=${bogotaDay()}`,
      ).expect(200);
      expect((res.body as GroupBody[]).map((g) => g.toothNumber)).toEqual([
        '46',
      ]);
    });

    it('la dentición a una fecha: la edad y los eventos de entonces', async () => {
      const res = await call(
        a,
        'get',
        `/patients/${child}/dentition?asOf=${bogotaDay(1)}`,
      ).expect(200);
      const body = res.body as DentitionBody;
      expect(body.asOf).toBe(bogotaDay(1));
      expect(body.positions.find((p) => p.position === '15')?.source).toBe(
        'AGE',
      );
    });

    it.each(['2026-02-30', 'ayer'])('asOf inválido (%s): 400', async (asOf) => {
      await call(a, 'get', `/patients/${adult}/odontogram?asOf=${asOf}`).expect(
        400,
      );
    });

    it('asOf futuro: 400', async () => {
      await call(
        a,
        'get',
        `/patients/${adult}/dentition?asOf=${bogotaDay(-3)}`,
      ).expect(400);
    });
  });

  describe('aislamiento entre clínicas (B sobre el paciente y el registro de A)', () => {
    // ISOLATION_COVERS: GET /patients/:patientId/dentition
    it('B no ve la dentición de A: 404', async () => {
      await call(b, 'get', `/patients/${child}/dentition`).expect(404);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/dentition-events
    it('B no cambia la dentición de A: 404, sin escribir', async () => {
      const before = await raw.patientDentitionEvent.count();
      await call(b, 'post', `/patients/${child}/dentition-events`)
        .send({ positions: ['11'], dentition: 'MIXED', reason: 'MANUAL' })
        .expect(404);
      expect(await raw.patientDentitionEvent.count()).toBe(before);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/tooth-records/:recordId/void
    it('B no anula un registro de A: 404', async () => {
      const target = await raw.toothRecord.findFirstOrThrow({
        where: { tenantId: a.tenantId, toothNumber: '55' },
      });
      await call(
        b,
        'post',
        `/patients/${child}/tooth-records/${target.id}/void`,
      )
        .send({ reason: REASON })
        .expect(404);
    });

    it('A no anula con la ruta de otro paciente: 404', async () => {
      const target = await raw.toothRecord.findFirstOrThrow({
        where: { tenantId: a.tenantId, toothNumber: '55' },
      });
      await call(
        a,
        'post',
        `/patients/${adult}/tooth-records/${target.id}/void`,
      )
        .send({ reason: REASON })
        .expect(404);
    });
  });
});
