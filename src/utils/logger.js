/**
 * Logger estruturado usando Pino
 * Formato JSON em produção, formatado em desenvolvimento
 */

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: isDev ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    } : undefined,
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// Helpers para contexto
const createChildLogger = (context) => logger.child(context);

// Métodos de conveniência
const log = {
    info: (msg, data = {}) => logger.info(data, msg),
    warn: (msg, data = {}) => logger.warn(data, msg),
    error: (msg, data = {}) => logger.error(data, msg),
    debug: (msg, data = {}) => logger.debug(data, msg),

    // Log de operações específicas
    bot: (action, data = {}) => logger.info({ ...data, component: 'bot', action }, `🤖 Bot: ${action}`),
    ai: (action, data = {}) => logger.info({ ...data, component: 'ai', action }, `🧠 AI: ${action}`),
    google: (action, data = {}) => logger.info({ ...data, component: 'google', action }, `📅 Google: ${action}`),
    trello: (action, data = {}) => logger.info({ ...data, component: 'trello', action }, `🗂️ Trello: ${action}`),
    scheduler: (action, data = {}) => logger.info({ ...data, component: 'scheduler', action }, `⏰ Scheduler: ${action}`),

    // Log de erros com stack trace
    apiError: (service, error, context = {}) => {
        logger.error({
            component: service,
            error: error.message,
            stack: error.stack,
            ...context
        }, `❌ ${service} Error: ${error.message}`);
    }
};

module.exports = { logger, log, createChildLogger };
