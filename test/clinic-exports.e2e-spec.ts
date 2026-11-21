import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { JobQueue } from '../src/modules/jobs/application/job-queue.service';
import { JobWorker } from '../src/modules/jobs/application/job-worker.service';
import { MAILER } from '../src/modules/notifications/email/domain/ports/mailer.port';
import {
  CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE,
  CLINIC_EXPORT_EXPIRED_MESSAGE,
  CLINIC_EXPORT_FORBIDDEN_MESSAGE,
  CLINIC_EXPORT_IN_PROGRESS_MESSAGE,
  CLINIC_EXPORT_NOT_FOUND_MESSAGE,
  CLINIC_EXPORT_PURGE_JOB,
} from '../src/modules/clinic-exports/domain/clinic-export';
import { EXPORT_CATALOG } from '../src/modules/clinic-exports/domain/export-catalog';
import { FILE_STORAGE } from '../src/shared/storage/file-storage.port';
import type { FileStoragePort } from '../src/shared/storage/file-storage.port';
import { CapturingMailer } from './support/capture-mailer';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { csvRows, unzipText } from './support/unzip';

// DX-053 por HTTP contra Postgres: Ajustes › Exportar datos. Solo ADMIN; una
// en curso por clínica (409, también con dos peticiones a la vez); el trabajo
// genera el ZIP con un CSV por entidad SOLO de su clínica; aviso a todos los
// ADMIN sin enlace al fichero; descarga de un solo uso que caduca; auditoría
// de la petición y de la descarga; aislamiento entre dos clínicas; borrado
// del fichero a los 7 días.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface ExportBody {
  id: string;
  state: string;
  requestedByName: string | null;
  sizeBytes: number | null;
  fileCount: number | null;
  totalRows: number | null;
  downloadExpiresAt: string | null;
  downloadedAt: string | null;
  downloadedByName: string | null;
  errorCode: string | null;
  canDownload: boolean;
}

interface DownloadBody {
  url: string;
  expiresInSeconds: number;
  fileName: string;
  sizeBytes: number;
}

describe('Exportación de los datos de la clínica (e2e, DX-053)', () => {
  const mailer = new CapturingMailer();
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let admin2: { email: string; token: string; userId: string };
  let others: { role: ClinicRole; token: string }[] = [];
  let exportA: string;
  let exportB: string;
  let zipA: Map<string, string>;
  let patientN = 0;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host: string) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const list = (c: Clinic, token = c.adminToken) =>
    as(api().get('/api/v1/clinic-exports'), token, c.host);
  const requestExport = (c: Clinic, token = c.adminToken) =>
    as(api().post('/api/v1/clinic-exports'), token, c.host);
  const download = (c: Clinic, id: string, token = c.adminToken) =>
    as(api().post(`/api/v1/clinic-exports/${id}/download`), token, c.host);
  const drain = () => app.get(JobWorker).drain();

  async function patient(c: Clinic, firstName: string, lastName: string) {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName,
        lastName,
        docType: 'NATIONAL_ID',
        docNumber: `V053${String(++patientN).padStart(4, '0')}`,
        sex: 'F',
        phone: '+584121234567',
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  function fetchSigned(url: string) {
    const u = new URL(url);
    return api()
      .get(`${u.pathname}${u.search}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  }

  const exportEvents = (tenantId: string) =>
    raw.auditEvent.findMany({
      where: { tenantId, resourceType: 'CLINIC_EXPORT' },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await createE2eApp((b) =>
      b.overrideProvider(MAILER).useValue(mailer),
    );
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx053-e2e');
    other = await registerClinic(app, 'dx053-e2e-otra');
    const a2 = await seedMember(raw, clinic, ClinicRole.ADMIN);
    admin2 = { ...a2, token: await loginAs(app, clinic.host, a2.email) };
    others = [];
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const m = await seedMember(raw, clinic, role);
      others.push({ role, token: await loginAs(app, clinic.host, m.email) });
    }
    await patient(clinic, 'Ana', 'Pérez');
    // Un nombre que una hoja de cálculo ejecutaría como fórmula.
    await patient(clinic, '=HYPERLINK("http://x")', 'Rojas');
    await patient(other, 'Beatriz', 'Secreta');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('solo ADMIN: DENTIST, RECEPTION y ASSISTANT reciben 403 en español en las tres rutas y nada se crea', async () => {
    for (const m of others) {
      for (const res of [
        await list(clinic, m.token),
        await requestExport(clinic, m.token),
        await download(clinic, '00000000-0000-4000-8000-000000000000', m.token),
      ]) {
        expect({ role: m.role, status: res.status }).toEqual({
          role: m.role,
          status: 403,
        });
        expect((res.body as { message: string }).message).toBe(
          CLINIC_EXPORT_FORBIDDEN_MESSAGE,
        );
      }
    }
    expect(await raw.clinicExport.count()).toBe(0);
  });

  it('historial vacío al empezar, sin caché', async () => {
    const res = await list(clinic).expect(200);
    expect(res.body).toEqual([]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('pedir: 201 PENDING y auditado; una segunda mientras está en curso → 409', async () => {
    const res = await requestExport(clinic).expect(201);
    const body = res.body as ExportBody;
    expect(body).toMatchObject({
      state: 'PENDING',
      requestedByName: 'Dr. Owner',
      canDownload: false,
    });
    expect(res.headers['cache-control']).toBe('no-store');
    exportA = body.id;

    const again = await requestExport(clinic, admin2.token).expect(409);
    expect((again.body as { message: string }).message).toBe(
      CLINIC_EXPORT_IN_PROGRESS_MESSAGE,
    );

    const events = await exportEvents(clinic.tenantId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      resourceId: exportA,
      actorUserId: clinic.adminUserId,
      locationId: null,
    });
    expect(events[0].metadata).toEqual({ reason: 'CLINIC_EXPORT_REQUESTED' });
    // El trabajo quedó en la cola, con solo el id.
    const job = await raw.job.findFirstOrThrow({
      where: { tenantId: clinic.tenantId, name: 'clinic-exports.build' },
    });
    expect(job.payload).toEqual({ exportId: exportA });
  });

  it('dos peticiones A LA VEZ en otra clínica: una crea y la otra recibe 409 (índice único parcial)', async () => {
    const [r1, r2] = await Promise.all([
      requestExport(other),
      requestExport(other),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    exportB = ((r1.status === 201 ? r1.body : r2.body) as ExportBody).id;
    expect(
      await raw.clinicExport.count({ where: { tenantId: other.tenantId } }),
    ).toBe(1);
  });

  it('el trabajo genera el ZIP: READY con tamaño, ficheros y filas, y avisa a TODOS los ADMIN de la clínica (sin enlace al fichero)', async () => {
    mailer.clear();
    await drain();
    const [a] = (await list(clinic).expect(200)).body as ExportBody[];
    expect(a).toMatchObject({
      id: exportA,
      state: 'READY',
      canDownload: true,
      fileCount: EXPORT_CATALOG.length,
    });
    expect(a.sizeBytes).toBeGreaterThan(1000);
    expect(a.totalRows).toBeGreaterThanOrEqual(2);
    const expires = new Date(a.downloadExpiresAt!).getTime() - Date.now();
    expect(expires).toBeGreaterThan(23 * 3600_000);
    expect(expires).toBeLessThanOrEqual(24 * 3600_000);

    for (const to of [`owner@${clinic.subdomain}.test`, admin2.email]) {
      await mailer.waitFor(to, /Exportar datos/);
    }
    await mailer.waitFor(`owner@${other.subdomain}.test`, /Exportar datos/);
    const subjectOf = (c: Clinic) =>
      `La exportación de datos de Clinica ${c.subdomain} está lista`;
    const toA = mailer.sent.filter((m) => m.subject === subjectOf(clinic));
    expect(toA.map((m) => m.to).sort()).toEqual(
      [`owner@${clinic.subdomain}.test`, admin2.email].sort(),
    );
    for (const m of toA) {
      expect(m.text).toContain('Dr. Owner pidió');
      expect(m.text).toMatch(
        new RegExp(`//${clinic.subdomain}\\.[a-z.]+/settings/exportar-datos`),
      );
      expect(m.text + m.html).not.toMatch(/\.zip|clinic-exports\/|signature=/);
    }
    // La de B, solo a su ADMIN; nada al resto del personal.
    expect(
      mailer.sent
        .filter((m) => m.subject === subjectOf(other))
        .map((m) => m.to),
    ).toEqual([`owner@${other.subdomain}.test`]);
    expect(
      mailer.sent.some((m) => /^(dentist|reception|assistant)@/.test(m.to)),
    ).toBe(false);
  });

  // ISOLATION_COVERS: POST /clinic-exports/:id/download
  it('B no ve en su historial la exportación de A ni puede descargarla (404), y la de A sigue sin descargar', async () => {
    const bodies = (await list(other).expect(200)).body as ExportBody[];
    expect(bodies.map((b) => b.id)).toEqual([exportB]);
    const res = await download(other, exportA).expect(404);
    expect((res.body as { message: string }).message).toBe(
      CLINIC_EXPORT_NOT_FOUND_MESSAGE,
    );
    const row = await raw.clinicExport.findUniqueOrThrow({
      where: { id: exportA },
    });
    expect(row.downloadedAt).toBeNull();
  });

  it('descargar: URL firmada de 60 s; el ZIP trae un CSV por entidad, UTF-8 con BOM, SOLO de esta clínica y sin secretos', async () => {
    const res = await download(clinic, exportA, admin2.token).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as DownloadBody;
    expect(body.expiresInSeconds).toBe(60);
    expect(body.fileName).toMatch(
      /^exportacion-dentalix-\d{4}-\d{2}-\d{2}\.zip$/,
    );

    const file = await fetchSigned(body.url).expect(200);
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.headers['content-disposition']).toContain('attachment');
    const bytes = file.body as Buffer;
    expect(bytes.length).toBe(body.sizeBytes);
    zipA = unzipText(bytes);
    expect([...zipA.keys()]).toEqual([
      ...EXPORT_CATALOG.map((t) => t.file),
      'LEEME.txt',
    ]);
    for (const [name, text] of zipA) {
      if (name.endsWith('.csv')) expect(text.startsWith('﻿"Id"')).toBe(true);
    }

    const patients = csvRows(zipA.get('pacientes.csv')!);
    const header = patients[0];
    const nameCol = header.indexOf('Nombre');
    const codeCol = header.indexOf('Código');
    const names = patients
      .slice(1)
      .map((r) => r[nameCol])
      .sort();
    expect(names).toEqual([`'=HYPERLINK("http://x")`, 'Ana']);
    expect(patients.slice(1).every((r) => /^\d+$/.test(r[codeCol]))).toBe(true);

    // Sedes: la de la clínica, con su zona; personal: los 5 miembros.
    const sedes = csvRows(zipA.get('sedes.csv')!);
    expect(sedes).toHaveLength(2);
    expect(sedes[1][sedes[0].indexOf('Zona horaria')]).toBe('America/Caracas');
    const staff = csvRows(zipA.get('personal.csv')!);
    expect(staff).toHaveLength(6);

    // Nada de la otra clínica en NINGÚN fichero, ni secretos.
    const all = [...zipA.values()].join('\n');
    expect(all).not.toContain('Beatriz');
    expect(all).not.toContain('Secreta');
    expect(all).not.toContain(other.tenantId);
    expect(all).not.toMatch(/\$argon2|passwordHash|tokenHash/);
    expect(zipA.get('LEEME.txt')).toContain('pacientes.csv (2 filas)');

    // La descarga queda auditada con bytes, ficheros y filas, por quien la hizo.
    const events = await exportEvents(clinic.tenantId);
    const exported = events.find((e) => e.action === 'EXPORT');
    expect(exported).toMatchObject({
      resourceId: exportA,
      actorUserId: admin2.userId,
      locationId: null,
    });
    expect(exported!.metadata).toMatchObject({
      reason: 'CLINIC_EXPORT_DOWNLOADED',
      clinicExport: {
        sizeBytes: body.sizeBytes,
        fileCount: EXPORT_CATALOG.length,
      },
    });
  });

  it('un solo uso: la segunda descarga → 410 y el historial dice quién la descargó', async () => {
    const res = await download(clinic, exportA).expect(410);
    expect((res.body as { message: string }).message).toBe(
      CLINIC_EXPORT_ALREADY_DOWNLOADED_MESSAGE,
    );
    const [a] = (await list(clinic).expect(200)).body as ExportBody[];
    expect(a).toMatchObject({
      state: 'DOWNLOADED',
      canDownload: false,
      downloadedByName: `Miembro ADMIN`,
    });
    expect(
      (await exportEvents(clinic.tenantId)).filter(
        (e) => e.action === 'EXPORT',
      ),
    ).toHaveLength(1);
  });

  it('caducado a las 24 h: 410 en español', async () => {
    await raw.clinicExport.update({
      where: { id: exportB },
      data: { downloadExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await download(other, exportB).expect(410);
    expect((res.body as { message: string }).message).toBe(
      CLINIC_EXPORT_EXPIRED_MESSAGE,
    );
    const [b] = (await list(other).expect(200)).body as ExportBody[];
    expect(b.state).toBe('EXPIRED');
  });

  it('a los 7 días el trabajo diferido borra el fichero del almacén y la fila lo dice', async () => {
    const storage = app.get<FileStoragePort>(FILE_STORAGE);
    const row = await raw.clinicExport.findUniqueOrThrow({
      where: { id: exportA },
    });
    expect(await storage.stat(row.fileKey!)).not.toBeNull();
    const purge = await raw.job.findFirstOrThrow({
      where: {
        tenantId: clinic.tenantId,
        name: CLINIC_EXPORT_PURGE_JOB,
        payload: { equals: { exportId: exportA } },
      },
    });
    // Programado ANTES de subir el ZIP (red de seguridad): 7 días desde
    // entonces, unos segundos antes de READY.
    const days =
      (purge.runAt.getTime() - row.completedAt!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    await raw.job.update({
      where: { id: purge.id },
      data: { runAt: new Date(Date.now() - 1000) },
    });
    await drain();
    expect(await storage.stat(row.fileKey!)).toBeNull();
    const after = await raw.clinicExport.findUniqueOrThrow({
      where: { id: exportA },
    });
    expect(after.fileDeletedAt).not.toBeNull();
  });

  it('una en curso colgada de hace horas no bloquea: se cierra FAILED STALE, la nueva se crea y lo que hubiera subido se borra', async () => {
    const storage = app.get<FileStoragePort>(FILE_STORAGE);
    const stuck = await raw.clinicExport.create({
      data: {
        tenantId: other.tenantId,
        requestedById: other.adminUserId,
        status: 'RUNNING',
        requestedAt: new Date(Date.now() - 7 * 3600_000),
      },
    });
    // El worker murió tras subir: la fila ya nombraba el fichero.
    const key = `clinic-exports/${other.tenantId}/${stuck.id}.zip`;
    await raw.clinicExport.update({
      where: { id: stuck.id },
      data: { fileKey: key },
    });
    await storage.save(key, Buffer.from('volcado a medias'), 'application/zip');
    const res = await requestExport(other).expect(201);
    expect((res.body as ExportBody).id).not.toBe(stuck.id);
    const closed = await raw.clinicExport.findUniqueOrThrow({
      where: { id: stuck.id },
    });
    expect(closed).toMatchObject({ status: 'FAILED', errorCode: 'STALE' });
    const states = ((await list(other).expect(200)).body as ExportBody[]).map(
      (b) => b.state,
    );
    expect(states).toContain('FAILED');
    await drain();
    expect(await storage.stat(key)).toBeNull();
    expect(
      (await raw.clinicExport.findUniqueOrThrow({ where: { id: stuck.id } }))
        .fileDeletedAt,
    ).not.toBeNull();
  });

  it('el borrado encuentra un ZIP de una exportación que nunca llegó a READY', async () => {
    const storage = app.get<FileStoragePort>(FILE_STORAGE);
    const orphan = await raw.clinicExport.create({
      data: {
        tenantId: clinic.tenantId,
        requestedById: clinic.adminUserId,
        status: 'FAILED',
        errorCode: 'BUILD_FAILED',
        completedAt: new Date(),
      },
    });
    const key = `clinic-exports/${clinic.tenantId}/${orphan.id}.zip`;
    await raw.clinicExport.update({
      where: { id: orphan.id },
      data: { fileKey: key },
    });
    await storage.save(key, Buffer.from('huérfano'), 'application/zip');
    await app
      .get(JobQueue)
      .enqueue(
        CLINIC_EXPORT_PURGE_JOB,
        { exportId: orphan.id },
        { tenantId: clinic.tenantId },
      );
    await drain();
    expect(await storage.stat(key)).toBeNull();
    const after = await raw.clinicExport.findUniqueOrThrow({
      where: { id: orphan.id },
    });
    expect(after.fileDeletedAt).not.toBeNull();
  });

  it('id mal formado → 400', async () => {
    await download(clinic, 'no-es-un-uuid').expect(400);
  });
});
