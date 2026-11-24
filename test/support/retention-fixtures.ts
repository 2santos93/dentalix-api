import { AppointmentStatus, PrismaClient } from '@prisma/client';
import { ReportSeeder } from './reports-fixtures';

/**
 * DX-260 · Datos semilla conocidos de «Retención», con fechas FIJAS (sedes en
 * America/Caracas, UTC−4 sin horario de verano; todas las citas en días
 * laborables salvo el borde de zona de P11) y el «ahora» del informe en
 * `RETENTION_NOW` (el spec lo inyecta en RETENTION_CLOCK): nada depende del
 * reloj real.
 *
 * Período 2026-01-01..2026-06-30, 18 meses: «activo al inicio» = alguna
 * atendida desde el 2024-07-01; «activo al final» = alguna desde el
 * 2025-01-01. Resultado: 10 activos al inicio, 3 nuevos, 2 perdidos, 11
 * activos al final, 0 recuperados, 1 nuevo sin regreso y 80 % de retención.
 *
 *  - P1–P5 (Norte, Dra. Norte): atendidos el 2025-03-10 → activos y conservados.
 *  - P6: 2025-03-10 en Norte y 2026-02-10 en SUR con el Dr. Sur → se atribuye
 *    a Sur / Dr. Sur (su última atendida).
 *  - P7: atendido el 2024-07-01 a las 08:00 de Caracas, el MISMO día del
 *    corte → activo al inicio; sin nada después → perdido.
 *  - P8: 2024-09-02 y una cita AGENDADA el 2026-08-03 (posterior a «ahora»)
 *    → no es perdido aunque su última atendida es anterior al corte; activo
 *    al final.
 *  - P9: 2024-11-05; después, una cancelada, un «No asistió», una atendida
 *    BORRADA y una agendada ya pasada (no es futura) → perdido.
 *  - P10: 2025-12-31 a las 23:00 de Caracas (2026-01-01 03:00 UTC) → activo
 *    al inicio (el día es el de la sede, no el UTC) y conservado.
 *  - P11: 2024-06-30 a las 23:00 de Caracas (2024-07-01 03:00 UTC) → un día
 *    antes del corte: no entra en ninguna cifra.
 *  - N1: primera atendida 2026-02-02 y otra 2026-03-02 → nuevo que volvió.
 *  - N2: 2026-04-06 y una agendada el 2026-09-07 → nuevo con cita futura.
 *  - N3: 2026-05-04 y una cancelada el 2026-06-01; baja de avisos (DX-128)
 *    → nuevo sin regreso; cuenta, pero sin wa.me.
 *  - S1: historia suprimida (DX-039) y S2: archivado, con citas atendidas en
 *    el período → no cuentan.
 */
export const RETENTION_PERIOD = { from: '2026-01-01', to: '2026-06-30' };
export const RETENTION_NOW = new Date('2026-07-15T15:00:00Z');

export interface RetentionClinic {
  tenantId: string;
  norte: string;
  sur: string;
  drNorte: string;
  drSur: string;
  patients: Record<string, string>;
}

const at = (iso: string) => new Date(iso);

export async function seedRetentionClinic(
  raw: PrismaClient,
  tenantId: string,
  suffix: string,
): Promise<RetentionClinic> {
  const seed = new ReportSeeder(raw, tenantId);
  const norte = await seed.location('Sede Norte');
  const sur = await seed.location('Sede Sur');
  const drNorte = await seed.provider(`Dra. Norte ${suffix}`);
  const drSur = await seed.provider(`Dr. Sur ${suffix}`);
  const patients: Record<string, string> = {};
  for (const key of [
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'P6',
    'P7',
    'P8',
    'P9',
    'P10',
    'P11',
    'N1',
    'N2',
    'N3',
    'S1',
    'S2',
  ]) {
    const patient = await raw.patient.create({
      data: {
        tenantId,
        firstName: 'Paciente',
        lastName: `${key} ${suffix}`,
        phone: '+58 412 555 0101',
      },
      select: { id: true },
    });
    patients[key] = patient.id;
  }
  const used = new Map<string, number>();
  const visit = async (
    key: string,
    start: string,
    status: AppointmentStatus = 'COMPLETED',
    where: { locationId?: string; providerId?: string; deleted?: boolean } = {},
  ) => {
    // Las citas de la misma hora van una tras otra (10 min): ninguna se
    // solapa en la agenda del profesional y los bordes de zona quedan exactos.
    const n = used.get(start) ?? 0;
    used.set(start, n + 1);
    const begin = new Date(at(start).getTime() + n * 10 * 60_000);
    await raw.appointment.create({
      data: {
        tenantId,
        locationId: where.locationId ?? norte,
        patientId: patients[key],
        providerId: where.providerId ?? drNorte,
        start: begin,
        end: new Date(begin.getTime() + 10 * 60_000),
        status,
        ...(status === 'CANCELLED'
          ? {
              cancelledAt: new Date(begin.getTime() - 86_400_000),
              cancelledByKind: 'PATIENT_LINK' as const,
              noticeMinutes: 1440,
              lateCancellation: false,
            }
          : {}),
        ...(where.deleted ? { deletedAt: at('2026-06-02T15:00:00Z') } : {}),
      },
    });
  };

  for (const key of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    await visit(key, '2025-03-10T14:00:00Z');
  }
  await visit('P6', '2026-02-10T14:00:00Z', 'COMPLETED', {
    locationId: sur,
    providerId: drSur,
  });
  await visit('P7', '2024-07-01T12:00:00Z');
  await visit('P8', '2024-09-02T14:00:00Z');
  await visit('P8', '2026-08-03T14:00:00Z', 'SCHEDULED');
  await visit('P9', '2024-11-05T14:00:00Z');
  await visit('P9', '2026-03-02T14:00:00Z', 'CANCELLED');
  await visit('P9', '2026-04-01T14:00:00Z', 'NO_SHOW');
  await visit('P9', '2026-05-01T14:00:00Z', 'COMPLETED', { deleted: true });
  await visit('P9', '2026-07-01T14:00:00Z', 'SCHEDULED');
  await visit('P10', '2026-01-01T03:00:00Z');
  await visit('P11', '2024-07-01T03:00:00Z');
  await visit('N1', '2026-02-02T14:00:00Z');
  await visit('N1', '2026-03-02T14:00:00Z');
  await visit('N2', '2026-04-06T14:00:00Z');
  await visit('N2', '2026-09-07T14:00:00Z', 'SCHEDULED');
  await visit('N3', '2026-05-04T14:00:00Z');
  await visit('N3', '2026-06-01T14:00:00Z', 'CANCELLED');
  await visit('S1', '2025-03-10T14:00:00Z');
  await visit('S1', '2026-02-02T14:00:00Z');
  await visit('S2', '2026-02-02T14:00:00Z');

  await raw.patient.update({
    where: { id: patients.N3 },
    data: {
      reminderOptOutAt: at('2026-05-05T15:00:00Z'),
      reminderOptOutSource: 'STAFF',
    },
  });
  await raw.patient.update({
    where: { id: patients.S1 },
    data: { partiallySuppressedAt: at('2026-06-20T15:00:00Z') },
  });
  await raw.patient.update({
    where: { id: patients.S2 },
    data: { deletedAt: at('2026-06-20T15:00:00Z') },
  });
  return { tenantId, norte, sur, drNorte, drSur, patients };
}

/** Las cifras esperadas de `seedRetentionClinic` (18 meses, toda la clínica). */
export const RETENTION_EXPECTED_TOTALS = {
  activeAtStart: 10,
  newPatients: 3,
  lost: 2,
  activeAtEnd: 11,
  reactivated: 0,
  newNoReturn: 1,
  retentionRate: 80,
};

/** Qué pacientes forma cada lista (toda la clínica, 18 meses). */
export const RETENTION_EXPECTED_SEGMENTS: Record<string, string[]> = {
  active_start: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10'],
  new: ['N1', 'N2', 'N3'],
  lost: ['P7', 'P9'],
  active_end: [
    'P1',
    'P2',
    'P3',
    'P4',
    'P5',
    'P6',
    'P8',
    'P10',
    'N1',
    'N2',
    'N3',
  ],
  reactivated: [],
  new_no_return: ['N3'],
};
