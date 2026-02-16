/**
 * Histórico de ações para funcionalidade de DESFAZER
 * Guarda as últimas N ações por usuário para permitir rollback
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');
const HISTORY_FILE = path.join(DATA_DIR, 'action_history.json');

// Histórico em memória: { oderId: [ações] }
let actionHistory = {};

// Máximo de ações por usuário
const MAX_HISTORY_PER_USER = 20;

// Tipos de ação que podem ser desfeitas
const UNDOABLE_ACTIONS = {
    'create_event': 'delete_event',
    'complete_event': 'uncomplete_event',
    'complete_all_events': 'uncomplete_events',
    'delete_event': 'restore_event', // Não é possível restaurar, mas registramos
    'trello_create': 'trello_delete',
    'trello_archive': 'trello_unarchive',
    'trello_move': 'trello_move_back',
    'store_info': 'delete_info'
};

// Carrega histórico do disco
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
            actionHistory = JSON.parse(data);
            log.info('Histórico de ações carregado', { users: Object.keys(actionHistory).length });
        }
    } catch (e) {
        log.error('Erro ao carregar histórico de ações', { error: e.message });
        actionHistory = {};
    }
}

// Salva histórico no disco
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(actionHistory, null, 2));
    } catch (e) {
        log.error('Erro ao salvar histórico de ações', { error: e.message });
    }
}

/**
 * Registra uma ação no histórico
 * @param {string} userId - ID do usuário
 * @param {string} actionType - Tipo da ação (ex: 'create_event')
 * @param {object} data - Dados da ação para permitir desfazer
 * @param {object} result - Resultado da ação (ex: evento criado)
 */
function recordAction(userId, actionType, data, result = null) {
    if (!UNDOABLE_ACTIONS[actionType]) {
        return; // Ação não é "desfezeível"
    }

    if (!actionHistory[userId]) {
        actionHistory[userId] = [];
    }

    const action = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
        type: actionType,
        undoType: UNDOABLE_ACTIONS[actionType],
        data: data,
        result: result,
        timestamp: new Date().toISOString(),
        undone: false
    };

    actionHistory[userId].unshift(action); // Adiciona no início

    // Limita tamanho do histórico
    if (actionHistory[userId].length > MAX_HISTORY_PER_USER) {
        actionHistory[userId] = actionHistory[userId].slice(0, MAX_HISTORY_PER_USER);
    }

    saveHistory();
    log.debug('Ação registrada', { userId, actionType, actionId: action.id });

    return action;
}

/**
 * Obtém a última ação "desfezeível" do usuário
 * @param {string} userId
 * @returns {object|null} Última ação ou null
 */
function getLastAction(userId) {
    if (!actionHistory[userId] || actionHistory[userId].length === 0) {
        return null;
    }

    // Encontra a última ação que ainda não foi desfeita
    return actionHistory[userId].find(a => !a.undone) || null;
}

/**
 * Marca uma ação como desfeita
 * @param {string} userId
 * @param {string} actionId
 */
function markAsUndone(userId, actionId) {
    if (!actionHistory[userId]) return false;

    const action = actionHistory[userId].find(a => a.id === actionId);
    if (action) {
        action.undone = true;
        action.undoneAt = new Date().toISOString();
        saveHistory();
        return true;
    }
    return false;
}

/**
 * Obtém histórico completo do usuário (para debug)
 * @param {string} userId
 * @param {number} limit
 */
function getHistory(userId, limit = 10) {
    if (!actionHistory[userId]) return [];
    return actionHistory[userId].slice(0, limit);
}

/**
 * Limpa histórico do usuário
 * @param {string} userId
 */
function clearHistory(userId) {
    if (actionHistory[userId]) {
        delete actionHistory[userId];
        saveHistory();
        return true;
    }
    return false;
}

// Carrega histórico na inicialização
loadHistory();

module.exports = {
    recordAction,
    getLastAction,
    markAsUndone,
    getHistory,
    clearHistory,
    UNDOABLE_ACTIONS
};
