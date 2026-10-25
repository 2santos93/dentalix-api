import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { SAMPLE_POSTOP_TEMPLATES } from '../src/modules/post-op-instructions/domain/sample-templates';
import {
  POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE,
  POSTOP_CATALOG_ITEM_INVALID_MESSAGE,
  POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE,
} from '../src/modules/post-op-instructions/domain/ports/post-op-template-repository.port';
import { POSTOP_TEMPLATE_NOT_FOUND_MESSAGE } from '../src/modules/post-op-instructions/application/use-cases/post-op-templates.use-cases';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// DX-222 en HTTP real: plantillas de indicaciones postoperatorias (solo ADMIN
// escribe, los cuatro roles leen), versión al cambiar el texto, vínculos a
// procedimientos del catálogo y a tipos de cita validados en la clínica,
// plantillas de ejemplo idempotentes, aislamiento entre clínicas y el
// teléfono de la sede que usa la variable {{telefono_sede}}.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface TemplateBody {
  id: string;
  code: string;
  title: string;
  body: string;
  version: number;
  active: boolean;
  catalogItems: Array<{ id: string; code: string; labelEs: string }>;
  appointmentTypes: Array<{ id: string; name: string }>;
  createdAt: string;
  updatedAt: string;
}

const EXO_BODY =
  'Hola {{paciente}}: muerde la gasa 30 minutos. Dudas: {{clinica}}, {{telefono_sede}}.';

describe('Plantillas de indicaciones postoperatorias (e2e, DX-222)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: string;
  let assistant: string;
  let reception: string;
  let procedureId: string;
  let diagnosisId: string;
  let appointmentTypeId: string;
  let otherClinicProcedureId: string;
  let exo: TemplateBody;
  let otherTemplate: TemplateBody;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function catalogItem(
    c: Clinic,
    code: string,
    kind: CatalogKind,
  ): Promise<string> {
    const res = await as(
      api().post('/api/v1/catalog/items'),
      c.adminToken,
      c.host,
    )
      .send({ code, kind, labelEs: `Ítem ${code}`, color: '#2A2B3C' })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  async function auditCount(action: 'CREATE' | 'UPDATE'): Promise<number> {
    return raw.auditEvent.count({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'POSTOP_TEMPLATE',
        action,
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx222-e2e');
    other = await registerClinic(app, 'dx222-e2e-otra');
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const m = await seedMember(raw, clinic, role);
      const token = await loginAs(app, clinic.host, m.email);
      if (role === ClinicRole.DENTIST) dentist = token;
      if (role === ClinicRole.ASSISTANT) assistant = token;
      if (role === ClinicRole.RECEPTION) reception = token;
    }
    procedureId = await catalogItem(clinic, 'EXO-222', CatalogKind.PROCEDURE);
    diagnosisId = await catalogItem(
      clinic,
      'CARIES-222',
      CatalogKind.DIAGNOSIS,
    );
    otherClinicProcedureId = await catalogItem(
      other,
      'EXO-B',
      CatalogKind.PROCEDURE,
    );
    const type = await as(
      api().post('/api/v1/appointment-types'),
      clinic.adminToken,
    )
      .send({ name: 'Cirugía oral', durationMinutes: 60, color: '#0E7490' })
      .expect(201);
    appointmentTypeId = (type.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('CRUD por rol', () => {
    it('ADMIN crea POI-EXO vinculada a un procedimiento y a un tipo de cita (auditado)', async () => {
      const res = await as(
        api().post('/api/v1/post-op-templates'),
        clinic.adminToken,
      )
        .send({
          code: 'poi-exo',
          title: 'Exodoncia simple',
          body: EXO_BODY,
          catalogItemIds: [procedureId],
          appointmentTypeIds: [appointmentTypeId],
          // Campos que el cliente no pone: se descartan.
          version: 9,
          tenantId: other.tenantId,
        })
        .expect(201);
      exo = res.body as TemplateBody;

      expect(exo).toMatchObject({
        code: 'POI-EXO',
        title: 'Exodoncia simple',
        body: EXO_BODY,
        version: 1,
        active: true,
        catalogItems: [
          { id: procedureId, code: 'EXO-222', labelEs: 'Ítem EXO-222' },
        ],
        appointmentTypes: [{ id: appointmentTypeId, name: 'Cirugía oral' }],
      });
      expect(Object.keys(exo).sort()).toEqual(
        [
          'id',
          'code',
          'title',
          'body',
          'version',
          'active',
          'catalogItems',
          'appointmentTypes',
          'createdAt',
          'updatedAt',
        ].sort(),
      );
      const row = await raw.postOpInstructionTemplate.findUniqueOrThrow({
        where: { id: exo.id },
      });
      expect(row.tenantId).toBe(clinic.tenantId);
      expect(row.createdById).toBe(clinic.adminUserId);

      expect(await auditCount('CREATE')).toBe(1);
      const event = await raw.auditEvent.findFirstOrThrow({
        where: { tenantId: clinic.tenantId, resourceType: 'POSTOP_TEMPLATE' },
      });
      expect(event.resourceId).toBe(exo.id);
      expect(JSON.stringify(event.metadata)).not.toContain('muerde la gasa');
    });

    it('DENTIST, ASSISTANT y RECEPTION leen la lista pero no escriben', async () => {
      for (const token of [dentist, assistant, reception]) {
        const list = await as(
          api().get('/api/v1/post-op-templates'),
          token,
        ).expect(200);
        expect((list.body as TemplateBody[]).map((t) => t.code)).toEqual([
          'POI-EXO',
        ]);
        await as(api().post('/api/v1/post-op-templates'), token)
          .send({ code: 'POI-X', title: 'X', body: 'x' })
          .expect(403);
        await as(api().patch(`/api/v1/post-op-templates/${exo.id}`), token)
          .send({ active: false })
          .expect(403);
        await as(api().post('/api/v1/post-op-templates/samples'), token)
          .send({})
          .expect(403);
      }
    });

    it('PATCH del texto deja la versión 2; PATCH `active:false` no la cambia', async () => {
      const edited = await as(
        api().patch(`/api/v1/post-op-templates/${exo.id}`),
        clinic.adminToken,
      )
        .send({ body: `${EXO_BODY} No fumes.` })
        .expect(200);
      expect(edited.body as TemplateBody).toMatchObject({
        version: 2,
        body: `${EXO_BODY} No fumes.`,
        catalogItems: [{ id: procedureId }],
        appointmentTypes: [{ id: appointmentTypeId }],
      });

      const off = await as(
        api().patch(`/api/v1/post-op-templates/${exo.id}`),
        clinic.adminToken,
      )
        .send({ active: false })
        .expect(200);
      expect(off.body as TemplateBody).toMatchObject({
        active: false,
        version: 2,
      });

      const active = await as(
        api().get('/api/v1/post-op-templates?active=true'),
        clinic.adminToken,
      ).expect(200);
      expect(active.body).toEqual([]);
      const inactive = await as(
        api().get('/api/v1/post-op-templates?active=false'),
        clinic.adminToken,
      ).expect(200);
      expect((inactive.body as TemplateBody[]).map((t) => t.id)).toEqual([
        exo.id,
      ]);
      expect(await auditCount('UPDATE')).toBe(2);
    });

    it('`?active` distinto de true/false responde 400', async () => {
      const res = await as(
        api().get('/api/v1/post-op-templates?active=foo'),
        clinic.adminToken,
      ).expect(400);
      expect(JSON.stringify(res.body)).toContain(
        'active debe ser true o false.',
      );
    });

    it('los vínculos se reemplazan completos; `code` no se edita', async () => {
      const res = await as(
        api().patch(`/api/v1/post-op-templates/${exo.id}`),
        clinic.adminToken,
      )
        .send({ appointmentTypeIds: [], code: 'POI-OTRO', active: true })
        .expect(200);
      expect(res.body as TemplateBody).toMatchObject({
        code: 'POI-EXO',
        active: true,
        version: 2,
        catalogItems: [{ id: procedureId }],
        appointmentTypes: [],
      });
      expect(
        await raw.postOpInstructionTemplateLink.count({
          where: { templateId: exo.id },
        }),
      ).toBe(1);
    });

    it('código duplicado 409; variables desconocidas 400', async () => {
      const dup = await as(
        api().post('/api/v1/post-op-templates'),
        clinic.adminToken,
      )
        .send({ code: 'POI-EXO', title: 'Otra', body: 'x' })
        .expect(409);
      expect((dup.body as { message: string }).message).toBe(
        POSTOP_TEMPLATE_DUPLICATE_CODE_MESSAGE,
      );

      const bad = await as(
        api().post('/api/v1/post-op-templates'),
        clinic.adminToken,
      )
        .send({ code: 'POI-MALA', title: 'Mala', body: 'Hola {{edad}}' })
        .expect(400);
      expect((bad.body as { message: string }).message).toBe(
        'Variables no admitidas: {{edad}}',
      );
    });

    it('un ítem que no es PROCEDURE, de otra clínica o un tipo de cita ajeno dan 400', async () => {
      for (const catalogItemIds of [[diagnosisId], [otherClinicProcedureId]]) {
        const res = await as(
          api().post('/api/v1/post-op-templates'),
          clinic.adminToken,
        )
          .send({ code: 'POI-LINK', title: 'X', body: 'x', catalogItemIds })
          .expect(400);
        expect((res.body as { message: string }).message).toBe(
          POSTOP_CATALOG_ITEM_INVALID_MESSAGE,
        );
      }
      const res = await as(
        api().patch(`/api/v1/post-op-templates/${exo.id}`),
        clinic.adminToken,
      )
        .send({ appointmentTypeIds: [procedureId] })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        POSTOP_APPOINTMENT_TYPE_INVALID_MESSAGE,
      );
      expect(
        await raw.postOpInstructionTemplate.count({
          where: { code: 'POI-LINK' },
        }),
      ).toBe(0);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B no ve ni edita la plantilla de A (404)', async () => {
      otherTemplate = (
        await as(
          api().post('/api/v1/post-op-templates'),
          other.adminToken,
          other.host,
        )
          .send({ code: 'POI-EXO', title: 'De B', body: 'B {{paciente}}' })
          .expect(201)
      ).body as TemplateBody;

      const list = await as(
        api().get('/api/v1/post-op-templates'),
        other.adminToken,
        other.host,
      ).expect(200);
      expect((list.body as TemplateBody[]).map((t) => t.id)).toEqual([
        otherTemplate.id,
      ]);

      const res = await as(
        api().patch(`/api/v1/post-op-templates/${exo.id}`),
        other.adminToken,
        other.host,
      )
        .send({ active: false })
        .expect(404);
      expect((res.body as { message: string }).message).toBe(
        POSTOP_TEMPLATE_NOT_FOUND_MESSAGE,
      );
      const row = await raw.postOpInstructionTemplate.findUniqueOrThrow({
        where: { id: exo.id },
      });
      expect(row.active).toBe(true);
    });
  });

  describe('plantillas de ejemplo', () => {
    it('crean las que faltan por código y la segunda vez ninguna (auditado)', async () => {
      const before = await auditCount('CREATE');
      const first = await as(
        api().post('/api/v1/post-op-templates/samples'),
        other.adminToken,
        other.host,
      ).expect(201);
      // B ya tiene POI-EXO propia: no se pisa.
      expect((first.body as TemplateBody[]).map((t) => t.code).sort()).toEqual(
        SAMPLE_POSTOP_TEMPLATES.map((t) => t.code)
          .filter((code) => code !== 'POI-EXO')
          .sort(),
      );

      const fresh = await registerClinic(app, 'dx222-e2e-ejemplos');
      const created = await as(
        api().post('/api/v1/post-op-templates/samples'),
        fresh.adminToken,
        fresh.host,
      ).expect(201);
      expect(created.body as TemplateBody[]).toHaveLength(5);
      const again = await as(
        api().post('/api/v1/post-op-templates/samples'),
        fresh.adminToken,
        fresh.host,
      ).expect(201);
      expect(again.body).toEqual([]);
      expect(
        await raw.postOpInstructionTemplate.count({
          where: { tenantId: fresh.tenantId },
        }),
      ).toBe(5);
      expect(
        await raw.auditEvent.count({
          where: {
            tenantId: fresh.tenantId,
            resourceType: 'POSTOP_TEMPLATE',
            action: 'CREATE',
          },
        }),
      ).toBe(2);
      // Los de la clínica A no cambian.
      expect(await auditCount('CREATE')).toBe(before);
    });
  });

  describe('teléfono de la sede', () => {
    it('PATCH de `phone` lo guarda y lo devuelve; vacío lo quita', async () => {
      const list = await as(
        api().get('/api/v1/locations'),
        clinic.adminToken,
      ).expect(200);
      const [location] = list.body as Array<{ id: string; phone: unknown }>;
      expect(location.phone).toBeNull();

      const res = await as(
        api().patch(`/api/v1/locations/${location.id}`),
        clinic.adminToken,
      )
        .send({ phone: ' +57 601 555 0101 ' })
        .expect(200);
      expect((res.body as { phone: string }).phone).toBe('+57 601 555 0101');
      const again = await as(api().get('/api/v1/locations'), reception).expect(
        200,
      );
      expect((again.body as Array<{ phone: string }>)[0].phone).toBe(
        '+57 601 555 0101',
      );

      const tooLong = await as(
        api().patch(`/api/v1/locations/${location.id}`),
        clinic.adminToken,
      )
        .send({ phone: '1'.repeat(41) })
        .expect(400);
      expect(JSON.stringify(tooLong.body)).toContain(
        'El teléfono admite hasta 40 caracteres.',
      );

      const cleared = await as(
        api().patch(`/api/v1/locations/${location.id}`),
        clinic.adminToken,
      )
        .send({ phone: '' })
        .expect(200);
      expect((cleared.body as { phone: unknown }).phone).toBeNull();
    });

    it('POST /locations acepta el teléfono al crear la sede', async () => {
      const res = await as(api().post('/api/v1/locations'), clinic.adminToken)
        .send({ name: 'Sede Sur', phone: '601 222 3333' })
        .expect(201);
      expect((res.body as { phone: string }).phone).toBe('601 222 3333');
    });
  });
});
