import { Logger } from '@nestjs/common';
import { ConsoleMailer } from './console.mailer';
import { SmtpMailer, SmtpTransport } from './smtp.mailer';

const message = {
  to: 'ana.perez@clinica.co',
  subject: 'Te invitaron a unirte a Clínica Demo',
  html: '<a href="https://demo.dentalix.app/invitacion/TOKEN-SECRETO">x</a>',
  text: 'https://demo.dentalix.app/invitacion/TOKEN-SECRETO',
};

describe('ConsoleMailer', () => {
  it('registra una línea con el destinatario enmascarado, sin cuerpo ni token', async () => {
    const spy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    await new ConsoleMailer().send(message);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls[0]);
    expect(logged).toContain('an***@clinica.co');
    expect(logged).not.toContain('ana.perez@clinica.co');
    expect(logged).not.toContain('TOKEN-SECRETO');
    spy.mockRestore();
  });
});

describe('SmtpMailer', () => {
  it('entrega el mensaje con el remitente y sin acceso a ficheros/URLs', async () => {
    const sendMail = jest.fn().mockResolvedValue({ messageId: 'x' });
    const transport: SmtpTransport = { sendMail, close: jest.fn() };
    await new SmtpMailer('Dentalix <no-reply@dentalix.app>', transport).send(
      message,
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Dentalix <no-reply@dentalix.app>',
      ...message,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  });

  it('propaga el fallo del proveedor (el despachador decide el reintento)', async () => {
    const transport: SmtpTransport = {
      sendMail: jest.fn().mockRejectedValue(new Error('421 try later')),
      close: jest.fn(),
    };
    await expect(
      new SmtpMailer('no-reply@x.co', transport).send(message),
    ).rejects.toThrow('421');
  });

  it('fromUrl arma un transporte SMTP real a partir de la URL', () => {
    const mailer = SmtpMailer.fromUrl(
      'smtp://usuario:clave@127.0.0.1:2525',
      'no-reply@x.co',
    );
    expect(mailer).toBeInstanceOf(SmtpMailer);
    mailer.close();
  });
});
