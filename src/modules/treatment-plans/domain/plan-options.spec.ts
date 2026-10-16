import {
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  daysSince,
  defaultOptionLabel,
  hasClosedOption,
  nextOptionLabel,
  normalizeOptionLabel,
  optionSiblingsToReject,
  rejectionBlocker,
  rejectionInputError,
  siblingRejectionBlockedMessage,
} from './plan-options';

const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;

describe('opciones de un plan (DX-040)', () => {
  describe('defaultOptionLabel', () => {
    it('nombra las opciones por letra, en orden de alta', () => {
      expect(defaultOptionLabel(0)).toBe('Opción A');
      expect(defaultOptionLabel(1)).toBe('Opción B');
      expect(defaultOptionLabel(25)).toBe('Opción Z');
    });

    it('pasada la Z sigue con números', () => {
      expect(defaultOptionLabel(26)).toBe('Opción 27');
    });
  });

  describe('normalizeOptionLabel', () => {
    it('recorta espacios y deja null si queda vacía', () => {
      expect(normalizeOptionLabel('  Opción B: puente  ')).toBe(
        'Opción B: puente',
      );
      expect(normalizeOptionLabel('   ')).toBeNull();
      expect(normalizeOptionLabel(undefined)).toBeNull();
      expect(normalizeOptionLabel(null)).toBeNull();
    });
  });

  describe('optionSiblingsToReject', () => {
    it('rechaza las hermanas en borrador o presentadas', () => {
      expect(
        optionSiblingsToReject([
          { id: 'b', status: PRESENTED },
          { id: 'c', status: DRAFT },
          { id: 'd', status: REJECTED },
          { id: 'e', status: CANCELLED },
        ]),
      ).toEqual({ reject: ['b', 'c'], conflict: false });
    });

    it('sin hermanas no hay nada que rechazar', () => {
      expect(optionSiblingsToReject([])).toEqual({
        reject: [],
        conflict: false,
      });
    });

    it.each([ACCEPTED, COMPLETED])(
      'una hermana ya %s es un conflicto (no hay dos opciones aceptadas)',
      (status) => {
        expect(
          optionSiblingsToReject([
            { id: 'b', status },
            { id: 'c', status: DRAFT },
          ]),
        ).toEqual({ reject: ['c'], conflict: true });
      },
    );
  });

  describe('hasClosedOption', () => {
    it('detecta una opción aceptada o completada en el grupo', () => {
      expect(hasClosedOption([{ status: DRAFT }, { status: ACCEPTED }])).toBe(
        true,
      );
      expect(hasClosedOption([{ status: COMPLETED }])).toBe(true);
      expect(
        hasClosedOption([
          { status: DRAFT },
          { status: PRESENTED },
          { status: REJECTED },
          { status: CANCELLED },
        ]),
      ).toBe(false);
    });
  });

  describe('rejectionInputError', () => {
    it.each([
      TreatmentPlanRejectionReason.PRICE,
      TreatmentPlanRejectionReason.FEAR,
      TreatmentPlanRejectionReason.SECOND_OPINION,
    ])('%s vale sin nota', (reason) => {
      expect(rejectionInputError(reason, null)).toBeNull();
    });

    it('OTHER exige una nota', () => {
      expect(
        rejectionInputError(TreatmentPlanRejectionReason.OTHER, '  '),
      ).toBe('Con el motivo «Otro» describe en la nota por qué lo rechazó.');
      expect(
        rejectionInputError(
          TreatmentPlanRejectionReason.OTHER,
          'Prefiere esperar al año que viene',
        ),
      ).toBeNull();
    });

    it('OTHER_OPTION_ACCEPTED lo pone el sistema, no el personal', () => {
      expect(
        rejectionInputError(
          TreatmentPlanRejectionReason.OTHER_OPTION_ACCEPTED,
          null,
        ),
      ).toBe(
        '«Aceptó otra opción» lo registra el sistema al aceptar otra opción del grupo.',
      );
    });

    it('la nota admite hasta 500 caracteres', () => {
      expect(
        rejectionInputError(
          TreatmentPlanRejectionReason.PRICE,
          'a'.repeat(501),
        ),
      ).toBe('La nota del rechazo admite hasta 500 caracteres.');
    });
  });

  describe('daysSince', () => {
    it('cuenta días completos desde la presentación', () => {
      const now = new Date('2026-10-16T12:00:00.000Z');
      expect(daysSince(new Date('2026-10-16T08:00:00.000Z'), now)).toBe(0);
      expect(daysSince(new Date('2026-10-08T12:00:00.000Z'), now)).toBe(8);
      expect(daysSince(new Date('2026-10-08T12:00:01.000Z'), now)).toBe(7);
    });
  });
});

describe('rejectionBlocker', () => {
  it('un plan con trabajo hecho o con abonos no se rechaza', () => {
    expect(
      rejectionBlocker({ hasDoneItems: false, hasLivePayments: false }),
    ).toBeNull();
    expect(
      rejectionBlocker({ hasDoneItems: true, hasLivePayments: false }),
    ).toMatch(/procedimientos realizados/);
    expect(
      rejectionBlocker({ hasDoneItems: false, hasLivePayments: true }),
    ).toMatch(/abonos registrados/);
  });

  it('el 409 de una hermana la nombra (o dice «otra opción del grupo»)', () => {
    expect(siblingRejectionBlockedMessage('Opción B')).toMatch(
      /^La opción «Opción B» tiene abonos/,
    );
    expect(siblingRejectionBlockedMessage(null)).toMatch(
      /^La opción otra opción del grupo/,
    );
  });
});

describe('nextOptionLabel', () => {
  it('la letra siguiente a la mayor usada, sin repetir', () => {
    expect(nextOptionLabel(['Opción A'])).toBe('Opción B');
    expect(nextOptionLabel(['Opción A', 'Opción C'])).toBe('Opción D');
    expect(nextOptionLabel(['Opción A: implante', 'Opción B: puente'])).toBe(
      'Opción C',
    );
  });

  it('sin letras, la que toca por número de opciones (y nunca una usada)', () => {
    expect(nextOptionLabel(['Implante'])).toBe('Opción B');
    expect(nextOptionLabel(['Implante', 'Opción C'])).toBe('Opción D');
    expect(nextOptionLabel(['Implante', 'Puente'])).toBe('Opción C');
  });
});
