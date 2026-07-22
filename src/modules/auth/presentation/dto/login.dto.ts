import { IsEmail, IsString, Matches } from 'class-validator';

export class LoginDto {
  @Matches(/^[a-z0-9-]+$/)
  subdomain!: string;

  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}
