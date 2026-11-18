import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PatientAccessScope } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../../shared/public-links/public-link-token';
import { requireLocationFormat } from '../../../../shared/locations/location-regional';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import { civilDateIn } from '../../../../shared/time/civil-day';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { isMinor } from '../../../patients/domain/responsible-parties/majority-age';
import { PATIENT_ARCHIVED_MESSAGE } from '../../../../shared/patients/lock-live-patient';
import { firstNameOnly } from '../../../appointment-confirmations/application/confirmation-token';
import {
  PATIENT_ACCESS_DEFAULT_TTL_DAYS,
  PATIENT_ACCESS_LINK_NOT_FOUND_MESSAGE,
  PATIENT_ACCESS_NO_BIRTH_DATE_MESSAGE,
  PATIENT_ACCESS_NO_HOST_MESSAGE,
  buildPatientAccessUrl,
  normalizeScopes,
  patientAccessExpiresAt,
  patientAccessWhatsAppMessage,
} from '../../domain/patient-access';
import {
  PATIENT_ACCESS_REPOSITORY,
  type AccessLinkRow,
  type PatientAccessRepository,
} from '../../domain/ports/patient-access-repository.port';
import {
  PATIENT_ACCESS_CLOCK,
  type PatientAccessClock,
} from '../patient-access-clock';

export interface CreateAccessLinkInput {
  scopes: PatientAccessScope[];
  /** Días de validez (1–30); sin él, 14. */
  ttlDays?: number;
}

export interface CreatedAccessLink {
  id: string;
  /** La URL con el token: SOLO en esta respuesta (no se guarda). */
  url: string;
  expiresAt: Date;
  scopes: PatientAccessScope[];
  /** Número para `wa.me` y el texto, sin importes; null sin teléfono válido. */
  whatsapp: { phone: string; text: string } | null;
  /**
   * El paciente es menor de edad: el enlace lo recibe su responsable (los
   * datos del responsable en el portal dependen de C1; la UI avisa).
   */
  minor: boolean;
}

/**
 * «Compartir con el paciente» (DX-101): un enlace de solo lectura con los
 * apartados elegidos y su caducidad. El token solo viaja en la URL de la
 * respuesta. Exige la fecha de nacimiento del paciente: es el segundo factor
 * con que se abre.
 */
@Injectable()
export class CreateAccessLinkUseCase {
  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
  ) {}

  async execute(
    patientId: string,
    input: CreateAccessLinkInput,
    createdById: string,
    link: { protocol: string; host: string | null },
  ): Promise<CreatedAccessLink> {
    const patient = await this.repo.findPatient(patientId);
    if (!patient) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    if (patient.deletedAt)
      throw new ConflictException(PATIENT_ARCHIVED_MESSAGE);
    if (!patient.birthDate) {
      throw new ConflictException(PATIENT_ACCESS_NO_BIRTH_DATE_MESSAGE);
    }
    // El host entero se valida antes de escribir nada (safeLinkHost en el
    // controlador): uno manipulado no arma un enlace hacia otro sitio.
    if (!link.host)
      throw new BadRequestException(PATIENT_ACCESS_NO_HOST_MESSAGE);
    const scopes = normalizeScopes(input.scopes);
    if (scopes.length === 0) {
      throw new BadRequestException('Elige al menos un apartado.');
    }

    const now = this.clock();
    const expiresAt = patientAccessExpiresAt(
      now,
      input.ttlDays ?? PATIENT_ACCESS_DEFAULT_TTL_DAYS,
    );
    const token = generatePublicLinkToken();
    const url = buildPatientAccessUrl(`${link.protocol}://${link.host}`, token);
    const id = randomUUID();
    const clinic = await this.repo.clinicContext();
    // Antes de escribir: una sede sin formato da su 409 sin dejar enlace.
    const format = requireLocationFormat(clinic.location);

    await this.repo.issue({
      id,
      patientId,
      tokenHash: hashPublicLinkToken(token),
      scopes,
      expiresAt,
      createdById,
    });

    const phone = whatsAppDigits(patient.phone, clinic.phoneRegion);
    return {
      id,
      url,
      expiresAt,
      scopes,
      whatsapp: phone
        ? {
            phone,
            text: patientAccessWhatsAppMessage({
              firstName: firstNameOnly(patient.firstName),
              clinicName: clinic.clinicName,
              scopes,
              url,
              expiresAtLabel: format.longDateTime(expiresAt, clinic.timeZone),
            }),
          }
        : null,
      minor: isMinor(
        patient.birthDate,
        clinic.majorityAge,
        civilDateIn(now, clinic.timeZone),
      ),
    };
  }
}

/** `GET /patients/:id/access-links`: los vivos, con su último acceso. */
@Injectable()
export class ListAccessLinksUseCase {
  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
  ) {}

  async execute(patientId: string): Promise<AccessLinkRow[]> {
    const rows = await this.repo.listLive(patientId, this.clock());
    if (!rows) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    return rows;
  }
}

/**
 * `DELETE /patients/:id/access-links/:linkId`: revoca. Corta también la
 * sesión abierta (el guard relee el enlace en cada petición). Idempotente:
 * revocar uno ya revocado es 204; uno de otro paciente o clínica, 404.
 */
@Injectable()
export class RevokeAccessLinkUseCase {
  constructor(
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
  ) {}

  async execute(
    patientId: string,
    linkId: string,
    revokedById: string,
  ): Promise<void> {
    const outcome = await this.repo.revoke(patientId, linkId, revokedById);
    if (outcome === 'NOT_FOUND') {
      throw new NotFoundException(PATIENT_ACCESS_LINK_NOT_FOUND_MESSAGE);
    }
  }
}
