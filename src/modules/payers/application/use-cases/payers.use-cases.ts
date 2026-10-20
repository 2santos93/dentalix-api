import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicCountry, PayerType } from '@prisma/client';
import { Payer } from '../../domain/entities/payer.entity';
import {
  PAYER_REPOSITORY,
  type PayerRepository,
} from '../../domain/ports/payer-repository.port';
import {
  normalizePayerName,
  payerNameKey,
  validatePayerName,
  validatePayerTypeCountry,
} from '../../domain/payer-rules';

export const PAYER_NOT_FOUND_MESSAGE = 'Pagador no encontrado.';
export const PAYER_DUPLICATE_MESSAGE = 'Ya existe un pagador con ese nombre.';
export const PAYER_DUPLICATE_INACTIVE_MESSAGE =
  'Ya existe un pagador con ese nombre, pero está desactivado; pídele a administración que lo reactive.';
export const PAYER_IN_USE_MESSAGE =
  'Este pagador tiene coberturas asociadas; desactívalo en lugar de retirarlo.';

export interface CreatePayerInput {
  name: string;
  type: PayerType;
  country?: ClinicCountry | null;
  active?: boolean;
}

export interface UpdatePayerInput {
  name?: string;
  type?: PayerType;
  country?: ClinicCountry | null;
  active?: boolean;
}

function duplicateConflict(existing: Payer): ConflictException {
  return new ConflictException(
    existing.active
      ? PAYER_DUPLICATE_MESSAGE
      : PAYER_DUPLICATE_INACTIVE_MESSAGE,
  );
}

function assertValid(error: string | null): void {
  if (error !== null) throw new BadRequestException(error);
}

@Injectable()
export class ListPayersUseCase {
  constructor(
    @Inject(PAYER_REPOSITORY) private readonly repo: PayerRepository,
  ) {}

  /** Por defecto solo los activos (los selectores). */
  execute(params: { includeInactive?: boolean }): Promise<Payer[]> {
    return this.repo.list({ includeInactive: params.includeInactive ?? false });
  }
}

@Injectable()
export class CreatePayerUseCase {
  constructor(
    @Inject(PAYER_REPOSITORY) private readonly repo: PayerRepository,
  ) {}

  async execute(input: CreatePayerInput, createdById?: string): Promise<Payer> {
    assertValid(validatePayerName(input.name));
    const country = input.country ?? null;
    assertValid(validatePayerTypeCountry(input.type, country));
    const name = normalizePayerName(input.name);
    const existing = await this.repo.findByNormalizedName(payerNameKey(name));
    if (existing) throw duplicateConflict(existing);
    return this.repo.create({
      name,
      type: input.type,
      country,
      active: input.active ?? true,
      createdById,
    });
  }
}

@Injectable()
export class UpdatePayerUseCase {
  constructor(
    @Inject(PAYER_REPOSITORY) private readonly repo: PayerRepository,
  ) {}

  async execute(
    id: string,
    input: UpdatePayerInput,
    updatedById?: string,
  ): Promise<Payer> {
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundException(PAYER_NOT_FOUND_MESSAGE);

    const patch: UpdatePayerInput = { active: input.active };
    if (input.name !== undefined) {
      assertValid(validatePayerName(input.name));
      patch.name = normalizePayerName(input.name);
      const existing = await this.repo.findByNormalizedName(
        payerNameKey(patch.name),
        id,
      );
      if (existing) throw duplicateConflict(existing);
    }
    // Tipo y país se validan juntos, con el valor que quedaría tras el cambio.
    if (input.type !== undefined || input.country !== undefined) {
      const type = input.type ?? current.type;
      const country =
        input.country !== undefined ? input.country : current.country;
      assertValid(validatePayerTypeCountry(type, country));
      if (input.type !== undefined) patch.type = input.type;
      if (input.country !== undefined) patch.country = input.country;
    }
    const updated = await this.repo.update(id, { ...patch, updatedById });
    if (!updated) throw new NotFoundException(PAYER_NOT_FOUND_MESSAGE);
    return updated;
  }
}

@Injectable()
export class DeletePayerUseCase {
  constructor(
    @Inject(PAYER_REPOSITORY) private readonly repo: PayerRepository,
  ) {}

  /** Con coberturas vivas no se retira: se desactiva (las coberturas siguen). */
  async execute(id: string, deletedById?: string): Promise<void> {
    const result = await this.repo.retire(id, deletedById);
    if (result === 'NOT_FOUND') {
      throw new NotFoundException(PAYER_NOT_FOUND_MESSAGE);
    }
    if (result === 'IN_USE') throw new ConflictException(PAYER_IN_USE_MESSAGE);
  }
}
