import {
  CHAIR_NAME_MAX,
  chairAssignmentProblem,
  chairNameError,
  chairOverlapMessage,
  chairSortOrderError,
  normalizeChairName,
  resolveAppointmentProviderId,
  sameChairName,
} from './chair-rules';
import type { Chair } from './entities/chair.entity';

function chair(partial: Partial<Chair> = {}): Chair {
  return {
    id: 'chair-1',
    tenantId: 't1',
    locationId: 'norte',
    name: 'Sillón 1',
    sortOrder: 0,
    defaultProviderId: null,
    active: true,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...partial,
  };
}

describe('reglas del sillón (DX-211)', () => {
  describe('nombre', () => {
    it('acepta de 1 a 40 caracteres y lo recorta', () => {
      expect(chairNameError('  Sillón 1 ')).toBeNull();
      expect(normalizeChairName('  Sillón 1 ')).toBe('Sillón 1');
      expect(chairNameError('x'.repeat(CHAIR_NAME_MAX))).toBeNull();
    });

    it('rechaza vacío, más de 40 caracteres o caracteres de control', () => {
      expect(chairNameError('   ')).toBe(
        'El nombre del sillón no puede estar vacío',
      );
      expect(chairNameError('x'.repeat(CHAIR_NAME_MAX + 1))).toBe(
        'El nombre del sillón no puede tener más de 40 caracteres',
      );
      expect(chairNameError('Sillón\t1')).toBe(
        'El nombre del sillón no puede tener saltos de línea ni tabuladores',
      );
    });

    it('compara nombres sin mayúsculas ni espacios de los extremos', () => {
      expect(sameChairName('Sillón 1', ' sillón 1')).toBe(true);
      expect(sameChairName('Sillón 1', 'Sillón 2')).toBe(false);
    });
  });

  it('el orden es un entero de 0 a 999', () => {
    expect(chairSortOrderError(0)).toBeNull();
    expect(chairSortOrderError(999)).toBeNull();
    expect(chairSortOrderError(1000)).toBe(
      'El orden del sillón debe ser un número entero entre 0 y 999',
    );
    expect(chairSortOrderError(1.5)).not.toBeNull();
  });

  describe('sillón de una cita', () => {
    it('sin sillón (otra clínica o inexistente): 404', () => {
      expect(
        chairAssignmentProblem(null, {
          locationId: 'norte',
          requireActive: true,
        }),
      ).toEqual({ status: 404, message: 'Sillón no encontrado' });
    });

    it('de otra sede: 400, aunque esté activo', () => {
      expect(
        chairAssignmentProblem(chair({ locationId: 'sur' }), {
          locationId: 'norte',
          requireActive: true,
        }),
      ).toEqual({
        status: 400,
        message:
          'El sillón «Sillón 1» es de otra sede: elige un sillón de la sede de la cita',
      });
    });

    it('desactivado: 400 al asignarlo, pero vale si no se exige activo', () => {
      const inactive = chair({ active: false });
      expect(
        chairAssignmentProblem(inactive, {
          locationId: 'norte',
          requireActive: true,
        }),
      ).toEqual({
        status: 400,
        message: 'El sillón «Sillón 1» está desactivado: elige otro sillón',
      });
      expect(
        chairAssignmentProblem(inactive, {
          locationId: 'norte',
          requireActive: false,
        }),
      ).toBeNull();
    });

    it('activo y de la sede: sin problema', () => {
      expect(
        chairAssignmentProblem(chair(), {
          locationId: 'norte',
          requireActive: true,
        }),
      ).toBeNull();
    });
  });

  describe('precedencia del profesional por defecto', () => {
    it('manda el profesional elegido, aunque el sillón tenga otro por defecto', () => {
      expect(
        resolveAppointmentProviderId(
          'dra-elegida',
          chair({ defaultProviderId: 'dr-del-sillon' }),
        ),
      ).toBe('dra-elegida');
    });

    it('sin profesional elegido, el del sillón', () => {
      expect(
        resolveAppointmentProviderId(
          undefined,
          chair({ defaultProviderId: 'dr-del-sillon' }),
        ),
      ).toBe('dr-del-sillon');
    });

    it('sin profesional elegido ni del sillón (o sin sillón): ninguno', () => {
      expect(resolveAppointmentProviderId(undefined, chair())).toBeNull();
      expect(resolveAppointmentProviderId(undefined, null)).toBeNull();
    });
  });

  describe('mensaje del choque', () => {
    it('da el nombre y las horas de la cita que ocupa el sillón', () => {
      expect(
        chairOverlapMessage('Sillón 2', { from: '10:00', to: '10:30' }),
      ).toBe('El sillón «Sillón 2» ya está ocupado de 10:00 a 10:30');
    });

    it('sin la cita que choca (carrera resuelta por la BD): sin horas', () => {
      expect(chairOverlapMessage('Sillón 2', null)).toBe(
        'El sillón «Sillón 2» ya está ocupado en ese horario',
      );
    });
  });
});
