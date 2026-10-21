import { PrismaClient } from '@prisma/client';

const app = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tables = ['icd10_codes', 'currencies', 'countries', 'cities'];
describe('DX-236 referencias globales de solo lectura como dentalix_app', () => {
  afterAll(() => app.$disconnect());
  it.each(tables)('%s permite SELECT con una clínica fijada', async (table) => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', '00000000-0000-4000-8000-000000000236', true)`;
      return tx.$queryRawUnsafe(`SELECT 1 FROM public.${table} LIMIT 1`);
    });
    expect(rows).toHaveLength(1);
  });
  it.each(
    tables.flatMap((table) =>
      ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((command) => [
        table,
        command,
      ]),
    ),
  )('%s rechaza %s con 42501', async (table, command) => {
    const column =
      table === 'cities'
        ? 'name'
        : table === 'icd10_codes'
          ? 'label_es'
          : 'name';
    const sql =
      command === 'INSERT'
        ? `INSERT INTO public.${table} (${column}) SELECT NULL WHERE false`
        : command === 'UPDATE'
          ? `UPDATE public.${table} SET ${column} = ${column} WHERE false`
          : command === 'DELETE'
            ? `DELETE FROM public.${table} WHERE false`
            : `TRUNCATE public.${table}`;
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', '00000000-0000-4000-8000-000000000236', true)`;
        await tx.$executeRawUnsafe(sql);
        throw new Error('privilegio de escritura permitido'); // rollback si hay regresión
      }),
    ).rejects.toMatchObject({
      meta: { code: '42501' },
    });
  });
});
