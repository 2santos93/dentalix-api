import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PrescriptionTemplate,
  PrescriptionTemplateItem,
} from '../../domain/entities/prescription-template.entity';
import {
  PRESCRIPTION_TEMPLATE_REPOSITORY,
  type PrescriptionTemplateRepository,
} from '../../domain/ports/prescription-template-repository.port';
import { MAX_PRESCRIPTION_ITEMS } from '../../domain/prescription-rules';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export const PRESCRIPTION_TEMPLATE_NOT_FOUND_MESSAGE =
  'Plantilla de receta no encontrada';

export interface PrescriptionTemplateInput {
  name: string;
  notes?: string | null;
  items: Partial<PrescriptionTemplateItem>[];
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

const RANGES: readonly [
  'durationDays' | 'totalQuantity' | 'packages',
  number,
  string,
][] = [
  [
    'durationDays',
    365,
    'la duración debe ser un número entero de días entre 1 y 365',
  ],
  [
    'totalQuantity',
    9999,
    'la cantidad total debe ser un número entero entre 1 y 9999',
  ],
  ['packages', 99, 'el número de envases debe ser un entero entre 1 y 99'],
];

function normalizeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new BadRequestException('El nombre de la plantilla es obligatorio');
  }
  return trimmed;
}

/**
 * Una plantilla puede quedar a medias (solo el principio activo es
 * obligatorio): el resto se completa en el modal, donde sí se aplican las
 * reglas del país al emitir.
 */
function normalizeItems(
  items: Partial<PrescriptionTemplateItem>[],
): PrescriptionTemplateItem[] {
  if (items.length === 0) {
    throw new BadRequestException(
      'La plantilla necesita al menos un medicamento',
    );
  }
  if (items.length > MAX_PRESCRIPTION_ITEMS) {
    throw new BadRequestException(
      `Una plantilla admite como mucho ${MAX_PRESCRIPTION_ITEMS} medicamentos`,
    );
  }
  const errors: string[] = [];
  const out = items.map((item, i) => {
    const n = i + 1;
    const activeIngredient = trimmedOrNull(item.activeIngredient);
    if (!activeIngredient) {
      errors.push(`Medicamento ${n}: falta el principio activo (DCI)`);
    }
    for (const [field, max, message] of RANGES) {
      const value = item[field];
      if (
        value != null &&
        (!Number.isInteger(value) || value < 1 || value > max)
      ) {
        errors.push(`Medicamento ${n}: ${message}`);
      }
    }
    return {
      activeIngredient: activeIngredient ?? '',
      brandName: trimmedOrNull(item.brandName),
      concentration: trimmedOrNull(item.concentration),
      pharmaceuticalForm: trimmedOrNull(item.pharmaceuticalForm),
      route: trimmedOrNull(item.route),
      dose: trimmedOrNull(item.dose),
      frequency: trimmedOrNull(item.frequency),
      durationDays: item.durationDays ?? null,
      totalQuantity: item.totalQuantity ?? null,
      quantityUnit: trimmedOrNull(item.quantityUnit),
      packages: item.packages ?? null,
      instructions: trimmedOrNull(item.instructions),
    };
  });
  if (errors.length > 0) {
    throw new BadRequestException(errors.join('; '));
  }
  return out;
}

@Injectable()
export class ListPrescriptionTemplatesUseCase {
  constructor(
    @Inject(PRESCRIPTION_TEMPLATE_REPOSITORY)
    private readonly repo: PrescriptionTemplateRepository,
  ) {}

  execute(): Promise<PrescriptionTemplate[]> {
    return this.repo.list();
  }
}

@Injectable()
export class CreatePrescriptionTemplateUseCase {
  constructor(
    @Inject(PRESCRIPTION_TEMPLATE_REPOSITORY)
    private readonly repo: PrescriptionTemplateRepository,
  ) {}

  async execute(
    input: PrescriptionTemplateInput,
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate> {
    return this.repo.create(
      {
        name: normalizeName(input.name),
        notes: trimmedOrNull(input.notes),
        items: normalizeItems(input.items),
      },
      audit,
    );
  }
}

@Injectable()
export class UpdatePrescriptionTemplateUseCase {
  constructor(
    @Inject(PRESCRIPTION_TEMPLATE_REPOSITORY)
    private readonly repo: PrescriptionTemplateRepository,
  ) {}

  /** Editar la plantilla no toca ninguna receta emitida (copian los datos). */
  async execute(
    id: string,
    input: Partial<PrescriptionTemplateInput>,
    audit: AuditRequestContext,
  ): Promise<PrescriptionTemplate> {
    if (!(await this.repo.findById(id))) {
      throw new NotFoundException(PRESCRIPTION_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    return this.repo.update(
      id,
      {
        ...(input.name !== undefined
          ? { name: normalizeName(input.name) }
          : {}),
        ...(input.notes !== undefined
          ? { notes: trimmedOrNull(input.notes) }
          : {}),
        ...(input.items !== undefined
          ? { items: normalizeItems(input.items) }
          : {}),
      },
      audit,
    );
  }
}

@Injectable()
export class DeletePrescriptionTemplateUseCase {
  constructor(
    @Inject(PRESCRIPTION_TEMPLATE_REPOSITORY)
    private readonly repo: PrescriptionTemplateRepository,
  ) {}

  /** Borrado BLANDO: en Dentalix nada se borra en duro. */
  async execute(id: string, audit: AuditRequestContext): Promise<void> {
    if (!(await this.repo.findById(id))) {
      throw new NotFoundException(PRESCRIPTION_TEMPLATE_NOT_FOUND_MESSAGE);
    }
    await this.repo.softDelete(id, audit);
  }
}
