import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ANESTHESIA_REPOSITORY,
  type AnesthesiaRepository,
  type AnestheticProductInput,
  type AnestheticProductPatch,
} from '../../domain/ports/anesthesia-repository.port';
import type { AnestheticProduct } from '../../domain/entities';
import { SAMPLE_ANESTHETICS } from '../../domain/sample-anesthetics';
import { epinephrineFromLabel } from '../../domain/anesthesia-limits';
import { ANESTHETIC_NOT_FOUND_MESSAGE } from './anesthesia.use-cases';

export const ANESTHETIC_DUPLICATE_NAME_MESSAGE =
  'Ya hay un anestésico con ese nombre en el catálogo de la clínica';

function clean(input: AnestheticProductPatch): AnestheticProductPatch {
  const out: AnestheticProductPatch = { ...input };
  if (input.name !== undefined) out.name = input.name.trim();
  if (input.activeIngredient !== undefined) {
    out.activeIngredient = input.activeIngredient.trim();
  }
  if (input.vasoconstrictor !== undefined) {
    out.vasoconstrictor = input.vasoconstrictor?.trim() || null;
  }
  if (out.name === '' || out.activeIngredient === '') {
    throw new BadRequestException(
      'El nombre y el principio activo no pueden estar vacíos',
    );
  }
  return out;
}

/**
 * Catálogo de anestésicos de la clínica (DX-307). Leerlo: quien registra la
 * evolución. Crear, editar, desactivar y cargar los sugeridos: solo ADMIN.
 * Cambiar un valor no toca lo ya registrado: cada registro copió los suyos.
 */
@Injectable()
export class AnestheticCatalogUseCases {
  constructor(
    @Inject(ANESTHESIA_REPOSITORY)
    private readonly repo: AnesthesiaRepository,
  ) {}

  list(includeInactive: boolean): Promise<AnestheticProduct[]> {
    return this.repo.listProducts(includeInactive);
  }

  async create(
    input: AnestheticProductInput,
    userId: string,
  ): Promise<AnestheticProduct> {
    const values = clean(input) as AnestheticProductInput;
    const created = await this.repo.createProduct(
      {
        ...values,
        pediatricMaxMgPerKg: values.pediatricMaxMgPerKg ?? null,
        minAgeYears: values.minAgeYears ?? null,
        // DX-420: sin valor, de la dilución del vasoconstrictor.
        epinephrineMgPerCarpule:
          values.epinephrineMgPerCarpule ??
          epinephrineFromLabel(
            values.vasoconstrictor ?? null,
            values.mlPerCarpule,
          ),
      },
      userId,
    );
    if (created === 'DUPLICATE_NAME') {
      throw new ConflictException(ANESTHETIC_DUPLICATE_NAME_MESSAGE);
    }
    return created;
  }

  async update(
    id: string,
    patch: AnestheticProductPatch,
    userId: string,
  ): Promise<AnestheticProduct> {
    const values = clean(patch);
    // DX-420: cambiar el vasoconstrictor o el volumen sin dar la epinefrina
    // la recalcula, para que no quede la del carpule anterior.
    if (
      values.epinephrineMgPerCarpule === undefined &&
      (values.vasoconstrictor !== undefined ||
        values.mlPerCarpule !== undefined)
    ) {
      const current = await this.repo.findProduct(id);
      if (current === null) {
        throw new NotFoundException(ANESTHETIC_NOT_FOUND_MESSAGE);
      }
      values.epinephrineMgPerCarpule = epinephrineFromLabel(
        values.vasoconstrictor === undefined
          ? current.vasoconstrictor
          : values.vasoconstrictor,
        values.mlPerCarpule ?? current.mlPerCarpule,
      );
    }
    const updated = await this.repo.updateProduct(id, values, userId);
    if (updated === null) {
      throw new NotFoundException(ANESTHETIC_NOT_FOUND_MESSAGE);
    }
    if (updated === 'DUPLICATE_NAME') {
      throw new ConflictException(ANESTHETIC_DUPLICATE_NAME_MESSAGE);
    }
    return updated;
  }

  /** «Cargar sugeridos»: crea los que faltan; repetirlo no duplica nada. */
  loadSamples(userId: string): Promise<AnestheticProduct[]> {
    return this.repo.createMissingSamples(SAMPLE_ANESTHETICS, userId);
  }
}
