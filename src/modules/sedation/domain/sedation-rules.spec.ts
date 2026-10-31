import {
  agentProblems,
  assessmentProblems,
  bodyMassIndex,
  buildChecklistItems,
  buildDischargeCriteria,
  checklistProblems,
  dischargeProblems,
  reversalDoses,
  vitalsProblems,
  vitalsWatch,
  type SedationAssessmentInput,
  type SedationDischargeInput,
} from './sedation-rules';
import { PLATFORM_SEDATION_TEMPLATE as T } from './sedation-template';

const OPERATOR = 'op';
const MONITOR = 'mon';

function assessment(
  overrides: Partial<SedationAssessmentInput> = {},
): SedationAssessmentInput {
  return {
    grade: 'MINIMAL',
    asaClass: 'I',
    asaEmergency: false,
    fastingClearLiquidsHours: 2,
    fastingSolidsHours: 6,
    mallampati: 1,
    weightKg: 20,
    heightCm: 115,
    escortName: 'Laura Ortiz',
    escortRelationship: 'Madre',
    consentConfirmed: true,
    ...overrides,
  };
}

const allCriteria = () =>
  T.dischargeCriteria.map((c) => ({ code: c.code, met: true }));

const goodVitals = {
  spo2: 98,
  heartRate: 90,
  systolic: 100,
  diastolic: 65,
  respiratoryRate: 18,
  sedationLevel: 'AWAKE' as const,
};

function discharge(
  overrides: Partial<SedationDischargeInput> = {},
): SedationDischargeInput {
  return {
    criteria: allCriteria(),
    vitals: goodVitals,
    handedOverToName: 'Laura Ortiz',
    handedOverToRelationship: 'Madre',
    instructionsDelivered: true,
    monitorId: MONITOR,
    ...overrides,
  };
}

const at = (min: number) => new Date(Date.UTC(2026, 9, 30, 15, min));

describe('reglas de la hoja de sedación (DX-407)', () => {
  describe('IMC y reversores por peso', () => {
    it('IMC = kg / m², a un decimal; sin peso o talla, null', () => {
      expect(bodyMassIndex(20, 115)).toBe(15.1);
      expect(bodyMassIndex(70, 175)).toBe(22.9);
      expect(bodyMassIndex(null, 175)).toBeNull();
      expect(bodyMassIndex(70, null)).toBeNull();
    });

    it('naloxona 0,1 mg/kg (máx. 2 mg) y flumazenil 0,01 mg/kg (máx. 0,2 mg)', () => {
      expect(reversalDoses(15)).toEqual({
        naloxoneMg: 1.5,
        flumazenilMg: 0.15,
      });
      expect(reversalDoses(18.5)).toEqual({
        naloxoneMg: 1.85,
        flumazenilMg: 0.185,
      });
      // Topes: a partir de 20 kg los dos llegan al máximo.
      expect(reversalDoses(20)).toEqual({ naloxoneMg: 2, flumazenilMg: 0.2 });
      expect(reversalDoses(70)).toEqual({ naloxoneMg: 2, flumazenilMg: 0.2 });
      expect(reversalDoses(null)).toBeNull();
    });
  });

  describe('valoración previa', () => {
    it('completa: sin problemas', () => {
      expect(assessmentProblems(assessment(), T)).toEqual([]);
    });

    it('la plantilla exige ASA, ayuno, Mallampati, peso, talla, acompañante y consentimiento', () => {
      const problems = assessmentProblems(
        {
          grade: 'MINIMAL',
          asaEmergency: false,
          consentConfirmed: false,
        },
        T,
      );
      expect(problems.map((p) => p.code)).toEqual([
        'ASA',
        'FASTING',
        'MALLAMPATI',
        'WEIGHT',
        'HEIGHT',
        'ESCORT',
        'CONSENT',
      ]);
      expect(problems.every((p) => p.message.length > 0)).toBe(true);
    });

    it('ayuno incompleto o acompañante sin relación también faltan', () => {
      const problems = assessmentProblems(
        assessment({ fastingSolidsHours: undefined, escortRelationship: ' ' }),
        T,
      );
      expect(problems.map((p) => p.code)).toEqual(['FASTING', 'ESCORT']);
    });

    it.each(['III', 'IV', 'V'] as const)(
      'ASA %s exige interconsulta o justificación',
      (asa) => {
        expect(
          assessmentProblems(assessment({ asaClass: asa }), T).map(
            (p) => p.code,
          ),
        ).toEqual(['HIGH_ASA_REASON']);
        expect(
          assessmentProblems(
            assessment({
              asaClass: asa,
              highAsaInterconsultation: 'Pediatra: apto para sedación mínima',
            }),
            T,
          ),
        ).toEqual([]);
        expect(
          assessmentProblems(
            assessment({
              asaClass: asa,
              highAsaJustification: 'Asma controlada, sin crisis en 1 año',
            }),
            T,
          ),
        ).toEqual([]);
      },
    );

    it('peso y talla que dan un IMC imposible se rechazan (no llegan a la BD)', () => {
      expect(
        assessmentProblems(assessment({ weightKg: 200, heightCm: 50 }), T).map(
          (p) => p.code,
        ),
      ).toEqual(['BMI_IMPLAUSIBLE']);
      expect(
        assessmentProblems(assessment({ weightKg: 3, heightCm: 250 }), T).map(
          (p) => p.code,
        ),
      ).toEqual(['BMI_IMPLAUSIBLE']);
      // Un lactante de 3,5 kg y 50 cm (IMC 14) es válido.
      expect(
        assessmentProblems(assessment({ weightKg: 3.5, heightCm: 50 }), T),
      ).toEqual([]);
    });

    it('una justificación de menos de 10 caracteres no cuenta', () => {
      expect(
        assessmentProblems(
          assessment({ asaClass: 'III', highAsaJustification: 'ok' }),
          T,
        ).map((p) => p.code),
      ).toEqual(['HIGH_ASA_REASON']);
    });

    it('una plantilla que no exige Mallampati ni talla no los pide', () => {
      const relaxed = {
        ...T,
        requiredAssessment: T.requiredAssessment.filter(
          (f) => f !== 'MALLAMPATI' && f !== 'HEIGHT',
        ),
      };
      expect(
        assessmentProblems(
          assessment({ mallampati: undefined, heightCm: undefined }),
          relaxed,
        ),
      ).toEqual([]);
    });
  });

  describe('checklist previo', () => {
    const marks = (unchecked: string[] = []) =>
      T.checklist.map((i) => ({
        code: i.code,
        checked: !unchecked.includes(i.code),
      }));

    it('todos los obligatorios marcados: sin problemas; el opcional puede ir sin marcar', () => {
      expect(checklistProblems(marks(['TWO_ADULTS_TRANSPORT']), T)).toEqual([]);
    });

    it('falta un obligatorio (o no viene): lo dice por su texto', () => {
      const problems = checklistProblems(
        marks(['REVERSAL_AGENTS']).filter((m) => m.code !== 'EMERGENCY_KIT'),
        T,
      );
      expect(problems.map((p) => p.code)).toEqual([
        'EMERGENCY_KIT',
        'REVERSAL_AGENTS',
      ]);
      expect(problems[1].message).toContain('Reversores');
    });

    it('un ítem que la plantilla no tiene se rechaza', () => {
      expect(
        checklistProblems([...marks(), { code: 'X', checked: true }], T).map(
          (p) => p.code,
        ),
      ).toEqual(['UNKNOWN_ITEM']);
    });

    it('la copia guarda el texto de la plantilla y la marca de cada ítem', () => {
      const items = buildChecklistItems(marks(['TWO_ADULTS_TRANSPORT']), T);
      expect(items).toHaveLength(T.checklist.length);
      expect(items[0]).toEqual({
        code: 'MONITORS_TESTED',
        label: T.checklist[0].label,
        checked: true,
      });
      expect(items.at(-1)?.checked).toBe(false);
    });
  });

  describe('constantes', () => {
    it('completas: sin problemas; el CO2 es opcional', () => {
      expect(vitalsProblems(goodVitals, T)).toEqual([]);
    });

    it('faltan las obligatorias de la plantilla', () => {
      expect(vitalsProblems({ spo2: 97 }, T).map((p) => p.code)).toEqual([
        'HEART_RATE',
        'BLOOD_PRESSURE',
        'RESPIRATORY_RATE',
        'SEDATION_LEVEL',
      ]);
    });

    it('la TA va completa y la diastólica por debajo de la sistólica', () => {
      expect(
        vitalsProblems({ ...goodVitals, diastolic: undefined }, T).map(
          (p) => p.code,
        ),
      ).toEqual(['BLOOD_PRESSURE']);
      expect(
        vitalsProblems({ ...goodVitals, systolic: 80, diastolic: 90 }, T).map(
          (p) => p.code,
        ),
      ).toEqual(['BLOOD_PRESSURE_ORDER']);
    });
  });

  describe('aviso de intervalo sin toma', () => {
    const base = {
      intervalMinutes: 5,
      checklistDone: true,
      discharged: false,
      agentTimes: [at(0)],
      vitals: [
        { phase: 'BASELINE' as const, takenAt: at(-10) },
        { phase: 'INTRA' as const, takenAt: at(4) },
      ],
    };

    it('sin sedación en curso (sin fármaco ni toma intraoperatoria) no vigila', () => {
      const watch = vitalsWatch(
        { ...base, agentTimes: [], vitals: [base.vitals[0]] },
        at(30),
      );
      expect(watch).toMatchObject({ active: false, overdue: false });
      expect(watch.nextDueAt).toBeNull();
    });

    it('dentro del intervalo: la próxima toma vence 5 min después de la última', () => {
      const watch = vitalsWatch(base, at(8));
      expect(watch).toMatchObject({
        active: true,
        overdue: false,
        overdueMinutes: 0,
        intervalMinutes: 5,
      });
      expect(watch.startedAt).toEqual(at(0));
      expect(watch.lastTakenAt).toEqual(at(4));
      expect(watch.nextDueAt).toEqual(at(9));
    });

    it('pasado el intervalo sin toma: avisa con los minutos de retraso', () => {
      const watch = vitalsWatch(base, at(12));
      expect(watch).toMatchObject({ overdue: true, overdueMinutes: 3 });
    });

    it('sin tomas desde el primer fármaco, el intervalo cuenta desde él', () => {
      const watch = vitalsWatch({ ...base, vitals: [base.vitals[0]] }, at(6));
      expect(watch.nextDueAt).toEqual(at(5));
      expect(watch.overdue).toBe(true);
    });

    it('cuenta los intervalos vencidos sin toma, no los huecos', () => {
      const watch = vitalsWatch(
        {
          ...base,
          vitals: [
            { phase: 'INTRA', takenAt: at(4) },
            { phase: 'INTRA', takenAt: at(9) },
            { phase: 'INTRA', takenAt: at(20) },
          ],
        },
        at(21),
      );
      // 0→4 y 4→9 caben en 5 min; en 9→20 vencieron sin toma las de los
      // minutos 14 y 19.
      expect(watch.missedIntervals).toBe(2);
    });

    it('un hueco de 20 min con intervalo de 5 son 3 intervalos vencidos (la toma del minuto 20 llega a su hora)', () => {
      const watch = vitalsWatch(
        { ...base, vitals: [{ phase: 'INTRA', takenAt: at(20) }] },
        at(21),
      );
      // Vencían a los 5, 10, 15 y 20: la del 20 se hizo justo a tiempo.
      expect(watch.missedIntervals).toBe(3);
    });

    it('un hueco de 21 min ya son 4 intervalos vencidos; uno de 10 exactos, 1', () => {
      expect(
        vitalsWatch(
          { ...base, vitals: [{ phase: 'INTRA', takenAt: at(21) }] },
          at(22),
        ).missedIntervals,
      ).toBe(4);
      expect(
        vitalsWatch(
          { ...base, vitals: [{ phase: 'INTRA', takenAt: at(10) }] },
          at(11),
        ).missedIntervals,
      ).toBe(1);
    });

    it('una toma con hora posterior a cuando se registró cuenta desde que se registró (no aplaza el aviso)', () => {
      // A los 8 min se anota una toma «de las 12» (reloj adelantado o error
      // al teclear): la próxima vence a los 13, no a los 17.
      const watch = vitalsWatch(
        {
          ...base,
          vitals: [{ phase: 'INTRA', takenAt: at(12), recordedAt: at(8) }],
        },
        at(14),
      );
      expect(watch.nextDueAt).toEqual(at(13));
      expect(watch).toMatchObject({ overdue: true, overdueMinutes: 1 });
      // Un fármaco con hora futura tampoco retrasa el inicio.
      const agent = vitalsWatch(
        {
          ...base,
          agentTimes: [{ at: at(4), recordedAt: at(0) }],
          vitals: [],
        },
        at(6),
      );
      expect(agent.startedAt).toEqual(at(0));
      expect(agent.overdue).toBe(true);
    });

    it('con el egreso firmado deja de vigilar', () => {
      expect(vitalsWatch({ ...base, discharged: true }, at(60))).toMatchObject({
        active: false,
        overdue: false,
      });
    });
  });

  describe('fármacos', () => {
    it('N2O: % (10–70) y flujo (hasta 15 l/min), sin dosis', () => {
      expect(
        agentProblems({ kind: 'NITROUS_OXIDE', n2oPercent: 30, flowLpm: 6 }),
      ).toEqual([]);
      expect(
        agentProblems({ kind: 'NITROUS_OXIDE', n2oPercent: 30 }).map(
          (p) => p.code,
        ),
      ).toEqual(['N2O_FLOW']);
      expect(
        agentProblems({
          kind: 'NITROUS_OXIDE',
          n2oPercent: 30,
          flowLpm: 6,
          drugName: 'Midazolam',
        }).map((p) => p.code),
      ).toEqual(['N2O_SHAPE']);
    });

    it('oral: fármaco, dosis y unidad, por vía oral o sublingual', () => {
      expect(
        agentProblems({
          kind: 'ORAL',
          drugName: 'Midazolam',
          dose: 7.5,
          doseUnit: 'MG',
          route: 'ORAL',
        }),
      ).toEqual([]);
      expect(
        agentProblems({
          kind: 'ORAL',
          drugName: 'Midazolam',
          dose: 7.5,
          doseUnit: 'MG',
          route: 'INTRANASAL',
        }).map((p) => p.code),
      ).toEqual(['ORAL_ROUTE']);
      expect(
        agentProblems({ kind: 'OTHER', drugName: 'Midazolam' }).map(
          (p) => p.code,
        ),
      ).toEqual(['DOSE', 'ROUTE']);
    });
  });

  describe('egreso', () => {
    const ctx = {
      grade: 'MINIMAL' as const,
      operatorId: OPERATOR,
      lastEventAt: at(20),
      dischargedAt: at(40),
    };

    it('con los 6 criterios, constantes, entrega e indicaciones: sin problemas', () => {
      expect(dischargeProblems(discharge(), T, ctx)).toEqual([]);
    });

    it('sin todos los criterios ni Aldrete no se cierra', () => {
      const criteria = allCriteria();
      criteria[2].met = false;
      expect(
        dischargeProblems(discharge({ criteria }), T, ctx).map((p) => p.code),
      ).toEqual(['DISCHARGE_CRITERIA']);
    });

    it('Aldrete modificado ≥ 9 sustituye a los criterios; 8 no', () => {
      expect(
        dischargeProblems(discharge({ criteria: [], aldreteScore: 9 }), T, ctx),
      ).toEqual([]);
      expect(
        dischargeProblems(
          discharge({ criteria: [], aldreteScore: 8 }),
          T,
          ctx,
        ).map((p) => p.code),
      ).toEqual(['ALDRETE_BELOW_MINIMUM']);
    });

    it('un Aldrete anotado por debajo del mínimo impide el alta aunque se marquen los criterios', () => {
      expect(
        dischargeProblems(discharge({ aldreteScore: 7 }), T, ctx).map(
          (p) => p.code,
        ),
      ).toEqual(['ALDRETE_BELOW_MINIMUM']);
      expect(
        dischargeProblems(discharge({ aldreteScore: 10 }), T, ctx),
      ).toEqual([]);
    });

    it('no se da el alta con el paciente en sedación moderada o profunda', () => {
      for (const sedationLevel of ['MODERATE', 'DEEP'] as const) {
        expect(
          dischargeProblems(
            discharge({ vitals: { ...goodVitals, sedationLevel } }),
            T,
            ctx,
          ).map((p) => p.code),
        ).toEqual(['DISCHARGE_SEDATION_LEVEL']);
      }
      expect(
        dischargeProblems(
          discharge({ vitals: { ...goodVitals, sedationLevel: 'MINIMAL' } }),
          T,
          ctx,
        ),
      ).toEqual([]);
    });

    it('exige constantes al alta, a quién se entrega e indicaciones entregadas', () => {
      const problems = dischargeProblems(
        discharge({
          vitals: { spo2: 98 },
          handedOverToName: '',
          instructionsDelivered: false,
        }),
        T,
        ctx,
      );
      expect(problems.map((p) => p.code)).toEqual([
        'HEART_RATE',
        'BLOOD_PRESSURE',
        'RESPIRATORY_RATE',
        'SEDATION_LEVEL',
        'HANDED_OVER_TO',
        'INSTRUCTIONS',
      ]);
    });

    it('la hora de egreso no puede ser anterior a la última toma o fármaco', () => {
      expect(
        dischargeProblems(discharge(), T, {
          ...ctx,
          dischargedAt: at(10),
        }).map((p) => p.code),
      ).toEqual(['DISCHARGED_AT_ORDER']);
    });

    it('operador = monitor en sedación moderada exige justificación; en mínima no', () => {
      const same = discharge({ monitorId: OPERATOR });
      expect(dischargeProblems(same, T, ctx)).toEqual([]);
      expect(
        dischargeProblems(same, T, { ...ctx, grade: 'MODERATE' }).map(
          (p) => p.code,
        ),
      ).toEqual(['SAME_MONITOR']);
      expect(
        dischargeProblems(
          {
            ...same,
            sameMonitorJustification: 'Sin auxiliar libre; N2O a 30 %',
          },
          T,
          { ...ctx, grade: 'MODERATE' },
        ),
      ).toEqual([]);
    });

    it('la copia de los criterios guarda su texto y si se cumplían', () => {
      const criteria = buildDischargeCriteria(
        [{ code: 'HYDRATION', met: true }],
        T,
      );
      expect(criteria).toHaveLength(6);
      expect(criteria.find((c) => c.code === 'HYDRATION')).toEqual({
        code: 'HYDRATION',
        label: 'Hidratación adecuada',
        met: true,
      });
      expect(criteria.filter((c) => c.met)).toHaveLength(1);
    });
  });
});
