/**
 * Retry com Exponential Backoff
 * Tenta novamente operações que falharam com delay crescente
 */

const { log } = require('./logger');

/**
 * Executa uma função com retry e exponential backoff
 * @param {Function} fn - Função async para executar
 * @param {Object} options - Opções de retry
 * @param {number} options.maxRetries - Número máximo de tentativas (default: 3)
 * @param {number} options.initialDelay - Delay inicial em ms (default: 1000)
 * @param {number} options.maxDelay - Delay máximo em ms (default: 10000)
 * @param {number} options.backoffMultiplier - Multiplicador do backoff (default: 2)
 * @param {Function} options.shouldRetry - Função para decidir se deve retry (default: sempre)
 * @param {string} options.operationName - Nome da operação para logs
 * @returns {Promise<any>}
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        initialDelay = 1000,
        maxDelay = 10000,
        backoffMultiplier = 2,
        shouldRetry = () => true,
        operationName = 'operation'
    } = options;

    let lastError;
    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            // Verifica se deve fazer retry
            if (attempt === maxRetries || !shouldRetry(error)) {
                log.warn(`${operationName} falhou após ${attempt} tentativa(s)`, {
                    error: error.message,
                    attempts: attempt
                });
                throw error;
            }

            // Log do retry
            log.warn(`${operationName} falhou, tentando novamente em ${delay}ms...`, {
                attempt,
                maxRetries,
                error: error.message,
                nextDelay: delay
            });

            // Aguarda antes do próximo retry
            await sleep(delay);

            // Calcula próximo delay com backoff
            delay = Math.min(delay * backoffMultiplier, maxDelay);
        }
    }

    throw lastError;
}

/**
 * Helper para sleep
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determina se um erro é retryable (erros de rede, rate limit, etc)
 */
function isRetryableError(error) {
    // Erros de rede
    if (error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ECONNREFUSED' ||
        error.code === 'ENOTFOUND') {
        return true;
    }

    // Rate limiting (HTTP 429)
    if (error.status === 429 || error.code === 429) {
        return true;
    }

    // Server errors (5xx)
    if (error.status >= 500 && error.status < 600) {
        return true;
    }

    // Google API specific errors
    if (error.message?.includes('quota') ||
        error.message?.includes('rate limit') ||
        error.message?.includes('temporarily unavailable')) {
        return true;
    }

    return false;
}

/**
 * Wrapper pré-configurado para APIs do Google
 */
function withGoogleRetry(fn, operationName) {
    return withRetry(fn, {
        maxRetries: 3,
        initialDelay: 1000,
        shouldRetry: isRetryableError,
        operationName: `Google ${operationName}`
    });
}

/**
 * Wrapper pré-configurado para Trello
 */
function withTrelloRetry(fn, operationName) {
    return withRetry(fn, {
        maxRetries: 3,
        initialDelay: 500,
        shouldRetry: isRetryableError,
        operationName: `Trello ${operationName}`
    });
}

module.exports = {
    withRetry,
    withGoogleRetry,
    withTrelloRetry,
    isRetryableError,
    sleep
};
