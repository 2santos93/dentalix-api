import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InMemoryPayerRepository } from '../../../payers/application/__fixtures__/in-memory-payers';
import {
  COVERAGE_DATE_RANGE_MESSAGE,
  COVERAGE_LIMIT_MESSAGE,
  COVERAGE_NOT_FOUND_MESSAGE,
  COVERAGE_PRIMARY_REQUIRED_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
  PAYER_INACTIVE_MESSAGE,
} from '../../domain/coverage-rules';
import { InMemoryPatientCoverageRepository } from '../__fixtures__/in-memory-patient-coverages';
import {
  COVERAGE_PAYER_NOT_FOUND_MESSAGE,
  CreatePatientCoverageUseCase,
  DeletePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  UpdatePatientCoverageUseCase,
} from './patient-coverages.use-cases';

describe('casos de uso de coberturas (DX-153)', () => {
  const PATIENT = 'patient-1';
  let payers: InMemoryPayerRepository;
  let repo: InMemoryPatientCoverageRepository;
  let list: ListPatientCoveragesUseCase;
  let create: CreatePatientCoverageUseCase;
  let update: UpdatePatientCoverageUseCase;
  let remove: DeletePatientCoverageUseCase;
  let sanitas: string;
  let sura: string;

  beforeEach(() => {
    payers = new InMemoryPayerRepository();
    repo = new InMemoryPatientCoverageRepository(payers);
    repo.knowPatient(PATIENT);
    const clock = () => new Date('2026-10-20T15:00:00.000Z');
    list = new ListPatientCoveragesUseCase(repo, clock);
    create = new CreatePatientCoverageUseCase(repo, payers, clock);
    update = new UpdatePatientCoverageUseCase(repo, payers, clock);
    remove = new DeletePatientCoverageUseCase(repo);
    sanitas = payers.seed({ name: 'Sanitas' }).id;
    sura = payers.seed({ name: 'Sura' }).id;
  });

  describe('listar', () => {
    it('404 si el paciente no es de esta clínica', async () => {
      await expect(list.execute('otra-clinica')).rejects.toThrow(
        new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
      );
    });

    it('vivas, principal primero y luego por alta, con el estado a hoy', async () => {
      repo.seed({ patientId: PATIENT, payerId: sanitas });
      repo.seed({
        patientId: PATIENT,
        payerId: sura,
        isPrimary: true,
        validTo: '2026-10-19',
      });
      const gone = repo.seed({ patientId: PATIENT, payerId: sura });
      gone.deleted = true;

      const out = await list.execute(PATIENT);
      expect(out.map((c) => [c.payer.name, c.isPrimary, c.status])).toEqual([
        ['Sura', true, 'EXPIRED'],
        ['Sanitas', false, 'ACTIVE'],
      ]);
    });
  });

  describe('crear', () => {
    it('404 del paciente de otra clínica', async () => {
      await expect(
        create.execute('otra-clinica', { payerId: sanitas }, 'u1'),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('400 con un pagador inexistente, de otra clínica o retirado', async () => {
      const retired = payers.seed({ name: 'Retirada' });
      payers.deleted.add(retired.id);
      for (const payerId of ['no-existe', retired.id]) {
        await expect(
          create.execute(PATIENT, { payerId }, 'u1'),
        ).rejects.toThrow(
          new BadRequestException(COVERAGE_PAYER_NOT_FOUND_MESSAGE),
        );
      }
    });

    it('400 con un pagador desactivado', async () => {
      const off = payers.seed({ name: 'Off', active: false });
      await expect(
        create.execute(PATIENT, { payerId: off.id }, 'u1'),
      ).rejects.toThrow(new BadRequestException(PAYER_INACTIVE_MESSAGE));
    });

    it('400 con la vigencia al revés o un día inexistente', async () => {
      await expect(
        create.execute(
          PATIENT,
          { payerId: sanitas, validFrom: '2026-05-02', validTo: '2026-05-01' },
          'u1',
        ),
      ).rejects.toThrow(new BadRequestException(COVERAGE_DATE_RANGE_MESSAGE));
      await expect(
        create.execute(
          PATIENT,
          { payerId: sanitas, validFrom: '2026-02-30' },
          'u1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('400 con el tope de 5 coberturas vivas; una retirada no cuenta', async () => {
      for (let i = 0; i < 5; i++) {
        await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      }
      await expect(
        create.execute(PATIENT, { payerId: sanitas }, 'u1'),
      ).rejects.toThrow(new BadRequestException(COVERAGE_LIMIT_MESSAGE));
      repo.rows[4].deleted = true;
      await expect(
        create.execute(PATIENT, { payerId: sanitas }, 'u1'),
      ).resolves.toBeDefined();
    });

    it('la primera viva es principal aunque pida lo contrario; recorta textos', async () => {
      const out = await create.execute(
        PATIENT,
        {
          payerId: sanitas,
          planName: '  Plan Oro ',
          memberNumber: ' 12345 ',
          policyHolderName: '   ',
          isPrimary: false,
          validFrom: '2026-01-01',
        },
        'u1',
      );
      expect(out).toMatchObject({
        isPrimary: true,
        planName: 'Plan Oro',
        memberNumber: '12345',
        policyHolderName: null,
        validFrom: '2026-01-01',
        validTo: null,
        status: 'ACTIVE',
        payer: { id: sanitas, name: 'Sanitas', active: true },
      });
    });

    it('la segunda no es principal si no se pide; con isPrimary:true desmarca la anterior', async () => {
      const first = await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      expect(second.isPrimary).toBe(false);

      const third = await create.execute(
        PATIENT,
        { payerId: sura, isPrimary: true },
        'u1',
      );
      expect(third.isPrimary).toBe(true);
      const primaries = repo.live(PATIENT).filter((r) => r.isPrimary);
      expect(primaries.map((r) => r.id)).toEqual([third.id]);
      expect(first.id).not.toBe(third.id);
    });

    it('el estado sale del día civil de la sede, no del reloj UTC', async () => {
      repo.today = '2026-10-21';
      const out = await create.execute(
        PATIENT,
        { payerId: sanitas, validTo: '2026-10-20' },
        'u1',
      );
      expect(out.status).toBe('EXPIRED');
    });
  });

  describe('editar', () => {
    let covId: string;
    beforeEach(async () => {
      covId = (await create.execute(PATIENT, { payerId: sanitas }, 'u1')).id;
    });

    it('404 del paciente ajeno y de una cobertura que no es suya', async () => {
      await expect(
        update.execute('otra-clinica', covId, { planName: 'X' }, 'u1'),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      await expect(
        update.execute(PATIENT, 'no-existe', { planName: 'X' }, 'u1'),
      ).rejects.toThrow(new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE));
    });

    it('null vacía los textos y las fechas; solo toca lo enviado', async () => {
      await update.execute(
        PATIENT,
        covId,
        { planName: 'Oro', memberNumber: '999', validFrom: '2026-01-01' },
        'u1',
      );
      const out = await update.execute(
        PATIENT,
        covId,
        { planName: null, validFrom: null, notes: '  nota ' },
        'u1',
      );
      expect(out).toMatchObject({
        planName: null,
        memberNumber: '999',
        validFrom: null,
        notes: 'nota',
      });
    });

    it('valida la vigencia sobre lo guardado: un fin anterior al inicio ya guardado es 400', async () => {
      await update.execute(PATIENT, covId, { validFrom: '2026-05-10' }, 'u1');
      await expect(
        update.execute(PATIENT, covId, { validTo: '2026-05-09' }, 'u1'),
      ).rejects.toThrow(new BadRequestException(COVERAGE_DATE_RANGE_MESSAGE));
    });

    it('cambiar de pagador exige uno activo; 400 si no existe', async () => {
      const off = payers.seed({ name: 'Off', active: false });
      await expect(
        update.execute(PATIENT, covId, { payerId: off.id }, 'u1'),
      ).rejects.toThrow(new BadRequestException(PAYER_INACTIVE_MESSAGE));
      await expect(
        update.execute(PATIENT, covId, { payerId: 'no-existe' }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_PAYER_NOT_FOUND_MESSAGE),
      );
      const out = await update.execute(PATIENT, covId, { payerId: sura }, 'u1');
      expect(out.payer.id).toBe(sura);
    });

    it('con el mismo pagador ya desactivado, editar otros campos vale', async () => {
      payers.rows.find((p) => p.id === sanitas)!.active = false;
      const out = await update.execute(
        PATIENT,
        covId,
        { payerId: sanitas, planName: 'Plata' },
        'u1',
      );
      expect(out).toMatchObject({
        planName: 'Plata',
        payer: { active: false },
      });
    });

    it('isPrimary:false sobre la única principal es 400', async () => {
      await expect(
        update.execute(PATIENT, covId, { isPrimary: false }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_PRIMARY_REQUIRED_MESSAGE),
      );
      expect(repo.live(PATIENT)[0].isPrimary).toBe(true);
    });

    it('isPrimary:false sobre una no principal no cambia nada', async () => {
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      const out = await update.execute(
        PATIENT,
        second.id,
        { isPrimary: false },
        'u1',
      );
      expect(out.isPrimary).toBe(false);
      expect(repo.live(PATIENT).find((r) => r.id === covId)!.isPrimary).toBe(
        true,
      );
    });

    it('isPrimary:true en otra la hace principal y desmarca la anterior', async () => {
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      const out = await update.execute(
        PATIENT,
        second.id,
        { isPrimary: true },
        'u1',
      );
      expect(out.isPrimary).toBe(true);
      expect(
        repo
          .live(PATIENT)
          .filter((r) => r.isPrimary)
          .map((r) => r.id),
      ).toEqual([second.id]);
    });

    it('la carrera del índice parcial sube como 422', async () => {
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      repo.failNextPrimaryWrite = true;
      await expect(
        update.execute(PATIENT, second.id, { isPrimary: true }, 'u1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(
        repo.live(PATIENT).find((r) => r.id === second.id)!.isPrimary,
      ).toBe(false);
    });

    it('la carrera en un alta con isPrimary:true sube como 422 y no deja la fila', async () => {
      const before = repo.live(PATIENT).length;
      repo.failNextPrimaryWrite = true;
      await expect(
        create.execute(PATIENT, { payerId: sura, isPrimary: true }, 'u1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.live(PATIENT)).toHaveLength(before);
    });
  });

  describe('retirar', () => {
    it('404 del paciente ajeno y de una cobertura inexistente o ya retirada', async () => {
      const c = await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      await expect(remove.execute('otra-clinica', c.id, 'u1')).rejects.toThrow(
        new NotFoundException(PATIENT_NOT_FOUND_MESSAGE),
      );
      await remove.execute(PATIENT, c.id, 'u1');
      await expect(remove.execute(PATIENT, c.id, 'u1')).rejects.toThrow(
        new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE),
      );
    });

    it('retirar la principal promueve la más antigua de las vivas', async () => {
      const a = await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      const b = await create.execute(PATIENT, { payerId: sura }, 'u1');
      const c = await create.execute(PATIENT, { payerId: sura }, 'u1');
      await remove.execute(PATIENT, a.id, 'u1');
      const left = await list.execute(PATIENT);
      expect(left.map((x) => [x.id, x.isPrimary])).toEqual([
        [b.id, true],
        [c.id, false],
      ]);
    });

    it('retirar una no principal no cambia la principal; retirar la última deja cero', async () => {
      const a = await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      const b = await create.execute(PATIENT, { payerId: sura }, 'u1');
      await remove.execute(PATIENT, b.id, 'u1');
      expect(repo.live(PATIENT).map((r) => [r.id, r.isPrimary])).toEqual([
        [a.id, true],
      ]);
      await remove.execute(PATIENT, a.id, 'u1');
      expect(repo.live(PATIENT)).toHaveLength(0);
    });
  });
});
