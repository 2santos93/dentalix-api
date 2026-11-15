import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { FixedDocumentTypeNamesReader } from '../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import type { PatientCertificate } from '../domain/patient-certificate';
import type {
  ArchivePdf,
  CertificateIssueContext,
  CertificateSettings,
  IssueContextResult,
  IssueResult,
  NewCertificateInput,
  PatientCertificateRepository,
  VoidResult,
} from '../domain/ports/patient-certificate-repository.port';
import type { CertificatePdfRenderer } from '../infrastructure/certificate-pdf.renderer';
import {
  CertificateSettingsUseCases,
  PatientCertificatesUseCases,
} from './patient-certificates.use-cases';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SEDE = 'loc-chacao';
const OTRA_SEDE = 'loc-maracaibo';

const context = (
  over: Partial<CertificateIssueContext> = {},
): CertificateIssueContext => ({
  patient: {
    id: 'p1',
    firstName: 'Mariela',
    lastName: 'Rondón',
    docType: 'NATIONAL_ID',
    docTypeLabel: null,
    docNumber: 'V-12345678',
  },
  appointment: {
    id: 'a1',
    locationId: SEDE,
    providerId: 'u-dentist',
    status: AppointmentStatus.COMPLETED,
    start: new Date('2026-11-16T13:00:00Z'),
    end: new Date('2026-11-16T13:30:00Z'),
    arrivedAt: new Date('2026-11-16T12:55:00Z'),
    completedAt: new Date('2026-11-16T13:40:00Z'),
  },
  location: {
    id: SEDE,
    name: 'Sede Chacao',
    address: 'Av. Francisco de Miranda',
    healthRegistrationNumber: 'RS-001',
    showHealthRegistrationNumber: false,
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: {
    name: 'Clínica Ávila',
    legalName: null,
    taxIdLabel: 'RIF',
    taxId: 'J-12345678-9',
  },
  settings: { restMaxDays: 30, restPrintDiagnosis: true },
  provider: {
    membershipId: 'm-dentist',
    name: 'Dra. Ana Pérez',
    license: 'MPPS 45678',
    specialty: null,
  },
  issuer: {
    membershipId: 'm-dentist',
    name: 'Dra. Ana Pérez',
    license: 'MPPS 45678',
    specialty: null,
  },
  ...over,
});

class FakeRepo implements PatientCertificateRepository {
  ctx: IssueContextResult = { kind: 'OK', context: context() };
  rows: PatientCertificate[] = [];
  settings: CertificateSettings = {
    restMaxDays: 30,
    restPrintDiagnosis: false,
  };
  issued: NewCertificateInput[] = [];

  loadIssueContext(): Promise<IssueContextResult> {
    return Promise.resolve(this.ctx);
  }

  async issue(
    input: NewCertificateInput,
    archive: ArchivePdf,
  ): Promise<IssueResult> {
    const live = this.rows.find(
      (r) =>
        r.appointmentId === input.appointmentId &&
        r.kind === input.kind &&
        r.voidedAt === null,
    );
    if (live) return { kind: 'DUPLICATE', number: live.number };
    this.issued.push(input);
    const cert: PatientCertificate = {
      id: `c${this.rows.length + 1}`,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      locationId: input.locationId,
      professionalMembershipId: input.professionalMembershipId,
      issuedById: input.issuedById,
      issuedByName: null,
      kind: input.kind,
      number: this.rows.length + 1,
      issuedAt: new Date('2026-11-16T14:00:00Z'),
      attendedFrom: input.attendedFrom,
      attendedUntil: input.attendedUntil,
      timesSource: input.timesSource,
      restDays: input.rest?.restDays ?? null,
      restStartDate: input.rest?.restStartDate ?? null,
      restEndDate: input.rest?.restEndDate ?? null,
      diagnosis: input.rest?.diagnosis ?? null,
      snapshot: input.snapshot,
      documentId: null,
      voidedAt: null,
      voidedById: null,
      voidedByName: null,
      voidReason: null,
      voidedDocumentId: null,
    };
    const pdf = await archive(cert);
    cert.documentId = pdf.documentId;
    this.rows.push(cert);
    return { kind: 'ISSUED', certificate: cert };
  }

  private visible(locationIds?: readonly string[]): PatientCertificate[] {
    return this.rows.filter(
      (r) => !locationIds || locationIds.includes(r.locationId),
    );
  }

  list(
    _p: string,
    locationIds?: readonly string[],
  ): Promise<PatientCertificate[] | null> {
    return Promise.resolve(this.visible(locationIds));
  }

  get(
    _p: string,
    id: string,
    locationIds?: readonly string[],
  ): Promise<PatientCertificate | null> {
    return Promise.resolve(
      this.visible(locationIds).find((r) => r.id === id) ?? null,
    );
  }

  async voidCertificate(
    _p: string,
    id: string,
    locationIds: readonly string[] | undefined,
    actor: { userId: string; reason: string },
    authorize: (c: PatientCertificate) => void,
    archive: ArchivePdf,
  ): Promise<VoidResult> {
    const row = this.visible(locationIds).find((r) => r.id === id);
    if (!row) return { kind: 'NOT_FOUND' };
    authorize(row);
    if (row.voidedAt) return { kind: 'ALREADY_VOIDED' };
    Object.assign(row, {
      voidedAt: new Date(),
      voidedById: actor.userId,
      voidReason: actor.reason,
    });
    row.voidedDocumentId = (await archive(row)).documentId;
    return { kind: 'VOIDED', certificate: row };
  }

  eligibleAppointments(): Promise<null> {
    return Promise.resolve(null);
  }

  professionalLicense(): Promise<string | null> {
    return Promise.resolve('MPPS 45678');
  }

  getSettings(): Promise<CertificateSettings> {
    return Promise.resolve(this.settings);
  }

  setSettings(next: CertificateSettings) {
    const before = this.settings;
    this.settings = next;
    return Promise.resolve({ before, after: next });
  }
}

const renderer: CertificatePdfRenderer = {
  render: () => Promise.resolve(Buffer.from('%PDF-1.7 fake')),
};

describe('PatientCertificatesUseCases (DX-306)', () => {
  let repo: FakeRepo;
  let storage: jest.Mocked<Pick<FileStoragePort, 'save' | 'delete'>>;
  let tenantContext: TenantContextService;
  let useCases: PatientCertificatesUseCases;
  let allowed: readonly string[] | undefined;

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run(TENANT, undefined, fn, allowed);

  const dentist = { userId: 'u-dentist', role: ClinicRole.DENTIST };
  const reception = { userId: 'u-rec', role: ClinicRole.RECEPTION };

  beforeEach(() => {
    repo = new FakeRepo();
    storage = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    tenantContext = new TenantContextService();
    allowed = undefined;
    useCases = new PatientCertificatesUseCases(
      repo,
      renderer,
      storage as unknown as FileStoragePort,
      tenantContext,
      new FixedDocumentTypeNamesReader(),
    );
  });

  it('recepción emite el justificante de una cita atendida con las horas reales y la foto', async () => {
    const cert = await run(() =>
      useCases.issue(
        'p1',
        { kind: 'ATTENDANCE', appointmentId: 'a1' },
        reception,
      ),
    );
    expect(cert).toMatchObject({
      kind: 'ATTENDANCE',
      issuedById: 'u-rec',
      professionalMembershipId: 'm-dentist',
      timesSource: 'ACTUAL',
      attendedFrom: new Date('2026-11-16T12:55:00Z'),
      attendedUntil: new Date('2026-11-16T13:40:00Z'),
      diagnosis: null,
    });
    expect(cert.snapshot).toMatchObject({
      patient: { name: 'Mariela Rondón' },
      professional: { name: 'Dra. Ana Pérez', license: 'MPPS 45678' },
      // La sede no muestra su registro sanitario: no va en la foto.
      location: { healthRegistrationNumber: null, timeZone: 'America/Caracas' },
      clinic: { taxIdLabel: 'RIF', taxId: 'J-12345678-9' },
    });
    expect(cert.snapshot.patient.document).toContain('V-12345678');
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(cert.documentId).not.toBeNull();
  });

  it('cita no atendida: 409 en español; otra sede: 403 (antes que el estado)', async () => {
    repo.ctx = {
      kind: 'OK',
      context: context({
        appointment: {
          ...context().appointment,
          status: AppointmentStatus.SCHEDULED,
        },
      }),
    };
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toThrow(
      new ConflictException(
        'Solo se emite para una cita atendida: esta cita está agendada.',
      ),
    );
    allowed = [OTRA_SEDE];
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('paciente o cita inexistentes: 404', async () => {
    repo.ctx = { kind: 'PATIENT_NOT_FOUND' };
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    repo.ctx = { kind: 'APPOINTMENT_NOT_FOUND' };
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toThrow('La cita no existe o no es de este paciente.');
  });

  it('el reposo: recepción y asistente 403; sin registro 400 que dice qué; con todo, días y diagnóstico', async () => {
    for (const role of [ClinicRole.RECEPTION, ClinicRole.ASSISTANT]) {
      await expect(
        run(() =>
          useCases.issue(
            'p1',
            { kind: 'REST', appointmentId: 'a1', restDays: 2 },
            { userId: 'x', role },
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
    repo.ctx = {
      kind: 'OK',
      context: context({
        issuer: { ...context().issuer!, license: null },
      }),
    };
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'REST', appointmentId: 'a1', restDays: 45 },
          dentist,
        ),
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'No se puede emitir el certificado de reposo: falta tu número de registro profesional (lo añade un administrador en Personal); los días de reposo deben ser un número entero entre 1 y 30.',
      ),
    );
    expect(storage.save).not.toHaveBeenCalled();

    repo.ctx = { kind: 'OK', context: context() };
    const cert = await run(() =>
      useCases.issue(
        'p1',
        {
          kind: 'REST',
          appointmentId: 'a1',
          restDays: 3,
          diagnosis: 'Exodoncia del 38',
        },
        dentist,
      ),
    );
    expect(cert).toMatchObject({
      kind: 'REST',
      restDays: 3,
      // Día de la atención en Caracas.
      restStartDate: '2026-11-16',
      restEndDate: '2026-11-18',
      diagnosis: 'Exodoncia del 38',
    });
  });

  it('dos del mismo tipo para la misma cita: 409 con el número y sin PDF huérfano', async () => {
    await run(() =>
      useCases.issue(
        'p1',
        { kind: 'ATTENDANCE', appointmentId: 'a1' },
        reception,
      ),
    );
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toThrow(
      'Ya hay un justificante de asistencia vigente de esta cita (Nº 000001). Anúlalo para emitir otro.',
    );
  });

  it('si la BD falla tras guardar el PDF, se borra el objeto', async () => {
    const original = repo.issue.bind(repo);
    jest.spyOn(repo, 'issue').mockImplementation(async (input, archive) => {
      await original(input, archive);
      throw new Error('BD caída');
    });
    await expect(
      run(() =>
        useCases.issue(
          'p1',
          { kind: 'ATTENDANCE', appointmentId: 'a1' },
          reception,
        ),
      ),
    ).rejects.toThrow('BD caída');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(storage.save.mock.calls[0][0]);
  });

  it('recepción no ve el diagnóstico ni imprime un reposo que lo lleva', async () => {
    const cert = await run(() =>
      useCases.issue(
        'p1',
        {
          kind: 'REST',
          appointmentId: 'a1',
          restDays: 2,
          diagnosis: 'Alveolitis',
        },
        dentist,
      ),
    );
    const [seen] = await run(() => useCases.list('p1', reception));
    expect(seen.diagnosis).toBeNull();
    expect(seen.diagnosisHidden).toBe(true);
    const [mine] = await run(() => useCases.list('p1', dentist));
    expect(mine.diagnosis).toBe('Alveolitis');
    await expect(
      run(() => useCases.pdf('p1', cert.id, reception)),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      run(() => useCases.pdf('p1', cert.id, dentist)),
    ).resolves.toMatchObject({ fileName: 'certificado-reposo-000001.pdf' });
  });

  it('el PDF archivado en Documentos nunca lleva el diagnóstico; el de quien lo ve, sí', async () => {
    const models: unknown[] = [];
    useCases = new PatientCertificatesUseCases(
      repo,
      {
        render: (model) => {
          models.push(model);
          return Promise.resolve(Buffer.from('%PDF'));
        },
      },
      storage as unknown as FileStoragePort,
      tenantContext,
      new FixedDocumentTypeNamesReader(),
    );
    const cert = await run(() =>
      useCases.issue(
        'p1',
        {
          kind: 'REST',
          appointmentId: 'a1',
          restDays: 2,
          diagnosis: 'Alveolitis',
        },
        dentist,
      ),
    );
    // El archivado (el único render de la emisión).
    expect(JSON.stringify(models)).not.toContain('Alveolitis');
    await run(() => useCases.pdf('p1', cert.id, dentist));
    expect(JSON.stringify(models[1])).toContain('Diagnóstico: Alveolitis');
  });

  it('sede no permitida: no sale en la lista ni por id (404 al imprimir y anular)', async () => {
    const cert = await run(() =>
      useCases.issue(
        'p1',
        { kind: 'ATTENDANCE', appointmentId: 'a1' },
        reception,
      ),
    );
    allowed = [OTRA_SEDE];
    await expect(run(() => useCases.list('p1', reception))).resolves.toEqual(
      [],
    );
    await expect(
      run(() => useCases.pdf('p1', cert.id, reception)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      run(() => useCases.void('p1', cert.id, 'Fecha equivocada', reception)),
    ).rejects.toBeInstanceOf(NotFoundException);
    allowed = [SEDE];
    await expect(
      run(() => useCases.list('p1', reception)),
    ).resolves.toHaveLength(1);
  });

  it('anular: motivo obligatorio; solo quien emitió o ADMIN; una vez', async () => {
    const cert = await run(() =>
      useCases.issue(
        'p1',
        { kind: 'ATTENDANCE', appointmentId: 'a1' },
        reception,
      ),
    );
    await expect(
      run(() => useCases.void('p1', cert.id, ' a ', reception)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(() =>
        useCases.void('p1', cert.id, 'Fecha equivocada', {
          userId: 'otra',
          role: ClinicRole.RECEPTION,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const voided = await run(() =>
      useCases.void('p1', cert.id, 'Fecha equivocada', reception),
    );
    expect(voided).toMatchObject({ voidReason: 'Fecha equivocada' });
    expect(voided.voidedDocumentId).not.toBeNull();
    await expect(
      run(() =>
        useCases.void('p1', cert.id, 'Otra vez', {
          userId: 'adm',
          role: ClinicRole.ADMIN,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      run(() => useCases.void('p1', 'nada', 'Motivo', reception)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CertificateSettingsUseCases (DX-306)', () => {
  const ctx: AuditRequestContext = {
    tenantId: TENANT,
    locationId: null,
    actor: { userId: 'u-admin', role: ClinicRole.ADMIN },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };

  it('valida, guarda y audita solo lo que cambió', async () => {
    const repo = new FakeRepo();
    const record = jest.fn().mockResolvedValue(undefined);
    const useCases = new CertificateSettingsUseCases(repo, {
      record,
    } as unknown as RecordAuditEventUseCase);
    await expect(
      useCases.update({ restMaxDays: 0, restPrintDiagnosis: true }, ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      useCases.update({ restMaxDays: 10, restPrintDiagnosis: 'sí' }, ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
    await useCases.update({ restMaxDays: 30, restPrintDiagnosis: false }, ctx);
    expect(record).not.toHaveBeenCalled();
    const after = await useCases.update(
      { restMaxDays: 15, restPrintDiagnosis: false },
      ctx,
    );
    expect(after).toEqual({ restMaxDays: 15, restPrintDiagnosis: false });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        metadata: {
          reason: 'CERTIFICATE_SETTINGS',
          changedFields: ['restMaxDays'],
        },
      }),
    );
  });
});
