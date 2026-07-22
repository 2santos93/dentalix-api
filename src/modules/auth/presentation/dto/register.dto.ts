import { IsEmail, IsString, MinLength, Matches } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(2)
  clinicName!: string;

  @Matches(/^[a-z0-9-]+$/, {
    message: 'subdomain must be lowercase alphanumeric or hyphen',
  })
  subdomain!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(2)
  fullName!: string;
}
