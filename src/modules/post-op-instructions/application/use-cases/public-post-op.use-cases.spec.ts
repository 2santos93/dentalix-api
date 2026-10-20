import { GoneException, NotFoundException } from '@nestjs/common';
import type { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  generatePostOpToken,
  hashPostOpToken,
} from '../../domain/postop-token';
import {
  APPOINTMENT_ID,
  appointmentContext,
  InMemoryPostOpDeliveryRepository,
  PATIENT_ID,
} from '../__fixtures__/in-memory-post-op-deliveries';
import {
  GetPublicPostOpUseCase,
  MarkPublicPostOpOpenedUseCase,
  POSTOP_LINK_EXPIRED_MESSAGE,
  POSTOP_LINK_NOT_FOUND_MESSAGE,
} from './public-post-op.use-cases';

const ISSUED = new Date('2026-10-20T15:00:00.000Z');
const EXPIRES = new Date('2026-11-19T15:00:00.000Z');

function setup({ withTenant = true } = {}) {
  const repo = new InMemoryPostOpDeliveryRepository();
  repo.contexts.set(APPOINTMENT_ID, appointmentContext());
  let now = ISSUED;
  const clock = () => now;
  const tenantContext = {
    getTenantId: () => (withTenant ? 't1' : undefined),
  } as unknown as TenantContextService;
  return {
    repo,
    get: new GetPublicPostOpUseCase(tenantContext, repo, clock),
    opened: new MarkPublicPostOpOpenedUseCase(tenantContext, repo, clock),
    setNow: (at: Date) => {
      now = at;
    },
  };
}

async function deliveredWithLink(
  repo: InMemoryPostOpDeliveryRepository,
): Promise<string> {
  const token = generatePostOpToken();
  await repo.create({
    patientId: PATIENT_ID,
    appointmentId: APPOINTMENT_ID,
    locationId: 'loc-1',
    templateId: 'tpl-1',
    templateCode: 'POI-EXO',
    templateTitle: 'Exodoncia',
    templateVersion: 2,
    channel: 'EMAIL',
    renderedText: 'Hola Carolina Duque: muerde la gasa.',
    deliveredById: 'user-1',
    deliveredByName: 'Recepción Demo',
    recipientMasked: 'ca***@example.com',
    sentToResponsible: false,
    tokenHash: hashPostOpToken(token),
    tokenExpiresAt: EXPIRES,
  });
  return token;
}

describe('GetPublicPostOpUseCase', () => {
  it('devuelve el texto congelado con la marca de la clínica y el teléfono de la sede', async () => {
    const { repo, get } = setup();
    const token = await deliveredWithLink(repo);
    const view = await get.execute(token);
    expect(view).toEqual({
      clinic: {
        name: 'Sonrisas del Norte',
        logoUrl: null,
        primaryColor: '#0F5E9C',
      },
      locationPhone: '601 555 0101',
      title: 'Exodoncia',
      code: 'POI-EXO',
      version: 2,
      renderedText: 'Hola Carolina Duque: muerde la gasa.',
      deliveredAt: repo.rows[0].deliveredAt,
    });
    expect(JSON.stringify(view)).not.toContain(PATIENT_ID);
  });

  it('token malformado → 404 sin consultar el repositorio', async () => {
    const { repo, get } = setup();
    await expect(get.execute('no-es-un-token')).rejects.toThrow(
      new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE),
    );
    expect(repo.tokenLookups).toBe(0);
  });

  it('sin clínica en el host → 404 sin consultar el repositorio', async () => {
    const { repo, get } = setup({ withTenant: false });
    const token = await deliveredWithLink(repo);
    await expect(get.execute(token)).rejects.toThrow(
      new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE),
    );
    expect(repo.tokenLookups).toBe(0);
  });

  it('token bien formado pero desconocido → 404', async () => {
    const { get } = setup();
    await expect(get.execute(generatePostOpToken())).rejects.toThrow(
      new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE),
    );
  });

  it('caduca justo en tokenExpiresAt → 410', async () => {
    const { repo, get, setNow } = setup();
    const token = await deliveredWithLink(repo);
    setNow(new Date(EXPIRES.getTime() - 1));
    await expect(get.execute(token)).resolves.toBeDefined();
    setNow(EXPIRES);
    await expect(get.execute(token)).rejects.toThrow(
      new GoneException(POSTOP_LINK_EXPIRED_MESSAGE),
    );
  });
});

describe('MarkPublicPostOpOpenedUseCase', () => {
  it('la primera apertura queda marcada una sola vez aunque se llame dos veces', async () => {
    const { repo, opened } = setup();
    const token = await deliveredWithLink(repo);
    await opened.execute(token);
    const first = repo.rows[0].firstOpenedAt;
    expect(first).toBeInstanceOf(Date);
    await opened.execute(token);
    expect(repo.rows[0].firstOpenedAt).toBe(first);
    expect(repo.openedMarks).toBe(1);
  });

  it('caducado → 410 sin marcar la apertura', async () => {
    const { repo, opened, setNow } = setup();
    const token = await deliveredWithLink(repo);
    setNow(new Date(EXPIRES.getTime() + 24 * 60 * 60 * 1000));
    await expect(opened.execute(token)).rejects.toThrow(
      new GoneException(POSTOP_LINK_EXPIRED_MESSAGE),
    );
    expect(repo.rows[0].firstOpenedAt).toBeNull();
  });

  it('token malformado → 404 sin tocar el repositorio', async () => {
    const { repo, opened } = setup();
    await expect(opened.execute('x'.repeat(42))).rejects.toThrow(
      new NotFoundException(POSTOP_LINK_NOT_FOUND_MESSAGE),
    );
    expect(repo.tokenLookups).toBe(0);
  });
});
