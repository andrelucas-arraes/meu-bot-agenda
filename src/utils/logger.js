/**
 * Logger estruturado usando Pino
 * Formato JSON em produção, formatado em desenvolvimento
 * Salva logs em arquivo para debug
 */

const pino = require('pino');
const fs = require('fs');
const path = require('path');

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

// Streams: console + arquivo
const streams = [
    // Console (formatado em dev, JSON em prod)
    {
        stream: isDev
            ? require('pino-pretty')({ colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' })
            : process.stdout
    }
];

// Adiciona stream de arquivo se possível
try {
    const fileStream = fs.createWriteStream(getLogFile(), { flags: 'a' });
    streams.push({ stream: fileStream });
} catch (e) {
    console.error('Não foi possível criar stream de log para arquivo', e.message);
}

const logger = pino(
    {
        level: process.env.LOG_LEVEL || 'info',
        formatters: {
            level: (label) => ({ level: label }),
        },
        timestamp: () => `,"time":"${new Date().toISOString()}"`,
    },
    pino.multistream(streams)
);

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

// Função para limpar logs antigos (mais de 7 dias)
const cleanOldLogs = () => {
    try {
        const files = fs.readdirSync(LOGS_DIR);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 dias

        files.forEach(file => {
            const filePath = path.join(LOGS_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log(`Log antigo removido: ${file}`);
            }
        });
    } catch (e) {
        // Ignora erros de limpeza
    }
};

// Limpa logs antigos na inicialização
cleanOldLogs();

module.exports = { logger, log, createChildLogger, LOGS_DIR };
