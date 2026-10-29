import { ConflictException } from '@nestjs/common';
import {
  assertNotUnderRetention,
  assertUnderRetention,
  CLINICAL_RECORD_RETENTION,
} from './retention-guard';

const now = new Date('2026-10-16T12:00:00.000Z');

function conflictBody(fn: () => void): Record<string, unknown> {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse() as Record<string, unknown>;
  }
  throw new Error('no lanzó');
}

describe('assertNotUnderRetention (DX-039)', () => {
  it('sin atenciones clínicas deja archivar', () => {
    expect(() =>
      assertNotUnderRetention(
        { lastAttentionAt: null, retentionExtended: 'NONE' },
        now,
      ),
    ).not.toThrow();
  });

  it('con una atención de hace menos de 15 años: 409 con código y fecha en español', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        {
          lastAttentionAt: new Date('2024-02-29T15:00:00Z'),
          retentionExtended: 'NONE',
        },
        now,
      ),
    );
    expect(body.code).toBe(CLINICAL_RECORD_RETENTION);
    expect(body.retentionUntil).toBe('2039-02-28');
    expect(body.message).toContain('retención legal hasta el 28/02/2039');
    expect(body.message).toContain('15 años desde la última atención');
    expect(body.message).not.toContain('Res. 839');
  });

  it('DOUBLE: el mensaje cita el plazo doble (30 años), no los 15 años', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        {
          lastAttentionAt: new Date('2026-10-12T21:00:00Z'),
          retentionExtended: 'DOUBLE',
        },
        now,
      ),
    );
    expect(body.retentionUntil).toBe('2056-10-12');
    expect(body.message).toContain('retención legal hasta el 12/10/2056');
    expect(body.message).toContain('plazo doble: 30 años');
    expect(body.message).not.toContain('15 años');
  });

  it('vencida (más de 15 años) deja archivar; DOUBLE la sigue reteniendo', () => {
    const old = new Date('2010-01-01T00:00:00Z');
    expect(() =>
      assertNotUnderRetention(
        { lastAttentionAt: old, retentionExtended: 'NONE' },
        now,
      ),
    ).not.toThrow();
    expect(
      conflictBody(() =>
        assertNotUnderRetention(
          { lastAttentionAt: old, retentionExtended: 'DOUBLE' },
          now,
        ),
      ).retentionUntil,
    ).toBe('2040-01-01');
  });

  it('PERMANENT: 409 sin fecha', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        { lastAttentionAt: null, retentionExtended: 'PERMANENT' },
        now,
      ),
    );
    expect(body.retentionUntil).toBeNull();
    expect(body.message).toContain('permanente');
  });
});

describe('assertUnderRetention', () => {
  it('rechaza la supresión parcial si no hay retención', () => {
    expect(() =>
      assertUnderRetention(
        { lastAttentionAt: null, retentionExtended: 'NONE' },
        now,
      ),
    ).toThrow(ConflictException);
  });
});
