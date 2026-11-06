import { BadRequestException } from '@nestjs/common';
import {
  EQUIPMENT_DUE_SOON_DAYS,
  maintenanceStatus,
  nextMaintenanceOn,
  resolveMaintenanceNextDue,
  validateEquipmentFields,
  validateMaintenanceFields,
  validateReason,
} from './equipment-rules';

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return (error.getResponse() as { message: string }).message;
    }
    throw error;
  }
  throw new Error('no lanzó');
}

describe('reglas de los equipos (DX-542)', () => {
  const TODAY = '2026-11-06';

  describe('validateEquipmentFields', () => {
    it('normaliza los textos y convierte los vacíos en null', () => {
      expect(
        validateEquipmentFields(
          {
            name: '  Autoclave   Sala 1 ',
            brand: '  ',
            model: 'B-17',
            serialNumber: ' SN 001 ',
            sanitaryRegistration: '',
            notes: ' línea 1\nlínea 2 ',
            acquiredOn: '2024-02-01',
            maintenanceIntervalMonths: 6,
          },
          TODAY,
        ),
      ).toEqual({
        name: 'Autoclave Sala 1',
        brand: null,
        model: 'B-17',
        serialNumber: 'SN 001',
        sanitaryRegistration: null,
        notes: 'línea 1\nlínea 2',
        acquiredOn: '2024-02-01',
        maintenanceIntervalMonths: 6,
      });
    });

    it('reúne todos los errores en un solo mensaje', () => {
      expect(
        message(() =>
          validateEquipmentFields(
            {
              name: ' ',
              acquiredOn: '2026-11-07',
              maintenanceIntervalMonths: 0,
            },
            TODAY,
          ),
        ),
      ).toBe(
        'Escribe el nombre del equipo (hasta 120 caracteres). La fecha de adquisición no puede ser futura. La periodicidad del mantenimiento va de 1 a 120 meses.',
      );
    });

    it('rechaza fechas que no existen y caracteres de control', () => {
      expect(
        message(() =>
          validateEquipmentFields(
            { name: 'Lámpara\u0007', acquiredOn: '2026-02-30' },
            TODAY,
          ),
        ),
      ).toBe(
        'El nombre del equipo tiene caracteres no permitidos. La fecha de adquisición no es válida (AAAA-MM-DD).',
      );
    });

    it('solo valida lo que llega en una edición parcial', () => {
      expect(
        validateEquipmentFields({ maintenanceIntervalMonths: null }, TODAY),
      ).toEqual({ maintenanceIntervalMonths: null });
    });
  });

  describe('validateMaintenanceFields', () => {
    it('exige descripción y fecha no futura; el costo va con su moneda', () => {
      expect(
        message(() =>
          validateMaintenanceFields(
            { performedOn: '2026-11-07', description: '', cost: 10 },
            TODAY,
          ),
        ),
      ).toBe(
        'La fecha del mantenimiento no puede ser futura. Describe qué se hizo (hasta 2000 caracteres). Indica la moneda del costo.',
      );
      expect(
        message(() =>
          validateMaintenanceFields(
            { performedOn: TODAY, description: 'Ok', currency: 'USD' },
            TODAY,
          ),
        ),
      ).toBe('La moneda solo va con un costo.');
    });

    it('el próximo explícito va después del mantenimiento', () => {
      expect(
        message(() =>
          validateMaintenanceFields(
            {
              performedOn: '2026-10-01',
              description: 'Revisión',
              nextDueOn: '2026-10-01',
            },
            TODAY,
          ),
        ),
      ).toBe('El próximo mantenimiento tiene que ser posterior a este.');
    });

    it('el próximo explícito no va a más de 10 años', () => {
      expect(
        message(() =>
          validateMaintenanceFields(
            {
              performedOn: '2026-10-01',
              description: 'Revisión',
              nextDueOn: '2036-10-02',
            },
            TODAY,
          ),
        ),
      ).toBe('El próximo mantenimiento no puede ser a más de 10 años de este.');
      expect(
        validateMaintenanceFields(
          {
            performedOn: '2026-10-01',
            description: 'Revisión',
            nextDueOn: '2036-10-01',
          },
          TODAY,
        ).nextDueOn,
      ).toBe('2036-10-01');
    });

    it('la fecha no es anterior a la adquisición del equipo', () => {
      expect(
        message(() =>
          validateMaintenanceFields(
            { performedOn: '2025-12-31', description: 'Revisión' },
            TODAY,
            '2026-01-01',
          ),
        ),
      ).toBe(
        'La fecha del mantenimiento no puede ser anterior a la adquisición del equipo.',
      );
      expect(
        validateMaintenanceFields(
          { performedOn: '2026-01-01', description: 'Revisión' },
          TODAY,
          '2026-01-01',
        ).performedOn,
      ).toBe('2026-01-01');
    });

    it('acepta un costo con hasta 2 decimales y normaliza la moneda', () => {
      expect(
        validateMaintenanceFields(
          {
            performedOn: '2026-10-01',
            description: ' Cambio de empaque ',
            technician: ' Luis ',
            company: '',
            cost: 120.5,
            currency: 'usd',
          },
          TODAY,
        ),
      ).toEqual({
        performedOn: '2026-10-01',
        description: 'Cambio de empaque',
        technician: 'Luis',
        company: null,
        cost: 120.5,
        currency: 'USD',
        nextDueOn: null,
      });
      expect(
        message(() =>
          validateMaintenanceFields(
            {
              performedOn: '2026-10-01',
              description: 'x',
              cost: 1.234,
              currency: 'USD',
            },
            TODAY,
          ),
        ),
      ).toBe(
        'El costo tiene que ser mayor que 0 y con 2 decimales como mucho.',
      );
    });
  });

  describe('validateReason', () => {
    it('de 3 a 500 caracteres', () => {
      expect(validateReason('  Se dañó  ', 'baja')).toBe('Se dañó');
      expect(message(() => validateReason('no', 'baja'))).toBe(
        'Escribe el motivo de la baja (de 3 a 500 caracteres).',
      );
    });
  });

  describe('resolveMaintenanceNextDue', () => {
    it('un preventivo suma la periodicidad (recortando a fin de mes)', () => {
      expect(
        resolveMaintenanceNextDue('PREVENTIVE', '2026-08-31', null, 6),
      ).toBe('2027-02-28');
    });

    it('la fecha explícita manda', () => {
      expect(
        resolveMaintenanceNextDue('PREVENTIVE', '2026-08-31', '2026-12-01', 6),
      ).toBe('2026-12-01');
      expect(
        resolveMaintenanceNextDue('CALIBRATION', '2026-08-31', '2027-08-31', 6),
      ).toBe('2027-08-31');
    });

    it('sin periodicidad o en un correctivo no hay próximo calculado', () => {
      expect(
        resolveMaintenanceNextDue('PREVENTIVE', '2026-08-31', null, null),
      ).toBeNull();
      expect(
        resolveMaintenanceNextDue('CORRECTIVE', '2026-08-31', null, 6),
      ).toBeNull();
    });
  });

  describe('nextMaintenanceOn', () => {
    it('el último preventivo vivo manda', () => {
      expect(
        nextMaintenanceOn({
          acquiredOn: '2024-01-15',
          maintenanceIntervalMonths: 6,
          lastPreventive: {
            performedOn: '2026-05-10',
            nextDueOn: '2026-11-10',
          },
        }),
      ).toBe('2026-11-10');
    });

    it('un preventivo sin próximo usa la periodicidad actual', () => {
      expect(
        nextMaintenanceOn({
          acquiredOn: null,
          maintenanceIntervalMonths: 12,
          lastPreventive: { performedOn: '2026-05-10', nextDueOn: null },
        }),
      ).toBe('2027-05-10');
    });

    it('sin preventivos cuenta desde la adquisición', () => {
      expect(
        nextMaintenanceOn({
          acquiredOn: '2026-01-31',
          maintenanceIntervalMonths: 1,
          lastPreventive: null,
        }),
      ).toBe('2026-02-28');
    });

    it('sin periodicidad ni próximo: sin programar', () => {
      expect(
        nextMaintenanceOn({
          acquiredOn: '2026-01-31',
          maintenanceIntervalMonths: null,
          lastPreventive: null,
        }),
      ).toBeNull();
    });
  });

  describe('maintenanceStatus', () => {
    it('vencido, próximo (≤30 días), al día o sin programar', () => {
      expect(EQUIPMENT_DUE_SOON_DAYS).toBe(30);
      expect(maintenanceStatus('2026-11-05', TODAY)).toBe('OVERDUE');
      expect(maintenanceStatus(TODAY, TODAY)).toBe('DUE_SOON');
      expect(maintenanceStatus('2026-12-06', TODAY)).toBe('DUE_SOON');
      expect(maintenanceStatus('2026-12-07', TODAY)).toBe('UP_TO_DATE');
      expect(maintenanceStatus(null, TODAY)).toBe('UNSCHEDULED');
    });
  });
});
