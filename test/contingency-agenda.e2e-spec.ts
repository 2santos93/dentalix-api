import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import {
  CONTINGENCY_FORBIDDEN_MESSAGE,
  CONTINGENCY_NIGHTLY_JOB,
  CONTINGENCY_NIGHTLY_MISSING_MESSAGE,
  ContingencyAgendaUseCases,
  ContingencyNightlySweep,
} from '../src/modules/contingency-agenda/application/contingency-agenda.use-cases';
import { CONTINGENCY_AGENDA_CLOCK } from '../src/modules/contingency-agenda/domain/ports/contingency-agenda-repository.port';
import {
  CONTINGENCY_AGENDA_RENDERER,
  PdfkitContingencyAgendaRenderer,
} from '../src/modules/contingency-agenda/infrastructure/pdf/contingency-agenda-pdf.renderer';

/**
 * DX-339 · Agenda de contingencia por HTTP real. Clínica A (sedes en Bogotá,
 * UTC−5, reloj de 24 h) con la sede principal y la Norte, y la clínica B. El
 * reloj del módulo es fijo: «hoy» es el lunes 4 de marzo de 2030 (mediodía en
 * Bogotá) y «mañana» el martes 5. El PDF se genera sin comprimir para leer lo
 * que pinta.
 *
 *  - hoyConfirmada: hoy 09:00, confirmada, primera visita → sale;
 *  - hoyCancelada: hoy 10:00, cancelada → no sale;
 *  - mananaAgendada: mañana 08:30, con motivo y notas → sale, sin ellos;
 *  - pasado: pasado mañana → no sale (fuera de la ventana);
 *  - norte: hoy en la Sede Norte → solo en el PDF de la Norte.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const NOW = new Date('2030-03-04T17:00:00Z'); // 12:00 en Bogotá
const at = (day: string, time: string) => new Date(`${day}T${time}:00-05:00`);
const route = (locationId: string, suffix = '') =>
  `/locations/${locationId}/contingency-agenda${suffix}`;

/** Lo que pinta cada operador `TJ` del PDF sin comprimir (WinAnsi). */
function paintedText(pdf: Buffer): string[] {
  const winAnsi: Record<number, string> = { 0x96: '–' };
  return [...pdf.toString('latin1').matchAll(/\[([^\]]*)\] TJ/g)].map((op) =>
    [...op[1].matchAll(/<([0-9a-f]*)>/g)]
      .map((hex) =>
        [...Buffer.from(hex[1], 'hex')]
          .map((b) => winAnsi[b] ?? String.fromCharCode(b))
          .join(''),
      )
      .join(''),
  );
}

describe('Agenda de contingencia por sede (DX-339, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let bLocation: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let receptionUserId: string;
  let receptionNorteOnly: string;

  const get = (clinic: Clinic, token: string, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  const pdf = (clinic: Clinic, token: string, path: string) =>
    get(clinic, token, path)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });

  const auditRows = (reason: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        metadata: { path: ['reason'], equals: reason },
      },
      orderBy: { occurredAt: 'asc' },
      select: {
        actorUserId: true,
        actorRole: true,
        action: true,
        resourceType: true,
        resourceId: true,
        patientId: true,
        locationId: true,
      },
    });

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(CONTINGENCY_AGENDA_CLOCK)
        .useValue(() => NOW)
        .overrideProvider(CONTINGENCY_AGENDA_RENDERER)
        .useValue(new PdfkitContingencyAgendaRenderer({ compress: false })),
    );
    await resetDatabase(raw);
    a = await registerClinic(app, 'contingencia-a');
    b = await registerClinic(app, 'contingencia-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    bLocation = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    await raw.location.update({
      where: { id: principal },
      data: { name: 'Sede Principal', phone: '6015550000' },
    });
    tokens.ADMIN = a.adminToken;
    let dentistId = '';
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
      if (role === ClinicRole.RECEPTION) receptionUserId = member.userId;
    }
    receptionNorteOnly = (
      await app.get(TokenService).issue({
        sub: receptionUserId,
        tenantId: a.tenantId,
        role: ClinicRole.RECEPTION,
        loc: [norte],
        tv: 0,
      })
    ).accessToken;

    const patient = async (
      firstName: string,
      lastName: string,
      phone: string,
    ) =>
      (
        await raw.patient.create({
          data: { tenantId: a.tenantId, firstName, lastName, phone },
          select: { id: true },
        })
      ).id;
    const laura = await patient('Laura', 'Castro', '3001234567');
    const pedro = await patient('Pedro', 'Cancelado', '3007654321');
    const marta = await patient('Marta', 'Mañana', '3011112233');
    const lejano = await patient('Lucas', 'Pasado', '3019998877');
    const nora = await patient('Nora', 'Norteña', '3024445566');
    const limpieza = await raw.appointmentType.create({
      data: {
        tenantId: a.tenantId,
        name: 'Limpieza',
        durationMinutes: 30,
        color: '#0E7490',
      },
      select: { id: true },
    });
    const appointment = (data: {
      patientId: string;
      locationId?: string;
      start: Date;
      status: 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED';
      reason?: string;
      notes?: string;
      appointmentTypeId?: string;
    }) =>
      raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId: data.locationId ?? principal,
          providerId: dentistId,
          patientId: data.patientId,
          start: data.start,
          end: new Date(data.start.getTime() + 30 * 60_000),
          status: data.status,
          reason: data.reason,
          notes: data.notes,
          appointmentTypeId: data.appointmentTypeId,
        },
      });
    await appointment({
      patientId: laura,
      start: at('2030-03-04', '09:00'),
      status: 'CONFIRMED',
      appointmentTypeId: limpieza.id,
    });
    await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: principal,
        providerId: dentistId,
        patientId: pedro,
        start: at('2030-03-04', '10:00'),
        end: at('2030-03-04', '10:30'),
        status: 'CANCELLED',
        cancelledAt: NOW,
        cancelledByKind: 'STAFF_FOR_PATIENT',
        cancelReasonCode: 'ILLNESS',
        noticeMinutes: 60,
        lateCancellation: false,
      },
    });
    await appointment({
      patientId: marta,
      start: at('2030-03-05', '08:30'),
      status: 'SCHEDULED',
      reason: 'Dolor en la muela 36',
      notes: 'Paciente con ansiedad',
    });
    await appointment({
      patientId: lejano,
      start: at('2030-03-06', '09:00'),
      status: 'SCHEDULED',
    });
    await appointment({
      patientId: nora,
      locationId: norte,
      start: at('2030-03-04', '15:00'),
      status: 'SCHEDULED',
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('descarga a demanda', () => {
    it('ADMIN: PDF de hoy y mañana de la sede, con nombre de fichero, sin canceladas ni fuera de la ventana', async () => {
      const res = await pdf(a, a.adminToken, route(principal)).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toContain(
        'filename="agenda-contingencia-sede-principal-2030-03-04.pdf"',
      );
      expect(res.headers['cache-control']).toBe('private, no-store');
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe('%PDF-');
      const text = paintedText(body);
      expect(text).toEqual(
        expect.arrayContaining([
          'Agenda de contingencia',
          'Clinica contingencia-a · Sede Principal · Tel. +57 601 5550000',
          'Hoy · lunes 4 de marzo de 2030',
          'Mañana · martes 5 de marzo de 2030',
          '09:00 – 09:30',
          'Laura Castro',
          '+57 300 1234567',
          'Miembro DENTIST',
          'Limpieza',
          'Confirmada · Primera visita',
          '08:30 – 09:00',
          'Marta Mañana',
          'Sin confirmar · Primera visita',
        ]),
      );
      const joined = text.join('\n');
      expect(joined).not.toContain('Pedro Cancelado');
      expect(joined).not.toContain('Lucas Pasado');
      expect(joined).not.toContain('Nora Norteña');
      // Ni el motivo ni las notas de la cita.
      expect(joined).not.toContain('Dolor en la muela');
      expect(joined).not.toContain('ansiedad');
      expect(joined).toContain('Generada el 04/03/2030 12:00 (America/Bogota)');
    });

    it('RECEPTION también; cada sede con sus citas', async () => {
      const res = await pdf(a, tokens.RECEPTION!, route(norte)).expect(200);
      const joined = paintedText(res.body as Buffer).join('\n');
      expect(joined).toContain('Nora Norteña');
      expect(joined).not.toContain('Laura Castro');
    });

    it('DENTIST y ASSISTANT: 403 con el mensaje del rol', async () => {
      for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
        const res = await get(a, tokens[role]!, route(principal)).expect(403);
        expect((res.body as { message: string }).message).toBe(
          CONTINGENCY_FORBIDDEN_MESSAGE,
        );
      }
    });

    it('sede de otra clínica o inexistente: 404; id que no es uuid: 400', async () => {
      await get(a, a.adminToken, route(bLocation)).expect(404);
      await get(
        a,
        a.adminToken,
        route('00000000-0000-4000-8000-000000000000'),
      ).expect(404);
      await get(a, a.adminToken, route('no-es-uuid')).expect(400);
      // Y B no ve la de A.
      await get(b, b.adminToken, route(principal)).expect(404);
    });

    it('sede de la clínica no permitida al usuario restringido (DX-089): 403 LOCATION_NOT_ALLOWED; la suya, 200', async () => {
      const res = await get(a, receptionNorteOnly, route(principal)).expect(
        403,
      );
      expect(res.body).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
      await get(a, receptionNorteOnly, route(principal, '/nightly')).expect(
        403,
      );
      await get(a, receptionNorteOnly, route(principal, '/nightly/pdf')).expect(
        403,
      );
      await pdf(a, receptionNorteOnly, route(norte)).expect(200);
    });

    it('cada descarga correcta queda en la auditoría (EXPORT · LOCATION · sede); las rechazadas no', async () => {
      const rows = await auditRows('CONTINGENCY_AGENDA_DOWNLOADED');
      expect(rows).toEqual([
        {
          actorUserId: a.adminUserId,
          actorRole: 'ADMIN',
          action: 'EXPORT',
          resourceType: 'LOCATION',
          resourceId: principal,
          patientId: null,
          locationId: null,
        },
        expect.objectContaining({
          actorUserId: receptionUserId,
          resourceId: norte,
        }),
        expect.objectContaining({
          actorUserId: receptionUserId,
          resourceId: norte,
        }),
      ]);
    });
  });

  describe('copia nocturna', () => {
    it('sin copia: no disponible y la descarga da 404', async () => {
      const info = await get(
        a,
        a.adminToken,
        route(principal, '/nightly'),
      ).expect(200);
      expect(info.body).toEqual({
        available: false,
        current: false,
        forDate: null,
        generatedAt: null,
        appointmentCount: null,
      });
      const res = await get(
        a,
        a.adminToken,
        route(principal, '/nightly/pdf'),
      ).expect(404);
      expect((res.body as { message: string }).message).toBe(
        CONTINGENCY_NIGHTLY_MISSING_MESSAGE,
      );
    });

    it('el barrido encola una copia por sede (idempotente por sede y día)', async () => {
      const sweep = app.get(ContingencyNightlySweep);
      await sweep.run();
      await sweep.run();
      const jobs = await raw.job.findMany({
        where: { name: CONTINGENCY_NIGHTLY_JOB, tenantId: a.tenantId },
        select: { payload: true, idempotencyKey: true },
      });
      expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual(
        [principal, norte]
          .map((id) => `contingency.nightly:${id}:2030-03-04`)
          .sort(),
      );
      // Los trabajos solo llevan el id de la sede.
      expect(jobs.map((j) => j.payload)).toEqual(
        expect.arrayContaining([
          { locationId: principal },
          { locationId: norte },
        ]),
      );
    });

    it('el trabajo la genera y guarda; luego se describe y se descarga, auditado', async () => {
      await app
        .get(TenantContextService)
        .run(a.tenantId, () =>
          app.get(ContingencyAgendaUseCases).generateNightly(principal),
        );
      const info = await get(
        a,
        tokens.RECEPTION!,
        route(principal, '/nightly'),
      ).expect(200);
      expect(info.body).toEqual({
        available: true,
        current: true,
        forDate: '2030-03-04',
        generatedAt: NOW.toISOString(),
        appointmentCount: 2,
      });
      const res = await pdf(
        a,
        tokens.RECEPTION!,
        route(principal, '/nightly/pdf'),
      ).expect(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(paintedText(res.body as Buffer)).toContain('Laura Castro');
      const rows = await auditRows('CONTINGENCY_AGENDA_NIGHTLY_DOWNLOADED');
      expect(rows).toEqual([
        expect.objectContaining({
          actorUserId: receptionUserId,
          action: 'EXPORT',
          resourceType: 'LOCATION',
          resourceId: principal,
        }),
      ]);
      // Ver el estado de la copia no se audita (no lleva pacientes).
      const all = await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          resourceType: 'LOCATION',
          action: 'VIEW',
        },
      });
      expect(all).toBe(0);
    });

    it('la fila de la copia es de la clínica: B no la ve ni por RLS', async () => {
      const visibleFromB = await raw.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE dentalix_app`;
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
        return tx.contingencyAgendaSnapshot.count();
      });
      expect(visibleFromB).toBe(0);
    });
  });
});
