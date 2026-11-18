export const NEW_LOGIN_NOTIFIER = Symbol('NEW_LOGIN_NOTIFIER');

/** DX-137: el aviso «Nuevo inicio de sesión» (con el enlace «No fui yo»). */
export interface NewLoginNotice {
  tenantId: string;
  userId: string;
  to: string;
  userName: string;
  /** Ya resumido y truncada: nunca el user-agent ni la IP completos. */
  deviceLabel: string;
  ipPrefix: string | null;
  at: Date;
  /** Token del enlace en claro: viaja SOLO en el email. */
  token: string;
  expiresInHours: number;
}

export interface NewLoginNotifier {
  send(notice: NewLoginNotice): Promise<void>;
}
