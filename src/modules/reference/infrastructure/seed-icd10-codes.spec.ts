import type { PrismaClient } from '@prisma/client';
import { seedIcd10Codes } from './seed-icd10-codes';

// In-memory persistence boundary: exercises the seed's update/create decisions.
it('preserva la etiqueta existente de un código usado al repetir la siembra', async () => {
  const labels = new Map([['K02.1', 'Texto clínico ya utilizado']]);
  const prisma = {
    icd10Code: {
      upsert: ({
        where,
        update,
        create,
      }: {
        where: { code: string };
        update: { labelEs?: string };
        create: { code: string; labelEs: string };
      }) => {
        if (!labels.has(where.code)) labels.set(create.code, create.labelEs);
        else if (update.labelEs) labels.set(where.code, update.labelEs);
        return Promise.resolve();
      },
    },
  } as unknown as PrismaClient;
  await seedIcd10Codes(prisma);
  await seedIcd10Codes(prisma);
  expect(labels.get('K02.1')).toBe('Texto clínico ya utilizado');
  expect(labels.get('Z01.2')).toBe('Examen odontológico');
});
