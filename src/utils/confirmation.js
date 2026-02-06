/**
 * Sistema de Confirmação para ações em lote
 * Gerencia estados pendentes de confirmação por usuário
 */

const { log } = require('./logger');

// Armazena confirmações pendentes: { oderId: pendingConfirmation }
const pendingConfirmations = new Map();

// Tempo limite para confirmação (2 minutos)
const CONFIRMATION_TIMEOUT = 2 * 60 * 1000;

/**
 * Cria uma confirmação pendente
 * @param {string} userId - ID do usuário
 * @param {string} actionType - Tipo da ação
 * @param {object} data - Dados da ação a ser confirmada
 * @param {string} message - Mensagem de confirmação
 * @param {Array} items - Itens que serão afetados (para preview)
 * @returns {object} Objeto de confirmação com callback_data unique
 */
function createConfirmation(userId, actionType, data, message, items = []) {
    const confirmationId = `conf_${Date.now().toString(36)}`;

    const confirmation = {
        id: confirmationId,
        userId,
        actionType,
        data,
        message,
        items,
        createdAt: Date.now(),
        expires: Date.now() + CONFIRMATION_TIMEOUT
    };

    pendingConfirmations.set(userId, confirmation);

    log.debug('Confirmação criada', { userId, actionType, confirmationId });

    // Limpa automaticamente após timeout
    setTimeout(() => {
        if (pendingConfirmations.has(userId) && pendingConfirmations.get(userId).id === confirmationId) {
            pendingConfirmations.delete(userId);
            log.debug('Confirmação expirada', { userId, confirmationId });
        }
    }, CONFIRMATION_TIMEOUT);

    return confirmation;
}

/**
 * Obtém confirmação pendente do usuário
 * @param {string} userId
 * @returns {object|null}
 */
function getPendingConfirmation(userId) {
    const confirmation = pendingConfirmations.get(userId);

    if (!confirmation) return null;

    // Verifica se expirou
    if (Date.now() > confirmation.expires) {
        pendingConfirmations.delete(userId);
        return null;
    }

    return confirmation;
}

/**
 * Remove confirmação pendente
 * @param {string} userId
 */
function clearConfirmation(userId) {
    pendingConfirmations.delete(userId);
}

/**
 * Gera teclado inline para confirmação
 * @param {string} confirmationId
 * @returns {object} Telegram InlineKeyboard markup
 */
function getConfirmationKeyboard(confirmationId) {
    return {
        inline_keyboard: [
            [
                { text: '✅ Confirmar', callback_data: `confirm_yes_${confirmationId}` },
                { text: '❌ Cancelar', callback_data: `confirm_no_${confirmationId}` }
            ]
        ]
    };
}

/**
 * Formata preview de itens para confirmação
 * @param {Array} items - Itens a serem exibidos
 * @param {string} type - 'events', 'tasks', 'cards'
 * @param {number} maxShow - Máximo de itens a mostrar
 * @returns {string} Mensagem formatada
 */
function formatPreview(items, type, maxShow = 5) {
    if (!items || items.length === 0) return '';

    const typeEmoji = {
        events: '📅',
        tasks: '✅',
        cards: '📌'
    };

    const emoji = typeEmoji[type] || '•';
    let preview = '';

    items.slice(0, maxShow).forEach(item => {
        const name = item.summary || item.title || item.name || 'Sem nome';
        preview += `   ${emoji} ${name}\n`;
    });

    if (items.length > maxShow) {
        preview += `   _...e mais ${items.length - maxShow} itens_\n`;
    }

    return preview;
}

module.exports = {
    createConfirmation,
    getPendingConfirmation,
    clearConfirmation,
    getConfirmationKeyboard,
    formatPreview,
    CONFIRMATION_TIMEOUT
};
