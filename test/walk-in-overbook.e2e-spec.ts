import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import type { RegionalFixture } from './support/location-fixtures';
import { SCHEDULE_BLOCK_CLOCK } from '../src/modules/schedule-blocks/application/schedule-block-clock';
import { CLOSING_QUEUE_NOW } from '../src/modules/closing-queue/domain/ports/closing-queue-repository.port';
import {
  addCivilDays,
  civilDateIn,
  civilWeekday,
  zonedWallTime,
} from '../src/shared/time/civil-day';

// DX-509 y DX-510 en HTTP real, contra Postgres (EXCLUDE, trigger y único de
// la clave):
//  - una urgencia en sobrecupo deja de serlo al MOVERLA (y pasa el
//    anti-solape: 409 si choca); al DESHACER LA LLEGADA o REACTIVARLA, solo
//    con su hueco libre, o se mantiene a sabiendas (`keepOverbooked`,
//    auditado); en su hora no cambia; la agenda lo dice con `overbooked`;
//  - «Atender sin cita» con Idempotency-Key: envíos en paralelo con la misma
//    clave = una cita y un paciente; otro cuerpo = 422; por clínica.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const CARACAS: RegionalFixture = {
  country: 'VE',
  currency: 'VES',
  timeZone: 'America/Caracas',
  locale: 'es-VE',
  hourCycle: 'h23',
  defaultPhoneRegion: 'VE',
};

function nextTuesdayIn(zone: string): string {
  let day = addCivilDays(civilDateIn(new Date(), zone), 7);
  while (civilWeekday(day) !== 2) day = addCivilDays(day, 1);
  return day;
}
const DAY = nextTuesdayIn(CARACAS.timeZone);
const local = (hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedWallTime(DAY, h * 60 + m, CARACAS.timeZone);
};

let clockNow = new Date(0);
// «Pendiente de cerrar» mira días anteriores a hoy: su reloj va aparte.
let closingNow = new Date(0);

interface Body {
  id: string;
  [key: string]: unknown;
}
interface Member {
  userId: string;
  email: string;
  token: string;
}

describe('Sobrecupo de urgencia y «Atender sin cita» idempotente (e2e, DX-509/DX-510)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let reception: Member;
  let dentist: Member;
  let dentist2: Member;
  let mainId: string;
  let otherMainId: string;
  let bookedPatientId: string;
  let urgentPatientId: string;

  const api = () => request(app.getHttpServer());
  const as = (
    req: request.Test,
    token: string,
    /** Sin indicar: la sede principal; `null`: sin cabecera. */
    locationId: string | null = mainId,
    host = clinic.host,
  ) => {
    const r = req
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
    return locationId ? r.set('X-Location-Id', locationId) : r;
  };

  async function member(c: Clinic, role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, c, role);
    return { ...m, token: await loginAs(app, c.host, m.email) };
  }

  async function createPatient(c: Clinic, doc: string, firstName: string) {
    const res = await as(
      api().post('/api/v1/patients'),
      c.adminToken,
      null,
      c.host,
    )
      .send({
        firstName,
        lastName: 'Urgencia',
        docType: 'NATIONAL_ID',
        docNumber: doc,
        sex: 'F',
      })
      .expect(201);
    return (res.body as Body).id;
  }

  async function createUrgentType(c: Clinic) {
    await as(
      api().post('/api/v1/appointment-types'),
      c.adminToken,
      null,
      c.host,
    )
      .send({
        name: 'Consulta de urgencia',
        durationMinutes: 30,
        color: '#DC2626',
        isUrgent: true,
      })
      .expect(201);
  }

  /** Urgencia en sobrecupo AHORA (`clockNow`), de 30 min, con el dentista. */
  async function overbookedAt(hhmm: string): Promise<Body> {
    clockNow = local(hhmm);
    const res = await as(
      api().post('/api/v1/appointments/walk-in'),
      reception.token,
    )
      .send({
        patientId: urgentPatientId,
        providerId: dentist.userId,
        triageFlags: ['PAIN'],
        overbookReason: 'Dolor agudo, no puede esperar',
      })
      .expect(201);
    const body = res.body as Body;
    expect(body).toMatchObject({
      overbooked: true,
      start: local(hhmm).toISOString(),
    });
    return body;
  }

  /** Cita agendada normal del dentista (otro paciente). */
  const book = (start: string, end: string, providerId = dentist.userId) =>
    as(api().post('/api/v1/appointments'), reception.token).send({
      patientId: bookedPatientId,
      providerId,
      start: local(start).toISOString(),
      end: local(end).toISOString(),
    });

  const patch = (id: string, body: Record<string, unknown>) =>
    as(api().patch(`/api/v1/appointments/${id}`), reception.token).send(body);

  const undo = (id: string, body?: Record<string, unknown>) => {
    const req = as(
      api().post(`/api/v1/appointments/${id}/undo-arrival`),
      reception.token,
    );
    return body ? req.send(body) : req;
  };

  const overbookedInDb = async (id: string) =>
    (await raw.appointment.findUniqueOrThrow({ where: { id } })).overbooked;

  const reasonsOf = async (id: string) =>
    (
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId, resourceId: id },
        orderBy: { occurredAt: 'asc' },
      })
    ).map((e) => (e.metadata as { reason?: string }).reason);

  const agendaRow = async (id: string) => {
    const res = await as(
      api().get(
        `/api/v1/appointments?from=${encodeURIComponent(local('00:00').toISOString())}&to=${encodeURIComponent(local('23:59').toISOString())}`,
      ),
      reception.token,
    ).expect(200);
    return (res.body as Body[]).find((a) => a.id === id)!;
  };

  const expectSlotTaken = (body: unknown) =>
    expect(body).toMatchObject({
      statusCode: 409,
      code: 'OVERBOOK_SLOT_TAKEN',
      canKeepOverbooked: true,
      message:
        'Esta urgencia se atendió en sobrecupo y su hora ya la ocupa otra cita del profesional. Muévela a otra hora o mantenla como sobrecupo.',
    });

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(SCHEDULE_BLOCK_CLOCK).useValue(() => clockNow);
      builder.overrideProvider(CLOSING_QUEUE_NOW).useValue(() => closingNow);
    });
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx509-caracas', CARACAS);
    other = await registerClinic(app, 'dx509-otra', CARACAS);
    reception = await member(clinic, ClinicRole.RECEPTION);
    dentist = await member(clinic, ClinicRole.DENTIST);
    // `seedMember` usa un correo por rol: el segundo odontólogo va a mano
    // (solo hace falta su id como profesional).
    const second = await raw.user.create({
      data: {
        email: `dentist2@${clinic.subdomain}.test`,
        passwordHash: 'x',
        fullName: 'Dra. Segunda',
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: second.id,
        role: ClinicRole.DENTIST,
      },
    });
    dentist2 = { userId: second.id, email: second.email, token: '' };
    const sedes = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
      null,
    ).expect(200);
    mainId = (sedes.body as Body[])[0].id;
    const otherSedes = await as(
      api().get('/api/v1/locations'),
      other.adminToken,
      null,
      other.host,
    ).expect(200);
    otherMainId = (otherSedes.body as Body[])[0].id;
    await createUrgentType(clinic);
    await createUrgentType(other);
    bookedPatientId = await createPatient(clinic, '509001', 'Berta');
    urgentPatientId = await createPatient(clinic, '509002', 'Ursula');
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('las migraciones: trigger de la cita, único parcial por clínica de la clave y EXCLUDE por sillón que sí cuenta el sobrecupo', async () => {
    const [trigger] = await raw.$queryRaw<{ def: string }[]>`
      SELECT pg_get_triggerdef(oid) AS def FROM pg_trigger
       WHERE tgname = 'dx509_walk_in_guard'`;
    expect(trigger.def).toMatch(
      /BEFORE UPDATE OF overbooked, start, "end", "providerId"/,
    );
    const [index] = await raw.$queryRaw<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
       WHERE indexname = 'appointments_tenant_idempotency_key'`;
    expect(index.def).toMatch(
      /UNIQUE INDEX .*\("tenantId", "idempotencyKey"\) WHERE \("idempotencyKey" IS NOT NULL\)/,
    );
    const [chair] = await raw.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'appointments_no_overlap_per_chair'`;
    expect(chair.def).not.toMatch(/overbooked/);
  });

  describe('DX-509 · mover', () => {
    it('a una hora que choca: 409 y sigue en sobrecupo; a una libre: normal, auditado, y cuenta en el anti-solape', async () => {
      const a = await overbookedAt('09:00');
      await book('10:00', '10:30').expect(201);

      const clash = await patch(a.id, {
        start: local('10:10').toISOString(),
        end: local('10:40').toISOString(),
      }).expect(409);
      expect(clash.body).toMatchObject({
        message: 'El profesional ya tiene una cita en ese horario',
        // DX-509-bis: con código y ámbito, la web ofrece el siguiente hueco.
        code: 'APPOINTMENT_OVERLAP',
        scope: 'provider',
      });
      expect(await overbookedInDb(a.id)).toBe(true);

      // DX-509-bis: «Buscar hueco» para moverla: sin excluirla, su propia
      // hora (del paciente) tapa 09:00–09:30; excluyéndola, ese hueco sale.
      const openings = async (exclude: boolean) => {
        const res = await as(
          api().get('/api/v1/appointments/openings'),
          reception.token,
        )
          .query({
            providerId: dentist.userId,
            locationId: mainId,
            from: DAY,
            to: DAY,
            durationMinutes: 30,
            patientId: urgentPatientId,
            ...(exclude ? { excludeAppointmentId: a.id } : {}),
          })
          .expect(200);
        return (res.body as { openings: { start: string; end: string }[] })
          .openings;
      };
      const covers = (list: { start: string; end: string }[]) =>
        list.some(
          (o) =>
            new Date(o.start) <= local('09:00') &&
            new Date(o.end) >= local('09:30'),
        );
      expect(covers(await openings(false))).toBe(false);
      expect(covers(await openings(true))).toBe(true);
      // Una cita que no existe no cambia nada; un id que no es UUID, 400.
      await as(api().get('/api/v1/appointments/openings'), reception.token)
        .query({
          providerId: dentist.userId,
          locationId: mainId,
          from: DAY,
          to: DAY,
          durationMinutes: 30,
          excludeAppointmentId: 'no-uuid',
        })
        .expect(400);

      const moved = await patch(a.id, {
        start: local('11:00').toISOString(),
        end: local('11:30').toISOString(),
      }).expect(200);
      expect(moved.body).toMatchObject({ overbooked: false });
      expect(await overbookedInDb(a.id)).toBe(false);
      expect(await reasonsOf(a.id)).toEqual(
        expect.arrayContaining([
          'APPOINTMENT_MOVED',
          'WALK_IN_OVERBOOK_CLEARED',
        ]),
      );
      // Ya no es sobrecupo: otra cita encima del profesional choca.
      await book('11:10', '11:40').expect(409);
      expect((await agendaRow(a.id)).overbooked).toBe(false);
    });

    it('a otro profesional: normal y ocupa SU hueco', async () => {
      const a = await overbookedAt('12:00');
      const moved = await patch(a.id, { providerId: dentist2.userId }).expect(
        200,
      );
      expect(moved.body).toMatchObject({
        providerId: dentist2.userId,
        overbooked: false,
      });
      await book('12:00', '12:30', dentist2.userId).expect(409);
    });
  });

  describe('DX-509 · deshacer la llegada', () => {
    it('con su hora ocupada: 409 OVERBOOK_SLOT_TAKEN; con `keepOverbooked`, agendada en sobrecupo y auditada', async () => {
      const a = await overbookedAt('12:30');
      // Mientras es sobrecupo, el hueco del profesional sigue libre.
      await book('12:30', '13:00').expect(201);

      const taken = await undo(a.id).expect(409);
      expectSlotTaken(taken.body);
      expect(
        await raw.appointment.findUniqueOrThrow({ where: { id: a.id } }),
      ).toMatchObject({ status: 'ARRIVED', overbooked: true });

      const kept = await undo(a.id, { keepOverbooked: true }).expect(200);
      expect(kept.body).toMatchObject({
        status: 'SCHEDULED',
        overbooked: true,
        arrivedAt: null,
      });
      expect(await reasonsOf(a.id)).toEqual(
        expect.arrayContaining(['ARRIVAL_UNDONE', 'WALK_IN_OVERBOOK_KEPT']),
      );
      expect((await agendaRow(a.id)).overbooked).toBe(true);
    });

    it('con su hora libre: agendada normal (cuenta en el anti-solape)', async () => {
      const a = await overbookedAt('18:00');
      const undone = await undo(a.id).expect(200);
      expect(undone.body).toMatchObject({
        status: 'SCHEDULED',
        overbooked: false,
      });
      expect(await reasonsOf(a.id)).toContain('WALK_IN_OVERBOOK_CLEARED');
      await book('18:00', '18:30').expect(409);
      expect((await agendaRow(a.id)).overbooked).toBe(false);
    });
  });

  describe('DX-509 · reactivar', () => {
    const cancel = (id: string) =>
      patch(id, {
        status: 'CANCELLED',
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'ILLNESS',
      }).expect(200);

    it('con su hora ocupada: 409; con `keepOverbooked`, sigue en sobrecupo y auditada', async () => {
      const a = await overbookedAt('15:00');
      await cancel(a.id);
      await book('15:00', '15:30').expect(201);

      const taken = await patch(a.id, { status: 'SCHEDULED' }).expect(409);
      expectSlotTaken(taken.body);
      expect(
        (await raw.appointment.findUniqueOrThrow({ where: { id: a.id } }))
          .status,
      ).toBe('CANCELLED');

      const kept = await patch(a.id, {
        status: 'SCHEDULED',
        keepOverbooked: true,
      }).expect(200);
      expect(kept.body).toMatchObject({
        status: 'SCHEDULED',
        overbooked: true,
      });
      expect(await reasonsOf(a.id)).toContain('WALK_IN_OVERBOOK_KEPT');
    });

    it('con su hora libre: normal y cuenta en el anti-solape', async () => {
      const a = await overbookedAt('16:00');
      await cancel(a.id);
      const back = await patch(a.id, { status: 'SCHEDULED' }).expect(200);
      expect(back.body).toMatchObject({
        status: 'SCHEDULED',
        overbooked: false,
      });
      expect(await reasonsOf(a.id)).toContain('WALK_IN_OVERBOOK_CLEARED');
      await book('16:00', '16:30').expect(409);
    });
  });

  it('DX-509-bis · «Pendiente de cerrar» lista los sobrecupos mantenidos (no los demás), sin sumarlos al contador', async () => {
    // Mantenido a sabiendas: reactivada con su hora ocupada.
    const kept = await overbookedAt('09:30');
    await patch(kept.id, {
      status: 'CANCELLED',
      cancelledByKind: 'STAFF_FOR_PATIENT',
      cancelReasonCode: 'ILLNESS',
    }).expect(200);
    await book('09:30', '10:00').expect(201);
    await patch(kept.id, { status: 'SCHEDULED', keepOverbooked: true }).expect(
      200,
    );
    // Sobrecupo de siempre (nadie decidió mantenerlo): no sale.
    const plain = await overbookedAt('10:00');

    closingNow = new Date(local('12:00').getTime() + 86_400_000);
    const list = async (token: string) =>
      (
        await as(api().get('/api/v1/closing-queue'), token)
          .query({ from: DAY, to: DAY })
          .expect(200)
      ).body as {
        total: number;
        keptOverbooks: {
          total: number;
          items: {
            appointmentId: string;
            keptByName: string | null;
            keptAt: string;
          }[];
        };
      };
    const count = async (token: string) =>
      (
        (
          await as(api().get('/api/v1/closing-queue/count'), token)
            .query({ from: DAY, to: DAY })
            .expect(200)
        ).body as { total: number }
      ).total;

    const asReception = await list(reception.token);
    const ids = asReception.keptOverbooks.items.map((i) => i.appointmentId);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(plain.id);
    const row = asReception.keptOverbooks.items.find(
      (i) => i.appointmentId === kept.id,
    )!;
    const receptionUser = await raw.user.findUniqueOrThrow({
      where: { id: reception.userId },
    });
    expect(row.keptByName).toBe(receptionUser.fullName);
    expect(Number.isNaN(Date.parse(row.keptAt))).toBe(false);
    // Informativo: el total y el contador son los de las secciones.
    expect(await count(reception.token)).toBe(asReception.total);

    // El odontólogo de la cita la ve; la otra clínica, nunca.
    expect(
      (await list(dentist.token)).keptOverbooks.items.map(
        (i) => i.appointmentId,
      ),
    ).toContain(kept.id);
    const foreign = (
      await as(
        api().get('/api/v1/closing-queue'),
        other.adminToken,
        null,
        other.host,
      )
        .query({ from: DAY, to: DAY })
        .expect(200)
    ).body as { keptOverbooks: { total: number } };
    expect(foreign.keptOverbooks.total).toBe(0);

    // Cancelada deja de salir; movida deja de ser sobrecupo y tampoco sale.
    await patch(kept.id, {
      start: local('17:30').toISOString(),
      end: local('18:00').toISOString(),
    }).expect(200);
    expect(
      (await list(reception.token)).keptOverbooks.items.map(
        (i) => i.appointmentId,
      ),
    ).not.toContain(kept.id);
  });

  it('DX-509 · en su hora no cambia: notas y salida sin atención (cancelar)', async () => {
    // (Pasar al sillón lo cubre el spec unitario: aquí el reloj de la
    // agenda va fijado al futuro y la hora del sillón es la real.)
    const a = await overbookedAt('17:00');
    await book('17:00', '17:30').expect(201);
    await patch(a.id, { notes: 'Viene con su madre' }).expect(200);
    expect(await overbookedInDb(a.id)).toBe(true);
    expect((await agendaRow(a.id)).overbooked).toBe(true);
    await patch(a.id, {
      status: 'CANCELLED',
      cancelledByKind: 'STAFF_FOR_PATIENT',
      cancelReasonCode: 'ILLNESS',
    }).expect(200);
    expect(await overbookedInDb(a.id)).toBe(true);
    expect(await reasonsOf(a.id)).not.toContain('WALK_IN_OVERBOOK_CLEARED');
  });

  it('DX-509 · la BD: un UPDATE no enciende el sobrecupo y moverla por SQL lo apaga', async () => {
    const a = await overbookedAt('10:30');
    await expect(
      raw.appointment.update({
        where: {
          id: (
            (await book('18:30', '19:00').expect(201)).body as { id: string }
          ).id,
        },
        data: { overbooked: true, walkIn: true },
      }),
    ).rejects.toThrow(/Un sobrecupo solo nace/);
    await raw.$executeRaw`
      UPDATE "appointments" SET "start" = "start" + interval '5 hours',
                                "end" = "end" + interval '5 hours'
       WHERE "id" = ${a.id}::uuid`;
    expect(await overbookedInDb(a.id)).toBe(false);
  });

  describe('DX-510 · Idempotency-Key', () => {
    const walkIn = (
      key: string | undefined,
      body: Record<string, unknown>,
      c: Clinic = clinic,
      locationId = mainId,
      token = reception.token,
    ) => {
      const req = as(
        api().post('/api/v1/appointments/walk-in'),
        token,
        locationId,
        c.host,
      );
      return (key ? req.set('Idempotency-Key', key) : req).send(body);
    };
    const newPatient = (providerId: string) => ({
      newPatient: {
        firstName: 'Doble',
        lastName: 'Clic',
        phone: '+58 412 555 0199',
      },
      providerId,
      triageFlags: ['SWELLING'],
      overbookReason: 'Inflamación, no puede esperar',
    });

    it('cinco envíos en paralelo con la misma clave: la misma cita, un paciente y una cita', async () => {
      clockNow = local('20:00');
      const key = randomUUID();
      const patients = await raw.patient.count({
        where: { tenantId: clinic.tenantId },
      });
      const appointments = await raw.appointment.count({
        where: { tenantId: clinic.tenantId },
      });
      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          walkIn(key, newPatient(dentist.userId)),
        ),
      );
      expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const ids = new Set(responses.map((r) => (r.body as Body).id));
      expect(ids.size).toBe(1);
      expect(
        responses.filter((r) => (r.body as Body).patientCreated === true),
      ).toHaveLength(1);
      expect(
        await raw.patient.count({ where: { tenantId: clinic.tenantId } }),
      ).toBe(patients + 1);
      expect(
        await raw.appointment.count({ where: { tenantId: clinic.tenantId } }),
      ).toBe(appointments + 1);
      // Una sola alta en la auditoría.
      const [id] = [...ids];
      expect(
        (await reasonsOf(id)).filter((r) => r === 'WALK_IN_ARRIVAL'),
      ).toHaveLength(1);

      // Repetir después (reintento de red): la misma, con su motivo.
      const again = await walkIn(key, newPatient(dentist.userId)).expect(201);
      expect(again.body).toMatchObject({
        id,
        patientCreated: false,
        overbooked: true,
        overbookId: (responses[0].body as { overbookId: string }).overbookId,
      });
    });

    it('misma clave con otros datos: 422 IDEMPOTENCY_KEY_REUSED sin crear nada', async () => {
      clockNow = local('20:30');
      const key = randomUUID();
      await walkIn(key, newPatient(dentist.userId)).expect(201);
      const appointments = await raw.appointment.count({
        where: { tenantId: clinic.tenantId },
      });
      const reused = await walkIn(key, newPatient(dentist2.userId)).expect(422);
      expect(reused.body).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'Esta atención sin cita ya se registró con otros datos. Revisa «En clínica» antes de volver a intentarlo.',
      });
      expect(
        await raw.appointment.count({ where: { tenantId: clinic.tenantId } }),
      ).toBe(appointments);
    });

    it('por clínica: la misma clave en otra clínica es otra petición; clave que no es UUID, 400', async () => {
      clockNow = local('21:00');
      const key = randomUUID();
      const mine = await walkIn(key, newPatient(dentist.userId)).expect(201);
      const otherDentist = await member(other, ClinicRole.DENTIST);
      const otherReception = await member(other, ClinicRole.RECEPTION);
      const theirs = await walkIn(
        key,
        newPatient(otherDentist.userId),
        other,
        otherMainId,
        otherReception.token,
      ).expect(201);
      expect((theirs.body as { id: string }).id).not.toBe(
        (mine.body as { id: string }).id,
      );
      expect(theirs.body).toMatchObject({ patientCreated: true });

      const bad = await walkIn('doble-clic', newPatient(dentist.userId)).expect(
        400,
      );
      expect(bad.body).toMatchObject({
        message: 'La clave de idempotencia debe ser un UUID.',
      });
    });

    it('sin clave: como antes (dos envíos, dos citas)', async () => {
      clockNow = local('21:30');
      const before = await raw.appointment.count({
        where: { tenantId: clinic.tenantId },
      });
      await walkIn(undefined, newPatient(dentist.userId)).expect(201);
      await walkIn(undefined, newPatient(dentist.userId)).expect(201);
      expect(
        await raw.appointment.count({ where: { tenantId: clinic.tenantId } }),
      ).toBe(before + 2);
    });
  });
});
