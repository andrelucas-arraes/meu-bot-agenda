/**
 * Busca Fuzzy usando Fuse.js
 * Encontra itens mesmo com erros de digitação
 */

const Fuse = require('fuse.js');
const { log } = require('./logger');

/**
 * Cria uma instância do Fuse configurada para busca de eventos
 * @param {Array} items - Array de itens para buscar
 * @param {Array<string>} keys - Chaves para buscar (ex: ['summary', 'description'])
 * @param {Object} options - Opções adicionais do Fuse
 * @returns {Fuse}
 */
function createFuzzySearcher(items, keys, options = {}) {
    const defaultOptions = {
        // Qual porcentagem de match é necessária (0 = match perfeito, 1 = qualquer coisa)
        threshold: 0.4,
        // Distância máxima de caracteres
        distance: 100,
        // Peso da posição (matches no início são mais relevantes)
        location: 0,
        // Mínimo de caracteres para buscar
        minMatchCharLength: 2,
        // Incluir score no resultado
        includeScore: true,
        // Chaves para buscar
        keys: keys,
        // Opções de ordenação
        shouldSort: true,
        // Ignorar acentos e case
        ignoreLocation: false,
        useExtendedSearch: false,
        ...options
    };

    return new Fuse(items, defaultOptions);
}

/**
 * Busca um evento por query fuzzy
 * @param {Array} events - Lista de eventos
 * @param {string} query - Termo de busca
 * @returns {Object|null} - Melhor match ou null
 */
function findEventFuzzy(events, query) {
    if (!events || events.length === 0 || !query) {
        return null;
    }

    const fuse = createFuzzySearcher(events, ['summary', 'description'], {
        threshold: 0.4
    });

    const results = fuse.search(query);

    if (results.length === 0) {
        log.debug('Busca fuzzy sem resultados', { query, totalItems: events.length });
        return null;
    }

    const best = results[0];
    log.debug('Busca fuzzy encontrou', {
        query,
        match: best.item.summary,
        score: best.score
    });

    return best.item;
}

/**
 * Busca uma tarefa por query fuzzy
 * @param {Array} tasks - Lista de tarefas
 * @param {string} query - Termo de busca
 * @returns {Object|null} - Melhor match ou null
 */
function findTaskFuzzy(tasks, query) {
    if (!tasks || tasks.length === 0 || !query) {
        return null;
    }

    const fuse = createFuzzySearcher(tasks, ['title', 'notes'], {
        threshold: 0.4
    });

    const results = fuse.search(query);

    if (results.length === 0) {
        return null;
    }

    return results[0].item;
}

/**
 * Busca um card do Trello por query fuzzy
 * @param {Array} cards - Lista de cards
 * @param {string} query - Termo de busca
 * @returns {Object|null} - Melhor match ou null
 */
function findTrelloCardFuzzy(cards, query) {
    if (!cards || cards.length === 0 || !query) {
        return null;
    }

    const fuse = createFuzzySearcher(cards, ['name', 'desc'], {
        threshold: 0.4
    });

    const results = fuse.search(query);

    if (results.length === 0) {
        return null;
    }

    return results[0].item;
}

/**
 * Busca uma lista do Trello por nome fuzzy
 * @param {Array} lists - Lista de listas
 * @param {string} query - Nome da lista
 * @returns {Object|null} - Melhor match ou null
 */
function findTrelloListFuzzy(lists, query) {
    if (!lists || lists.length === 0 || !query) {
        return null;
    }

    const fuse = createFuzzySearcher(lists, ['name'], {
        threshold: 0.3 // Mais estrito para nomes de lista
    });

    const results = fuse.search(query);

    if (results.length === 0) {
        return null;
    }

    return results[0].item;
}

/**
 * Retorna múltiplos resultados ordenados por relevância
 * @param {Array} items - Lista de itens
 * @param {string} query - Termo de busca
 * @param {Array<string>} keys - Chaves para buscar
 * @param {number} limit - Máximo de resultados
 * @returns {Array} - Array de matches
 */
function findMultiple(items, query, keys, limit = 5) {
    if (!items || items.length === 0 || !query) {
        return [];
    }

    const fuse = createFuzzySearcher(items, keys, {
        threshold: 0.5
    });

    const results = fuse.search(query, { limit });

    return results.map(r => ({
        item: r.item,
        score: r.score
    }));
}

module.exports = {
    createFuzzySearcher,
    findEventFuzzy,
    findTaskFuzzy,
    findTrelloCardFuzzy,
    findTrelloListFuzzy,
    findMultiple
};
