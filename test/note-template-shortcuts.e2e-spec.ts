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

// DX-455 en HTTP real: atajo de las plantillas de evolución (409 en español
// por duplicado sin distinguir mayúsculas y por prefijo, poner y quitar) y
// plantilla sugerida por procedimiento del catálogo (ligar, desligar, una
// desactivada no se liga ni se sugiere, aislamiento entre clínicas), con su
// auditoría.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface TemplateBody {
  id: string;
  name: string;
  shortcut: string | null;
  active: boolean;
  version: number;
}

interface CatalogItemBody {
  id: string;
  code: string;
  kind: 'DIAGNOSIS' | 'PROCEDURE';
  clinicalNoteTemplateId: string | null;
  suggestedClinicalNoteTemplateId: string | null;
}

interface ErrorBody {
  message: string | string[];
  code?: string;
}

describe('Atajos de plantillas y plantilla por procedimiento (e2e, DX-455)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: string;
  let resin: TemplateBody;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  const templateBody = (name: string, shortcut?: string | null) => ({
    name,
    body: `${name}: texto fijo`,
    prompts: [],
    ...(shortcut !== undefined ? { shortcut } : {}),
  });

  async function createTemplate(
    name: string,
    shortcut?: string | null,
    c: Clinic = clinic,
  ): Promise<TemplateBody> {
    const res = await as(
      api().post('/api/v1/clinical-note-templates'),
      c.adminToken,
      c.host,
    )
      .send(templateBody(name, shortcut))
      .expect(201);
    return res.body as TemplateBody;
  }

  async function patchTemplate(
    t: TemplateBody,
    body: object,
    status = 200,
  ): Promise<request.Response> {
    return as(
      api().patch(`/api/v1/clinical-note-templates/${t.id}`),
      clinic.adminToken,
    )
      .send({ version: t.version, ...body })
      .expect(status);
  }

  async function createProcedure(
    code: string,
    extra: object = {},
    c: Clinic = clinic,
    status = 201,
  ): Promise<request.Response> {
    return as(api().post('/api/v1/catalog/items'), c.adminToken, c.host)
      .send({
        code,
        kind: 'PROCEDURE',
        labelEs: `Procedimiento ${code}`,
        color: '#123456',
        ...extra,
      })
      .expect(status);
  }

  async function lastAuditFields(
    resourceType: 'CLINICAL_NOTE_TEMPLATE' | 'DENTAL_CATALOG_ITEM',
    resourceId: string,
  ): Promise<string[]> {
    const event = await raw.auditEvent.findFirst({
      where: {
        tenantId: clinic.tenantId,
        resourceType,
        resourceId,
        action: 'UPDATE',
      },
      orderBy: { occurredAt: 'desc' },
    });
    return (
      (event?.metadata as { changedFields?: string[] } | null)?.changedFields ??
      []
    );
  }

  const messageOf = (res: request.Response) => (res.body as ErrorBody).message;

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx455-e2e');
    other = await registerClinic(app, 'dx455-e2e-otra');
    const d = await seedMember(raw, clinic, ClinicRole.DENTIST);
    dentist = await loginAs(app, clinic.host, d.email);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('atajo de la plantilla', () => {
    it('ADMIN crea «Resina compuesta» con #resina; la lista y el detalle lo traen', async () => {
      resin = await createTemplate('Resina compuesta', ' #resina ');
      expect(resin).toMatchObject({ shortcut: '#resina', active: true });
      const list = await as(
        api().get('/api/v1/clinical-note-templates'),
        dentist,
      ).expect(200);
      expect(
        (list.body as TemplateBody[]).find((t) => t.id === resin.id)?.shortcut,
      ).toBe('#resina');
    });

    it('409 por duplicado sin distinguir mayúsculas (#RESINA)', async () => {
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send(templateBody('Otra', '#RESINA'))
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'NOTE_SHORTCUT_CONFLICT',
        message: 'El atajo #RESINA ya lo usa la plantilla «Resina compuesta».',
      });
    });

    it('409 por prefijo (#re frente a #resina)', async () => {
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send(templateBody('Corta', '#re'))
        .expect(409);
      expect(res.body).toMatchObject({
        code: 'NOTE_SHORTCUT_CONFLICT',
        message:
          'El atajo #re choca con #resina: uno no puede empezar por el otro.',
      });
    });

    it('400 en español con un formato inválido', async () => {
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send(templateBody('Mal', '#con espacio'))
        .expect(400);
      expect(messageOf(res)).toMatch(/El atajo empieza por #/);
    });

    it('otra clínica puede usar el mismo atajo', async () => {
      const t = await createTemplate('Resina', '#resina', other);
      expect(t.shortcut).toBe('#resina');
    });

    it('cambiar, quitar (null) y volver a poner el atajo, auditado', async () => {
      const changed = (await patchTemplate(resin, { shortcut: '#Resina-A2' }))
        .body as TemplateBody;
      expect(changed).toMatchObject({ shortcut: '#Resina-A2', version: 2 });
      expect(await lastAuditFields('CLINICAL_NOTE_TEMPLATE', resin.id)).toEqual(
        expect.arrayContaining(['shortcut']),
      );

      const cleared = (await patchTemplate(changed, { shortcut: null }))
        .body as TemplateBody;
      expect(cleared.shortcut).toBeNull();

      // Sin atajo, #re ya no choca con nada.
      const short = await createTemplate('Corta', '#re');
      expect(short.shortcut).toBe('#re');

      // Y ahora es #resina el que choca con #re.
      const res = await patchTemplate(cleared, { shortcut: '#resina' }, 409);
      expect(messageOf(res)).toBe(
        'El atajo #resina choca con #re: uno no puede empezar por el otro.',
      );
      resin = (await patchTemplate(cleared, { shortcut: '#compuesta' }))
        .body as TemplateBody;
      expect(resin.shortcut).toBe('#compuesta');
    });

    it('una plantilla desactivada conserva su atajo', async () => {
      const old = await createTemplate('Vieja', '#vieja');
      await patchTemplate(old, { active: false });
      const res = await as(
        api().post('/api/v1/clinical-note-templates'),
        clinic.adminToken,
      )
        .send(templateBody('Nueva', '#VIEJA'))
        .expect(409);
      expect(messageOf(res)).toBe(
        'El atajo #VIEJA ya lo usa la plantilla «Vieja».',
      );
    });

    it('solo ADMIN edita el atajo (403 al odontólogo)', async () => {
      await as(
        api().patch(`/api/v1/clinical-note-templates/${resin.id}`),
        dentist,
      )
        .send({ version: resin.version, shortcut: '#otra' })
        .expect(403);
    });
  });

  describe('plantilla por procedimiento del catálogo', () => {
    let item: CatalogItemBody;

    it('alta de procedimiento con plantilla: la trae y la sugiere', async () => {
      item = (
        await createProcedure('DX455-01', { clinicalNoteTemplateId: resin.id })
      ).body as CatalogItemBody;
      expect(item).toMatchObject({
        clinicalNoteTemplateId: resin.id,
        suggestedClinicalNoteTemplateId: resin.id,
      });
    });

    it('desligar y volver a ligar por PATCH, auditado con el campo', async () => {
      const cleared = await as(
        api().patch(`/api/v1/catalog/items/${item.id}`),
        clinic.adminToken,
      )
        .send({ clinicalNoteTemplateId: null })
        .expect(200);
      expect(cleared.body).toMatchObject({
        clinicalNoteTemplateId: null,
        suggestedClinicalNoteTemplateId: null,
      });
      expect(await lastAuditFields('DENTAL_CATALOG_ITEM', item.id)).toEqual([
        'clinicalNoteTemplateId',
      ]);
      await as(
        api().patch(`/api/v1/catalog/items/${item.id}`),
        clinic.adminToken,
      )
        .send({ clinicalNoteTemplateId: resin.id })
        .expect(200);
    });

    it('GET /catalog/items (lo que usa el plan): sugerida mientras la plantilla está activa; desactivada, null', async () => {
      const find = async () =>
        (
          (
            await as(
              api().get('/api/v1/catalog/items?kind=PROCEDURE'),
              dentist,
            ).expect(200)
          ).body as CatalogItemBody[]
        ).find((i) => i.id === item.id);

      expect(await find()).toMatchObject({
        clinicalNoteTemplateId: resin.id,
        suggestedClinicalNoteTemplateId: resin.id,
      });

      resin = (await patchTemplate(resin, { active: false }))
        .body as TemplateBody;
      expect(await find()).toMatchObject({
        clinicalNoteTemplateId: resin.id,
        suggestedClinicalNoteTemplateId: null,
      });

      // Ni se puede ligar estando desactivada.
      const rejected = await createProcedure(
        'DX455-02',
        { clinicalNoteTemplateId: resin.id },
        clinic,
        400,
      );
      expect(messageOf(rejected)).toBe(
        'La plantilla «Resina compuesta» está desactivada: actívala en Ajustes → Plantillas de evolución o elige otra.',
      );

      resin = (await patchTemplate(resin, { active: true }))
        .body as TemplateBody;
      expect((await find())?.suggestedClinicalNoteTemplateId).toBe(resin.id);
    });

    it('aislamiento: no se liga la plantilla de otra clínica (404)', async () => {
      const foreign = await createTemplate('Ajena', '#ajena', other);
      const res = await as(
        api().patch(`/api/v1/catalog/items/${item.id}`),
        clinic.adminToken,
      )
        .send({ clinicalNoteTemplateId: foreign.id })
        .expect(404);
      expect(messageOf(res)).toBe(
        'Plantilla de evolución no encontrada en esta clínica',
      );
      const row = await raw.dentalCatalogItem.findUniqueOrThrow({
        where: { id: item.id },
      });
      expect(row.clinicalNoteTemplateId).toBe(resin.id);
      // Y en el alta: 404 y no se crea nada.
      const created = await createProcedure(
        'DX455-03',
        { clinicalNoteTemplateId: foreign.id },
        clinic,
        404,
      );
      expect(messageOf(created)).toBe(
        'Plantilla de evolución no encontrada en esta clínica',
      );
      expect(
        await raw.dentalCatalogItem.count({
          where: { tenantId: clinic.tenantId, code: 'DX455-03' },
        }),
      ).toBe(0);
    });

    it('un diagnóstico no lleva plantilla (400) y un id que no es UUID tampoco (400)', async () => {
      const diagnosis = await as(
        api().post('/api/v1/catalog/items'),
        clinic.adminToken,
      )
        .send({
          code: 'DX455-D1',
          kind: 'DIAGNOSIS',
          labelEs: 'Caries',
          color: '#FF0000',
          clinicalNoteTemplateId: resin.id,
        })
        .expect(400);
      expect(messageOf(diagnosis)).toMatch(/Solo un procedimiento/);
      await as(
        api().patch(`/api/v1/catalog/items/${item.id}`),
        clinic.adminToken,
      )
        .send({ clinicalNoteTemplateId: 'no-es-uuid' })
        .expect(400);
    });

    it('quitar el vínculo no toca las evoluciones guardadas ni la plantilla', async () => {
      await as(
        api().patch(`/api/v1/catalog/items/${item.id}`),
        clinic.adminToken,
      )
        .send({ clinicalNoteTemplateId: null })
        .expect(200);
      const tpl = await raw.clinicalNoteTemplate.findUniqueOrThrow({
        where: { id: resin.id },
      });
      expect(tpl).toMatchObject({ active: true, shortcut: resin.shortcut });
    });
  });
});
