require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { interpretMessage } = require('./services/ai');
const googleService = require('./services/google');
const trelloService = require('./services/trello');
const { DateTime } = require('luxon');
const scheduler = require('./services/scheduler');
const { log } = require('./utils/logger');
const { rateLimiter } = require('./utils/rateLimiter');
const { formatFriendlyDate, getEventStatusEmoji, formatEventForDisplay } = require('./utils/dateFormatter');
const { findEventFuzzy, findTaskFuzzy, findTrelloCardFuzzy, findTrelloListFuzzy } = require('./utils/fuzzySearch');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Init scheduler
scheduler.initScheduler(bot);

// ============================================
// MIDDLEWARE: Autenticação
// ============================================
bot.use(async (ctx, next) => {
    const allowedIds = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(id => id.trim());
    const userId = String(ctx.from.id);
    if (allowedIds.length > 0 && !allowedIds.includes(userId) && allowedIds[0] !== '') {
        log.bot('Acesso negado', { userId, username: ctx.from.username });
        return ctx.reply(`🚫 Acesso negado. Seu ID é: ${userId}`);
    }
    return next();
});

// ============================================
// MIDDLEWARE: Rate Limiting
// ============================================
bot.use(async (ctx, next) => {
    // Ignora comandos (não contam no rate limit)
    if (ctx.message?.text?.startsWith('/')) {
        return next();
    }

    const userId = String(ctx.from.id);
    const check = rateLimiter.check(userId);

    if (!check.allowed) {
        log.bot('Rate limit atingido', { userId, resetIn: check.resetIn });
        return ctx.reply(check.message);
    }

    return next();
});

// ============================================
// COMANDOS
// ============================================

bot.start((ctx) => {
    log.bot('Start', { userId: ctx.from.id });
    ctx.reply('👋 Olá! Sou seu Assistente Supremo!\n\nPosso ajudar com:\n📅 Google Calendar\n✅ Google Tasks\n🗂️ Trello\n\nDigite /help para ver exemplos de uso.');
});

// Comando /help com menu interativo
bot.command('help', (ctx) => {
    log.bot('Help', { userId: ctx.from.id });

    const helpMessage = `
🤖 *Assistente Supremo - Ajuda*

Escolha uma categoria abaixo para ver exemplos de comandos:
    `;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Eventos (Calendar)', 'help_events')],
        [Markup.button.callback('✅ Tarefas (Tasks)', 'help_tasks')],
        [Markup.button.callback('🗂️ Trello', 'help_trello')],
        [Markup.button.callback('💡 Dicas Gerais', 'help_tips')]
    ]);

    ctx.reply(helpMessage, { parse_mode: 'Markdown', ...keyboard });
});

// Callbacks do menu de ajuda
bot.action('help_events', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
📅 *Eventos (Google Calendar)*

*Criar:*
• "Reunião amanhã às 14h"
• "Consulta dia 15 às 10h"
• "Call online com cliente sexta"
• "Yoga toda terça às 7h" (recorrente)

*Listar:*
• "O que tenho hoje?"
• "Agenda da semana"
• "Próximos compromissos"

*Editar:*
• "Muda a reunião para 16h"
• "Cancela a consulta de amanhã"
• "Marcar reunião como concluída"

*Dica:* Diga "online" para criar link do Meet automaticamente! 📹
    `, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'help_back')]]) });
});

bot.action('help_tasks', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
✅ *Tarefas (Google Tasks)*

*Criar:*
• "Lembrar de comprar leite"
• "Revisar documento até sexta"
• "Tarefa: enviar relatório"

*Listar:*
• "Minhas tarefas"
• "O que tenho pendente?"

*Gerenciar:*
• "Marcar comprar leite como feita"
• "Apagar tarefa revisar documento"

*Dica:* Tarefas são para coisas sem hora específica.
Para compromissos com hora, use eventos! 📅
    `, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'help_back')]]) });
});

bot.action('help_trello', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
🗂️ *Trello (Projetos)*

*Criar:*
• "Criar card Bug no login"
• "Card: Refatorar módulo com checklist: testes, deploy"

*Listar:*
• "Listar cards"
• "Meu board"

*Gerenciar:*
• "Mover Bug no login para Feito"
• "Adicionar etiqueta Urgente no card X"
• "Comentar no card X: já resolvido"
• "Arquivar card X"

*Dica:* Use Trello para tarefas maiores que precisam de rastreamento e subtarefas!
    `, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'help_back')]]) });
});

bot.action('help_tips', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
💡 *Dicas Gerais*

*Entendo linguagem natural:*
• "amanhã às 14h" ✅
• "semana que vem" ✅
• "toda segunda às 9h" ✅

*Múltiplas ações:*
• "Agendar daily às 9h e criar tarefa revisar métricas"

*Correções rápidas:*
• Depois de criar algo, diga "muda para 15h" e eu entendo!

*Emojis de status:*
• 🟢 Evento confirmado
• 🟡 Evento próximo (< 1h)
• 📹 Evento online
• 🔄 Evento recorrente

*Resumos automáticos:*
• 08:00 - Resumo do dia
• 14:00 - Check da tarde
• 15 min antes - Lembrete de eventos
    `, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'help_back')]]) });
});

bot.action('help_back', (ctx) => {
    ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Eventos (Calendar)', 'help_events')],
        [Markup.button.callback('✅ Tarefas (Tasks)', 'help_tasks')],
        [Markup.button.callback('🗂️ Trello', 'help_trello')],
        [Markup.button.callback('💡 Dicas Gerais', 'help_tips')]
    ]);
    ctx.editMessageText(`
🤖 *Assistente Supremo - Ajuda*

Escolha uma categoria abaixo para ver exemplos de comandos:
    `, { parse_mode: 'Markdown', ...keyboard });
});

// ============================================
// HELPERS INTELIGENTES (com Fuzzy Search)
// ============================================

async function findEventByQuery(query, targetDate = null) {
    let start, end;

    if (targetDate) {
        const target = DateTime.fromISO(targetDate).setZone('America/Sao_Paulo');
        start = target.startOf('day').toISO();
        end = target.endOf('day').toISO();
    } else {
        const now = DateTime.now();
        start = now.startOf('day').toISO();
        end = now.plus({ days: 30 }).toISO();
    }

    const events = await googleService.listEvents(start, end);

    // Usa busca fuzzy
    return findEventFuzzy(events, query);
}

async function findTaskByQuery(query) {
    const tasks = await googleService.listTasks();
    return findTaskFuzzy(tasks, query);
}

async function findTrelloCardByQuery(query) {
    const cards = await trelloService.listAllCards();
    return findTrelloCardFuzzy(cards, query);
}

// ============================================
// PROCESSADOR DE MENSAGENS
// ============================================

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = String(ctx.from.id);

    // Envia mensagem de processamento
    const processingMsg = await ctx.reply('⏳ Processando...');

    try {
        log.bot('Mensagem recebida', { userId, text: text.substring(0, 50) });

        await ctx.sendChatAction('typing');
        const intentResult = await interpretMessage(text, userId);

        log.bot('Intenção detectada', {
            userId,
            tipo: Array.isArray(intentResult) ? intentResult.map(i => i.tipo) : intentResult.tipo
        });

        const intents = Array.isArray(intentResult) ? intentResult : [intentResult];

        // Deleta mensagem de processamento
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });

        for (const intent of intents) {
            await processIntent(ctx, intent);
        }

    } catch (error) {
        log.apiError('Bot', error, { userId, text: text.substring(0, 50) });

        // Deleta mensagem de processamento
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });

        await ctx.reply(`❌ Erro: ${error.message}`);
    }
});

async function processIntent(ctx, intent) {
    // ============================================
    // EVENTOS
    // ============================================
    if (intent.tipo === 'create_event' || intent.tipo === 'evento') {
        const event = await googleService.createEvent(intent);
        const friendlyDate = formatFriendlyDate(intent.start);
        const emoji = event.hangoutLink ? '📹' : '📅';

        // Atualiza cache
        scheduler.invalidateCache('events');

        let msg = `✅ *Agendado:* [${intent.summary}](${event.htmlLink})\n${emoji} ${friendlyDate}`;

        if (event.hangoutLink) {
            msg += `\n\n📹 [Entrar na reunião](${event.hangoutLink})`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } else if (intent.tipo === 'list_events') {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        const end = now.plus({ days: intent.period === 'week' ? 7 : 1 }).endOf('day');
        const events = await googleService.listEvents(now.startOf('day').toISO(), end.toISO());

        if (events.length === 0) {
            await ctx.reply('📅 Nada agendado.');
        } else {
            let msg = '📅 *Eventos:*\n\n';
            events.forEach(e => {
                msg += formatEventForDisplay(e) + '\n';
            });
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        }

    } else if (intent.tipo === 'update_event') {
        const event = await findEventByQuery(intent.query, intent.target_date);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}"${intent.target_date ? ` na data ${intent.target_date}` : ''}.`);

        await googleService.updateEvent(event.id, intent);
        scheduler.invalidateCache('events');

        let msg = `✅ Evento "${event.summary}" atualizado!`;
        if (intent.target_date) msg += ` (Exceção criada para ${intent.target_date})`;

        await ctx.reply(msg);

    } else if (intent.tipo === 'complete_event') {
        const event = await findEventByQuery(intent.query, intent.target_date);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}".`);

        const newSummary = event.summary.startsWith('✅') ? event.summary : `✅ ${event.summary}`;
        await googleService.updateEvent(event.id, { summary: newSummary, colorId: '8' });
        scheduler.invalidateCache('events');

        await ctx.reply(`✅ Evento "${event.summary}" marcado como concluído!`);

    } else if (intent.tipo === 'delete_event') {
        const event = await findEventByQuery(intent.query, intent.target_date);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}"${intent.target_date ? ` na data ${intent.target_date}` : ''}.`);

        await googleService.deleteEvent(event.id);
        scheduler.invalidateCache('events');

        let msg = `🗑️ Evento "${event.summary}" apagado.`;
        if (event.recurringEventId) msg += ` (Apenas esta ocorrência)`;

        await ctx.reply(msg);

        // ============================================
        // TAREFAS
        // ============================================
    } else if (intent.tipo === 'create_task' || intent.tipo === 'tarefa') {
        await googleService.createTask(intent);
        scheduler.invalidateCache('tasks');

        await ctx.reply(`✅ *Tarefa criada:* ${intent.title || intent.name}`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'list_tasks') {
        const groups = await googleService.listTasksGrouped();
        if (groups.length === 0) return ctx.reply('✅ Nenhuma lista de tarefas encontrada.');

        let msg = '';
        groups.forEach(group => {
            msg += `📁 *${group.title}*\n`;
            if (group.tasks.length === 0) {
                msg += `   _(vazia)_\n`;
            } else {
                group.tasks.forEach(t => {
                    msg += `   ▫️ ${t.title}`;
                    if (t.notes) msg += `\n      📝 _${t.notes}_`;
                    msg += `\n`;
                });
            }
            msg += '\n';
        });
        await ctx.reply(msg, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'update_task') {
        const task = await findTaskByQuery(intent.query);
        if (!task) return ctx.reply('⚠️ Tarefa não encontrada.');

        await googleService.updateTask(task.id, intent, task.taskListId);
        scheduler.invalidateCache('tasks');

        await ctx.reply(`✅ Tarefa "${task.title}" atualizada.`);

    } else if (intent.tipo === 'complete_task') {
        const task = await findTaskByQuery(intent.query);
        if (!task) return ctx.reply('⚠️ Tarefa não encontrada.');

        await googleService.completeTask(task.id, task.taskListId);
        scheduler.invalidateCache('tasks');

        await ctx.reply(`✅ Tarefa "${task.title}" concluída!`);

    } else if (intent.tipo === 'delete_task') {
        const task = await findTaskByQuery(intent.query);
        if (!task) return ctx.reply('⚠️ Tarefa não encontrada.');

        await googleService.deleteTask(task.id, task.taskListId);
        scheduler.invalidateCache('tasks');

        await ctx.reply(`🗑️ Tarefa "${task.title}" apagada.`);

        // ============================================
        // TRELLO
        // ============================================
    } else if (intent.tipo === 'trello_create' || intent.tipo === 'trello') {
        const card = await trelloService.createCard(intent);

        if (intent.checklist && Array.isArray(intent.checklist)) {
            await trelloService.addChecklist(card.id, 'Checklist', intent.checklist);
        }

        scheduler.invalidateCache('trello');
        await ctx.reply(`✅ *Card Criado:* [${card.name}](${card.shortUrl})`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_list') {
        const groups = await trelloService.listAllCardsGrouped();

        if (groups.length === 0) return ctx.reply('🗂️ Nenhuma lista encontrada no Trello.');

        let msg = '*Quadro Trello:*\n\n';
        groups.forEach(group => {
            msg += `📁 *${group.name}*\n`;
            if (group.cards.length === 0) {
                msg += `   _(vazia)_\n`;
            } else {
                group.cards.forEach(c => {
                    msg += `   📌 [${c.name}](${c.shortUrl})`;
                    if (c.desc) msg += ` - _${c.desc.substring(0, 50)}${c.desc.length > 50 ? '...' : ''}_`;
                    msg += `\n`;
                });
            }
            msg += '\n';
        });

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } else if (intent.tipo === 'trello_update') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        await trelloService.updateCard(card.id, intent);
        scheduler.invalidateCache('trello');

        await ctx.reply(`✅ Card "${card.name}" atualizado.`);

    } else if (intent.tipo === 'trello_archive') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        await trelloService.updateCard(card.id, { closed: true });
        scheduler.invalidateCache('trello');

        await ctx.reply(`📦 Card "${card.name}" arquivado.`);

    } else if (intent.tipo === 'trello_add_comment') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        await trelloService.addComment(card.id, intent.comment);
        await ctx.reply(`💬 Comentário adicionado em "${card.name}"`);

    } else if (intent.tipo === 'trello_move') {
        let card = await findTrelloCardByQuery(intent.query);

        if (!card) {
            await new Promise(r => setTimeout(r, 1000));
            card = await findTrelloCardByQuery(intent.query);
            if (!card) return ctx.reply('⚠️ Card não encontrado.');
        }

        if (!intent.list) return ctx.reply('⚠️ Preciso saber para qual lista mover (Ex: "Mover para Feito").');

        const lists = await trelloService.getLists();
        const targetList = findTrelloListFuzzy(lists, intent.list);

        if (!targetList) {
            const listNames = lists.map(l => l.name).join(', ');
            return ctx.reply(`⚠️ Lista "${intent.list}" não encontrada.\n📋 Listas disponíveis: ${listNames}`);
        }

        await trelloService.updateCard(card.id, { idList: targetList.id });
        scheduler.invalidateCache('trello');

        await ctx.reply(`✅ Card "${card.name}" movido para *${targetList.name}*!`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_add_label') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const labels = await trelloService.getLabels();
        const targetLabel = labels.find(l =>
            (l.name && l.name.toLowerCase() === intent.label.toLowerCase()) ||
            (l.color && l.color.toLowerCase() === intent.label.toLowerCase())
        );

        if (!targetLabel) {
            const available = labels.map(l => l.name || l.color).join(', ');
            return ctx.reply(`⚠️ Etiqueta "${intent.label}" não encontrada.\n🏷️ Disponíveis: ${available}`);
        }

        await trelloService.addLabel(card.id, targetLabel.id);
        await ctx.reply(`✅ Etiqueta *${targetLabel.name || targetLabel.color}* adicionada ao card "${card.name}"`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_add_member') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const members = await trelloService.getMembers();
        const targetMember = members.find(m =>
            m.fullName.toLowerCase().includes(intent.member.toLowerCase()) ||
            m.username.toLowerCase().includes(intent.member.toLowerCase())
        );

        if (!targetMember) {
            return ctx.reply(`⚠️ Membro "${intent.member}" não encontrado.`);
        }

        await trelloService.addMember(card.id, targetMember.id);
        await ctx.reply(`✅ Membro *${targetMember.fullName}* adicionado ao card "${card.name}"`, { parse_mode: 'Markdown' });

        // ============================================
        // CHAT / FALLBACK
        // ============================================
    } else {
        await ctx.reply(intent.message || 'Olá! Posso ajudar com Agenda, Tarefas e Trello. Digite /help para exemplos.', { parse_mode: 'Markdown' });
    }
}

// ============================================
// ERROR HANDLING
// ============================================

bot.catch((err) => {
    if (err && err.response && err.response.error_code === 409) {
        log.warn('Conflito: Outra instância iniciou. Encerrando...');
        process.exit(0);
    }
    log.apiError('Bot', err);
});

// ============================================
// START
// ============================================

bot.launch({ dropPendingUpdates: true });
log.bot('Bot Supremo Iniciado');

process.once('SIGINT', () => {
    log.bot('Encerrando (SIGINT)');
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    log.bot('Encerrando (SIGTERM)');
    bot.stop('SIGTERM');
});
