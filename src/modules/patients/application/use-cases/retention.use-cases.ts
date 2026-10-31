import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  totalLivePublicLinks,
  type LivePublicLinkCounts,
} from '../../domain/live-public-links';
import {
  PATIENT_PUBLIC_LINKS_READER,
  type PatientPublicLinksReader,
} from '../../domain/ports/patient-public-links.port';
import type { RetentionExtension } from '@prisma/client';
import {
  PATIENT_REPOSITORY,
  type ListPatientsResult,
  type PatientRepository,
} from '../../domain/ports/patient-repository.port';
import type { Patient } from '../../domain/entities/patient.entity';
import { CLINICAL_RECORD_RETENTION_YEARS } from '../../domain/retention/clinical-record-retention';
import {
  assertNoPendingAppointments,
  assertNotUnderRetention,
  assertUnderRetention,
} from '../retention-guard';

/** Hora del sistema; inyectable para los tests. */
export type Clock = () => Date;
export const RETENTION_CLOCK = Symbol('RETENTION_CLOCK');

/**
 * Archivar (borrado blando, `deletedAt`) un paciente — DX-039. Rechaza con 409
 * `CLINICAL_RECORD_RETENTION` si la HC sigue en retención legal; un paciente
 * sin atenciones clínicas (p. ej. un duplicado recién creado) se archiva,
 * salvo que tenga citas abiertas (409 `PATIENT_HAS_PENDING_APPOINTMENTS`).
 * DX-461: al archivar se anulan sus enlaces públicos vivos (ver el repo).
 */
@Injectable()
export class ArchivePatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  execute(id: string, ctx: AuditRequestContext): Promise<void> {
    const now = this.now();
    return this.repo.archive(
      id,
      (state) => {
        assertNotUnderRetention(state, now);
        assertNoPendingAppointments(state.pendingAppointments);
      },
      { now, ctx },
    );
  }
}

export type LivePublicLinksSummary = LivePublicLinkCounts & { total: number };

/**
 * DX-461: cuántos enlaces públicos vivos anularía archivar al paciente, para
 * avisarlo en el diálogo antes de confirmar. 404 si no existe en la clínica
 * (o ya está archivado).
 */
@Injectable()
export class CountPatientLivePublicLinksUseCase {
  constructor(
    @Inject(PATIENT_PUBLIC_LINKS_READER)
    private readonly links: PatientPublicLinksReader,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  async execute(patientId: string): Promise<LivePublicLinksSummary> {
    const counts = await this.links.countLive(patientId, this.now());
    if (!counts) throw new NotFoundException('Patient not found');
    return { ...counts, total: totalLivePublicLinks(counts) };
  }
}

/** Cambiar la retención extendida (solo ADMIN, lo exige el controlador). */
@Injectable()
export class SetRetentionExtensionUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
  ) {}

  execute(
    id: string,
    input: { value: RetentionExtension; reason: string; actorId: string },
  ): Promise<Patient> {
    return this.repo.setRetentionExtension(id, {
      ...input,
      reason: input.reason.trim(),
    });
  }
}

/**
 * Supresión parcial (solo ADMIN): para un paciente cuya HC está en retención,
 * vacía los datos no clínicos y retira la autorización de marketing, sin tocar
 * la HC. Motivo obligatorio.
 */
@Injectable()
export class PartiallySuppressPatientUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  execute(
    id: string,
    input: { reason: string; actorId: string },
  ): Promise<Patient> {
    const now = this.now();
    return this.repo.partiallySuppress(id, {
      reason: input.reason.trim(),
      actorId: input.actorId,
      assertAllowed: (state) => assertUnderRetention(state, now),
    });
  }
}

export const RETENTION_EXPIRING_MAX_DAYS = 365;
export const RETENTION_EXPIRING_MAX_PAGE_SIZE = 50;

function yearsBefore(date: Date, years: number): Date {
  const d = new Date(date);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/**
 * Historias que salen de retención (ya vencidas o que vencen dentro de
 * `withinDays`), para que el ADMIN decida. No purga nada (fuera de alcance).
 */
@Injectable()
export class ListRetentionExpiringUseCase {
  constructor(
    @Inject(PATIENT_REPOSITORY) private readonly repo: PatientRepository,
    @Inject(RETENTION_CLOCK) private readonly now: Clock,
  ) {}

  execute(input: {
    withinDays: number;
    page: number;
    pageSize: number;
  }): Promise<ListPatientsResult> {
    const now = this.now();
    const days = Math.min(input.withinDays, RETENTION_EXPIRING_MAX_DAYS);
    const take = Math.min(input.pageSize, RETENTION_EXPIRING_MAX_PAGE_SIZE);
    // Día siguiente al horizonte a medianoche UTC: la retención termina el
    // día (incluido) en que se cumplen los años, así que «vence antes del
    // horizonte» = última atención < horizonte + 1 día − N años.
    const horizon = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + days + 1,
      ),
    );
    return this.repo.listRetentionExpiring({
      noneBefore: yearsBefore(horizon, CLINICAL_RECORD_RETENTION_YEARS),
      doubleBefore: yearsBefore(horizon, CLINICAL_RECORD_RETENTION_YEARS * 2),
      skip: (input.page - 1) * take,
      take,
    });
  }
}
