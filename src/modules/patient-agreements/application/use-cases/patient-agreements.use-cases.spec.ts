import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
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
  COVERAGE_NOT_LIVE_MESSAGE,
  COVERAGE_PAYER_MISMATCH_MESSAGE,
  COVERAGE_SELF_DECLARED_MESSAGE,
  INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE,
  PATIENT_AGREEMENT_NOT_FOUND_MESSAGE,
  coverageRequiredMessage,
} from '../../domain/patient-agreement-rules';
import { InMemoryPatientAgreementRepository } from '../__fixtures__/in-memory-patient-agreements';
import {
  AssignPatientAgreementUseCase,
  GetPatientAgreementUseCase,
  RemovePatientAgreementUseCase,
} from './patient-agreements.use-cases';

const actor = (role: ClinicRole) => ({ userId: 'u1', role });
const RECEPTION = actor(ClinicRole.RECEPTION);
const ADMIN = actor(ClinicRole.ADMIN);
const NON_ADMIN = [
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
] as const;

describe('casos de uso del convenio del paciente (DX-105)', () => {
  const PATIENT = 'patient-1';
  let payers: InMemoryPayerRepository;
  let agreements: InMemoryAgreementRepository;
  let coverages: InMemoryPatientCoverageRepository;
  let repo: InMemoryPatientAgreementRepository;
  let get: GetPatientAgreementUseCase;
  let assign: AssignPatientAgreementUseCase;
  let remove: RemovePatientAgreementUseCase;
  let sanavida: { id: string; name: string };
  let surco: { id: string; name: string };
  let convenioSanavida: string;
  let convenioSurco: string;
  /** Coberturas vivas del paciente con cada pagador. */
  let covSanavida: string;
  let covSurco: string;
  /** Convenio sin pagador externo: su pagador es de tipo OTHER (SEC-047). */
  let cortesia: string;
  let cortesiaPayer: { id: string; name: string };

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
    sanavida = payers.seed({ name: 'Sanavida' });
    surco = payers.seed({ name: 'Surco' });
    cortesiaPayer = payers.seed({
      name: 'Cortesía',
      type: 'OTHER',
    });
    convenioSanavida = agreements.seed({
      name: 'Convenio Sanavida',
      payer: { id: sanavida.id, name: sanavida.name, type: 'PUBLIC_SYSTEM' },
    }).id;
    convenioSurco = agreements.seed({
      name: 'Convenio Surco',
      payer: { id: surco.id, name: surco.name, type: 'PUBLIC_SYSTEM' },
    }).id;
    cortesia = agreements.seed({
      name: 'Cortesía socios 100 %',
      percent: 100,
      payer: { ...cortesiaPayer, type: 'OTHER' },
    }).id;
    covSanavida = coverages.seed({
      patientId: PATIENT,
      payerId: sanavida.id,
    }).id;
    covSurco = coverages.seed({ patientId: PATIENT, payerId: surco.id }).id;
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
        agreementId: convenioSurco,
        retiredAt: new Date('2026-09-01T00:00:00Z'),
      });
      repo.seed({
        patientId: PATIENT,
        agreementId: convenioSanavida,
        retiredAt: new Date('2026-09-15T00:00:00Z'),
      });
      const live = repo.seed({
        patientId: PATIENT,
        agreementId: convenioSanavida,
      });

      const without = await get.execute(PATIENT, false);
      expect(without.current?.id).toBe(live.id);
      expect(without.history).toEqual([]);

      const withHistory = await get.execute(PATIENT, true);
      expect(withHistory.history.map((h) => h.agreement.name)).toEqual([
        'Convenio Sanavida',
        'Convenio Surco',
      ]);
      expect(withHistory.history.every((h) => h.retiredAt !== null)).toBe(true);
    });

    it('calcula el estado a hoy con las dos vigencias', async () => {
      const past = agreements.seed({
        name: 'Vencido',
        payer: { id: sanavida.id, name: sanavida.name, type: 'PUBLIC_SYSTEM' },
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
        assign.execute(
          'otra-clinica',
          { agreementId: convenioSanavida, coverageId: covSanavida },
          RECEPTION,
        ),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('crea la asignación con estado ACTIVE y autor', async () => {
      const out = await assign.execute(
        PATIENT,
        {
          agreementId: convenioSanavida,
          coverageId: covSanavida,
          notes: '  Plan oro  ',
        },
        RECEPTION,
      );
      expect(out.status).toBe('ACTIVE');
      expect(out.agreement.payer.name).toBe('Sanavida');
      expect(out.notes).toBe('Plan oro');
      expect(out.retiredAt).toBeNull();
      expect(repo.live(PATIENT)).toHaveLength(1);
      expect(repo.lastBy).toBe('u1');
    });

    it('sustituye la viva: la anterior queda retirada y aparece en el historial', async () => {
      const first = await assign.execute(
        PATIENT,
        { agreementId: convenioSanavida, coverageId: covSanavida },
        RECEPTION,
      );
      const second = await assign.execute(
        PATIENT,
        { agreementId: convenioSurco, coverageId: covSurco },
        RECEPTION,
      );
      expect(repo.live(PATIENT)).toHaveLength(1);
      const out = await get.execute(PATIENT, true);
      expect(out.current?.id).toBe(second.id);
      expect(out.history.map((h) => h.id)).toEqual([first.id]);
    });

    it('400 con un convenio inexistente o retirado', async () => {
      await expect(
        assign.execute(PATIENT, { agreementId: 'no-existe' }, RECEPTION),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE));
      agreements.deleted.add(convenioSanavida);
      await expect(
        assign.execute(
          PATIENT,
          { agreementId: convenioSanavida, coverageId: covSanavida },
          RECEPTION,
        ),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_NOT_FOUND_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('un convenio desactivado se asigna y sale INACTIVE', async () => {
      agreements.rows.find((a) => a.id === convenioSanavida)!.active = false;
      const out = await assign.execute(
        PATIENT,
        { agreementId: convenioSanavida, coverageId: covSanavida },
        RECEPTION,
      );
      expect(out.status).toBe('INACTIVE');
      expect(repo.live(PATIENT)).toHaveLength(1);
    });

    it('400 con una vigencia al revés y no retira la anterior', async () => {
      await assign.execute(
        PATIENT,
        { agreementId: convenioSanavida, coverageId: covSanavida },
        RECEPTION,
      );
      await expect(
        assign.execute(
          PATIENT,
          {
            agreementId: convenioSurco,
            validFrom: '2026-12-31',
            validTo: '2026-01-01',
          },
          RECEPTION,
        ),
      ).rejects.toThrow(new BadRequestException(AGREEMENT_DATE_RANGE_MESSAGE));
      expect(repo.live(PATIENT)[0].agreementId).toBe(convenioSanavida);
    });

    describe('cobertura', () => {
      it('la acepta si es del paciente y del mismo pagador', async () => {
        const cov = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
        });
        const out = await assign.execute(
          PATIENT,
          { agreementId: convenioSanavida, coverageId: cov.id },
          RECEPTION,
        );
        expect(out.coverageId).toBe(cov.id);
      });

      it('400 si es de otro pagador y no escribe', async () => {
        const cov = coverages.seed({ patientId: PATIENT, payerId: surco.id });
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: convenioSanavida, coverageId: cov.id },
            RECEPTION,
          ),
        ).rejects.toThrow(
          new BadRequestException(COVERAGE_PAYER_MISMATCH_MESSAGE),
        );
        expect(repo.rows).toHaveLength(0);
      });

      it('400 si no es del paciente o está retirada', async () => {
        const other = coverages.seed({
          patientId: 'otro-paciente',
          payerId: sanavida.id,
        });
        const gone = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
        });
        gone.deleted = true;
        for (const coverageId of [other.id, gone.id, 'no-existe']) {
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanavida, coverageId },
              RECEPTION,
            ),
          ).rejects.toThrow(
            new BadRequestException(COVERAGE_NOT_FOUND_MESSAGE),
          );
        }
        expect(repo.rows).toHaveLength(0);
      });
    });

    describe('elegibilidad (SEC-047)', () => {
      it.each([ClinicRole.ADMIN, ...NON_ADMIN])(
        '%s: un convenio de pagador sin cobertura da 400 y no escribe',
        async (role) => {
          for (const coverageId of [undefined, null]) {
            await expect(
              assign.execute(
                PATIENT,
                { agreementId: convenioSanavida, coverageId },
                actor(role),
              ),
            ).rejects.toThrow(
              new BadRequestException(coverageRequiredMessage('Sanavida')),
            );
          }
          expect(repo.rows).toHaveLength(0);
        },
      );

      it.each([ClinicRole.ADMIN, ...NON_ADMIN])(
        '%s: un convenio de pagador con su cobertura viva se asigna',
        async (role) => {
          const out = await assign.execute(
            PATIENT,
            { agreementId: convenioSanavida, coverageId: covSanavida },
            actor(role),
          );
          expect(out.coverageId).toBe(covSanavida);
        },
      );

      it('400 con una cobertura vencida o que aún no empieza (extremos vigentes)', async () => {
        const expired = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
          validTo: '2026-10-19',
        });
        const future = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
          validFrom: '2026-10-21',
        });
        for (const coverageId of [expired.id, future.id]) {
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanavida, coverageId },
              ADMIN,
            ),
          ).rejects.toThrow(new BadRequestException(COVERAGE_NOT_LIVE_MESSAGE));
        }
        expect(repo.rows).toHaveLength(0);
        const edges = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
          validFrom: '2026-10-20',
          validTo: '2026-10-20',
        });
        const out = await assign.execute(
          PATIENT,
          { agreementId: convenioSanavida, coverageId: edges.id },
          RECEPTION,
        );
        expect(out.coverageId).toBe(edges.id);
      });

      it.each(NON_ADMIN)(
        '%s: un convenio sin pagador externo da 403, con o sin cobertura',
        async (role) => {
          const cov = coverages.seed({
            patientId: PATIENT,
            payerId: cortesiaPayer.id,
          });
          for (const coverageId of [undefined, cov.id]) {
            await expect(
              assign.execute(
                PATIENT,
                { agreementId: cortesia, coverageId },
                actor(role),
              ),
            ).rejects.toThrow(
              new ForbiddenException(INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE),
            );
          }
          expect(repo.rows).toHaveLength(0);
        },
      );

      it.each(NON_ADMIN)(
        '%s: con una cobertura MIGRADA del texto libre de aseguradora anterior a DX-153 del mismo pagador, el convenio OTHER se asigna',
        async (role) => {
          const migrated = coverages.seed({
            patientId: PATIENT,
            payerId: cortesiaPayer.id,
            migratedFromInsurerEps: true,
          });
          const out = await assign.execute(
            PATIENT,
            { agreementId: cortesia, coverageId: migrated.id },
            actor(role),
          );
          expect(out.coverageId).toBe(migrated.id);
        },
      );

      it('la cobertura migrada tiene que ser del mismo pagador, del paciente y estar vigente', async () => {
        const otherPayer = coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
          migratedFromInsurerEps: true,
        });
        const otherPatient = coverages.seed({
          patientId: 'otro-paciente',
          payerId: cortesiaPayer.id,
          migratedFromInsurerEps: true,
        });
        for (const coverageId of [
          otherPayer.id,
          otherPatient.id,
          'no-existe',
        ]) {
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: cortesia, coverageId },
              RECEPTION,
            ),
          ).rejects.toThrow(
            new ForbiddenException(INTERNAL_AGREEMENT_ADMIN_ONLY_MESSAGE),
          );
        }
        const expired = coverages.seed({
          patientId: PATIENT,
          payerId: cortesiaPayer.id,
          migratedFromInsurerEps: true,
          validTo: '2026-10-19',
        });
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: cortesia, coverageId: expired.id },
            RECEPTION,
          ),
        ).rejects.toThrow(new BadRequestException(COVERAGE_NOT_LIVE_MESSAGE));
        expect(repo.rows).toHaveLength(0);
      });

      it('ADMIN asigna un convenio sin pagador externo sin cobertura (null = omitirla)', async () => {
        const out = await assign.execute(
          PATIENT,
          { agreementId: cortesia, coverageId: null },
          ADMIN,
        );
        expect(out.coverageId).toBeNull();
        expect(out.agreement.payer.type).toBe('OTHER');
      });

      it('ADMIN con un convenio sin pagador externo: la cobertura, si viene, se valida igual', async () => {
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: cortesia, coverageId: covSanavida },
            ADMIN,
          ),
        ).rejects.toThrow(
          new BadRequestException(COVERAGE_PAYER_MISMATCH_MESSAGE),
        );
        expect(repo.rows).toHaveLength(0);
      });

      it('el 403 va antes que el resto: un no-ADMIN no aprende nada de la cobertura', async () => {
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: cortesia, coverageId: 'no-existe' },
            RECEPTION,
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe('cobertura verificable (SEC-049)', () => {
      /** Cobertura de Sanavida que registró `declaredById` (SEC-049). */
      const declared = (declaredById: string, extra: object = {}) =>
        coverages.seed({
          patientId: PATIENT,
          payerId: sanavida.id,
          memberNumber: '1020304050',
          declaredById,
          ...extra,
        }).id;

      it.each(NON_ADMIN)(
        '%s: con la cobertura que registró él y nadie verificó, 403 en español y no escribe',
        async (role) => {
          const coverageId = declared('u1');
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanavida, coverageId },
              actor(role),
            ),
          ).rejects.toThrow(
            new ForbiddenException(COVERAGE_SELF_DECLARED_MESSAGE),
          );
          expect(repo.rows).toHaveLength(0);
        },
      );

      it.each(NON_ADMIN)(
        '%s: verificada por un ADMIN o registrada por otro usuario, se asigna',
        async (role) => {
          const verified = declared('u1', {
            verifiedAt: new Date('2026-10-19T12:00:00Z'),
            verifiedById: 'admin-1',
          });
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanavida, coverageId: verified },
              actor(role),
            ),
          ).resolves.toMatchObject({ coverageId: verified });
          const byOther = declared('u2');
          await expect(
            assign.execute(
              PATIENT,
              { agreementId: convenioSanavida, coverageId: byOther },
              actor(role),
            ),
          ).resolves.toMatchObject({ coverageId: byOther });
        },
      );

      it('ADMIN asigna con la que registró él sin verificar, como hasta ahora', async () => {
        const coverageId = declared('u1');
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: convenioSanavida, coverageId },
            ADMIN,
          ),
        ).resolves.toMatchObject({ coverageId });
      });

      it('la cobertura de otro paciente o de otra clínica sigue siendo 400 «no encontrada», antes del 403', async () => {
        const foreign = coverages.seed({
          patientId: 'otro-paciente',
          payerId: sanavida.id,
          declaredById: 'u1',
        }).id;
        await expect(
          assign.execute(
            PATIENT,
            { agreementId: convenioSanavida, coverageId: foreign },
            RECEPTION,
          ),
        ).rejects.toThrow(new BadRequestException(COVERAGE_NOT_FOUND_MESSAGE));
      });

      it('el repositorio recibe quién asigna para repetir la comprobación en la transacción', async () => {
        await assign.execute(
          PATIENT,
          { agreementId: convenioSanavida, coverageId: covSanavida },
          RECEPTION,
        );
        expect(repo.lastReplaceActor).toEqual({
          userId: 'u1',
          role: ClinicRole.RECEPTION,
        });
      });
    });

    it('la carrera del índice parcial llega como 422 y no cambia nada', async () => {
      const first = await assign.execute(
        PATIENT,
        { agreementId: convenioSanavida, coverageId: covSanavida },
        RECEPTION,
      );
      repo.failNextReplace = true;
      await expect(
        assign.execute(
          PATIENT,
          { agreementId: convenioSurco, coverageId: covSurco },
          RECEPTION,
        ),
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
        { agreementId: convenioSanavida, coverageId: covSanavida },
        RECEPTION,
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
