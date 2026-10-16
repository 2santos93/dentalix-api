import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  ClaimedOutboxEmail,
  EMAIL_OUTBOX_REPOSITORY,
} from '../domain/ports/email-outbox-repository.port';
import type { EmailOutboxRepository } from '../domain/ports/email-outbox-repository.port';
import { MAILER } from '../domain/ports/mailer.port';
import type { Mailer } from '../domain/ports/mailer.port';
import { EmailPayloadCipher } from '../infrastructure/email-payload-cipher';
import { MAIL_CONFIG } from '../infrastructure/mail-config';
import type { MailConfig } from '../infrastructure/mail-config';
import {
  MAX_EMAIL_ATTEMPTS,
  describeDeliveryError,
  retryDelayMs,
} from './retry-policy';

/** Cuánto espera el apagado a que termine la tanda en vuelo. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Despachador EN PROCESO del registro de envíos (hasta que exista la cola
 * genérica de DX-085). Nunca corre dentro de una petición:
 *
 * - `kick()` lo despierta tras el commit de un encolado (no espera nada: la
 *   petición responde sin esperar al proveedor);
 * - un barrido cada MAIL_DISPATCH_INTERVAL_MS recoge lo que quedó (reintentos
 *   vencidos, réplicas que murieron a mitad, emails encolados por otra
 *   réplica). 0 lo apaga (tests).
 *
 * Cada tanda reclama filas con FOR UPDATE SKIP LOCKED (seguro con varias
 * réplicas: ninguna fila se reclama dos veces) y las envía. Un fallo del
 * proveedor suma el intento y reprograma con backoff exponencial; el 3.er
 * fallo la deja FAILED. Nada de esto llega al usuario como error.
 */
@Injectable()
export class EmailDispatcher
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('Email');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(
    @Inject(EMAIL_OUTBOX_REPOSITORY)
    private readonly repo: EmailOutboxRepository,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly cipher: EmailPayloadCipher,
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.verifyAccess();
    if (this.config.dispatchIntervalMs <= 0) return;
    this.timer = setInterval(() => this.kick(), this.config.dispatchIntervalMs);
    // El barrido no mantiene vivo el proceso por sí solo.
    this.timer.unref();
    this.kick();
  }

  /**
   * Revisión D4: si el rol de la app no puede ejecutar las funciones del
   * despachador o su owner no se salta la RLS, ningún email saldría nunca y
   * la web diría «Pendiente» para siempre. En producción la API NO ARRANCA
   * (como con la configuración inválida: es un fallo de despliegue, no un
   * corte pasajero de la BD, que es lo que mide /health/ready). Fuera de
   * producción, una línea `error`. Si la BD no responde en este momento, no
   * se decide nada aquí (eso sí es cosa de la readiness).
   */
  private async verifyAccess(): Promise<void> {
    let access: { executable: boolean; ownerBypassesRls: boolean };
    try {
      access = await this.repo.dispatcherAccess();
    } catch (err) {
      this.logger.warn({
        event: 'email.dispatcher_check_failed',
        error: describeDeliveryError(err),
      });
      return;
    }
    if (access.executable && access.ownerBypassesRls) return;
    const hint = !access.executable
      ? 'El rol de la app no puede ejecutar email_outbox_claim/settle/enqueue_platform: concédele EXECUTE (README, «Email transaccional»).'
      : 'El owner de las funciones email_outbox_* no se salta la RLS: tiene que ser superusuario o tener BYPASSRLS (el mismo requisito que las migraciones, DX-025).';
    this.logger.error({ event: 'email.dispatcher_misconfigured', hint });
    if (this.config.production) {
      throw new Error(
        `Configuración inválida; la API no arranca:\n- Despachador de email sin acceso. ${hint}`,
      );
    }
  }

  /** Apagado ordenado: sin barridos nuevos y esperando la tanda en vuelo. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.running) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        this.running,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        }),
      ]);
      clearTimeout(grace);
    }
    this.mailer.close?.();
  }

  /**
   * Despierta al despachador sin esperarlo. Si ya está trabajando, apunta
   * otra vuelta al terminar (lo encolado mientras tanto no espera al barrido).
   */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        this.kick();
      }
    });
  }

  /** Para tests y el seed: resuelve cuando no queda ninguna vuelta en curso. */
  async whenIdle(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (!this.stopped) {
        const claimed = await this.dispatchBatch();
        if (claimed < this.config.batchSize) break;
      }
    } catch (err) {
      // La BD caída no tumba nada: el próximo barrido lo vuelve a intentar.
      this.logger.warn({
        event: 'email.dispatch_failed',
        error: describeDeliveryError(err),
      });
    }
  }

  /** Una tanda: reclama, envía y cierra cada intento. Devuelve cuántas reclamó. */
  async dispatchBatch(): Promise<number> {
    const claimed = await this.repo.claimDue(
      this.config.batchSize,
      this.config.leaseSeconds,
    );
    await Promise.all(claimed.map((email) => this.deliver(email)));
    return claimed.length;
  }

  private async deliver(email: ClaimedOutboxEmail): Promise<void> {
    // Una fila que ya gastó sus intentos (la réplica murió durante el último)
    // no se vuelve a enviar.
    if (email.attempts > MAX_EMAIL_ATTEMPTS || !email.payload) {
      await this.finish(email, {
        status: 'FAILED',
        lastError: email.payload ? 'MaxAttemptsExceeded' : 'MissingPayload',
      });
      return;
    }

    let message;
    try {
      message = this.cipher.decrypt(email.payload);
    } catch {
      // Otra clave (MAIL_ENCRYPTION_KEY cambió o era efímera) o fila alterada:
      // reintentar no lo arregla.
      await this.finish(email, { status: 'FAILED', lastError: 'DecryptError' });
      return;
    }

    try {
      await this.mailer.send(message);
    } catch (err) {
      const lastError = describeDeliveryError(err);
      if (email.attempts >= MAX_EMAIL_ATTEMPTS) {
        await this.finish(email, { status: 'FAILED', lastError });
      } else {
        await this.finish(email, {
          status: 'PENDING',
          lastError,
          nextAttemptAt: new Date(
            Date.now() + retryDelayMs(email.attempts, this.config.retryBaseMs),
          ),
        });
      }
      return;
    }
    await this.finish(email, { status: 'SENT' });
  }

  private async finish(
    email: ClaimedOutboxEmail,
    outcome:
      | { status: 'SENT' }
      | { status: 'FAILED'; lastError: string }
      | { status: 'PENDING'; lastError: string; nextAttemptAt: Date },
  ): Promise<void> {
    await this.repo.settle(email.id, email.attempts, outcome);
    const fields = {
      event: `email.${outcome.status.toLowerCase()}`,
      outboxId: email.id,
      tenantId: email.tenantId,
      attempt: email.attempts,
      ...(outcome.status === 'SENT' ? {} : { error: outcome.lastError }),
      ...(outcome.status === 'PENDING'
        ? { nextAttemptAt: outcome.nextAttemptAt.toISOString() }
        : {}),
    };
    if (outcome.status === 'SENT') {
      this.logger.log(fields);
    } else {
      this.logger.warn(fields);
    }
  }
}
