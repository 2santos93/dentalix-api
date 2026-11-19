import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../../shared/prisma/prisma.service';
import type { AuditEventDraft } from '../domain/audit-event';
import {
  PrismaAuditEventRepository,
  writeAuditEvent,
} from './prisma-audit-event.repository';

/**
 * DX-582: `writeAuditEvent` es el único sitio que inserta en `audit_events`
 * (src/architecture/audit-events-writers.spec.ts). Todo evento nuevo sale de
 * aquí con la IP truncada y el navegador resumido, como las sesiones de
 * DX-137: el login, el login fallido y cualquier otro.
 */
const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    tenantId: TENANT,
    locationId: null,
    actor: { kind: 'user', userId: USER, role: 'DENTIST' },
    action: 'LOGIN',
    resourceType: 'SESSION',
    resourceId: null,
    patient: null,
    requestId: 'req-dx582',
    ip: '190.202.15.77',
    userAgent: CHROME_MAC,
    metadata: {},
    ...overrides,
  };
}

type Written = { ip: string | null; userAgent: string | null };

function fakeTx() {
  const create = jest
    .fn<Promise<{ id: string }>, [{ data: Written }]>()
    .mockResolvedValue({ id: 'x' });
  const findFirst = jest.fn().mockResolvedValue({ userId: USER });
  const tx = {
    auditEvent: { create },
    clinicMembership: { findFirst },
  } as unknown as Prisma.TransactionClient;
  const written = (): Written => create.mock.calls[0][0].data;
  return { tx, create, written };
}

describe('writeAuditEvent (DX-582: IP truncada y navegador resumido)', () => {
  it('LOGIN: guarda la IP /24 y «Chrome en macOS», nunca lo completo', async () => {
    const { tx, written } = fakeTx();
    await writeAuditEvent(tx, draft());
    expect(written()).toMatchObject({
      ip: '190.202.15.0/24',
      userAgent: 'Chrome en macOS',
    });
  });

  it('LOGIN_FAILED (actor por email): igual', async () => {
    const { tx, written } = fakeTx();
    await writeAuditEvent(
      tx,
      draft({
        action: 'LOGIN_FAILED',
        actor: { kind: 'email', email: 'alguien@clinica.test' },
        ip: '2800:a4:1f:9c::1',
        userAgent: 'curl/8.4.0',
        metadata: { reason: 'INVALID_CREDENTIALS' },
      }),
    );
    expect(written()).toMatchObject({
      ip: '2800:a4:1f::/48',
      userAgent: 'Dispositivo desconocido',
    });
  });

  it('un evento ya truncado y resumido (sesiones de DX-137) llega igual', async () => {
    const { tx, written } = fakeTx();
    await writeAuditEvent(
      tx,
      draft({
        action: 'DELETE',
        ip: '127.0.0.0/24',
        userAgent: 'Firefox en Linux',
      }),
    );
    expect(written()).toMatchObject({
      ip: '127.0.0.0/24',
      userAgent: 'Firefox en Linux',
    });
  });

  it('sin IP ni user-agent (un trabajo, un enlace sin cabecera): null', async () => {
    const { tx, written } = fakeTx();
    await writeAuditEvent(
      tx,
      draft({ actor: { kind: 'system' }, ip: null, userAgent: null }),
    );
    expect(written()).toMatchObject({ ip: null, userAgent: null });
  });

  it('la ruta del repositorio (RecordAuditEventUseCase → insert) pasa por el mismo punto', async () => {
    const { tx, written } = fakeTx();
    const prisma = {
      runWithTenant: (
        _tenantId: string,
        fn: (t: Prisma.TransactionClient) => Promise<unknown>,
      ) => fn(tx),
    } as unknown as PrismaService;
    await new PrismaAuditEventRepository(prisma).insert(
      draft({ action: 'VIEW', resourceType: 'PATIENT' }),
    );
    expect(written()).toMatchObject({
      ip: '190.202.15.0/24',
      userAgent: 'Chrome en macOS',
    });
  });
});
