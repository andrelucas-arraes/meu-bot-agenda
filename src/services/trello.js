const fetch = global.fetch;
const { log } = require('../utils/logger');
const { withTrelloRetry } = require('../utils/retry');

const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const TRELLO_LIST_INBOX = process.env.TRELLO_LIST_ID_INBOX;

const BASE_URL = 'https://api.trello.com/1';

function getAuthParams() {
    if (!TRELLO_API_KEY || !TRELLO_TOKEN) {
        throw new Error('Trello API Key ou Token não configurados no .env');
    }
    return `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
}

async function getLists(boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required (env or param)');
        const url = `${BASE_URL}/boards/${boardId}/lists?${getAuthParams()}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());
        const lists = await response.json();
        log.trello('Listas obtidas', { count: lists.length });
        return lists;
    }, 'getLists');
}

async function getLabels(boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required');
        const url = `${BASE_URL}/boards/${boardId}/labels?${getAuthParams()}`;
        const response = await fetch(url);
        return await response.json();
    }, 'getLabels');
}

async function getMembers(boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required');
        const url = `${BASE_URL}/boards/${boardId}/members?${getAuthParams()}`;
        const response = await fetch(url);
        return await response.json();
    }, 'getMembers');
}

async function addLabel(cardId, labelId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/idLabels?value=${labelId}&${getAuthParams()}`;
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Label adicionada', { cardId, labelId });
        return await response.json();
    }, 'addLabel');
}

async function addMember(cardId, memberId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/idMembers?value=${memberId}&${getAuthParams()}`;
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Membro adicionado', { cardId, memberId });
        return await response.json();
    }, 'addMember');
}

async function createCard({ name, desc, due, labels, members }) {
    return withTrelloRetry(async () => {
        if (!TRELLO_LIST_INBOX) {
            throw new Error('TRELLO_LIST_ID_INBOX não configurado no .env');
        }

        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            idList: TRELLO_LIST_INBOX,
            name: name,
        });

        if (desc) params.append('desc', desc);
        if (due) params.append('due', due);
        if (labels) params.append('idLabels', labels);
        if (members) params.append('idMembers', members);

        const url = `${BASE_URL}/cards?${params.toString()}`;

        log.trello('Criando card', { name });

        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());

        const card = await response.json();
        log.trello('Card criado', { id: card.id, name: card.name });
        return card;
    }, 'createCard');
}

async function listCards(listId = TRELLO_LIST_INBOX) {
    return withTrelloRetry(async () => {
        if (!listId) throw new Error('List ID required');

        const url = `${BASE_URL}/lists/${listId}/cards?fields=name,shortUrl,due,idList,labels,desc&${getAuthParams()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }, 'listCards');
}

async function listAllCards() {
    return withTrelloRetry(async () => {
        const lists = await getLists();
        let allCards = [];

        const promises = lists.map(async (list) => {
            try {
                const cards = await listCards(list.id);
                return cards.map(c => ({ ...c, listName: list.name }));
            } catch (e) {
                log.error(`Erro ao buscar cards da lista ${list.name}`, { error: e.message });
                return [];
            }
        });

        const results = await Promise.all(promises);
        results.forEach(cards => allCards = allCards.concat(cards));

        log.trello('Todos os cards listados', { count: allCards.length });
        return allCards;
    }, 'listAllCards');
}

async function listAllCardsGrouped() {
    return withTrelloRetry(async () => {
        const lists = await getLists();
        const result = [];

        for (const list of lists) {
            try {
                const cards = await listCards(list.id);
                result.push({
                    id: list.id,
                    name: list.name,
                    cards: cards
                });
            } catch (e) {
                log.error(`Erro ao buscar cards da lista ${list.name}`, { error: e.message });
            }
        }

        log.trello('Cards agrupados', {
            lists: result.length,
            totalCards: result.reduce((sum, l) => sum + l.cards.length, 0)
        });
        return result;
    }, 'listAllCardsGrouped');
}

async function updateCard(cardId, updates) {
    return withTrelloRetry(async () => {
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN
        });

        if (updates.name) params.append('name', updates.name);
        if (updates.desc) params.append('desc', updates.desc);
        if (updates.due) params.append('due', updates.due);
        if (updates.idList) params.append('idList', updates.idList);
        if (updates.closed !== undefined) params.append('closed', updates.closed);

        const url = `${BASE_URL}/cards/${cardId}?${params.toString()}`;

        log.trello('Atualizando card', { cardId, updates: Object.keys(updates) });

        const response = await fetch(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const card = await response.json();
        log.trello('Card atualizado', { id: card.id });
        return card;
    }, 'updateCard');
}

async function addComment(cardId, text) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}&${getAuthParams()}`;
        const response = await fetch(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Comentário adicionado', { cardId });
        return await response.json();
    }, 'addComment');
}

async function addChecklist(cardId, name, items = []) {
    return withTrelloRetry(async () => {
        // 1. Criar Checklist
        const urlCreate = `${BASE_URL}/cards/${cardId}/checklists?name=${encodeURIComponent(name || 'Checklist')}&${getAuthParams()}`;
        const resCreate = await fetch(urlCreate, { method: 'POST' });
        if (!resCreate.ok) throw new Error(await resCreate.text());
        const checklist = await resCreate.json();

        log.trello('Checklist criada', { cardId, checklistId: checklist.id });

        // 2. Adicionar Itens
        if (items && items.length > 0) {
            for (const item of items) {
                const urlItem = `${BASE_URL}/checklists/${checklist.id}/checkItems?name=${encodeURIComponent(item)}&${getAuthParams()}`;
                await fetch(urlItem, { method: 'POST' });
            }
            log.trello('Itens adicionados à checklist', { count: items.length });
        }
        return checklist;
    }, 'addChecklist');
}

// ============================================
// NOVOS ENDPOINTS - Gerenciamento Avançado
// ============================================

/**
 * Obtém detalhes completos de um card
 * @param {string} cardId - ID do card
 * @returns {Promise<Object>} Detalhes completos do card
 */
async function getCard(cardId) {
    return withTrelloRetry(async () => {
        const fields = 'id,name,desc,due,dueComplete,idList,idBoard,labels,shortUrl,url,closed,idMembers,idChecklists,dateLastActivity';
        const url = `${BASE_URL}/cards/${cardId}?fields=${fields}&checklists=all&checklist_fields=all&members=true&attachments=true&${getAuthParams()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());

        const card = await response.json();
        log.trello('Card obtido', { id: card.id, name: card.name });
        return card;
    }, 'getCard');
}

/**
 * Deleta um card permanentemente
 * @param {string} cardId - ID do card
 * @returns {Promise<void>}
 */
async function deleteCard(cardId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}?${getAuthParams()}`;

        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());

        log.trello('Card deletado', { cardId });
        return { success: true, cardId };
    }, 'deleteCard');
}

/**
 * Busca cards por texto (nome, descrição, etc.)
 * @param {string} query - Texto para buscar
 * @param {string} boardId - ID do board (opcional, usa o do .env)
 * @returns {Promise<Array>} Cards encontrados
 */
async function searchCards(query, boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required');

        const params = new URLSearchParams({
            query: query,
            idBoards: boardId,
            modelTypes: 'cards',
            card_fields: 'id,name,desc,due,idList,labels,shortUrl,closed',
            cards_limit: 20,
            partial: 'true'
        });

        const url = `${BASE_URL}/search?${params.toString()}&${getAuthParams()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());

        const result = await response.json();
        log.trello('Busca realizada', { query, encontrados: result.cards?.length || 0 });
        return result.cards || [];
    }, 'searchCards');
}

/**
 * Obtém todos os cards de um board de uma vez (mais eficiente)
 * @param {string} boardId - ID do board (opcional)
 * @returns {Promise<Array>} Todos os cards do board
 */
async function getBoardCards(boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required');

        const fields = 'id,name,desc,due,dueComplete,idList,labels,shortUrl,closed,idMembers,idChecklists';
        const url = `${BASE_URL}/boards/${boardId}/cards?fields=${fields}&${getAuthParams()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());

        const cards = await response.json();
        log.trello('Cards do board obtidos', { count: cards.length });
        return cards;
    }, 'getBoardCards');
}

/**
 * Obtém as checklists de um card com seus itens
 * @param {string} cardId - ID do card
 * @returns {Promise<Array>} Checklists com itens
 */
async function getCardChecklists(cardId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/checklists?checkItem_fields=name,state,pos,due,idMember&${getAuthParams()}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(await response.text());

        const checklists = await response.json();
        log.trello('Checklists obtidas', { cardId, count: checklists.length });
        return checklists;
    }, 'getCardChecklists');
}

/**
 * Atualiza o estado de um item de checklist (marcar como feito/não feito)
 * @param {string} cardId - ID do card
 * @param {string} checkItemId - ID do item de checklist
 * @param {Object} updates - Campos a atualizar (state, name, pos, due)
 * @returns {Promise<Object>} Item atualizado
 */
async function updateCheckItem(cardId, checkItemId, updates) {
    return withTrelloRetry(async () => {
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN
        });

        if (updates.state) params.append('state', updates.state); // 'complete' ou 'incomplete'
        if (updates.name) params.append('name', updates.name);
        if (updates.pos !== undefined) params.append('pos', updates.pos);
        if (updates.due) params.append('due', updates.due);

        const url = `${BASE_URL}/cards/${cardId}/checkItem/${checkItemId}?${params.toString()}`;

        const response = await fetch(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const item = await response.json();
        log.trello('CheckItem atualizado', { cardId, checkItemId, state: updates.state });
        return item;
    }, 'updateCheckItem');
}

/**
 * Deleta um item de checklist
 * @param {string} cardId - ID do card
 * @param {string} checkItemId - ID do item de checklist
 * @returns {Promise<Object>}
 */
async function deleteCheckItem(cardId, checkItemId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/checkItem/${checkItemId}?${getAuthParams()}`;

        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());

        log.trello('CheckItem deletado', { cardId, checkItemId });
        return { success: true, cardId, checkItemId };
    }, 'deleteCheckItem');
}

/**
 * Remove uma label de um card
 * @param {string} cardId - ID do card
 * @param {string} labelId - ID da label
 * @returns {Promise<Object>}
 */
async function removeLabel(cardId, labelId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/idLabels/${labelId}?${getAuthParams()}`;

        const response = await fetch(url, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());

        log.trello('Label removida', { cardId, labelId });
        return { success: true, cardId, labelId };
    }, 'removeLabel');
}

module.exports = {
    // Operações básicas
    createCard,
    listCards,
    listAllCards,
    listAllCardsGrouped,
    updateCard,
    addComment,
    addChecklist,
    getLists,
    getLabels,
    getMembers,
    addLabel,
    addMember,
    // Novos endpoints avançados
    getCard,
    deleteCard,
    searchCards,
    getBoardCards,
    getCardChecklists,
    updateCheckItem,
    deleteCheckItem,
    removeLabel
};
