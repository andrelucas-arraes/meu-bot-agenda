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

module.exports = {
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
    addMember
};
