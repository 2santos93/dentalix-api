import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { requireLocationFormat } from '../../../shared/locations/location-regional';
import { requireLocationTimeZone } from '../../../shared/locations/location-time-zone';
import { phoneInternational } from '../../../shared/phone/phone-number';
import { transliterateToAscii } from '../../../shared/storage/ascii-filename';
import {
  FILE_STORAGE,
  type FileStoragePort,
} from '../../../shared/storage/file-storage.port';
import {
  isLocationAllowed,
  locationNotAllowed,
  type AllowedLocations,
} from '../../../shared/tenancy/location-access';
import {
  civilDateIn,
  isValidTimeZone,
  zonedWallTime,
} from '../../../shared/time/civil-day';
import type { AppointmentForAlerts } from '../../medical-history/application/patient-medical-alert-flags';
import type { MedicalAlertFlags } from '../../medical-history/domain/medical-alert-flags';
import type { EnqueueOptions, EnqueueResult } from '../../jobs/domain/job';
import {
  buildContingencyAgenda,
  contingencyWindow,
} from '../domain/contingency-agenda';
import {
  CONTINGENCY_AGENDA_CLOCK,
  CONTINGENCY_AGENDA_REPOSITORY,
  type ContingencyAgendaRepository,
  type ContingencyClock,
  type ContingencyLocation,
} from '../domain/ports/contingency-agenda-repository.port';
import {
  CONTINGENCY_AGENDA_RENDERER,
  type ContingencyAgendaRenderer,
} from '../infrastructure/pdf/contingency-agenda-pdf.renderer';

export const CONTINGENCY_LOCATION_NOT_FOUND_MESSAGE =
  'La sede no existe en esta clínica.';
export const CONTINGENCY_NIGHTLY_MISSING_MESSAGE =
  'Aún no hay copia nocturna de esta sede. Descarga la agenda actual.';
export const CONTINGENCY_FORBIDDEN_MESSAGE =
  'Solo la administración y recepción descargan la agenda de contingencia.';

/** Banderas médicas por cita (DX-247): aquí solo cuenta el sí/no. */
export const CONTINGENCY_MEDICAL_FLAGS = Symbol('CONTINGENCY_MEDICAL_FLAGS');
export interface ContingencyMedicalFlags {
  forAppointments(
    appointments: readonly AppointmentForAlerts[],
  ): Promise<Map<string, MedicalAlertFlags>>;
}

/** Lo que el barrido necesita de la cola (DX-085). */
export const CONTINGENCY_JOB_QUEUE = Symbol('CONTINGENCY_JOB_QUEUE');
export interface ContingencyJobQueue {
  enqueue(
    name: string,
    payload: { locationId: string },
    options: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

export const CONTINGENCY_NIGHTLY_JOB = 'contingency.nightly-agenda';
export const CONTINGENCY_SWEEP_JOB = 'contingency.nightly-sweep';
export const CONTINGENCY_SWEEP_SCHEDULE = 'contingency.nightly-sweep.hourly';
/** Cada hora: así cada sede tiene su copia poco después de SU medianoche. */
export const CONTINGENCY_SWEEP_CRON = '47 * * * *';
/** Hora local de la sede desde la que se genera la copia del día. */
export const CONTINGENCY_NIGHTLY_LOCAL_HOUR = 2;

const PDF_TYPE = 'application/pdf';

/** Clave del PDF nocturno en el almacén privado (una por sede, se sobrescribe). */
export function contingencyStorageKey(
  tenantId: string,
  locationId: string,
): string {
  return `contingency-agendas/${tenantId}/${locationId}.pdf`;
}

function fileNameOf(locationName: string, day: string): string {
  const slug = transliterateToAscii(locationName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `agenda-contingencia-${slug || 'sede'}-${day}.pdf`;
}

export interface ContingencyPdf {
  pdf: Buffer;
  fileName: string;
  /** «Hoy» en la sede que cubre el PDF (y el día siguiente). */
  forDate: string;
  generatedAt: Date;
  appointmentCount: number;
}

export interface NightlyInfo {
  available: boolean;
  /** La copia es la de hoy en la sede. */
  current: boolean;
  forDate: string | null;
  generatedAt: Date | null;
  appointmentCount: number | null;
}

/**
 * Agenda de contingencia por sede (DX-339): el PDF de hoy y mañana a demanda
 * y la copia nocturna guardada. Solo sedes vivas y activas de la clínica del
 * contexto (otra clínica o inexistente: 404) y permitidas al usuario (DX-089:
 * 403). La auditoría de cada descarga la escribe el controlador (`@Audit`).
 */
@Injectable()
export class ContingencyAgendaUseCases {
  private readonly logger = new Logger('ContingencyAgenda');

  constructor(
    @Inject(CONTINGENCY_AGENDA_REPOSITORY)
    private readonly repo: ContingencyAgendaRepository,
    @Inject(CONTINGENCY_AGENDA_RENDERER)
    private readonly renderer: ContingencyAgendaRenderer,
    @Inject(FILE_STORAGE) private readonly storage: FileStoragePort,
    @Inject(CONTINGENCY_MEDICAL_FLAGS)
    private readonly medical: ContingencyMedicalFlags,
    @Inject(CONTINGENCY_AGENDA_CLOCK) private readonly clock: ContingencyClock,
  ) {}

  private async location(
    locationId: string,
    allowed: AllowedLocations,
  ): Promise<ContingencyLocation> {
    const location = await this.repo.findLocation(locationId);
    if (!location) {
      throw new NotFoundException(CONTINGENCY_LOCATION_NOT_FOUND_MESSAGE);
    }
    if (!isLocationAllowed(allowed, location.id)) throw locationNotAllowed();
    return location;
  }

  private async generate(
    location: ContingencyLocation,
  ): Promise<ContingencyPdf> {
    const timeZone = requireLocationTimeZone(location);
    const fmt = requireLocationFormat(location);
    const now = this.clock();
    const window = contingencyWindow(now, timeZone);
    const rows = await this.repo.listAppointments(
      location.id,
      window.from,
      window.to,
    );
    const flags = await this.medical.forAppointments(
      rows.map((r) => ({
        id: r.appointmentId,
        patientId: r.patientId,
        start: r.start,
        locationId: location.id,
      })),
    );
    const phone = (text: string | null) =>
      text === null
        ? null
        : (phoneInternational(text, location.defaultPhoneRegion) ?? text);
    const model = buildContingencyAgenda({
      clinicName: location.clinicName,
      locationName: location.name,
      locationPhone: phone(location.phone),
      timeZone,
      fmt,
      today: window.days[0],
      generatedAt: now,
      appointments: rows.map((r) => {
        const f = flags.get(r.appointmentId);
        return {
          appointmentId: r.appointmentId,
          start: r.start,
          end: r.end,
          status: r.status,
          patientName: `${r.firstName} ${r.lastName}`.trim(),
          phone: phone(r.phone),
          professionalName: r.professionalName,
          appointmentTypeName: r.appointmentTypeName,
          firstVisit: r.firstVisit,
          medicalAlert:
            f !== undefined && (f.hasCriticalAlert || f.requiresPremedication),
          callbackRequested: r.callbackRequested,
        };
      }),
    });
    return {
      pdf: await this.renderer.render(model),
      fileName: fileNameOf(location.name, window.days[0]),
      forDate: window.days[0],
      generatedAt: now,
      appointmentCount: model.total,
    };
  }

  /** El PDF generado en este momento. */
  async downloadNow(
    locationId: string,
    allowed: AllowedLocations,
  ): Promise<ContingencyPdf> {
    return this.generate(await this.location(locationId, allowed));
  }

  async nightlyInfo(
    locationId: string,
    allowed: AllowedLocations,
  ): Promise<NightlyInfo> {
    const location = await this.location(locationId, allowed);
    const snapshot = await this.repo.findSnapshot(location.id);
    if (!snapshot) {
      return {
        available: false,
        current: false,
        forDate: null,
        generatedAt: null,
        appointmentCount: null,
      };
    }
    const zone = location.timeZone;
    const today =
      zone !== null && isValidTimeZone(zone)
        ? civilDateIn(this.clock(), zone)
        : null;
    return {
      available: true,
      current: snapshot.forDate === today,
      forDate: snapshot.forDate,
      generatedAt: snapshot.generatedAt,
      appointmentCount: snapshot.appointmentCount,
    };
  }

  /** La última copia nocturna guardada, tal cual se generó. */
  async downloadNightly(
    locationId: string,
    allowed: AllowedLocations,
  ): Promise<ContingencyPdf> {
    const location = await this.location(locationId, allowed);
    const snapshot = await this.repo.findSnapshot(location.id);
    const file = snapshot ? await this.storage.read(snapshot.storageKey) : null;
    if (!snapshot || !file) {
      throw new NotFoundException(CONTINGENCY_NIGHTLY_MISSING_MESSAGE);
    }
    return {
      pdf: file.bytes,
      fileName: fileNameOf(location.name, snapshot.forDate),
      forDate: snapshot.forDate,
      generatedAt: snapshot.generatedAt,
      appointmentCount: snapshot.appointmentCount,
    };
  }

  /**
   * El trabajo nocturno de UNA sede (con la clínica del trabajo en el
   * contexto): genera, guarda el PDF y sobrescribe la fila. Una sede retirada
   * o desactivada desde el barrido se salta sin fallar.
   */
  async generateNightly(locationId: string): Promise<'GENERATED' | 'SKIPPED'> {
    const location = await this.repo.findLocation(locationId);
    if (!location) return 'SKIPPED';
    const result = await this.generate(location);
    const storageKey = contingencyStorageKey(location.tenantId, location.id);
    await this.storage.save(storageKey, result.pdf, PDF_TYPE);
    await this.repo.saveSnapshot({
      locationId: location.id,
      forDate: result.forDate,
      generatedAt: result.generatedAt,
      appointmentCount: result.appointmentCount,
      sizeBytes: result.pdf.length,
      storageKey,
    });
    this.logger.log({
      event: 'contingency.nightly_generated',
      locationId: location.id,
      forDate: result.forDate,
      appointments: result.appointmentCount,
    });
    return 'GENERATED';
  }
}

/**
 * Barrido horario (DX-339): por clínica, las sedes con zona y formato cuya
 * copia no es la de hoy en SU zona y en las que ya son las 02:00 o más tarde
 * reciben su trabajo `contingency.nightly-agenda`. La clave idempotente por
 * sede y día evita duplicados entre ticks; una noche perdida se recupera en
 * el tick siguiente del mismo día.
 */
@Injectable()
export class ContingencyNightlySweep {
  private readonly logger = new Logger('ContingencyAgenda');

  constructor(
    @Inject(CONTINGENCY_AGENDA_REPOSITORY)
    private readonly repo: ContingencyAgendaRepository,
    @Inject(CONTINGENCY_JOB_QUEUE) private readonly queue: ContingencyJobQueue,
    @Inject(CONTINGENCY_AGENDA_CLOCK) private readonly clock: ContingencyClock,
  ) {}

  async run(): Promise<{ queued: number }> {
    const now = this.clock();
    let queued = 0;
    let failed = 0;
    for (const tenantId of await this.repo.tenantIds()) {
      try {
        for (const c of await this.repo.nightlyCandidates(tenantId)) {
          const today = civilDateIn(now, c.timeZone);
          const due = zonedWallTime(
            today,
            CONTINGENCY_NIGHTLY_LOCAL_HOUR * 60,
            c.timeZone,
          );
          if (now < due || c.lastForDate === today) continue;
          await this.queue.enqueue(
            CONTINGENCY_NIGHTLY_JOB,
            { locationId: c.locationId },
            {
              tenantId,
              idempotencyKey: `contingency.nightly:${c.locationId}:${today}`,
            },
          );
          queued += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.warn({
          event: 'contingency.nightly_sweep_failed',
          tenantId,
          error: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    if (failed > 0) {
      throw new Error(
        `Barrido de agendas de contingencia falló en ${failed} clínica(s)`,
      );
    }
    return { queued };
  }
}
