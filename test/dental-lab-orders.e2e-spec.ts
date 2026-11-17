import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { LOCATION_NOT_ALLOWED_CODE } from '../src/shared/tenancy/location-access';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { LAB_CLOCK } from '../src/modules/lab-orders/domain/ports/lab-repository.port';
import { LAB_MESSAGES } from '../src/modules/lab-orders/domain/lab-order-rules';
import {
  LAB_ORDER_CHECK_FORBIDDEN_MESSAGE,
  LAB_ORDER_PRINT_FORBIDDEN_MESSAGE,
  LAB_ORDER_WRITE_FORBIDDEN_MESSAGE,
} from '../src/modules/lab-orders/presentation/lab-orders.controller';
import { LAB_CATALOG_FORBIDDEN_MESSAGE } from '../src/modules/lab-orders/presentation/dental-labs.controller';

// DX-017 · Laboratorio dental: catálogo de laboratorios y servicios, órdenes
// de laboratorio (crear → enviar → recibir → revisar, anular con motivo),
// validaciones cruzadas, roles, redacción para recepción, fecha prometida en
// días hábiles de la sede, lista de la sede con atrasadas, impresión y
// aislamiento entre clínicas. Todo por la API salvo el ítem del plan y las
// citas (no es lo que se prueba) y la lectura de la auditoría, por `raw`.
//
// Reloj FIJO del laboratorio (LAB_CLOCK): el viernes 20-11-2026 a mediodía en
// Caracas. Las fechas del spec son literales: no dependen del reloj real.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const FRIDAY = '2026-11-20';
const NOW = new Date(`${FRIDAY}T12:00:00-04:00`);

interface ErrorBody {
  message: string;
  code?: string;
}

interface LabBody {
  id: string;
  name: string;
  active: boolean;
  services: ServiceBody[];
}

interface ServiceBody {
  id: string;
  labId: string;
  name: string;
  leadTimeBusinessDays: number;
  referencePrice: string | null;
  referenceCurrency: string | null;
  active: boolean;
}

interface OrderBody {
  id: string;
  number: number;
  status: string;
  overdue: boolean;
  daysOverdue: number | null;
  patientId: string;
  locationId: string;
  description: string;
  toothNumbers: string[];
  shade: string | null;
  material: string | null;
  instructions: string | null;
  clinicalRedacted: boolean;
  dueOn: string | null;
  sentAt: string | null;
  sentBy: { id: string; fullName: string } | null;
  receivedAt: string | null;
  receivedBy: { id: string; fullName: string } | null;
  checkedAt: string | null;
  checkedBy: { id: string; fullName: string } | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  professional: { membershipId: string; userId: string; fullName: string };
  treatmentPlanItem: {
    id: string;
    toothNumber: string;
    procedureName: string;
  } | null;
  appointment: { id: string; start: string } | null;
  replacesOrder: { id: string; number: number } | null;
  replacedBy: { id: string; number: number }[];
}

interface PageBody {
  items: OrderBody[];
  total: number;
  page: number;
  pageSize: number;
}

const idOf = (res: request.Response): string => (res.body as { id: string }).id;

const CROWN = {
  description: 'Corona de zirconio',
  toothNumbers: ['16'],
  shade: 'A2',
  material: 'Zirconio monolítico',
  instructions: 'Margen en chamfer; contacto proximal firme',
};

describe('Laboratorio dental — /dental-labs, /patients/:id/lab-orders, /lab-orders (DX-017, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let reception: { token: string; userId: string };
  let assistant: string;
  let patient1: string;
  let patient2: string;
  let patientB: string;
  let locationA: string;
  let locationB: string;
  let labA: string;
  let zirconiaA: string;
  let splintA: string;
  let labB: string;
  let serviceB: string;
  let itemA: string;
  let itemOfPatient2: string;
  let itemB: string;
  let appointmentA: string;
  let appointmentOfPatient2: string;
  let appointmentB: string;
  let orderA: string;

  const call = (
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post' | 'put' | 'patch',
    path: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };

  async function createPatient(
    clinic: Clinic,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await call(clinic, clinic.adminToken, 'post', '/patients', {
      firstName,
      lastName: 'Laboratorio',
      docType: 'NATIONAL_ID',
      docNumber,
      sex: 'F',
      phone: '+584121234567',
    }).expect(201);
    return idOf(res);
  }

  async function mainLocation(clinic: Clinic): Promise<string> {
    return (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
  }

  /** Ítem del plan del paciente (por `raw`: el plan no es lo que se prueba). */
  async function planItem(clinic: Clinic, patientId: string): Promise<string> {
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: clinic.tenantId,
        code: `dx017-${patientId.slice(0, 8)}`,
        kind: 'PROCEDURE',
        labelEs: 'Corona de zirconio',
        color: '#123456',
      },
    });
    const plan = await raw.treatmentPlan.create({
      data: { tenantId: clinic.tenantId, patientId, currency: 'USD' },
    });
    const item = await raw.treatmentPlanItem.create({
      data: {
        tenantId: clinic.tenantId,
        planId: plan.id,
        catalogItemId: catalog.id,
        toothNumber: '16',
        price: 300,
      },
    });
    return item.id;
  }

  async function appointment(
    clinic: Clinic,
    patientId: string,
    providerId: string,
    start: Date,
  ): Promise<string> {
    const row = await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId: await mainLocation(clinic),
        patientId,
        providerId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    return row.id;
  }

  const orderEvents = (clinic: Clinic, resourceId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'DENTAL_LAB_ORDER',
        resourceId,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(LAB_CLOCK).useValue(() => NOW),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'labo-a');
    b = await registerClinic(app, 'labo-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: d.userId },
      data: {
        professionalLicense: 'COV 12345',
        professionalSpecialty: 'Prostodoncia',
      },
    });
    const r = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = {
      token: await loginAs(app, a.host, r.email),
      userId: r.userId,
    };
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    patient1 = await createPatient(a, 'Valentina', '62000001');
    patient2 = await createPatient(a, 'Andrés', '62000002');
    patientB = await createPatient(b, 'Otra', '62000003');
    locationA = await mainLocation(a);
    locationB = await mainLocation(b);
    itemA = await planItem(a, patient1);
    itemOfPatient2 = await planItem(a, patient2);
    itemB = await planItem(b, patientB);
    appointmentA = await appointment(
      a,
      patient1,
      d.userId,
      new Date('2026-12-04T14:00:00.000Z'),
    );
    appointmentOfPatient2 = await appointment(
      a,
      patient2,
      d.userId,
      new Date('2026-12-04T15:00:00.000Z'),
    );
    appointmentB = await appointment(
      b,
      patientB,
      b.adminUserId,
      new Date('2026-12-04T14:00:00.000Z'),
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('catálogo de laboratorios', () => {
    it('ADMIN da de alta laboratorios y servicios (auditado); el precio de referencia solo lo ve ADMIN', async () => {
      labA = idOf(
        await call(a, a.adminToken, 'post', '/dental-labs', {
          name: 'Laboratorio Dental Caracas',
          contactName: 'Carmen Rondón',
          phone: '+58 212 555 0142',
          email: 'pedidos@labdentalcaracas.com.ve',
        }).expect(201),
      );
      const zirconia = await call(
        a,
        a.adminToken,
        'post',
        `/dental-labs/${labA}/services`,
        {
          name: 'Corona zirconio',
          leadTimeBusinessDays: 5,
          referencePrice: '180',
          referenceCurrency: 'USD',
        },
      ).expect(201);
      zirconiaA = idOf(zirconia);
      expect(zirconia.body).toMatchObject({
        labId: labA,
        referencePrice: '180.00',
        referenceCurrency: 'USD',
      });
      splintA = idOf(
        await call(a, a.adminToken, 'post', `/dental-labs/${labA}/services`, {
          name: 'Férula de descarga',
          leadTimeBusinessDays: 3,
        }).expect(201),
      );
      const forReception = await call(
        a,
        reception.token,
        'get',
        '/dental-labs',
      ).expect(200);
      const [lab] = forReception.body as LabBody[];
      expect(lab.services.map((s) => [s.name, s.referencePrice])).toEqual([
        ['Corona zirconio', null],
        ['Férula de descarga', null],
      ]);
      const forAdmin = await call(a, a.adminToken, 'get', '/dental-labs');
      expect((forAdmin.body as LabBody[])[0].services[0].referencePrice).toBe(
        '180.00',
      );
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceType: 'DENTAL_LAB' },
      });
      expect(
        events.map((e) => (e.metadata as { reason: string }).reason).sort(),
      ).toEqual([
        'DENTAL_LAB_CREATED',
        'DENTAL_LAB_SERVICE_CREATED',
        'DENTAL_LAB_SERVICE_CREATED',
      ]);
    });

    it('solo ADMIN cambia el catálogo (403 en español); nombre repetido 409; precio sin moneda 400', async () => {
      for (const token of [dentist.token, reception.token, assistant]) {
        const res = await call(a, token, 'post', '/dental-labs', {
          name: 'Otro',
        }).expect(403);
        expect((res.body as ErrorBody).message).toBe(
          LAB_CATALOG_FORBIDDEN_MESSAGE,
        );
      }
      const dup = await call(a, a.adminToken, 'post', '/dental-labs', {
        name: 'laboratorio dental caracas',
      }).expect(409);
      expect((dup.body as ErrorBody).message).toBe(LAB_MESSAGES.labNameTaken);
      await call(a, a.adminToken, 'post', `/dental-labs/${labA}/services`, {
        name: 'Incrustación',
        leadTimeBusinessDays: 4,
        referencePrice: '90',
      }).expect(400);
      await call(a, a.adminToken, 'post', `/dental-labs/${labA}/services`, {
        name: 'Incrustación',
        leadTimeBusinessDays: 121,
      }).expect(400);
    });

    it('desactivar no borra: el laboratorio sale solo con includeInactive', async () => {
      const proto = idOf(
        await call(a, a.adminToken, 'post', '/dental-labs', {
          name: 'ProtoLab Valencia',
        }).expect(201),
      );
      const res = await call(
        a,
        a.adminToken,
        'patch',
        `/dental-labs/${proto}`,
        {
          active: false,
        },
      ).expect(200);
      expect((res.body as LabBody).active).toBe(false);
      const active = await call(a, dentist.token, 'get', '/dental-labs');
      expect((active.body as LabBody[]).map((l) => l.id)).toEqual([labA]);
      const all = await call(
        a,
        dentist.token,
        'get',
        '/dental-labs?includeInactive=true',
      );
      expect((all.body as LabBody[]).map((l) => l.name)).toEqual([
        'Laboratorio Dental Caracas',
        'ProtoLab Valencia',
      ]);
      // Un laboratorio inactivo no recibe órdenes (422).
      const order = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        { labId: proto, ...CROWN },
      ).expect(422);
      expect((order.body as ErrorBody).message).toBe(LAB_MESSAGES.labInactive);
    });
  });

  describe('fecha prometida sugerida', () => {
    it('«Corona zirconio» (5 días hábiles) desde el viernes: el viernes siguiente', async () => {
      const res = await call(
        a,
        reception.token,
        'get',
        `/lab-orders/due-date-suggestion?serviceId=${zirconiaA}&from=${FRIDAY}`,
      ).expect(200);
      expect(res.body).toEqual({
        dueOn: '2026-11-27',
        from: FRIDAY,
        leadTimeBusinessDays: 5,
      });
    });

    it('salta los días en que la sede está cerrada (miércoles sin horario) y sus festivos', async () => {
      // Lunes, martes, jueves y viernes de 8:00 a 17:00; el miércoles cerrado.
      await call(a, a.adminToken, 'put', '/locations/schedule')
        .set('X-Location-Id', locationA)
        .send({
          ranges: [1, 2, 4, 5].map((weekday) => ({
            weekday,
            startMinute: 480,
            endMinute: 1020,
          })),
        })
        .expect(200);
      const holiday = await raw.locationHoliday.create({
        data: {
          tenantId: a.tenantId,
          locationId: locationA,
          date: new Date('2026-11-23T00:00:00.000Z'),
          name: 'Cierre de la sede',
          recurring: false,
        },
      });
      try {
        // Lun 23 festivo, mar 24 (1), mié cerrado, jue 26 (2), vie 27 (3),
        // lun 30 (4), mar 1 (5).
        const res = await call(
          a,
          dentist.token,
          'get',
          `/lab-orders/due-date-suggestion?serviceId=${zirconiaA}&from=${FRIDAY}&locationId=${locationA}`,
        ).expect(200);
        expect((res.body as { dueOn: string }).dueOn).toBe('2026-12-01');
      } finally {
        await raw.locationHoliday.update({
          where: { id: holiday.id },
          data: { deletedAt: NOW },
        });
        await call(a, a.adminToken, 'put', '/locations/schedule')
          .set('X-Location-Id', locationA)
          .send({ ranges: [] })
          .expect(200);
      }
    });
  });

  describe('flujo de la orden', () => {
    it('el odontólogo crea desde un ítem del plan: borrador con su registro y la fecha sugerida desde el viernes del reloj fijo', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        {
          labId: labA,
          serviceId: zirconiaA,
          treatmentPlanItemId: itemA,
          appointmentId: appointmentA,
          ...CROWN,
        },
      ).expect(201);
      orderA = idOf(res);
      expect(res.body).toMatchObject({
        number: 1,
        status: 'DRAFT',
        overdue: false,
        daysOverdue: null,
        patientId: patient1,
        locationId: locationA,
        dueOn: '2026-11-27',
        shade: 'A2',
        clinicalRedacted: false,
        professional: { userId: dentist.userId },
        treatmentPlanItem: {
          id: itemA,
          toothNumber: '16',
          procedureName: 'Corona de zirconio',
        },
        appointment: { id: appointmentA },
        sentAt: null,
      });
      const [created] = await orderEvents(a, orderA);
      expect(created).toMatchObject({ action: 'CREATE', patientId: patient1 });
    });

    it('recibir sin enviar → 422 en español; revisar sin recibir → 422', async () => {
      const res = await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${orderA}/receive`,
      ).expect(422);
      expect((res.body as ErrorBody).message).toBe(
        'No se puede recibir una orden que no se ha enviado.',
      );
      const check = await call(
        a,
        dentist.token,
        'post',
        `/lab-orders/${orderA}/check`,
      ).expect(422);
      expect((check.body as ErrorBody).message).toBe(
        'No se puede revisar una orden que no se ha recibido.',
      );
    });

    it('en borrador se edita el contenido; el cambio manual de la fecha prometida queda en auditoría (sin texto clínico)', async () => {
      const res = await call(
        a,
        dentist.token,
        'patch',
        `/lab-orders/${orderA}`,
        {
          shade: 'A3',
          dueOn: '2026-11-30',
        },
      ).expect(200);
      expect(res.body).toMatchObject({ shade: 'A3', dueOn: '2026-11-30' });
      const event = (await orderEvents(a, orderA)).at(-1)!;
      expect(event).toMatchObject({ action: 'UPDATE', patientId: patient1 });
      expect(event.metadata).toMatchObject({
        reason: 'DENTAL_LAB_ORDER_UPDATED',
        changedFields: ['dueOn', 'shade'],
        dueOn: { from: '2026-11-27', to: '2026-11-30' },
      });
      // Solo nombres de campos, la fecha y la ruta: ni el color ni el texto.
      expect(Object.keys(event.metadata as object).sort()).toEqual([
        'changedFields',
        'dueOn',
        'params',
        'reason',
      ]);
      expect(JSON.stringify(event.metadata)).not.toMatch(/chamfer|zirconio/i);
    });

    it('recepción no toca el contenido (403) ni crea ni anula; sí cambia la fecha prometida', async () => {
      await call(a, reception.token, 'patch', `/lab-orders/${orderA}`, {
        instructions: 'Otra cosa',
      }).expect(403);
      const create = await call(
        a,
        reception.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        { labId: labA, ...CROWN },
      ).expect(403);
      expect((create.body as ErrorBody).message).toBe(
        LAB_ORDER_WRITE_FORBIDDEN_MESSAGE,
      );
      await call(a, reception.token, 'post', `/lab-orders/${orderA}/cancel`, {
        reason: 'No procede',
      }).expect(403);
      const moved = await call(
        a,
        reception.token,
        'patch',
        `/lab-orders/${orderA}`,
        { dueOn: '2026-12-01' },
      ).expect(200);
      expect(moved.body).toMatchObject({
        dueOn: '2026-12-01',
        shade: null,
        material: null,
        instructions: null,
        clinicalRedacted: true,
      });
    });

    it('crear → enviar → recibir → revisar: cada paso guarda fecha y usuario; el estado sale de las fechas', async () => {
      const sent = await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${orderA}/send`,
        {},
      ).expect(200);
      expect(sent.body).toMatchObject({
        status: 'SENT',
        sentAt: NOW.toISOString(),
        sentBy: { id: reception.userId },
        // Fecha puesta a mano: el envío la respeta.
        dueOn: '2026-12-01',
      });
      await call(
        a,
        dentist.token,
        'post',
        `/lab-orders/${orderA}/send`,
        {},
      ).expect(409);
      const received = await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${orderA}/receive`,
      ).expect(200);
      expect(received.body).toMatchObject({
        status: 'RECEIVED',
        receivedAt: NOW.toISOString(),
        receivedBy: { id: reception.userId },
      });
      const denied = await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${orderA}/check`,
      ).expect(403);
      expect((denied.body as ErrorBody).message).toBe(
        LAB_ORDER_CHECK_FORBIDDEN_MESSAGE,
      );
      const checked = await call(
        a,
        dentist.token,
        'post',
        `/lab-orders/${orderA}/check`,
      ).expect(200);
      expect(checked.body).toMatchObject({
        status: 'CHECKED',
        checkedBy: { id: dentist.userId },
      });
      const steps = (await orderEvents(a, orderA))
        .map((e) => e.metadata as { reason: string; statusChange?: object })
        .filter((m) => m.statusChange);
      expect(steps.map((m) => [m.reason, m.statusChange])).toEqual([
        ['DENTAL_LAB_ORDER_SENT', { from: 'DRAFT', to: 'SENT' }],
        ['DENTAL_LAB_ORDER_RECEIVED', { from: 'SENT', to: 'RECEIVED' }],
        ['DENTAL_LAB_ORDER_CHECKED', { from: 'RECEIVED', to: 'CHECKED' }],
      ]);
    });

    it('tras «Enviada» el contenido no cambia (409 con el camino) y la corrección es una orden nueva que la referencia', async () => {
      const res = await call(
        a,
        dentist.token,
        'patch',
        `/lab-orders/${orderA}`,
        {
          shade: 'B1',
        },
      ).expect(409);
      expect((res.body as ErrorBody).message).toBe(
        'La orden ya se envió: para corregirla crea una orden nueva que la sustituya.',
      );
      const fix = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        { labId: labA, ...CROWN, shade: 'B1', replacesOrderId: orderA },
      ).expect(201);
      expect(fix.body).toMatchObject({
        number: 2,
        replacesOrder: { id: orderA, number: 1 },
      });
      const original = await call(a, assistant, 'get', `/lab-orders/${orderA}`);
      expect((original.body as OrderBody).replacedBy).toEqual([
        { id: idOf(fix), number: 2 },
      ]);
      // Revisada: no se anula.
      await call(a, dentist.token, 'post', `/lab-orders/${orderA}/cancel`, {
        reason: 'Error de color',
      }).expect(409);
    });

    it('anulación con motivo: VOID sin el motivo en la auditoría y la orden ya no se toca', async () => {
      const order = idOf(
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient2}/lab-orders`,
          {
            labId: labA,
            serviceId: splintA,
            description: 'Férula de descarga',
          },
        ).expect(201),
      );
      await call(a, dentist.token, 'post', `/lab-orders/${order}/cancel`, {
        reason: 'no',
      }).expect(400);
      const res = await call(
        a,
        dentist.token,
        'post',
        `/lab-orders/${order}/cancel`,
        { reason: 'El paciente pospone el tratamiento' },
      ).expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'El paciente pospone el tratamiento',
      });
      const event = (await orderEvents(a, order)).at(-1)!;
      expect(event.action).toBe('VOID');
      expect(event.metadata).toMatchObject({
        reason: 'DENTAL_LAB_ORDER_CANCELLED',
        statusChange: { from: 'DRAFT', to: 'CANCELLED' },
      });
      expect(JSON.stringify(event.metadata)).not.toContain('pospone');
      const after = await call(
        a,
        dentist.token,
        'patch',
        `/lab-orders/${order}`,
        {
          dueOn: '2026-12-10',
        },
      ).expect(409);
      expect((after.body as ErrorBody).message).toBe(LAB_MESSAGES.cancelled);
      await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${order}/send`,
        {},
      ).expect(409);
    });

    it('validaciones: dientes FDI, textos, fecha y servicio de otro laboratorio → 400/422 en español', async () => {
      const post = (body: object) =>
        call(a, dentist.token, 'post', `/patients/${patient1}/lab-orders`, {
          labId: labA,
          ...CROWN,
          ...body,
        });
      const teeth = await post({ toothNumbers: ['19'] }).expect(400);
      expect(JSON.stringify(teeth.body)).toContain('FDI');
      await post({ toothNumbers: ['16', '16'] }).expect(400);
      await post({ description: '' }).expect(400);
      await post({ shade: 'x'.repeat(41) }).expect(400);
      await post({ dueOn: '2026-02-30' }).expect(400);
      const proto = (
        await raw.dentalLab.findFirstOrThrow({
          where: { tenantId: a.tenantId, name: 'ProtoLab Valencia' },
        })
      ).id;
      await call(a, a.adminToken, 'patch', `/dental-labs/${proto}`, {
        active: true,
      }).expect(200);
      const otherLab = await post({
        labId: proto,
        serviceId: zirconiaA,
      }).expect(422);
      expect((otherLab.body as ErrorBody).message).toBe(
        LAB_MESSAGES.serviceOfOtherLab,
      );
    });

    it('ítem o cita de OTRO paciente de la clínica → 422 genérico, sin crear nada', async () => {
      const before = await raw.dentalLabOrder.count();
      const item = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        { labId: labA, ...CROWN, treatmentPlanItemId: itemOfPatient2 },
      ).expect(422);
      expect((item.body as ErrorBody).message).toBe(
        'El ítem del plan no es de este paciente.',
      );
      const appt = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/lab-orders`,
        { labId: labA, ...CROWN, appointmentId: appointmentOfPatient2 },
      ).expect(422);
      expect((appt.body as ErrorBody).message).toBe(
        'La cita no es de este paciente.',
      );
      expect(await raw.dentalLabOrder.count()).toBe(before);
    });
  });

  describe('lista de la sede, ficha e impresión', () => {
    it('«Solo atrasados»: la fecha prometida vencida y sin recibir, con los días de atraso, primero en la lista', async () => {
      const late = idOf(
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient2}/lab-orders`,
          {
            labId: labA,
            serviceId: zirconiaA,
            description: 'Corona provisional',
            dueOn: '2026-11-17',
          },
        ).expect(201),
      );
      await call(
        a,
        reception.token,
        'post',
        `/lab-orders/${late}/send`,
        {},
      ).expect(200);
      const res = await call(
        a,
        reception.token,
        'get',
        '/lab-orders?overdue=true',
      ).expect(200);
      const page = res.body as PageBody;
      expect(page).toMatchObject({ total: 1, page: 1, pageSize: 50 });
      expect(page.items[0]).toMatchObject({
        id: late,
        status: 'SENT',
        overdue: true,
        daysOverdue: 3,
        dueOn: '2026-11-17',
        clinicalRedacted: true,
      });
      const all = await call(a, dentist.token, 'get', '/lab-orders').expect(
        200,
      );
      expect((all.body as PageBody).items[0].id).toBe(late);
      const sent = await call(
        a,
        dentist.token,
        'get',
        `/lab-orders?status=SENT&status=RECEIVED&labId=${labA}`,
      ).expect(200);
      expect((sent.body as PageBody).items.map((o) => o.id)).toEqual([late]);
      await call(a, dentist.token, 'get', '/lab-orders?status=OTRO').expect(
        400,
      );
      await call(a, dentist.token, 'get', '/lab-orders?pageSize=500').expect(
        400,
      );
      const listed = await raw.auditEvent.findFirst({
        where: {
          tenantId: a.tenantId,
          resourceType: 'DENTAL_LAB_ORDER',
          action: 'VIEW',
          resourceId: null,
        },
      });
      expect(listed?.metadata).toMatchObject({
        reason: 'DENTAL_LAB_ORDER_LIST',
      });
    });

    it('la ficha lista las órdenes del paciente, la más reciente primero', async () => {
      const res = await call(
        a,
        assistant,
        'get',
        `/patients/${patient1}/lab-orders`,
      ).expect(200);
      const page = res.body as PageBody;
      expect(page.items.map((o) => o.number)).toEqual([2, 1]);
      expect(page.items[0].shade).toBe('B1');
    });

    it('impresión: prescripción con clínica, sede, profesional con su registro, paciente y la orden completa; recepción no imprime', async () => {
      const res = await call(
        a,
        dentist.token,
        'get',
        `/lab-orders/${orderA}/print`,
      ).expect(200);
      expect(res.body).toMatchObject({
        order: { id: orderA, shade: 'A3', clinicalRedacted: false },
        professional: { license: 'COV 12345', specialty: 'Prostodoncia' },
        patient: { fullName: 'Valentina Laboratorio' },
        location: { name: expect.any(String) as string },
        clinic: { name: expect.any(String) as string },
        printedAt: NOW.toISOString(),
      });
      expect(
        (res.body as { patient: { document: string } }).patient.document,
      ).toContain('62000001');
      const denied = await call(
        a,
        reception.token,
        'get',
        `/lab-orders/${orderA}/print`,
      ).expect(403);
      expect((denied.body as ErrorBody).message).toBe(
        LAB_ORDER_PRINT_FORBIDDEN_MESSAGE,
      );
      const printed = (await orderEvents(a, orderA)).at(-1)!;
      expect(printed).toMatchObject({ action: 'PRINT', patientId: patient1 });
    });
  });

  describe('aislamiento entre clínicas', () => {
    beforeAll(async () => {
      labB = idOf(
        await call(b, b.adminToken, 'post', '/dental-labs', {
          name: 'Laboratorio Dental Caracas',
        }).expect(201),
      );
      serviceB = idOf(
        await call(b, b.adminToken, 'post', `/dental-labs/${labB}/services`, {
          name: 'Corona zirconio',
          leadTimeBusinessDays: 5,
        }).expect(201),
      );
    });

    // ISOLATION_COVERS: PATCH /dental-labs/:labId
    // ISOLATION_COVERS: POST /dental-labs/:labId/services
    // ISOLATION_COVERS: PATCH /dental-labs/:labId/services/:serviceId
    // ISOLATION_COVERS: GET /patients/:patientId/lab-orders
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders
    // ISOLATION_COVERS: GET /lab-orders/:id
    // ISOLATION_COVERS: PATCH /lab-orders/:id
    // ISOLATION_COVERS: POST /lab-orders/:id/send
    // ISOLATION_COVERS: POST /lab-orders/:id/receive
    // ISOLATION_COVERS: POST /lab-orders/:id/check
    // ISOLATION_COVERS: POST /lab-orders/:id/cancel
    // ISOLATION_COVERS: GET /lab-orders/:id/print
    it('B → 404 sobre el laboratorio, el servicio, el paciente y la orden de A, y nada de A cambia', async () => {
      const labBefore = await raw.dentalLab.findUniqueOrThrow({
        where: { id: labA },
        include: { services: true },
      });
      const orderBefore = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: orderA },
      });
      const ordersBefore = await raw.dentalLabOrder.count({
        where: { tenantId: a.tenantId },
      });
      const tries: [
        verb: 'get' | 'post' | 'patch',
        path: string,
        body?: object,
      ][] = [
        ['patch', `/dental-labs/${labA}`, { name: 'Tomado' }],
        [
          'post',
          `/dental-labs/${labA}/services`,
          { name: 'Intruso', leadTimeBusinessDays: 1 },
        ],
        [
          'patch',
          `/dental-labs/${labA}/services/${zirconiaA}`,
          { leadTimeBusinessDays: 1 },
        ],
        // El servicio de A bajo el laboratorio de B: tampoco existe.
        [
          'patch',
          `/dental-labs/${labB}/services/${zirconiaA}`,
          { leadTimeBusinessDays: 1 },
        ],
        ['get', `/patients/${patient1}/lab-orders`],
        ['post', `/patients/${patient1}/lab-orders`, { labId: labB, ...CROWN }],
        ['get', `/lab-orders/${orderA}`],
        ['patch', `/lab-orders/${orderA}`, { dueOn: '2026-12-24' }],
        ['post', `/lab-orders/${orderA}/send`, {}],
        ['post', `/lab-orders/${orderA}/receive`],
        ['post', `/lab-orders/${orderA}/check`],
        ['post', `/lab-orders/${orderA}/cancel`, { reason: 'Intrusión' }],
        ['get', `/lab-orders/${orderA}/print`],
      ];
      for (const [verb, path, body] of tries) {
        const res = await call(b, b.adminToken, verb, path, body);
        expect([path, res.status]).toEqual([path, 404]);
        expect(typeof (res.body as ErrorBody).message).toBe('string');
        expect(JSON.stringify(res.body)).not.toContain('Valentina');
      }
      expect(
        await raw.dentalLab.findUniqueOrThrow({
          where: { id: labA },
          include: { services: true },
        }),
      ).toEqual(labBefore);
      expect(
        await raw.dentalLabOrder.findUniqueOrThrow({ where: { id: orderA } }),
      ).toEqual(orderBefore);
      expect(
        await raw.dentalLabOrder.count({ where: { tenantId: a.tenantId } }),
      ).toBe(ordersBefore);
    });

    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.labId
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.serviceId
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.locationId
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.treatmentPlanItemId
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.appointmentId
    // ISOLATION_COVERS: POST /patients/:patientId/lab-orders body.replacesOrderId
    it('B crea una orden con el laboratorio, el servicio, la sede, el ítem, la cita o la orden de A: 404/422 en español y nada se crea', async () => {
      const before = await raw.dentalLabOrder.count();
      const post = (body: object) =>
        call(b, b.adminToken, 'post', `/patients/${patientB}/lab-orders`, {
          labId: labB,
          description: 'Corona de zirconio',
          ...body,
        });
      const expectations: [body: object, status: number, message: string][] = [
        [{ labId: labA }, 404, LAB_MESSAGES.labNotFound],
        [{ serviceId: zirconiaA }, 404, LAB_MESSAGES.serviceNotFound],
        [{ locationId: locationA }, 404, LAB_MESSAGES.locationNotFound],
        [
          { treatmentPlanItemId: itemA },
          422,
          LAB_MESSAGES.planItemNotOfPatient,
        ],
        [
          { appointmentId: appointmentA },
          422,
          LAB_MESSAGES.appointmentNotOfPatient,
        ],
        [{ replacesOrderId: orderA }, 422, LAB_MESSAGES.replacesNotOfPatient],
      ];
      for (const [body, status, message] of expectations) {
        const res = await post(body);
        expect([body, res.status, (res.body as ErrorBody).message]).toEqual([
          body,
          status,
          message,
        ]);
      }
      expect(await raw.dentalLabOrder.count()).toBe(before);
      // Con lo suyo, B sí crea (y su número empieza en 1).
      const own = await post({
        serviceId: serviceB,
        treatmentPlanItemId: itemB,
        appointmentId: appointmentB,
        locationId: locationB,
      }).expect(201);
      expect((own.body as OrderBody).number).toBe(1);
    });

    // ISOLATION_COVERS: PATCH /lab-orders/:id body.labId
    // ISOLATION_COVERS: PATCH /lab-orders/:id body.serviceId
    // ISOLATION_COVERS: PATCH /lab-orders/:id body.treatmentPlanItemId
    // ISOLATION_COVERS: PATCH /lab-orders/:id body.appointmentId
    // ISOLATION_COVERS: PATCH /lab-orders/:id body.replacesOrderId
    it('B edita su orden con el laboratorio, el servicio, el ítem, la cita o la orden de A: 404/422 y su orden no cambia', async () => {
      const own = idOf(
        await call(
          b,
          b.adminToken,
          'post',
          `/patients/${patientB}/lab-orders`,
          {
            labId: labB,
            description: 'Férula de descarga',
          },
        ).expect(201),
      );
      const before = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: own },
      });
      const expectations: [body: object, status: number][] = [
        [{ labId: labA }, 404],
        [{ serviceId: zirconiaA }, 404],
        [{ treatmentPlanItemId: itemA }, 422],
        [{ appointmentId: appointmentA }, 422],
        [{ replacesOrderId: orderA }, 422],
      ];
      for (const [body, status] of expectations) {
        const res = await call(
          b,
          b.adminToken,
          'patch',
          `/lab-orders/${own}`,
          body,
        );
        expect([body, res.status]).toEqual([body, status]);
      }
      expect(
        await raw.dentalLabOrder.findUniqueOrThrow({ where: { id: own } }),
      ).toEqual(before);
    });

    // DX-207 (tenant-id-inputs): GET /lab-orders ?locationId y ?labId,
    // GET /lab-orders/due-date-suggestion ?locationId y ?serviceId.
    it('B lista o pide la fecha sugerida con la sede, el laboratorio o el servicio de A: 404 o una lista sin filas de A', async () => {
      await call(
        b,
        b.adminToken,
        'get',
        `/lab-orders?locationId=${locationA}`,
      ).expect(404);
      const byLab = await call(
        b,
        b.adminToken,
        'get',
        `/lab-orders?labId=${labA}`,
      ).expect(200);
      expect(byLab.body).toMatchObject({ items: [], total: 0 });
      await call(
        b,
        b.adminToken,
        'get',
        `/lab-orders/due-date-suggestion?serviceId=${zirconiaA}`,
      ).expect(404);
      await call(
        b,
        b.adminToken,
        'get',
        `/lab-orders/due-date-suggestion?serviceId=${serviceB}&locationId=${locationA}`,
      ).expect(404);
      const own = await call(b, b.adminToken, 'get', '/lab-orders').expect(200);
      expect(
        (own.body as PageBody).items.every((o) => o.locationId === locationB),
      ).toBe(true);
    });
  });

  // DX-017-bis: lecturas por id y ficha del paciente acotadas a las sedes
  // permitidas del miembro (DX-089, claim `loc`), como ya lo estaban las
  // escrituras (SEC-014).
  describe('sedes permitidas (DX-089) en las lecturas', () => {
    let otherLocation: string;
    let patient3: string;
    let inMain: string;
    let inOther: string;
    let limited: string;
    // DX-017-ter: «corrige a» entre sedes (otro paciente, para no tocar los
    // totales de patient3).
    let patient4: string;
    let p4Main: string;
    let p4Other: string;
    let crossFix: string;
    let p4OtherFix: string;

    beforeAll(async () => {
      otherLocation = idOf(
        await call(
          a,
          a.adminToken,
          'post',
          '/locations',
          locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Valencia' }),
        ).expect(201),
      );
      patient3 = await createPatient(a, 'Mariana', '62000004');
      inMain = idOf(
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient3}/lab-orders`,
          {
            labId: labA,
            locationId: locationA,
            ...CROWN,
          },
        ).expect(201),
      );
      inOther = idOf(
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient3}/lab-orders`,
          {
            labId: labA,
            locationId: otherLocation,
            ...CROWN,
          },
        ).expect(201),
      );
      patient4 = await createPatient(a, 'Rosa', '62000005');
      const orderOf = async (body: Record<string, unknown>) =>
        idOf(
          await call(
            a,
            dentist.token,
            'post',
            `/patients/${patient4}/lab-orders`,
            { labId: labA, ...CROWN, ...body },
          ).expect(201),
        );
      p4Main = await orderOf({ locationId: locationA });
      p4Other = await orderOf({ locationId: otherLocation });
      // Sin restricción de sede, «corrige a» puede cruzar sedes.
      crossFix = await orderOf({
        locationId: locationA,
        replacesOrderId: p4Other,
      });
      p4OtherFix = await orderOf({
        locationId: otherLocation,
        replacesOrderId: p4Main,
      });
      // El mismo odontólogo, ahora limitado a la sede principal (último
      // bloque del spec: nada después depende de él sin restricción).
      await call(a, a.adminToken, 'put', `/staff/${dentist.userId}/locations`, {
        locationIds: [locationA],
      }).expect(200);
      const dentistUser = await raw.user.findUniqueOrThrow({
        where: { id: dentist.userId },
      });
      limited = await loginAs(app, a.host, dentistUser.email);
    });

    it('un odontólogo limitado a la sede principal no lee ni imprime la orden de otra sede: el mismo 403 que al escribirla', async () => {
      const write = await call(a, limited, 'patch', `/lab-orders/${inOther}`, {
        dueOn: '2026-12-15',
      }).expect(403);
      expect((write.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
      const read = await call(
        a,
        limited,
        'get',
        `/lab-orders/${inOther}`,
      ).expect(403);
      expect(read.body).toEqual(write.body);
      const before = (await orderEvents(a, inOther)).length;
      const print = await call(
        a,
        limited,
        'get',
        `/lab-orders/${inOther}/print`,
      ).expect(403);
      expect((print.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
      expect(await orderEvents(a, inOther)).toHaveLength(before);
      // La de su sede, normal.
      await call(a, limited, 'get', `/lab-orders/${inMain}`).expect(200);
      await call(a, limited, 'get', `/lab-orders/${inMain}/print`).expect(200);
    });

    it('la ficha del paciente solo trae las órdenes de sus sedes (también en el total); sin restricción (ADMIN), todas', async () => {
      const own = (
        await call(
          a,
          limited,
          'get',
          `/patients/${patient3}/lab-orders`,
        ).expect(200)
      ).body as PageBody;
      expect(own.items.map((o) => o.id)).toEqual([inMain]);
      expect(own.total).toBe(1);
      expect(own.items.every((o) => o.locationId === locationA)).toBe(true);
      const all = (
        await call(
          a,
          a.adminToken,
          'get',
          `/patients/${patient3}/lab-orders`,
        ).expect(200)
      ).body as PageBody;
      expect(all.items.map((o) => o.id).sort()).toEqual(
        [inMain, inOther].sort(),
      );
      expect(all.total).toBe(2);
    });

    it('DX-017-ter · crear con «corrige a» una orden de otra sede: el mismo 403 que al escribirla, sin crear nada ni mostrar la orden', async () => {
      const write = await call(a, limited, 'patch', `/lab-orders/${p4Other}`, {
        dueOn: '2026-12-15',
      }).expect(403);
      const before = await raw.dentalLabOrder.count({
        where: { patientId: patient4 },
      });
      const denied = await call(
        a,
        limited,
        'post',
        `/patients/${patient4}/lab-orders`,
        {
          labId: labA,
          locationId: locationA,
          replacesOrderId: p4Other,
          ...CROWN,
        },
      ).expect(403);
      expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
      expect(denied.body).toEqual(write.body);
      expect(JSON.stringify(denied.body)).not.toContain(p4Other);
      expect(
        await raw.dentalLabOrder.count({ where: { patientId: patient4 } }),
      ).toBe(before);
    });

    it('DX-017-ter · editar «corrige a» hacia una orden de otra sede da 403 y la orden no cambia', async () => {
      const denied = await call(a, limited, 'patch', `/lab-orders/${p4Main}`, {
        replacesOrderId: p4Other,
      }).expect(403);
      expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
      const row = await raw.dentalLabOrder.findUniqueOrThrow({
        where: { id: p4Main },
      });
      expect(row.replacesOrderId).toBeNull();
    });

    it('DX-017-ter · «corrige a» hacia una orden de su sede sigue funcionando', async () => {
      const fix = (
        await call(a, limited, 'post', `/patients/${patient4}/lab-orders`, {
          labId: labA,
          locationId: locationA,
          replacesOrderId: p4Main,
          ...CROWN,
        }).expect(201)
      ).body as OrderBody;
      expect(fix.replacesOrder?.id).toBe(p4Main);
    });

    it('DX-017-ter · las vistas no enlazan órdenes de otra sede (vista, ficha y lista); sin restricción (ADMIN), sí', async () => {
      const seen = (
        await call(a, limited, 'get', `/lab-orders/${crossFix}`).expect(200)
      ).body as OrderBody;
      expect(seen.replacesOrder).toBeNull();
      const original = (
        await call(a, limited, 'get', `/lab-orders/${p4Main}`).expect(200)
      ).body as OrderBody;
      expect(original.replacedBy.map((r) => r.id)).not.toContain(p4OtherFix);
      const sheet = await call(
        a,
        limited,
        'get',
        `/patients/${patient4}/lab-orders`,
      ).expect(200);
      const listed = await call(
        a,
        limited,
        'get',
        `/lab-orders?locationId=${locationA}&pageSize=100`,
      ).expect(200);
      for (const body of [sheet.text, listed.text]) {
        expect(body).not.toContain(p4Other);
        expect(body).not.toContain(p4OtherFix);
      }
      const admin = (
        await call(a, a.adminToken, 'get', `/lab-orders/${crossFix}`).expect(
          200,
        )
      ).body as OrderBody;
      expect(admin.replacesOrder?.id).toBe(p4Other);
      const adminOriginal = (
        await call(a, a.adminToken, 'get', `/lab-orders/${p4Main}`).expect(200)
      ).body as OrderBody;
      expect(adminOriginal.replacedBy.map((r) => r.id)).toContain(p4OtherFix);
    });

    it('la lista de la otra sede le da 403 LOCATION_NOT_ALLOWED', async () => {
      const denied = await call(
        a,
        limited,
        'get',
        `/lab-orders?locationId=${otherLocation}`,
      ).expect(403);
      expect((denied.body as ErrorBody).code).toBe(LOCATION_NOT_ALLOWED_CODE);
    });
  });
});
