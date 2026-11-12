import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  RECALL_REPOSITORY,
  type RecallRepository,
} from '../../domain/ports/recall-repository.port';
import type {
  RecallTypeFields,
  RecallTypeView,
} from '../../domain/recall.entity';
import {
  exclusionGroupError,
  normalizeTriggerIds,
  recallTypeIntervalError,
  recallTypeNameError,
  recallTypeSortOrderError,
  triggerIdsError,
} from '../../domain/recall-type-rules';
import { RECALL_TYPE_NOT_FOUND_MESSAGE } from './recall.use-cases';

export const SYSTEM_RECALL_TYPE_RETIRE_MESSAGE =
  'Este tipo de recall es del sistema (Higiene o Control): no se puede retirar, solo desactivar.';

/** Lo que llega del cuerpo (crear los trae todos menos los opcionales). */
export interface RecallTypeInput {
  name?: string;
  defaultIntervalMonths?: number;
  active?: boolean;
  sortOrder?: number;
  /** `null` quita la exclusión; `undefined` no la cambia. */
  exclusionGroup?: string | null;
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

/** Valida y normaliza solo los campos presentes (400 en español). */
function normalize(input: RecallTypeInput): Partial<RecallTypeFields> {
  const out: Partial<RecallTypeFields> = {};
  if (input.name !== undefined) {
    assertValid(recallTypeNameError(input.name));
    out.name = input.name.trim();
  }
  if (input.defaultIntervalMonths !== undefined) {
    assertValid(recallTypeIntervalError(input.defaultIntervalMonths));
    out.defaultIntervalMonths = input.defaultIntervalMonths;
  }
  if (input.active !== undefined) out.active = input.active;
  if (input.sortOrder !== undefined) {
    assertValid(recallTypeSortOrderError(input.sortOrder));
    out.sortOrder = input.sortOrder;
  }
  if (input.exclusionGroup !== undefined) {
    assertValid(exclusionGroupError(input.exclusionGroup));
    out.exclusionGroup = input.exclusionGroup;
  }
  return out;
}

/** D11: alta de un tipo (ADMIN). Activo por defecto; sin orden, el último. */
@Injectable()
export class CreateRecallTypeUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(
    input: RecallTypeInput & { name: string; defaultIntervalMonths: number },
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    const valid = normalize(input);
    return this.repo.createType(
      {
        name: valid.name ?? input.name,
        defaultIntervalMonths:
          valid.defaultIntervalMonths ?? input.defaultIntervalMonths,
        active: valid.active ?? true,
        sortOrder: valid.sortOrder,
        exclusionGroup: valid.exclusionGroup ?? null,
      },
      audit,
    );
  }
}

/**
 * D11: editar cualquier campo. El intervalo por defecto nuevo solo afecta a
 * los recalls que se creen después; desactivar el tipo solo deja de crearlos
 * por procedimiento (los que hay siguen en la lista).
 */
@Injectable()
export class UpdateRecallTypeUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(
    id: string,
    input: RecallTypeInput,
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    const fields = normalize(input);
    if (!(await this.repo.findTypeView(id))) {
      throw new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE);
    }
    return this.repo.updateType(id, fields, audit);
  }
}

/**
 * D11: retirar (borrado lógico). Un tipo con `systemKey` no se retira (409):
 * el enum de compatibilidad (`PUT …/recalls/HYGIENE`) apunta a él; se
 * desactiva.
 */
@Injectable()
export class RetireRecallTypeUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(id: string, audit: AuditRequestContext): Promise<void> {
    const current = await this.repo.findTypeView(id);
    if (!current) throw new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE);
    // `systemKey` no se cambia por la API: comprobarlo fuera de la
    // transacción no abre carrera.
    if (current.systemKey !== null) {
      throw new ConflictException(SYSTEM_RECALL_TYPE_RETIRE_MESSAGE);
    }
    await this.repo.retireType(id, audit);
  }
}

/** D12: reemplazar los procedimientos que disparan el tipo. */
@Injectable()
export class SetRecallTypeTriggersUseCase {
  constructor(
    @Inject(RECALL_REPOSITORY) private readonly repo: RecallRepository,
  ) {}

  async execute(
    id: string,
    catalogItemIds: readonly string[],
    audit: AuditRequestContext,
  ): Promise<RecallTypeView> {
    assertValid(triggerIdsError(catalogItemIds));
    if (!(await this.repo.findTypeView(id))) {
      throw new NotFoundException(RECALL_TYPE_NOT_FOUND_MESSAGE);
    }
    return this.repo.setTriggers(
      id,
      normalizeTriggerIds(catalogItemIds),
      audit,
    );
  }
}
