/**
 * Post-Action Suggestions
 * Sugestões contextuais após criar eventos/tarefas/cards
 */

const { Markup } = require('telegraf');

/**
 * Gera sugestões após criar um evento
 * @param {Object} event - Evento criado
 * @param {Object} eventData - Dados originais do evento
 * @returns {Object} - { message, keyboard }
 */
function getEventSuggestions(event, eventData) {
    const suggestions = [];
    const buttons = [];

    // Se não tem Meet, sugere adicionar
    if (!event.hangoutLink && !eventData.online) {
        suggestions.push('📹 Adicionar link do Meet');
        buttons.push(Markup.button.callback('📹 Add Meet', `event_add_meet:${event.id}`));
    }

    // Se não tem descrição, sugere adicionar
    if (!eventData.description) {
        suggestions.push('📝 Adicionar descrição');
        buttons.push(Markup.button.callback('📝 Descrição', `suggest_add_desc:${event.id}`));
    }

    // Se não tem local e não é online, sugere definir local
    if (!eventData.location && !event.hangoutLink) {
        suggestions.push('📍 Definir local');
        buttons.push(Markup.button.callback('📍 Local', `suggest_add_location:${event.id}`));
    }

    // Sugere criar lembrete extra para eventos importantes (baseado em palavras-chave)
    const importantKeywords = ['reunião', 'meeting', 'entrevista', 'apresentação', 'deadline'];
    const isImportant = importantKeywords.some(kw =>
        (eventData.summary || '').toLowerCase().includes(kw)
    );

    if (isImportant) {
        suggestions.push('⏰ Lembrete extra (1h antes)');
        buttons.push(Markup.button.callback('⏰ +Lembrete', `suggest_extra_reminder:${event.id}`));
    }

    // Se é evento de viagem, sugere criar tarefa "fazer malas"
    const travelKeywords = ['viagem', 'viajar', 'aeroporto', 'voo', 'hotel'];
    const isTravel = travelKeywords.some(kw =>
        (eventData.summary || '').toLowerCase().includes(kw)
    );

    if (isTravel) {
        suggestions.push('🧳 Criar tarefa "Preparar viagem"');
        buttons.push(Markup.button.callback('🧳 Prep. Viagem', `suggest_travel_task:${event.id}`));
    }

    if (buttons.length === 0) {
        return null;
    }

    // Organiza botões em linhas de 2
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }

    return {
        message: '💡 _Sugestões:_',
        keyboard: Markup.inlineKeyboard(rows)
    };
}

/**
 * Gera sugestões após criar uma tarefa
 * @param {Object} task - Tarefa criada
 * @param {Object} taskData - Dados originais
 * @returns {Object} - { message, keyboard }
 */
function getTaskSuggestions(task, taskData) {
    const buttons = [];

    // Se não tem prazo, sugere definir
    if (!taskData.due) {
        buttons.push(Markup.button.callback('📅 Definir Prazo', `suggest_task_due:${task.id}`));
    }

    // Se não tem notas, sugere adicionar
    if (!taskData.notes) {
        buttons.push(Markup.button.callback('📝 Add Notas', `suggest_task_notes:${task.id}`));
    }

    // Sugere criar no Trello também (para tarefas maiores)
    const complexKeywords = ['projeto', 'implementar', 'desenvolver', 'criar', 'refatorar'];
    const isComplex = complexKeywords.some(kw =>
        (taskData.title || taskData.name || '').toLowerCase().includes(kw)
    );

    if (isComplex) {
        buttons.push(Markup.button.callback('🗂️ Criar no Trello', `suggest_create_trello:${task.id}`));
    }

    if (buttons.length === 0) {
        return null;
    }

    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }

    return {
        message: '💡 _Quer adicionar mais algo?_',
        keyboard: Markup.inlineKeyboard(rows)
    };
}

/**
 * Gera sugestões após criar um card no Trello
 * @param {Object} card - Card criado
 * @param {Object} cardData - Dados originais
 * @returns {Object} - { message, keyboard }
 */
function getTrelloSuggestions(card, cardData) {
    const buttons = [];

    // Se não tem checklist, sugere adicionar
    if (!cardData.checklist || cardData.checklist.length === 0) {
        buttons.push(Markup.button.callback('☑️ Add Checklist', `suggest_trello_checklist:${card.id}`));
    }

    // Se não tem prazo, sugere definir
    if (!cardData.due) {
        buttons.push(Markup.button.callback('📅 Definir Prazo', `suggest_trello_due:${card.id}`));
    }

    // Se não tem descrição, sugere adicionar
    if (!cardData.desc) {
        buttons.push(Markup.button.callback('📝 Add Descrição', `suggest_trello_desc:${card.id}`));
    }

    // Sugere adicionar etiqueta
    buttons.push(Markup.button.callback('🏷️ Add Etiqueta', `suggest_trello_label:${card.id}`));

    if (buttons.length === 0) {
        return null;
    }

    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
    }

    return {
        message: '💡 _Quer completar o card?_',
        keyboard: Markup.inlineKeyboard(rows)
    };
}

/**
 * Botões de confirmação para conflitos
 */
function getConflictButtons(eventData, suggestions) {
    const buttons = [
        [
            Markup.button.callback('✅ Forçar Agendamento', 'conflict_force'),
            Markup.button.callback('❌ Cancelar', 'conflict_cancel')
        ]
    ];

    // Adiciona botões para sugestões de horário
    if (suggestions && suggestions.length > 0) {
        const suggestionButtons = suggestions.slice(0, 3).map((sug, i) =>
            Markup.button.callback(`${sug.start}`, `conflict_accept:${i}`)
        );
        buttons.push(suggestionButtons);
    }

    return Markup.inlineKeyboard(buttons);
}

/**
 * Botões para perguntar sobre recorrência
 */
function getRecurrenceButtons(eventId) {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('📅 Só esta vez', `recurrence_single:${eventId}`),
            Markup.button.callback('🔄 Todas as vezes', `recurrence_all:${eventId}`)
        ]
    ]);
}

module.exports = {
    getEventSuggestions,
    getTaskSuggestions,
    getTrelloSuggestions,
    getConflictButtons,
    getRecurrenceButtons
};
