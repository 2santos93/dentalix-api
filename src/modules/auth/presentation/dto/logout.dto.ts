import { IsOptional, IsString, MinLength } from 'class-validator';

export class LogoutDto {
  // Opcional (DX-062): la web lo manda en la cookie HttpOnly. Si viene en el
  // body (clientes antiguos, migración), tiene prioridad sobre la cookie.
  @IsOptional()
  @IsString()
  @MinLength(1)
  refreshToken?: string;
}
