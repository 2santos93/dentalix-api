import { ClinicRole } from '@prisma/client';
import { consentsForViewer } from './consent-evidence-visibility';
import type {
  DataConsentRecord,
  PatientDataConsents,
} from '../domain/entities/data-consent.entity';

const record: DataConsentRecord = {
  id: 'c1',
  patientId: 'p1',
  scope: 'GENERAL',
  granted: true,
  channel: 'IN_PERSON',
  policyVersion: { id: 'v1', version: 1 },
  legacyPolicyVersion: null,
  recordedAt: new Date('2026-03-01T14:00:00Z'),
  recordedBy: { id: 'u1', fullName: 'Recepción Caracas' },
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (Macintosh)',
};

const consents: PatientDataConsents = {
  current: [
    { scope: 'GENERAL', granted: true, latest: record },
    { scope: 'MARKETING', granted: null, latest: null },
  ],
  history: [record],
};

describe('consentsForViewer (DX-092, SEC-027)', () => {
  it('ADMIN ve la IP y el user-agent', () => {
    expect(consentsForViewer(consents, ClinicRole.ADMIN)).toEqual(consents);
  });

  it.each([ClinicRole.RECEPTION, ClinicRole.DENTIST, ClinicRole.ASSISTANT])(
    '%s recibe IP y user-agent en null, con el resto intacto',
    (role) => {
      const shown = consentsForViewer(consents, role);
      const hidden = { ...record, ipAddress: null, userAgent: null };
      expect(shown).toEqual({
        current: [
          { scope: 'GENERAL', granted: true, latest: hidden },
          { scope: 'MARKETING', granted: null, latest: null },
        ],
        history: [hidden],
      });
      expect(JSON.stringify(shown)).not.toMatch(/203\.0\.113|Mozilla/);
    },
  );

  it('sin rol de clínica (token de plataforma): nada', () => {
    expect(consentsForViewer(consents, undefined).history[0].ipAddress).toBe(
      null,
    );
  });
});
