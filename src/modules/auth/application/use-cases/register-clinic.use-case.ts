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
import { PasswordService } from '../../../../shared/crypto/password.service';
import {
  REGISTRATION_NOTICE_PATH,
  REGISTRATION_TTL_HOURS,
  REGISTRATION_VERIFY_PATH,
  generateRegistrationToken,
  hashRegistrationToken,
  isWellFormedRegistrationToken,
  registrationExpiresAt,
} from '../registration-token';

export interface RegisterClinicInput {
  clinicName: string;
  subdomain: string;
  email: string;
  password: string;
  fullName: string;
  /** `<protocolo>://<host de la web>` validado (safeLinkHost) para los enlaces. */
  linkBase: string;
}

/** Qué pasó, solo para el log y los tests: NUNCA llega a la respuesta. */
export type RegisterOutcome = 'VERIFICATION_SENT' | 'EXISTING_ACCOUNT_NOTIFIED';

export const SUBDOMAIN_TAKEN = 'Ese subdominio ya está en uso. Elige otro.';

export const REGISTRATION_LINK_INVALID =
  'El enlace para confirmar el registro no es válido o ya se usó. Si no puedes entrar, vuelve a registrarte.';
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
  ) {}

  /**
   * Parte síncrona (subdominio libre y hash, igual para todos) y el resto en
   * segundo plano. Resuelve cuando ya se puede responder; nunca depende del
   * email.
   */
  async accept(input: RegisterClinicInput): Promise<void> {
    const subdomain = input.subdomain.trim().toLowerCase();
    if (await this.repo.findTenantBySubdomain(subdomain)) {
      throw new ConflictException(SUBDOMAIN_TAKEN);
    }
    const passwordHash = await this.password.hash(input.password);
    this.process({ ...input, subdomain }, passwordHash).catch(
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
    const subdomain = input.subdomain.trim().toLowerCase();
    if (await this.repo.findTenantBySubdomain(subdomain)) {
      throw new ConflictException(SUBDOMAIN_TAKEN);
    }
    const passwordHash = await this.password.hash(input.password);
    return this.process({ ...input, subdomain }, passwordHash);
  }

  private async process(
    input: RegisterClinicInput,
    passwordHash: string,
  ): Promise<RegisterOutcome> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.repo.findUserByEmail(email);
    if (existing) {
      await this.notifier.sendExistingAccountNotice({
        to: email,
        userName: existing.fullName,
        loginUrl: `${input.linkBase}${REGISTRATION_NOTICE_PATH}`,
      });
      return this.done('EXISTING_ACCOUNT_NOTIFIED');
    }

    const token = generateRegistrationToken();
    const fullName = input.fullName.trim();
    await this.pending.savePending({
      email,
      clinicName: input.clinicName.trim(),
      subdomain: input.subdomain,
      fullName,
      passwordHash,
      tokenHash: hashRegistrationToken(token),
      expiresAt: registrationExpiresAt(new Date()),
    });
    await this.notifier.sendVerification({
      to: email,
      userName: fullName,
      verifyUrl: `${input.linkBase}${REGISTRATION_VERIFY_PATH}/${token}`,
      expiresInHours: REGISTRATION_TTL_HOURS,
    });
    return this.done('VERIFICATION_SENT');
  }

  /**
   * Abre el enlace del email: crea la clínica, su sede y su dueño (ADMIN) con
   * el email ya verificado. Quien llega aquí controla el buzón, así que los
   * errores pueden ser concretos.
   */
  async verify(
    token: string,
  ): Promise<{ tenantId: string; userId: string; subdomain: string }> {
    if (!isWellFormedRegistrationToken(token)) {
      throw new NotFoundException(REGISTRATION_LINK_INVALID);
    }
    const record = await this.pending.findPendingByTokenHash(
      hashRegistrationToken(token),
    );
    if (!record) {
      throw new NotFoundException(REGISTRATION_LINK_INVALID);
    }
    if (record.expiresAt.getTime() <= Date.now()) {
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
