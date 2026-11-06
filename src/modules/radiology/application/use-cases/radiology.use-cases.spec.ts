import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { EquipmentRepository } from '../../../equipment/domain/ports/equipment-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import {
  InMemoryRadiologyRepository,
  type FakeEquipment,
  type FakeLocation,
  type FakeMember,
} from '../__fixtures__/in-memory-radiology';
import {
  CreateRadiologyRecordUseCase,
  GetRadiologyRecordUseCase,
  ListRadiologyDueUseCase,
  ListRadiologyRecordsUseCase,
  UpdateRadiologyRecordUseCase,
  VoidRadiologyRecordUseCase,
} from './radiology.use-cases';

const LOCATIONS: FakeLocation[] = [
  { id: 'norte', name: 'Sede Norte', timeZone: 'America/Lima' },
  { id: 'sur', name: 'Sede Sur', timeZone: 'America/Lima' },
  { id: 'sin-zona', name: 'Sede sin zona', timeZone: null },
];
const EQUIPMENT: FakeEquipment[] = [
  {
    id: 'rx-norte',
    name: 'Periapical',
    locationId: 'norte',
    category: 'XRAY',
    status: 'ACTIVE',
  },
  {
    id: 'rx-norte-baja',
    name: 'Periapical vieja',
    locationId: 'norte',
    category: 'XRAY',
    status: 'RETIRED',
  },
  {
    id: 'autoclave',
    name: 'Autoclave',
    locationId: 'norte',
    category: 'AUTOCLAVE',
    status: 'ACTIVE',
  },
  {
    id: 'rx-sur',
    name: 'Panorámico',
    locationId: 'sur',
    category: 'XRAY',
    status: 'ACTIVE',
  },
];
const MEMBERS: FakeMember[] = [{ userId: 'dra-ana', fullName: 'Dra. Ana' }];
/** 12:00 en Lima del 6 de noviembre de 2026. */
const NOW = new Date('2026-11-06T17:00:00.000Z');

const locations = {
  findById: (id: string) =>
    Promise.resolve(LOCATIONS.find((l) => l.id === id) ?? null),
} as unknown as LocationRepository;
const equipment = {
  findById: (id: string) =>
    Promise.resolve(EQUIPMENT.find((e) => e.id === id) ?? null),
} as unknown as EquipmentRepository;
const staff = {
  findById: (userId: string) =>
    Promise.resolve(MEMBERS.find((m) => m.userId === userId) ?? null),
} as unknown as StaffRepository;

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

const LICENSE = {
  kind: 'LICENSE' as const,
  locationId: 'norte',
  category: 'I' as const,
  reference: 'Res. 2021-0456',
  issuer: 'Autoridad sanitaria regional',
  issuedOn: '2026-02-10',
};
const QUALITY = {
  kind: 'QUALITY_CONTROL' as const,
  locationId: 'norte',
  issuer: 'Física Médica SAS',
  issuedOn: '2026-02-10',
};

describe('expediente de rayos X (DX-544)', () => {
  let repo: InMemoryRadiologyRepository;
  let list: ListRadiologyRecordsUseCase;
  let get: GetRadiologyRecordUseCase;
  let create: CreateRadiologyRecordUseCase;
  let update: UpdateRadiologyRecordUseCase;
  let voidRecord: VoidRadiologyRecordUseCase;
  let due: ListRadiologyDueUseCase;

  function build(allowed: string[] | null = null, now = NOW): void {
    repo = new InMemoryRadiologyRepository(LOCATIONS, EQUIPMENT, MEMBERS);
    const ctx = context(allowed);
    const clock = () => now;
    list = new ListRadiologyRecordsUseCase(repo, locations, ctx, clock);
    get = new GetRadiologyRecordUseCase(repo, ctx, clock);
    create = new CreateRadiologyRecordUseCase(
      repo,
      locations,
      equipment,
      staff,
      ctx,
      clock,
    );
    update = new UpdateRadiologyRecordUseCase(
      repo,
      locations,
      equipment,
      staff,
      ctx,
      clock,
    );
    voidRecord = new VoidRadiologyRecordUseCase(repo, ctx, clock);
    due = new ListRadiologyDueUseCase(repo, ctx, clock);
  }

  beforeEach(() => build());

  describe('alta y cálculo del vencimiento', () => {
    it('licencia Cat. I sin vencimiento: +5 años; Cat. II: +4; control de calidad: +2', async () => {
      const one = await create.execute(LICENSE, 'admin');
      expect(one).toMatchObject({
        kind: 'LICENSE',
        category: 'I',
        expiresOn: '2031-02-10',
        status: 'UP_TO_DATE',
        locationName: 'Sede Norte',
      });
      expect(
        (await create.execute({ ...LICENSE, category: 'II' }, 'admin'))
          .expiresOn,
      ).toBe('2030-02-10');
      expect((await create.execute(QUALITY, 'admin')).expiresOn).toBe(
        '2028-02-10',
      );
    });

    it('respeta el vencimiento que dice el papel', async () => {
      expect(
        (await create.execute({ ...LICENSE, expiresOn: '2027-01-15' }, 'admin'))
          .status,
      ).toBe('DUE_SOON');
    });

    it('el control de calidad con categoría da 400 sin crear nada', async () => {
      await expect(
        create.execute({ ...QUALITY, category: 'I' }, 'admin'),
      ).rejects.toThrow('La categoría solo va en una licencia.');
      expect(repo.rows).toHaveLength(0);
    });

    it('sede de otra clínica 404, no permitida 403, sin zona 400', async () => {
      await expect(
        create.execute({ ...LICENSE, locationId: 'otra' }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
      build(['sur']);
      await expect(create.execute(LICENSE, 'admin')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      build();
      await expect(
        create.execute({ ...LICENSE, locationId: 'sin-zona' }, 'admin'),
      ).rejects.toThrow('La sede no tiene zona horaria configurada');
      expect(repo.rows).toHaveLength(0);
    });

    it('el equipo: de la sede, de rayos X y activo; de otra clínica 404', async () => {
      await expect(
        create.execute({ ...LICENSE, equipmentId: 'rx-sur' }, 'admin'),
      ).rejects.toThrow('El equipo no es de la sede del documento.');
      await expect(
        create.execute({ ...LICENSE, equipmentId: 'autoclave' }, 'admin'),
      ).rejects.toThrow('El equipo no es de rayos X');
      await expect(
        create.execute({ ...LICENSE, equipmentId: 'rx-norte-baja' }, 'admin'),
      ).rejects.toThrow('El equipo está dado de baja');
      await expect(
        create.execute({ ...LICENSE, equipmentId: 'de-otra' }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.rows).toHaveLength(0);
      expect(
        await create.execute({ ...LICENSE, equipmentId: 'rx-norte' }, 'admin'),
      ).toMatchObject({ equipmentId: 'rx-norte', equipmentName: 'Periapical' });
    });

    it('el encargado: miembro activo del personal o texto, no los dos', async () => {
      expect(
        await create.execute({ ...LICENSE, officerUserId: 'dra-ana' }, 'admin'),
      ).toMatchObject({
        officerUserId: 'dra-ana',
        officerMemberName: 'Dra. Ana',
      });
      expect(
        await create.execute(
          { ...LICENSE, officerName: '  Juan   Pérez ' },
          'admin',
        ),
      ).toMatchObject({ officerUserId: null, officerName: 'Juan Pérez' });
      await expect(
        create.execute({ ...LICENSE, officerUserId: 'nadie' }, 'admin'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        create.execute(
          { ...LICENSE, officerUserId: 'dra-ana', officerName: 'Juan' },
          'admin',
        ),
      ).rejects.toThrow('no los dos');
    });
  });

  describe('edición', () => {
    it('cambiar la expedición o la categoría recalcula; un vencimiento explícito manda', async () => {
      const saved = await create.execute(LICENSE, 'admin');
      expect(
        (await update.execute(saved.id, { category: 'II' }, 'admin')).expiresOn,
      ).toBe('2030-02-10');
      expect(
        (await update.execute(saved.id, { expiresOn: '2029-06-30' }, 'admin'))
          .expiresOn,
      ).toBe('2029-06-30');
      // Solo las notas: el vencimiento escrito se conserva.
      expect(
        (
          await update.execute(
            saved.id,
            { notes: 'Copia en recepción' },
            'admin',
          )
        ).expiresOn,
      ).toBe('2029-06-30');
      // null lo recalcula.
      expect(
        (await update.execute(saved.id, { expiresOn: null }, 'admin'))
          .expiresOn,
      ).toBe('2030-02-10');
      expect(
        (
          await update.execute(
            saved.id,
            { issuedOn: '2025-02-10', expiresOn: undefined },
            'admin',
          )
        ).expiresOn,
      ).toBe('2029-02-10');
    });

    it('cambiar de sede quita el equipo salvo que venga uno de la sede nueva', async () => {
      const saved = await create.execute(
        { ...LICENSE, equipmentId: 'rx-norte' },
        'admin',
      );
      expect(
        await update.execute(saved.id, { locationId: 'sur' }, 'admin'),
      ).toMatchObject({ locationId: 'sur', equipmentId: null });
      expect(
        await update.execute(saved.id, { equipmentId: 'rx-sur' }, 'admin'),
      ).toMatchObject({ equipmentId: 'rx-sur' });
      await expect(
        update.execute(saved.id, { equipmentId: 'rx-norte' }, 'admin'),
      ).rejects.toThrow('El equipo no es de la sede del documento.');
    });

    it('elegir un miembro quita el nombre escrito y al revés', async () => {
      const saved = await create.execute(
        { ...LICENSE, officerName: 'Juan Pérez' },
        'admin',
      );
      expect(
        await update.execute(saved.id, { officerUserId: 'dra-ana' }, 'admin'),
      ).toMatchObject({ officerUserId: 'dra-ana', officerName: null });
      expect(
        await update.execute(saved.id, { officerName: 'Otra' }, 'admin'),
      ).toMatchObject({ officerUserId: null, officerName: 'Otra' });
    });

    it('null en un obligatorio da 400; quitar la categoría a una licencia, 400', async () => {
      const saved = await create.execute(LICENSE, 'admin');
      for (const patch of [
        { issuer: null },
        { issuedOn: null },
        { locationId: null },
      ]) {
        await expect(
          update.execute(saved.id, patch as never, 'admin'),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      await expect(
        update.execute(saved.id, { category: null }, 'admin'),
      ).rejects.toThrow('Indica la categoría de la licencia (I o II).');
    });

    it('un usuario sin la sede del documento recibe 403 al leer, editar y anular', async () => {
      const saved = await create.execute(LICENSE, 'admin');
      const ctx = context(['sur']);
      const clock = () => NOW;
      await expect(
        new GetRadiologyRecordUseCase(repo, ctx, clock).execute(saved.id),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        new UpdateRadiologyRecordUseCase(
          repo,
          locations,
          equipment,
          staff,
          ctx,
          clock,
        ).execute(saved.id, { notes: 'x' }, 'admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        new VoidRadiologyRecordUseCase(repo, ctx, clock).execute(
          saved.id,
          'No es su sede',
          'admin',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.rows[0]).toMatchObject({ notes: null, voidedAt: null });
    });
  });

  describe('anulación', () => {
    it('con motivo, una vez; después no se edita (409)', async () => {
      const saved = await create.execute(LICENSE, 'admin');
      await expect(voidRecord.execute(saved.id, 'x', 'admin')).rejects.toThrow(
        'Escribe el motivo de la anulación',
      );
      const voided = await voidRecord.execute(
        saved.id,
        'Número mal escrito',
        'admin',
      );
      expect(voided).toMatchObject({
        voidReason: 'Número mal escrito',
        status: null,
      });
      await expect(
        voidRecord.execute(saved.id, 'Otra vez', 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        update.execute(saved.id, { notes: 'x' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('lista', () => {
    it('vivos por defecto, por sede, con «Renovado» si otro vivo del grupo vence después', async () => {
      const old = repo.seed({
        expiresOn: '2026-10-01',
        issuedOn: '2021-10-01',
      });
      const renewed = repo.seed({
        expiresOn: '2031-10-01',
        issuedOn: '2026-10-01',
      });
      repo.seed({ locationId: 'sur' });
      repo.seed({ voidedAt: NOW, voidReason: 'Error' });
      const norte = await list.execute({ locationId: 'norte' });
      expect(norte.items.map((i) => [i.id, i.status])).toEqual([
        [old.id, 'RENEWED'],
        [renewed.id, 'UP_TO_DATE'],
      ]);
      expect((await list.execute({ status: 'ALL' })).total).toBe(4);
      expect((await list.execute({ status: 'VOIDED' })).items[0].status).toBe(
        null,
      );
    });

    it('un usuario limitado a una sede solo ve esa (y 403 si pide otra)', async () => {
      repo.seed({ locationId: 'norte' });
      const sur = repo.seed({ locationId: 'sur' });
      const ctx = context(['sur']);
      const scoped = new ListRadiologyRecordsUseCase(
        repo,
        locations,
        ctx,
        () => NOW,
      );
      expect((await scoped.execute({})).items.map((i) => i.id)).toEqual([
        sur.id,
      ]);
      await expect(
        scoped.execute({ locationId: 'norte' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const none = new ListRadiologyRecordsUseCase(
        repo,
        locations,
        context([]),
        () => NOW,
      );
      expect(await none.execute({})).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('avisos de «Mi día»', () => {
    it('vencidos y ≤90 días, el más urgente primero, sin renovados ni anulados', async () => {
      const overdue = repo.seed({
        kind: 'QUALITY_CONTROL',
        category: null,
        expiresOn: '2026-09-30',
      });
      const soon = repo.seed({ expiresOn: '2026-12-01' });
      // Al día (otro grupo: la licencia del equipo).
      repo.seed({ equipmentId: 'rx-norte', expiresOn: '2027-03-01' });
      repo.seed({ expiresOn: '2026-11-01', voidedAt: NOW, voidReason: 'x' });
      // Una licencia vencida de la Sur ya renovada.
      repo.seed({ locationId: 'sur', expiresOn: '2026-08-01' });
      repo.seed({ locationId: 'sur', expiresOn: '2031-08-01' });
      const out = await due.execute({});
      expect(out.items.map((i) => [i.id, i.status, i.daysUntilExpiry])).toEqual(
        [
          [overdue.id, 'OVERDUE', -37],
          [soon.id, 'DUE_SOON', 25],
        ],
      );
      expect(out.total).toBe(2);
      expect((await due.execute({ limit: 1 })).items).toHaveLength(1);
    });

    it('sigue al alcance de sedes y con `loc = []` no lee nada', async () => {
      repo.seed({ locationId: 'norte', expiresOn: '2026-10-01' });
      const sur = repo.seed({ locationId: 'sur', expiresOn: '2026-10-01' });
      const scoped = new ListRadiologyDueUseCase(
        repo,
        context(['sur']),
        () => NOW,
      );
      expect((await scoped.execute({})).items.map((i) => i.id)).toEqual([
        sur.id,
      ]);
      const spy = jest.spyOn(repo, 'listDueCandidates');
      const none = new ListRadiologyDueUseCase(repo, context([]), () => NOW);
      expect((await none.execute({})).total).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    });

    it('cuenta en el día de la sede: a las 23:30 de Lima todavía vence «hoy»', async () => {
      // 04:30 UTC del 7/11 = 23:30 del 6/11 en Lima.
      build(null, new Date('2026-11-07T04:30:00.000Z'));
      const today = repo.seed({ expiresOn: '2026-11-06' });
      const out = await due.execute({});
      expect(out.items).toEqual([
        expect.objectContaining({
          id: today.id,
          status: 'DUE_SOON',
          daysUntilExpiry: 0,
        }),
      ]);
      expect((await get.execute(today.id)).status).toBe('DUE_SOON');
    });
  });
});
