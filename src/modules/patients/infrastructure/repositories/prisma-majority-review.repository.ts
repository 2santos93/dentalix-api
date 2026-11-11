import { Injectable } from '@nestjs/common';
import { Prisma, type MajorityReviewDecision } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { NoticeSettings } from '../../domain/communication/notice-recipient';
import type {
  ComingOfAgeCandidate,
  ComingOfAgeQuery,
  MajorityReviewRepository,
  MajorityReviewSnapshot,
  NewMajorityReview,
} from '../../domain/ports/majority-review-repository.port';
import { loadNoticeSettings } from '../notices/notice-context';

const civilDay = (d: Date): string => d.toISOString().slice(0, 10);

interface CandidateRow {
  patientId: string;
  firstName: string;
  lastName: string;
  patientCode: number;
  birthDate: Date;
  responsiblesCount: number;
  firstResponsibleAt: Date;
  reviewDecision: MajorityReviewDecision | null;
  reviewMajorityDate: Date | null;
  locationId: string | null;
  locationName: string | null;
}

/**
 * DX-342: revisión del paso a la mayoría de edad, bajo la RLS de la clínica.
 * Los responsables son los VIVOS de la regla de destinatario
 * (loadNoticeResponsibles): un paciente responsable archivado no cuenta.
 */
@Injectable()
export class PrismaMajorityReviewRepository implements MajorityReviewRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  private loadSettings(tx: Prisma.TransactionClient): Promise<NoticeSettings> {
    return loadNoticeSettings(
      tx,
      this.tenantId(),
      this.tenantContext.getLocationId() ?? null,
    );
  }

  settings(): Promise<NoticeSettings> {
    return this.prisma.runWithTenant((tx) => this.loadSettings(tx));
  }

  locationExists(locationId: string): Promise<boolean> {
    return this.prisma.runWithTenant(
      async (tx) =>
        (await tx.location.findFirst({
          where: { id: locationId },
          select: { id: true },
        })) !== null,
    );
  }

  load(patientId: string): Promise<MajorityReviewSnapshot | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true, birthDate: true },
      });
      if (!patient) return null;
      const [rows, review, settings] = await Promise.all([
        tx.patientResponsibleParty.findMany({
          where: { patientId, deletedAt: null },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            fullName: true,
            relationship: true,
            receivesNotices: true,
            isPayer: true,
            createdAt: true,
            responsiblePatient: {
              select: { firstName: true, lastName: true, deletedAt: true },
            },
          },
        }),
        tx.patientMajorityReview.findFirst({
          where: { patientId },
          orderBy: [{ reviewedAt: 'desc' }, { id: 'desc' }],
          select: {
            decision: true,
            majorityDate: true,
            reviewedAt: true,
            reviewedById: true,
          },
        }),
        this.loadSettings(tx),
      ]);
      const reviewer = review
        ? await tx.clinicMembership.findFirst({
            where: { userId: review.reviewedById },
            orderBy: { createdAt: 'desc' },
            select: { user: { select: { fullName: true } } },
          })
        : null;
      return {
        patient,
        responsibles: rows
          .filter((r) => !r.responsiblePatient?.deletedAt)
          .map((r) => ({
            id: r.id,
            name: r.responsiblePatient
              ? `${r.responsiblePatient.firstName} ${r.responsiblePatient.lastName}`
              : (r.fullName ?? ''),
            relationship: r.relationship,
            receivesNotices: r.receivesNotices,
            isPayer: r.isPayer,
            createdAt: r.createdAt,
          })),
        review: review
          ? {
              decision: review.decision,
              majorityDate: civilDay(review.majorityDate),
              reviewedAt: review.reviewedAt,
              reviewedById: review.reviewedById,
              reviewedByName: reviewer?.user.fullName ?? null,
            }
          : null,
        settings,
      };
    });
  }

  async insert(review: NewMajorityReview): Promise<void> {
    const tenantId = this.tenantId();
    await this.prisma.runWithTenant((tx) =>
      tx.patientMajorityReview.create({
        data: {
          tenantId,
          patientId: review.patientId,
          decision: review.decision,
          note: review.note,
          majorityDate: new Date(`${review.majorityDate}T00:00:00.000Z`),
          reviewedById: review.reviewedById,
        },
        select: { id: true },
      }),
    );
  }

  /**
   * UNA sentencia acotada por los responsables vivos de la clínica
   * (patient_responsible_parties_tenant_patient_idx): solo los pacientes con
   * responsable pueden pasar a la mayoría de edad «con responsable». Para
   * cada uno, su última revisión (patient_majority_reviews_patient_idx) y su
   * sede: la de su última cita atendida (appointments_tenant_patient_completed_idx).
   * Los atrasados se acotan con holgura (dos días por la zona y el 29/2): el
   * caso de uso aplica la regla exacta.
   */
  comingOfAge(query: ComingOfAgeQuery): Promise<ComingOfAgeCandidate[]> {
    const tenantId = this.tenantId();
    const locationFilter = query.locationIds
      ? Prisma.sql`AND hl."locationId" = ANY(${[...query.locationIds]}::uuid[])`
      : Prisma.empty;
    return this.prisma.runWithTenant(async (tx) => {
      const rows = await tx.$queryRaw<CandidateRow[]>`
        WITH r AS (
          SELECT x."patientId",
                 count(*)::int AS "responsiblesCount",
                 min(x."createdAt") AS "firstResponsibleAt"
            FROM "patient_responsible_parties" x
            LEFT JOIN "patients" rp
              ON rp."tenantId" = x."tenantId" AND rp."id" = x."responsiblePatientId"
           WHERE x."tenantId" = ${tenantId}::uuid
             AND x."deletedAt" IS NULL
             AND (x."responsiblePatientId" IS NULL OR rp."deletedAt" IS NULL)
           GROUP BY x."patientId"
        )
        SELECT p."id" AS "patientId", p."firstName", p."lastName",
               p."patientCode", p."birthDate",
               r."responsiblesCount", r."firstResponsibleAt",
               rv."decision" AS "reviewDecision",
               rv."majorityDate" AS "reviewMajorityDate",
               hl."locationId", lo."name" AS "locationName"
          FROM r
          JOIN "patients" p
            ON p."tenantId" = ${tenantId}::uuid AND p."id" = r."patientId"
          LEFT JOIN LATERAL (
            SELECT m."decision", m."majorityDate"
              FROM "patient_majority_reviews" m
             WHERE m."tenantId" = p."tenantId" AND m."patientId" = p."id"
             ORDER BY m."reviewedAt" DESC, m."id" DESC
             LIMIT 1
          ) rv ON true
          LEFT JOIN LATERAL (
            SELECT a."locationId"
              FROM "appointments" a
             WHERE a."tenantId" = p."tenantId"
               AND a."patientId" = p."id"
               AND a."status" = 'COMPLETED'
               AND a."deletedAt" IS NULL
             ORDER BY a."start" DESC, a."id" DESC
             LIMIT 1
          ) hl ON true
          LEFT JOIN "locations" lo
            ON lo."tenantId" = p."tenantId" AND lo."id" = hl."locationId"
         WHERE p."deletedAt" IS NULL
           AND p."birthDate" IS NOT NULL
           AND p."birthDate" <= ${query.maxBirthDate}::date
           AND (
             p."birthDate" >= ${query.minBirthDate}::date
             OR r."firstResponsibleAt"
                  < p."birthDate" + make_interval(years => ${query.majorityAge}::int) + interval '2 days'
           )
           ${locationFilter}`;
      return rows.map((row) => ({
        patientId: row.patientId,
        firstName: row.firstName,
        lastName: row.lastName,
        patientCode: row.patientCode,
        birthDate: row.birthDate,
        responsiblesCount: row.responsiblesCount,
        firstResponsibleAt: row.firstResponsibleAt,
        review:
          row.reviewDecision && row.reviewMajorityDate
            ? {
                decision: row.reviewDecision,
                majorityDate: civilDay(row.reviewMajorityDate),
              }
            : null,
        locationId: row.locationId,
        locationName: row.locationName,
      }));
    });
  }
}
