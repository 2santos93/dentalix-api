import { ConflictException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaClinicalNoteTemplateRepository } from '../src/modules/clinical-note-templates/infrastructure/repositories/prisma-clinical-note-template.repository';
import { PrismaDentalCatalogRepository } from '../src/modules/dental-catalog/infrastructure/repositories/prisma-dental-catalog.repository';
import type { CreateNoteTemplateRepoInput } from '../src/modules/clinical-note-templates/domain/ports/clinical-note-template-repository.port';
import {
  holdLock,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';

// DX-455, capa DB: el atajo de las plantillas (único por clínica sin
// distinguir mayúsculas, regla de prefijos bajo candado por clínica) y la
// plantilla ligada a un procedimiento del catálogo (FK compuesta por clínica).
// Lo que se prueba va por la MISMA ruta que la app (repositorios con
// runWithTenant, rol dentalix_app, sujeto a RLS); `raw` (DIRECT_URL) siembra
// y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const templates = new PrismaClinicalNoteTemplateRepository(
  prisma,
  tenantContext,
);
const catalog = new PrismaDentalCatalogRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx455-int-a', 'dx455-int-b'];

let tenantA: string;
let tenantB: string;

const draft = (
  name: string,
  shortcut: string | null,
  active = true,
): CreateNoteTemplateRepoInput => ({
  name,
  category: null,
  body: 'Texto fijo',
  prompts: [],
  active,
  shortcut,
});

const asTenant = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenantId, fn);

async function create(
  tenantId: string,
  name: string,
  shortcut: string | null,
  active = true,
) {
  const [t] = await asTenant(tenantId, () =>
    templates.createMany([draft(name, shortcut, active)]),
  );
  return t;
}

function lockShortcutsOf(tenantId: string) {
  return (tx: Prisma.TransactionClient) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext('dx455_note_shortcut'),
      hashtext(${tenantId})
    )`;
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.clinicalNoteTemplate.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

async function resetTemplates(): Promise<void> {
  const where = { tenantId: { in: [tenantA, tenantB] } };
  await raw.dentalCatalogItem.deleteMany({ where });
  await raw.clinicalNoteTemplate.deleteMany({ where });
}

describe('atajos de plantillas y plantilla por procedimiento (int, DX-455)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    const [a, b] = await Promise.all(
      SUBDOMAINS.map((subdomain) =>
        raw.tenant.create({ data: { name: subdomain, subdomain } }),
      ),
    );
    tenantA = a.id;
    tenantB = b.id;
  });

  beforeEach(resetTemplates);

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('índice único del atajo', () => {
    it('existe parcial sobre (tenantId, lower(shortcut)) WHERE shortcut IS NOT NULL', async () => {
      const [index] = await raw.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
         WHERE indexname = 'clinical_note_templates_tenant_shortcut_key'`;
      expect(index.indexdef).toMatch(/UNIQUE INDEX/);
      expect(index.indexdef).toMatch(/lower\(shortcut\)/);
      expect(index.indexdef).toMatch(/WHERE \(shortcut IS NOT NULL\)/);
    });

    it('rechaza un duplicado que solo difiere en mayúsculas aunque se salte la API', async () => {
      await create(tenantA, 'Resina compuesta', '#resina');
      await expect(
        raw.clinicalNoteTemplate.create({
          data: {
            tenantId: tenantA,
            name: 'Otra',
            body: 'x',
            shortcut: '#RESINA',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('si solo el índice ve el duplicado, el repositorio da el 409 del atajo (no el del nombre)', async () => {
      // «İ» (I con punto): para Postgres lower('#İx') = '#ix'; para JS es
      // '#i̇x' (i + punto combinante), así que la comprobación previa no ve el
      // choque y lo para el índice único, cuyo P2002 no dice cuál (RLS).
      await create(tenantA, 'Uno', '#ix');
      await expect(create(tenantA, 'Dos', '#İx')).rejects.toThrow(
        new ConflictException(
          'El atajo #İx ya lo usa otra plantilla de esta clínica.',
        ),
      );
      // Y un nombre repetido sigue dando el 409 del nombre.
      await expect(create(tenantA, 'Uno', '#otro')).rejects.toThrow(
        'Ya existe una plantilla de evolución con ese nombre.',
      );
    });

    it('el CHECK de la BD rechaza un atajo con espacios aunque se salte la API', async () => {
      await expect(
        raw.clinicalNoteTemplate.create({
          data: {
            tenantId: tenantA,
            name: 'Mal',
            body: 'x',
            shortcut: '#con espacio',
          },
        }),
      ).rejects.toThrow(/clinical_note_templates_shortcut_check/);
    });

    it('dos clínicas pueden usar el mismo atajo', async () => {
      await create(tenantA, 'Resina compuesta', '#resina');
      const inB = await create(tenantB, 'Resina', '#Resina');
      expect(inB.shortcut).toBe('#Resina');
    });

    it('varias plantillas sin atajo conviven (NULL fuera del índice)', async () => {
      await create(tenantA, 'Una', null);
      await create(tenantA, 'Dos', null);
      expect(
        await raw.clinicalNoteTemplate.count({ where: { tenantId: tenantA } }),
      ).toBe(2);
    });
  });

  describe('regla del repositorio', () => {
    it('409 por duplicado (#RESINA) con el nombre de la otra plantilla', async () => {
      await create(tenantA, 'Resina compuesta', '#resina');
      await expect(create(tenantA, 'Otra', '#RESINA')).rejects.toThrow(
        new ConflictException(
          'El atajo #RESINA ya lo usa la plantilla «Resina compuesta».',
        ),
      );
    });

    it('409 por prefijo en los dos sentidos', async () => {
      await create(tenantA, 'Resina compuesta', '#resina');
      await expect(create(tenantA, 'Corta', '#re')).rejects.toThrow(
        'El atajo #re choca con #resina: uno no puede empezar por el otro.',
      );
      await expect(create(tenantA, 'Larga', '#Resina-A2')).rejects.toThrow(
        'El atajo #Resina-A2 choca con #resina: uno no puede empezar por el otro.',
      );
    });

    it('una plantilla desactivada conserva (reserva) su atajo', async () => {
      await create(tenantA, 'Vieja', '#resina', false);
      await expect(create(tenantA, 'Nueva', '#resina')).rejects.toThrow(
        /ya lo usa la plantilla «Vieja»/,
      );
    });

    it('el atajo de otra clínica no cuenta (RLS en la lectura)', async () => {
      await create(tenantB, 'Resina B', '#resina');
      const inA = await create(tenantA, 'Corta', '#re');
      expect(inA.shortcut).toBe('#re');
      const visible = await asTenant(tenantA, () =>
        templates.list({ includeInactive: true }),
      );
      expect(visible.map((t) => t.shortcut)).toEqual(['#re']);
    });

    it('editar: poner, cambiar mayúsculas del propio y quitar', async () => {
      const t = await create(tenantA, 'Resina', null);
      const set = await asTenant(tenantA, () =>
        templates.update(t.id, { shortcut: '#resina', expectedVersion: 1 }),
      );
      expect(set.shortcut).toBe('#resina');
      const recased = await asTenant(tenantA, () =>
        templates.update(t.id, { shortcut: '#RESINA', expectedVersion: 2 }),
      );
      expect(recased.shortcut).toBe('#RESINA');
      const cleared = await asTenant(tenantA, () =>
        templates.update(t.id, { shortcut: null, expectedVersion: 3 }),
      );
      expect(cleared.shortcut).toBeNull();
    });

    it('carrera: #re y #resina a la vez en la misma clínica → exactamente una', async () => {
      const held = await holdLock(raw, lockShortcutsOf(tenantA));
      const attempts = [
        settle(create(tenantA, 'Corta', '#re')),
        settle(create(tenantA, 'Larga', '#resina')),
      ];
      // Las dos esperan el candado de la clínica (señal de pg_locks).
      await waitForLockWaiters(raw, [held.pid], 2);
      held.release();
      await held.done;
      const outcomes = await Promise.all(attempts);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected');
      expect(rejected).toBeDefined();
      expect(
        rejected && rejected.status === 'rejected' && rejected.reason,
      ).toBeInstanceOf(ConflictException);
      expect(
        await raw.clinicalNoteTemplate.count({
          where: { tenantId: tenantA, shortcut: { not: null } },
        }),
      ).toBe(1);
    });

    it('el candado es por clínica: otra clínica no espera', async () => {
      const held = await holdLock(raw, lockShortcutsOf(tenantA));
      try {
        const inB = await create(tenantB, 'Resina B', '#resina');
        expect(inB.shortcut).toBe('#resina');
      } finally {
        held.release();
        await held.done;
      }
    });
  });

  describe('plantilla por procedimiento del catálogo', () => {
    async function procedure(tenantId: string, code: string) {
      return asTenant(tenantId, () =>
        catalog.create({
          code,
          kind: 'PROCEDURE',
          labelEs: 'Resina',
          color: '#123456',
        }),
      );
    }

    it('liga, sugiere solo si la plantilla está activa y desliga', async () => {
      const t = await create(tenantA, 'Resina', '#resina');
      const item = await procedure(tenantA, 'RES-01');
      const linked = await asTenant(tenantA, () =>
        catalog.update(item.id, { clinicalNoteTemplateId: t.id }),
      );
      expect(linked).toMatchObject({
        clinicalNoteTemplateId: t.id,
        suggestedClinicalNoteTemplateId: t.id,
      });

      await asTenant(tenantA, () =>
        templates.update(t.id, { active: false, expectedVersion: 1 }),
      );
      const [listed] = await asTenant(tenantA, () =>
        catalog.list({ kind: 'PROCEDURE' }),
      );
      expect(listed).toMatchObject({
        clinicalNoteTemplateId: t.id,
        suggestedClinicalNoteTemplateId: null,
      });

      const unlinked = await asTenant(tenantA, () =>
        catalog.update(item.id, { clinicalNoteTemplateId: null }),
      );
      expect(unlinked).toMatchObject({
        clinicalNoteTemplateId: null,
        suggestedClinicalNoteTemplateId: null,
      });
    });

    it('FK compuesta: no se liga la plantilla de otra clínica aunque se salte la API', async () => {
      const foreign = await create(tenantB, 'Resina B', null);
      const item = await procedure(tenantA, 'RES-02');
      await expect(
        raw.dentalCatalogItem.update({
          where: { id: item.id },
          data: { clinicalNoteTemplateId: foreign.id },
        }),
      ).rejects.toThrow(/dental_catalog_items_note_template_fkey/);
    });

    it('RESTRICT: una plantilla ligada no se puede borrar', async () => {
      const t = await create(tenantA, 'Resina', null);
      const item = await procedure(tenantA, 'RES-03');
      await asTenant(tenantA, () =>
        catalog.update(item.id, { clinicalNoteTemplateId: t.id }),
      );
      await expect(
        raw.clinicalNoteTemplate.delete({ where: { id: t.id } }),
      ).rejects.toThrow(
        /dental_catalog_items_note_template_fkey|P2003|Foreign key/i,
      );
    });
  });
});
