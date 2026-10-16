import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  SEEDED_PASSWORD,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { AUDIT_EVENT_REPOSITORY } from '../src/modules/audit/domain/ports/audit-event-repository.port';

// DX-009 · registro de auditoría de punta a punta: qué deja cada acceso, qué
// NO guarda nunca, quién puede leerlo y que una clínica no ve lo de otra.
// DIRECT_URL (superusuario, sin RLS) solo para leer la tabla tal cual quedó.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// Contenido clínico y financiero con marcas únicas: ninguna puede aparecer en
// la tabla de auditoría.
const ALLERGY = 'Penicilina-DX009';
const HISTORY_NOTE = 'Antecedente-secreto-DX009';
const ENTRY_REASON = 'Motivo-clinico-DX009';
const ENTRY_NOTES = 'Evolucion-secreta-DX009';
const PAYMENT_NOTE = 'Nota-de-abono-DX009';
const VOID_REASON = 'Anulado-por-duplicado-DX009';
const PNG_A =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_B =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const CLINICAL_MARKS = [
  ALLERGY,
  HISTORY_NOTE,
  ENTRY_REASON,
  ENTRY_NOTES,
  PAYMENT_NOTE,
  VOID_REASON,
  PNG_A.slice(0, 40),
  PNG_B.slice(0, 40),
  'data:image',
  SEEDED_PASSWORD,
];

type Verb = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface AuditRow {
  tenantId: string;
  actorUserId: string | null;
  actorRole: ClinicRole | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  patientId: string | null;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

interface AuditPage {
  items: {
    id: string;
    occurredAt: string;
    action: string;
    resourceType: string;
    actor: { id: string; fullName: string | null; role: string | null } | null;
    patient: { id: string; fullName: string } | null;
    ip: string | null;
    userAgent: string | null;
    requestId: string | null;
    timeZone: string;
    metadata: Record<string, unknown>;
  }[];
  nextCursor: string | null;
  timeZone: string;
}

let counter = 0;
/** Un X-Request-Id válido y único (DX-023) para enlazar petición y evento. */
const nextRequestId = (): string =>
  `dx009-e2e-${String(++counter).padStart(4, '0')}`;

describe('Registro de auditoría (e2e, DX-009)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let dentist: { userId: string; token: string };
  let reception: { userId: string; token: string };
  let assistantToken: string;
  let patientId: string;

  function api(
    clinic: Clinic,
    verb: Verb,
    path: string,
    token: string,
    requestId: string = nextRequestId(),
  ): request.Test {
    return request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', requestId)
      .set('User-Agent', 'dx009-e2e-agent');
  }

  async function eventsOf(requestId: string): Promise<AuditRow[]> {
    return raw.auditEvent.findMany({ where: { requestId } }) as Promise<
      AuditRow[]
    >;
  }

  /** Hace la petición y devuelve el único evento que dejó. */
  async function onlyEvent(
    clinic: Clinic,
    verb: Verb,
    path: string,
    token: string,
    body: object | undefined,
    status: number,
  ): Promise<{ event: AuditRow; body: unknown }> {
    const requestId = nextRequestId();
    const req = api(clinic, verb, path, token, requestId);
    const res = await (body === undefined ? req : req.send(body)).expect(
      status,
    );
    const events = await eventsOf(requestId);
    // Una sola escritura por petición: ni cero ni varias (sin N+1).
    expect(events).toHaveLength(1);
    return { event: events[0], body: res.body as unknown };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'auditoria-a');
    clinicB = await registerClinic(app, 'auditoria-b');
    const d = await seedMember(raw, clinicA, ClinicRole.DENTIST);
    dentist = {
      userId: d.userId,
      token: await loginAs(app, clinicA.host, d.email),
    };
    const r = await seedMember(raw, clinicA, ClinicRole.RECEPTION);
    reception = {
      userId: r.userId,
      token: await loginAs(app, clinicA.host, r.email),
    };
    const a = await seedMember(raw, clinicA, ClinicRole.ASSISTANT);
    assistantToken = await loginAs(app, clinicA.host, a.email);
    const patient = await api(clinicA, 'post', '/patients', clinicA.adminToken)
      .send({
        firstName: 'Paula',
        lastName: 'Auditada',
        docType: 'CC',
        docNumber: 'AUD-0001',
        sex: 'F',
      })
      .expect(201);
    patientId = (patient.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('qué deja cada acceso', () => {
    it('ver la ficha: VIEW PATIENT con actor, rol, paciente, IP, user agent y request id', async () => {
      const requestId = nextRequestId();
      await api(
        clinicA,
        'get',
        `/patients/${patientId}`,
        dentist.token,
        requestId,
      ).expect(200);
      const [event] = await eventsOf(requestId);
      expect(event).toMatchObject({
        tenantId: clinicA.tenantId,
        actorUserId: dentist.userId,
        actorRole: 'DENTIST',
        action: 'VIEW',
        resourceType: 'PATIENT',
        resourceId: patientId,
        patientId,
        requestId,
        userAgent: 'dx009-e2e-agent',
      });
      expect(event.ip).toBeTruthy();
    });

    it('ver y guardar la HC: VIEW y UPDATE (con los nombres de los campos, no su contenido)', async () => {
      await api(
        clinicA,
        'put',
        `/patients/${patientId}/medical-history`,
        dentist.token,
      )
        .send({
          allergies: [
            {
              alergeno: ALLERGY,
              tipo: 'MEDICAMENTO',
              severidad: 'MODERADA',
              esAlerta: true,
            },
          ],
          notes: HISTORY_NOTE,
        })
        .expect(200);
      const { event: view } = await onlyEvent(
        clinicA,
        'get',
        `/patients/${patientId}/medical-history`,
        dentist.token,
        undefined,
        200,
      );
      expect(view).toMatchObject({
        action: 'VIEW',
        resourceType: 'MEDICAL_HISTORY',
        patientId,
      });
      const { event: update } = await onlyEvent(
        clinicA,
        'put',
        `/patients/${patientId}/medical-history`,
        dentist.token,
        { allergies: [], notes: HISTORY_NOTE },
        200,
      );
      expect(update).toMatchObject({
        action: 'UPDATE',
        resourceType: 'MEDICAL_HISTORY',
        patientId,
      });
      expect(update.metadata).toEqual({
        changedFields: ['allergies', 'notes'],
        params: { patientId },
      });
    });

    it('crear una entrada clínica: CREATE CLINICAL_ENTRY con el id de la entrada', async () => {
      const { event, body } = await onlyEvent(
        clinicA,
        'post',
        `/patients/${patientId}/clinical-entries`,
        dentist.token,
        { reason: ENTRY_REASON, notes: ENTRY_NOTES },
        201,
      );
      expect(event).toMatchObject({
        action: 'CREATE',
        resourceType: 'CLINICAL_ENTRY',
        resourceId: (body as { id: string }).id,
        patientId,
        actorUserId: dentist.userId,
        actorRole: 'DENTIST',
      });
    });

    it('firmar un consentimiento: SIGN CONSENT', async () => {
      const template = await api(
        clinicA,
        'post',
        '/consent-templates',
        clinicA.adminToken,
      )
        .send({
          title: 'Consentimiento DX-009',
          body: 'Yo, {{paciente}}, autorizo {{tratamiento}}.',
        })
        .expect(201);
      const { id: templateId, version } = template.body as {
        id: string;
        version: number;
      };
      const { event, body } = await onlyEvent(
        clinicA,
        'post',
        `/patients/${patientId}/consents`,
        dentist.token,
        {
          templateId,
          templateVersion: version,
          signerType: 'PATIENT',
          patientSignature: `data:image/png;base64,${PNG_A}`,
          professionalSignature: `data:image/png;base64,${PNG_B}`,
        },
        201,
      );
      expect(event).toMatchObject({
        action: 'SIGN',
        resourceType: 'CONSENT',
        resourceId: (body as { id: string }).id,
        patientId,
        actorRole: 'DENTIST',
      });
    });

    it('registrar y anular un abono: CREATE y VOID PAYMENT, con el paciente resuelto del plan', async () => {
      const plan = await api(
        clinicA,
        'post',
        `/patients/${patientId}/treatment-plans`,
        clinicA.adminToken,
      )
        .send({ currency: 'USD' })
        .expect(201);
      const planId = (plan.body as { id: string }).id;
      const { event: created, body } = await onlyEvent(
        clinicA,
        'post',
        `/treatment-plans/${planId}/payments`,
        reception.token,
        {
          amount: 100,
          currency: 'USD',
          paidAt: new Date().toISOString(),
          method: 'CASH',
          notes: PAYMENT_NOTE,
        },
        201,
      );
      const paymentId = (body as { id: string }).id;
      expect(created).toMatchObject({
        action: 'CREATE',
        resourceType: 'PAYMENT',
        resourceId: paymentId,
        patientId,
        actorUserId: reception.userId,
        actorRole: 'RECEPTION',
      });
      const { event: voided } = await onlyEvent(
        clinicA,
        'delete',
        `/payments/${paymentId}`,
        reception.token,
        { reason: VOID_REASON },
        200,
      );
      expect(voided).toMatchObject({
        action: 'VOID',
        resourceType: 'PAYMENT',
        resourceId: paymentId,
        patientId,
        actorRole: 'RECEPTION',
      });
    });

    it('login correcto y fallido: LOGIN con el usuario; LOGIN_FAILED con el miembro o sin actor', async () => {
      const login = (email: string, password: string, requestId: string) =>
        request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .set('X-Tenant-Host', clinicA.host)
          .set('X-Request-Id', requestId)
          .send({ email, password });
      const ok = nextRequestId();
      await login('dentist@auditoria-a.test', SEEDED_PASSWORD, ok).expect(201);
      expect(await eventsOf(ok)).toEqual([
        expect.objectContaining({
          tenantId: clinicA.tenantId,
          action: 'LOGIN',
          resourceType: 'SESSION',
          actorUserId: dentist.userId,
          actorRole: 'DENTIST',
        }),
      ]);
      const wrongPassword = nextRequestId();
      await login(
        'dentist@auditoria-a.test',
        'otra-clave',
        wrongPassword,
      ).expect(401);
      expect(await eventsOf(wrongPassword)).toEqual([
        expect.objectContaining({
          action: 'LOGIN_FAILED',
          actorUserId: dentist.userId,
          actorRole: null,
          metadata: { reason: 'INVALID_CREDENTIALS' },
        }),
      ]);
      // Un usuario que existe pero es de OTRA clínica: sin actor (no se filtra).
      const stranger = nextRequestId();
      await login('owner@auditoria-b.test', SEEDED_PASSWORD, stranger).expect(
        401,
      );
      expect(await eventsOf(stranger)).toEqual([
        expect.objectContaining({
          tenantId: clinicA.tenantId,
          action: 'LOGIN_FAILED',
          actorUserId: null,
        }),
      ]);
    });

    it('una petición que falla (404, 403) no deja evento', async () => {
      const notFound = nextRequestId();
      await api(
        clinicA,
        'get',
        `/patients/${clinicA.tenantId}`,
        dentist.token,
        notFound,
      ).expect(404);
      const forbidden = nextRequestId();
      await api(
        clinicA,
        'get',
        `/patients/${patientId}/medical-history`,
        reception.token,
        forbidden,
      ).expect(403);
      expect(await eventsOf(notFound)).toEqual([]);
      expect(await eventsOf(forbidden)).toEqual([]);
    });

    it('la lectura de B sobre un paciente de A (200 vacío por RLS) queda en B y sin paciente', async () => {
      const { event } = await onlyEvent(
        clinicB,
        'get',
        `/patients/${patientId}/medical-history`,
        clinicB.adminToken,
        undefined,
        200,
      );
      expect(event).toMatchObject({
        tenantId: clinicB.tenantId,
        patientId: null,
      });
    });
  });

  it('ningún evento guarda contenido clínico, firmas, importes ni contraseñas', async () => {
    const rows = await raw.auditEvent.findMany();
    expect(rows.length).toBeGreaterThan(5);
    const dump = JSON.stringify(rows);
    for (const mark of CLINICAL_MARKS) {
      expect({ mark, found: dump.includes(mark) }).toEqual({
        mark,
        found: false,
      });
    }
    expect(dump).not.toMatch(/"amount"|"100(\.00)?"/);
  });

  describe('GET /audit-events', () => {
    it('solo ADMIN: los demás roles reciben 403', async () => {
      await api(clinicA, 'get', '/audit-events', clinicA.adminToken).expect(
        200,
      );
      for (const token of [dentist.token, assistantToken, reception.token]) {
        await api(clinicA, 'get', '/audit-events', token).expect(403);
      }
    });

    it('devuelve los eventos con nombres, IP, user agent y zona de la sede', async () => {
      const res = await api(
        clinicA,
        'get',
        `/audit-events?patientId=${patientId}&action=SIGN`,
        clinicA.adminToken,
      ).expect(200);
      const page = res.body as AuditPage;
      expect(page.timeZone).toBe('America/Bogota');
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        action: 'SIGN',
        resourceType: 'CONSENT',
        actor: {
          id: dentist.userId,
          fullName: 'Miembro DENTIST',
          role: 'DENTIST',
        },
        patient: { id: patientId, fullName: 'Paula Auditada' },
        userAgent: 'dx009-e2e-agent',
        timeZone: 'America/Bogota',
      });
      expect(page.items[0].ip).toBeTruthy();
      expect(page.items[0].requestId).toMatch(/^dx009-e2e-/);
    });

    it('filtra por usuario y por recurso', async () => {
      const byActor = (
        await api(
          clinicA,
          'get',
          `/audit-events?actorUserId=${reception.userId}`,
          clinicA.adminToken,
        ).expect(200)
      ).body as AuditPage;
      expect(byActor.items.length).toBeGreaterThan(0);
      expect(byActor.items.every((e) => e.actor?.id === reception.userId)).toBe(
        true,
      );
      const payments = (
        await api(
          clinicA,
          'get',
          '/audit-events?resourceType=PAYMENT',
          clinicA.adminToken,
        ).expect(200)
      ).body as AuditPage;
      expect(payments.items.map((e) => e.action).sort()).toEqual([
        'CREATE',
        'VOID',
      ]);
    });

    it('pagina por cursor sin repetir ni saltarse eventos', async () => {
      const all = (
        await api(
          clinicA,
          'get',
          '/audit-events?limit=100',
          clinicA.adminToken,
        ).expect(200)
      ).body as AuditPage;
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : '';
        const page = (
          await api(
            clinicA,
            'get',
            `/audit-events?limit=3${query}`,
            clinicA.adminToken,
          ).expect(200)
        ).body as AuditPage;
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(all.items.map((e) => e.id));
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('DX-102: pagina hondo por cursor a través de particiones (cambio de mes) con filtros de acción y recurso, sin duplicados', async () => {
      // 120 anulaciones de abono en grupos de 4 en el MISMO milisegundo, a
      // ambos lados del inicio de un mes de hace dos meses (dos particiones).
      const now = new Date();
      const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1);
      const rows = Array.from({ length: 120 }, (_, i) => ({
        id: randomUUID(),
        tenantId: clinicA.tenantId,
        actorUserId: clinicA.adminUserId,
        actorRole: 'ADMIN' as const,
        action: 'VOID' as const,
        resourceType: 'PAYMENT' as const,
        occurredAt: new Date(boundary + (Math.floor(i / 4) - 15) * 60_000),
      }));
      await raw.auditEvent.createMany({ data: rows });
      const from = new Date(boundary - 86_400_000).toISOString();
      const to = new Date(boundary + 86_400_000).toISOString();
      const seen: AuditPage['items'] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : '';
        const page = (
          await api(
            clinicA,
            'get',
            `/audit-events?limit=25&action=VOID&resourceType=PAYMENT&from=${from}&to=${to}${query}`,
            clinicA.adminToken,
          ).expect(200)
        ).body as AuditPage;
        seen.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(120);
      expect(new Set(seen.map((e) => e.id)).size).toBe(120);
      expect(seen.map((e) => e.id).sort()).toEqual(
        rows.map((r) => r.id).sort(),
      );
      const keys = seen.map((e) => `${e.occurredAt}|${e.id}`);
      expect(keys).toEqual([...keys].sort().reverse());
      // B no ve ninguno, ni con los mismos filtros.
      const b = (
        await api(
          clinicB,
          'get',
          `/audit-events?action=VOID&resourceType=PAYMENT&from=${from}&to=${to}`,
          clinicB.adminToken,
        ).expect(200)
      ).body as AuditPage;
      expect(b.items).toEqual([]);
    });

    it('topes: limit > 100, rango de más de 366 días o cursor manipulado dan 400', async () => {
      await api(
        clinicA,
        'get',
        '/audit-events?limit=101',
        clinicA.adminToken,
      ).expect(400);
      await api(
        clinicA,
        'get',
        '/audit-events?from=2024-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
        clinicA.adminToken,
      ).expect(400);
      await api(
        clinicA,
        'get',
        `/audit-events?cursor=${Buffer.from('x|y').toString('base64url')}`,
        clinicA.adminToken,
      ).expect(400);
      await api(
        clinicA,
        'get',
        '/audit-events?action=ROOT',
        clinicA.adminToken,
      ).expect(400);
    });

    it('aislado por clínica: B nunca ve los eventos de A, ni filtrando por ids de A', async () => {
      const own = (
        await api(
          clinicB,
          'get',
          '/audit-events?limit=100',
          clinicB.adminToken,
        ).expect(200)
      ).body as AuditPage;
      expect(own.items.length).toBeGreaterThan(0);
      const aEvents = await raw.auditEvent.findMany({
        where: { tenantId: clinicA.tenantId },
        select: { id: true },
      });
      const aIds = new Set(aEvents.map((e) => e.id));
      expect(own.items.filter((e) => aIds.has(e.id))).toEqual([]);
      for (const filter of [
        `patientId=${patientId}`,
        `actorUserId=${dentist.userId}`,
        `actorUserId=${clinicA.adminUserId}`,
      ]) {
        const res = (
          await api(
            clinicB,
            'get',
            `/audit-events?${filter}`,
            clinicB.adminToken,
          ).expect(200)
        ).body as AuditPage;
        expect({ filter, items: res.items }).toEqual({ filter, items: [] });
      }
    });

    it('leer el registro no deja evento', async () => {
      const requestId = nextRequestId();
      await api(
        clinicA,
        'get',
        '/audit-events',
        clinicA.adminToken,
        requestId,
      ).expect(200);
      expect(await eventsOf(requestId)).toEqual([]);
    });
  });

  describe('si la escritura del evento falla', () => {
    let broken: INestApplication<App>;

    beforeAll(async () => {
      broken = await createE2eApp({
        override: (builder) =>
          builder.overrideProvider(AUDIT_EVENT_REPOSITORY).useValue({
            insert: () =>
              Promise.reject(new Error('audit_events no disponible')),
            list: () => Promise.resolve([]),
            clinicTimeZone: () => Promise.resolve('America/Bogota'),
          }),
      });
    });

    afterAll(async () => {
      await broken.close();
    });

    it('ni la lectura ni la escritura se rompen (el fallo va al log)', async () => {
      const call = (verb: Verb, path: string) =>
        request(broken.getHttpServer())
          [verb](`/api/v1${path}`)
          .set('X-Tenant-Host', clinicA.host)
          .set('Authorization', `Bearer ${dentist.token}`);
      await call('get', `/patients/${patientId}`).expect(200);
      await call('post', `/patients/${patientId}/clinical-entries`)
        .send({ reason: 'Control', notes: 'Sin auditoría disponible' })
        .expect(201);
    });
  });
});
