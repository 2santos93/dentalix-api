import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { FileStoragePort } from '../../../shared/storage/file-storage.port';
import type { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import { FixedDocumentTypeNamesReader } from '../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import type { ExternalOrder } from '../domain/external-order';
import type {
  ArchiveExternalOrderPdf,
  ExternalOrderIssueContext,
  ExternalOrderIssueContextResult,
  ExternalOrderRepository,
  ExternalOrderSettings,
  LinkResultOutcome,
  NewExternalOrderInput,
  PendingExternalOrdersQuery,
  UnlinkResultOutcome,
  VoidExternalOrderResult,
} from '../domain/ports/external-order-repository.port';
import type { ExternalOrderPdfModel } from '../domain/external-order';
import type { ExternalOrderPdfRenderer } from '../infrastructure/external-order-pdf.renderer';
import {
  ExternalOrderSettingsUseCases,
  ExternalOrdersUseCases,
} from './external-orders.use-cases';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SEDE = 'loc-chacao';
const OTRA_SEDE = 'loc-maracaibo';
const NOW = new Date('2026-12-01T15:00:00Z');

const context = (
  over: Partial<ExternalOrderIssueContext> = {},
): ExternalOrderIssueContext => ({
  patient: {
    id: 'p1',
    firstName: 'Mariela',
    lastName: 'Rondón',
    birthDate: new Date('1992-12-02T00:00:00Z'),
    docType: 'NATIONAL_ID',
    docTypeLabel: null,
    docNumber: '12345678',
  },
  appointment: null,
  location: {
    id: SEDE,
    name: 'Sede Chacao',
    address: 'Av. Principal 10',
    healthRegistrationNumber: null,
    showHealthRegistrationNumber: false,
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: {
    name: 'Clínica Ávila',
    legalName: null,
    taxIdLabel: null,
    taxId: null,
    logoKey: 'logos/clinica-0123456789abcdef.png',
  },
  issuer: {
    membershipId: 'm-dentist',
    name: 'Dra. Ana Pérez',
    license: 'REG-45678',
    specialty: null,
  },
  template: null,
  ...over,
});

const content = {
  kind: 'IMAGING' as const,
  recipient: 'Centro de Imagen del Este',
  items: ['Radiografía panorámica'],
  toothNumbers: ['36'],
  clinicalNote: 'Dolor a la percusión',
};

class FakeRepo implements ExternalOrderRepository {
  ctx: ExternalOrderIssueContextResult = { kind: 'OK', context: context() };
  rows: ExternalOrder[] = [];
  issued: NewExternalOrderInput[] = [];
  settings: ExternalOrderSettings = { overdueDays: 15 };
  pendingQuery: PendingExternalOrdersQuery | null = null;
  templates: string[] = [];
  recent: string[] = [];

  loadIssueContext(): Promise<ExternalOrderIssueContextResult> {
    return Promise.resolve(this.ctx);
  }

  async issue(
    input: NewExternalOrderInput,
    archive: ArchiveExternalOrderPdf,
  ): Promise<ExternalOrder> {
    this.issued.push(input);
    const order: ExternalOrder = {
      id: `o${this.rows.length + 1}`,
      patientId: input.patientId,
      locationId: input.locationId,
      appointmentId: input.appointmentId,
      professionalMembershipId: input.professionalMembershipId,
      issuedById: input.issuedById,
      issuedByName: null,
      ...input.content,
      number: this.rows.length + 1,
      issuedAt: new Date('2026-11-16T14:00:00Z'),
      status: 'ISSUED',
      templateId: input.templateId,
      snapshot: input.snapshot,
      clinicLogoKey: input.clinicLogoKey,
      documentId: null,
      resultDocumentId: null,
      resultLinkedAt: null,
      resultLinkedById: null,
      resultLinkedByName: null,
      voidedAt: null,
      voidedById: null,
      voidedByName: null,
      voidReason: null,
      voidedDocumentId: null,
    };
    order.documentId = (await archive(order)).documentId;
    this.rows.push(order);
    return order;
  }

  private visible(locationIds?: readonly string[]): ExternalOrder[] {
    return this.rows.filter(
      (r) => !locationIds || locationIds.includes(r.locationId),
    );
  }

  listForPatient(
    _p: string,
    locationIds?: readonly string[],
  ): Promise<ExternalOrder[] | null> {
    return Promise.resolve(this.visible(locationIds));
  }

  get(id: string, locationIds?: readonly string[]) {
    return Promise.resolve(
      this.visible(locationIds).find((r) => r.id === id) ?? null,
    );
  }

  async voidOrder(
    id: string,
    locationIds: readonly string[] | undefined,
    actor: { userId: string; reason: string },
    authorize: (o: ExternalOrder) => void,
    archive: ArchiveExternalOrderPdf,
  ): Promise<VoidExternalOrderResult> {
    const row = this.visible(locationIds).find((r) => r.id === id);
    if (!row) return { kind: 'NOT_FOUND' };
    authorize(row);
    if (row.status === 'VOIDED') return { kind: 'ALREADY_VOIDED' };
    if (row.status !== 'ISSUED') return { kind: 'NOT_ISSUED' };
    Object.assign(row, {
      status: 'VOIDED',
      voidedAt: NOW,
      voidedById: actor.userId,
      voidReason: actor.reason,
    });
    row.voidedDocumentId = (await archive(row)).documentId;
    return { kind: 'VOIDED', order: row };
  }

  linkResult(
    id: string,
    _l: readonly string[] | undefined,
    documentId: string,
    userId: string,
  ): Promise<LinkResultOutcome> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (row.status !== 'ISSUED') return Promise.resolve({ kind: 'NOT_ISSUED' });
    Object.assign(row, {
      status: 'RESULT_RECEIVED',
      resultDocumentId: documentId,
      resultLinkedAt: NOW,
      resultLinkedById: userId,
    });
    return Promise.resolve({ kind: 'LINKED', order: row });
  }

  unlinkResult(
    id: string,
    _l: readonly string[] | undefined,
    authorize: (o: ExternalOrder) => void,
  ): Promise<UnlinkResultOutcome> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (row.status !== 'RESULT_RECEIVED') {
      return Promise.resolve({ kind: 'NOT_RECEIVED' });
    }
    authorize(row);
    Object.assign(row, {
      status: 'ISSUED',
      resultDocumentId: null,
      resultLinkedAt: null,
      resultLinkedById: null,
    });
    return Promise.resolve({ kind: 'UNLINKED', order: row });
  }

  pending(query: PendingExternalOrdersQuery) {
    this.pendingQuery = query;
    const rows = this.rows
      .filter((r) => r.status === 'ISSUED' && r.locationId === query.locationId)
      .map((order) => ({
        order,
        patient: { id: order.patientId, firstName: 'M', lastName: 'R' },
      }));
    return Promise.resolve({ rows, total: rows.length });
  }

  locationTimeZone(locationId: string) {
    return Promise.resolve(
      [SEDE, OTRA_SEDE].includes(locationId)
        ? { timeZone: 'America/Caracas' }
        : null,
    );
  }

  recentRecipients() {
    return Promise.resolve(this.recent);
  }

  templateRecipients() {
    return Promise.resolve(this.templates);
  }

  getSettings() {
    return Promise.resolve(this.settings);
  }

  setSettings(next: ExternalOrderSettings) {
    const before = this.settings;
    this.settings = next;
    return Promise.resolve({ before, after: next });
  }
}

describe('ExternalOrdersUseCases (DX-572)', () => {
  let repo: FakeRepo;
  let storage: jest.Mocked<Pick<FileStoragePort, 'save' | 'delete' | 'read'>>;
  let rendered: ExternalOrderPdfModel[];
  let tenantContext: TenantContextService;
  let useCases: ExternalOrdersUseCases;
  let allowed: readonly string[] | undefined;
  let activeLocation: string | undefined;

  const run = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantContext.run(TENANT, activeLocation, fn, allowed);

  const dentist = { userId: 'u-dentist', role: ClinicRole.DENTIST };
  const assistant = { userId: 'u-asis', role: ClinicRole.ASSISTANT };
  const reception = { userId: 'u-rec', role: ClinicRole.RECEPTION };
  const admin = { userId: 'u-admin', role: ClinicRole.ADMIN };

  beforeEach(() => {
    repo = new FakeRepo();
    rendered = [];
    storage = {
      save: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      read: jest.fn().mockResolvedValue({
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        contentType: 'image/png',
      }),
    };
    const renderer: ExternalOrderPdfRenderer = {
      render: (model) => {
        rendered.push(model);
        return Promise.resolve(Buffer.from('%PDF-1.7 fake'));
      },
    };
    tenantContext = new TenantContextService();
    allowed = undefined;
    activeLocation = undefined;
    useCases = new ExternalOrdersUseCases(
      repo,
      renderer,
      storage as unknown as FileStoragePort,
      tenantContext,
      new FixedDocumentTypeNamesReader(),
      () => NOW,
    );
  });

  const issue = (actor = dentist, input = {}) =>
    run(() => useCases.issue('p1', { ...content, ...input }, actor));

  it('emite con la foto (edad en el día de la sede), el logo de hoy y archiva el PDF SIN la nota', async () => {
    const order = await issue();
    expect(order).toMatchObject({
      issuedById: 'u-dentist',
      professionalMembershipId: 'm-dentist',
      locationId: SEDE,
      clinicalNote: 'Dolor a la percusión',
      clinicLogoKey: 'logos/clinica-0123456789abcdef.png',
    });
    // Cumple 34 el 2 de diciembre: el 1 de diciembre en Caracas tiene 33.
    expect(order.snapshot.patient).toMatchObject({
      name: 'Mariela Rondón',
      ageYears: 33,
    });
    expect(order.snapshot.patient.document).toContain('12345678');
    expect(order.snapshot.professional.license).toBe('REG-45678');
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(rendered[0].note).toBeNull();
    expect(rendered[0].noteOmitted).not.toBeNull();
    expect(rendered[0].logo).not.toBeNull();
    expect(storage.read).toHaveBeenCalledWith(
      'logos/clinica-0123456789abcdef.png',
    );
  });

  it('solo DENTIST y ADMIN emiten: auxiliar y recepción, 403 en español', async () => {
    for (const actor of [assistant, reception]) {
      await expect(issue(actor)).rejects.toThrow(
        new ForbiddenException(
          'Solo un odontólogo o un administrador emiten órdenes de estudios y referencias.',
        ),
      );
    }
    await expect(issue(admin)).resolves.toMatchObject({
      issuedById: 'u-admin',
    });
  });

  it('sin registro profesional o con contenido inválido: un 400 que lo dice todo', async () => {
    repo.ctx = {
      kind: 'OK',
      context: context({
        issuer: { ...context().issuer!, license: null },
      }),
    };
    await expect(issue(dentist, { recipient: '', items: [] })).rejects.toThrow(
      BadRequestException,
    );
    await issue(dentist, { recipient: '', items: [] }).catch((e: Error) => {
      expect(e.message).toMatch(/centro o el especialista/);
      expect(e.message).toMatch(/estudios o motivos/);
      expect(e.message).toMatch(/registro profesional/);
    });
    expect(repo.issued).toHaveLength(0);
  });

  it('paciente, cita o plantilla que no existen: 404; plantilla desactivada: 409', async () => {
    repo.ctx = { kind: 'PATIENT_NOT_FOUND' };
    await expect(issue()).rejects.toThrow(NotFoundException);
    repo.ctx = { kind: 'APPOINTMENT_NOT_FOUND' };
    await expect(issue()).rejects.toThrow(
      'La cita no existe o no es de este paciente.',
    );
    repo.ctx = { kind: 'TEMPLATE_NOT_FOUND' };
    await expect(issue()).rejects.toThrow(NotFoundException);
    repo.ctx = {
      kind: 'OK',
      context: context({ template: { id: 't1', active: false } }),
    };
    await expect(issue()).rejects.toThrow(ConflictException);
  });

  it('la sede de la orden no permitida: 403 antes de nada más', async () => {
    allowed = [OTRA_SEDE];
    await expect(issue()).rejects.toThrow(ForbiddenException);
    expect(repo.issued).toHaveLength(0);
  });

  it('si la transacción falla, borra el PDF guardado', async () => {
    const first = await issue();
    jest.spyOn(repo, 'issue').mockImplementationOnce(async (input, archive) => {
      await archive({ ...first, ...input.content });
      throw new Error('fallo de BD');
    });
    await expect(issue()).rejects.toThrow('fallo de BD');
    expect(storage.save).toHaveBeenCalledTimes(2);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('recepción ve la lista y el detalle sin la nota (null + bandera) y reimprime sin ella; withNote es 403', async () => {
    const order = await issue();
    const [listed] = await run(() => useCases.listForPatient('p1', reception));
    expect(listed).toMatchObject({
      clinicalNote: null,
      clinicalNoteHidden: true,
    });
    await expect(
      run(() => useCases.get(order.id, reception)),
    ).resolves.toMatchObject({ clinicalNote: null });
    await run(() => useCases.pdf(order.id, false, reception));
    expect(rendered.at(-1)?.note).toBeNull();
    await expect(
      run(() => useCases.pdf(order.id, true, reception)),
    ).rejects.toThrow(ForbiddenException);
    // Un rol clínico sí la ve y la imprime.
    await run(() => useCases.pdf(order.id, true, assistant));
    expect(rendered.at(-1)?.note).toBe('Dolor a la percusión');
  });

  it('una orden de una sede no permitida no sale (404)', async () => {
    const order = await issue();
    allowed = [OTRA_SEDE];
    await expect(run(() => useCases.get(order.id, dentist))).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      run(() => useCases.listForPatient('p1', dentist)),
    ).resolves.toEqual([]);
  });

  it('anular: motivo 5–500, ADMIN o quien la emitió; dos veces 409', async () => {
    const order = await issue();
    await expect(
      run(() => useCases.void(order.id, 'Mal', dentist)),
    ).rejects.toThrow(BadRequestException);
    await expect(
      run(() => useCases.void(order.id, 'Estudio equivocado', reception)),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      run(() =>
        useCases.void(order.id, 'Estudio equivocado', {
          userId: 'otro',
          role: ClinicRole.DENTIST,
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    const voided = await run(() =>
      useCases.void(order.id, 'Estudio equivocado', admin),
    );
    expect(voided.status).toBe('VOIDED');
    expect(rendered.at(-1)?.voided?.stamp).toBe('ANULADA');
    expect(rendered.at(-1)?.note).toBeNull();
    await expect(
      run(() => useCases.void(order.id, 'Otra vez más', admin)),
    ).rejects.toThrow('La orden ya está anulada.');
  });

  it('con el resultado ligado no se anula (409): se desliga antes', async () => {
    const order = await issue();
    await run(() => useCases.linkResult(order.id, 'd1', reception));
    await expect(
      run(() => useCases.void(order.id, 'Estudio equivocado', admin)),
    ).rejects.toThrow(ConflictException);
  });

  it('ligar: los 4 roles; desligar: un clínico o quien lo ligó (403 a otra recepción)', async () => {
    const order = await issue();
    const linked = await run(() =>
      useCases.linkResult(order.id, 'd1', reception),
    );
    expect(linked).toMatchObject({
      status: 'RESULT_RECEIVED',
      resultDocumentId: 'd1',
      resultLinkedById: 'u-rec',
    });
    await expect(
      run(() => useCases.linkResult(order.id, 'd2', dentist)),
    ).rejects.toThrow(ConflictException);
    await expect(
      run(() =>
        useCases.unlinkResult(order.id, {
          userId: 'otra-recepcion',
          role: ClinicRole.RECEPTION,
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      run(() => useCases.unlinkResult(order.id, reception)),
    ).resolves.toMatchObject({ status: 'ISSUED', resultDocumentId: null });
    await expect(
      run(() => useCases.unlinkResult(order.id, assistant)),
    ).rejects.toThrow('La orden no tiene un resultado ligado.');
  });

  describe('«Órdenes sin resultado»', () => {
    it('de la sede pedida o la activa, con días civiles de la sede y vencida > N', async () => {
      await issue();
      repo.settings = { overdueDays: 14 };
      activeLocation = SEDE;
      const page = await run(() => useCases.pending({}, reception));
      // Emitida el 16/11 (Caracas), hoy 01/12: 15 días.
      expect(page).toMatchObject({ overdueDays: 14, total: 1, page: 1 });
      expect(page.items[0]).toMatchObject({ ageDays: 15, overdue: true });
      expect(page.items[0].order.clinicalNote).toBeNull();
      expect(repo.pendingQuery?.issuedBefore).toBeNull();
    });

    it('solo vencidas: emitidas antes del inicio del día (hoy − N) en la zona de la sede', async () => {
      await run(() =>
        useCases.pending(
          { locationId: SEDE, overdueOnly: true, page: 2, pageSize: 10 },
          dentist,
        ),
      );
      // Hoy 01/12 en Caracas, N = 15 → antes del 16/11 00:00 de Caracas.
      expect(repo.pendingQuery).toEqual({
        locationId: SEDE,
        issuedBefore: new Date('2026-11-16T04:00:00.000Z'),
        skip: 10,
        take: 10,
      });
    });

    it('sin sede pedida ni activa: 400; de una sede no permitida: 403', async () => {
      await expect(run(() => useCases.pending({}, dentist))).rejects.toThrow(
        BadRequestException,
      );
      allowed = [OTRA_SEDE];
      await expect(
        run(() => useCases.pending({ locationId: SEDE }, dentist)),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it('sugerencias de destinatario: plantillas primero, sin repetir (sin mayúsculas) y como mucho 10', async () => {
    repo.templates = ['Centro de Imagen del Este'];
    repo.recent = [
      'centro de imagen del este',
      'Laboratorio Clínico Central',
      ...Array.from({ length: 12 }, (_, i) => `Especialista ${i}`),
    ];
    const list = await run(() => useCases.recipients('  '));
    expect(list).toHaveLength(10);
    expect(list.slice(0, 2)).toEqual([
      { name: 'Centro de Imagen del Este', source: 'TEMPLATE' },
      { name: 'Laboratorio Clínico Central', source: 'RECENT' },
    ]);
  });
});

describe('ExternalOrderSettingsUseCases (DX-572)', () => {
  const ctx: AuditRequestContext = {
    tenantId: TENANT,
    locationId: SEDE,
    actor: { userId: 'u-admin', role: ClinicRole.ADMIN },
    requestId: 'r1',
    ip: null,
    userAgent: null,
  };

  it('valida 1–365 y audita solo si cambia, sin sede (CLINIC_SETTINGS · EXTERNAL_ORDER_SETTINGS)', async () => {
    const repo = new FakeRepo();
    const record = jest.fn().mockResolvedValue(undefined);
    const settings = new ExternalOrderSettingsUseCases(repo, {
      record,
    } as unknown as RecordAuditEventUseCase);
    await expect(settings.update({ overdueDays: 0 }, ctx)).rejects.toThrow(
      BadRequestException,
    );
    await settings.update({ overdueDays: 15 }, ctx);
    expect(record).not.toHaveBeenCalled();
    await expect(settings.update({ overdueDays: 30 }, ctx)).resolves.toEqual({
      overdueDays: 30,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        locationId: null,
        metadata: {
          reason: 'EXTERNAL_ORDER_SETTINGS',
          changedFields: ['overdueDays'],
        },
      }),
    );
  });
});
