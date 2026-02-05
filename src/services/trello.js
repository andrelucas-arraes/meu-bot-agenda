const fetch = global.fetch;

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
    if (!boardId) throw new Error('TRELLO_BOARD_ID required (env or param)');
    const url = `${BASE_URL}/boards/${boardId}/lists?${getAuthParams()}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function getLabels(boardId = process.env.TRELLO_BOARD_ID) {
    if (!boardId) throw new Error('TRELLO_BOARD_ID required');
    const url = `${BASE_URL}/boards/${boardId}/labels?${getAuthParams()}`;
    const response = await fetch(url);
    return await response.json();
}

async function getMembers(boardId = process.env.TRELLO_BOARD_ID) {
    if (!boardId) throw new Error('TRELLO_BOARD_ID required');
    const url = `${BASE_URL}/boards/${boardId}/members?${getAuthParams()}`;
    const response = await fetch(url);
    return await response.json();
}

async function addLabel(cardId, labelId) {
    const url = `${BASE_URL}/cards/${cardId}/idLabels?value=${labelId}&${getAuthParams()}`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function addMember(cardId, memberId) {
    const url = `${BASE_URL}/cards/${cardId}/idMembers?value=${memberId}&${getAuthParams()}`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function createCard({ name, desc, due, labels, members }) {
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
    // Labels e Members (IDs) se disponíveis
    if (labels) params.append('idLabels', labels); // Array IDs
    if (members) params.append('idMembers', members); // Array IDs

    const url = `${BASE_URL}/cards?${params.toString()}`;

    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function listCards(listId = TRELLO_LIST_INBOX) {
    if (!listId) throw new Error('List ID required');

    const url = `${BASE_URL}/lists/${listId}/cards?fields=name,shortUrl,due,idList,labels,desc&${getAuthParams()}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function listAllCards() {
    const lists = await getLists();
    let allCards = [];

    // Fetch cards for each list in parallel
    const promises = lists.map(async (list) => {
        try {
            const cards = await listCards(list.id);
            return cards.map(c => ({ ...c, listName: list.name }));
        } catch (e) {
            console.error(`Error fetching cards from list ${list.name}:`, e);
            return [];
        }
    });

    const results = await Promise.all(promises);
    results.forEach(cards => allCards = allCards.concat(cards));

    return allCards;
}

async function listAllCardsGrouped() {
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
            console.error(`Error fetching cards for list ${list.name}:`, e);
        }
    }
    return result;
}

module.exports = { createCard, listCards, listAllCards, listAllCardsGrouped, updateCard, addComment, addChecklist, getLists, getLabels, getMembers, addLabel, addMember };

async function updateCard(cardId, updates) {
    const params = new URLSearchParams({
        key: TRELLO_API_KEY,
        token: TRELLO_TOKEN
    });

    if (updates.name) params.append('name', updates.name);
    if (updates.desc) params.append('desc', updates.desc);
    if (updates.due) params.append('due', updates.due);
    if (updates.idList) params.append('idList', updates.idList);
    if (updates.closed) params.append('closed', updates.closed);

    const url = `${BASE_URL}/cards/${cardId}?${params.toString()}`;

    const response = await fetch(url, { method: 'PUT' });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}


async function addComment(cardId, text) {
    const url = `${BASE_URL}/cards/${cardId}/actions/comments?text=${encodeURIComponent(text)}&${getAuthParams()}`;
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
}

async function addChecklist(cardId, name, items = []) {
    // 1. Criar Checklist
    const urlCreate = `${BASE_URL}/cards/${cardId}/checklists?name=${encodeURIComponent(name || 'Checklist')}&${getAuthParams()}`;
    const resCreate = await fetch(urlCreate, { method: 'POST' });
    if (!resCreate.ok) throw new Error(await resCreate.text());
    const checklist = await resCreate.json();

    // 2. Adicionar Itens
    if (items && items.length > 0) {
        for (const item of items) {
            const urlItem = `${BASE_URL}/checklists/${checklist.id}/checkItems?name=${encodeURIComponent(item)}&${getAuthParams()}`;
            await fetch(urlItem, { method: 'POST' });
        }
    }
    return checklist;
}


