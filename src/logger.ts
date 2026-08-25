import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      // Under launchd, stdout is a log file — ANSI escapes there make the
      // log unreadable and break every grep that inspects it.
      colorize: process.stdout.isTTY === true,
      // Default is time-only, which makes a never-rotated log ambiguous the
      // moment you look at anything older than today. UTC to match container
      // log filenames, task_run_logs, and the watchdog's `date -u`.
      translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss'Z'",
    },
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
