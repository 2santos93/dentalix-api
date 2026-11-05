import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TreatmentPlanStatus } from '@prisma/client';
import {
  heicFixture,
  htmlFake,
  jpegFixture,
  pdfFixture,
  pngFixture,
  pngRenamedAsPdf,
  svgFake,
  webpFixture,
} from '../../../../test/support/document-fixtures';
import { referenceCurrencyDigitsCatalog } from '../../../shared/money/__fixtures__/reference-currency-digits';
import { RecordAuditEventUseCase } from '../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import type { ClinicPaymentMethodEntity } from '../../payment-methods/domain/payment-method.entity';
import type { PaymentMethodRepository } from '../../payment-methods/domain/ports/payment-method-repository.port';
import { PLAN_WITHOUT_OPTIONS } from '../../treatment-plans/application/use-cases/__fixtures__/in-memory-treatment-plan.repository';
import type { GetTreatmentPlanUseCase } from '../../treatment-plans/application/use-cases/get-treatment-plan.use-case';
import type { TreatmentPlanDetail } from '../../treatment-plans/domain/entities/treatment-plan.entity';
import {
  MAX_PAYMENT_PROOF_BYTES,
  PROOF_NOT_ALLOWED_MESSAGE,
  PROOF_ALREADY_USED_MESSAGE,
  PROOF_NOT_FOUND_MESSAGE,
  PROOF_REJECTED_CODE,
  PROOF_REQUIRED_MESSAGE,
  PROOF_TOO_LARGE_MESSAGE,
  PROOF_TYPE_MESSAGE,
} from '../domain/payment-proof';
import { PaymentMethodGate } from './payment-method-gate';
import { InMemoryPaymentRepository } from './use-cases/__fixtures__/in-memory-payment.repository';
import {
  PROOF_TENANT_ID,
  PROOF_USER,
  buildPaymentProofKit,
  sha256Of,
  type PaymentProofKit,
} from './__fixtures__/payment-proof-kit';
import { GetPaymentProofUrlUseCase } from './use-cases/get-payment-proof-url.use-case';
import { RecordPaymentUseCase } from './use-cases/record-payment.use-case';
import { RecordOpeningBalancePaymentUseCase } from './use-cases/record-opening-balance-payment.use-case';
import {
  EMPTY_FILE_MESSAGE,
  SIZE_MISMATCH_MESSAGE,
  UPLOAD_NOT_FOUND_MESSAGE,
} from '../../../shared/storage/pending-upload';
import { TYPE_MISMATCH_MESSAGE } from '../../../shared/storage/document-content';

const MB = 1024 * 1024;
const NOW = new Date('2026-11-04T15:00:00.000Z');

const MEDIUM = (
  id: string,
  proofPolicy: 'NONE' | 'OPTIONAL' | 'REQUIRED',
): ClinicPaymentMethodEntity => ({
  id,
  tenantId: 't1',
  name: `Medio ${id}`,
  kind: 'TRANSFER',
  active: true,
  requiresReference: false,
  proofPolicy,
  legacyMethod: null,
  adjustments: [],
  createdAt: NOW,
  updatedAt: NOW,
});
const MEDIUMS = [
  MEDIUM('m-none', 'NONE'),
  MEDIUM('m-opt', 'OPTIONAL'),
  MEDIUM('m-req', 'REQUIRED'),
];

function plan(): TreatmentPlanDetail {
  return {
    id: 'plan-1',
    tenantId: 't1',
    patientId: 'patient-1',
    status: TreatmentPlanStatus.DRAFT,
    currency: 'USD',
    notes: null,
    createdById: null,
    ...PLAN_WITHOUT_OPTIONS,
    createdAt: NOW,
    updatedAt: NOW,
    acceptance: null,
    items: [],
    total: 0,
  };
}

function build() {
  const repo = new InMemoryPaymentRepository();
  const kit = buildPaymentProofKit(repo);
  const uc = new RecordPaymentUseCase(
    repo,
    {
      execute: () => Promise.resolve(plan()),
    } as unknown as GetTreatmentPlanUseCase,
    { has: (c: string) => Promise.resolve(['USD', 'VES'].includes(c)) },
    {
      afterPayment: () => Promise.resolve(null),
    } as unknown as import('./receipts/receipt-plan-balance').ReceiptPlanBalanceCalculator,
    {
      execute: () => Promise.reject(new Error('sin conversión en vivo')),
      quote: () => Promise.reject(new Error('sin tasa')),
    } as unknown as ConvertAmountUseCase,
    new PaymentMethodGate(
      {
        findById: (id: string) =>
          Promise.resolve(MEDIUMS.find((m) => m.id === id) ?? null),
        findByLegacyMethod: () => Promise.resolve(null),
      } as unknown as PaymentMethodRepository,
      repo,
      referenceCurrencyDigitsCatalog(),
    ),
    kit.proofs,
    () => NOW,
  );
  return { repo, kit, uc };
}

const pay = (
  uc: RecordPaymentUseCase,
  kit: PaymentProofKit,
  extra: { paymentMethodId: string; proofUploadId?: string },
) =>
  kit.inTenant(() =>
    uc.execute(
      'plan-1',
      { amount: 50, currency: 'USD', paidAt: '2026-11-04', ...extra },
      PROOF_USER,
    ),
  );

describe('autorizar la subida del comprobante (DX-389)', () => {
  const ask = (
    kit: PaymentProofKit,
    patch: Record<string, unknown> = {},
    bytes = pngFixture(),
  ) =>
    kit.inTenant(() =>
      kit.uploads.authorize(
        {
          name: 'captura.png',
          mimeType: 'image/png',
          size: bytes.length,
          sha256: sha256Of(bytes),
          ...patch,
        },
        PROOF_USER,
      ),
    );

  it('el tope es 10 MB y la clave pendiente cuelga de payment-proofs/pending', async () => {
    const { kit } = build();
    const ticket = await ask(kit);
    expect(ticket.maxBytes).toBe(10 * MB);
    const [key, policy] = [...kit.storage.directUploads.entries()][0];
    expect(key).toMatch(
      new RegExp(`^payment-proofs/pending/[0-9a-f-]{36}/${ticket.uploadId}$`),
    );
    expect(policy.maxBytes).toBe(10 * MB);
    expect(policy.metadata['uploaded-by']).toBe(PROOF_USER);
  });

  it.each([
    ['más de 10 MB', { size: 10 * MB + 1 }, PROOF_TOO_LARGE_MESSAGE],
    ['tamaño 0', { size: 0 }, EMPTY_FILE_MESSAGE],
    [
      'HEIC declarado',
      { mimeType: 'image/heic', name: 'f.heic' },
      PROOF_TYPE_MESSAGE,
    ],
    [
      'SVG declarado',
      { mimeType: 'image/svg+xml', name: 'f.svg' },
      PROOF_TYPE_MESSAGE,
    ],
  ])('rechaza %s con 400 en español', async (_n, patch, message) => {
    const { kit } = build();
    await expect(ask(kit, patch)).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(kit.storage.directUploads.size).toBe(0);
  });

  it('exactamente 10 MB se autoriza', async () => {
    const { kit } = build();
    await expect(
      ask(kit, { size: MAX_PAYMENT_PROOF_BYTES }),
    ).resolves.toBeDefined();
  });
});

describe('abono con comprobante (DX-389)', () => {
  it.each([
    ['PNG', pngFixture(), 'captura.png', 'image/png', 'png'],
    ['JPG', jpegFixture(), 'captura.jpg', 'image/jpeg', 'jpg'],
    ['WebP', webpFixture(), 'captura.webp', 'image/webp', 'webp'],
    ['PDF', pdfFixture(), 'pago.pdf', 'application/pdf', 'pdf'],
  ])(
    'guarda el comprobante %s con el abono y lo mueve a su clave definitiva',
    async (_n, bytes, name, mimeType, ext) => {
      const { repo, kit, uc } = build();
      const uploadId = await kit.upload(bytes, { name, mimeType });
      const payment = await pay(uc, kit, {
        paymentMethodId: 'm-opt',
        proofUploadId: uploadId,
      });
      expect(payment.hasProof).toBe(true);
      const proof = repo.lastCreateInput?.proof;
      expect(proof).toMatchObject({
        mime: mimeType,
        size: bytes.length,
        sha256: sha256Of(bytes),
        name,
      });
      // Clave definitiva: solo ids y huella; nada del nombre original.
      expect(proof?.key).toMatch(
        new RegExp(
          `^payment-proofs/[0-9a-f-]{36}/[0-9a-f-]{36}-[0-9a-f]{16}\\.${ext}$`,
        ),
      );
      expect(proof?.key).not.toContain('captura');
      expect(kit.storage.files.has(proof!.key)).toBe(true);
      // El pendiente se descarta cuando el abono ya existe.
      await Promise.resolve();
      expect(
        [...kit.storage.files.keys()].some((k) => k.includes('/pending/')),
      ).toBe(false);
    },
  );

  it('sin comprobante, un medio OPTIONAL registra igual (hasProof false)', async () => {
    const { kit, uc } = build();
    const payment = await pay(uc, kit, { paymentMethodId: 'm-opt' });
    expect(payment.hasProof).toBe(false);
  });

  it('REQUIRED sin comprobante es 400 en español y no registra nada', async () => {
    const { repo, kit, uc } = build();
    await expect(pay(uc, kit, { paymentMethodId: 'm-req' })).rejects.toThrow(
      new BadRequestException(PROOF_REQUIRED_MESSAGE),
    );
    expect(repo.lastCreateInput).toBeNull();
  });

  it('REQUIRED con comprobante registra', async () => {
    const { kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    const payment = await pay(uc, kit, {
      paymentMethodId: 'm-req',
      proofUploadId: uploadId,
    });
    expect(payment.hasProof).toBe(true);
  });

  it('NONE con comprobante es 400 y deja el pendiente sin tocar', async () => {
    const { repo, kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    await expect(
      pay(uc, kit, { paymentMethodId: 'm-none', proofUploadId: uploadId }),
    ).rejects.toThrow(new BadRequestException(PROOF_NOT_ALLOWED_MESSAGE));
    expect(repo.lastCreateInput).toBeNull();
  });

  describe('validación por contenido', () => {
    it.each([
      [
        'HTML disfrazado de PNG',
        htmlFake(),
        { name: 'x.png', mimeType: 'image/png' },
        PROOF_TYPE_MESSAGE,
      ],
      [
        'SVG disfrazado de PNG',
        svgFake(),
        { name: 'x.png', mimeType: 'image/png' },
        PROOF_TYPE_MESSAGE,
      ],
      [
        'HEIC con nombre .jpg',
        heicFixture(),
        { name: 'x.jpg', mimeType: '' },
        PROOF_TYPE_MESSAGE,
      ],
      [
        'PNG llamado .pdf',
        pngRenamedAsPdf().bytes,
        { name: 'x.pdf', mimeType: 'application/pdf' },
        TYPE_MISMATCH_MESSAGE,
      ],
    ])(
      '%s es 400 y se borra el objeto',
      async (_n, bytes, declared, message) => {
        const { repo, kit, uc } = build();
        const uploadId = await kit.upload(bytes, declared);
        await expect(
          pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
        ).rejects.toMatchObject({
          response: { code: PROOF_REJECTED_CODE, message },
        });
        expect(repo.lastCreateInput).toBeNull();
        expect(kit.storage.files.size).toBe(0);
      },
    );

    it('un objeto subido más grande de lo declarado es 400', async () => {
      const { kit, uc } = build();
      const small = pngFixture();
      const ticket = await kit.inTenant(() =>
        kit.uploads.authorize(
          {
            name: 'a.png',
            mimeType: 'image/png',
            size: small.length + 5,
            sha256: sha256Of(small),
          },
          PROOF_USER,
        ),
      );
      const key = [...kit.storage.directUploads.keys()][0];
      kit.storage.simulateDirectUpload(key, small);
      await expect(
        pay(uc, kit, {
          paymentMethodId: 'm-opt',
          proofUploadId: ticket.uploadId,
        }),
      ).rejects.toThrow(new BadRequestException(SIZE_MISMATCH_MESSAGE));
    });

    it('la subida de otro usuario o inexistente es 404 sin tocarla', async () => {
      const { kit, uc } = build();
      const uploadId = await kit.upload(
        pngFixture(),
        undefined,
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      );
      const before = kit.storage.files.size;
      await expect(
        pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
      ).rejects.toThrow(new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE));
      expect(kit.storage.files.size).toBe(before);
      await expect(
        pay(uc, kit, {
          paymentMethodId: 'm-opt',
          proofUploadId: '99999999-9999-4999-8999-999999999999',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('si el alta falla, la copia sin fila se borra y el pendiente queda para reintentar', async () => {
    const { repo, kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    jest.spyOn(repo, 'create').mockRejectedValueOnce(new Error('boom'));
    await expect(
      pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
    ).rejects.toThrow('boom');
    const keys = [...kit.storage.files.keys()];
    expect(keys.filter((k) => !k.includes('/pending/'))).toEqual([]);
    expect(keys.filter((k) => k.includes('/pending/'))).toHaveLength(1);
    // El reintento con la misma subida funciona.
    const payment = await pay(uc, kit, {
      paymentMethodId: 'm-opt',
      proofUploadId: uploadId,
    });
    expect(payment.hasProof).toBe(true);
  });
});

describe('ver o descargar el comprobante (DX-389)', () => {
  const ctx = (): AuditRequestContext =>
    ({
      tenantId: 't1',
      locationId: null,
      actor: { userId: PROOF_USER, role: 'RECEPTION' },
      requestId: 'req-1',
      ip: '127.0.0.1',
      userAgent: 'jest',
    }) as unknown as AuditRequestContext;

  async function withProof() {
    const { repo, kit, uc } = build();
    const uploadId = await kit.upload(pngFixture(), {
      name: 'Captura Pérez María.png',
      mimeType: 'image/png',
    });
    const payment = await pay(uc, kit, {
      paymentMethodId: 'm-opt',
      proofUploadId: uploadId,
    });
    const events: AuditEventDraft[] = [];
    const audit = {
      record: (e: AuditEventDraft) => {
        events.push(e);
        return Promise.resolve();
      },
    } as unknown as RecordAuditEventUseCase;
    const url = new GetPaymentProofUrlUseCase(
      repo,
      kit.storage,
      audit,
      () => NOW,
      300,
      kit.tenant,
    );
    return { repo, kit, payment, url, events };
  }

  it('inline audita VIEW y attachment audita EXPORT, sin datos del paciente en la metadata', async () => {
    const { payment, url, events } = await withProof();
    const inline = await url.execute(payment.id, 'inline', ctx());
    expect(inline).toMatchObject({
      disposition: 'inline',
      mime: 'image/png',
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    });
    await url.execute(payment.id, 'attachment', ctx());
    expect(events.map((e) => e.action)).toEqual(['VIEW', 'EXPORT']);
    expect(events[0]).toMatchObject({
      resourceType: 'PAYMENT',
      resourceId: payment.id,
      metadata: { reason: 'PAYMENT_PROOF_VIEW' },
    });
    expect(events[1].metadata).toEqual({ reason: 'PAYMENT_PROOF_DOWNLOAD' });
    expect(JSON.stringify(events)).not.toMatch(/Pérez|Maria|María/);
  });

  it('un abono sin comprobante o inexistente es 404', async () => {
    const { repo, kit, url } = await withProof();
    const bare = repo.seedPayment({ id: 'sin-comprobante' });
    await expect(url.execute(bare.id, 'inline', ctx())).rejects.toThrow(
      new NotFoundException(PROOF_NOT_FOUND_MESSAGE),
    );
    await expect(url.execute('no-existe', 'inline', ctx())).rejects.toThrow(
      NotFoundException,
    );
    expect(kit.storage.files.size).toBeGreaterThan(0);
  });
});

describe('abono al saldo migrado con comprobante (DX-389)', () => {
  function buildBalance() {
    const repo = new InMemoryPaymentRepository();
    repo.openingBalances.set('ob-1', {
      id: 'ob-1',
      patientId: 'pat-1',
      currency: 'VES',
      amount: 150000,
    });
    const kit = buildPaymentProofKit(repo);
    const uc = new RecordOpeningBalancePaymentUseCase(
      repo,
      { has: (c: string) => Promise.resolve(c === 'VES') },
      new PaymentMethodGate(
        {
          findById: (id: string) =>
            Promise.resolve(MEDIUMS.find((m) => m.id === id) ?? null),
          findByLegacyMethod: () => Promise.resolve(null),
        } as unknown as PaymentMethodRepository,
        repo,
        referenceCurrencyDigitsCatalog(),
      ),
      kit.proofs,
      () => NOW,
    );
    const run = (extra: { paymentMethodId: string; proofUploadId?: string }) =>
      kit.inTenant(() =>
        uc.execute(
          'ob-1',
          { amount: 1000, currency: 'VES', paidAt: '2026-11-04', ...extra },
          PROOF_USER,
        ),
      );
    return { repo, kit, run };
  }

  it('REQUIRED sin comprobante es 400; con comprobante lo guarda', async () => {
    const { repo, kit, run } = buildBalance();
    await expect(run({ paymentMethodId: 'm-req' })).rejects.toThrow(
      new BadRequestException(PROOF_REQUIRED_MESSAGE),
    );
    expect(repo.lastCreateInput).toBeNull();
    const uploadId = await kit.upload(webpFixture(), {
      name: 'c.webp',
      mimeType: 'image/webp',
    });
    const payment = await run({
      paymentMethodId: 'm-req',
      proofUploadId: uploadId,
    });
    expect(payment.hasProof).toBe(true);
    expect(repo.lastCreateInput?.proof?.mime).toBe('image/webp');
  });
});

describe('revisión DX-389 (ronda 1)', () => {
  const PAYMENT_KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  // --- L4 / H1: la sede del abono manda para ver su comprobante ---
  describe('sede del abono (H1, DX-089)', () => {
    async function withProofIn() {
      const { repo, kit, uc } = build();
      const uploadId = await kit.upload(pngFixture());
      const payment = await pay(uc, kit, {
        paymentMethodId: 'm-opt',
        proofUploadId: uploadId,
      });
      const events: AuditEventDraft[] = [];
      const audit = {
        record: (e: AuditEventDraft) => {
          events.push(e);
          return Promise.resolve();
        },
      } as unknown as RecordAuditEventUseCase;
      const url = new GetPaymentProofUrlUseCase(
        repo,
        kit.storage,
        audit,
        () => NOW,
        300,
        kit.tenant,
      );
      const sign = jest.spyOn(kit.storage, 'getSignedUrl');
      const ctx = {
        tenantId: 't1',
        locationId: null,
        actor: { userId: PROOF_USER, role: 'RECEPTION' },
        requestId: 'r',
        ip: null,
        userAgent: null,
      } as unknown as AuditRequestContext;
      return { kit, payment, url, events, sign, ctx };
    }

    it('un miembro restringido a otras sedes: 403 antes de firmar y sin auditar', async () => {
      const { kit, payment, url, events, sign, ctx } = await withProofIn();
      // El abono del fake es de la sede `loc-1`.
      await expect(
        kit.tenant.run(
          PROOF_TENANT_ID,
          undefined,
          () => url.execute(payment.id, 'inline', ctx),
          ['loc-2'],
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(sign).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('con su sede (o sin restricción) lo ve', async () => {
      const { kit, payment, url, ctx } = await withProofIn();
      await expect(
        kit.tenant.run(
          PROOF_TENANT_ID,
          undefined,
          () => url.execute(payment.id, 'inline', ctx),
          ['loc-1'],
        ),
      ).resolves.toMatchObject({ disposition: 'inline' });
      await expect(
        kit.inTenant(() => url.execute(payment.id, 'attachment', ctx)),
      ).resolves.toMatchObject({ disposition: 'attachment' });
    });
  });

  // --- L1: una subida respalda un solo abono ---
  it('reusar la subida de un abono ya registrado: 404 (el pendiente se consumió)', async () => {
    const { kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    await pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId });
    await expect(
      pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
    ).rejects.toThrow(new NotFoundException(UPLOAD_NOT_FOUND_MESSAGE));
  });

  it('si la BD dice que la subida ya respalda otro abono (carrera), 400 en español y no queda la copia', async () => {
    const { repo, kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    jest
      .spyOn(repo, 'create')
      .mockRejectedValueOnce(
        new BadRequestException(PROOF_ALREADY_USED_MESSAGE),
      );
    await expect(
      pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
    ).rejects.toThrow(new BadRequestException(PROOF_ALREADY_USED_MESSAGE));
    expect(
      [...kit.storage.files.keys()].filter((k) => !k.includes('/pending/')),
    ).toEqual([]);
  });

  // --- L2: la limpieza no tapa el error original ---
  it('si falla el alta Y la limpieza, el error es el del alta y la copia se intenta borrar igual', async () => {
    const { repo, kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    jest.spyOn(repo, 'create').mockRejectedValueOnce(new Error('alta rota'));
    jest
      .spyOn(repo, 'proofKeyInUse')
      .mockRejectedValueOnce(new Error('BD caída'));
    await expect(
      pay(uc, kit, { paymentMethodId: 'm-opt', proofUploadId: uploadId }),
    ).rejects.toThrow('alta rota');
    expect(
      [...kit.storage.files.keys()].filter((k) => !k.includes('/pending/')),
    ).toEqual([]);
  });

  it('si el borrado del pendiente falla tras registrar, el abono sigue siendo correcto', async () => {
    const { kit, uc } = build();
    const uploadId = await kit.upload(pngFixture());
    jest
      .spyOn(kit.storage, 'delete')
      .mockRejectedValue(new Error('bucket caído'));
    const payment = await pay(uc, kit, {
      paymentMethodId: 'm-opt',
      proofUploadId: uploadId,
    });
    expect(payment.hasProof).toBe(true);
  });

  // --- L3 / L4: idempotencia con comprobante ---
  describe('Idempotency-Key con comprobante', () => {
    const payWithKey = (
      uc: RecordPaymentUseCase,
      kit: PaymentProofKit,
      proofUploadId: string,
    ) =>
      kit.inTenant(() =>
        uc.execute(
          'plan-1',
          {
            amount: 50,
            currency: 'USD',
            paidAt: '2026-11-04',
            paymentMethodId: 'm-opt',
            proofUploadId,
          },
          PROOF_USER,
          PAYMENT_KEY,
        ),
      );

    it('repetir la MISMA petición devuelve el abono original: un solo abono, una sola copia', async () => {
      const { repo, kit, uc } = build();
      const uploadId = await kit.upload(pngFixture());
      const first = await payWithKey(uc, kit, uploadId);
      const filesAfterFirst = kit.storage.files.size;
      const spy = jest.spyOn(repo, 'create');
      const again = await payWithKey(uc, kit, uploadId);
      expect(again.id).toBe(first.id);
      expect(spy).not.toHaveBeenCalled();
      expect(kit.storage.files.size).toBe(filesAfterFirst);
    });

    it('la misma clave con OTRO comprobante es 422, no el abono original sin él', async () => {
      const { kit, uc } = build();
      const first = await kit.upload(pngFixture());
      await payWithKey(uc, kit, first);
      const other = await kit.upload(pngFixture());
      await expect(payWithKey(uc, kit, other)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  // --- L5: sin medio resuelto el comprobante se admite como OPTIONAL ---
  it('un abono sin medio ni método admite comprobante (OPTIONAL) y no lo exige', async () => {
    const { repo, kit, uc } = build();
    const bare = await kit.inTenant(() =>
      uc.execute(
        'plan-1',
        { amount: 50, currency: 'USD', paidAt: '2026-11-04' },
        PROOF_USER,
      ),
    );
    expect(bare.hasProof).toBe(false);
    const uploadId = await kit.upload(pngFixture());
    const withProof = await kit.inTenant(() =>
      uc.execute(
        'plan-1',
        {
          amount: 50,
          currency: 'USD',
          paidAt: '2026-11-04',
          proofUploadId: uploadId,
        },
        PROOF_USER,
      ),
    );
    expect(withProof.hasProof).toBe(true);
    expect(repo.lastCreateInput?.proof?.mime).toBe('image/png');
  });
});
