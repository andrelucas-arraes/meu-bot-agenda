/**
 * Configurações centralizadas do bot
 * Evita "magic numbers" espalhados pelo código
 */

module.exports = {
    // ===========================================
    // RATE LIMITING
    // ===========================================
    rateLimiter: {
        maxRequests: 10,          // Máximo de requests por janela
        windowMs: 60000,          // Janela de tempo (1 minuto)
        blockDurationMs: 30000,   // Tempo de bloqueio se exceder (30 segundos)
        inactiveThresholdMs: 7 * 24 * 60 * 60 * 1000  // 7 dias para limpar usuário inativo
    },

    // ===========================================
    // FUZZY SEARCH
    // ===========================================
    fuzzySearch: {
        defaultThreshold: 0.3,    // Match mínimo (0 = perfeito, 1 = qualquer)
        strictThreshold: 0.3,     // Para buscas mais importantes
        looseThreshold: 0.5,      // Para buscas mais permissivas
        minMatchCharLength: 3,    // Mínimo de chars para considerar match
        maxBadScoreThreshold: 0.5 // Score acima disso é rejeitado
    },

    // ===========================================
    // CACHE
    // ===========================================
    cache: {
        ttlMs: 5 * 60 * 1000,     // TTL do cache: 5 minutos
        staleThresholdHours: 2,   // Considera cache "velho" após 2 horas
        refreshIntervalMs: 60 * 60 * 1000  // Atualiza a cada 1 hora
    },

    // ===========================================
    // BATCH PROCESSING
    // ===========================================
    batch: {
        defaultBatchSize: 10,     // Items por batch
        defaultDelayMs: 1000      // Delay entre batches (1 segundo)
    },

    // ===========================================
    // CONFIRMAÇÃO E HISTÓRICO
    // ===========================================
    confirmation: {
        timeoutMs: 2 * 60 * 1000, // Timeout de confirmação: 2 minutos
        maxPendingPerUser: 1      // Máximo de confirmações pendentes por usuário
    },

    actionHistory: {
        maxActionsPerUser: 10,    // Quantidade de ações para manter no histórico
        undoWindowMs: 5 * 60 * 1000 // Janela para desfazer: 5 minutos
    },

    // ===========================================
    // KNOWLEDGE BASE
    // ===========================================
    knowledge: {
        maxBackups: 3,            // Número de backups a manter
        fuzzyThreshold: 0.4       // Threshold para busca na KB
    },

    // ===========================================
    // SCHEDULER
    // ===========================================
    scheduler: {
        morningAlertHour: 8,      // Hora do resumo matinal
        afternoonCheckHour: 14,   // Hora do check da tarde
        reminderMinutes: 15,      // Minutos antes do evento para lembrete
        maxEventsInSummary: 10,   // Máximo de eventos no resumo

        maxCardsInSummary: 10     // Máximo de cards Trello no resumo
    },

    // ===========================================
    // LOGGING
    // ===========================================
    logging: {
        maxLogAgeDays: 7,         // Dias para manter logs
        maxInteractionLength: 200,// Chars máx; do input no log
        maxOutputLength: 500      // Chars máx do output no log
    },

    // ===========================================
    // TIMEZONE
    // ===========================================
    timezone: 'America/Sao_Paulo'
};
