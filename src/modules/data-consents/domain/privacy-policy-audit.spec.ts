import { TEST_AUDIT } from '../../audit/application/__fixtures__/test-audit-context';
import { sanitizeAuditMetadata } from '../../audit/domain/audit-metadata';
import { privacyPolicyPublishedAuditEvent } from './privacy-policy-audit';

const ID = '0192f0a0-0000-7000-8000-0000000000cc';
const V1 = {
  version: 1,
  contentHash: 'a'.repeat(64),
  policyText: 'Política v1',
  generalText: 'General',
  sensitiveHealthText: 'Sensibles',
  marketingText: 'Marketing',
};

describe('privacyPolicyPublishedAuditEvent (DX-360)', () => {
  it('la primera versión: el después (versión y hash), sin textos', () => {
    const event = privacyPolicyPublishedAuditEvent(TEST_AUDIT, ID, null, V1);
    expect(event).toMatchObject({
      action: 'CREATE',
      resourceType: 'PRIVACY_POLICY',
      resourceId: ID,
      metadata: {
        reason: 'PRIVACY_POLICY_PUBLISHED',
        configChange: { after: { version: 1, contentHash: V1.contentHash } },
      },
    });
    expect(event.metadata.changedFields).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('Política v1');
  });

  it('una versión nueva: antes y después, y qué textos cambiaron', () => {
    const v2 = {
      ...V1,
      version: 2,
      contentHash: 'b'.repeat(64),
      marketingText: 'Otro',
    };
    const event = privacyPolicyPublishedAuditEvent(TEST_AUDIT, ID, V1, v2);
    expect(event.metadata).toEqual({
      reason: 'PRIVACY_POLICY_PUBLISHED',
      changedFields: ['marketingText'],
      configChange: {
        before: { version: 1, contentHash: V1.contentHash },
        after: { version: 2, contentHash: v2.contentHash },
      },
    });
    expect(sanitizeAuditMetadata(event.metadata)).toEqual(event.metadata);
    expect(JSON.stringify(event)).not.toContain('Otro');
  });
});
