import { IsOptional, IsString, MinLength } from 'class-validator';
import {
  INPUT_TOKEN_MAX,
  TextMaxLength,
} from '../../../../shared/validation/input-limits';

export class LogoutDto {
  // Opcional (DX-062): la web lo manda en la cookie HttpOnly. Si viene en el
  // body (clientes antiguos, migración), tiene prioridad sobre la cookie.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @TextMaxLength(INPUT_TOKEN_MAX)
  refreshToken?: string;
}
