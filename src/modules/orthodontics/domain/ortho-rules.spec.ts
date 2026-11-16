import {
  ORTHO_DEFAULT_WIRE_GAUGES,
  ORTHO_MESSAGES,
  acceptsVisits,
  canTransition,
  caseProgress,
  composeVisitNote,
  daysSinceLastVisit,
  isOverdue,
  validateCasePlan,
  validateNextVisit,
  validateStatusChange,
  validateVisit,
  validateWireGauges,
  wholeMonthsBetween,
  wholePercent,
} from './ortho-rules';

const TODAY = '2026-11-16';
const GAUGES = [...ORTHO_DEFAULT_WIRE_GAUGES];

describe('DX-190 · reglas de ortodoncia', () => {
  describe('progreso', () => {
    it('24 meses y 24 controles con 3 registrados: 3/24 (12 %)', () => {
      const p = caseProgress(
        { startDate: '2026-08-10', plannedVisits: 24, estimatedMonths: 24 },
        3,
        TODAY,
      );
      expect(p).toEqual({
        visitsDone: 3,
        plannedVisits: 24,
        monthsElapsed: 3,
        estimatedMonths: 24,
        percent: 12,
      });
    });

    it('el porcentaje no pasa de 100 con más controles que los previstos', () => {
      expect(
        caseProgress(
          { startDate: '2025-01-01', plannedVisits: 2, estimatedMonths: 6 },
          5,
          TODAY,
        ).percent,
      ).toBe(100);
    });

    it.each([
      [0, 24, 0],
      [3, 24, 12],
      [23, 24, 95],
      [24, 24, 100],
      [30, 24, 100],
    ])('%i de %i controles: %i %%', (part, whole, pct) => {
      expect(wholePercent(part, whole)).toBe(pct);
    });

    it.each([
      ['2026-10-16', '2026-11-16', 1],
      ['2026-10-17', '2026-11-16', 0],
      ['2024-11-16', '2026-11-16', 24],
      ['2026-01-31', '2026-02-28', 0],
      ['2026-11-16', '2026-11-16', 0],
      ['2026-12-01', '2026-11-16', 0],
    ])('meses completos de %s a %s: %i', (from, to, months) => {
      expect(wholeMonthsBetween(from, to)).toBe(months);
    });
  });

  describe('«Atrasado» (intervalo + 15 días)', () => {
    it('último control hace 50 días con intervalo 30: atrasado', () => {
      expect(daysSinceLastVisit('2026-09-27', '2026-01-10', TODAY)).toBe(50);
      expect(isOverdue('2026-09-27', '2026-01-10', 30, TODAY)).toBe(true);
    });

    it('justo en intervalo + 15 (45 días) aún no; a los 46 sí', () => {
      expect(isOverdue('2026-10-02', '2026-01-10', 30, TODAY)).toBe(false);
      expect(isOverdue('2026-10-01', '2026-01-10', 30, TODAY)).toBe(true);
    });

    it('sin controles cuenta desde el inicio del caso', () => {
      expect(isOverdue(null, '2026-11-01', 30, TODAY)).toBe(false);
      expect(isOverdue(null, '2026-09-01', 30, TODAY)).toBe(true);
    });

    it('un control con fecha de hoy da 0 días', () => {
      expect(daysSinceLastVisit(TODAY, '2026-01-10', TODAY)).toBe(0);
    });
  });

  describe('estados del caso', () => {
    it.each([
      ['ACTIVE', 'RETENTION', true],
      ['ACTIVE', 'FINISHED', true],
      ['ACTIVE', 'ABANDONED', true],
      ['RETENTION', 'FINISHED', true],
      ['RETENTION', 'ABANDONED', true],
      ['RETENTION', 'ACTIVE', false],
      ['FINISHED', 'ACTIVE', false],
      ['FINISHED', 'RETENTION', false],
      ['ABANDONED', 'ACTIVE', false],
      ['ACTIVE', 'ACTIVE', false],
    ] as const)('%s → %s: %s', (from, to, ok) => {
      expect(canTransition(from, to)).toBe(ok);
    });

    it('abandonar exige motivo; finalizar no', () => {
      expect(validateStatusChange('ACTIVE', 'ABANDONED', '  ')).toEqual({
        ok: false,
        message: 'Indica el motivo del abandono del caso.',
      });
      expect(
        validateStatusChange('ACTIVE', 'ABANDONED', ' Se mudó de ciudad '),
      ).toEqual({ ok: true, value: { reason: 'Se mudó de ciudad' } });
      expect(validateStatusChange('ACTIVE', 'FINISHED', undefined)).toEqual({
        ok: true,
        value: { reason: null },
      });
    });

    it('una transición no permitida da un mensaje en español', () => {
      expect(validateStatusChange('FINISHED', 'ACTIVE', null)).toEqual({
        ok: false,
        message: 'Un caso finalizado no puede pasar a activo.',
      });
    });

    it('el motivo admite de 3 a 500 caracteres', () => {
      expect(validateStatusChange('ACTIVE', 'FINISHED', 'ok').ok).toBe(false);
      expect(
        validateStatusChange('ACTIVE', 'FINISHED', 'x'.repeat(501)).ok,
      ).toBe(false);
    });

    it('solo un caso activo o en retención admite controles', () => {
      expect(acceptsVisits('ACTIVE')).toBe(true);
      expect(acceptsVisits('RETENTION')).toBe(true);
      expect(acceptsVisits('FINISHED')).toBe(false);
      expect(acceptsVisits('ABANDONED')).toBe(false);
    });
  });

  describe('planificación', () => {
    it('alta válida con el intervalo de 30 días por defecto', () => {
      expect(
        validateCasePlan(
          {
            technique: 'METAL_BRACKETS',
            startDate: '2026-11-02',
            estimatedMonths: 24,
            plannedVisits: 24,
          },
          TODAY,
        ),
      ).toEqual({
        ok: true,
        value: {
          technique: 'METAL_BRACKETS',
          startDate: '2026-11-02',
          estimatedMonths: 24,
          plannedVisits: 24,
          visitIntervalDays: 30,
          bondedOn: null,
          debondedOn: null,
        },
      });
    });

    it('enumera todos los fallos en un mensaje', () => {
      const r = validateCasePlan(
        {
          startDate: '2026-12-01',
          estimatedMonths: 0,
          plannedVisits: 241,
          visitIntervalDays: 3,
          bondedOn: '2026-11-10',
          debondedOn: '2026-11-01',
        },
        TODAY,
      );
      expect(r).toEqual({
        ok: false,
        message:
          'Indica la técnica. La fecha de inicio no puede ser futura. La duración estimada va de 1 a 120 meses. Los controles previstos van de 1 a 240. El intervalo entre controles va de 7 a 180 días. El retiro no puede ser anterior al cementado.',
      });
    });

    it('en una edición conserva lo que no llega', () => {
      const current = {
        technique: 'ALIGNERS' as const,
        startDate: '2026-05-01',
        estimatedMonths: 18,
        plannedVisits: 12,
        visitIntervalDays: 45,
        bondedOn: null,
        debondedOn: null,
      };
      expect(validateCasePlan({ plannedVisits: 14 }, TODAY, current)).toEqual({
        ok: true,
        value: { ...current, plannedVisits: 14 },
      });
    });
  });

  describe('control', () => {
    it('arcos, elásticos, incidencias e higiene', () => {
      const r = validateVisit(
        {
          upperWire: { material: 'NITI', gauge: ' 0.016 ' },
          lowerWire: { material: 'STEEL', gauge: '0.016x0.022' },
          elasticsType: 'CLASS_II',
          elasticsWear: 'FULL_TIME',
          incidents: ['BRACKET_DEBONDED', 'BRACKET_DEBONDED'],
          hygieneIndex: 2,
          note: '  Paciente colaborador  ',
        },
        GAUGES,
      );
      expect(r).toEqual({
        ok: true,
        value: {
          upperWire: { material: 'NITI', gauge: '0.016' },
          lowerWire: { material: 'STEEL', gauge: '0.016x0.022' },
          elasticsType: 'CLASS_II',
          elasticsWear: 'FULL_TIME',
          applianceChanges: null,
          incidents: ['BRACKET_DEBONDED'],
          hygieneIndex: 2,
          note: 'Paciente colaborador',
          nextVisitProposedOn: null,
        },
      });
    });

    it('un calibre fuera de la lista de la clínica, un arco a medias y el uso sin tipo', () => {
      expect(
        validateVisit(
          {
            upperWire: { material: 'NITI', gauge: '0.099' },
            lowerWire: { material: 'TMA' },
            elasticsWear: 'NIGHT',
          },
          GAUGES,
        ),
      ).toEqual({
        ok: false,
        message:
          'El calibre «0.099» del arco superior no está en la lista de la clínica. El arco inferior necesita material y calibre. Indica el tipo de elásticos además de su uso.',
      });
    });

    it('un control vacío no se guarda', () => {
      expect(validateVisit({ note: '   ' }, GAUGES)).toEqual({
        ok: false,
        message: ORTHO_MESSAGES.emptyVisit,
      });
    });

    it('el próximo control: posterior y como mucho a un año', () => {
      expect(validateNextVisit(null, TODAY)).toBeNull();
      expect(validateNextVisit('2026-12-16', TODAY)).toBeNull();
      expect(validateNextVisit(TODAY, TODAY)).toMatch(/posterior/);
      expect(validateNextVisit('2027-11-17', TODAY)).toMatch(/un año/);
    });

    it('la evolución lleva el texto de lo registrado', () => {
      const r = validateVisit(
        {
          upperWire: { material: 'NITI', gauge: '0.014' },
          elasticsType: 'CLASS_III',
          elasticsWear: 'NIGHT',
          applianceChanges: 'Se añade botón en 36',
          incidents: ['WIRE_DAMAGED'],
          hygieneIndex: 3,
          note: 'Refuerzo de higiene',
          nextVisitProposedOn: '2026-12-16',
        },
        GAUGES,
      );
      if (!r.ok) throw new Error(r.message);
      expect(composeVisitNote(r.value)).toBe(
        [
          'Control de ortodoncia.',
          'Arco superior: NiTi 0.014.',
          'Elásticos: Clase III (solo de noche).',
          'Aparatología: Se añade botón en 36',
          'Incidencias: Arco dañado.',
          'Higiene: 3/4 (deficiente).',
          'Próximo control propuesto: 2026-12-16.',
          '',
          'Refuerzo de higiene',
        ].join('\n'),
      );
    });
  });

  describe('calibres de la clínica', () => {
    it('recorta, conserva el orden y rechaza repetidos o vacíos', () => {
      expect(validateWireGauges([' 0.014', '0.016x0.022 '])).toEqual({
        ok: true,
        value: ['0.014', '0.016x0.022'],
      });
      for (const bad of [
        [],
        ['0.014', '0.014'],
        [''],
        ['x'.repeat(21)],
        ['0.01\t4'],
        'no',
        Array.from({ length: 41 }, (_, i) => `g${i}`),
      ]) {
        expect(validateWireGauges(bad).ok).toBe(false);
      }
    });
  });
});
