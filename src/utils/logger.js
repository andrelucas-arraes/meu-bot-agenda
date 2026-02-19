/**
 * Logger estruturado usando Pino
 * Formato JSON em produção, formatado em desenvolvimento
 * Salva logs em arquivo para debug
 */

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');

const localStorage = new AsyncLocalStorage();

const isDev = process.env.NODE_ENV !== 'production';
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

// Garante que o diretório de logs existe
if (!fs.existsSync(LOGS_DIR)) {
    try {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch (e) {
        console.error('Não foi possível criar diretório de logs', e.message);
    }
}

// Arquivo de log do dia atual
const getLogFile = () => {
    const today = new Date().toISOString().split('T')[0];
    return path.join(LOGS_DIR, `bot-${today}.log`);
};

// Streams: console + arquivo (com rotação diária)
let currentLogDate = null;
let currentFileStream = null;

function getOrCreateFileStream() {
    const today = new Date().toISOString().split('T')[0];
    if (currentLogDate !== today) {
        // Fecha stream anterior se existir
        if (currentFileStream) {
            try { currentFileStream.end(); } catch (e) { /* ignora */ }
        }
        currentLogDate = today;
        const logFile = path.join(LOGS_DIR, `bot-${today}.log`);
        currentFileStream = fs.createWriteStream(logFile, { flags: 'a' });
    }
    return currentFileStream;
}

// Stream dinâmico que redireciona para o arquivo do dia correto
const dailyRotatingStream = new (require('stream').Writable)({
    write(chunk, encoding, callback) {
        try {
            const stream = getOrCreateFileStream();
            stream.write(chunk, encoding, callback);
        } catch (e) {
            callback();
        }
    }
});

const streams = [
    // Console (formatado em dev, JSON em prod)
    {
        stream: isDev
            ? require('pino-pretty')({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' })
            : process.stdout
    },
    // Arquivo com rotação diária
    { stream: dailyRotatingStream }
];

// Redaction keys
const SENSITIVE_KEYS = ['token', 'key', 'password', 'secret', 'authorization', 'apiKey', 'accessToken'];

const redactData = (data) => {
    if (!data || typeof data !== 'object') return data;

    if (Array.isArray(data)) {
        return data.map(redactData);
    }

    const redacted = { ...data };
    for (const key in redacted) {
        if (SENSITIVE_KEYS.some(k => key.toLowerCase().includes(k))) {
            redacted[key] = '[REDACTED]';
        } else if (typeof redacted[key] === 'object') {
            redacted[key] = redactData(redacted[key]);
        }
    }
    return redacted;
};

const logger = pino(
    {
        level: process.env.LOG_LEVEL || 'info',
        formatters: {
            level: (label) => ({ level: label }),
        },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
        mixin() {
            const context = localStorage.getStore();
            return context || {};
        }
    },
    pino.multistream(streams)
);

// Helpers para contexto
const createChildLogger = (context) => logger.child(context);
const runWithContext = (context, callback) => localStorage.run(context, callback);

// Métodos de conveniência
const log = {
    info: (msg, data = {}) => logger.info(redactData(data), msg),
    warn: (msg, data = {}) => logger.warn(redactData(data), msg),
    error: (msg, data = {}) => logger.error(redactData(data), msg),
    debug: (msg, data = {}) => logger.debug(redactData(data), msg),

    // Log de operações específicas
    bot: (action, data = {}) => logger.info({ ...data, component: 'bot', action }, `🤖 Bot: ${action}`),
    ai: (action, data = {}) => logger.info({ ...data, component: 'ai', action }, `🧠 AI: ${action}`),
    google: (action, data = {}) => logger.info({ ...data, component: 'google', action }, `📅 Google: ${action}`),
    trello: (action, data = {}) => logger.info({ ...data, component: 'trello', action }, `🗂️ Trello: ${action}`),
    scheduler: (action, data = {}) => logger.info({ ...data, component: 'scheduler', action }, `⏰ Scheduler: ${action}`),

    // Log de interações do usuário (para debug de conversas)
    interaction: (userId, input, output, data = {}) => {
        logger.info({
            component: 'interaction',
            userId,
            input: input.substring(0, 200),
            output: typeof output === 'object' ? JSON.stringify(output).substring(0, 500) : output.substring(0, 500),
            ...data
        }, `💬 Interação: ${input.substring(0, 50)}...`);
    },

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

/**
 * Função assíncrona para limpar logs antigos (mais de 7 dias)
 * Evita bloquear o event loop
 */
const cleanOldLogs = async () => {
    try {
        const files = await fs.promises.readdir(LOGS_DIR);
        const now = Date.now();
        const maxAge = (config.logging?.maxLogAgeDays || 7) * 24 * 60 * 60 * 1000;

        for (const file of files) {
            const filePath = path.join(LOGS_DIR, file);
            const stats = await fs.promises.stat(filePath);

            if (now - stats.mtimeMs > maxAge) {
                await fs.promises.unlink(filePath);
                logger.debug(`Log antigo removido: ${file}`);
            }
        }
    } catch (e) {
        // Ignora erros de limpeza
    }
};

// Agenda limpeza (não bloqueia inicialização)
cleanOldLogs();

module.exports = { logger, log, createChildLogger, runWithContext, LOGS_DIR };
