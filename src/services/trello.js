const nativeFetch = global.fetch;
const { log } = require('../utils/logger');
const { withTrelloRetry } = require('../utils/retry');

let rateLimitStats = {
    limit: null,
    remaining: null,
    lastUpdate: null
};

// Wrapper para interceptar headers de rate limit
async function fetchTrello(url, options) {
    const response = await nativeFetch(url, options);

    // Captura headers se existirem
    const limit = response.headers.get('x-ratelimit-limit');
    const remaining = response.headers.get('x-ratelimit-remaining');

    if (limit) {
        rateLimitStats = {
            limit: parseInt(limit),
            remaining: parseInt(remaining),
            lastUpdate: new Date()
        };
    }

    return response;
}

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
        const response = await fetchTrello(url);
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
        const response = await fetchTrello(url);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }, 'getLabels');
}

async function getMembers(boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        if (!boardId) throw new Error('TRELLO_BOARD_ID required');
        const url = `${BASE_URL}/boards/${boardId}/members?${getAuthParams()}`;
        const response = await fetchTrello(url);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }, 'getMembers');
}

async function addLabel(cardId, labelId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/idLabels?value=${labelId}&${getAuthParams()}`;
        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Label adicionada', { cardId, labelId });
        return await response.json();
    }, 'addLabel');
}

async function createLabel(name, color = null) {
    return withTrelloRetry(async () => {
        const boardId = await ensureBoardId(process.env.TRELLO_BOARD_ID);
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            name: name,
            idBoard: boardId
        });
        if (color) params.append('color', color);

        const url = `${BASE_URL}/labels?${params.toString()}`;
        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());

        const label = await response.json();
        log.trello('Nova label criada', { name, color, id: label.id });
        return label;
    }, 'createLabel');
}

async function addMember(cardId, memberId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/idMembers?value=${memberId}&${getAuthParams()}`;
        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Membro adicionado', { cardId, memberId });
        return await response.json();
    }, 'addMember');
}

async function createCard({ name, desc, due, labels, members, idList }) {
    return withTrelloRetry(async () => {
        if (!TRELLO_LIST_INBOX) {
            throw new Error('TRELLO_LIST_ID_INBOX não configurado no .env');
        }

        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            idList: idList || TRELLO_LIST_INBOX,
            name: name,
        });

        if (desc) params.append('desc', desc);
        if (due) params.append('due', due);
        if (labels) params.append('idLabels', labels);
        if (members) params.append('idMembers', members);

        const url = `${BASE_URL}/cards?${params.toString()}`;

        log.trello('Criando card', { name });

        const response = await fetchTrello(url, { method: 'POST' });
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

        const response = await fetchTrello(url);
        if (!response.ok) throw new Error(await response.text());
        return await response.json();
    }, 'listCards');
}

async function listAllCards() {
    try {
        const lists = await getLists();
        const cards = await getBoardCards();

        // Cria mapa de id -> nome da lista
        const listMap = {};
        lists.forEach(l => { listMap[l.id] = l.name; });

        // Adiciona listName a cada card
        const allCards = cards
            .filter(c => !c.closed)
            .map(c => ({ ...c, listName: listMap[c.idList] || 'Desconhecida' }));

        log.trello('Todos os cards listados', { count: allCards.length });
        return allCards;
    } catch (error) {
        log.error('Erro ao listar todos os cards', { error: error.message });
        return [];
    }
}

async function listAllCardsGrouped() {
    try {
        const lists = await getLists();
        const cards = await getBoardCards();

        // Agrupa cards por lista
        const result = lists.map(list => ({
            id: list.id,
            name: list.name,
            cards: cards.filter(c => c.idList === list.id && !c.closed)
        }));

        log.trello('Cards agrupados', {
            lists: result.length,
            totalCards: result.reduce((sum, l) => sum + l.cards.length, 0)
        });
        return result;
    } catch (error) {
        log.error('Erro ao agrupar cards', { error: error.message });
        return [];
    }
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

        const response = await fetchTrello(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const card = await response.json();
        log.trello('Card atualizado', { id: card.id });
        return card;
    }, 'updateCard');
}

async function addComment(cardId, text) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}&${getAuthParams()}`;
        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());
        log.trello('Comentário adicionado', { cardId });
        return await response.json();
    }, 'addComment');
}

async function addChecklist(cardId, name, items = []) {
    return withTrelloRetry(async () => {
        // 1. Criar Checklist
        const urlCreate = `${BASE_URL}/cards/${cardId}/checklists?name=${encodeURIComponent(name || 'Checklist')}&${getAuthParams()}`;
        const resCreate = await fetchTrello(urlCreate, { method: 'POST' });
        if (!resCreate.ok) throw new Error(await resCreate.text());
        const checklist = await resCreate.json();

        log.trello('Checklist criada', { cardId, checklistId: checklist.id });

        // 2. Adicionar Itens
        if (items && items.length > 0) {
            for (const item of items) {
                const urlItem = `${BASE_URL}/checklists/${checklist.id}/checkItems?name=${encodeURIComponent(item)}&${getAuthParams()}`;
                await fetchTrello(urlItem, { method: 'POST' });
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

        const response = await fetchTrello(url);
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

        const response = await fetchTrello(url, { method: 'DELETE' });
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
let _resolvedBoardId = null;

/**
 * Resolve o ID do board (Short ID -> Long ID) se necessário
 */
async function ensureBoardId(boardId) {
    if (!boardId) throw new Error('TRELLO_BOARD_ID required');

    // Se já for 24 chars hex, assume que é ObjectID válido
    if (/^[0-9a-fA-F]{24}$/.test(boardId)) {
        return boardId;
    }

    // Se já resolvemos o ID do env var e é o mesmo solicitado
    if (_resolvedBoardId && boardId === process.env.TRELLO_BOARD_ID) {
        return _resolvedBoardId;
    }

    // Busca o ID real na API
    try {
        const url = `${BASE_URL}/boards/${boardId}?fields=id&${getAuthParams()}`;
        const response = await fetchTrello(url);
        if (!response.ok) throw new Error(await response.text());
        const board = await response.json();

        // Cache se for o do env
        if (boardId === process.env.TRELLO_BOARD_ID) {
            _resolvedBoardId = board.id;
        }
        return board.id;
    } catch (error) {
        log.error('Erro ao resolver Board ID', { error: error.message, boardId });
        return boardId; // Retorna original se falhar
    }
}

/**
 * Busca cards por texto (nome, descrição, etc.)
 * @param {string} query - Texto para buscar
 * @param {string} boardId - ID do board (opcional, usa o do .env)
 * @returns {Promise<Array>} Cards encontrados
 */
async function searchCards(query, boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        const resolvedBoardId = await ensureBoardId(boardId);

        const params = new URLSearchParams({
            query: query,
            idBoards: resolvedBoardId,
            modelTypes: 'cards',
            card_fields: 'id,name,desc,due,idList,labels,shortUrl,closed',
            cards_limit: 50,
            partial: 'true'
        });

        const url = `${BASE_URL}/search?${params.toString()}&${getAuthParams()}`;

        const response = await fetchTrello(url);
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

        const response = await fetchTrello(url);
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

        const response = await fetchTrello(url);
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

        const response = await fetchTrello(url, { method: 'PUT' });
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

        const response = await fetchTrello(url, { method: 'DELETE' });
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

        const response = await fetchTrello(url, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());

        log.trello('Label removida', { cardId, labelId });
        return { success: true, cardId, labelId };
    }, 'removeLabel');
}

/**
 * Cria uma nova lista no board
 * @param {string} name - Nome da lista
 * @param {string} boardId - ID do board (opcional)
 * @returns {Promise<Object>} Nova lista
 */
async function createList(name, boardId = process.env.TRELLO_BOARD_ID) {
    return withTrelloRetry(async () => {
        const resolvedBoardId = await ensureBoardId(boardId);
        const url = `${BASE_URL}/lists?name=${encodeURIComponent(name)}&idBoard=${resolvedBoardId}&${getAuthParams()}`;

        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());

        const list = await response.json();
        log.trello('Lista criada', { name, id: list.id });
        return list;
    }, 'createList');
}

/**
 * Adiciona um item a uma checklist existente
 * @param {string} checklistId - ID da checklist
 * @param {string} name - Texto do item
 * @returns {Promise<Object>} Item criado
 */
async function addItemToChecklist(checklistId, name) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/checklists/${checklistId}/checkItems?name=${encodeURIComponent(name)}&${getAuthParams()}`;

        const response = await fetchTrello(url, { method: 'POST' });
        if (!response.ok) throw new Error(await response.text());

        const item = await response.json();
        log.trello('Item adicionado à checklist', { checklistId, itemId: item.id });
        return item;
    }, 'addItemToChecklist');
}

/**
 * Marca a data de entrega de um card como concluída ou não
 * @param {string} cardId - ID do card
 * @param {boolean} complete - true para marcar como concluído, false para desmarcar
 * @returns {Promise<Object>} Card atualizado
 */
async function markDueComplete(cardId, complete = true) {
    return withTrelloRetry(async () => {
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            dueComplete: complete.toString()
        });

        const url = `${BASE_URL}/cards/${cardId}?${params.toString()}`;
        const response = await fetchTrello(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const card = await response.json();
        log.trello('DueComplete atualizado', { cardId, complete });
        return card;
    }, 'markDueComplete');
}

/**
 * Renomeia uma lista existente
 * @param {string} listId - ID da lista
 * @param {string} newName - Novo nome para a lista
 * @returns {Promise<Object>} Lista atualizada
 */
async function renameList(listId, newName) {
    return withTrelloRetry(async () => {
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            name: newName
        });

        const url = `${BASE_URL}/lists/${listId}?${params.toString()}`;
        const response = await fetchTrello(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const list = await response.json();
        log.trello('Lista renomeada', { listId, newName });
        return list;
    }, 'renameList');
}

/**
 * Arquiva/fecha uma lista
 * @param {string} listId - ID da lista
 * @param {boolean} closed - true para arquivar, false para restaurar
 * @returns {Promise<Object>} Lista atualizada
 */
async function archiveList(listId, closed = true) {
    return withTrelloRetry(async () => {
        const params = new URLSearchParams({
            key: TRELLO_API_KEY,
            token: TRELLO_TOKEN,
            closed: closed.toString()
        });

        const url = `${BASE_URL}/lists/${listId}?${params.toString()}`;
        const response = await fetchTrello(url, { method: 'PUT' });
        if (!response.ok) throw new Error(await response.text());

        const list = await response.json();
        log.trello('Lista arquivada/restaurada', { listId, closed });
        return list;
    }, 'archiveList');
}

/**
 * Obtém o histórico de atividades de um card
 * @param {string} cardId - ID do card
 * @param {number} limit - Quantidade de ações (padrão 10)
 * @returns {Promise<Array>} Ações do card
 */
async function getCardActions(cardId, limit = 10) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/cards/${cardId}/actions?limit=${limit}&${getAuthParams()}`;

        const response = await fetchTrello(url);
        if (!response.ok) throw new Error(await response.text());

        const actions = await response.json();
        log.trello('Ações do card obtidas', { cardId, count: actions.length });
        return actions;
    }, 'getCardActions');
}

/**
 * Deleta uma checklist inteira de um card
 * @param {string} checklistId - ID da checklist
 * @returns {Promise<Object>}
 */
async function deleteChecklist(checklistId) {
    return withTrelloRetry(async () => {
        const url = `${BASE_URL}/checklists/${checklistId}?${getAuthParams()}`;

        const response = await fetchTrello(url, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text());

        log.trello('Checklist deletada', { checklistId });
        return { success: true, checklistId };
    }, 'deleteChecklist');
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
    createLabel,
    addMember,
    // Novos endpoints avançados
    getCard,
    deleteCard,
    searchCards,
    getBoardCards,
    getCardChecklists,
    updateCheckItem,
    deleteCheckItem,
    removeLabel,
    createList,
    addItemToChecklist,
    // Endpoints adicionais
    markDueComplete,
    renameList,
    archiveList,
    getCardActions,
    deleteChecklist,
    // Status
    getStatus: () => ({
        online: !!process.env.TRELLO_API_KEY,
        rateLimit: rateLimitStats
    })
};
