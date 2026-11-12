import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { RecallRepository } from '../../domain/ports/recall-repository.port';
import type {
  NewRecallType,
  RecallTypeFields,
  RecallTypeView,
} from '../../domain/recall.entity';
import {
  RECALL_EXCLUSION_GROUP_MESSAGE,
  RECALL_TYPE_INTERVAL_MESSAGE,
  RECALL_TYPE_NAME_EMPTY_MESSAGE,
  RECALL_TYPE_TRIGGERS_MAX_MESSAGE,
} from '../../domain/recall-type-rules';
import { RECALL_TYPE_NOT_FOUND_MESSAGE } from './recall.use-cases';
import {
  CreateRecallTypeUseCase,
  RetireRecallTypeUseCase,
  SYSTEM_RECALL_TYPE_RETIRE_MESSAGE,
  SetRecallTypeTriggersUseCase,
  UpdateRecallTypeUseCase,
} from './recall-types.use-cases';

// DX-015-bis (D11–D13): el CRUD de tipos de recall con un doble del
// repositorio. Lo que valida la BD (nombre único, procedimientos vivos) se
// prueba en recall-types.e2e-spec.ts.
const AUDIT: AuditRequestContext = {
  tenantId: 'clinica',
  locationId: null,
  actor: { userId: 'admin', role: ClinicRole.ADMIN },
  requestId: null,
  ip: null,
  userAgent: null,
};

const view = (
  over: Partial<RecallTypeView> & { id: string },
): RecallTypeView => ({
  name: 'Tipo',
  defaultIntervalMonths: 6,
  active: true,
  sortOrder: 10,
  systemKey: null,
  exclusionGroup: null,
  triggerCatalogItemIds: [],
  triggers: [],
  ...over,
});

class TypesRepo {
  types = new Map<string, RecallTypeView>([
    [
      't-higiene',
      view({ id: 't-higiene', name: 'Higiene', systemKey: 'HYGIENE' }),
    ],
    ['t-perio', view({ id: 't-perio', name: 'Mantenimiento periodontal' })],
  ]);
  created: NewRecallType[] = [];
  updated: [string, Partial<RecallTypeFields>][] = [];
  retired: string[] = [];
  triggers: [string, readonly string[]][] = [];

  findTypeView(id: string) {
    return Promise.resolve(this.types.get(id) ?? null);
  }
  createType(data: NewRecallType) {
    this.created.push(data);
    return Promise.resolve(
      view({ id: 't-nuevo', ...data, sortOrder: data.sortOrder ?? 40 }),
    );
  }
  updateType(id: string, data: Partial<RecallTypeFields>) {
    this.updated.push([id, data]);
    return Promise.resolve({ ...this.types.get(id)!, ...data });
  }
  retireType(id: string) {
    this.retired.push(id);
    return Promise.resolve();
  }
  setTriggers(id: string, ids: readonly string[]) {
    this.triggers.push([id, ids]);
    return Promise.resolve({
      ...this.types.get(id)!,
      triggerCatalogItemIds: [...ids],
    });
  }
}

const asRepo = (r: TypesRepo) => r as unknown as RecallRepository;

describe('CRUD de tipos de recall (DX-015-bis)', () => {
  let repo: TypesRepo;
  beforeEach(() => {
    repo = new TypesRepo();
  });

  describe('crear', () => {
    it('recorta el nombre, activo por defecto, sin orden ni grupo', async () => {
      await new CreateRecallTypeUseCase(asRepo(repo)).execute(
        { name: '  Ortodoncia  ', defaultIntervalMonths: 1 },
        AUDIT,
      );
      expect(repo.created).toEqual([
        {
          name: 'Ortodoncia',
          defaultIntervalMonths: 1,
          active: true,
          sortOrder: undefined,
          exclusionGroup: null,
        },
      ]);
    });

    it('con grupo, orden e inactivo', async () => {
      await new CreateRecallTypeUseCase(asRepo(repo)).execute(
        {
          name: 'Blanqueamiento',
          defaultIntervalMonths: 12,
          active: false,
          sortOrder: 5,
          exclusionGroup: 'ESTETICA',
        },
        AUDIT,
      );
      expect(repo.created[0]).toMatchObject({
        active: false,
        sortOrder: 5,
        exclusionGroup: 'ESTETICA',
      });
    });

    it.each([
      [
        { name: '   ', defaultIntervalMonths: 6 },
        RECALL_TYPE_NAME_EMPTY_MESSAGE,
      ],
      [{ name: 'X', defaultIntervalMonths: 37 }, RECALL_TYPE_INTERVAL_MESSAGE],
      [{ name: 'X', defaultIntervalMonths: 0 }, RECALL_TYPE_INTERVAL_MESSAGE],
      [
        { name: 'X', defaultIntervalMonths: 6, exclusionGroup: 'grupo' },
        RECALL_EXCLUSION_GROUP_MESSAGE,
      ],
    ])('%j: 400 sin escribir', async (input, message) => {
      await expect(
        new CreateRecallTypeUseCase(asRepo(repo)).execute(input, AUDIT),
      ).rejects.toThrow(new BadRequestException(message));
      expect(repo.created).toEqual([]);
    });
  });

  describe('editar', () => {
    it('solo los campos presentes; null quita el grupo', async () => {
      await new UpdateRecallTypeUseCase(asRepo(repo)).execute(
        't-perio',
        { defaultIntervalMonths: 4, exclusionGroup: null },
        AUDIT,
      );
      expect(repo.updated).toEqual([
        ['t-perio', { defaultIntervalMonths: 4, exclusionGroup: null }],
      ]);
    });

    it('un tipo del sistema se edita (y se desactiva)', async () => {
      await new UpdateRecallTypeUseCase(asRepo(repo)).execute(
        't-higiene',
        { name: 'Limpieza', active: false },
        AUDIT,
      );
      expect(repo.updated).toEqual([
        ['t-higiene', { name: 'Limpieza', active: false }],
      ]);
    });

    it('404 si no existe (o es de otra clínica); 400 antes de buscarlo', async () => {
      const update = new UpdateRecallTypeUseCase(asRepo(repo));
      await expect(
        update.execute('t-otro', { name: 'X' }, AUDIT),
      ).rejects.toThrow(new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE));
      await expect(
        update.execute('t-otro', { defaultIntervalMonths: 40 }, AUDIT),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.updated).toEqual([]);
    });
  });

  describe('retirar', () => {
    it('un tipo de la clínica se retira', async () => {
      await new RetireRecallTypeUseCase(asRepo(repo)).execute('t-perio', AUDIT);
      expect(repo.retired).toEqual(['t-perio']);
    });

    it('uno con systemKey no se retira (409), solo se desactiva', async () => {
      await expect(
        new RetireRecallTypeUseCase(asRepo(repo)).execute('t-higiene', AUDIT),
      ).rejects.toThrow(
        new ConflictException(SYSTEM_RECALL_TYPE_RETIRE_MESSAGE),
      );
      expect(repo.retired).toEqual([]);
    });

    it('404 si no existe', async () => {
      await expect(
        new RetireRecallTypeUseCase(asRepo(repo)).execute('t-otro', AUDIT),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('disparadores', () => {
    const id = (n: number) =>
      `0b7d1c2e-0000-4000-8000-${String(n).padStart(12, '0')}`;

    it('el conjunto sin repetidos, en orden estable', async () => {
      await new SetRecallTypeTriggersUseCase(asRepo(repo)).execute(
        't-perio',
        [id(2), id(1), id(2)],
        AUDIT,
      );
      expect(repo.triggers).toEqual([['t-perio', [id(1), id(2)]]]);
    });

    it('[] los quita todos', async () => {
      await new SetRecallTypeTriggersUseCase(asRepo(repo)).execute(
        't-perio',
        [],
        AUDIT,
      );
      expect(repo.triggers).toEqual([['t-perio', []]]);
    });

    it('más de 50: 400; tipo inexistente: 404', async () => {
      const set = new SetRecallTypeTriggersUseCase(asRepo(repo));
      await expect(
        set.execute(
          't-perio',
          Array.from({ length: 51 }, (_, i) => id(i)),
          AUDIT,
        ),
      ).rejects.toThrow(
        new BadRequestException(RECALL_TYPE_TRIGGERS_MAX_MESSAGE),
      );
      await expect(
        set.execute('t-otro', [id(1)], AUDIT),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.triggers).toEqual([]);
    });
  });
});
