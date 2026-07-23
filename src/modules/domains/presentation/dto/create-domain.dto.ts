import { Matches } from 'class-validator';

export class CreateDomainDto {
  // A dotted hostname: labels of alphanumerics/hyphens separated by dots.
  @Matches(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, {
    message: 'host must be a valid domain name',
  })
  host!: string;
}
