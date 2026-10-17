import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { InMemoryImplantRepository } from '../__fixtures__/in-memory-implants';
import {
  GetImplantCardUseCase,
  ListPatientImplantsUseCase,
  RegisterImplantUseCase,
  SearchImplantsByLotUseCase,
  VoidImplantUseCase,
  type RegisterImplantInput,
} from './implants.use-cases';

// 2026-10-17 15:00 UTC = 10:00 en Bogotá.
const NOW = new Date('2026-10-17T15:00:00.000Z');
const clock = () => NOW;

const IMPLANT: RegisterImplantInput = {
  toothNumber: '36',
  kind: 'IMPLANT',
  manufacturer: 'Straumann',
  system: 'BLT',
  reference: '021.5310',
  lot: 'LOT-AB12',
  diameterMm: 4.1,
  lengthMm: 10,
};

describe('Implantes (DX-191, casos de uso)', () => {
  let repo: InMemoryImplantRepository;
  let register: RegisterImplantUseCase;

  beforeEach(() => {
    repo = new InMemoryImplantRepository();
    repo.patients.set('p1', {
      id: 'p1',
      firstName: 'Ana',
      lastName: 'Gómez',
      docType: 'CC',
      docNumber: '52123456',
      birthDate: null,
    });
    repo.planItems.set('item-p1', 'p1');
    repo.planItems.set('item-p2', 'p2');
    register = new RegisterImplantUseCase(repo, clock);
  });

  describe('registrar', () => {
    it('guarda con profesional del token, sede del request y hoy en la sede', async () => {
      const created = await register.execute('p1', IMPLANT, 'dr-1');
      expect(created).toMatchObject({
        professionalId: 'dr-1',
        locationId: 'loc-1',
        placedOn: '2026-10-17',
        toothNumber: '36',
        manufacturer: 'Straumann',
        reference: '021.5310',
        lot: 'LOT-AB12',
      });
    });

    it('400 en español si faltan fabricante, referencia y lote', async () => {
      const err = await register
        .execute(
          'p1',
          { ...IMPLANT, manufacturer: '', reference: ' ', lot: undefined },
          'dr-1',
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toBe(
        'No se puede registrar el implante: falta el fabricante; falta la referencia (REF); falta el lote.',
      );
    });

    it('400 con un diente FDI inválido', async () => {
      await expect(
        register.execute('p1', { ...IMPLANT, toothNumber: '19' }, 'dr-1'),
      ).rejects.toThrow(/no es un código FDI válido/);
    });

    it('404 si el paciente no es de esta clínica', async () => {
      await expect(register.execute('otro', IMPLANT, 'dr-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('400 si el ítem del plan es de otro paciente', async () => {
      await expect(
        register.execute(
          'p1',
          { ...IMPLANT, treatmentPlanItemId: 'item-p2' },
          'dr-1',
        ),
      ).rejects.toThrow('El ítem del plan no es de un plan de este paciente');
      await expect(
        register.execute(
          'p1',
          { ...IMPLANT, treatmentPlanItemId: 'item-p1' },
          'dr-1',
        ),
      ).resolves.toMatchObject({ treatmentPlanItemId: 'item-p1' });
    });

    it('rechaza una fecha de colocación futura', async () => {
      await expect(
        register.execute('p1', { ...IMPLANT, placedOn: '2026-10-18' }, 'dr-1'),
      ).rejects.toThrow('La fecha de colocación no puede ser posterior a hoy');
    });
  });

  describe('anular', () => {
    it('exige motivo, autor o ADMIN, y una sola vez', async () => {
      const voider = new VoidImplantUseCase(repo, clock);
      const { id } = await register.execute('p1', IMPLANT, 'dr-1');
      await expect(
        voider.execute(id, '  ', { userId: 'dr-1', role: ClinicRole.DENTIST }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        voider.execute(id, 'Lote mal transcrito', {
          userId: 'dr-2',
          role: ClinicRole.DENTIST,
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        voider.execute(id, 'Lote mal transcrito', {
          userId: 'admin',
          role: ClinicRole.ADMIN,
        }),
      ).resolves.toMatchObject({
        voidedAt: NOW,
        voidedById: 'admin',
        voidReason: 'Lote mal transcrito',
      });
      await expect(
        voider.execute(id, 'Otra vez', {
          userId: 'dr-1',
          role: ClinicRole.DENTIST,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('tarjeta', () => {
    it('compone la intervención del día con implante y pilar, y registra la entrega', async () => {
      const card = new GetImplantCardUseCase(repo, clock);
      await register.execute('p1', IMPLANT, 'dr-1');
      await register.execute(
        'p1',
        { ...IMPLANT, kind: 'ABUTMENT', reference: 'RC-ABUT', lot: 'LOT-P1' },
        'dr-1',
      );
      const shown = await card.execute('p1', '2026-10-17');
      expect(shown).toMatchObject({
        patientName: 'Ana Gómez',
        patientDocument: 'CC 52123456',
        clinicName: 'Clínica Demo',
        deliveredAt: null,
      });
      expect(shown.items.map((i) => i.kindLabel)).toEqual([
        'Implante',
        'Pilar',
      ]);
      const delivered = await card.deliver('p1', '2026-10-17', 'rec-1');
      expect(delivered.deliveredAt).toEqual(NOW);
    });

    it('400 sin día válido y 404 sin implantes ese día', async () => {
      const card = new GetImplantCardUseCase(repo, clock);
      await expect(card.execute('p1', undefined)).rejects.toThrow(
        BadRequestException,
      );
      await expect(card.execute('p1', '2026-10-01')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('listar: 404 con un paciente ajeno', async () => {
    await expect(
      new ListPatientImplantsUseCase(repo).execute('otro'),
    ).rejects.toThrow(NotFoundException);
  });

  it('buscar: exige lote o referencia y los recorta', async () => {
    const search = new SearchImplantsByLotUseCase(repo);
    await expect(search.execute({ lot: ' ', reference: '' })).rejects.toThrow(
      'Indica el lote o la referencia (REF) a buscar',
    );
    await search.execute({ lot: ' LOT-1 ', locationId: 'loc-1' });
    expect(repo.lastQuery).toEqual({
      lot: 'LOT-1',
      reference: undefined,
      locationId: 'loc-1',
    });
  });
});
