import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { InMemoryChairRepository } from '../__fixtures__/in-memory-chairs';
import {
  CreateChairUseCase,
  ListChairsUseCase,
  ReorderChairsUseCase,
  SetChairActiveUseCase,
  UpdateChairUseCase,
} from './chairs.use-cases';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffMember } from '../../../staff/domain/entities/staff-member.entity';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

function makeLocations(known = ['norte', 'sur']): LocationRepository {
  return {
    findById: (id: string) =>
      Promise.resolve(
        known.includes(id) ? { id, timeZone: 'America/Bogota' } : null,
      ),
  } as unknown as LocationRepository;
}

const MEMBERS: Record<string, Partial<StaffMember>> = {
  dra: { role: ClinicRole.DENTIST, locationIds: null },
  // Restringida a la sede Sur (DX-089).
  drSur: { role: ClinicRole.DENTIST, locationIds: ['sur'] },
  rec: { role: ClinicRole.RECEPTION, locationIds: null },
};

function makeStaff(): StaffRepository {
  return {
    findById: (userId: string) =>
      Promise.resolve(MEMBERS[userId] ? { userId, ...MEMBERS[userId] } : null),
  } as unknown as StaffRepository;
}

/** Contexto con sedes permitidas (DX-089): `null` = todas. */
function context(allowed: string[] | null = null): TenantContextService {
  const ctx = new TenantContextService();
  jest
    .spyOn(ctx, 'assertLocationAllowed')
    .mockImplementation((locationId: string) => {
      if (allowed && !allowed.includes(locationId)) {
        throw new ForbiddenException('Sede no permitida');
      }
    });
  return ctx;
}

describe('sillones (DX-211)', () => {
  let repo: InMemoryChairRepository;
  let ctx: TenantContextService;
  let create: CreateChairUseCase;
  let update: UpdateChairUseCase;
  let setActive: SetChairActiveUseCase;
  let reorder: ReorderChairsUseCase;
  let list: ListChairsUseCase;

  function build(allowed: string[] | null = null): void {
    repo = new InMemoryChairRepository();
    ctx = context(allowed);
    const locations = makeLocations();
    const staff = makeStaff();
    create = new CreateChairUseCase(repo, locations, staff, ctx);
    update = new UpdateChairUseCase(repo, staff, ctx);
    setActive = new SetChairActiveUseCase(repo, ctx);
    reorder = new ReorderChairsUseCase(repo, locations, ctx);
    list = new ListChairsUseCase(repo, locations, ctx);
  }

  beforeEach(() => build());

  describe('crear', () => {
    it('crea el sillón en la sede, recortado, al final del orden', async () => {
      await create.execute({ locationId: 'norte', name: 'Sillón 1' }, 'admin');
      const second = await create.execute(
        { locationId: 'norte', name: '  Sillón 2 ' },
        'admin',
      );
      expect(second).toMatchObject({
        locationId: 'norte',
        name: 'Sillón 2',
        sortOrder: 1,
        active: true,
        defaultProviderId: null,
      });
    });

    it('los sillones de la sede Norte no salen en la Sur', async () => {
      await create.execute({ locationId: 'norte', name: 'Sillón 1' }, 'admin');
      await expect(
        list.execute({ locationId: 'sur', includeInactive: true }),
      ).resolves.toEqual([]);
    });

    it('un nombre repetido en la misma sede (sin distinguir mayúsculas) es 409', async () => {
      await create.execute({ locationId: 'norte', name: 'Sillón 1' }, 'admin');
      await expect(
        create.execute({ locationId: 'norte', name: 'sillón 1' }, 'admin'),
      ).rejects.toThrow(
        new ConflictException(
          'Ya existe un sillón con ese nombre en esta sede.',
        ),
      );
      // En otra sede, el mismo nombre vale.
      await expect(
        create.execute({ locationId: 'sur', name: 'Sillón 1' }, 'admin'),
      ).resolves.toMatchObject({ locationId: 'sur' });
    });

    it('el nombre de un sillón desactivado tampoco se repite (se reactiva)', async () => {
      const chair = await create.execute(
        { locationId: 'norte', name: 'Sillón 1' },
        'admin',
      );
      await setActive.execute(chair.id, false, 'admin');
      await expect(
        create.execute({ locationId: 'norte', name: 'Sillón 1' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('nombre vacío o de más de 40: 400', async () => {
      await expect(
        create.execute({ locationId: 'norte', name: ' ' }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        create.execute({ locationId: 'norte', name: 'x'.repeat(41) }, 'admin'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sede inexistente o de otra clínica: 404; no permitida al usuario: 403', async () => {
      await expect(
        create.execute({ locationId: 'ajena', name: 'Sillón 1' }, 'admin'),
      ).rejects.toThrow(new NotFoundException('Sede no encontrada'));
      build(['sur']);
      await expect(
        create.execute({ locationId: 'norte', name: 'Sillón 1' }, 'admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('el profesional por defecto es un miembro que atiende en la sede', async () => {
      await expect(
        create.execute(
          { locationId: 'norte', name: 'Sillón 1', defaultProviderId: 'dra' },
          'admin',
        ),
      ).resolves.toMatchObject({ defaultProviderId: 'dra' });
      await expect(
        create.execute(
          { locationId: 'norte', name: 'Sillón 2', defaultProviderId: 'nadie' },
          'admin',
        ),
      ).rejects.toThrow(new NotFoundException('Profesional no encontrado'));
      await expect(
        create.execute(
          { locationId: 'norte', name: 'Sillón 3', defaultProviderId: 'rec' },
          'admin',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        create.execute(
          { locationId: 'norte', name: 'Sillón 4', defaultProviderId: 'drSur' },
          'admin',
        ),
      ).rejects.toThrow(
        new BadRequestException('Algún profesional no atiende en esta sede.'),
      );
    });
  });

  describe('editar', () => {
    it('renombra, cambia el orden y quita el profesional por defecto', async () => {
      const chair = await create.execute(
        { locationId: 'norte', name: 'Sillón 1', defaultProviderId: 'dra' },
        'admin',
      );
      await expect(
        update.execute(
          chair.id,
          { name: 'Gabinete A', sortOrder: 5, defaultProviderId: null },
          'admin',
        ),
      ).resolves.toMatchObject({
        name: 'Gabinete A',
        sortOrder: 5,
        defaultProviderId: null,
      });
    });

    it('renombrar al nombre de otro sillón de la sede es 409; a su propio nombre, no', async () => {
      const one = await create.execute(
        { locationId: 'norte', name: 'Sillón 1' },
        'admin',
      );
      await create.execute({ locationId: 'norte', name: 'Sillón 2' }, 'admin');
      await expect(
        update.execute(one.id, { name: 'SILLÓN 2' }, 'admin'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        update.execute(one.id, { name: 'sillón 1' }, 'admin'),
      ).resolves.toMatchObject({ name: 'sillón 1' });
    });

    it('un sillón de otra clínica es 404 y uno de una sede no permitida, 403', async () => {
      await expect(
        update.execute('no-existe', { name: 'X' }, 'admin'),
      ).rejects.toThrow(new NotFoundException('Sillón no encontrado'));
      const chair = repo.seed({ locationId: 'norte' });
      build(['sur']);
      repo.rows.push({ ...chair });
      await expect(
        update.execute(chair.id, { name: 'X' }, 'admin'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('desactivar y reactivar', () => {
    it('desactivar no borra: sale de la lista de activos y sigue con includeInactive', async () => {
      const chair = await create.execute(
        { locationId: 'norte', name: 'Sillón 1' },
        'admin',
      );
      await expect(
        setActive.execute(chair.id, false, 'admin'),
      ).resolves.toMatchObject({ active: false });
      await expect(
        list.execute({ locationId: 'norte', includeInactive: false }),
      ).resolves.toEqual([]);
      await expect(
        list.execute({ locationId: 'norte', includeInactive: true }),
      ).resolves.toEqual([expect.objectContaining({ id: chair.id })]);
      await expect(
        setActive.execute(chair.id, true, 'admin'),
      ).resolves.toMatchObject({ active: true });
    });
  });

  describe('ordenar', () => {
    it('fija el orden con todos los sillones de la sede', async () => {
      const a = await create.execute(
        { locationId: 'norte', name: 'A' },
        'admin',
      );
      const b = await create.execute(
        { locationId: 'norte', name: 'B' },
        'admin',
      );
      const sorted = await reorder.execute(
        { locationId: 'norte', chairIds: [b.id, a.id] },
        'admin',
      );
      expect(sorted.map((c) => c.id)).toEqual([b.id, a.id]);
    });

    it('faltan, sobran, se repiten o son de otra sede: 400', async () => {
      const a = await create.execute(
        { locationId: 'norte', name: 'A' },
        'admin',
      );
      const b = await create.execute(
        { locationId: 'norte', name: 'B' },
        'admin',
      );
      const sur = await create.execute(
        { locationId: 'sur', name: 'S' },
        'admin',
      );
      for (const chairIds of [[a.id], [a.id, a.id], [a.id, b.id, sur.id]]) {
        await expect(
          reorder.execute({ locationId: 'norte', chairIds }, 'admin'),
        ).rejects.toThrow(
          new BadRequestException(
            'Envía todos los sillones de la sede, cada uno una vez',
          ),
        );
      }
    });
  });
});
