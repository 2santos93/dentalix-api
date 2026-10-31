import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InMemoryFileStorage } from '../../../shared/storage/__fixtures__/in-memory-file-storage';
import type { MedicalAlertFlags } from '../../medical-history/domain/medical-alert-flags';
import { NO_ANAMNESIS_FLAGS } from '../../medical-history/domain/medical-alert-flags';
import type { ContingencyAgendaModel } from '../domain/contingency-agenda';
import type {
  ContingencyAgendaRepository,
  ContingencyAppointmentRow,
  ContingencyLocation,
  ContingencySnapshot,
  NightlyCandidate,
} from '../domain/ports/contingency-agenda-repository.port';
import type { ContingencyAgendaRenderer } from '../infrastructure/pdf/contingency-agenda-pdf.renderer';
import {
  CONTINGENCY_LOCATION_NOT_FOUND_MESSAGE,
  CONTINGENCY_NIGHTLY_JOB,
  CONTINGENCY_NIGHTLY_MISSING_MESSAGE,
  ContingencyAgendaUseCases,
  ContingencyNightlySweep,
  contingencyStorageKey,
  type ContingencyJobQueue,
  type ContingencyMedicalFlags,
} from './contingency-agenda.use-cases';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CENTRO = '22222222-2222-4222-8222-222222222222';
const NORTE = '33333333-3333-4333-8333-333333333333';
// 2026-11-02 10:00 en Caracas (UTC−4).
const NOW = new Date('2026-11-02T14:00:00Z');

class FakeRepo implements ContingencyAgendaRepository {
  locations = new Map<string, ContingencyLocation>();
  rows: ContingencyAppointmentRow[] = [];
  snapshots = new Map<string, ContingencySnapshot>();
  candidates = new Map<string, NightlyCandidate[]>();
  windows: { locationId: string; from: Date; to: Date }[] = [];

  findLocation(id: string) {
    return Promise.resolve(this.locations.get(id) ?? null);
  }
  listAppointments(locationId: string, from: Date, to: Date) {
    this.windows.push({ locationId, from, to });
    return Promise.resolve(this.rows);
  }
  findSnapshot(id: string) {
    return Promise.resolve(this.snapshots.get(id) ?? null);
  }
  saveSnapshot(s: ContingencySnapshot) {
    this.snapshots.set(s.locationId, s);
    return Promise.resolve();
  }
  tenantIds() {
    return Promise.resolve([...this.candidates.keys()]);
  }
  nightlyCandidates(tenantId: string) {
    return Promise.resolve(this.candidates.get(tenantId) ?? []);
  }
}

/** El renderer falso devuelve el modelo en JSON: así se ve lo que se pintaría. */
const renderer: ContingencyAgendaRenderer = {
  render: (model) => Promise.resolve(Buffer.from(JSON.stringify(model))),
};
const modelOf = (pdf: Buffer) =>
  JSON.parse(pdf.toString()) as ContingencyAgendaModel;

function location(
  over: Partial<ContingencyLocation> = {},
): ContingencyLocation {
  return {
    id: CENTRO,
    tenantId: TENANT,
    name: 'Sede Centro',
    phone: '2125550000',
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
    defaultPhoneRegion: 'VE',
    clinicName: 'Clínica Demo',
    ...over,
  };
}

function row(
  over: Partial<ContingencyAppointmentRow> = {},
): ContingencyAppointmentRow {
  return {
    appointmentId: 'a1',
    patientId: 'p1',
    start: new Date('2026-11-02T15:00:00Z'),
    end: new Date('2026-11-02T15:30:00Z'),
    status: 'CONFIRMED',
    firstName: 'Laura',
    lastName: 'Castro',
    phone: '04121234567',
    professionalName: 'Dra. Ana Gómez',
    appointmentTypeName: 'Limpieza',
    firstVisit: false,
    callbackRequested: false,
    ...over,
  };
}

describe('ContingencyAgendaUseCases (DX-339)', () => {
  let repo: FakeRepo;
  let storage: InMemoryFileStorage;
  let flags: Map<string, MedicalAlertFlags>;
  let useCases: ContingencyAgendaUseCases;

  beforeEach(() => {
    repo = new FakeRepo();
    repo.locations.set(CENTRO, location());
    storage = new InMemoryFileStorage();
    flags = new Map();
    const medical: ContingencyMedicalFlags = {
      forAppointments: () => Promise.resolve(flags),
    };
    useCases = new ContingencyAgendaUseCases(
      repo,
      renderer,
      storage,
      medical,
      () => NOW,
    );
  });

  describe('descarga a demanda', () => {
    it('genera el PDF de hoy y mañana en la zona de la sede, con nombre de fichero sin acentos', async () => {
      repo.rows = [row()];
      const result = await useCases.downloadNow(CENTRO, 'ALL');
      expect(result.fileName).toBe(
        'agenda-contingencia-sede-centro-2026-11-02.pdf',
      );
      expect(result.appointmentCount).toBe(1);
      expect(repo.windows).toEqual([
        {
          locationId: CENTRO,
          from: new Date('2026-11-02T04:00:00Z'),
          to: new Date('2026-11-04T04:00:00Z'),
        },
      ]);
      const model = modelOf(result.pdf);
      expect(model.days[0].rows[0]).toMatchObject({
        patient: 'Laura Castro',
        professional: 'Dra. Ana Gómez',
        type: 'Limpieza',
        time: '11:00 a. m. – 11:30 a. m.',
      });
    });

    it('teléfonos en formato internacional con la región de la sede (o el texto guardado si no se leen)', async () => {
      repo.rows = [
        row(),
        row({ appointmentId: 'a2', patientId: 'p2', phone: 'llamar a casa' }),
      ];
      const model = modelOf((await useCases.downloadNow(CENTRO, 'ALL')).pdf);
      expect(model.days[0].rows.map((r) => r.phone)).toEqual([
        '+58 412 1234567',
        'llamar a casa',
      ]);
      expect(model.locationPhone).toBe('+58 212 5550000');
    });

    it('la alerta médica es un sí/no (alerta o premedicación), sin detalle', async () => {
      repo.rows = [
        row(),
        row({ appointmentId: 'a2', patientId: 'p2' }),
        row({ appointmentId: 'a3', patientId: 'p3' }),
      ];
      flags.set('a1', {
        ...NO_ANAMNESIS_FLAGS,
        hasCriticalAlert: true,
        alerts: ['anticoagulantes'],
      });
      flags.set('a2', { ...NO_ANAMNESIS_FLAGS, requiresPremedication: true });
      const model = modelOf((await useCases.downloadNow(CENTRO, 'ALL')).pdf);
      const alerts = model.days[0].rows.map((r) => r.alerts);
      expect(alerts[0]).toContain('Alerta médica: ver ficha');
      expect(alerts[1]).toContain('Alerta médica: ver ficha');
      expect(alerts[2]).not.toContain('Alerta médica');
      expect(JSON.stringify(model)).not.toContain('anticoagulantes');
    });

    it('sede de otra clínica o inexistente: 404', async () => {
      await expect(useCases.downloadNow(NORTE, 'ALL')).rejects.toThrow(
        new NotFoundException(CONTINGENCY_LOCATION_NOT_FOUND_MESSAGE),
      );
    });

    it('sede de la clínica fuera de las permitidas al usuario: 403 LOCATION_NOT_ALLOWED', async () => {
      const error = await useCases
        .downloadNow(CENTRO, [NORTE])
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'LOCATION_NOT_ALLOWED',
      });
    });

    it('sede sin zona o sin formato: 409 con su código, nunca otra zona', async () => {
      repo.locations.set(CENTRO, location({ timeZone: null }));
      const noZone = await useCases
        .downloadNow(CENTRO, 'ALL')
        .catch((e: unknown) => e);
      expect(noZone).toBeInstanceOf(ConflictException);
      expect((noZone as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_TIMEZONE_REQUIRED',
      });
      repo.locations.set(CENTRO, location({ hourCycle: null }));
      const noFormat = await useCases
        .downloadNow(CENTRO, 'ALL')
        .catch((e: unknown) => e);
      expect((noFormat as ConflictException).getResponse()).toMatchObject({
        code: 'LOCATION_LOCALE_REQUIRED',
      });
    });
  });

  describe('copia nocturna', () => {
    it('sin copia: no disponible; la descarga da 404 con un mensaje que lleva a la agenda actual', async () => {
      await expect(useCases.nightlyInfo(CENTRO, 'ALL')).resolves.toEqual({
        available: false,
        current: false,
        forDate: null,
        generatedAt: null,
        appointmentCount: null,
      });
      await expect(useCases.downloadNightly(CENTRO, 'ALL')).rejects.toThrow(
        new NotFoundException(CONTINGENCY_NIGHTLY_MISSING_MESSAGE),
      );
    });

    it('generarla guarda el PDF en el almacén privado y la fila de la sede; luego se describe y se descarga', async () => {
      repo.rows = [row()];
      await expect(useCases.generateNightly(CENTRO)).resolves.toBe('GENERATED');
      expect(storage.saved).toEqual([contingencyStorageKey(TENANT, CENTRO)]);
      expect(contingencyStorageKey(TENANT, CENTRO)).toBe(
        `contingency-agendas/${TENANT}/${CENTRO}.pdf`,
      );
      const snapshot = repo.snapshots.get(CENTRO);
      expect(snapshot).toMatchObject({
        forDate: '2026-11-02',
        generatedAt: NOW,
        appointmentCount: 1,
      });
      await expect(useCases.nightlyInfo(CENTRO, 'ALL')).resolves.toEqual({
        available: true,
        current: true,
        forDate: '2026-11-02',
        generatedAt: NOW,
        appointmentCount: 1,
      });
      const download = await useCases.downloadNightly(CENTRO, 'ALL');
      expect(download.fileName).toBe(
        'agenda-contingencia-sede-centro-2026-11-02.pdf',
      );
      expect(modelOf(download.pdf).days[0].rows[0].patient).toBe(
        'Laura Castro',
      );
    });

    it('una copia de otro día sigue disponible pero no es la de hoy (current: false)', async () => {
      repo.snapshots.set(CENTRO, {
        locationId: CENTRO,
        forDate: '2026-10-31',
        generatedAt: new Date('2026-10-31T06:10:00Z'),
        appointmentCount: 4,
        sizeBytes: 10,
        storageKey: 'contingency-agendas/x/y.pdf',
      });
      await expect(useCases.nightlyInfo(CENTRO, 'ALL')).resolves.toMatchObject({
        available: true,
        current: false,
        forDate: '2026-10-31',
      });
    });

    it('fila sin fichero en el almacén: el mismo 404', async () => {
      repo.snapshots.set(CENTRO, {
        locationId: CENTRO,
        forDate: '2026-11-02',
        generatedAt: NOW,
        appointmentCount: 0,
        sizeBytes: 10,
        storageKey: 'contingency-agendas/x/perdido.pdf',
      });
      await expect(useCases.downloadNightly(CENTRO, 'ALL')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('describir y descargar la copia exigen la misma sede permitida', async () => {
      await expect(useCases.nightlyInfo(CENTRO, [NORTE])).rejects.toThrow(
        ForbiddenException,
      );
      await expect(useCases.downloadNightly(NORTE, 'ALL')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('el trabajo salta una sede retirada o desactivada sin fallar', async () => {
      await expect(useCases.generateNightly(NORTE)).resolves.toBe('SKIPPED');
      expect(storage.saved).toEqual([]);
    });
  });
});

describe('ContingencyNightlySweep (DX-339)', () => {
  function sweepAt(now: Date, candidates: NightlyCandidate[]) {
    const repo = new FakeRepo();
    repo.candidates.set(TENANT, candidates);
    const enqueued: { name: string; payload: object; options: object }[] = [];
    const queue: ContingencyJobQueue = {
      enqueue: (name, payload, options) => {
        enqueued.push({ name, payload, options });
        return Promise.resolve({ id: 'j', created: true });
      },
    };
    return {
      run: () => new ContingencyNightlySweep(repo, queue, () => now).run(),
      enqueued,
    };
  }

  const candidate = (
    over: Partial<NightlyCandidate> = {},
  ): NightlyCandidate => ({
    locationId: CENTRO,
    timeZone: 'America/Caracas',
    lastForDate: null,
    ...over,
  });

  it('desde las 02:00 de la sede encola la copia del día, con clave idempotente por sede y día', async () => {
    // 06:30 UTC = 02:30 en Caracas.
    const { run, enqueued } = sweepAt(new Date('2026-11-02T06:30:00Z'), [
      candidate(),
    ]);
    await expect(run()).resolves.toEqual({ queued: 1 });
    expect(enqueued).toEqual([
      {
        name: CONTINGENCY_NIGHTLY_JOB,
        payload: { locationId: CENTRO },
        options: {
          tenantId: TENANT,
          idempotencyKey: `contingency.nightly:${CENTRO}:2026-11-02`,
        },
      },
    ]);
  });

  it('antes de las 02:00 de la sede no encola (la de ayer aún vale para ese día)', async () => {
    // 05:30 UTC = 01:30 en Caracas.
    const { run, enqueued } = sweepAt(new Date('2026-11-02T05:30:00Z'), [
      candidate(),
    ]);
    await run();
    expect(enqueued).toEqual([]);
  });

  it('no repite la de hoy y recupera una noche perdida más tarde ese mismo día', async () => {
    const at = new Date('2026-11-02T18:00:00Z'); // 14:00 en Caracas
    const done = sweepAt(at, [candidate({ lastForDate: '2026-11-02' })]);
    await done.run();
    expect(done.enqueued).toEqual([]);
    const missed = sweepAt(at, [candidate({ lastForDate: '2026-10-30' })]);
    await missed.run();
    expect(missed.enqueued).toHaveLength(1);
  });

  it('cada sede con su medianoche: Madrid ya está en el día siguiente, Caracas no', async () => {
    // 01:30 UTC = 02:30 en Madrid (CET) y 21:30 del día anterior en Caracas.
    const { run, enqueued } = sweepAt(new Date('2026-11-02T01:30:00Z'), [
      candidate({ lastForDate: '2026-11-01' }),
      candidate({
        locationId: NORTE,
        timeZone: 'Europe/Madrid',
        lastForDate: '2026-11-01',
      }),
    ]);
    await run();
    expect(enqueued.map((e) => e.payload)).toEqual([{ locationId: NORTE }]);
  });
});
