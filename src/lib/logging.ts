type LogLevel = 'info' | 'warn' | 'error';

type LogMeta = Record<string, string | number | boolean | null | undefined>;

const redact = (meta: LogMeta = {}) =>
  Object.fromEntries(
    Object.entries(meta).filter(([key]) => !/key|secret|token|audio|transcript/i.test(key))
  );

const write = (level: LogLevel, event: string, meta?: LogMeta) => {
  const payload = {
    level,
    event,
    time: new Date().toISOString(),
    ...redact(meta)
  };

  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export const logger = {
  info: (event: string, meta?: LogMeta) => write('info', event, meta),
  warn: (event: string, meta?: LogMeta) => write('warn', event, meta),
  error: (event: string, meta?: LogMeta) => write('error', event, meta)
};
