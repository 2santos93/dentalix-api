import { BadRequestException } from '@nestjs/common';
import {
  CONSENT_SCOPES,
  assertValidDecisions,
  currentConsentByScope,
  deriveLegacyPatientConsent,
} from './consent-state';
import type { DataConsentRecord } from './entities/data-consent.entity';

let seq = 0;
function row(overrides: Partial<DataConsentRecord>): DataConsentRecord {
  seq += 1;
  return {
    id: `r${seq}`,
    patientId: 'p1',
    scope: 'GENERAL',
    granted: true,
    channel: 'IN_PERSON',
    policyVersion: { id: 'pol1', version: 1 },
    legacyPolicyVersion: null,
    recordedAt: new Date('2026-10-01T10:00:00.000Z'),
    recordedBy: { id: 'u1', fullName: 'Recepción' },
    ipAddress: '10.0.0.1',
    userAgent: 'jest',
    ...overrides,
  };
}

describe('currentConsentByScope', () => {
  it('devuelve los tres scopes en orden fijo, sin decisión si no hay filas', () => {
    const current = currentConsentByScope([]);
    expect(current.map((c) => c.scope)).toEqual(CONSENT_SCOPES);
    expect(current.every((c) => c.granted === null && c.latest === null)).toBe(
      true,
    );
  });

  it('el estado vigente de cada scope es su ÚLTIMA fila (revocar gana a aceptar)', () => {
    const accepted = row({
      scope: 'MARKETING',
      granted: true,
      recordedAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const revoked = row({
      scope: 'MARKETING',
      granted: false,
      recordedAt: new Date('2026-10-02T10:00:00.000Z'),
    });
    const general = row({ scope: 'GENERAL', granted: true });
    // El orden de entrada no importa: manda recordedAt.
    const current = currentConsentByScope([accepted, general, revoked]);
    const marketing = current.find((c) => c.scope === 'MARKETING');
    expect(marketing?.granted).toBe(false);
    expect(marketing?.latest?.id).toBe(revoked.id);
    expect(current.find((c) => c.scope === 'GENERAL')?.granted).toBe(true);
    expect(current.find((c) => c.scope === 'SENSITIVE_HEALTH')?.granted).toBe(
      null,
    );
  });
});

describe('deriveLegacyPatientConsent', () => {
  it('resume la última fila GENERAL en los campos deprecados del paciente', () => {
    const at = new Date('2026-10-03T08:00:00.000Z');
    expect(
      deriveLegacyPatientConsent(
        row({ scope: 'GENERAL', granted: true, recordedAt: at }),
      ),
    ).toEqual({
      dataConsentAccepted: true,
      dataConsentAt: at,
      dataConsentPolicyVersion: 'v1',
    });
  });

  it('una fila LEGACY conserva su etiqueta de versión original', () => {
    expect(
      deriveLegacyPatientConsent(
        row({
          channel: 'LEGACY',
          policyVersion: null,
          legacyPolicyVersion: 'v1-papel',
        }),
      ).dataConsentPolicyVersion,
    ).toBe('v1-papel');
  });

  it('sin fila GENERAL el paciente queda sin autorización', () => {
    expect(deriveLegacyPatientConsent(null)).toEqual({
      dataConsentAccepted: false,
      dataConsentAt: null,
      dataConsentPolicyVersion: null,
    });
  });
});

describe('assertValidDecisions', () => {
  it('acepta de una a tres decisiones de scopes distintos', () => {
    expect(() =>
      assertValidDecisions([
        { scope: 'GENERAL', granted: true },
        { scope: 'MARKETING', granted: false },
      ]),
    ).not.toThrow();
  });

  it('rechaza una lista vacía: sin acción explícita no se registra nada', () => {
    expect(() => assertValidDecisions([])).toThrow(BadRequestException);
  });

  it('rechaza dos decisiones del mismo scope en la misma petición', () => {
    expect(() =>
      assertValidDecisions([
        { scope: 'GENERAL', granted: true },
        { scope: 'GENERAL', granted: false },
      ]),
    ).toThrow(BadRequestException);
  });
});
