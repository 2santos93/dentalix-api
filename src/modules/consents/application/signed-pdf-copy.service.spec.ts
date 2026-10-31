import {
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import type {
  ClinicBranding,
  ConsumeSignedPdfCopyOutcome,
  IssueSignedPdfCopyLinkInput,
  SignedConsentPdfBackfillRepository,
  SignedPdfCopyLinkRow,
  SignedPdfCopyRepository,
  SignedPdfCopyTarget,
} from '../domain/ports/signed-pdf-copy-repository.port';
import {
  SIGNED_PDF_COPY_USED_CODE,
  hashSignedPdfCopyToken,
} from '../domain/signed-pdf-copy-link';
import type { SignedConsentCopyEmailVars } from '../../notifications/email/domain/email-message';
import {
  BackfillSignedConsentPdfs,
  DownloadSignedPdfCopyUseCase,
  GetPublicSignedPdfCopyUseCase,
  ResendSignedPdfCopyUseCase,
  SendSignedPdfCopyJob,
  SignedPdfCopySender,
  type SignedPdfCopyEmailSender,
} from './signed-pdf-copy.service';

const NOW = new Date('2026-10-31T13:00:00.000Z');
const META: AuditRequestMeta = {
  requestId: 'req-1',
  ip: '203.0.113.7',
  userAgent: 'test',
};
const TOKEN = 'A'.repeat(43);
const CONSENT = '6b1f2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';

function target(over: Partial<SignedPdfCopyTarget> = {}): SignedPdfCopyTarget {
  return {
    consentId: 'c1',
    patientId: 'p1',
    ready: true,
    notifyPatient: true,
    destination: 'marta@example.com',
    destinationMasked: 'ma***@example.com',
    signerType: 'GUARDIAN',
    signerName: 'Marta Ruiz',
    patientFirstName: 'Lucía',
    clinicName: 'Sonrisas del Norte',
    location: {
      id: 'loc-1',
      timeZone: 'America/Bogota',
      locale: 'es-CO',
      hourCycle: 'h12',
    },
    ...over,
  };
}

class FakeRepo implements SignedPdfCopyRepository {
  target: SignedPdfCopyTarget | null = target();
  issued: (IssueSignedPdfCopyLinkInput & { id: string })[] = [];
  links = new Map<string, SignedPdfCopyLinkRow>();
  consumeOutcome: ConsumeSignedPdfCopyOutcome = {
    kind: 'CONSUMED',
    download: {
      storageKey: 't/doc.pdf',
      originalName: 'Consentimiento firmado - Exodoncia.pdf',
      mimeType: 'application/pdf',
    },
  };
  consumed: { linkId: string; meta: AuditRequestMeta }[] = [];
  loadArgs: (string | undefined)[][] = [];

  loadTarget(consentId: string, patientId?: string) {
    this.loadArgs.push([consentId, patientId]);
    return Promise.resolve(this.target);
  }
  issueLink(input: IssueSignedPdfCopyLinkInput) {
    const id = `link-${this.issued.length + 1}`;
    this.issued.push({ ...input, id });
    return Promise.resolve({ id });
  }
  findLinkByTokenHash(hash: string) {
    return Promise.resolve(this.links.get(hash) ?? null);
  }
  consumeLink(linkId: string, _now: Date, meta: AuditRequestMeta) {
    this.consumed.push({ linkId, meta });
    return Promise.resolve(this.consumeOutcome);
  }
  findClinicBranding(): Promise<ClinicBranding | null> {
    return Promise.resolve({
      name: 'Sonrisas del Norte',
      primaryColor: null,
      logoUrl: null,
    });
  }
}

function setup(opts: { base?: string | null; tenantId?: string | null } = {}) {
  const repo = new FakeRepo();
  const emails: {
    to: string;
    referenceId: string;
    vars: SignedConsentCopyEmailVars;
  }[] = [];
  const quotaChecks: string[] = [];
  const email: SignedPdfCopyEmailSender & { quotaError: Error | null } = {
    quotaError: null,
    assertCanSend(to) {
      quotaChecks.push(to);
      return this.quotaError
        ? Promise.reject(this.quotaError)
        : Promise.resolve();
    },
    send(input) {
      emails.push(input);
      return Promise.resolve();
    },
  };
  const linkBaseCalls: (string | undefined)[][] = [];
  const linkBase = {
    forTenant: (tenantId: string, host?: string) => {
      linkBaseCalls.push([tenantId, host]);
      return Promise.resolve(
        opts.base === undefined ? 'https://demo.dentalix.app' : opts.base,
      );
    },
  };
  const tenantId = opts.tenantId === undefined ? 't1' : opts.tenantId;
  const tenantContext = { getTenantId: () => tenantId ?? undefined };
  const config = { ttlHours: 48 };
  const clock = () => NOW;
  const sender = new SignedPdfCopySender(
    repo,
    email,
    linkBase,
    tenantContext,
    config,
    clock,
  );
  const signedUrls: unknown[][] = [];
  const storage = {
    getSignedUrl: (...args: unknown[]) => {
      signedUrls.push(args);
      return Promise.resolve('https://api.example/files/signed?x=1');
    },
  };
  return {
    repo,
    emails,
    quotaChecks,
    email,
    linkBaseCalls,
    signedUrls,
    job: new SendSignedPdfCopyJob(repo, sender),
    resend: new ResendSignedPdfCopyUseCase(repo, sender, email),
    get: new GetPublicSignedPdfCopyUseCase(repo, tenantContext, clock),
    download: new DownloadSignedPdfCopyUseCase(
      repo,
      tenantContext,
      clock,
      storage,
    ),
  };
}

describe('copia del PDF firmado al paciente (DX-443)', () => {
  describe('envío automático al quedar READY', () => {
    it('crea un enlace (solo el hash) y envía el email sin nada clínico a quien firmó', async () => {
      const ctx = setup();
      await ctx.job.handle({ consentId: CONSENT });

      expect(ctx.repo.issued).toHaveLength(1);
      const link = ctx.repo.issued[0];
      expect(link).toMatchObject({
        consentId: 'c1',
        patientId: 'p1',
        createdById: null,
        now: NOW,
        expiresAt: new Date('2026-11-02T13:00:00.000Z'),
      });
      expect(ctx.emails).toHaveLength(1);
      const sent = ctx.emails[0];
      expect(sent.to).toBe('marta@example.com');
      expect(sent.referenceId).toBe('link-1');
      const token = sent.vars.url.split('/copia/')[1];
      expect(sent.vars.url).toBe(`https://demo.dentalix.app/copia/${token}`);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      // Lo guardado es el hash, nunca el token.
      expect(link.tokenHash).toBe(hashSignedPdfCopyToken(token));
      expect(JSON.stringify(ctx.repo.issued)).not.toContain(token);
      expect(sent.vars).toEqual({
        recipientFirstName: 'Marta',
        patientFirstName: 'Lucía',
        clinicName: 'Sonrisas del Norte',
        url: sent.vars.url,
        expiresAtLabel: expect.stringContaining('2026') as string,
      });
      // El envío automático no consume el tope del reenvío manual.
      expect(ctx.quotaChecks).toEqual([]);
      expect(ctx.linkBaseCalls).toEqual([['t1', undefined]]);
    });

    it('al propio paciente no lo nombra como «en nombre de»', async () => {
      const ctx = setup();
      ctx.repo.target = target({
        signerType: 'PATIENT',
        signerName: 'Laura Castro',
        patientFirstName: 'Laura',
      });
      await ctx.job.handle({ consentId: CONSENT });
      expect(ctx.emails[0].vars).toMatchObject({
        recipientFirstName: 'Laura',
        patientFirstName: null,
      });
    });

    it('no envía nada si el PDF es del barrido retroactivo, no está listo o no existe', async () => {
      for (const t of [
        target({ notifyPatient: false }),
        target({ ready: false }),
        null,
      ]) {
        const ctx = setup();
        ctx.repo.target = t;
        await ctx.job.handle({ consentId: CONSENT });
        expect(ctx.repo.issued).toEqual([]);
        expect(ctx.emails).toEqual([]);
      }
    });

    it('sin un host seguro para el enlace no crea enlace ni email (y no reintenta)', async () => {
      const ctx = setup({ base: null });
      await ctx.job.handle({ consentId: CONSENT });
      expect(ctx.repo.issued).toEqual([]);
      expect(ctx.emails).toEqual([]);
    });

    it('rechaza un payload sin uuid', async () => {
      const ctx = setup();
      await expect(ctx.job.handle({ consentId: 'x' })).rejects.toThrow(
        /payload inválido/,
      );
    });
  });

  describe('«Reenviar copia»', () => {
    const uuid = '0f9c2b1e-1d2c-4e5f-8a9b-0c1d2e3f4a5b';

    it('genera un enlace nuevo a nombre de quien reenvía y lo envía', async () => {
      const ctx = setup();
      const result = await ctx.resend.execute(
        'p1',
        uuid,
        'u1',
        'demo.localhost:3000',
      );
      expect(ctx.repo.loadArgs).toEqual([[uuid, 'p1']]);
      expect(ctx.quotaChecks).toEqual(['marta@example.com']);
      expect(ctx.repo.issued).toHaveLength(1);
      expect(ctx.repo.issued[0]).toMatchObject({ createdById: 'u1' });
      expect(ctx.emails).toHaveLength(1);
      expect(ctx.linkBaseCalls).toEqual([['t1', 'demo.localhost:3000']]);
      expect(result).toEqual({
        sentAt: NOW,
        expiresAt: new Date('2026-11-02T13:00:00.000Z'),
        destinationMasked: 'ma***@example.com',
      });
    });

    it('404 si el consentimiento no es de este paciente en esta clínica', async () => {
      const ctx = setup();
      ctx.repo.target = null;
      await expect(ctx.resend.execute('p1', uuid, 'u1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(ctx.repo.issued).toEqual([]);
    });

    it('409 si el PDF aún no está archivado', async () => {
      const ctx = setup();
      ctx.repo.target = target({ ready: false });
      await expect(ctx.resend.execute('p1', uuid, 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.repo.issued).toEqual([]);
    });

    it('el tope de emails frena ANTES de invalidar el enlace anterior', async () => {
      const ctx = setup();
      ctx.email.quotaError = new HttpException('Espera', 429);
      await expect(ctx.resend.execute('p1', uuid, 'u1')).rejects.toThrow(
        'Espera',
      );
      expect(ctx.repo.issued).toEqual([]);
      expect(ctx.emails).toEqual([]);
    });

    it('sin host seguro para el enlace: 409 y nada cambia', async () => {
      const ctx = setup({ base: null });
      await expect(ctx.resend.execute('p1', uuid, 'u1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(ctx.repo.issued).toEqual([]);
    });
  });

  describe('página pública', () => {
    const hash = hashSignedPdfCopyToken(TOKEN);
    const live: SignedPdfCopyLinkRow = {
      id: 'link-1',
      consentId: 'c1',
      patientId: 'p1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      usedAt: null,
      revokedAt: null,
    };

    it('abrir el enlace solo lee: disponible, con la marca de la clínica', async () => {
      const ctx = setup();
      ctx.repo.links.set(hash, live);
      await expect(ctx.get.execute(TOKEN)).resolves.toEqual({
        state: 'AVAILABLE',
        message: expect.any(String) as string,
        clinic: {
          name: 'Sonrisas del Norte',
          primaryColor: null,
          logoUrl: null,
        },
        expiresAt: live.expiresAt,
      });
      expect(ctx.repo.consumed).toEqual([]);
    });

    it('usado: «enlace usado»', async () => {
      const ctx = setup();
      ctx.repo.links.set(hash, { ...live, usedAt: NOW });
      await expect(ctx.get.execute(TOKEN)).resolves.toMatchObject({
        state: 'USED',
        message: 'Este enlace ya se usó',
      });
    });

    it('inventado, mal formado, caducado, invalidado o sin clínica: el mismo 404', async () => {
      const cases: [string, SignedPdfCopyLinkRow | null, string | null][] = [
        [TOKEN, null, 't1'],
        ['corto', live, 't1'],
        [TOKEN, { ...live, expiresAt: NOW }, 't1'],
        [TOKEN, { ...live, revokedAt: NOW }, 't1'],
        [TOKEN, live, null],
      ];
      for (const [token, row, tenantId] of cases) {
        const ctx = setup({ tenantId });
        if (row) ctx.repo.links.set(hash, row);
        await expect(ctx.get.execute(token)).rejects.toThrow(
          new NotFoundException('El enlace no existe o ya no es válido.'),
        );
        await expect(ctx.download.execute(token, META)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(ctx.repo.consumed).toEqual([]);
      }
    });

    it('descargar gasta el enlace y devuelve una URL firmada de corta vida del PDF', async () => {
      const ctx = setup();
      ctx.repo.links.set(hash, live);
      const result = await ctx.download.execute(TOKEN, META);
      expect(ctx.repo.consumed).toEqual([{ linkId: 'link-1', meta: META }]);
      expect(ctx.signedUrls).toEqual([
        [
          't/doc.pdf',
          60,
          {
            disposition: 'attachment',
            filename: 'Consentimiento firmado - Exodoncia.pdf',
            contentType: 'application/pdf',
          },
        ],
      ]);
      expect(result).toEqual({
        url: 'https://api.example/files/signed?x=1',
        expiresAt: new Date(NOW.getTime() + 60_000),
        fileName: 'Consentimiento firmado - Exodoncia.pdf',
      });
    });

    it('la segunda descarga responde «enlace usado» (410) sin URL', async () => {
      const ctx = setup();
      ctx.repo.links.set(hash, { ...live, usedAt: NOW });
      const error = await ctx.download
        .execute(TOKEN, META)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GoneException);
      expect((error as GoneException).getResponse()).toMatchObject({
        code: SIGNED_PDF_COPY_USED_CODE,
      });
      expect(ctx.repo.consumed).toEqual([]);
      expect(ctx.signedUrls).toEqual([]);
    });

    it('si otra descarga ganó la carrera: 410; si caducó en medio: 404', async () => {
      const ctx = setup();
      ctx.repo.links.set(hash, live);
      ctx.repo.consumeOutcome = { kind: 'USED' };
      await expect(ctx.download.execute(TOKEN, META)).rejects.toBeInstanceOf(
        GoneException,
      );
      ctx.repo.consumeOutcome = { kind: 'GONE' };
      await expect(ctx.download.execute(TOKEN, META)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(ctx.signedUrls).toEqual([]);
    });
  });
});

describe('barrido retroactivo de PDF firmados (DX-443)', () => {
  function backfillSetup(failing: string[] = []) {
    const calls: { tenantId: string; limit: number; keys: string[] }[] = [];
    const repo: SignedConsentPdfBackfillRepository = {
      tenantIds: () => Promise.resolve(['t1', 't2', 't3']),
      backfill: async (tenantId, limit, enqueue) => {
        if (failing.includes(tenantId)) throw new Error('boom');
        const keys: string[] = [];
        const tx = {} as Prisma.TransactionClient;
        await enqueue(tx, `${tenantId}-c1`);
        keys.push(`${tenantId}-c1`);
        calls.push({ tenantId, limit, keys });
        return keys.length;
      },
    };
    const enqueued: string[] = [];
    const queue = {
      schedule: (_tx: Prisma.TransactionClient, consentId: string) => {
        enqueued.push(consentId);
        return Promise.resolve();
      },
    };
    return {
      calls,
      enqueued,
      sweep: new BackfillSignedConsentPdfs(repo, queue),
    };
  }

  it('recorre las clínicas por lotes y encola la generación con la clave de siempre', async () => {
    const ctx = backfillSetup();
    await expect(ctx.sweep.run()).resolves.toEqual({ queued: 3 });
    expect(ctx.calls.map((c) => [c.tenantId, c.limit])).toEqual([
      ['t1', 100],
      ['t2', 100],
      ['t3', 100],
    ]);
    expect(ctx.enqueued).toEqual(['t1-c1', 't2-c1', 't3-c1']);
  });

  it('una clínica que falla no frena a las demás; al final falla para que la cola reintente', async () => {
    const ctx = backfillSetup(['t2']);
    await expect(ctx.sweep.run()).rejects.toThrow(/1 clínica/);
    expect(ctx.calls.map((c) => c.tenantId)).toEqual(['t1', 't3']);
  });
});
