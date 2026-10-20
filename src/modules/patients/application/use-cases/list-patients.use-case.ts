import { Inject, Injectable } from '@nestjs/common';
import { PATIENT_REPOSITORY } from '../../domain/ports/patient-repository.port';
import type { PatientRepository } from '../../domain/ports/patient-repository.port';
import { Patient } from '../../domain/entities/patient.entity';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
export const PATIENTS_MAX_PAGE_SIZE = 100;
/**
 * Tope de `page` (DX-043, DB-005): el OFFSET recorre todas las filas que salta,
 * así que una página desorbitada es una consulta cara. 5000 páginas cubren
 * 100k pacientes con la página por defecto (20); más allá se busca. Lo valida
 * el DTO (400 en español); aquí solo se documenta junto a los demás topes.
 */
export const PATIENTS_MAX_PAGE = 5000;
export const PATIENTS_MAX_QUERY_LENGTH = 100;

export interface ListPatientsInput {
  query?: string;
  /** Solo pacientes con alguna cobertura viva de este pagador (DX-153). */
  payerId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListPatientsOutput {
  items: Patient[];
  total: number;
  page: number;
  pageSize: number;
}

function normalizePage(page?: number): number {
  if (page === undefined || !Number.isFinite(page) || page < 1) {
    return DEFAULT_PAGE;
  }
  return Math.floor(page);
}

function normalizePageSize(pageSize?: number): number {
  if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(pageSize), PATIENTS_MAX_PAGE_SIZE);
}

@Injectable()
export class ListPatientsUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  async execute(input: ListPatientsInput): Promise<ListPatientsOutput> {
    const page = normalizePage(input.page);
    const pageSize = normalizePageSize(input.pageSize);

    const { items, total } = await this.repo.list({
      query: input.query,
      payerId: input.payerId,
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { items, total, page, pageSize };
  }
}
