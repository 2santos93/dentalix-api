import { Injectable } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  ResponsiblePartyConflictError,
  type CreateResponsiblePartyData,
  type ResponsibleContactFields,
  type PatientResponsiblesSnapshot,
  type ResponsiblePartyRepository,
  type ResponsiblePartyView,
  type ResponsiblePatientSummary,
  type UpdateResponsiblePartyData,
} from '../../domain/ports/responsible-party-repository.port';
import {
  loadNoticeSettings,
  loadNoticeResponsibles,
} from '../notices/notice-context';

const SUMMARY_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  documentType: true,
  docTypeLabel: true,
  docNumber: true,
  email: true,
  phone: true,
} as const satisfies Prisma.PatientSelect;

const PARTY_SELECT = {
  id: true,
  patientId: true,
  fullName: true,
  documentType: true,
  docTypeLabel: true,
  docNumber: true,
  email: true,
  phone: true,
  relationship: true,
  isPayer: true,
  receivesNotices: true,
  migratedFromGuardian: true,
  createdAt: true,
  updatedAt: true,
  responsiblePatient: { select: SUMMARY_SELECT },
} as const satisfies Prisma.PatientResponsiblePartySelect;

export type PartyRow = Prisma.PatientResponsiblePartyGetPayload<{
  select: typeof PARTY_SELECT;
}>;

type SummaryRow = Prisma.PatientGetPayload<{ select: typeof SUMMARY_SELECT }>;

/** DX-327 (R4): el tipo genérico, nunca el código anterior. */
function toSummary(p: SummaryRow): ResponsiblePatientSummary {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    docType: p.documentType,
    docTypeLabel: p.docTypeLabel,
    docNumber: p.docNumber,
    email: p.email,
    phone: p.phone,
  };
}

/** El alta de un contacto: su `docType` va a la columna `documentType`. */
function contactCreateData({ docType, ...rest }: ResponsibleContactFields) {
  return {
    ...rest,
    documentType: docType,
  } satisfies { documentType: DocumentType | null };
}

/**
 * R7: con `docType` y sin `docTypeLabel`, la etiqueta se borra solo si el
 * tipo cambia respecto del GUARDADO (`stored`, de la fila bloqueada).
 */
export function contactUpdateData(
  { docType, ...rest }: Partial<ResponsibleContactFields>,
  stored: DocumentType | null,
): Omit<Prisma.PatientResponsiblePartyUncheckedUpdateManyInput, 'docType'> {
  if (docType === undefined) return rest;
  const clearsLabel = rest.docTypeLabel === undefined && docType !== stored;
  return {
    ...rest,
    documentType: docType,
    ...(clearsLabel ? { docTypeLabel: null } : {}),
  };
}

export function toView(row: PartyRow): ResponsiblePartyView {
  const p = row.responsiblePatient;
  const summary = p ? toSummary(p) : null;
  return {
    id: row.id,
    patientId: row.patientId,
    kind: summary ? 'PATIENT' : 'CONTACT',
    responsiblePatient: summary,
    fullName: summary
      ? `${summary.firstName} ${summary.lastName}`
      : (row.fullName ?? ''),
    docType: summary ? summary.docType : row.documentType,
    docTypeLabel: summary ? summary.docTypeLabel : row.docTypeLabel,
    docNumber: summary ? summary.docNumber : row.docNumber,
    email: summary ? summary.email : row.email,
    phone: summary ? summary.phone : row.phone,
    relationship: row.relationship,
    isPayer: row.isPayer,
    receivesNotices: row.receivesNotices,
    migratedFromGuardian: row.migratedFromGuardian,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Un índice único parcial saltó: el pagador o el mismo paciente dos veces. */
function conflictOf(err: unknown): ResponsiblePartyConflictError | null {
  if (
    !(err instanceof Prisma.PrismaClientKnownRequestError) ||
    err.code !== 'P2002'
  ) {
    return null;
  }
  const target = JSON.stringify(err.meta ?? {});
  return new ResponsiblePartyConflictError(
    target.includes('responsiblePatientId') || target.includes('patient_link')
      ? 'DUPLICATE_PATIENT'
      : 'PAYER',
  );
}

/**
 * Responsables de pago y avisos (DX-203), bajo la RLS de la clínica del
 * contexto: un paciente de otra clínica no aparece (404 en el caso de uso) y,
 * si se colara, la FK compuesta lo rechaza.
 */
@Injectable()
export class PrismaResponsiblePartyRepository implements ResponsiblePartyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  load(patientId: string): Promise<PatientResponsiblesSnapshot | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          birthDate: true,
          email: true,
          emergencyContactName: true,
        },
      });
      if (!patient) return null;
      const [rows, responsibleFor, noticeResponsibles, noticeSettings] =
        await Promise.all([
          tx.patientResponsibleParty.findMany({
            // Con el responsable archivado también: sigue ocupando el pagador
            // (índice único) y recepción tiene que poder quitarlo. Los avisos
            // no le llegan (loadNoticeResponsibles lo excluye).
            where: { patientId, deletedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: PARTY_SELECT,
          }),
          // Índice parcial patient_responsible_parties_responsible_idx.
          tx.patientResponsibleParty.findMany({
            where: {
              responsiblePatientId: patientId,
              deletedAt: null,
              patient: { deletedAt: null },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              relationship: true,
              isPayer: true,
              receivesNotices: true,
              patient: {
                select: { id: true, firstName: true, lastName: true },
              },
            },
          }),
          loadNoticeResponsibles(tx, patientId),
          loadNoticeSettings(
            tx,
            tenantId,
            this.tenantContext.getLocationId() ?? null,
          ),
        ]);
      return {
        patient,
        parties: rows.map(toView),
        noticeResponsibles,
        responsibleFor,
        noticeSettings,
      };
    });
  }

  async findPatient(
    patientId: string,
  ): Promise<ResponsiblePatientSummary | null> {
    const row = await this.prisma.runWithTenant((tx) =>
      tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: SUMMARY_SELECT,
      }),
    );
    return row ? toSummary(row) : null;
  }

  async create(
    patientId: string,
    data: CreateResponsiblePartyData,
    createdById: string,
  ): Promise<ResponsiblePartyView> {
    const tenantId = this.requireTenantId();
    try {
      return await this.prisma.runWithTenant(async (tx) =>
        toView(
          await tx.patientResponsibleParty.create({
            data: {
              tenantId,
              patientId,
              responsiblePatientId: data.responsiblePatientId,
              ...(data.contact ? contactCreateData(data.contact) : {}),
              relationship: data.relationship,
              isPayer: data.isPayer,
              receivesNotices: data.receivesNotices,
              createdById,
            },
            select: PARTY_SELECT,
          }),
        ),
      );
    } catch (err) {
      throw conflictOf(err) ?? err;
    }
  }

  async update(
    patientId: string,
    partyId: string,
    data: UpdateResponsiblePartyData,
  ): Promise<ResponsiblePartyView | null> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // FOR UPDATE: el tipo con el que se decide la etiqueta (R7) es el de
        // la fila que se va a escribir, no el que leyó antes el caso de uso.
        const [locked] = await tx.$queryRaw<
          { documentType: DocumentType | null }[]
        >`
          SELECT "documentType" FROM "patient_responsible_parties"
           WHERE "id" = ${partyId}::uuid AND "patientId" = ${patientId}::uuid
             AND "deletedAt" IS NULL
           FOR UPDATE`;
        if (!locked) return null;
        const { count } = await tx.patientResponsibleParty.updateMany({
          where: { id: partyId, patientId, deletedAt: null },
          data: {
            relationship: data.relationship,
            isPayer: data.isPayer,
            receivesNotices: data.receivesNotices,
            ...(data.contact
              ? contactUpdateData(data.contact, locked.documentType)
              : {}),
          },
        });
        if (count === 0) return null;
        return toView(
          await tx.patientResponsibleParty.findFirstOrThrow({
            where: { id: partyId },
            select: PARTY_SELECT,
          }),
        );
      });
    } catch (err) {
      throw conflictOf(err) ?? err;
    }
  }

  async remove(patientId: string, partyId: string): Promise<boolean> {
    const { count } = await this.prisma.runWithTenant((tx) =>
      tx.patientResponsibleParty.updateMany({
        where: { id: partyId, patientId, deletedAt: null },
        data: { deletedAt: new Date() },
      }),
    );
    return count > 0;
  }
}
