import { LoggerService } from '@nestjs/common';
import { LogConfig, LogLevelName } from './log-config';
import { redactSensitive } from './redact';
import { currentRequestId } from './request-context';

export type EmitLevel = Exclude<LogLevelName, 'silent'>;

/** Destino de las líneas ya formateadas (con su `\n`). */
export type LogSink = (stream: 'stdout' | 'stderr', line: string) => void;

const SEVERITY: Record<LogLevelName, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const processSink: LogSink = (stream, line) => {
  process[stream].write(line);
};

/**
 * En formato pretty el mensaje va tal cual en la línea: sus saltos se
 * escapan para que un evento sea siempre UNA línea y nadie pueda fabricar
 * otra (en JSON ya los escapa JSON.stringify). El stack sí va debajo.
 */
const escapeLineBreaks = (text: string): string =>
  text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');

/** Un stack de V8: "Nombre: mensaje\n    at ...". */
const looksLikeStack = (value: string): boolean => /\n\s+at /.test(value);

/**
 * Logger de la API (DX-023), sin dependencias: implementa el LoggerService de
 * Nest (main.ts lo instala con `app.useLogger`, así que los `new Logger(...)`
 * de toda la app también pasan por aquí) y añade `entry()` para eventos con
 * campos estructurados, como la línea de acceso.
 *
 * Cada evento es UNA línea: JSON (`time`, `level`, `context`, `requestId`,
 * `msg`, campos y, en errores, `stack`) o, con LOG_FORMAT=pretty, texto
 * legible. El request id sale del contexto de la petición en curso. Los
 * campos pasan por `redactSensitive`: una cabecera Authorization o una
 * contraseña nunca se escriben aunque alguien las pase por error.
 */
export class AppLogger implements LoggerService {
  constructor(
    private readonly config: LogConfig,
    private readonly sink: LogSink = processSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isEnabled(level: EmitLevel): boolean {
    return SEVERITY[level] <= SEVERITY[this.config.level];
  }

  /** Evento estructurado: `fields` van tal cual (redactados) a la línea. */
  entry(
    level: EmitLevel,
    context: string,
    msg: string,
    fields: Record<string, unknown> = {},
    stack?: string,
  ): void {
    if (!this.isEnabled(level)) return;
    const requestId = currentRequestId();
    const time = this.now().toISOString();
    const safeFields = redactSensitive(fields) as Record<string, unknown>;
    const stream = level === 'error' ? 'stderr' : 'stdout';
    if (this.config.format === 'pretty') {
      const pairs = Object.entries({
        ...(requestId ? { requestId } : {}),
        ...safeFields,
      }).map(([key, value]) =>
        key === 'requestId'
          ? `${key}=${requestId}`
          : `${key}=${JSON.stringify(value)}`,
      );
      const head = [time, level.toUpperCase().padEnd(5), `[${context}]`]
        .concat(msg ? [escapeLineBreaks(msg)] : [], pairs)
        .join(' ');
      this.sink(stream, stack ? `${head}\n${stack}\n` : `${head}\n`);
      return;
    }
    // El sobre va después de los campos: un campo no puede falsear el nivel,
    // la hora ni el request id de la línea.
    const event: Record<string, unknown> = {
      ...safeFields,
      time,
      level,
      context,
      ...(requestId ? { requestId } : {}),
      msg,
      ...(stack ? { stack } : {}),
    };
    this.sink(stream, `${JSON.stringify(event)}\n`);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  /** Firma de Nest: `error(mensaje, stack?, contexto?)`. */
  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params, true);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params, true);
  }

  private write(
    level: EmitLevel,
    message: unknown,
    params: unknown[],
    withStack = false,
  ): void {
    if (!this.isEnabled(level)) return;
    // Nest pone el contexto del `new Logger(ctx)` como último parámetro.
    const last = params.at(-1);
    let context = 'App';
    let stack: string | undefined;
    if (withStack && params.length === 1 && typeof last === 'string') {
      if (looksLikeStack(last)) stack = last;
      else context = last;
    } else {
      if (typeof last === 'string' && params.length > 0) context = last;
      const first = params[0];
      if (withStack && params.length > 1 && typeof first === 'string') {
        stack = first;
      }
    }

    if (message instanceof Error) {
      this.entry(level, context, message.message, {}, stack ?? message.stack);
    } else if (message !== null && typeof message === 'object') {
      this.entry(level, context, '', message as Record<string, unknown>, stack);
    } else {
      this.entry(level, context, String(message), {}, stack);
    }
  }
}
