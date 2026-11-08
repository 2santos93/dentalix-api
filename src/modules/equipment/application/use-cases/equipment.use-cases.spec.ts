import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { ChairRepository } from '../../../chairs/domain/ports/chair-repository.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import {
  InMemoryEquipmentRepository,
  type FakeChair,
  type FakeLocation,
} from '../__fixtures__/in-memory-equipment';
import {
  CreateEquipmentUseCase,
  GetEquipmentUseCase,
  ListEquipmentUseCase,
  RecordMaintenanceUseCase,
  RetireEquipmentUseCase,
  UpdateEquipmentUseCase,
  VoidMaintenanceUseCase,
} from './equipment.use-cases';

const LOCATIONS: FakeLocation[] = [
  { id: 'norte', name: 'Sede Norte', timeZone: 'America/Caracas' },
  { id: 'sur', name: 'Sede Sur', timeZone: 'America/Caracas' },
];
const CHAIRS: FakeChair[] = [
  { id: 'ch-norte', name: 'Sillón 1', locationId: 'norte', active: true },
  { id: 'ch-norte-off', name: 'Sillón 9', locationId: 'norte', active: false },
  { id: 'ch-sur', name: 'Sillón S', locationId: 'sur', active: true },
];
/** 12:00 en Caracas del 6 de noviembre de 2026. */
const NOW = new Date('2026-11-06T16:00:00.000Z');

function makeLocations(): LocationRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(LOCATIONS.find((l) => l.id === id) ?? null),
  } as unknown as LocationRepository;
}

function makeChairs(): ChairRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(CHAIRS.find((c) => c.id === id) ?? null),
  } as unknown as ChairRepository;
}

const currencies: CurrencyWhitelist = {
  has: (code: string) => Promise.resolve(['USD', 'VES'].includes(code)),
};

function context(allowed: string[] | null = null): TenantContextService {
  const ctx = new TenantContextService();
  jest.spyOn(ctx, 'assertLocationAllowed').mockImplementation((id: string) => {
    if (allowed && !allowed.includes(id)) {
      throw new ForbiddenException('No tienes acceso a esta sede.');
    }
  });
  jest
    .spyOn(ctx, 'scopeLocationIds')
    .mockImplementation(() => (allowed ? [...allowed] : undefined));
  return ctx;
}

describe('reloj cerca de medianoche (DX-542)', () => {
  // 02:30 UTC del 7 de noviembre = 22:30 del 6 de noviembre en Caracas.
  const LATE = new Date('2026-11-07T02:30:00.000Z');

  it('cuenta «hoy» con el día de la sede, no con el UTC', async () => {
    const repo = new InMemoryEquipmentRepository(LOCATIONS, CHAIRS);
    const ctx = context();
    const clock = () => LATE;
    const record = new RecordMaintenanceUseCase(repo, currencies, ctx, clock);
    const get = new GetEquipmentUseCase(repo, ctx, clock);
    const eq = repo.seed({
      locationId: 'norte',
      maintenanceIntervalMonths: 1,
      acquiredOn: '2026-10-06',
    });
    // El 7 ya es hoy en UTC, pero en la sede todavía es futuro.
    await expect(
      record.execute(
        eq.id,
        { kind: 'CORRECTIVE', performedOn: '2026-11-07', description: 'x' },
        'admin',
      ),
    ).rejects.toThrow('La fecha del mantenimiento no puede ser futura.');
    // Adquirido el 06/10 cada mes: vence el 06/11, que en la sede es hoy
    // («vence pronto»), no ayer («vencido») como diría el día UTC.
    expect((await get.execute(eq.id)).maintenanceStatus).toBe('DUE_SOON');
    await expect(
      record.execute(
        eq.id,
        { kind: 'CORRECTIVE', performedOn: '2026-11-06', description: 'x' },
        'admin',
      ),
    ).resolves.toMatchObject({ performedOn: '2026-11-06' });
  });
});

describe('equipos biomédicos (DX-542)', () => {
  let repo: InMemoryEquipmentRepository;
  let list: ListEquipmentUseCase;
  let get: GetEquipmentUseCase;
  let create: CreateEquipmentUseCase;
  let update: UpdateEquipmentUseCase;
  let retire: RetireEquipmentUseCase;
  let record: RecordMaintenanceUseCase;
  let voidMaintenance: VoidMaintenanceUseCase;

  function build(allowed: string[] | null = null): void {
    repo = new InMemoryEquipmentRepository(LOCATIONS, CHAIRS);
    const ctx = context(allowed);
    const clock = () => NOW;
    const locations = makeLocations();
    const chairs = makeChairs();
    list = new ListEquipmentUseCase(repo, locations, ctx, clock);
    get = new GetEquipmentUseCase(repo, ctx, clock);
    create = new CreateEquipmentUseCase(repo, locations, chairs, ctx, clock);
    update = new UpdateEquipmentUseCase(repo, locations, chairs, ctx, clock);
    retire = new RetireEquipmentUseCase(repo, ctx, clock);
    record = new RecordMaintenanceUseCase(repo, currencies, ctx, clock);
    voidMaintenance = new VoidMaintenanceUseCase(repo, ctx);
  }

  beforeEach(() => build());

  describe('crear', () => {
    it('crea un equipo en su sede con el sillón de esa sede', async () => {
      const saved = await create.execute(
        {
          locationId: 'norte',
          chairId: 'ch-norte',
          name: ' Autoclave ',
          category: 'AUTOCLAVE',
          riskClass: 'IIB',
          acquiredOn: '2026-05-06',
          maintenanceIntervalMonths: 6,
        },
        'admin',
      );
      expect(saved).toMatchObject({
        locationId: 'norte',
        locationName: 'Sede Norte',
        chairId: 'ch-norte',
        chairName: 'Sillón 1',
        name: 'Autoclave',
        status: 'ACTIVE',
        // Sin preventivos: adquisición + 6 meses = hoy → «próximo».
        nextMaintenanceOn: '2026-11-06',
        maintenanceStatus: 'DUE_SOON',
      });
    });

    it('un sillón de otra sede da 400; uno que no existe (u otra clínica), 404', async () => {
      await expect(
        create.execute(
          {
            locationId: 'norte',
            chairId: 'ch-sur',
            name: 'X',
            category: 'OTHER',
          },
          'admin',
        ),
      ).rejects.toThrow(
        new BadRequestException('El sillón no es de la sede del equipo.'),
      );
      await expect(
        create.execute(
          {
            locationId: 'norte',
            chairId: 'ajeno',
            name: 'X',
            category: 'OTHER',
          },
          'admin',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        create.execute(
          {
            locationId: 'norte',
            chairId: 'ch-norte-off',
            name: 'X',
            category: 'OTHER',
          },
          'admin',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.rows).toHaveLength(0);
    });

    it('una sede ajena da 404 y una no permitida 403', async () => {
      await expect(
        create.execute(
          { locationId: 'otra', name: 'X', category: 'OTHER' },
          'a',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      build(['sur']);
      await expect(
        create.execute(
          { locationId: 'norte', name: 'X', category: 'OTHER' },
          'a',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('valida los campos con el «hoy» de la sede', async () => {
      await expect(
        create.execute(
          {
            locationId: 'norte',
            name: 'X',
            category: 'OTHER',
            acquiredOn: '2026-11-07',
          },
          'admin',
        ),
      ).rejects.toThrow('La fecha de adquisición no puede ser futura.');
    });
  });

  describe('listar', () => {
    beforeEach(async () => {
      await create.execute(
        {
          locationId: 'norte',
          name: 'Compresor',
          category: 'COMPRESSOR',
          acquiredOn: '2025-01-10',
          maintenanceIntervalMonths: 12,
        },
        'admin',
      );
      await create.execute(
        {
          locationId: 'sur',
          name: 'Autoclave',
          category: 'AUTOCLAVE',
          brand: 'Tuttnauer',
        },
        'admin',
      );
    });

    it('por sede, por estado y por búsqueda, paginado', async () => {
      const all = await list.execute({});
      expect(all).toMatchObject({ total: 2, page: 1, pageSize: 50 });
      expect(all.items.map((i) => i.name)).toEqual(['Autoclave', 'Compresor']);
      // Adquirido en enero de 2025 cada 12 meses: venció el 10/01/2026.
      expect(all.items[1]).toMatchObject({
        nextMaintenanceOn: '2026-01-10',
        maintenanceStatus: 'OVERDUE',
      });
      expect(all.items[0].maintenanceStatus).toBe('UNSCHEDULED');
      expect((await list.execute({ locationId: 'norte' })).total).toBe(1);
      expect((await list.execute({ query: 'tuttn' })).items[0].name).toBe(
        'Autoclave',
      );
      expect((await list.execute({ status: 'RETIRED' })).total).toBe(0);
      const page = await list.execute({ page: 2, pageSize: 1 });
      expect(page.items.map((i) => i.name)).toEqual(['Compresor']);
    });

    it('sin sede explícita lista solo las sedes permitidas', async () => {
      build(['sur']);
      repo.seed({ locationId: 'norte', name: 'De Norte' });
      repo.seed({ locationId: 'sur', name: 'De Sur' });
      const res = await list.execute({});
      expect(res.items.map((i) => i.name)).toEqual(['De Sur']);
      await expect(
        list.execute({ locationId: 'norte' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('editar y dar de baja', () => {
    it('edita y, al cambiar de sede, quita el sillón salvo que venga uno de la nueva', async () => {
      const eq = await create.execute(
        {
          locationId: 'norte',
          chairId: 'ch-norte',
          name: 'Lámpara',
          category: 'CURING_LIGHT',
        },
        'admin',
      );
      const moved = await update.execute(eq.id, { locationId: 'sur' }, 'admin');
      expect(moved).toMatchObject({ locationId: 'sur', chairId: null });
      await expect(
        update.execute(eq.id, { chairId: 'ch-norte' }, 'admin'),
      ).rejects.toThrow('El sillón no es de la sede del equipo.');
      const withChair = await update.execute(
        eq.id,
        {
          chairId: 'ch-sur',
          brand: 'Woodpecker',
          maintenanceIntervalMonths: 12,
        },
        'admin',
      );
      expect(withChair).toMatchObject({
        chairName: 'Sillón S',
        brand: 'Woodpecker',
        maintenanceIntervalMonths: 12,
      });
    });

    it('da de baja con fecha y motivo una sola vez; después no se edita ni se le registra nada', async () => {
      const eq = await create.execute(
        {
          locationId: 'norte',
          name: 'Rayos X',
          category: 'XRAY',
          acquiredOn: '2020-01-01',
        },
        'admin',
      );
      const retired = await retire.execute(
        eq.id,
        { reason: 'Reemplazado por uno digital' },
        'admin',
      );
      expect(retired).toMatchObject({
        status: 'RETIRED',
        retiredOn: '2026-11-06',
        retiredReason: 'Reemplazado por uno digital',
        maintenanceStatus: null,
      });
      await expect(
        retire.execute(eq.id, { reason: 'Otra vez' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        update.execute(eq.id, { name: 'Nuevo' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        record.execute(
          eq.id,
          { kind: 'PREVENTIVE', performedOn: '2026-11-01', description: 'x' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('la baja no es anterior a la adquisición ni futura', async () => {
      const eq = await create.execute(
        {
          locationId: 'norte',
          name: 'Rayos X',
          category: 'XRAY',
          acquiredOn: '2026-01-01',
        },
        'admin',
      );
      await expect(
        retire.execute(eq.id, { retiredOn: '2025-12-31', reason: 'Roto' }, 'a'),
      ).rejects.toThrow('La baja no puede ser anterior a la adquisición.');
      await expect(
        retire.execute(eq.id, { retiredOn: '2026-11-07', reason: 'Roto' }, 'a'),
      ).rejects.toThrow('La fecha de la baja no puede ser futura.');
    });

    it('null en la sede, el tipo o el nombre es un 400, no una escritura', async () => {
      const eq = repo.seed({ locationId: 'norte', name: 'Lámpara' });
      for (const body of [
        { locationId: null },
        { category: null },
        { name: null },
      ]) {
        await expect(
          update.execute(eq.id, body as never, 'admin'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(repo.rows[0]).toMatchObject({
        locationId: 'norte',
        name: 'Lámpara',
      });
    });

    it('un equipo de otra clínica da 404', async () => {
      await expect(update.execute('nope', { name: 'x' }, 'a')).rejects.toThrow(
        new NotFoundException('Equipo no encontrado'),
      );
      await expect(get.execute('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('mantenimientos y hoja de vida', () => {
    it('un preventivo programa el próximo por la periodicidad y la hoja de vida va en orden cronológico', async () => {
      const eq = await create.execute(
        {
          locationId: 'norte',
          name: 'Autoclave',
          category: 'AUTOCLAVE',
          acquiredOn: '2025-01-10',
          maintenanceIntervalMonths: 6,
        },
        'admin',
      );
      expect((await get.execute(eq.id)).maintenanceStatus).toBe('OVERDUE');
      const preventive = await record.execute(
        eq.id,
        {
          kind: 'PREVENTIVE',
          performedOn: '2026-11-02',
          description: 'Limpieza de cámara y prueba de vacío',
          technician: 'Luis Pérez',
          company: 'Servitec',
          cost: 80,
          currency: 'usd',
        },
        'admin',
      );
      expect(preventive).toMatchObject({
        nextDueOn: '2027-05-02',
        cost: 80,
        currency: 'USD',
      });
      await record.execute(
        eq.id,
        {
          kind: 'CORRECTIVE',
          performedOn: '2026-03-15',
          description: 'Cambio de empaque',
        },
        'admin',
      );
      const detail = await get.execute(eq.id);
      expect(detail).toMatchObject({
        nextMaintenanceOn: '2027-05-02',
        maintenanceStatus: 'UP_TO_DATE',
        lastMaintenanceOn: '2026-11-02',
      });
      expect(detail.maintenances.map((m) => m.performedOn)).toEqual([
        '2026-03-15',
        '2026-11-02',
      ]);
    });

    it('una moneda que la clínica no conoce da 400 y la fecha no es futura', async () => {
      const eq = repo.seed({ locationId: 'norte' });
      await expect(
        record.execute(
          eq.id,
          {
            kind: 'CORRECTIVE',
            performedOn: '2026-11-01',
            description: 'x',
            cost: 5,
            currency: 'XXX',
          },
          'admin',
        ),
      ).rejects.toThrow('Esa moneda no está en la lista de monedas admitidas.');
      await expect(
        record.execute(
          eq.id,
          { kind: 'CORRECTIVE', performedOn: '2026-11-07', description: 'x' },
          'admin',
        ),
      ).rejects.toThrow('La fecha del mantenimiento no puede ser futura.');
      expect(repo.maintenances).toHaveLength(0);
    });

    it('anular un preventivo devuelve el próximo al anterior; la segunda anulación da 409', async () => {
      const eq = await create.execute(
        {
          locationId: 'norte',
          name: 'Compresor',
          category: 'COMPRESSOR',
          maintenanceIntervalMonths: 3,
        },
        'admin',
      );
      await record.execute(
        eq.id,
        { kind: 'PREVENTIVE', performedOn: '2026-05-01', description: 'Purga' },
        'admin',
      );
      const wrong = await record.execute(
        eq.id,
        {
          kind: 'PREVENTIVE',
          performedOn: '2026-11-01',
          description: 'Mal cargado',
        },
        'admin',
      );
      const voided = await voidMaintenance.execute(
        eq.id,
        wrong.id,
        'Se registró en el equipo equivocado',
        'admin',
      );
      expect(voided.voidReason).toBe('Se registró en el equipo equivocado');
      const detail = await get.execute(eq.id);
      expect(detail).toMatchObject({
        nextMaintenanceOn: '2026-08-01',
        maintenanceStatus: 'OVERDUE',
      });
      // El anulado sigue en la hoja de vida, marcado.
      expect(detail.maintenances).toHaveLength(2);
      await expect(
        voidMaintenance.execute(eq.id, wrong.id, 'Otra vez', 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        voidMaintenance.execute(eq.id, 'nope', 'Motivo', 'admin'),
      ).rejects.toThrow(new NotFoundException('Mantenimiento no encontrado'));
    });

    it('la fecha del mantenimiento no es anterior a la adquisición', async () => {
      const eq = repo.seed({ locationId: 'norte', acquiredOn: '2026-06-01' });
      await expect(
        record.execute(
          eq.id,
          { kind: 'CORRECTIVE', performedOn: '2026-05-31', description: 'x' },
          'admin',
        ),
      ).rejects.toThrow(
        'La fecha del mantenimiento no puede ser anterior a la adquisición del equipo.',
      );
    });

    it('si otra petición da de baja el equipo en medio (carrera), editar y registrar dan 409, no 500', async () => {
      const eq = repo.seed({ locationId: 'norte' });
      const retireBehind = () => {
        repo.rows.find((r) => r.id === eq.id)!.status = 'RETIRED';
      };
      jest.spyOn(repo, 'update').mockImplementationOnce(() => {
        retireBehind();
        return Promise.resolve(null);
      });
      await expect(
        update.execute(eq.id, { name: 'Nuevo' }, 'admin'),
      ).rejects.toThrow(
        new ConflictException(
          'El equipo está dado de baja: ya no se edita ni se le registran mantenimientos.',
        ),
      );
      repo.rows.find((r) => r.id === eq.id)!.status = 'ACTIVE';
      jest.spyOn(repo, 'addMaintenance').mockImplementationOnce(() => {
        retireBehind();
        return Promise.resolve(null);
      });
      await expect(
        record.execute(
          eq.id,
          { kind: 'CORRECTIVE', performedOn: '2026-11-01', description: 'x' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('un restringido no toca equipos de otra sede (403)', async () => {
      const eq = repo.seed({ locationId: 'norte' });
      build(['sur']);
      repo.rows.push({ ...eq });
      await expect(get.execute(eq.id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        record.execute(
          eq.id,
          { kind: 'CORRECTIVE', performedOn: '2026-11-01', description: 'x' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
