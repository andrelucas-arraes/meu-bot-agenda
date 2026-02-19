/**
 * Rate Limiter simples por usuário
 * Limita o número de mensagens que um usuário pode enviar por período
 */

const { log } = require('./logger');

class RateLimiter {
    constructor(options = {}) {
        // Configurações
        this.maxRequests = options.maxRequests || 5; // máximo de requests
        this.windowMs = options.windowMs || 60000;   // janela em ms (1 minuto)
        this.blockDurationMs = options.blockDurationMs || 30000; // tempo de bloqueio (30s)

        // Storage: { userId: { requests: [timestamps], blockedUntil: timestamp } }
        this.users = new Map();

        // Limpa entradas antigas periodicamente (armazena referência para cleanup)
        this._cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    /**
     * Verifica se um usuário pode fazer uma request
     * @param {string} userId - ID do usuário
     * @returns {{ allowed: boolean, remaining: number, resetIn: number, message?: string }}
     */
    check(userId) {
        const now = Date.now();
        const userKey = String(userId);

        // Inicializa se não existe
        if (!this.users.has(userKey)) {
            this.users.set(userKey, { requests: [], blockedUntil: 0 });
        }

        const userData = this.users.get(userKey);

        // Verifica se está bloqueado
        if (userData.blockedUntil > now) {
            const waitTime = Math.ceil((userData.blockedUntil - now) / 1000);
            return {
                allowed: false,
                remaining: 0,
                resetIn: waitTime,
                message: `⏳ Espere ${waitTime}s antes de enviar mais mensagens.`
            };
        }

        // Remove requests antigas (fora da janela)
        userData.requests = userData.requests.filter(
            timestamp => now - timestamp < this.windowMs
        );

        // Verifica se excedeu o limite
        if (userData.requests.length >= this.maxRequests) {
            // Bloqueia o usuário
            userData.blockedUntil = now + this.blockDurationMs;
            const waitTime = Math.ceil(this.blockDurationMs / 1000);

            log.warn('Rate limit exceeded', { userId, requests: userData.requests.length });

            return {
                allowed: false,
                remaining: 0,
                resetIn: waitTime,
                message: `🚫 Muitas mensagens! Espere ${waitTime}s.`
            };
        }

        // Adiciona request atual
        userData.requests.push(now);

        return {
            allowed: true,
            remaining: this.maxRequests - userData.requests.length,
            resetIn: Math.ceil(this.windowMs / 1000)
        };
    }

    /**
     * Reseta o contador de um usuário
     * @param {string} userId 
     */
    reset(userId) {
        this.users.delete(String(userId));
    }

    /**
     * Remove entradas antigas para liberar memória
     * Inclui limpeza de usuários inativos por mais de 7 dias
     */
    cleanup() {
        const now = Date.now();
        const INACTIVE_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 dias em ms

        for (const [userId, userData] of this.users.entries()) {
            // Verifica última requisição
            const lastRequest = userData.requests[userData.requests.length - 1] || 0;
            const isInactive = (now - lastRequest) > INACTIVE_THRESHOLD;

            // Remove se:
            // 1. Não tem requests recentes E não está bloqueado
            // 2. OU está inativo por mais de 7 dias E não está bloqueado
            if ((userData.requests.length === 0 || isInactive) && userData.blockedUntil < now) {
                this.users.delete(userId);
            }
        }
    }

    /**
     * Retorna estatísticas do rate limiter
     */
    getStats() {
        return {
            activeUsers: this.users.size,
            config: {
                maxRequests: this.maxRequests,
                windowMs: this.windowMs,
                blockDurationMs: this.blockDurationMs
            }
        };
    }

    /**
     * Limpa o interval para permitir o processo encerrar graciosamente
     */
    destroy() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
            this._cleanupInterval = null;
        }
    }
}

// Instância singleton com configuração do arquivo config.js
const config = require('../config');

const rateLimiter = new RateLimiter({
    maxRequests: config.rateLimiter.maxRequests,
    windowMs: config.rateLimiter.windowMs,
    blockDurationMs: config.rateLimiter.blockDurationMs
});

module.exports = { RateLimiter, rateLimiter };
