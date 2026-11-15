import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from '../../../../shared/crypto/token.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const header = request.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Falta la sesión: inicia sesión.');
    }
    try {
      request.user = await this.tokens.verifyAccess(
        header.slice('Bearer '.length),
      );
      return true;
    } catch {
      throw new UnauthorizedException(
        'La sesión no es válida o expiró. Vuelve a iniciar sesión.',
      );
    }
  }
}
