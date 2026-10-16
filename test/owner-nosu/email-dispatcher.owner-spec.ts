import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import { PrismaEmailOutboxRepository } from '../../src/modules/notifications/email/infrastructure/repositories/prisma-email-outbox.repository';
import { requireOwnerNosuEnv } from './owner-nosu-env';

// DX-113: con un owner de las migraciones sin superusuario ni BYPASSRLS el
// despachador de email sigue trabajando para todas las clínicas: sus
// funciones SECURITY DEFINER son de un rol NOLOGIN con su propia política,
// no del owner. Antes, en producción la API no arrancaba (revisión D4 de
// DX-088) y fuera de ella ningún email salía.
//
// Corre como la app (DATABASE_URL) sobre la base migrada por el owner de
// DIRECT_URL, en el job «Migraciones con owner sin superusuario» de la CI.

describe('DX-113 · despachador de email con un owner sin superusuario (owner-nosu)', () => {
  requireOwnerNosuEnv();
  const prisma = new PrismaService(new TenantContextService());
  const repo = new PrismaEmailOutboxRepository(prisma);

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('la comprobación de arranque da acceso completo', async () => {
    expect(await repo.dispatcherAccess()).toEqual({
      executable: true,
      ownerSeesAllRows: true,
    });
  });

  it('encola un email de plataforma, lo reclama y lo cierra', async () => {
    const referenceId = randomUUID();
    const { id } = await repo.insert({
      tenantId: null,
      template: 'email-verify',
      toHash: `owner-nosu-${referenceId}`,
      toMasked: 'ow***@example.com',
      referenceId,
      payload: Buffer.from('cifrado'),
    });
    const claimed = await repo.claimDue(100, 60);
    const mine = claimed.find((c) => c.id === id);
    expect(mine).toMatchObject({ tenantId: null, attempts: 1 });
    expect(await repo.settle(id, 1, { status: 'SENT' })).toBe(true);
  });
});
