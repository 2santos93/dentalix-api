import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { InMemoryPayerRepository } from '../../../payers/application/__fixtures__/in-memory-payers';
import {
  COVERAGE_DATE_RANGE_MESSAGE,
  COVERAGE_LIMIT_MESSAGE,
  COVERAGE_NOT_FOUND_MESSAGE,
  COVERAGE_PRIMARY_REQUIRED_MESSAGE,
  COVERAGE_VERIFY_INTERNAL_MESSAGE,
  COVERAGE_VERIFY_NO_NUMBER_MESSAGE,
  COVERAGE_VERIFY_STALE_MESSAGE,
  PATIENT_NOT_FOUND_MESSAGE,
  PAYER_INACTIVE_MESSAGE,
} from '../../domain/coverage-rules';
import {
  MEMBER_NUMBER_DIGIT_MESSAGE,
  MEMBER_NUMBER_REQUIRED_MESSAGE,
} from '../../domain/member-number-rules';
import { InMemoryPatientCoverageRepository } from '../__fixtures__/in-memory-patient-coverages';
import {
  COVERAGE_PAYER_NOT_FOUND_MESSAGE,
  CreatePatientCoverageUseCase,
  DeletePatientCoverageUseCase,
  ListPatientCoveragesUseCase,
  UpdatePatientCoverageUseCase,
  VerifyPatientCoverageUseCase,
  type UpdatePatientCoverageInput,
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
  /** Edita con ese usuario y rol (recepción por omisión) y da la cobertura. */
  const edit = async (
    patientId: string,
    coverageId: string,
    input: UpdatePatientCoverageInput,
    userId: string,
    role: ClinicRole = ClinicRole.RECEPTION,
  ) =>
    (await update.execute(patientId, coverageId, input, { userId, role }))
      .coverage;

  beforeEach(() => {
    payers = new InMemoryPayerRepository();
    repo = new InMemoryPatientCoverageRepository(payers);
    repo.knowPatient(PATIENT);
    const clock = () => new Date('2026-10-20T15:00:00.000Z');
    list = new ListPatientCoveragesUseCase(repo, clock);
    create = new CreatePatientCoverageUseCase(repo, payers, clock);
    update = new UpdatePatientCoverageUseCase(repo, payers, clock);
    remove = new DeletePatientCoverageUseCase(repo);
    // Pagadores OTRO: estas pruebas de DX-153 no van del nº de afiliado, que
    // con un pagador externo es obligatorio (SEC-049, más abajo).
    sanitas = payers.seed({ name: 'Sanitas', type: 'OTHER' }).id;
    sura = payers.seed({ name: 'Sura', type: 'OTHER' }).id;
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
        edit('otra-clinica', covId, { planName: 'X' }, 'u1'),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      await expect(
        edit(PATIENT, 'no-existe', { planName: 'X' }, 'u1'),
      ).rejects.toThrow(new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE));
    });

    it('null vacía los textos y las fechas; solo toca lo enviado', async () => {
      await edit(
        PATIENT,
        covId,
        { planName: 'Oro', memberNumber: '999', validFrom: '2026-01-01' },
        'u1',
      );
      const out = await edit(
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
      await edit(PATIENT, covId, { validFrom: '2026-05-10' }, 'u1');
      await expect(
        edit(PATIENT, covId, { validTo: '2026-05-09' }, 'u1'),
      ).rejects.toThrow(new BadRequestException(COVERAGE_DATE_RANGE_MESSAGE));
    });

    it('cambiar de pagador exige uno activo; 400 si no existe', async () => {
      const off = payers.seed({ name: 'Off', active: false });
      await expect(
        edit(PATIENT, covId, { payerId: off.id }, 'u1'),
      ).rejects.toThrow(new BadRequestException(PAYER_INACTIVE_MESSAGE));
      await expect(
        edit(PATIENT, covId, { payerId: 'no-existe' }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_PAYER_NOT_FOUND_MESSAGE),
      );
      const out = await edit(PATIENT, covId, { payerId: sura }, 'u1');
      expect(out.payer.id).toBe(sura);
    });

    it('con el mismo pagador ya desactivado, editar otros campos vale', async () => {
      payers.rows.find((p) => p.id === sanitas)!.active = false;
      const out = await edit(
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
        edit(PATIENT, covId, { isPrimary: false }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_PRIMARY_REQUIRED_MESSAGE),
      );
      expect(repo.live(PATIENT)[0].isPrimary).toBe(true);
    });

    it('isPrimary:false sobre una no principal no cambia nada', async () => {
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      const out = await edit(PATIENT, second.id, { isPrimary: false }, 'u1');
      expect(out.isPrimary).toBe(false);
      expect(repo.live(PATIENT).find((r) => r.id === covId)!.isPrimary).toBe(
        true,
      );
    });

    it('isPrimary:true en otra la hace principal y desmarca la anterior', async () => {
      const second = await create.execute(PATIENT, { payerId: sura }, 'u1');
      const out = await edit(PATIENT, second.id, { isPrimary: true }, 'u1');
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
        edit(PATIENT, second.id, { isPrimary: true }, 'u1'),
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

  describe('nº de afiliado y verificación (SEC-049)', () => {
    let external: string;
    let verify: VerifyPatientCoverageUseCase;
    beforeEach(() => {
      external = payers.seed({
        name: 'Aseguradora Norte',
        type: 'EMPLOYER',
      }).id;
      verify = new VerifyPatientCoverageUseCase(
        repo,
        () => new Date('2026-10-20T15:00:00.000Z'),
      );
      repo.userNames.set('admin-1', 'Ana Admin');
    });

    it('alta con un pagador externo sin nº: 400 en español y nada escrito', async () => {
      await expect(
        create.execute(
          PATIENT,
          { payerId: external, memberNumber: '  ' },
          'u1',
        ),
      ).rejects.toThrow(
        new BadRequestException(MEMBER_NUMBER_REQUIRED_MESSAGE),
      );
      await expect(
        create.execute(
          PATIENT,
          { payerId: external, memberNumber: 'ABCD' },
          'u1',
        ),
      ).rejects.toThrow(new BadRequestException(MEMBER_NUMBER_DIGIT_MESSAGE));
      expect(repo.rows).toHaveLength(0);
    });

    it('alta con nº válido: normalizado, declarada por quien la crea y sin verificar', async () => {
      const out = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: ' 1020  304050 ' },
        'u1',
      );
      expect(out).toMatchObject({
        memberNumber: '1020 304050',
        declaredById: 'u1',
        verifiedAt: null,
        verifiedById: null,
      });
    });

    it('una cobertura anterior sin nº se edita (notas, fechas) sin pedirlo', async () => {
      const old = repo.seed({ patientId: PATIENT, payerId: external });
      await expect(
        edit(PATIENT, old.id, { notes: 'Llamar antes' }, 'u2'),
      ).resolves.toMatchObject({ notes: 'Llamar antes', memberNumber: null });
    });

    it('cambiar el pagador a uno externo o vaciar el nº lo exige', async () => {
      const c = await create.execute(PATIENT, { payerId: sanitas }, 'u1');
      await expect(
        edit(PATIENT, c.id, { payerId: external }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(MEMBER_NUMBER_REQUIRED_MESSAGE),
      );
      const e = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: '1020304050' },
        'u1',
      );
      await expect(
        edit(PATIENT, e.id, { memberNumber: null }, 'u1'),
      ).rejects.toThrow(
        new BadRequestException(MEMBER_NUMBER_REQUIRED_MESSAGE),
      );
    });

    it('verificar: marca quién y cuándo, con el nombre de quien verifica', async () => {
      const c = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: '1020304050' },
        'u1',
      );
      const out = await verify.execute(PATIENT, c.id, '1020304050', 'admin-1');
      expect(out).toMatchObject({
        verifiedById: 'admin-1',
        verifiedByName: 'Ana Admin',
        verifiedAt: repo.now,
        status: 'ACTIVE',
      });
    });

    it('verificar: 404 ajena, 400 sin nº o de pagador interno, 409 si el nº cambió', async () => {
      await expect(
        verify.execute('otra-clinica', 'x', '1', 'admin-1'),
      ).rejects.toThrow(new NotFoundException(PATIENT_NOT_FOUND_MESSAGE));
      await expect(
        verify.execute(PATIENT, 'no-existe', '1', 'admin-1'),
      ).rejects.toThrow(new NotFoundException(COVERAGE_NOT_FOUND_MESSAGE));
      const legacy = repo.seed({ patientId: PATIENT, payerId: external });
      await expect(
        verify.execute(PATIENT, legacy.id, '', 'admin-1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_VERIFY_NO_NUMBER_MESSAGE),
      );
      const internal = await create.execute(
        PATIENT,
        { payerId: sanitas, memberNumber: '12345' },
        'u1',
      );
      await expect(
        verify.execute(PATIENT, internal.id, '12345', 'admin-1'),
      ).rejects.toThrow(
        new BadRequestException(COVERAGE_VERIFY_INTERNAL_MESSAGE),
      );
      const c = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: '1020304050' },
        'u1',
      );
      await expect(
        verify.execute(PATIENT, c.id, '1020304051', 'admin-1'),
      ).rejects.toThrow(new ConflictException(COVERAGE_VERIFY_STALE_MESSAGE));
      expect(repo.rows.find((r) => r.id === c.id)?.verifiedAt).toBeNull();
    });

    it('verificar: 409 si el pagador cambió entre la lectura y el candado', async () => {
      const c = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: '1020304050' },
        'u1',
      );
      const moved = payers.seed({ name: 'Cortesía', type: 'OTHER' }).id;
      const read = repo.findById.bind(repo);
      // Otra petición cambia el pagador justo después de que el caso de uso lea.
      jest.spyOn(repo, 'findById').mockImplementationOnce(async (p, id) => {
        const seen = await read(p, id);
        const row = repo.rows.find((r) => r.id === id);
        if (row) row.payerId = moved;
        return seen;
      });
      await expect(
        verify.execute(PATIENT, c.id, '1020304050', 'admin-1'),
      ).rejects.toThrow(new ConflictException(COVERAGE_VERIFY_STALE_MESSAGE));
      expect(repo.rows.find((r) => r.id === c.id)?.verifiedAt).toBeNull();
    });

    it('editar el nº (o el pagador) borra la verificación y el editor pasa a declararlo', async () => {
      const otherExternal = payers.seed({
        name: 'Aseguradora Sur',
        type: 'EMPLOYER',
      }).id;
      const c = await create.execute(
        PATIENT,
        { payerId: external, memberNumber: '1020304050' },
        'u1',
      );
      await verify.execute(PATIENT, c.id, '1020304050', 'admin-1');

      // El mismo número con otros espacios o tocar otros campos no la borra.
      const same = await edit(
        PATIENT,
        c.id,
        { memberNumber: ' 1020304050 ', notes: 'ok' },
        'u2',
      );
      expect(same).toMatchObject({
        verifiedById: 'admin-1',
        declaredById: 'u1',
      });

      const changed = await edit(
        PATIENT,
        c.id,
        { memberNumber: '1020304059' },
        'u2',
      );
      expect(changed).toMatchObject({
        verifiedAt: null,
        verifiedById: null,
        verifiedByName: null,
        declaredById: 'u2',
      });

      await verify.execute(PATIENT, c.id, '1020304059', 'admin-1');
      const moved = await edit(PATIENT, c.id, { payerId: otherExternal }, 'u3');
      expect(moved).toMatchObject({ verifiedAt: null, declaredById: 'u3' });
    });

    describe('vigencia de una cobertura verificada (SEC-053)', () => {
      async function verifiedExpired() {
        const c = await create.execute(
          PATIENT,
          {
            payerId: external,
            memberNumber: '1020304050',
            validFrom: '2025-01-01',
            validTo: '2026-06-30',
          },
          'admin-1',
        );
        await verify.execute(PATIENT, c.id, '1020304050', 'admin-1');
        return c.id;
      }

      it.each([ClinicRole.RECEPTION, ClinicRole.ASSISTANT, ClinicRole.DENTIST])(
        '%s alarga o quita el fin: queda sin verificar, declarada por él, y lo cuenta para la auditoría',
        async (role) => {
          const id = await verifiedExpired();
          const out = await update.execute(
            PATIENT,
            id,
            { validTo: null },
            { userId: 'u2', role },
          );
          expect(out.coverage).toMatchObject({
            validTo: null,
            status: 'ACTIVE',
            verifiedAt: null,
            verifiedById: null,
            verifiedByName: null,
            declaredById: 'u2',
          });
          expect(out.validityChange).toEqual({
            before: { validFrom: '2025-01-01', validTo: '2026-06-30' },
            after: { validFrom: '2025-01-01', validTo: null },
            verificationCleared: true,
          });
        },
      );

      it('ADMIN cambia la vigencia y sigue verificada', async () => {
        const id = await verifiedExpired();
        const out = await update.execute(
          PATIENT,
          id,
          { validTo: '2027-06-30' },
          { userId: 'admin-1', role: ClinicRole.ADMIN },
        );
        expect(out.coverage).toMatchObject({
          validTo: '2027-06-30',
          verifiedById: 'admin-1',
          declaredById: 'admin-1',
        });
        expect(out.validityChange).toMatchObject({
          after: { validTo: '2027-06-30' },
          verificationCleared: false,
        });
      });

      it('cambiar solo las notas, o enviar la misma vigencia, no la toca', async () => {
        const id = await verifiedExpired();
        const out = await update.execute(
          PATIENT,
          id,
          {
            notes: 'Pedir el carné nuevo',
            validFrom: '2025-01-01',
            validTo: '2026-06-30',
          },
          { userId: 'u2', role: ClinicRole.RECEPTION },
        );
        expect(out.coverage).toMatchObject({
          notes: 'Pedir el carné nuevo',
          verifiedById: 'admin-1',
          declaredById: 'admin-1',
        });
        expect(out.validityChange).toBeNull();
      });
    });
  });
});
