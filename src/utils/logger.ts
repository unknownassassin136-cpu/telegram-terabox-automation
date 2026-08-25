import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
    redact: {
      paths: [
        'telegramSession',
        'apiHash',
        'password',
        'phoneCode',
        'session',
        'sessionString',
      ],
      censor: '[REDACTED]',
    },
  });
}
