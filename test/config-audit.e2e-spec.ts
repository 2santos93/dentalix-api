import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';

/**
 * DX-360: las rutas que cambian la configuración de la clínica (sedes,
 * horario, recordatorios, dominios, política de datos, tipos de cita,
 * pagadores, plantillas e inventario) dejan su evento en la misma transacción
 * que el cambio: quién, la sede si aplica y el antes/después de los campos
 * cambiados, sin texto libre ni secretos. Guardar sin cambiar nada no deja
 * evento, y el evento es solo de su clínica.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const UA = 'dx360-e2e-agent';

const POLICY = {
  policyText:
    'Política de tratamiento de datos de la clínica (versión de prueba).',
  generalText: 'Autorizo el tratamiento de mis datos personales.',
  sensitiveHealthText:
    'Autorizo el tratamiento de mis datos sensibles de salud (historia clínica). No está obligado a autorizarlo. Finalidad: la atención odontológica.',
  marketingText: 'Autorizo recibir comunicaciones comerciales.',
};

interface AuditPage {
  items: {
    action: string;
    resourceType: string;
    resourceId: string | null;
    actor: { id: string } | null;
    metadata: Record<string, unknown>;
  }[];
}

describe('Auditoría de la configuración de la clínica (e2e, DX-360)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let locationA: string;

  const http = () => request(app.getHttpServer());
  const as = (clinic: Clinic) => ({
    get: (path: string) =>
      http()
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${clinic.adminToken}`),
    send: (method: 'post' | 'patch' | 'delete' | 'put', path: string) =>
      http()
        [method](`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('User-Agent', UA)
        .set('Authorization', `Bearer ${clinic.adminToken}`),
  });

  /** Eventos de una clínica de un tipo de recurso, en orden (owner, sin RLS). */
  function eventsOf(
    clinic: Clinic,
    resourceType: Prisma.AuditEventWhereInput['resourceType'],
    where: Prisma.AuditEventWhereInput = {},
  ) {
    return raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, resourceType, ...where },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        action: true,
        resourceType: true,
        resourceId: true,
        actorUserId: true,
        actorRole: true,
        locationId: true,
        userAgent: true,
        metadata: true,
      },
    });
  }

  const byAdmin = (clinic: Clinic) => ({
    actorUserId: clinic.adminUserId,
    actorRole: ClinicRole.ADMIN,
    userAgent: UA,
  });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'clinica-dx360-a');
    clinicB = await registerClinic(app, 'clinica-dx360-b');
    locationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('sedes y recordatorios', () => {
    it('POST /locations: CREATE LOCATION con sus valores, sin la dirección', async () => {
      const res = await as(clinicA)
        .send('post', '/locations')
        .send({
          name: 'Sede Norte',
          address: 'Calle 100 # 15-20',
          country: 'CO',
          currency: 'COP',
          timeZone: 'America/Bogota',
          locale: 'es-CO',
          hourCycle: 'h23',
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      const [event, ...rest] = await eventsOf(clinicA, 'LOCATION', {
        resourceId: id,
      });
      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        action: 'CREATE',
        ...byAdmin(clinicA),
        metadata: {
          reason: 'LOCATION_CREATED',
          configChange: {
            after: {
              name: 'Sede Norte',
              country: 'CO',
              currency: 'COP',
              timeZone: 'America/Bogota',
              locale: 'es-CO',
              hourCycle: 'h23',
            },
          },
        },
      });
      expect(JSON.stringify(event)).not.toContain('Calle 100');
    });

    it('PUT /locations/schedule: UPDATE LOCATION_SCHEDULE con los tramos antes y después; el mismo horario otra vez no deja evento', async () => {
      const ranges = [{ weekday: 1, startMinute: 480, endMinute: 720 }];
      const before = await eventsOf(clinicA, 'LOCATION_SCHEDULE');
      await as(clinicA)
        .send('put', '/locations/schedule')
        .set('X-Location-Id', locationA)
        .send({ ranges })
        .expect(200);
      const events = await eventsOf(clinicA, 'LOCATION_SCHEDULE');
      expect(events).toHaveLength(before.length + 1);
      const event = events.at(-1)!;
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceId: locationA,
        locationId: locationA,
        ...byAdmin(clinicA),
        metadata: {
          reason: 'LOCATION_SCHEDULE_REPLACED',
          scheduleChange: {
            after: [
              {
                locationId: locationA,
                weekday: 1,
                startMinute: 480,
                endMinute: 720,
              },
            ],
          },
        },
      });
      expect(
        (event.metadata as { scheduleChange: { before: unknown[] } })
          .scheduleChange.before.length,
      ).toBeGreaterThan(0);

      await as(clinicA)
        .send('put', '/locations/schedule')
        .set('X-Location-Id', locationA)
        .send({ ranges })
        .expect(200);
      expect(await eventsOf(clinicA, 'LOCATION_SCHEDULE')).toHaveLength(
        events.length,
      );
    });

    it('PUT /reminder-settings/:locationId: UPDATE REMINDER_SETTINGS con el antes y el después; sin cambios no deja evento', async () => {
      await as(clinicA)
        .send('put', `/reminder-settings/${locationA}`)
        .send({ enabled: true, leadHours: [24] })
        .expect(200);
      const [event] = await eventsOf(clinicA, 'REMINDER_SETTINGS');
      expect(event).toMatchObject({
        action: 'UPDATE',
        resourceId: locationA,
        locationId: locationA,
        ...byAdmin(clinicA),
        metadata: {
          reason: 'REMINDER_SETTINGS_UPDATED',
          changedFields: ['enabled', 'leadHours'],
          configChange: {
            before: { enabled: false, leadHours: [] },
            after: { enabled: true, leadHours: [24] },
          },
        },
      });

      await as(clinicA)
        .send('put', `/reminder-settings/${locationA}`)
        .send({ enabled: true, leadHours: [24] })
        .expect(200);
      expect(await eventsOf(clinicA, 'REMINDER_SETTINGS')).toHaveLength(1);
    });
  });

  describe('dominios y política de datos', () => {
    it('POST /domains: CREATE TENANT_DOMAIN con el host y el estado, nunca el token de verificación', async () => {
      const res = await as(clinicA)
        .send('post', '/domains')
        .send({ host: 'citas.clinica-dx360.co' })
        .expect(201);
      const body = res.body as {
        domain: { id: string };
        dns: { value: string };
      };
      const [event] = await eventsOf(clinicA, 'TENANT_DOMAIN', {
        action: 'CREATE',
      });
      expect(event).toMatchObject({
        resourceId: body.domain.id,
        ...byAdmin(clinicA),
        metadata: {
          reason: 'DOMAIN_REGISTERED',
          configChange: {
            after: { host: 'citas.clinica-dx360.co', status: 'PENDING' },
          },
        },
      });
      expect(JSON.stringify(event)).not.toContain(body.dns.value);
      expect(JSON.stringify(event)).not.toContain('dentalix-verify');
    });

    it('POST /privacy-policies: CREATE PRIVACY_POLICY con versión y hash, sin los textos', async () => {
      const first = await as(clinicA)
        .send('post', '/privacy-policies')
        .send(POLICY)
        .expect(201);
      const second = await as(clinicA)
        .send('post', '/privacy-policies')
        .send({ ...POLICY, policyText: 'Versión 2 de la política.' })
        .expect(201);
      const v1 = first.body as { id: string; contentHash: string };
      const v2 = second.body as { id: string; contentHash: string };
      const events = await eventsOf(clinicA, 'PRIVACY_POLICY');
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        action: 'CREATE',
        resourceId: v1.id,
        ...byAdmin(clinicA),
        metadata: {
          reason: 'PRIVACY_POLICY_PUBLISHED',
          configChange: { after: { version: 1, contentHash: v1.contentHash } },
        },
      });
      expect(events[1].metadata).toEqual({
        reason: 'PRIVACY_POLICY_PUBLISHED',
        changedFields: ['policyText'],
        configChange: {
          before: { version: 1, contentHash: v1.contentHash },
          after: { version: 2, contentHash: v2.contentHash },
        },
      });
      const dump = JSON.stringify(events);
      expect(dump).not.toContain('versión de prueba');
      expect(dump).not.toContain('Versión 2 de la política');
    });
  });

  describe('tipos de cita y pagadores', () => {
    it('POST/PATCH/DELETE /appointment-types: alta, cambio (solo lo cambiado) y retiro; PATCH sin cambios no deja evento', async () => {
      const created = await as(clinicA)
        .send('post', '/appointment-types')
        .send({ name: 'Control', durationMinutes: 30, color: '#3366ff' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as(clinicA)
        .send('patch', `/appointment-types/${id}`)
        .send({ name: 'Control', durationMinutes: 45 })
        .expect(200);
      await as(clinicA)
        .send('patch', `/appointment-types/${id}`)
        .send({ name: 'Control', durationMinutes: 45, color: '#3366FF' })
        .expect(200);
      await as(clinicA).send('delete', `/appointment-types/${id}`).expect(204);

      const events = await eventsOf(clinicA, 'APPOINTMENT_TYPE', {
        resourceId: id,
      });
      expect(events.map((e) => [e.action, e.metadata])).toEqual([
        [
          'CREATE',
          {
            reason: 'APPOINTMENT_TYPE_CREATED',
            configChange: {
              after: {
                name: 'Control',
                durationMinutes: 30,
                color: '#3366FF',
                active: true,
                isUrgent: false,
              },
            },
          },
        ],
        [
          'UPDATE',
          {
            reason: 'APPOINTMENT_TYPE_UPDATED',
            changedFields: ['durationMinutes'],
            configChange: {
              before: { durationMinutes: 30 },
              after: { durationMinutes: 45 },
            },
          },
        ],
        [
          'DELETE',
          {
            reason: 'APPOINTMENT_TYPE_DELETED',
            configChange: {
              before: {
                name: 'Control',
                durationMinutes: 45,
                color: '#3366FF',
                active: true,
                isUrgent: false,
              },
            },
          },
        ],
      ]);
      for (const e of events) expect(e).toMatchObject(byAdmin(clinicA));
    });

    it('POST/PATCH/DELETE /payers: alta, cambio y retiro; PATCH sin cambios no deja evento', async () => {
      const created = await as(clinicA)
        .send('post', '/payers')
        .send({ name: 'Seguros Andes', type: 'INSURER' })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as(clinicA)
        .send('patch', `/payers/${id}`)
        .send({ active: false })
        .expect(200);
      await as(clinicA)
        .send('patch', `/payers/${id}`)
        .send({ name: 'Seguros Andes', active: false })
        .expect(200);
      await as(clinicA).send('delete', `/payers/${id}`).expect(204);

      const events = await eventsOf(clinicA, 'PAYER', { resourceId: id });
      expect(events.map((e) => [e.action, e.metadata])).toEqual([
        [
          'CREATE',
          {
            reason: 'PAYER_CREATED',
            configChange: {
              after: { name: 'Seguros Andes', type: 'INSURER', active: true },
            },
          },
        ],
        [
          'UPDATE',
          {
            reason: 'PAYER_UPDATED',
            changedFields: ['active'],
            configChange: {
              before: { active: true },
              after: { active: false },
            },
          },
        ],
        [
          'DELETE',
          {
            reason: 'PAYER_DELETED',
            configChange: {
              before: { name: 'Seguros Andes', type: 'INSURER', active: false },
            },
          },
        ],
      ]);
      for (const e of events) expect(e).toMatchObject(byAdmin(clinicA));
    });
  });

  describe('plantillas', () => {
    it('POST/PATCH /consent-templates: el texto solo por su nombre y la versión; PATCH sin cambios no deja evento', async () => {
      const created = await as(clinicA)
        .send('post', '/consent-templates')
        .send({
          title: 'Exodoncia simple',
          body: 'Autorizo la extracción del diente indicado.',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as(clinicA)
        .send('patch', `/consent-templates/${id}`)
        .send({ body: 'Autorizo la extracción y conozco sus riesgos.' })
        .expect(200);
      await as(clinicA)
        .send('patch', `/consent-templates/${id}`)
        .send({ title: 'Exodoncia simple' })
        .expect(200);

      const events = await eventsOf(clinicA, 'CONSENT_TEMPLATE', {
        resourceId: id,
      });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        action: 'CREATE',
        ...byAdmin(clinicA),
        metadata: {
          reason: 'CONSENT_TEMPLATE_CREATED',
          configChange: {
            after: { title: 'Exodoncia simple', active: true, version: 1 },
          },
        },
      });
      expect(events[1]).toMatchObject({
        action: 'UPDATE',
        metadata: {
          reason: 'CONSENT_TEMPLATE_UPDATED',
          changedFields: ['body', 'version'],
          configChange: { before: { version: 1 }, after: { version: 2 } },
        },
      });
      const dump = JSON.stringify(events);
      expect(dump).not.toContain('Autorizo');
    });

    it('un título de 200 caracteres y un nombre con emoji (ZWJ) quedan en el evento, sin descartarse', async () => {
      const title = `Consentimiento ${'x'.repeat(185)}`;
      const created = await as(clinicA)
        .send('post', '/consent-templates')
        .send({ title, body: 'Texto de la plantilla larga.' })
        .expect(201);
      const [event] = await eventsOf(clinicA, 'CONSENT_TEMPLATE', {
        resourceId: (created.body as { id: string }).id,
      });
      expect(
        (event.metadata as { configChange: { after: { title: string } } })
          .configChange.after.title,
      ).toBe(title);

      const item = await as(clinicA)
        .send('post', '/inventory/items')
        .send({ name: 'Kit familia 👨\u200D👩\u200D👧', unit: 'caja' })
        .expect(201);
      const [itemEvent] = await eventsOf(clinicA, 'INVENTORY_ITEM', {
        resourceId: (item.body as { id: string }).id,
      });
      expect(
        (itemEvent.metadata as { configChange: { after: { name: string } } })
          .configChange.after.name,
      ).toBe('Kit familia 👨👩👧');
    });

    it('POST/PATCH/DELETE /prescription-templates: nombre y nº de medicamentos, nunca los medicamentos ni las notas', async () => {
      const created = await as(clinicA)
        .send('post', '/prescription-templates')
        .send({
          name: 'Post exodoncia',
          notes: 'Indicaciones privadas',
          items: [{ activeIngredient: 'Ibuprofeno' }],
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as(clinicA)
        .send('patch', `/prescription-templates/${id}`)
        .send({
          items: [
            { activeIngredient: 'Ibuprofeno' },
            { activeIngredient: 'Amoxicilina' },
          ],
        })
        .expect(200);
      await as(clinicA)
        .send('patch', `/prescription-templates/${id}`)
        .send({ name: 'Post exodoncia' })
        .expect(200);
      await as(clinicA)
        .send('delete', `/prescription-templates/${id}`)
        .expect(204);

      const events = await eventsOf(clinicA, 'PRESCRIPTION_TEMPLATE', {
        resourceId: id,
      });
      expect(events.map((e) => [e.action, e.metadata])).toEqual([
        [
          'CREATE',
          {
            reason: 'PRESCRIPTION_TEMPLATE_CREATED',
            configChange: { after: { name: 'Post exodoncia', itemCount: 1 } },
          },
        ],
        [
          'UPDATE',
          {
            reason: 'PRESCRIPTION_TEMPLATE_UPDATED',
            changedFields: ['itemCount', 'items'],
            configChange: { before: { itemCount: 1 }, after: { itemCount: 2 } },
          },
        ],
        [
          'DELETE',
          {
            reason: 'PRESCRIPTION_TEMPLATE_DELETED',
            configChange: { before: { name: 'Post exodoncia', itemCount: 2 } },
          },
        ],
      ]);
      const dump = JSON.stringify(events);
      expect(dump).not.toContain('Ibuprofeno');
      expect(dump).not.toContain('Indicaciones privadas');
    });
  });

  describe('inventario', () => {
    it('POST/PATCH/DELETE /inventory/items y POST movements: el artículo en su sede y el movimiento en la sede del movimiento, sin notas ni motivo', async () => {
      const created = await as(clinicA)
        .send('post', '/inventory/items')
        .set('X-Location-Id', locationA)
        .send({
          name: 'Guantes M',
          unit: 'caja',
          minStock: 2,
          notes: 'proveedor X',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await as(clinicA)
        .send('patch', `/inventory/items/${id}`)
        .send({ minStock: 5 })
        .expect(200);
      await as(clinicA)
        .send('patch', `/inventory/items/${id}`)
        .send({ name: 'Guantes M', minStock: 5 })
        .expect(200);
      const movement = await as(clinicA)
        .send('post', `/inventory/items/${id}/movements`)
        .send({ type: 'IN', quantity: 10, reason: 'compra al proveedor X' })
        .expect(201);
      await as(clinicA).send('delete', `/inventory/items/${id}`).expect(200);

      const items = await eventsOf(clinicA, 'INVENTORY_ITEM', {
        resourceId: id,
      });
      expect(items.map((e) => [e.action, e.locationId, e.metadata])).toEqual([
        [
          'CREATE',
          locationA,
          {
            reason: 'INVENTORY_ITEM_CREATED',
            configChange: {
              after: {
                name: 'Guantes M',
                sku: null,
                unit: 'caja',
                minStock: 2,
              },
            },
          },
        ],
        [
          'UPDATE',
          locationA,
          {
            reason: 'INVENTORY_ITEM_UPDATED',
            changedFields: ['minStock'],
            configChange: { before: { minStock: 2 }, after: { minStock: 5 } },
          },
        ],
        [
          'DELETE',
          locationA,
          {
            reason: 'INVENTORY_ITEM_DELETED',
            configChange: {
              before: {
                name: 'Guantes M',
                sku: null,
                unit: 'caja',
                minStock: 5,
              },
            },
          },
        ],
      ]);
      const [moved] = await eventsOf(clinicA, 'INVENTORY_MOVEMENT');
      expect(moved).toMatchObject({
        action: 'CREATE',
        resourceId: (movement.body as { id: string }).id,
        locationId: locationA,
        ...byAdmin(clinicA),
        metadata: {
          reason: 'INVENTORY_MOVEMENT_RECORDED',
          params: { itemId: id },
          configChange: { after: { type: 'IN', quantity: 10 } },
        },
      });
      const dump = JSON.stringify([...items, moved]);
      expect(dump).not.toContain('proveedor X');
    });
  });

  describe('rollback: sin cambio no hay evento', () => {
    const count = () =>
      raw.auditEvent.count({ where: { tenantId: clinicA.tenantId } });

    it('POST y PATCH /appointment-types con un nombre repetido: 409 y ningún evento nuevo', async () => {
      await as(clinicA)
        .send('post', '/appointment-types')
        .send({ name: 'Ortodoncia', durationMinutes: 30, color: '#112233' })
        .expect(201);
      const other = await as(clinicA)
        .send('post', '/appointment-types')
        .send({ name: 'Periodoncia', durationMinutes: 30, color: '#112233' })
        .expect(201);
      const before = await count();
      await as(clinicA)
        .send('post', '/appointment-types')
        .send({ name: 'Ortodoncia', durationMinutes: 45, color: '#445566' })
        .expect(409);
      await as(clinicA)
        .send(
          'patch',
          `/appointment-types/${(other.body as { id: string }).id}`,
        )
        .send({ name: 'Ortodoncia' })
        .expect(409);
      expect(await count()).toBe(before);
    });

    it('POST y PATCH /payers con un nombre repetido: 409 y ningún evento nuevo', async () => {
      await as(clinicA)
        .send('post', '/payers')
        .send({ name: 'Aseguradora Uno', type: 'INSURER' })
        .expect(201);
      const other = await as(clinicA)
        .send('post', '/payers')
        .send({ name: 'Aseguradora Dos', type: 'INSURER' })
        .expect(201);
      const before = await count();
      await as(clinicA)
        .send('post', '/payers')
        .send({ name: 'Aseguradora Uno', type: 'OTHER' })
        .expect(409);
      await as(clinicA)
        .send('patch', `/payers/${(other.body as { id: string }).id}`)
        .send({ name: 'Aseguradora Uno' })
        .expect(409);
      expect(await count()).toBe(before);
    });
  });

  describe('aislamiento por clínica', () => {
    it('los eventos de A no se ven desde B, ni en la tabla ni en el registro filtrado por los tipos nuevos', async () => {
      const types = [
        'LOCATION_SCHEDULE',
        'REMINDER_SETTINGS',
        'PRIVACY_POLICY',
        'APPOINTMENT_TYPE',
        'PAYER',
        'CONSENT_TEMPLATE',
        'PRESCRIPTION_TEMPLATE',
        'INVENTORY_ITEM',
        'INVENTORY_MOVEMENT',
      ] as const;
      for (const resourceType of types) {
        const mine = await as(clinicA)
          .get(`/audit-events?resourceType=${resourceType}`)
          .expect(200);
        const items = (mine.body as AuditPage).items;
        expect({ resourceType, seen: items.length > 0 }).toEqual({
          resourceType,
          seen: true,
        });
        for (const item of items) {
          expect(item.resourceType).toBe(resourceType);
          expect(item.actor?.id).toBe(clinicA.adminUserId);
        }
        const theirs = await as(clinicB)
          .get(`/audit-events?resourceType=${resourceType}`)
          .expect(200);
        expect({
          resourceType,
          items: (theirs.body as AuditPage).items,
        }).toEqual({ resourceType, items: [] });
        expect(await eventsOf(clinicB, resourceType)).toEqual([]);
      }
    });
  });
});
