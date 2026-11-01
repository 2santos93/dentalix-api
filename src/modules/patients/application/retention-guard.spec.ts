import { ConflictException } from '@nestjs/common';
import type { PatientRetentionState } from '../domain/ports/patient-repository.port';
import {
  assertNotUnderRetention,
  assertUnderRetention,
  CLINICAL_RECORD_RETENTION,
  NOT_UNDER_RETENTION,
  retentionMessage,
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

function state(over: Partial<PatientRetentionState>): PatientRetentionState {
  return {
    lastAttentionAt: null,
    retentionExtended: 'NONE',
    retentionFloorUntil: null,
    years: 15,
    ...over,
  };
}

describe('assertNotUnderRetention (DX-039, DX-330)', () => {
  it('sin atenciones clínicas deja archivar', () => {
    expect(() => assertNotUnderRetention(state({}), now)).not.toThrow();
  });

  it('con una atención dentro del plazo: 409 con código y fecha en español', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        state({ lastAttentionAt: new Date('2024-02-29T15:00:00Z') }),
        now,
      ),
    );
    expect(body.code).toBe(CLINICAL_RECORD_RETENTION);
    expect(body.retentionUntil).toBe('2039-02-28');
    expect(body.message).toBe(
      'La historia clínica de este paciente está en retención hasta el 28/02/2039 (15 años desde la última atención): no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.',
    );
    expect(body.message).not.toMatch(/legal/);
  });

  it('el mensaje dice el plazo de la clínica, no 15 años', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        state({
          lastAttentionAt: new Date('2020-03-10T15:00:00Z'),
          years: 20,
        }),
        now,
      ),
    );
    expect(body.retentionUntil).toBe('2040-03-10');
    expect(body.message).toBe(
      'La historia clínica de este paciente está en retención hasta el 10/03/2040 (20 años desde la última atención): no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.',
    );
  });

  it('una atención vencida con 15 sigue en retención con 20', () => {
    const lastAttentionAt = new Date('2010-06-15T00:00:00Z');
    expect(() =>
      assertNotUnderRetention(state({ lastAttentionAt, years: 15 }), now),
    ).not.toThrow();
    expect(
      conflictBody(() =>
        assertNotUnderRetention(state({ lastAttentionAt, years: 20 }), now),
      ).retentionUntil,
    ).toBe('2030-06-15');
  });

  it.each([
    [15, '2056-10-12', '12/10/2056', 'plazo doble: 30 años'],
    [20, '2066-10-12', '12/10/2066', 'plazo doble: 40 años'],
  ])(
    'DOUBLE con %i años: el mensaje cita el doble',
    (years, until, shown, basis) => {
      const body = conflictBody(() =>
        assertNotUnderRetention(
          state({
            lastAttentionAt: new Date('2026-10-12T21:00:00Z'),
            retentionExtended: 'DOUBLE',
            years,
          }),
          now,
        ),
      );
      expect(body.retentionUntil).toBe(until);
      expect(body.message).toContain(`en retención hasta el ${shown}`);
      expect(body.message).toContain(`(${basis} desde la última atención)`);
      expect(body.message).not.toContain(`${years} años`);
      expect(body.message).not.toMatch(/legal/);
    },
  );

  it('vencida en NONE deja archivar; DOUBLE la sigue reteniendo', () => {
    const old = new Date('2010-01-01T00:00:00Z');
    expect(() =>
      assertNotUnderRetention(state({ lastAttentionAt: old }), now),
    ).not.toThrow();
    expect(
      conflictBody(() =>
        assertNotUnderRetention(
          state({ lastAttentionAt: old, retentionExtended: 'DOUBLE' }),
          now,
        ),
      ).retentionUntil,
    ).toBe('2040-01-01');
  });

  it('el suelo retiene una historia vencida y lo dice', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(
        state({
          lastAttentionAt: new Date('2010-06-15T00:00:00Z'),
          retentionFloorUntil: new Date('2035-06-15T00:00:00Z'),
        }),
        now,
      ),
    );
    expect(body.retentionUntil).toBe('2035-06-15');
    expect(body.message).toContain(
      'en retención hasta el 15/06/2035 (plazo anterior de la clínica): no se puede archivar',
    );
    expect(body.message).not.toMatch(/\d+ años/);
  });

  it('PERMANENT: 409 sin fecha', () => {
    const body = conflictBody(() =>
      assertNotUnderRetention(state({ retentionExtended: 'PERMANENT' }), now),
    );
    expect(body.retentionUntil).toBeNull();
    expect(body.message).toBe(
      'La historia clínica de este paciente tiene retención permanente: no se puede archivar ni borrar. Si necesitas retirar sus datos de contacto, usa la supresión parcial.',
    );
  });
});

describe('assertUnderRetention', () => {
  it('rechaza la supresión parcial si no hay retención', () => {
    const body = conflictBody(() => assertUnderRetention(state({}), now));
    expect(body.code).toBe(NOT_UNDER_RETENTION);
    expect(body.message).toBe(
      'La historia clínica de este paciente no está en retención: no hace falta la supresión parcial, puedes archivar al paciente.',
    );
  });

  it('el plazo de la clínica y el suelo admiten la supresión parcial', () => {
    const lastAttentionAt = new Date('2010-06-15T00:00:00Z');
    expect(() =>
      assertUnderRetention(state({ lastAttentionAt, years: 20 }), now),
    ).not.toThrow();
    expect(() =>
      assertUnderRetention(
        state({
          lastAttentionAt,
          retentionFloorUntil: new Date('2030-06-15T00:00:00Z'),
        }),
        now,
      ),
    ).not.toThrow();
    expect(() =>
      assertUnderRetention(state({ lastAttentionAt, years: 15 }), now),
    ).toThrow(ConflictException);
  });
});

describe('retentionMessage (DX-330)', () => {
  const until = new Date('2035-06-15T00:00:00Z');

  it.each([15, 20])('TERM con N = %i', (years) => {
    expect(retentionMessage(until, 'TERM', years)).toContain(
      `(${years} años desde la última atención)`,
    );
  });

  it('DOUBLE con 2N', () => {
    expect(retentionMessage(until, 'DOUBLE', 20)).toContain(
      '(plazo doble: 40 años desde la última atención)',
    );
  });

  it('PREVIOUS_TERM no dice años', () => {
    expect(retentionMessage(until, 'PREVIOUS_TERM', 20)).toContain(
      '(plazo anterior de la clínica)',
    );
    expect(retentionMessage(until, 'PREVIOUS_TERM', 20)).not.toContain(
      '20 años',
    );
  });

  it('PERMANENT', () => {
    expect(retentionMessage('PERMANENT', 'PERMANENT', 20)).toContain(
      'tiene retención permanente',
    );
  });

  it.each([
    [until, 'TERM'],
    [until, 'DOUBLE'],
    [until, 'PREVIOUS_TERM'],
    ['PERMANENT', 'PERMANENT'],
  ] as const)('sin «legal» (%#)', (date, basis) => {
    expect(retentionMessage(date, basis, 20)).not.toMatch(/legal/);
  });
});
