import { BadRequestException } from '@nestjs/common';
import { PublishPrivacyPolicyUseCase } from './publish-privacy-policy.use-case';
import { GetPrivacyPoliciesUseCase } from './get-privacy-policies.use-case';
import { InMemoryPrivacyPolicyRepository } from './__fixtures__/in-memory-data-consents';
import { policyContentHash } from '../../domain/privacy-policy-content';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

const AUDIT: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'admin-1', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

const CONTENT = {
  policyText: 'Política de tratamiento de datos de la Clínica Sonrisa.',
  generalText: 'Autorizo el tratamiento de mis datos personales.',
  sensitiveHealthText:
    'Autorizo el tratamiento de mis datos sensibles de salud. No está obligado a autorizarlo. Finalidad: atención odontológica.',
  marketingText: 'Autorizo recibir comunicaciones comerciales.',
};

describe('PublishPrivacyPolicyUseCase', () => {
  let repo: InMemoryPrivacyPolicyRepository;
  let publish: PublishPrivacyPolicyUseCase;
  let get: GetPrivacyPoliciesUseCase;

  beforeEach(() => {
    repo = new InMemoryPrivacyPolicyRepository();
    publish = new PublishPrivacyPolicyUseCase(repo);
    get = new GetPrivacyPoliciesUseCase(repo);
  });

  it('publica con versión correlativa, hash del contenido y quién la publicó', async () => {
    const v1 = await publish.execute(CONTENT, AUDIT);
    const v2 = await publish.execute(
      { ...CONTENT, marketingText: 'Otro texto de marketing.' },
      AUDIT,
    );
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v1.contentHash).toBe(policyContentHash(CONTENT));
    expect(v1.publishedBy.id).toBe('admin-1');
  });

  it('guarda el contenido normalizado (sin espacios sobrantes)', async () => {
    const v1 = await publish.execute(
      { ...CONTENT, generalText: `  ${CONTENT.generalText}\r\n` },
      AUDIT,
    );
    expect(v1.generalText).toBe(CONTENT.generalText);
    expect(v1.contentHash).toBe(policyContentHash(CONTENT));
  });

  it('rechaza un texto de datos sensibles sin las frases obligatorias y no publica nada', async () => {
    await expect(
      publish.execute(
        { ...CONTENT, sensitiveHealthText: 'Autorizo el uso de mi salud.' },
        AUDIT,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      publish.execute(
        { ...CONTENT, sensitiveHealthText: 'Autorizo el uso de mi salud.' },
        AUDIT,
      ),
    ).rejects.toThrow(/no está obligado.*datos sensibles.*finalidad/);
    expect(repo.versions).toHaveLength(0);
  });

  it('rechaza textos vacíos tras recortar espacios', async () => {
    await expect(
      publish.execute({ ...CONTENT, policyText: '   ' }, AUDIT),
    ).rejects.toThrow(BadRequestException);
  });

  it('GET: vigente = la mayor versión; historial completo de la más nueva a la más vieja', async () => {
    expect(await get.execute()).toEqual({ current: null, history: [] });
    await publish.execute(CONTENT, AUDIT);
    const v2 = await publish.execute(
      { ...CONTENT, policyText: 'Versión 2.' },
      AUDIT,
    );
    const res = await get.execute();
    expect(res.current?.id).toBe(v2.id);
    expect(res.history.map((v) => v.version)).toEqual([2, 1]);
  });
});
