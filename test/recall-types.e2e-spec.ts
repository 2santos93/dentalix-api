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

/**
 * DX-015-bis (porción 2) · Ajustes › Recall por HTTP real con Postgres: el
 * CRUD de tipos de recall (solo ADMIN, como los tipos de cita), los
 * disparadores (`PUT /recall-types/:id/triggers`), los 400/409/422 en
 * español, que retirar un tipo lo saca de la ficha, que cambiar el intervalo
 * por defecto no mueve los recalls que ya existen, y el `audit_event`
 * RECALL_TYPE de cada escritura (D14), en la transacción del cambio.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface TypeBody {
  id: string;
  name: string;
  defaultIntervalMonths: number;
  active: boolean;
  sortOrder: number;
  systemKey: string | null;
  exclusionGroup: string | null;
  appointmentTypeId: string | null;
  triggerCatalogItemIds: string[];
  triggers: { catalogItemId: string; code: string; name: string }[];
}

const messageOf = (res: { body: unknown }) =>
  JSON.stringify((res.body as { message: unknown }).message);

describe('Tipos de recall: Ajustes › Recall (DX-015-bis, e2e)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<ClinicRole, string>;

  const api = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token = clinic.adminToken,
    host = clinic.host,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);

  const list = async (token = clinic.adminToken) =>
    (await api('get', '/recall-types', token).expect(200)).body as TypeBody[];

  async function createType(
    body: Record<string, unknown> & { name: string },
  ): Promise<TypeBody> {
    const res = await api('post', '/recall-types')
      .send({ defaultIntervalMonths: 6, ...body })
      .expect(201);
    return res.body as TypeBody;
  }

  async function catalogId(code: string, c = clinic): Promise<string> {
    return (
      await raw.dentalCatalogItem.findFirstOrThrow({
        where: { tenantId: c.tenantId, code, deletedAt: null },
        select: { id: true },
      })
    ).id;
  }

  const eventsOf = (resourceId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'RECALL_TYPE',
        resourceId,
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { action: true, actorUserId: true, metadata: true },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx015bis-tipos');
    other = await registerClinic(app, 'dx015bis-tipos-otra');
    tokens.ADMIN = clinic.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
    }
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('roles', () => {
    it('los cuatro roles leen los tipos con sus disparadores (código y nombre)', async () => {
      const profilaxis = await catalogId('PREV-PROFILAXIS');
      for (const role of Object.values(ClinicRole)) {
        const types = await list(tokens[role]);
        expect(types.find((t) => t.systemKey === 'HYGIENE')).toMatchObject({
          name: 'Higiene',
          active: true,
          exclusionGroup: 'HYGIENE_PERIO',
          triggerCatalogItemIds: [profilaxis],
          triggers: [
            {
              catalogItemId: profilaxis,
              code: 'PREV-PROFILAXIS',
              name: expect.any(String) as string,
            },
          ],
        });
      }
    });

    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
      '%s no escribe (403 en español) y nada cambia',
      async (role) => {
        const [higiene] = await list();
        const token = tokens[role];
        const before = await raw.recallType.count({
          where: { tenantId: clinic.tenantId },
        });
        for (const req of [
          api('post', '/recall-types', token).send({
            name: 'Ortodoncia',
            defaultIntervalMonths: 1,
          }),
          api('patch', `/recall-types/${higiene.id}`, token).send({
            defaultIntervalMonths: 3,
          }),
          // D20: enlazar un tipo de cita también es de administración.
          api('patch', `/recall-types/${higiene.id}`, token).send({
            appointmentTypeId: '0b7d1c2e-0000-4000-8000-000000000001',
          }),
          api('delete', `/recall-types/${higiene.id}`, token),
          api('put', `/recall-types/${higiene.id}/triggers`, token).send({
            catalogItemIds: [],
          }),
        ]) {
          const res = await req.expect(403);
          expect(messageOf(res)).toContain(
            'Solo administración gestiona los tipos de recall',
          );
        }
        expect(
          await raw.recallType.count({ where: { tenantId: clinic.tenantId } }),
        ).toBe(before);
        expect((await list())[0]).toEqual(higiene);
      },
    );
  });

  describe('crear y editar', () => {
    it('ADMIN crea un tipo (activo, el último, sin disparadores) y lo audita', async () => {
      const before = await list();
      const created = await createType({
        name: '  Ortodoncia  ',
        defaultIntervalMonths: 1,
        exclusionGroup: 'ORTO',
      });
      expect(created).toMatchObject({
        name: 'Ortodoncia',
        defaultIntervalMonths: 1,
        active: true,
        systemKey: null,
        exclusionGroup: 'ORTO',
        triggerCatalogItemIds: [],
        triggers: [],
      });
      expect(created.sortOrder).toBeGreaterThan(
        Math.max(...before.map((t) => t.sortOrder)),
      );
      expect((await list()).map((t) => t.id)).toContain(created.id);
      expect(await eventsOf(created.id)).toEqual([
        {
          action: 'CREATE',
          actorUserId: clinic.adminUserId,
          metadata: {
            reason: 'RECALL_TYPE_CREATED',
            configChange: {
              after: {
                name: 'Ortodoncia',
                defaultIntervalMonths: 1,
                active: true,
                sortOrder: created.sortOrder,
                exclusionGroup: 'ORTO',
                appointmentTypeId: null,
              },
            },
          },
        },
      ]);
    });

    it.each([
      [
        { defaultIntervalMonths: 0 },
        'El intervalo por defecto va de 1 a 36 meses',
      ],
      [
        { defaultIntervalMonths: 37 },
        'El intervalo por defecto va de 1 a 36 meses',
      ],
      [{ name: '   ' }, 'El nombre no puede estar vacío'],
      [{ name: 'x'.repeat(61) }, 'no puede tener más de 60'],
      [{ exclusionGroup: 'higiene' }, 'grupo de exclusión admite'],
      [{ exclusionGroup: 'X'.repeat(41) }, 'grupo de exclusión admite'],
      [{ sortOrder: -1 }, 'El orden va de 0 a 9999'],
    ])('valida %j con 400 en español', async (override, message) => {
      const res = await api('post', '/recall-types')
        .send({ name: 'Inválido', defaultIntervalMonths: 6, ...override })
        .expect(400);
      expect(messageOf(res)).toContain(message);
    });

    it.each([
      [{ name: null }, 'El nombre no puede estar vacío'],
      [
        { defaultIntervalMonths: null },
        'El intervalo por defecto va de 1 a 36',
      ],
      [{ active: null }, 'El campo «activo» debe ser verdadero o falso.'],
      [{ sortOrder: null }, 'El orden va de 0 a 9999'],
    ])(
      'PATCH %j: null solo vale en exclusionGroup (400, nada cambia)',
      async (body, message) => {
        const [higiene] = await list();
        const res = await api('patch', `/recall-types/${higiene.id}`)
          .send(body)
          .expect(400);
        expect(messageOf(res)).toContain(message);
        expect((await list())[0]).toEqual(higiene);
      },
    );

    it('nombre repetido entre los vivos, sin distinguir mayúsculas ni espacios: 409, al crear y al renombrar', async () => {
      const res = await api('post', '/recall-types')
        .send({ name: '  HIGIENE ', defaultIntervalMonths: 6 })
        .expect(409);
      expect(messageOf(res)).toContain(
        'Ya existe un tipo de recall con ese nombre.',
      );
      const blanqueamiento = await createType({ name: 'Blanqueamiento' });
      await api('patch', `/recall-types/${blanqueamiento.id}`)
        .send({ name: 'mantenimiento periodontal' })
        .expect(409);
    });

    it('editar cualquier campo (también un tipo del sistema); null quita el grupo; el diff va a la auditoría', async () => {
      const [higiene] = await list();
      const patched = (
        await api('patch', `/recall-types/${higiene.id}`)
          .send({ name: 'Higiene y profilaxis', exclusionGroup: null })
          .expect(200)
      ).body as TypeBody;
      expect(patched).toMatchObject({
        name: 'Higiene y profilaxis',
        exclusionGroup: null,
        systemKey: 'HYGIENE',
      });
      // Sin cambios, sin evento.
      await api('patch', `/recall-types/${higiene.id}`)
        .send({ name: 'Higiene y profilaxis' })
        .expect(200);
      await api('patch', `/recall-types/${higiene.id}`)
        .send({ name: 'Higiene', exclusionGroup: 'HYGIENE_PERIO' })
        .expect(200);
      expect(await eventsOf(higiene.id)).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          metadata: {
            reason: 'RECALL_TYPE_UPDATED',
            changedFields: ['exclusionGroup', 'name'],
            configChange: {
              before: { exclusionGroup: 'HYGIENE_PERIO', name: 'Higiene' },
              after: { exclusionGroup: null, name: 'Higiene y profilaxis' },
            },
          },
        }),
        expect.objectContaining({
          action: 'UPDATE',
          metadata: expect.objectContaining({
            changedFields: ['exclusionGroup', 'name'],
          }) as object,
        }),
      ]);
    });

    it('cambiar el intervalo por defecto NO mueve los recalls que ya existen', async () => {
      const [, control] = await list();
      const patientId = (
        await raw.patient.create({
          data: {
            tenantId: clinic.tenantId,
            firstName: 'Intervalo',
            lastName: 'Fijo',
          },
        })
      ).id;
      await api(
        'put',
        `/patients/${patientId}/recalls/${control.id}`,
        tokens.DENTIST,
      )
        .send({ intervalMonths: 12, lastDoneAt: '2026-01-15' })
        .expect(200);
      await api('patch', `/recall-types/${control.id}`)
        .send({ defaultIntervalMonths: 24 })
        .expect(200);
      const recall = await raw.patientRecall.findFirstOrThrow({
        where: { patientId, recallTypeId: control.id },
      });
      expect(recall).toMatchObject({
        intervalMonths: 12,
        dueAt: new Date('2027-01-15T00:00:00.000Z'),
      });
      await api('patch', `/recall-types/${control.id}`)
        .send({ defaultIntervalMonths: 12 })
        .expect(200);
    });
  });

  describe('retirar', () => {
    it('un tipo de la clínica se retira (204): sale de la lista y de la ficha, se audita y su nombre queda libre', async () => {
      const blanqueamiento = await createType({
        name: 'Sellantes',
        defaultIntervalMonths: 12,
      });
      const patientId = (
        await raw.patient.create({
          data: {
            tenantId: clinic.tenantId,
            firstName: 'Retirado',
            lastName: 'Tipo',
          },
        })
      ).id;
      await api(
        'put',
        `/patients/${patientId}/recalls/${blanqueamiento.id}`,
        tokens.DENTIST,
      )
        .send({ intervalMonths: 12 })
        .expect(200);

      // La lista de salida (checkout) lo ve antes de retirarlo...
      const location = await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId },
        select: { id: true },
      });
      const start = new Date(Date.now() - 60 * 60_000);
      const appointment = await raw.appointment.create({
        data: {
          tenantId: clinic.tenantId,
          patientId,
          locationId: location.id,
          providerId: clinic.adminUserId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
          status: 'SCHEDULED',
        },
        select: { id: true },
      });
      const checklist = async () =>
        (
          (
            await api(
              'get',
              `/appointments/${appointment.id}/checkout-checklist`,
            ).expect(200)
          ).body as { recallDueOn: string | null }
        ).recallDueOn;
      expect(await checklist()).toEqual(expect.any(String));

      await api('delete', `/recall-types/${blanqueamiento.id}`).expect(204);
      // ...y deja de verlo después, como la lista y la ficha.
      expect(await checklist()).toBeNull();
      expect((await list()).map((t) => t.id)).not.toContain(blanqueamiento.id);
      const ficha = (
        await api(
          'get',
          `/patients/${patientId}/recalls`,
          tokens.RECEPTION,
        ).expect(200)
      ).body as { recalls: unknown[] };
      expect(ficha.recalls).toEqual([]);
      // La fila del recall se conserva.
      expect(
        await raw.patientRecall.count({
          where: { patientId, recallTypeId: blanqueamiento.id },
        }),
      ).toBe(1);
      // Ya no existe: ni editarlo ni fijar un recall con él.
      await api('patch', `/recall-types/${blanqueamiento.id}`)
        .send({ name: 'Otro' })
        .expect(404);
      await api(
        'put',
        `/patients/${patientId}/recalls/${blanqueamiento.id}`,
        tokens.DENTIST,
      )
        .send({ intervalMonths: 12 })
        .expect(404);
      expect(
        (await eventsOf(blanqueamiento.id)).map((e) => e.metadata),
      ).toEqual([
        expect.objectContaining({ reason: 'RECALL_TYPE_CREATED' }),
        {
          reason: 'RECALL_TYPE_DELETED',
          configChange: {
            before: expect.objectContaining({ name: 'Sellantes' }) as object,
          },
        },
      ]);
      await createType({ name: 'SELLANTES' });
    });

    it('Higiene y Control (con systemKey) no se retiran: 409; se desactivan', async () => {
      for (const type of (await list()).filter((t) => t.systemKey !== null)) {
        const res = await api('delete', `/recall-types/${type.id}`).expect(409);
        expect(messageOf(res)).toContain(
          'no se puede retirar, solo desactivar',
        );
      }
      const [higiene] = await list();
      await api('patch', `/recall-types/${higiene.id}`)
        .send({ active: false })
        .expect(200);
      expect((await list())[0]).toMatchObject({
        id: higiene.id,
        active: false,
      });
      await api('patch', `/recall-types/${higiene.id}`)
        .send({ active: true })
        .expect(200);
    });
  });

  describe('disparadores', () => {
    it('PUT reemplaza el conjunto (un procedimiento dispara varios tipos) y lo audita con el antes y el después', async () => {
      const tipo = await createType({
        name: 'Periodoncia',
        defaultIntervalMonths: 4,
      });
      const raspado = await catalogId('PERIO-RASPADO');
      const mantenimiento = await catalogId('PERIO-MANTENIMIENTO');
      const set = async (ids: string[]) =>
        (
          await api('put', `/recall-types/${tipo.id}/triggers`)
            .send({ catalogItemIds: ids })
            .expect(200)
        ).body as TypeBody;

      const first = await set([raspado, mantenimiento, raspado]);
      expect(first.triggerCatalogItemIds).toEqual(
        [raspado, mantenimiento].sort(),
      );
      expect(first.triggers.map((t) => t.code).sort()).toEqual([
        'PERIO-MANTENIMIENTO',
        'PERIO-RASPADO',
      ]);
      // El mismo raspado sigue disparando Mantenimiento periodontal.
      const perio = (await list()).find(
        (t) => t.name === 'Mantenimiento periodontal',
      );
      expect(perio?.triggerCatalogItemIds).toContain(raspado);

      // Sin cambios, sin evento; [] los quita todos.
      await set([mantenimiento, raspado]);
      const cleared = await set([]);
      expect(cleared.triggers).toEqual([]);
      const events = (await eventsOf(tipo.id)).filter(
        (e) =>
          (e.metadata as { reason?: string }).reason ===
          'RECALL_TYPE_TRIGGERS_UPDATED',
      );
      expect(events.map((e) => e.metadata)).toEqual([
        {
          reason: 'RECALL_TYPE_TRIGGERS_UPDATED',
          changedFields: ['catalogItemIds'],
          configChange: {
            before: { catalogItemIds: [] },
            after: { catalogItemIds: [raspado, mantenimiento].sort() },
          },
        },
        {
          reason: 'RECALL_TYPE_TRIGGERS_UPDATED',
          changedFields: ['catalogItemIds'],
          configChange: {
            before: { catalogItemIds: [raspado, mantenimiento].sort() },
            after: { catalogItemIds: [] },
          },
        },
      ]);
    });

    it('422 si algún id no es un procedimiento vivo de la clínica (de otra clínica, un diagnóstico o retirado), sin cambiar nada', async () => {
      const tipo = await createType({
        name: 'Implantes',
        defaultIntervalMonths: 12,
      });
      const own = await catalogId('PERIO-RASPADO');
      await api('put', `/recall-types/${tipo.id}/triggers`)
        .send({ catalogItemIds: [own] })
        .expect(200);
      const diagnosis = await raw.dentalCatalogItem.findFirstOrThrow({
        where: {
          tenantId: clinic.tenantId,
          kind: 'DIAGNOSIS',
          deletedAt: null,
        },
        select: { id: true },
      });
      const retired = await raw.dentalCatalogItem.create({
        data: {
          tenantId: clinic.tenantId,
          code: 'DX015BIS-RETIRADO',
          kind: 'PROCEDURE',
          labelEs: 'Procedimiento retirado',
          color: '#0E7490',
          deletedAt: new Date(),
        },
        select: { id: true },
      });
      for (const bad of [
        await catalogId('PERIO-RASPADO', other),
        diagnosis.id,
        retired.id,
        '0b7d1c2e-0000-4000-8000-000000000000',
      ]) {
        const res = await api('put', `/recall-types/${tipo.id}/triggers`)
          .send({ catalogItemIds: [own, bad] })
          .expect(422);
        expect(messageOf(res)).toContain(
          'Hay procedimientos que no existen en el catálogo de esta clínica o están retirados.',
        );
      }
      expect(
        (await list()).find((t) => t.id === tipo.id)?.triggerCatalogItemIds,
      ).toEqual([own]);
    });

    it('un disparador que el tipo ya tenía se conserva aunque se retire del catálogo después', async () => {
      const tipo = await createType({
        name: 'Cirugía',
        defaultIntervalMonths: 6,
      });
      const item = await raw.dentalCatalogItem.create({
        data: {
          tenantId: clinic.tenantId,
          code: 'DX015BIS-CIRUGIA',
          kind: 'PROCEDURE',
          labelEs: 'Cirugía menor',
          color: '#0E7490',
        },
        select: { id: true },
      });
      await api('put', `/recall-types/${tipo.id}/triggers`)
        .send({ catalogItemIds: [item.id] })
        .expect(200);
      await raw.dentalCatalogItem.update({
        where: { id: item.id },
        data: { deletedAt: new Date() },
      });
      const kept = (
        await api('put', `/recall-types/${tipo.id}/triggers`)
          .send({ catalogItemIds: [item.id] })
          .expect(200)
      ).body as TypeBody;
      expect(kept.triggers).toEqual([
        {
          catalogItemId: item.id,
          code: 'DX015BIS-CIRUGIA',
          name: 'Cirugía menor',
        },
      ]);
    });

    it('400 si un id no es un uuid o hay más de 50', async () => {
      const [higiene] = await list();
      await api('put', `/recall-types/${higiene.id}/triggers`)
        .send({ catalogItemIds: ['no-es-un-id'] })
        .expect(400);
      const many = Array.from(
        { length: 51 },
        (_, i) => `0b7d1c2e-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
      const res = await api('put', `/recall-types/${higiene.id}/triggers`)
        .send({ catalogItemIds: many })
        .expect(400);
      expect(messageOf(res)).toContain('hasta 50 procedimientos');
    });
  });

  describe('tipo de cita al agendar (D20)', () => {
    async function appointmentType(
      name: string,
      c: Clinic = clinic,
    ): Promise<string> {
      const res = await api('post', '/appointment-types', c.adminToken, c.host)
        .send({ name, durationMinutes: 45, color: '#16A34A' })
        .expect(201);
      return (res.body as { id: string }).id;
    }

    it('una clínica nueva no trae enlaces', async () => {
      for (const t of await list()) expect(t.appointmentTypeId).toBeNull();
    });

    it('crear con uno, cambiarlo, leerlo y quitarlo con null; cada cambio va a la auditoría', async () => {
      const limpieza = await appointmentType('Limpieza D20');
      const valoracion = await appointmentType('Valoración D20');
      const created = await createType({
        name: 'Blanqueamiento D20',
        appointmentTypeId: limpieza,
      });
      expect(created.appointmentTypeId).toBe(limpieza);

      const changed = (
        await api('patch', `/recall-types/${created.id}`)
          .send({ appointmentTypeId: valoracion })
          .expect(200)
      ).body as TypeBody;
      expect(changed.appointmentTypeId).toBe(valoracion);
      expect(
        (await list()).find((t) => t.id === created.id)?.appointmentTypeId,
      ).toBe(valoracion);

      // Ausente no lo toca.
      const renamed = (
        await api('patch', `/recall-types/${created.id}`)
          .send({ sortOrder: 7 })
          .expect(200)
      ).body as TypeBody;
      expect(renamed.appointmentTypeId).toBe(valoracion);

      const cleared = (
        await api('patch', `/recall-types/${created.id}`)
          .send({ appointmentTypeId: null })
          .expect(200)
      ).body as TypeBody;
      expect(cleared.appointmentTypeId).toBeNull();

      const events = await eventsOf(created.id);
      expect(events[0].metadata).toMatchObject({
        reason: 'RECALL_TYPE_CREATED',
        configChange: { after: { appointmentTypeId: limpieza } },
      });
      expect(
        events
          .slice(1)
          .map(
            (e) => (e.metadata as { changedFields: string[] }).changedFields,
          ),
      ).toEqual([['appointmentTypeId'], ['sortOrder'], ['appointmentTypeId']]);
      expect(events[3].metadata).toMatchObject({
        configChange: {
          before: { appointmentTypeId: valoracion },
          after: { appointmentTypeId: null },
        },
      });
    });

    it('422 en español si no existe, es de otra clínica, está desactivado o retirado; nada cambia', async () => {
      const [higiene] = await list();
      const inactive = await appointmentType('Desactivado D20');
      await api('patch', `/appointment-types/${inactive}`)
        .send({ active: false })
        .expect(200);
      const retired = await appointmentType('Retirado D20');
      await api('delete', `/appointment-types/${retired}`).expect(204);
      const foreign = await appointmentType('Ajeno D20', other);
      const before = await eventsOf(higiene.id);
      for (const id of [
        '0b7d1c2e-0000-4000-8000-000000000999',
        foreign,
        inactive,
        retired,
      ]) {
        const res = await api('patch', `/recall-types/${higiene.id}`)
          .send({ appointmentTypeId: id, name: 'No cambia' })
          .expect(422);
        expect(messageOf(res)).toContain(
          'Ese tipo de cita no existe en esta clínica, está retirado o desactivado',
        );
        await api('post', '/recall-types')
          .send({
            name: 'Nunca creado D20',
            defaultIntervalMonths: 6,
            appointmentTypeId: id,
          })
          .expect(422);
      }
      expect((await list()).find((t) => t.id === higiene.id)).toEqual(higiene);
      expect((await list()).some((t) => t.name === 'Nunca creado D20')).toBe(
        false,
      );
      expect(await eventsOf(higiene.id)).toEqual(before);
    });

    it('400 si no es un uuid', async () => {
      const [higiene] = await list();
      const res = await api('patch', `/recall-types/${higiene.id}`)
        .send({ appointmentTypeId: 'no-es-un-id' })
        .expect(400);
      expect(messageOf(res)).toContain(
        'appointmentTypeId debe ser el id de un tipo de cita',
      );
    });

    it('el enlace guardado se devuelve aunque el tipo de cita se desactive después, y se puede conservar al editar', async () => {
      const cita = await appointmentType('Control D20');
      const type = await createType({
        name: 'Control anual D20',
        appointmentTypeId: cita,
      });
      await api('patch', `/appointment-types/${cita}`)
        .send({ active: false })
        .expect(200);
      expect(
        (await list()).find((t) => t.id === type.id)?.appointmentTypeId,
      ).toBe(cita);
      const kept = (
        await api('patch', `/recall-types/${type.id}`)
          .send({ name: 'Control anual D20 bis', appointmentTypeId: cita })
          .expect(200)
      ).body as TypeBody;
      expect(kept).toMatchObject({
        name: 'Control anual D20 bis',
        appointmentTypeId: cita,
      });
    });
  });

  it('un tipo de otra clínica no existe aquí (404) en PATCH, DELETE y PUT de disparadores', async () => {
    const foreign = (
      (
        await api('get', '/recall-types', other.adminToken, other.host).expect(
          200,
        )
      ).body as TypeBody[]
    ).find((t) => t.name === 'Mantenimiento periodontal')!;
    await api('patch', `/recall-types/${foreign.id}`)
      .send({ name: 'Robado' })
      .expect(404);
    await api('delete', `/recall-types/${foreign.id}`).expect(404);
    await api('put', `/recall-types/${foreign.id}/triggers`)
      .send({ catalogItemIds: [] })
      .expect(404);
    const after = await raw.recallType.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { name: true, deletedAt: true },
    });
    expect(after).toEqual({
      name: 'Mantenimiento periodontal',
      deletedAt: null,
    });
  });
});
