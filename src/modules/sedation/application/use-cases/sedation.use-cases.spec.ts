import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { PlatformSedationTemplateSource } from '../../infrastructure/platform-sedation-template.source';
import { PLATFORM_SEDATION_TEMPLATE as T } from '../../domain/sedation-template';
import { InMemorySedationRepository } from '../__fixtures__/in-memory-sedation';
import {
  SedationUseCases,
  type SedationAssessInput,
  type SedationDischargeRequest,
} from './sedation.use-cases';

const PATIENT = '11111111-1111-4111-8111-111111111111';
const ENTRY = '22222222-2222-4222-8222-222222222222';
const SEDE = '33333333-3333-4333-8333-333333333333';
const OTRA_SEDE = '44444444-4444-4444-8444-444444444444';
const DENTIST = '55555555-5555-4555-8555-555555555555';
const ASSISTANT = '66666666-6666-4666-8666-666666666666';
const CONSENT = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-30T15:30:00.000Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

function tenantContext(allowed: 'ALL' | string[] = 'ALL') {
  return {
    getAllowedLocationIds: () => allowed,
    assertLocationAllowed: (id: string) => {
      if (allowed !== 'ALL' && !allowed.includes(id)) {
        throw new ForbiddenException('Sede no permitida');
      }
    },
  } as unknown as TenantContextService;
}

function setup(allowed: 'ALL' | string[] = 'ALL') {
  const repo = new InMemorySedationRepository();
  repo.patients.add(PATIENT);
  repo.entries.set(ENTRY, { id: ENTRY, patientId: PATIENT, locationId: SEDE });
  repo.members.set(DENTIST, 'Dra. Ana Gómez');
  repo.members.set(ASSISTANT, 'Luis Pérez');
  repo.consents.set(CONSENT, PATIENT);
  repo.now = () => NOW;
  const uc = new SedationUseCases(
    repo,
    new PlatformSedationTemplateSource(),
    tenantContext(allowed),
  );
  uc.now = () => NOW;
  return { repo, uc };
}

const assessment = (
  overrides: Partial<SedationAssessInput> = {},
): SedationAssessInput => ({
  grade: 'MODERATE',
  asaClass: 'I',
  asaEmergency: false,
  fastingClearLiquidsHours: 2,
  fastingSolidsHours: 6,
  mallampati: 2,
  weightKg: 18.5,
  heightCm: 110,
  escortName: 'Laura Ortiz',
  escortRelationship: 'Madre',
  consentConfirmed: true,
  ...overrides,
});

const allMarks = T.checklist.map((i) => ({ code: i.code, checked: true }));
const vitals = {
  spo2: 98,
  heartRate: 92,
  systolic: 100,
  diastolic: 62,
  respiratoryRate: 20,
  sedationLevel: 'MINIMAL' as const,
};

const dischargeBody = (
  overrides: Partial<SedationDischargeRequest> = {},
): SedationDischargeRequest => ({
  criteria: T.dischargeCriteria.map((c) => ({ code: c.code, met: true })),
  vitals: { ...vitals, sedationLevel: 'AWAKE' },
  handedOverToName: 'Laura Ortiz',
  handedOverToRelationship: 'Madre',
  instructionsDelivered: true,
  monitorId: ASSISTANT,
  dischargedAt: at(-1),
  ...overrides,
});

async function problemsOf(promise: Promise<unknown>): Promise<string[]> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BadRequestException);
  const body = (err as BadRequestException).getResponse() as {
    problems: { code: string }[];
  };
  return body.problems.map((p) => p.code);
}

async function opened() {
  const ctx = setup();
  await ctx.uc.assess(PATIENT, ENTRY, assessment(), DENTIST);
  return ctx;
}

async function inProgress() {
  const ctx = await opened();
  await ctx.uc.check(PATIENT, ENTRY, allMarks, DENTIST);
  await ctx.uc.addAgent(
    PATIENT,
    ENTRY,
    {
      kind: 'NITROUS_OXIDE',
      n2oPercent: 30,
      flowLpm: 6,
      administeredAt: at(-20),
    },
    DENTIST,
  );
  await ctx.uc.addVitals(
    PATIENT,
    ENTRY,
    { phase: 'INTRA', takenAt: at(-16), ...vitals },
    ASSISTANT,
  );
  return ctx;
}

describe('SedationUseCases (DX-407)', () => {
  describe('valoración previa', () => {
    it('sin hoja: la evolución devuelve la plantilla de plataforma y ninguna hoja', async () => {
      const { uc } = setup();
      const view = await uc.getEntry(PATIENT, ENTRY);
      expect(view.sheet).toBeNull();
      expect(view.template).toMatchObject({
        version: 'SEDATION_PLATFORM_V1',
        source: 'PLATFORM',
        vitalsIntervalMinutes: 5,
      });
    });

    it('abre la hoja con IMC y reversores calculados en el servidor y la plantilla sellada', async () => {
      const { uc } = setup();
      const sheet = await uc.assess(
        PATIENT,
        ENTRY,
        assessment({ consentId: CONSENT }),
        DENTIST,
      );
      expect(sheet).toMatchObject({
        status: 'ASSESSED',
        bmi: 15.3,
        naloxoneMg: 1.85,
        flumazenilMg: 0.185,
        templateVersion: 'SEDATION_PLATFORM_V1',
        rulesVersion: 'SEDATION_RULES_V1',
        vitalsIntervalMinutes: 5,
        consentId: CONSENT,
        locationId: SEDE,
        author: { id: DENTIST, name: 'Dra. Ana Gómez' },
      });
    });

    it('incompleta: 400 con la lista de lo que falta y no guarda', async () => {
      const { uc, repo } = setup();
      const codes = await problemsOf(
        uc.assess(
          PATIENT,
          ENTRY,
          assessment({
            mallampati: undefined,
            escortName: undefined,
            consentConfirmed: false,
          }),
          DENTIST,
        ),
      );
      expect(codes).toEqual(['MALLAMPATI', 'ESCORT', 'CONSENT']);
      expect(repo.sheets).toHaveLength(0);
    });

    it('ASA III sin interconsulta ni justificación: 400; con justificación se abre', async () => {
      const { uc } = setup();
      expect(
        await problemsOf(
          uc.assess(PATIENT, ENTRY, assessment({ asaClass: 'III' }), DENTIST),
        ),
      ).toEqual(['HIGH_ASA_REASON']);
      const sheet = await uc.assess(
        PATIENT,
        ENTRY,
        assessment({
          asaClass: 'III',
          highAsaJustification: 'Asma controlada, sin crisis en 12 meses',
        }),
        DENTIST,
      );
      expect(sheet.asaClass).toBe('III');
    });

    it('una segunda hoja en la misma evolución: 409', async () => {
      const { uc } = await opened();
      await expect(
        uc.assess(PATIENT, ENTRY, assessment(), DENTIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un consentimiento que no es de este paciente: 404', async () => {
      const { uc, repo } = setup();
      repo.consents.set(CONSENT, 'otro-paciente');
      await expect(
        uc.assess(PATIENT, ENTRY, assessment({ consentId: CONSENT }), DENTIST),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('paciente o evolución que no existen: 404; sede no permitida: 403', async () => {
      const { uc } = setup();
      await expect(
        uc.getEntry('00000000-0000-4000-8000-000000000000', ENTRY),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        uc.getEntry(PATIENT, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toBeInstanceOf(NotFoundException);
      const restricted = setup([OTRA_SEDE]);
      await expect(
        restricted.uc.assess(PATIENT, ENTRY, assessment(), DENTIST),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('checklist', () => {
    it('sin hoja: 404', async () => {
      const { uc } = setup();
      await expect(
        uc.check(PATIENT, ENTRY, allMarks, DENTIST),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('falta un ítem obligatorio: 400 y no guarda', async () => {
      const { uc, repo } = await opened();
      const marks = allMarks.map((m) =>
        m.code === 'REVERSAL_AGENTS' ? { ...m, checked: false } : m,
      );
      expect(
        await problemsOf(uc.check(PATIENT, ENTRY, marks, DENTIST)),
      ).toEqual(['REVERSAL_AGENTS']);
      expect(repo.sheets[0].checklist).toBeNull();
    });

    it('con todo marcado: guarda la copia de los ítems, quién y la hora del servidor; un segundo, 409', async () => {
      const { uc } = await opened();
      const sheet = await uc.check(PATIENT, ENTRY, allMarks, DENTIST);
      expect(sheet.status).toBe('CHECKED');
      expect(sheet.checklist).toMatchObject({
        author: { id: DENTIST },
        checkedAt: NOW,
      });
      expect(sheet.checklist?.items[3]).toEqual({
        code: 'REVERSAL_AGENTS',
        label: T.checklist[3].label,
        checked: true,
      });
      await expect(
        uc.check(PATIENT, ENTRY, allMarks, DENTIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('fármacos y constantes', () => {
    it('antes del checklist: la toma basal sí; el fármaco y la toma intraoperatoria, 409', async () => {
      const { uc } = await opened();
      const sheet = await uc.addVitals(
        PATIENT,
        ENTRY,
        { phase: 'BASELINE', takenAt: at(-30), ...vitals },
        ASSISTANT,
      );
      expect(sheet.vitals).toHaveLength(1);
      await expect(
        uc.addVitals(
          PATIENT,
          ENTRY,
          { phase: 'INTRA', takenAt: at(-25), ...vitals },
          ASSISTANT,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        uc.addAgent(
          PATIENT,
          ENTRY,
          { kind: 'NITROUS_OXIDE', n2oPercent: 30, flowLpm: 6 },
          DENTIST,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('N2O se guarda inhalado; un oral sin vía va por vía oral', async () => {
      const { uc } = await inProgress();
      const sheet = await uc.addAgent(
        PATIENT,
        ENTRY,
        { kind: 'ORAL', drugName: 'Midazolam', dose: 7.5, doseUnit: 'MG' },
        DENTIST,
      );
      expect(sheet.agents.map((a) => [a.kind, a.route])).toEqual([
        ['NITROUS_OXIDE', 'INHALED'],
        ['ORAL', 'ORAL'],
      ]);
      expect(sheet.agents[1].administeredAt).toEqual(NOW);
    });

    it('fármaco o toma incompletos: 400', async () => {
      const { uc } = await inProgress();
      expect(
        await problemsOf(
          uc.addAgent(
            PATIENT,
            ENTRY,
            { kind: 'NITROUS_OXIDE', n2oPercent: 30 },
            DENTIST,
          ),
        ),
      ).toEqual(['N2O_FLOW']);
      expect(
        await problemsOf(
          uc.addVitals(PATIENT, ENTRY, { phase: 'INTRA', spo2: 97 }, ASSISTANT),
        ),
      ).toEqual([
        'HEART_RATE',
        'BLOOD_PRESSURE',
        'RESPIRATORY_RATE',
        'SEDATION_LEVEL',
      ]);
    });

    it('una hora futura: 400', async () => {
      const { uc } = await inProgress();
      await expect(
        uc.addVitals(
          PATIENT,
          ENTRY,
          { phase: 'INTRA', takenAt: at(30), ...vitals },
          ASSISTANT,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('la asistente registra la toma y queda como autora', async () => {
      const { uc } = await inProgress();
      const sheet = await uc.getEntry(PATIENT, ENTRY);
      expect(sheet.sheet?.vitals[0].author).toEqual({
        id: ASSISTANT,
        name: 'Luis Pérez',
      });
    });

    it('aviso: pasado el intervalo de 5 min sin toma, la hoja lo dice', async () => {
      const { uc } = await inProgress();
      const view = (await uc.getEntry(PATIENT, ENTRY)).sheet;
      // N2O a -20, última toma a -16: vencía a -11.
      expect(view?.status).toBe('IN_PROGRESS');
      expect(view?.watch).toMatchObject({
        active: true,
        overdue: true,
        overdueMinutes: 11,
        intervalMinutes: 5,
      });
      expect(view?.watch.nextDueAt).toEqual(at(-11));
      const after = await uc.addVitals(
        PATIENT,
        ENTRY,
        { phase: 'INTRA', ...vitals },
        ASSISTANT,
      );
      expect(after.watch).toMatchObject({ overdue: false });
      expect(after.watch.nextDueAt).toEqual(at(5));
      expect(after.watch.missedIntervals).toBe(1);
    });

    it('una toma anotada con hora futura (tolerancia de reloj) no aplaza el aviso', async () => {
      const { uc } = await inProgress();
      // Se registra ahora una toma «de dentro de 4 min»: la próxima vence a
      // los 5 min de AHORA (cuando se registró), no a los 9.
      const view = await uc.addVitals(
        PATIENT,
        ENTRY,
        { phase: 'INTRA', takenAt: at(4), ...vitals },
        ASSISTANT,
      );
      expect(view.watch.nextDueAt).toEqual(at(5));
    });
  });

  describe('egreso', () => {
    it('sin checklist: 409', async () => {
      const { uc } = await opened();
      await expect(
        uc.discharge(PATIENT, ENTRY, dischargeBody(), DENTIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sin criterios ni Aldrete ≥ 9: 400 y la hoja sigue abierta', async () => {
      const { uc, repo } = await inProgress();
      expect(
        await problemsOf(
          uc.discharge(
            PATIENT,
            ENTRY,
            dischargeBody({ criteria: [] }),
            DENTIST,
          ),
        ),
      ).toEqual(['DISCHARGE_CRITERIA']);
      // Un Aldrete anotado bajo el mínimo tampoco cierra, ni con los criterios.
      expect(
        await problemsOf(
          uc.discharge(
            PATIENT,
            ENTRY,
            dischargeBody({ aldreteScore: 8 }),
            DENTIST,
          ),
        ),
      ).toEqual(['ALDRETE_BELOW_MINIMUM']);
      expect(repo.sheets[0].discharge).toBeNull();
    });

    it('cierra con las constantes al alta, a quién se entrega, operador y monitor; después todo es 409', async () => {
      const { uc } = await inProgress();
      const sheet = await uc.discharge(
        PATIENT,
        ENTRY,
        dischargeBody({ criteria: [], aldreteScore: 9 }),
        DENTIST,
      );
      expect(sheet.status).toBe('DISCHARGED');
      expect(sheet.watch.active).toBe(false);
      const alta = sheet.vitals.find((v) => v.phase === 'DISCHARGE');
      expect(alta).toMatchObject({ takenAt: at(-1), sedationLevel: 'AWAKE' });
      expect(sheet.discharge).toMatchObject({
        vitalsId: alta?.id,
        aldreteScore: 9,
        dischargedAt: at(-1),
        handedOverToName: 'Laura Ortiz',
        operator: { id: DENTIST, name: 'Dra. Ana Gómez' },
        monitor: { id: ASSISTANT, name: 'Luis Pérez' },
      });
      expect(sheet.discharge?.criteria).toHaveLength(6);

      await expect(
        uc.addVitals(PATIENT, ENTRY, { phase: 'INTRA', ...vitals }, ASSISTANT),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        uc.addAgent(
          PATIENT,
          ENTRY,
          { kind: 'NITROUS_OXIDE', n2oPercent: 30, flowLpm: 6 },
          DENTIST,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        uc.discharge(PATIENT, ENTRY, dischargeBody(), DENTIST),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('sedación moderada con el operador como monitor: 400 sin justificación; con ella, se cierra', async () => {
      const { uc } = await inProgress();
      expect(
        await problemsOf(
          uc.discharge(
            PATIENT,
            ENTRY,
            dischargeBody({ monitorId: DENTIST }),
            DENTIST,
          ),
        ),
      ).toEqual(['SAME_MONITOR']);
      const sheet = await uc.discharge(
        PATIENT,
        ENTRY,
        dischargeBody({
          monitorId: DENTIST,
          sameMonitorJustification: 'Auxiliar en otra urgencia; N2O al 30 %',
        }),
        DENTIST,
      );
      expect(sheet.discharge?.sameMonitorJustification).toContain('Auxiliar');
    });

    it('un monitor que no es miembro clínico de la clínica: 400', async () => {
      const { uc } = await inProgress();
      await expect(
        uc.discharge(
          PATIENT,
          ENTRY,
          dischargeBody({ monitorId: '99999999-9999-4999-8999-999999999999' }),
          DENTIST,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('la hora de egreso antes de la última toma: 400', async () => {
      const { uc } = await inProgress();
      expect(
        await problemsOf(
          uc.discharge(
            PATIENT,
            ENTRY,
            dischargeBody({ dischargedAt: at(-18) }),
            DENTIST,
          ),
        ),
      ).toEqual(['DISCHARGED_AT_ORDER']);
    });
  });

  it('la ficha no enseña a un miembro acotado las hojas de otra sede', async () => {
    const { repo } = await inProgress();
    const restricted = new SedationUseCases(
      repo,
      new PlatformSedationTemplateSource(),
      tenantContext([OTRA_SEDE]),
    );
    expect(await restricted.listByPatient(PATIENT)).toEqual([]);
    const all = new SedationUseCases(
      repo,
      new PlatformSedationTemplateSource(),
      tenantContext(),
    );
    expect(await all.listByPatient(PATIENT)).toHaveLength(1);
  });
});
