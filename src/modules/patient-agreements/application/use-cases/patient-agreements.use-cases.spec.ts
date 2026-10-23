import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InMemoryAgreementRepository } from '../../../agreements/application/__fixtures__/in-memory-agreements';
import {
  AGREEMENT_DATE_RANGE_MESSAGE,
  AGREEMENT_NOT_FOUND_MESSAGE,
} from '../../../agreements/domain/agreement-rules';
import { InMemoryPayerRepository } from '../../../payers/application/__fixtures__/in-memory-payers';
import { InMemoryPatientCoverageRepository } from '../../../patient-coverages/application/__fixtures__/in-memory-patient-coverages';
import {
  COVERAGE_NOT_FOUND_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
} from '../../../patient-coverages/domain/coverage-rules';
import {
  AGREEMENT_RACE_MESSAGE,
  COVERAGE_PAYER_MISMATCH_MESSAGE,
  PATIENT_AGREEMENT_NOT_FOUND_MESSAGE,
} from '../../domain/patient-agreement-rules';
import { InMemoryPatientAgreementRepository } from '../__fixtures__/in-memory-patient-agreements';
import {
  AssignPatientAgreementUseCase,
  GetPatientAgreementUseCase,
  RemovePatientAgreementUseCase,
} from './patient-agreements.use-cases';

describe('casos de uso del convenio del paciente (DX-105)', () => {
  const PATIENT = 'patient-1';
  let payers: InMemoryPayerRepository;
  let agreements: InMemoryAgreementRepository;
  let coverages: InMemoryPatientCoverageRepository;
  let repo: InMemoryPatientAgreementRepository;
  let get: GetPatientAgreementUseCase;
  let assign: AssignPatientAgreementUseCase;
  let remove: RemovePatientAgreementUseCase;
  let sanitas: { id: string; name: string };
  let sura: { id: string; name: string };
  let convenioSanitas: string;
  let convenioSura: string;

  beforeEach(() => {
    payers = new InMemoryPayerRepository();
    agreements = new InMemoryAgreementRepository();
    coverages = new InMemoryPatientCoverageRepository(payers);
    repo = new InMemoryPatientAgreementRepository(agreements);
    repo.knowPatient(PATIENT);
    coverages.knowPatient(PATIENT);
    const clock = () => new Date('2026-10-20T15:00:00.000Z');
    get = new GetPatientAgreementUseCase(repo, clock);
    assign = new AssignPatientAgreementUseCase(
      repo,
      agreements,
      coverages,
      clock,
    );
    remove = new RemovePatientAgreementUseCase(repo);
    sanitas = payers.seed({ name: 'Sanitas' });
    sura = payers.seed({ name: 'Sura' });
    convenioSanitas = agreements.seed({
      name: 'Convenio Sanitas',
      payer: { id: sanitas.id, name: sanitas.name },
    }).id;
    convenioSura = agreements.seed({
      name: 'Convenio Sura',
      payer: { id: sura.id, name: sura.name },
    }).id;
  });

  describe('consultar', () => {
    it('404 si el paciente no es de esta clínica', async () => {
      await expect(get.execute('otra-clinica', true)).rejects.toThrow(
        new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
      );
    });

    it('sin convenio: current null e historial vacío', async () => {
      expect(await get.execute(PATIENT, true)).toEqual({
        current: null,
        history: [],
      });
    });

    it('el historial solo viene con includeHistory y va de la más reciente a la más antigua', async () => {
      repo.seed({
        patientId: PATIENT,
        agreementId: convenioSura,
        retiredAt: new Date('2026-09-01T00:00:00Z'),
      });
      repo.seed({
        patientId: PATIENT,
        agreementId: convenioSanitas,
        retiredAt: new Date('2026-09-15T00:00:00Z'),
      });
      const live = repo.seed({
        patientId: PATIENT,
        agreementId: convenioSanitas,
      });

      const without = await get.execute(PATIENT, false);
      expect(without.current?.id).toBe(live.id);
      expect(without.history).toEqual([]);

      const withHistory = await get.execute(PATIENT, true);
      expect(withHistory.history.map((h) => h.agreement.name)).toEqual([
        'Convenio Sanitas',
        'Convenio Sura',
      ]);
      expect(withHistory.history.every((h) => h.retiredAt !== null)).toBe(true);
    });

    it('calcula el estado a hoy con las dos vigencias', async () => {
      const past = agreements.seed({
        name: 'Vencido',
        payer: { id: sanitas.id, name: sanitas.name },
        validTo: '2026-10-19',
      });
      repo.seed({ patientId: PATIENT, agreementId: past.id });
      expect((await get.execute(PATIENT, false)).current?.status).toBe(
        'EXPIRED',
      );
    });
  });

  describe('asignar (PUT)', () => {
    it('404 del paciente de otra clínica y no escribe', async () => {
      await expect(
        assign.execute('otra-clinica', { agreementId: convenioSanitas }, 'u1'),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('crea la asignación con estado ACTIVE y autor', async () => {
      const out = await assign.execute(
        PATIENT,
        { agreementId: convenioSanitas, notes: '  Plan oro  ' },
        'u1',
      );
      expect(out.status).toBe('ACTIVE');
      expect(out.agreement.payer.name).toBe('Sanitas');
      expect(out.notes).toBe('Plan oro');
      expect(out.retiredAt).toBeNull();
      expect(repo.live(PATIENT)).toHaveLength(1);
      expect(repo.lastBy).toBe('u1');
    });

    it('sustituye la viva: la anterior queda retirada y aparece en el historial', async () => {
      const first = await assign.execute(
        PATIENT,
        { agreementId: convenioSanitas },
        'u1',
      );
      const second = await assign.execute(
        PATIENT,
        { agreementId: convenioSura },
        'u1',
      );
      expect(repo.live(PATIENT)).toHaveLength(1);
      const out = await get.execute(PATIENT, true);
      expect(out.current?.id).toBe(second.id);
      expect(out.history.map((h) => h.id)).toEqual([first.id]);
    });

    it('400 con un convenio inexistente o retirado', async () => {
      await expect(
        assign.execute(PATIENT, { agreementId: 'no-existe' }, 'u1'),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE));
      agreements.deleted.add(convenioSanitas);
      await expect(
        assign.execute(PATIENT, { agreementId: convenioSanitas }, 'u1'),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('un convenio desactivado se asigna y sale INACTIVE', async () => {
      agreements.rows.find((a) => a.id === convenioSanitas)!.active = false;
      const out = await assign.execute(
        PATIENT,
        { agreementId: convenioSanitas },
        'u1',
      );
      expect(out.status).toBe('INACTIVE');
      expect(repo.live(PATIENT)).toHaveLength(1);
    });

    it('400 con una vigencia al revés y no retira la anterior', async () => {
      await assign.execute(PATIENT, { agreementId: convenioSanitas }, 'u1');
      await expect(
        assign.execute(
          PATIENT,
          {
            agreementId: convenioSura,
            validFrom: '2026-12-31',
            validTo: '2026-01-01',
          },
          'u1',
        ),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_DATE_RANGE_MESSAGE));
      expect(repo.live(PATIENT)[0].agreementId).toBe(convenioSanitas);
    });

    describe('cobertura', () => {
      it('la acepta si es del paciente y del mismo pagador', async () => {
        const cov = coverages.seed({ patientId: PATIENT, payerId: sanitas.id });
        const out = await assign.execute(
          PATIENT,
          { agreementId: convenioSanitas, coverageId: cov.id },
          'u1',
        );
        expect(out.coverageId).toBe(cov.id);
      });

      it('400 si es de otro pagador y no escribe', async () => {
        const cov = coverages.seed({ patientId: PATIENT, payerId: sura.id });
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: convenioSanitas, coverageId: cov.id },
            'u1',
          ),
        ).rejects.toThrow(
          new BadRequestException(COVERAGE_PAYER_MISMATCH_MESSAGE),
        );
        expect(repo.rows).toHaveLength(0);
      });

      it('400 si no es del paciente o está retirada', async () => {
        const other = coverages.seed({
          patientId: 'otro-paciente',
          payerId: sanitas.id,
        });
        const gone = coverages.seed({
          patientId: PATIENT,
          payerId: sanitas.id,
        });
        gone.deleted = true;
        for (const coverageId of [other.id, gone.id, 'no-existe']) {
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanitas, coverageId },
              'u1',
            ),
          ).rejects.toThrow(
            new BadRequestException(COVERAGE_NOT_FOUND_MESSAGE),
          );
        }
        expect(repo.rows).toHaveLength(0);
      });

      it('coverageId null equivale a omitirlo', async () => {
        const out = await assign.execute(
          PATIENT,
          { agreementId: convenioSanitas, coverageId: null },
          'u1',
        );
        expect(out.coverageId).toBeNull();
      });
    });

    it('la carrera del índice parcial llega como 422 y no cambia nada', async () => {
      const first = await assign.execute(
        PATIENT,
        { agreementId: convenioSanitas },
        'u1',
      );
      repo.failNextReplace = true;
      await expect(
        assign.execute(PATIENT, { agreementId: convenioSura }, 'u1'),
      ).rejects.toThrow(
        new UnprocessableEntityException(AGREEMENT_RACE_MESSAGE),
      );
      expect(repo.live(PATIENT).map((r) => r.id)).toEqual([first.id]);
    });
  });

  describe('retirar (DELETE)', () => {
    it('404 del paciente de otra clínica', async () => {
      await expect(remove.execute('otra-clinica', 'u1')).rejects.toThrow(
        new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
      );
    });

    it('404 si no hay convenio asignado', async () => {
      await expect(remove.execute(PATIENT, 'u1')).rejects.toThrow(
        new NotFoundException(PATIENT_AGREEMENT_NOT_FOUND_MESSAGE),
      );
    });

    it('retira la viva, que pasa al historial', async () => {
      const a = await assign.execute(
        PATIENT,
        { agreementId: convenioSanitas },
        'u1',
      );
      await remove.execute(PATIENT, 'u2');
      const out = await get.execute(PATIENT, true);
      expect(out.current).toBeNull();
      expect(out.history.map((h) => h.id)).toEqual([a.id]);
      expect(repo.lastBy).toBe('u2');
      await expect(remove.execute(PATIENT, 'u2')).rejects.toThrow(
        PATIENT_AGREEMENT_NOT_FOUND_MESSAGE,
      );
    });
  });
});
