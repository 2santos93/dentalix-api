import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AUTH_REPOSITORY } from '../../domain/ports/auth-repository.port';
import type { AuthRepository } from '../../domain/ports/auth-repository.port';
import { REGISTRATION_REPOSITORY } from '../../domain/ports/registration-repository.port';
import type { RegistrationRepository } from '../../domain/ports/registration-repository.port';
import { REGISTRATION_NOTIFIER } from '../../domain/ports/registration-notifier.port';
import type { RegistrationNotifier } from '../../domain/ports/registration-notifier.port';
import {
  DUMMY_PASSWORD_HASH,
  PasswordService,
} from '../../../../shared/crypto/password.service';
import { COUNTRY_WHITELIST } from '../../../locations/domain/ports/country-whitelist.port';
import type { CountryWhitelist } from '../../../locations/domain/ports/country-whitelist.port';
import { CURRENCY_WHITELIST } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { CurrencyWhitelist } from '../../../treatment-plans/domain/ports/currency-whitelist.port';
import type { ClinicLocationSettings } from '../../domain/ports/auth-repository.port';
import type { AuditRequestMeta } from '../../../audit/domain/audit-request-context';
import {
  type RegistrationLocationInput,
  registrationLocation,
} from '../registration-location';
import {
  REGISTRATION_NOTICE_PATH,
  REGISTRATION_TTL_HOURS,
  REGISTRATION_VERIFY_PATH,
  generateRegistrationToken,
  hashRegistrationToken,
  isWellFormedRegistrationToken,
  registrationExpiresAt,
} from '../registration-token';

export interface RegisterClinicInput extends RegistrationLocationInput {
  clinicName: string;
  subdomain: string;
  email: string;
  password: string;
  fullName: string;
  /** `<protocolo>://<host de la web>` validado (safeLinkHost) para los enlaces. */
  linkBase: string;
}

/**
 * Qué pasó, solo para el log y los tests: NUNCA llega a la respuesta.
 * - RECIPIENT_QUOTA_REACHED: el destinatario ya recibió el máximo de emails
 *   del registro (enfriamiento o diario, DX-144); no se envía ni guarda nada.
 * - PENDING_KEPT: ya había un pendiente vigente más joven que el
 *   enfriamiento; se conserva (y su enlace sigue valiendo) y no se envía nada.
 */
export type RegisterOutcome =
  | 'VERIFICATION_SENT'
  | 'EXISTING_ACCOUNT_NOTIFIED'
  | 'RECIPIENT_QUOTA_REACHED'
  | 'PENDING_KEPT';

export const SUBDOMAIN_TAKEN = 'Ese subdominio ya está en uso. Elige otro.';

// Genérico a propósito (DX-029, R2): no distingue un enlace inválido o usado
// de una contraseña que no es la del registro.
export const REGISTRATION_LINK_INVALID =
  'No pudimos confirmar el registro: el enlace no es válido o ya se usó, o la contraseña no es la que elegiste al registrarte. Revísala o vuelve a registrarte.';
export const REGISTRATION_LINK_EXPIRED = `El enlace para confirmar el registro caducó (vale ${REGISTRATION_TTL_HOURS} horas). Vuelve a registrarte para recibir uno nuevo.`;
export const REGISTRATION_EMAIL_TAKEN =
  'Este correo ya tiene una cuenta en Dentalix. Inicia sesión en tu clínica o recupera tu contraseña.';

/**
 * Registro de una clínica sin enumeración de usuarios ni pre-secuestro de
 * cuentas (DX-029, SEC-006/SEC-007).
 *
 * `POST /auth/register` responde SIEMPRE lo mismo (202 con un mensaje
 * genérico) exista o no el email, y NO crea nada todavía:
 * - email nuevo → se guarda un registro pendiente y se envía un enlace de
 *   verificación; la clínica y su dueño se crean al abrirlo (`verify`), con
 *   `emailVerifiedAt` puesto. Nadie puede quedarse con un email ajeno.
 * - email ya registrado → no se crea nada y el TITULAR recibe un aviso.
 *
 * Tiempo: el hash argon2 de la contraseña se calcula en los dos casos ANTES
 * de responder, y la búsqueda del email y el envío corren en segundo plano
 * (`accept`), así que ni el cuerpo ni el tiempo de respuesta dependen de que
 * el email exista. El subdominio sí se comprueba en línea: es público (es el
 * host de la clínica) y no dice nada de ninguna persona.
 *
 * Sin relé de emails (DX-144, SEC-034): en segundo plano, y por eso sin que
 * cambie la respuesta, cada destinatario recibe como mucho un email del
 * registro por enfriamiento y unos pocos al día (contados en la BD por el
 * hash del destinatario, valen entre réplicas). El email de verificación no
 * lleva nada escrito por el solicitante, y un alta repetida dentro del
 * enfriamiento no reemplaza el pendiente de quien se está registrando.
 */
@Injectable()
export class RegisterClinicUseCase {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(AUTH_REPOSITORY) private readonly repo: AuthRepository,
    @Inject(REGISTRATION_REPOSITORY)
    private readonly pending: RegistrationRepository,
    @Inject(REGISTRATION_NOTIFIER)
    private readonly notifier: RegistrationNotifier,
    private readonly password: PasswordService,
    @Inject(CURRENCY_WHITELIST)
    private readonly currencies: CurrencyWhitelist,
    @Inject(COUNTRY_WHITELIST)
    private readonly countries: CountryWhitelist,
  ) {}

  /**
   * Parte síncrona (subdominio libre y hash, igual para todos) y el resto en
   * segundo plano. Resuelve cuando ya se puede responder; nunca depende del
   * email.
   */
  async accept(input: RegisterClinicInput): Promise<void> {
    // G1: la sede se valida antes que nada (es un 400 de los datos enviados,
    // igual para todos; no dice nada del email).
    const location = await registrationLocation(
      input,
      this.currencies,
      this.countries,
    );
    const subdomain = input.subdomain.trim().toLowerCase();
    if (await this.repo.findTenantBySubdomain(subdomain)) {
      throw new ConflictException(SUBDOMAIN_TAKEN);
    }
    const passwordHash = await this.password.hash(input.password);
    this.process({ ...input, subdomain }, passwordHash, location).catch(
      (err: unknown) => {
        // Solo el tipo de error: el mensaje de Prisma puede llevar el email.
        this.logger.warn({
          event: 'registration.request_failed',
          error: err instanceof Error ? err.constructor.name : typeof err,
        });
      },
    );
  }

  /** Todo el registro esperando el resultado (lo usan los tests). */
  async execute(input: RegisterClinicInput): Promise<RegisterOutcome> {
    const location = await registrationLocation(
      input,
      this.currencies,
      this.countries,
    );
    const subdomain = input.subdomain.trim().toLowerCase();
    if (await this.repo.findTenantBySubdomain(subdomain)) {
      throw new ConflictException(SUBDOMAIN_TAKEN);
    }
    const passwordHash = await this.password.hash(input.password);
    return this.process({ ...input, subdomain }, passwordHash, location);
  }

  private async process(
    input: RegisterClinicInput,
    passwordHash: string,
    location: ClinicLocationSettings,
  ): Promise<RegisterOutcome> {
    const email = input.email.trim().toLowerCase();
    // Antes de guardar nada: con el tope alcanzado, ni siquiera se reemplaza
    // el pendiente (su enlace, ya enviado, sigue valiendo).
    if (!(await this.notifier.withinRecipientQuota(email))) {
      return this.done('RECIPIENT_QUOTA_REACHED');
    }
    const existing = await this.repo.findUserByEmail(email);
    if (existing) {
      const sent = await this.notifier.sendExistingAccountNotice({
        to: email,
        userName: existing.fullName,
        loginUrl: `${input.linkBase}${REGISTRATION_NOTICE_PATH}`,
      });
      return this.done(
        sent ? 'EXISTING_ACCOUNT_NOTIFIED' : 'RECIPIENT_QUOTA_REACHED',
      );
    }

    const token = generateRegistrationToken();
    const now = new Date();
    const saved = await this.pending.savePending({
      email,
      clinicName: input.clinicName.trim(),
      subdomain: input.subdomain,
      fullName: input.fullName.trim(),
      passwordHash,
      tokenHash: hashRegistrationToken(token),
      expiresAt: registrationExpiresAt(now),
      location,
      replaceCreatedBefore: new Date(
        now.getTime() - this.notifier.recipientCooldownSeconds * 1000,
      ),
    });
    if (!saved) return this.done('PENDING_KEPT');
    const sent = await this.notifier.sendVerification({
      to: email,
      verifyUrl: `${input.linkBase}${REGISTRATION_VERIFY_PATH}/${token}`,
      expiresInHours: REGISTRATION_TTL_HOURS,
    });
    return this.done(sent ? 'VERIFICATION_SENT' : 'RECIPIENT_QUOTA_REACHED');
  }

  /**
   * Abre el enlace del email: crea la clínica, su sede (con la moneda, la zona
   * y el formato del registro, G1) y su dueño (ADMIN) con el email ya
   * verificado. Un enlace de una réplica anterior a G1 (pendiente sin sede)
   * caduca (410) sin consumirse (DX-312, R7). Exige ADEMÁS la contraseña
   * elegida al registrarse: quien abre el enlace controla el buzón y quien la
   * conoce es quien pidió el alta, así nadie convierte en suya una cuenta con
   * un email ajeno porque la víctima pulse «Confirmar» en un correo que no
   * pidió (pre-secuestro por clic engañado). Enlace inválido/usado y
   * contraseña errónea dan el MISMO 404 genérico, y en los dos casos se
   * ejecuta un argon2 (hash ficticio si no hay pendiente). Superado eso, los
   * errores pueden ser concretos.
   *
   * DX-359: el alta queda auditada (CLINIC_REGISTERED) en su transacción;
   * `request` es desde dónde se abrió el enlace.
   */
  async verify(
    token: string,
    password: string,
    request: AuditRequestMeta,
  ): Promise<{ tenantId: string; userId: string; subdomain: string }> {
    const record = isWellFormedRegistrationToken(token)
      ? await this.pending.findPendingByTokenHash(hashRegistrationToken(token))
      : null;
    const passwordMatches = await this.password.verify(
      password,
      record?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!record || !passwordMatches) {
      throw new NotFoundException(REGISTRATION_LINK_INVALID);
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new GoneException(REGISTRATION_LINK_EXPIRED);
    }
    // Un pendiente sin sede (forma legada de una réplica anterior) ya no puede
    // crear una clínica: caduca sin consumirlo y sin crear nada (DX-312, R7).
    if (record.location === null) {
      throw new GoneException(REGISTRATION_LINK_EXPIRED);
    }
    if (await this.repo.findTenantBySubdomain(record.subdomain)) {
      throw new ConflictException(
        'Mientras confirmabas, otra clínica tomó ese subdominio. Vuelve a registrarte con otro.',
      );
    }
    if (await this.repo.findUserByEmail(record.email)) {
      throw new ConflictException(REGISTRATION_EMAIL_TAKEN);
    }
    if (!(await this.pending.consumePending(record.id))) {
      throw new NotFoundException(REGISTRATION_LINK_INVALID);
    }

    try {
      const created = await this.repo.createClinicWithOwner({
        clinicName: record.clinicName,
        subdomain: record.subdomain,
        email: record.email,
        passwordHash: record.passwordHash,
        fullName: record.fullName,
        emailVerifiedAt: new Date(),
        location: record.location,
        // DX-359: CLINIC_REGISTERED en la transacción del alta.
        request,
      });
      this.logger.log({
        event: 'registration.completed',
        tenantId: created.tenantId,
        userId: created.userId,
      });
      return { ...created, subdomain: record.subdomain };
    } catch (error) {
      // Carrera check-then-create: los índices únicos de tenants/users son la
      // fuente de verdad.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ese subdominio o ese correo ya están en uso. Vuelve a registrarte.',
        );
      }
      throw error;
    }
  }

  // Sin email ni token: el resultado basta para operar.
  private done(outcome: RegisterOutcome): RegisterOutcome {
    this.logger.log({ event: 'registration.requested', outcome });
    return outcome;
  }
}
