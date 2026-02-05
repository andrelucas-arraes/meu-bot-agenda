require('dotenv').config();
const { Telegraf } = require('telegraf');
const { interpretMessage } = require('./services/ai');
const googleService = require('./services/google');
const trelloService = require('./services/trello');
const { DateTime } = require('luxon');
const scheduler = require('./services/scheduler');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Init scheduler
scheduler.initScheduler(bot);

// Middleware
bot.use(async (ctx, next) => {
    const allowedIds = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(id => id.trim());
    const userId = String(ctx.from.id);
    if (allowedIds.length > 0 && !allowedIds.includes(userId) && allowedIds[0] !== '') {
        return ctx.reply(`🚫 Acesso negado. Seu ID é: ${userId}`);
    }
    return next();
});

bot.start((ctx) => ctx.reply('👋 Olá! Sou seu Assistente Supremo (Edito, Apago e Organizo tudo!).'));

// --- HELPERS INTELIGENTES ---

// Encontrar evento por fuzzy search simples (contém texto)
async function findEventByQuery(query) {
    // Busca eventos da semana (passado e futuro próximo) para ter contexto
    const now = DateTime.now();
    const start = now.minus({ days: 7 }).toISO();
    const end = now.plus({ days: 30 }).toISO();

    const events = await googleService.listEvents(start, end);
    // Simples: se o titulo contiver a query
    const match = events.find(e => e.summary && e.summary.toLowerCase().includes(query.toLowerCase()));
    return match;
}

async function findTaskByQuery(query) {
    const tasks = await googleService.listTasks();
    return tasks.find(t => t.title.toLowerCase().includes(query.toLowerCase()));
}

async function findTrelloCardByQuery(query) {
    const cards = await trelloService.listCards();
    return cards.find(c => c.name.toLowerCase().includes(query.toLowerCase()));
}

// ---------------------------

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    await ctx.sendChatAction('typing');

    try {
        const userId = String(ctx.from.id);
        const intentResult = await interpretMessage(text, userId);
        console.log('Intenção:', intentResult);

        const intents = Array.isArray(intentResult) ? intentResult : [intentResult];

        for (const intent of intents) {
            await processIntent(ctx, intent);
        }

    } catch (error) {
        console.error('Erro:', error);
        await ctx.reply(`❌ Erro: ${error.message}`);
    }
});

async function processIntent(ctx, intent) {
    if (intent.tipo === 'create_event' || intent.tipo === 'evento') {
        const event = await googleService.createEvent(intent);
        const start = DateTime.fromISO(intent.start).setZone('America/Sao_Paulo');

        // Atualiza cache local para o lembrete funcionar se for hoje
        scheduler.refreshEventsCache();

        await ctx.reply(`✅ *Agendado:* [${intent.summary}](${event.htmlLink})\n📅 ${start.toFormat('dd/MM HH:mm')}`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'list_events') {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        const end = now.plus({ days: intent.period === 'week' ? 7 : 1 }).endOf('day');
        const events = await googleService.listEvents(now.startOf('day').toISO(), end.toISO());

        if (events.length === 0) await ctx.reply('📅 Nada agendado.');
        else {
            let msg = '📅 *Eventos:*\n';
            events.forEach(e => {
                const time = DateTime.fromISO(e.start.dateTime || e.start.date).setZone('America/Sao_Paulo');
                msg += `▪️ ${time.toFormat('dd/MM HH:mm')} - ${e.summary}\n`;
            });
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        }

    } else if (intent.tipo === 'update_event') {
        const event = await findEventByQuery(intent.query);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}".`);

        await googleService.updateEvent(event.id, intent);
        await ctx.reply(`✅ Evento "${event.summary}" atualizado!`);

    } else if (intent.tipo === 'complete_event') {
        const event = await findEventByQuery(intent.query);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}".`);

        const newSummary = event.summary.startsWith('✅') ? event.summary : `✅ ${event.summary}`;
        await googleService.updateEvent(event.id, { summary: newSummary, colorId: '8' }); // 8 = Grey
        await ctx.reply(`✅ Evento "${event.summary}" marcado como concluído!`);

    } else if (intent.tipo === 'delete_event') {
        const event = await findEventByQuery(intent.query);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}".`);

        await googleService.deleteEvent(event.id);
        await ctx.reply(`🗑️ Evento "${event.summary}" apagado.`);


        // --- GOOGLE TASKS ---
    } else if (intent.tipo === 'create_task' || intent.tipo === 'tarefa') {
        await googleService.createTask(intent);
        await ctx.reply(`✅ *Tarefa criada:* ${intent.title}`, { parse_mode: 'Markdown' });

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
        await ctx.reply(`✅ Tarefa "${task.title}" atualizada.`);

    } else if (intent.tipo === 'complete_task') {
        const task = await findTaskByQuery(intent.query);
        if (!task) return ctx.reply('⚠️ Tarefa não encontrada.');
        await googleService.completeTask(task.id, task.taskListId);
        await ctx.reply(`✅ Tarefa "${task.title}" concluída!`);

    } else if (intent.tipo === 'delete_task') {
        const task = await findTaskByQuery(intent.query);
        if (!task) return ctx.reply('⚠️ Tarefa não encontrada.');
        await googleService.deleteTask(task.id, task.taskListId);
        await ctx.reply(`🗑️ Tarefa "${task.title}" apagada.`);


        // --- TRELLO ---
    } else if (intent.tipo === 'trello_create' || intent.tipo === 'trello') {
        const card = await trelloService.createCard(intent);
        // Se tiver checklist, criar
        if (intent.checklist && Array.isArray(intent.checklist)) {
            await trelloService.addChecklist(card.id, 'Checklist', intent.checklist);
        }
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
                    if (c.desc) msg += ` - _${c.desc}_`;
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
        await ctx.reply(`✅ Card "${card.name}" atualizado.`);

    } else if (intent.tipo === 'trello_archive') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');
        await trelloService.updateCard(card.id, { closed: true });
        await ctx.reply(`📦 Card "${card.name}" arquivado.`);

    } else if (intent.tipo === 'trello_add_comment') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');
        await trelloService.addComment(card.id, intent.comment);
        await ctx.reply(`💬 Comentário adicionado em "${card.name}"`);

    } else if (intent.tipo === 'trello_move') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) {
            // Retry finding card a bit later if it was just created (hack for async consistency)
            await new Promise(r => setTimeout(r, 1000));
            const retryCard = await findTrelloCardByQuery(intent.query);
            if (!retryCard) return ctx.reply('⚠️ Card não encontrado.');
            // Use retryCard
            const lists = await trelloService.getLists();
            const targetList = lists.find(l => l.name.toLowerCase().includes(intent.list.toLowerCase()));
            if (!targetList) return ctx.reply(`⚠️ Lista "${intent.list}" não encontrada.`);
            await trelloService.updateCard(retryCard.id, { idList: targetList.id });
            await ctx.reply(`✅ Card "${retryCard.name}" movido para *${targetList.name}*!`, { parse_mode: 'Markdown' });
            return;
        }

        if (!intent.list) return ctx.reply('⚠️ Preciso saber para qual lista mover (Ex: "Mover para Feito").');

        // Find Target List
        const lists = await trelloService.getLists();
        const targetList = lists.find(l => l.name.toLowerCase().includes(intent.list.toLowerCase()));

        if (!targetList) {
            const listNames = lists.map(l => l.name).join(', ');
            return ctx.reply(`⚠️ Lista "${intent.list}" não encontrada.\n📋 Listas disponíveis: ${listNames}`);
        }

        await trelloService.updateCard(card.id, { idList: targetList.id });
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

    } else {
        await ctx.reply(intent.message || 'Olá! Posso ajudar com Agenda, Tarefas, Trello e Google Drive.', { parse_mode: 'Markdown' });
    }
}

bot.catch((err) => {
    if (err && err.response && err.response.error_code === 409) {
        console.warn('⚠️  CONFLITO: Outra instância iniciou. Encerrando esta...');
        process.exit(0);
    }
    console.error('❌ Bot Error:', err);
});
bot.launch();
console.log('🤖 Bot Supremo Iniciado...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
