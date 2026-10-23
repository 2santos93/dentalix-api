import type { ReminderOptOutSource } from '@prisma/client';

// Como el resto del módulo: sin `tenantId` en los inputs. El tenant sale del
// contexto (host en la página pública, trabajo de la cola, o el que fije el
// webhook de DX-126) y todo se lee y escribe bajo RLS.

export interface OptOutLinkLookup {
  linkId: string;
  patientId: string;
  /** Nombre de pila, lo único que la página pública muestra del paciente. */
  patientFirstName: string | null;
  /** Baja vigente del paciente, o null si sigue recibiendo recordatorios. */
  optedOutAt: Date | null;
}

export interface OptOutClinicBranding {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

/** Paciente vivo con móvil, candidato a ser el que escribió «BAJA». */
export interface MobileCandidate {
  patientId: string;
  phone: string;
}

export const REMINDER_OPT_OUT_REPOSITORY = Symbol(
  'REMINDER_OPT_OUT_REPOSITORY',
);

export interface ReminderOptOutRepository {
  /** Guarda el hash de un enlace nuevo para el paciente. */
  issueLink(patientId: string, tokenHash: string): Promise<void>;
  /** null si expiró, se usó, es de otra clínica o el paciente se retiró. */
  findLinkByTokenHash(
    tokenHash: string,
    at: Date,
  ): Promise<OptOutLinkLookup | null>;
  /**
   * Registra la baja si el paciente vivo no la tenía, y marca el enlace como
   * usado. true solo si ESTA llamada la registró (idempotente y a prueba de
   * dos clics simultáneos: UPDATE condicional). null: enlace no vigente o paciente retirado.
   */
  optOut(
    patientId: string,
    input: { source: ReminderOptOutSource; at: Date; linkId?: string },
  ): Promise<boolean | null>;
  /** Borra solo expirados/usados anteriores al corte, bajo tenant/RLS. */
  purgeLinks(before: Date): Promise<number>;
  /** Pacientes vivos cuyo teléfono acaba en esos 8 dígitos (prefiltro indexado). */
  findByPhoneTail(tail: string): Promise<MobileCandidate[]>;
  /** País (ClinicCountry) de la sede principal: la viva más antigua. */
  principalLocationCountry(): Promise<string | null>;
  clinicBranding(): Promise<OptOutClinicBranding | null>;
}
