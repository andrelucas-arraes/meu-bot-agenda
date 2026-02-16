require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const { interpretMessage, getStatus: getAiStatus } = require('./services/ai');
const googleService = require('./services/google');
const trelloService = require('./services/trello');
const knowledgeService = require('./services/knowledge');
const smartScheduling = require('./services/smartScheduling');
const { DateTime } = require('luxon');
const scheduler = require('./services/scheduler');
const { log, runWithContext } = require('./utils/logger');
const { rateLimiter } = require('./utils/rateLimiter');
const crypto = require('crypto');
const { formatFriendlyDate, getEventStatusEmoji, formatEventForDisplay } = require('./utils/dateFormatter');
const { findEventFuzzy, findTrelloCardFuzzy, findTrelloListFuzzy } = require('./utils/fuzzySearch');
const { getEventSuggestions, getTrelloSuggestions, getConflictButtons } = require('./utils/suggestions');
const actionHistory = require('./utils/actionHistory');
const confirmation = require('./utils/confirmation');
const { batchProcess } = require('./utils/batchProcessor');
const { formatTrelloCardListItem, cleanTrelloName } = require('./utils/trelloFormatter');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware de sessão persistente (salva em data/sessions.json)
const localSession = new LocalSession({
    database: 'data/sessions.json',
    property: 'session',
    storage: LocalSession.storagefileAsync
});
bot.use(localSession.middleware());

// MIDDLEWARE: Request Context (Traceability)
bot.use(async (ctx, next) => {
    const requestId = crypto.randomUUID();
    const userId = ctx.from?.id;

    return runWithContext({ requestId, userId }, async () => {
        // Log request start
        if (ctx.message?.text) {
            log.info('📩 Nova mensagem recebida', {
                text: ctx.message.text.substring(0, 50),
                chatId: ctx.chat?.id
            });
        }

        try {
            await next();
        } finally {
            // Opcional: logar fim do request
            // log.info('Request finalizado');
        }
    });
});

// Init scheduler
scheduler.initScheduler(bot);

// ============================================
// PERFIS DE USUÁRIO
// ============================================
const USER_PROFILES = {
    '1308852555': { name: 'Lazaro Dias', role: 'Colaborador', company: 'Gomes Empreendimentos' },
    '1405476881': { name: 'Wilfred Gomes', role: 'Dono', company: 'Gomes Empreendimentos' },
    '146495410': { name: 'Andre Lucas', role: 'Desenvolvedor', company: 'Tech Lead' }
};

function getUserContext(userId) {
    const profile = USER_PROFILES[userId];
    if (!profile) return '';
    return `USUÁRIO ATUAL:\nNOME: ${profile.name}\nFUNÇÃO: ${profile.role}\nEMPRESA: ${profile.company}`;
}

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
// TECLADO FIXO DE AÇÕES RÁPIDAS
// ============================================

const mainKeyboard = Markup.keyboard([
    ['📅 Agenda de Hoje', '📅 Agenda da Semana'],
    ['🗂️ Meu Trello', '🧠 Minha Memória'],
    ['🔄 Atualizar Tudo']
]).resize();

// Função helper para enviar com teclado
function replyWithKeyboard(ctx, message, options = {}) {
    return ctx.reply(message, { ...options, ...mainKeyboard });
}

// ============================================
// COMANDOS
// ============================================

bot.start((ctx) => {
    log.bot('Start', { userId: ctx.from.id });
    replyWithKeyboard(ctx, '👋 Olá! Sou seu Assistente Supremo!\n\nPosso ajudar com:\n📅 Google Calendar\n🗂️ Trello\n🧠 Guardar informações\n\nDigite /ajuda para ver exemplos ou use os botões abaixo! 👇');
});

bot.command('api', async (ctx) => {
    log.bot('Comando /api solicitado');

    const statusMsg = await ctx.reply('🔍 Verificando status dos serviços...');

    try {
        // Coleta status
        const ai = getAiStatus();
        const trello = trelloService.getStatus();
        const google = await googleService.getStatus();

        const uptime = process.uptime();
        const uptimeString = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

        const memory = process.memoryUsage();
        const memoryString = `${Math.round(memory.rss / 1024 / 1024)}MB`;

        const now = DateTime.now().setZone('America/Sao_Paulo');
        const timestamp = now.toFormat('dd/MM/yyyy HH:mm:ss');

        let msg = `📊 *Status do Sistema*\n`;
        msg += `🕒 ${timestamp}\n\n`;

        // AI
        msg += `🤖 *Inteligência Artificial*\n`;
        msg += `   • Modelo: ${ai.model}\n`;
        msg += `   • Status: ${ai.online ? '✅ Online' : '❌ Offline'}\n`;
        if (ai.usage) {
            msg += `   • Tokens Totais: ${ai.usage.totalTokens.toLocaleString()}\n`;
            msg += `   • Contexto (Prompt): ${ai.usage.promptTokens.toLocaleString()}\n`;
            msg += `   • Resposta (Tokens): ${ai.usage.candidateTokens.toLocaleString()}\n`;
            msg += `   • Sessões Ativas: ${ai.sessions || 0}\n`;
            msg += `   • Última Resp: ${ai.usage.lastRequestTokens} tokens\n`;
        }
        msg += '\n';

        // Trello
        msg += `🗂️ *Trello*\n`;
        msg += `   • Status: ${trello.online ? '✅ Online' : '❌ Configurar .env'}\n`;
        if (trello.rateLimit && trello.rateLimit.limit) {
            msg += `   • Limite: ${trello.rateLimit.remaining}/${trello.rateLimit.limit}\n`;
        } else {
            msg += `   • Limite: _(sem dados recentes)_\n`;
        }
        msg += '\n';

        // Google
        msg += `📅 *Google Services*\n`;
        msg += `   • Status: ${google.online ? '✅ Online' : '❌ Erro'}\n`;
        msg += `   • Autenticado: ${google.authenticated ? '✅ Sim' : '❌ Não'}\n`;
        if (google.error) msg += `   • Erro: _${google.error}_\n`;
        msg += '\n';

        // System
        msg += `⚙️ *Servidor*\n`;
        msg += `   • Uptime: ${uptimeString}\n`;
        msg += `   • Memória: ${memoryString}\n`;
        msg += `   • Node: ${process.version}\n`;
        msg += `   • PID: ${process.pid}\n`;

        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            msg,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        log.apiError('Status', error);
        ctx.reply('❌ Erro ao verificar status.');
    }
});

// Comando /help com menu interativo
bot.command('ajuda', (ctx) => {
    log.bot('Ajuda', { userId: ctx.from.id });

    const helpMessage = `
🤖 *Assistente Supremo - Ajuda*

Escolha uma categoria abaixo para ver exemplos de comandos:
    `;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Eventos (Calendar)', 'help_events')],
        [Markup.button.callback('🗂️ Trello', 'help_trello')],
        [Markup.button.callback('🧠 Memória', 'help_memory')],
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


bot.action('help_trello', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
🗂️ *Trello (Projetos)*

*Criar:*
• "Criar card Bug no login"
• "Card: Refatorar módulo com checklist: testes, deploy"

*Listar e Buscar:*
• "Listar cards" / "Meu board"
• "Procura cards sobre relatório" 🔍

*Ver Detalhes:*
• "Detalhes do card X"
• "Checklists do card X"

*Gerenciar Cards:*
• "Mover Bug no login para Feito"
• "Adicionar etiqueta Urgente no card X"
• "Remover etiqueta do card X"
• "Arquivar card X"
• "Deletar card X" 🗑️

*Checklists:*
• "Marca item 1 como feito no card X" ✅
• "Desmarca item Deploy no card X"
• "Remove item 2 do card X"

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
• "Agendar daily às 9h e criar card no Trello revisar métricas"

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

bot.action('help_memory', (ctx) => {
    ctx.answerCbQuery();
    ctx.editMessageText(`
🧠 *Memória (Segundo Cérebro)*

*Guardar informação:*
• "Guarda aí: a senha do wifi é 1234"
• "Lembra que o código do portão é 4590"
• "Anota: a ração do cachorro é Premium"

*Consultar:*
• "Qual a senha do wifi?"
• "Qual o código do portão?"
• "Qual a marca da ração?"

*Listar tudo:*
• "O que você lembra?"
• "Lista minhas memórias"

*Dica:* Use para guardar senhas, códigos, contatos e qualquer informação útil! 📝
    `, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Voltar', 'help_back')]]) });
});

bot.action('help_back', (ctx) => {
    ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📅 Eventos (Calendar)', 'help_events')],
        [Markup.button.callback('🗂️ Trello', 'help_trello')],
        [Markup.button.callback('🧠 Memória', 'help_memory')],
        [Markup.button.callback('💡 Dicas Gerais', 'help_tips')]
    ]);
    ctx.editMessageText(`
🤖 *Assistente Supremo - Ajuda*

Escolha uma categoria abaixo para ver exemplos de comandos:
    `, { parse_mode: 'Markdown', ...keyboard });
});

// ============================================
// COMANDO: /desfazer (Undo)
// ============================================
bot.command('desfazer', async (ctx) => {
    const userId = String(ctx.from.id);
    const lastAction = actionHistory.getLastAction(userId);

    if (!lastAction) {
        return ctx.reply('🔙 Nenhuma ação recente para desfazer.');
    }

    log.bot('Desfazer solicitado', { userId, actionType: lastAction.type });

    try {
        let undone = false;
        let msg = '';

        switch (lastAction.type) {
            case 'create_event':
                if (lastAction.result?.id) {
                    await googleService.deleteEvent(lastAction.result.id);
                    scheduler.invalidateCache('events');
                    msg = `🔙 Evento "${lastAction.data.summary || lastAction.result.summary}" foi removido.`;
                    undone = true;
                }
                break;

            case 'complete_event':
                if (lastAction.result?.id) {
                    const originalSummary = lastAction.data.originalSummary || lastAction.result.summary.replace('✅ ', '');
                    await googleService.updateEvent(lastAction.result.id, { summary: originalSummary });
                    scheduler.invalidateCache('events');
                    msg = `🔙 Evento "${originalSummary}" desmarcado como concluído.`;
                    undone = true;
                }
                break;

            case 'trello_create':
                if (lastAction.result?.id) {
                    await trelloService.deleteCard(lastAction.result.id);
                    scheduler.invalidateCache('trello');
                    msg = `🔙 Card "${lastAction.data.name}" foi removido.`;
                    undone = true;
                }
                break;

            case 'trello_archive':
                if (lastAction.result?.id) {
                    await trelloService.updateCard(lastAction.result.id, { closed: false });
                    scheduler.invalidateCache('trello');
                    msg = `🔙 Card "${lastAction.data.name}" foi restaurado.`;
                    undone = true;
                }
                break;

            default:
                msg = `⚠️ Não é possível desfazer a ação "${lastAction.type}".`;
        }

        if (undone) {
            actionHistory.markAsUndone(userId, lastAction.id);
        }

        ctx.reply(msg);

    } catch (error) {
        log.apiError('Undo', error);
        ctx.reply(`❌ Erro ao desfazer: ${error.message}`);
    }
});

// ============================================
// HANDLERS DE CONFIRMAÇÃO
// ============================================
bot.action(/^confirm_yes_(.+)$/, async (ctx) => {
    const confirmationId = ctx.match[1];
    const userId = String(ctx.from.id);
    const pending = confirmation.getPendingConfirmation(userId);

    await ctx.answerCbQuery();

    if (!pending || pending.id !== confirmationId) {
        return ctx.editMessageText('⚠️ Esta confirmação expirou ou já foi processada.');
    }

    confirmation.clearConfirmation(userId);
    log.bot('Confirmação aceita', { userId, actionType: pending.actionType });

    try {
        // Executa a ação confirmada
        await executeConfirmedAction(ctx, pending);
    } catch (error) {
        log.apiError('ConfirmAction', error);
        ctx.reply(`❌ Erro ao executar: ${error.message}`);
    }
});

bot.action(/^confirm_no_(.+)$/, async (ctx) => {
    const userId = String(ctx.from.id);
    confirmation.clearConfirmation(userId);

    await ctx.answerCbQuery('Ação cancelada');
    ctx.editMessageText('❌ Ação cancelada.');
});

// Função que executa ações confirmadas
async function executeConfirmedAction(ctx, pending) {
    const userId = String(ctx.from.id);

    switch (pending.actionType) {
        case 'complete_all_events':
            const events = pending.items;
            // Usa batchProcess para evitar rate limit da API Google Calendar
            await batchProcess(
                events,
                e => googleService.updateEvent(e.id, { summary: `✅ ${e.summary}`, colorId: '8' }),
                10,
                1000
            );
            scheduler.invalidateCache('events');
            actionHistory.recordAction(userId, pending.actionType, { count: events.length }, { eventIds: events.map(e => e.id) });
            await ctx.editMessageText(`✅ ${events.length} eventos marcados como concluídos!`);
            break;

        default:
            await ctx.editMessageText('⚠️ Tipo de confirmação não suportado.');
    }
}

// ============================================
// HANDLERS DO TECLADO FIXO
// ============================================

bot.hears('📅 Agenda de Hoje', async (ctx) => {
    log.bot('Teclado: Agenda de Hoje', { userId: ctx.from.id });

    try {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        const events = await googleService.listEvents(
            now.startOf('day').toISO(),
            now.endOf('day').toISO()
        );

        if (events.length === 0) {
            return replyWithKeyboard(ctx, '📅 *Hoje*\n\n✨ Nenhum evento agendado para hoje!', { parse_mode: 'Markdown' });
        }

        let msg = `📅 *Agenda de Hoje (${now.toFormat('dd/MM')})*\n\n`;
        events.forEach(e => {
            msg += formatEventForDisplay(e) + '\n';
        });

        replyWithKeyboard(ctx, msg, { parse_mode: 'Markdown' });
    } catch (error) {
        log.apiError('Bot', error);
        ctx.reply('❌ Erro ao buscar agenda.');
    }
});

bot.hears('📅 Agenda da Semana', async (ctx) => {
    log.bot('Teclado: Agenda da Semana', { userId: ctx.from.id });

    try {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        const events = await googleService.listEvents(
            now.startOf('day').toISO(),
            now.plus({ days: 7 }).endOf('day').toISO()
        );

        if (events.length === 0) {
            return replyWithKeyboard(ctx, '📅 *Próximos 7 dias*\n\n✨ Nenhum evento agendado!', { parse_mode: 'Markdown' });
        }

        let msg = `📅 *Agenda da Semana*\n\n`;
        events.forEach(e => {
            msg += formatEventForDisplay(e) + '\n';
        });

        replyWithKeyboard(ctx, msg, { parse_mode: 'Markdown' });
    } catch (error) {
        log.apiError('Bot', error);
        ctx.reply('❌ Erro ao buscar agenda.');
    }
});



bot.hears('🗂️ Meu Trello', async (ctx) => {
    log.bot('Teclado: Meu Trello', { userId: ctx.from.id });

    try {
        const groups = await trelloService.listAllCardsGrouped();

        if (groups.length === 0) {
            return replyWithKeyboard(ctx, '🗂️ *Trello*\n\n📭 Nenhuma lista encontrada.', { parse_mode: 'Markdown' });
        }

        let msg = '🗂️ *Meu Trello*\n\n';
        groups.forEach(group => {
            msg += `📁 *${group.name}* (${group.cards.length})\n`;
            if (group.cards.length === 0) {
                msg += `   _(vazia)_\n`;
            } else {
                group.cards.slice(0, 5).forEach(c => {
                    msg += formatTrelloCardListItem(c, { showDesc: false }) + '\n';
                });
                if (group.cards.length > 5) {
                    msg += `   _...e mais ${group.cards.length - 5} cards_\n`;
                }
            }
            msg += '\n';
        });

        replyWithKeyboard(ctx, msg, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (error) {
        log.apiError('Bot', error);
        ctx.reply('❌ Erro ao buscar Trello.');
    }
});

bot.hears('🔄 Atualizar Tudo', async (ctx) => {
    log.bot('Teclado: Atualizar Tudo', { userId: ctx.from.id });

    const processingMsg = await ctx.reply('🔄 Atualizando cache...');

    try {
        await scheduler.invalidateCache('all');
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });
        replyWithKeyboard(ctx, '✅ Cache atualizado! Dados sincronizados com Google e Trello.');
    } catch (error) {
        log.apiError('Bot', error);
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });
        ctx.reply('❌ Erro ao atualizar cache.');
    }
});

bot.hears('🧠 Minha Memória', async (ctx) => {
    log.bot('Teclado: Minha Memória', { userId: ctx.from.id });

    try {
        const items = knowledgeService.listInfo();

        if (items.length === 0) {
            return replyWithKeyboard(ctx, '🧠 *Memória*\n\n📭 Nenhuma informação guardada ainda.\n\n_Dica: Diga "Guarda aí: ..." para salvar algo!_', { parse_mode: 'Markdown' });
        }

        let msg = '🧠 *Minha Memória*\n\n';

        // Agrupa por categoria
        const grouped = {};
        items.forEach(item => {
            const cat = item.category || 'geral';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });

        for (const [category, catItems] of Object.entries(grouped)) {
            const categoryEmoji = {
                'pessoal': '👤',
                'casa': '🏠',
                'trabalho': '💼',
                'geral': '📁'
            }[category] || '📁';

            msg += `${categoryEmoji} *${category.charAt(0).toUpperCase() + category.slice(1)}*\n`;
            catItems.forEach(item => {
                msg += `   📝 *${item.key}*\n`;
                msg += `      ${item.value}\n`;
            });
            msg += '\n';
        }

        msg += `_Total: ${items.length} informações_`;

        replyWithKeyboard(ctx, msg, { parse_mode: 'Markdown' });
    } catch (error) {
        log.apiError('Bot', error);
        ctx.reply('❌ Erro ao buscar memória.');
    }
});

// ============================================
// CALLBACKS DE AÇÕES RÁPIDAS (Eventos)
// ============================================

// Adicionar Meet a um evento
bot.action(/event_add_meet:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    log.bot('Ação: Adicionar Meet', { eventId });

    try {
        await ctx.answerCbQuery('📹 Adicionando link do Meet...');

        // Busca o evento atual
        const auth = await require('./services/google');

        // Atualiza com conferência
        const event = await googleService.updateEvent(eventId, {
            conferenceData: {
                createRequest: {
                    requestId: Math.random().toString(36).substring(7),
                    conferenceSolutionKey: { type: 'hangoutsMeet' }
                }
            }
        });

        scheduler.invalidateCache('events');

        await ctx.editMessageText(
            `✅ Link do Meet adicionado ao evento!\n\n📹 O link será gerado automaticamente.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        log.apiError('Bot', error);
        ctx.answerCbQuery('❌ Erro ao adicionar Meet');
    }
});

// Editar evento (mostra opções)
bot.action(/event_edit:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    log.bot('Ação: Editar evento', { eventId });

    await ctx.answerCbQuery();

    const editKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('🕐 Mudar Horário', `event_edit_time:${eventId}`),
            Markup.button.callback('📝 Mudar Título', `event_edit_title:${eventId}`)
        ],
        [
            Markup.button.callback('📍 Mudar Local', `event_edit_location:${eventId}`),
            Markup.button.callback('✅ Marcar Concluído', `event_complete:${eventId}`)
        ],
        [Markup.button.callback('⬅️ Voltar', `event_back:${eventId}`)]
    ]);

    await ctx.editMessageText(
        '✏️ *O que você quer editar?*\n\nEscolha uma opção abaixo:',
        { parse_mode: 'Markdown', ...editKeyboard }
    );
});

// Editar horário - pede input
bot.action(/event_edit_time:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingEventUpdate = { id: eventId, field: 'time' };

    await ctx.editMessageText(
        `🕐 *Editar Horário*\n\nDigite o novo horário no formato natural:\n\n_Exemplo: "amanhã às 15h" ou "14:30"_`,
        { parse_mode: 'Markdown' }
    );
});

// Editar título - pede input
bot.action(/event_edit_title:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingEventUpdate = { id: eventId, field: 'summary' };

    await ctx.editMessageText(
        `📝 *Editar Título*\n\nDigite o novo título para o evento:`,
        { parse_mode: 'Markdown' }
    );
});

// Editar local - pede input
bot.action(/event_edit_location:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingEventUpdate = { id: eventId, field: 'location' };

    await ctx.editMessageText(
        `📍 *Editar Local*\n\nDigite o novo local do evento:\n\n_Exemplo: "Sala 3" ou "Rua X, 123"_`,
        { parse_mode: 'Markdown' }
    );
});

// Marcar evento como concluído
bot.action(/event_complete:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    log.bot('Ação: Completar evento', { eventId });

    try {
        await ctx.answerCbQuery('✅ Marcando como concluído...');

        // Busca evento para pegar o título atual
        const now = DateTime.now().setZone('America/Sao_Paulo');
        const events = await googleService.listEvents(
            now.minus({ days: 7 }).toISO(),
            now.plus({ days: 30 }).toISO()
        );

        const event = events.find(e => e.id === eventId);
        if (!event) {
            return ctx.editMessageText('⚠️ Evento não encontrado.');
        }

        const newSummary = event.summary.startsWith('✅') ? event.summary : `✅ ${event.summary}`;
        await googleService.updateEvent(eventId, { summary: newSummary, colorId: '8' });

        scheduler.invalidateCache('events');

        await ctx.editMessageText(`✅ Evento "${event.summary}" marcado como concluído!`);
    } catch (error) {
        log.apiError('Bot', error);
        ctx.answerCbQuery('❌ Erro ao marcar como concluído');
    }
});

// Deletar/Cancelar evento
bot.action(/event_delete:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];
    log.bot('Ação: Deletar evento', { eventId });

    await ctx.answerCbQuery();

    // Confirmação
    const confirmKeyboard = Markup.inlineKeyboard([
        [
            Markup.button.callback('✅ Sim, cancelar', `event_confirm_delete:${eventId}`),
            Markup.button.callback('❌ Não', `event_cancel_delete:${eventId}`)
        ]
    ]);

    await ctx.editMessageText(
        '⚠️ *Tem certeza que deseja cancelar este evento?*\n\nEsta ação não pode ser desfeita.',
        { parse_mode: 'Markdown', ...confirmKeyboard }
    );
});

// Confirmar deleção
bot.action(/event_confirm_delete:(.+)/, async (ctx) => {
    const eventId = ctx.match[1];

    try {
        await ctx.answerCbQuery('🗑️ Cancelando evento...');
        await googleService.deleteEvent(eventId);
        scheduler.invalidateCache('events');
        await ctx.editMessageText('🗑️ Evento cancelado com sucesso!');
    } catch (error) {
        log.apiError('Bot', error);
        ctx.editMessageText('❌ Erro ao cancelar evento.');
    }
});

// Cancelar deleção
bot.action(/event_cancel_delete:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Operação cancelada');
    await ctx.editMessageText('👍 Ok, evento mantido!');
});

// Voltar (remove botões de edição)
bot.action(/event_back:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText('👍 Ok! Use os botões abaixo para outras ações.', { parse_mode: 'Markdown' });
});

// ============================================


// ============================================
// CALLBACKS DE SUGESTÕES DO TRELLO
// ============================================

// Add checklist
bot.action(/suggest_trello_checklist:(.+)/, async (ctx) => {
    const cardId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingTrelloUpdate = { id: cardId, action: 'add_checklist' };

    await ctx.editMessageText('☑️ Digite os itens da checklist separados por vírgula (ex: "item 1, item 2"):');
});

// Add prazo
bot.action(/suggest_trello_due:(.+)/, async (ctx) => {
    const cardId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingTrelloUpdate = { id: cardId, action: 'set_due' };

    await ctx.editMessageText('📅 Digite o prazo para este card (ex: "amanhã"):');
});

// Add descrição
bot.action(/suggest_trello_desc:(.+)/, async (ctx) => {
    const cardId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingTrelloUpdate = { id: cardId, action: 'set_desc' };

    await ctx.editMessageText('📝 Digite a descrição para o card:');
});

// Add etiqueta
bot.action(/suggest_trello_label:(.+)/, async (ctx) => {
    const cardId = ctx.match[1];
    await ctx.answerCbQuery();

    ctx.session = ctx.session || {};
    ctx.session.pendingTrelloUpdate = { id: cardId, action: 'add_label' };

    await ctx.editMessageText('🏷️ Digite o nome ou cor da etiqueta (ex: "urgente", "red"):');
});

// ============================================
// CALLBACKS DE CONFLITO (Smart Scheduling)
// ============================================

// Forçar agendamento mesmo com conflito
bot.action('conflict_force', async (ctx) => {
    await ctx.answerCbQuery('📅 Criando evento...');

    try {
        if (!ctx.session?.pendingEvent) {
            return ctx.editMessageText('⚠️ Dados do evento perdidos. Por favor, tente novamente.');
        }

        const intent = ctx.session.pendingEvent;
        const event = await googleService.createEvent(intent);
        scheduler.invalidateCache('events');

        const friendlyDate = formatFriendlyDate(intent.start);
        await ctx.editMessageText(`✅ *Agendado (com conflito):* ${intent.summary}\n📅 ${friendlyDate}`, { parse_mode: 'Markdown' });

        // Limpa sessão
        delete ctx.session.pendingEvent;
        delete ctx.session.conflictSuggestions;
    } catch (error) {
        log.apiError('Bot', error);
        ctx.editMessageText('❌ Erro ao criar evento.');
    }
});

// Cancelar agendamento
bot.action('conflict_cancel', async (ctx) => {
    await ctx.answerCbQuery('Agendamento cancelado');

    if (ctx.session) {
        delete ctx.session.pendingEvent;
        delete ctx.session.conflictSuggestions;
    }

    await ctx.editMessageText('👍 Ok, evento não criado.');
});

// Aceitar sugestão de horário alternativo
bot.action(/conflict_accept:(\d+)/, async (ctx) => {
    const suggestionIndex = parseInt(ctx.match[1]);
    await ctx.answerCbQuery('📅 Criando evento...');

    try {
        if (!ctx.session?.pendingEvent || !ctx.session?.conflictSuggestions) {
            return ctx.editMessageText('⚠️ Dados do evento perdidos. Por favor, tente novamente.');
        }

        const suggestion = ctx.session.conflictSuggestions[suggestionIndex];
        if (!suggestion) {
            return ctx.editMessageText('⚠️ Sugestão inválida.');
        }

        const intent = {
            ...ctx.session.pendingEvent,
            start: suggestion.startISO,
            end: suggestion.endISO
        };

        const event = await googleService.createEvent(intent);
        scheduler.invalidateCache('events');

        const friendlyDate = formatFriendlyDate(suggestion.startISO);
        await ctx.editMessageText(`✅ *Agendado:* ${intent.summary}\n📅 ${friendlyDate}`, { parse_mode: 'Markdown' });

        // Limpa sessão
        delete ctx.session.pendingEvent;
        delete ctx.session.conflictSuggestions;
    } catch (error) {
        log.apiError('Bot', error);
        ctx.editMessageText('❌ Erro ao criar evento.');
    }
});

// ============================================
// CALLBACKS DE KNOWLEDGE BASE
// ============================================

// Deletar informação da KB
bot.action(/kb_delete:(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCbQuery('🗑️ Deletando...');

    try {
        const deleted = knowledgeService.deleteInfo(id);
        if (deleted) {
            await ctx.editMessageText('🗑️ Informação deletada da memória.');
        } else {
            await ctx.editMessageText('⚠️ Informação não encontrada.');
        }
    } catch (error) {
        log.apiError('Bot', error);
        ctx.editMessageText('❌ Erro ao deletar.');
    }
});

// Atualizar informação da KB (pede novo valor)
bot.action(/kb_update:(.+)/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCbQuery();

    // Armazena o ID para atualização
    ctx.session = ctx.session || {};
    ctx.session.pendingKBUpdate = id;

    await ctx.editMessageText('✏️ Digite o novo valor para esta informação:');
});

// ============================================
// CALLBACKS DE TRELLO (Deleção de Cards)
// ============================================

// Confirmar deleção de card
bot.action(/trello_confirm_delete:(.+)/, async (ctx) => {
    const cardId = ctx.match[1];

    try {
        await ctx.answerCbQuery('🗑️ Deletando card...');

        // Pega o nome da sessão se disponível
        const cardName = ctx.session?.pendingTrelloDelete?.name || 'Card';

        await trelloService.deleteCard(cardId);
        scheduler.invalidateCache('trello');

        await ctx.editMessageText(`🗑️ Card "${cardName}" deletado permanentemente.`);

        // Limpa sessão
        if (ctx.session?.pendingTrelloDelete) {
            delete ctx.session.pendingTrelloDelete;
        }
    } catch (error) {
        log.apiError('Bot', error);
        ctx.editMessageText('❌ Erro ao deletar card.');
    }
});

// Cancelar deleção de card
bot.action(/trello_cancel_delete:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Operação cancelada');

    if (ctx.session?.pendingTrelloDelete) {
        delete ctx.session.pendingTrelloDelete;
    }

    await ctx.editMessageText('👍 Ok, card mantido!');
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



async function findTrelloCardByQuery(query) {
    const cards = await trelloService.listAllCards();
    let card = null;

    // 1. Tenta buscar por número (ex: "02", "item 02", "card 10")
    // Regex captura apenas o número final
    const numberMatch = query.match(/^(?:item|card|tarefa|n[º°])?\s*0*(\d+)$/i);

    if (numberMatch) {
        const num = numberMatch[1];
        const paddedNum = num.padStart(2, '0'); // ex: "2" -> "02"

        // Procura por "02. Título" ou "2. Título"
        card = cards.find(c =>
            c.name.startsWith(`${paddedNum}.`) ||
            c.name.startsWith(`${num}.`)
        );

        if (card) {
            log.bot('Card encontrado por número', { query, found: card.name });
            return card;
        }
    }

    // 2. Busca Fuzzy normal (pelo nome)
    card = findTrelloCardFuzzy(cards, query);

    if (!card) {
        // Fallback: Busca na API (fluxo para encontrar cards arquivados)
        try {
            const searchResults = await trelloService.searchCards(query);
            if (searchResults && searchResults.length > 0) {
                card = searchResults[0];
            }
        } catch (e) {
            log.error('Erro no fallback de busca Trello', e);
        }
    }
    return card;
}

// ============================================
// PROCESSADOR DE MENSAGENS
// ============================================

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const userId = String(ctx.from.id);

    // ============================================
    // STATE MACHINE (Processa inputs de fluxos pendentes)
    // ============================================

    // 1. Atualização de Knowledge Base
    if (ctx.session?.pendingKBUpdate) {
        const id = ctx.session.pendingKBUpdate;
        try {
            await knowledgeService.updateInfo(id, text);
            await ctx.reply('✅ Informação atualizada com sucesso!');
        } catch (error) {
            log.apiError('Bot', error);
            await ctx.reply('❌ Erro ao atualizar informação.');
        }
        delete ctx.session.pendingKBUpdate;
        return;
    }



    // 3. Atualização de Trello
    if (ctx.session?.pendingTrelloUpdate) {
        const { id, action } = ctx.session.pendingTrelloUpdate;
        try {
            if (action === 'add_checklist') {
                const items = text.split(',').map(i => i.trim()).filter(i => i);
                await trelloService.addChecklist(id, 'Checklist', items);
                await ctx.reply('✅ Checklist adicionada!');
            } else if (action === 'set_due') {
                await trelloService.updateCard(id, { due: text }); // Trello service deve tratar formato
                await ctx.reply('✅ Prazo definido!');
            } else if (action === 'set_desc') {
                await trelloService.updateCard(id, { desc: text });
                await ctx.reply('✅ Descrição atualizada!');
            } else if (action === 'add_label') {
                // Precisa buscar ID da label pelo nome/cor
                const labels = await trelloService.getLabels();
                const targetLabel = labels.find(l =>
                    (l.name && l.name.toLowerCase() === text.toLowerCase()) ||
                    (l.color && l.color.toLowerCase() === text.toLowerCase())
                );

                if (targetLabel) {
                    await trelloService.addLabel(id, targetLabel.id);
                    await ctx.reply(`✅ Etiqueta *${targetLabel.name || targetLabel.color}* adicionada!`, { parse_mode: 'Markdown' });
                } else {
                    await ctx.reply('⚠️ Etiqueta não encontrada.');
                }
            }
            scheduler.invalidateCache('trello');
        } catch (error) {
            log.apiError('Bot', error);
            await ctx.reply('❌ Erro ao atualizar card.');
        }
        delete ctx.session.pendingTrelloUpdate;
        return;
    }

    // 4. Atualização de Evento (Edição)
    if (ctx.session?.pendingEventUpdate) {
        const { id, field } = ctx.session.pendingEventUpdate;
        try {
            const updates = {};

            if (field === 'summary') {
                updates.summary = text;
                await googleService.updateEvent(id, updates);
                await ctx.reply('✅ Título atualizado!');
            } else if (field === 'location') {
                updates.location = text;
                await googleService.updateEvent(id, updates);
                await ctx.reply('✅ Local atualizado!');
            } else if (field === 'time') {
                // Check if user wants to cancel the edit
                if (text.toLowerCase() === 'cancelar' || text.toLowerCase() === 'voltar') {
                    await ctx.reply('👍 Edição de horário cancelada.');
                    delete ctx.session.pendingEventUpdate;
                    return;
                }

                // Usa a IA para interpretar a nova data
                const interpretation = await interpretMessage(`alterar horário para ${text}`, userId, getUserContext(userId));
                const intent = Array.isArray(interpretation) ? interpretation[0] : interpretation;

                if (intent.start) {
                    updates.start = intent.start;
                    if (intent.end) updates.end = intent.end;
                    else {
                        // Se não tiver fim, assume 1h de duração padrão se for com hora
                        if (updates.start.includes('T')) {
                            const startDt = DateTime.fromISO(updates.start);
                            updates.end = startDt.plus({ hours: 1 }).toISO();
                        }
                    }

                    await googleService.updateEvent(id, updates);
                    await ctx.reply(`✅ Horário atualizado para ${formatFriendlyDate(updates.start)}!`);
                } else {
                    await ctx.reply('⚠️ Não consegui entender o novo horário. Tente novamente (ex: "amanhã às 15h") ou digite "cancelar" para sair.');
                    return; // Não limpa sessão para permitir tentar de novo
                }
            }

            scheduler.invalidateCache('events');
        } catch (error) {
            log.apiError('Bot', error);
            await ctx.reply('❌ Erro ao atualizar evento.');
        }
        delete ctx.session.pendingEventUpdate;
        return;
    }

    // Envia mensagem de processamento
    const processingMsg = await ctx.reply('⏳ Processando...');

    try {
        log.bot('Mensagem recebida', { userId, text: text.substring(0, 50) });

        await ctx.sendChatAction('typing');
        let intentResult = await interpretMessage(text, userId, getUserContext(userId));

        // Fallback de segurança: Se o usuário mencionou datas relativas e a IA se confundiu ou omitiu
        const nowSP = DateTime.now().setZone('America/Sao_Paulo');
        const lowText = text.toLowerCase();

        let forcedDate = null;
        if (lowText.includes('amanhã') && !lowText.includes('depois de amanhã')) {
            forcedDate = nowSP.plus({ days: 1 }).toFormat('yyyy-MM-dd');
        } else if (lowText.includes('depois de amanhã')) {
            forcedDate = nowSP.plus({ days: 2 }).toFormat('yyyy-MM-dd');
        } else {
            // Fallback para dias da semana
            const weekDaysMap = {
                'segunda': 1, 'segunda-feira': 1,
                'terça': 2, 'terça-feira': 2, 'terca': 2,
                'quarta': 3, 'quarta-feira': 3,
                'quinta': 4, 'quinta-feira': 4,
                'sexta': 5, 'sexta-feira': 5,
                'sábado': 6, 'sabado': 6,
                'domingo': 7
            };

            for (const [dayName, dayNum] of Object.entries(weekDaysMap)) {
                if (lowText.includes(dayName)) {
                    let target = nowSP;
                    // Encontra a próxima ocorrência do dia (incluindo hoje)
                    // Se hoje for terça (2) e pedirem terça, retorna hoje.
                    while (target.weekday !== dayNum) {
                        target = target.plus({ days: 1 });
                    }

                    // Se disser "próxima", garante que seja semana que vem se for hoje
                    if ((lowText.includes('próxima') || lowText.includes('proxima')) && target.hasSame(nowSP, 'day')) {
                        target = target.plus({ days: 7 });
                    }

                    forcedDate = target.toFormat('yyyy-MM-dd');
                    break;
                }
            }
        }

        if (forcedDate) {
            if (Array.isArray(intentResult)) {
                intentResult.forEach(i => {
                    // Sobrescreve se for igual a hoje ou se estiver nulo
                    if (!i.target_date || i.target_date === nowSP.toFormat('yyyy-MM-dd')) {
                        i.target_date = forcedDate;
                    }
                });
            } else if (intentResult) {
                if (!intentResult.target_date || intentResult.target_date === nowSP.toFormat('yyyy-MM-dd')) {
                    intentResult.target_date = forcedDate;
                }
            }
        }

        log.bot('Intenção detalhada', { userId, intent: JSON.stringify(intentResult) });

        const intents = Array.isArray(intentResult) ? intentResult : [intentResult];

        // Deleta mensagem de processamento
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });

        for (const intent of intents) {
            try {
                await processIntent(ctx, intent);
            } catch (intentError) {
                log.error('Erro ao processar intenção específica', { error: intentError.message, intent: intent.tipo });
                await ctx.reply(`⚠️ Tive um problema ao processar: ${intent.tipo}. Mas o resto pode ter funcionado.`);
            }
        }

    } catch (error) {
        log.apiError('Bot Main Loop', error, { userId, text: text.substring(0, 50) });
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => { });
        await ctx.reply(`❌ Erro técnico: ${error.message}. Tente reformular o pedido.`);
    }
});

async function processIntent(ctx, intent) {
    // ============================================
    // EVENTOS
    // ============================================
    if (intent.tipo === 'create_event' || intent.tipo === 'evento') {
        // --- SMART SCHEDULING: Verifica conflitos antes de criar ---
        const conflictCheck = await smartScheduling.checkConflicts(intent);

        if (conflictCheck.hasConflict) {
            // Detecta prioridade do pedido
            const priority = intent.priority ? { priority: intent.priority } : {};

            // Armazena intent para uso posterior
            ctx.session = ctx.session || {};
            ctx.session.pendingEvent = { ...intent, ...priority };
            ctx.session.conflictSuggestions = conflictCheck.suggestions;

            const conflictMsg = smartScheduling.formatConflictMessage(intent, conflictCheck);
            const buttons = getConflictButtons(intent, conflictCheck.suggestions);

            return ctx.reply(conflictMsg, { parse_mode: 'Markdown', ...buttons });
        }

        // --- Valida contexto do agendamento ---
        const contextValidation = smartScheduling.validateSchedulingContext(intent);

        if (!contextValidation.isValid) {
            return ctx.reply(`⚠️ *Não foi possível agendar*\n\n${contextValidation.warnings[0]}`, { parse_mode: 'Markdown' });
        }

        const event = await googleService.createEvent(intent);
        const friendlyDate = formatFriendlyDate(intent.start);
        const emoji = event.hangoutLink ? '📹' : '📅';

        // Atualiza cache
        scheduler.invalidateCache('events');

        let msg = `✅ *Agendado:* [${intent.summary}](${event.htmlLink})\n${emoji} ${friendlyDate}`;

        // Mostra prioridade se alta
        if (intent.priority === 'high') {
            msg = `🔴 *URGENTE* - ${msg}`;
        } else if (intent.priority === 'medium') {
            msg = `🟡 ${msg}`;
        }

        if (event.hangoutLink) {
            msg += `\n\n📹 [Entrar na reunião](${event.hangoutLink})`;
        }

        // Mostra avisos do contexto (se houver)
        if (contextValidation.warnings.length > 0) {
            msg += `\n\n⚠️ _${contextValidation.warnings.join(' | ')}_`;
        }

        // Botões de ação rápida
        const actionButtons = [];

        // Se não tem Meet, oferece adicionar
        if (!event.hangoutLink) {
            actionButtons.push(Markup.button.callback('📹 Add Meet', `event_add_meet:${event.id}`));
        }

        actionButtons.push(Markup.button.callback('✏️ Editar', `event_edit:${event.id}`));
        actionButtons.push(Markup.button.callback('🗑️ Cancelar', `event_delete:${event.id}`));

        const inlineKeyboard = Markup.inlineKeyboard([actionButtons]);

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true, ...inlineKeyboard });

        // --- POST-ACTION SUGGESTIONS ---
        const suggestions = getEventSuggestions(event, intent);
        if (suggestions) {
            await ctx.reply(suggestions.message, { parse_mode: 'Markdown', ...suggestions.keyboard });
        }

    } else if (intent.tipo === 'list_events') {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        let start, end, periodLabel;

        // Suporte a target_date para datas específicas (amanhã, sexta, etc.)
        if (intent.target_date) {
            const target = DateTime.fromISO(intent.target_date, { zone: 'America/Sao_Paulo' });
            start = target.startOf('day');
            if (intent.period === 'week') {
                end = target.plus({ days: 7 }).endOf('day');
                periodLabel = `semana a partir de ${target.toFormat('dd/MM')}`;
            } else {
                end = target.endOf('day');
                periodLabel = target.hasSame(now.plus({ days: 1 }), 'day')
                    ? 'amanhã'
                    : target.toFormat('dd/MM (cccc)', { locale: 'pt-BR' });
            }
        } else {
            start = now.startOf('day');
            if (intent.period === 'week') {
                end = now.plus({ days: 7 }).endOf('day');
                periodLabel = 'próximos 7 dias';
            } else {
                end = now.endOf('day');
                periodLabel = 'hoje';
            }
        }

        const events = await googleService.listEvents(start.toISO(), end.toISO());

        if (events.length === 0) {
            await ctx.reply(`📅 Nada agendado para ${periodLabel}.`);
        } else {
            let msg = `📅 *Eventos (${periodLabel}):*\n\n`;
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

    } else if (intent.tipo === 'complete_all_events') {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        let start, end, periodLabel;

        if (intent.period === 'day' || !intent.period) {
            start = now.startOf('day').toISO();
            end = now.endOf('day').toISO();
            periodLabel = 'hoje';
        } else if (intent.period === 'week') {
            start = now.startOf('day').toISO();
            end = now.plus({ days: 7 }).endOf('day').toISO();
            periodLabel = 'esta semana';
        } else {
            // Trata como data específica
            const target = DateTime.fromISO(intent.period, { zone: 'America/Sao_Paulo' });
            start = target.startOf('day').toISO();
            end = target.endOf('day').toISO();
            periodLabel = target.toFormat('dd/MM');
        }

        const events = await googleService.listEvents(start, end);

        if (events.length === 0) {
            return ctx.reply(`📅 Nenhum evento encontrado para ${periodLabel}.`);
        }

        // Filtra eventos que ainda não estão marcados como concluídos
        const pendingEvents = events.filter(e => !e.summary.startsWith('✅'));

        if (pendingEvents.length === 0) {
            return ctx.reply(`✅ Todos os eventos de ${periodLabel} já estão concluídos!`);
        }

        await ctx.reply(`⏳ Marcando ${pendingEvents.length} eventos como concluídos...`);

        // Processa em paralelo
        const promises = pendingEvents.map(e =>
            googleService.updateEvent(e.id, { summary: `✅ ${e.summary}`, colorId: '8' })
        );
        await Promise.all(promises);

        scheduler.invalidateCache('events');
        await ctx.reply(`✅ ${pendingEvents.length} eventos de ${periodLabel} marcados como concluídos!`);

    } else if (intent.tipo === 'delete_event') {
        const event = await findEventByQuery(intent.query, intent.target_date);
        if (!event) return ctx.reply(`⚠️ Não encontrei evento com "${intent.query}"${intent.target_date ? ` na data ${intent.target_date}` : ''}.`);

        await googleService.deleteEvent(event.id);
        scheduler.invalidateCache('events');

        let msg = `🗑️ Evento "${event.summary}" apagado.`;
        if (event.recurringEventId) msg += ` (Apenas esta ocorrência)`;

        await ctx.reply(msg);



    } else if (intent.tipo === 'report') {
        const now = DateTime.now().setZone('America/Sao_Paulo');
        // Se a IA detectou uma data específica (ex: amanhã), usa ela. Senão usa hoje.
        const referenceDate = intent.target_date ? DateTime.fromISO(intent.target_date, { zone: 'America/Sao_Paulo' }) : now;

        let period = intent.period || 'day';
        let startDate = referenceDate.startOf('day');
        let endDate;

        if (period === 'week') {
            endDate = referenceDate.plus({ days: 7 }).endOf('day');
        } else {
            endDate = referenceDate.endOf('day');
        }

        const periodLabel = intent.target_date
            ? (referenceDate.hasSame(now.plus({ days: 1 }), 'day') ? 'amanhã' : referenceDate.toFormat('dd/MM'))
            : (period === 'week' ? 'esta semana' : 'hoje');

        // Busca todos os dados com tratamento de erro individual
        let events = [], trelloGroups = [];

        try {
            const results = await Promise.allSettled([
                googleService.listEvents(startDate.toISO(), endDate.toISO()),
                trelloService.listAllCardsGrouped()
            ]);

            if (results[0].status === 'fulfilled') events = results[0].value;
            else log.error('Erro ao buscar eventos para o report', { error: results[0].reason?.message });

            if (results[1].status === 'fulfilled') trelloGroups = results[1].value;
            else log.error('Erro ao buscar trello para o report', { error: results[1].reason?.message });

        } catch (e) {
            log.error('Erro global no report', { error: e.message });
        }

        // Trello "A Fazer"
        const todoCards = trelloGroups
            .filter(g => g.name.toLowerCase().includes('a fazer') || g.name.toLowerCase().includes('to do'))
            .flatMap(g => g.cards);



        let msg = `📋 *RELATÓRIO ${periodLabel.toUpperCase()}* (${referenceDate.toFormat('dd/MM')})\n\n`;

        // Se alguma API falhou, avisa no topo
        if (trelloGroups.length === 0) {
            msg += `⚠️ _Alguns dados podem estar incompletos devido a erro na API._\n\n`;
        }

        // ESTATÍSTICAS
        msg += `📊 *Resumo:*\n`;
        msg += `   • ${events.length} eventos\n`;
        msg += `   • ${todoCards.length} cards no Trello\n\n`;

        // EVENTOS
        if (events.length > 0) {
            msg += `📅 *Eventos:*\n`;
            events.slice(0, 10).forEach(e => {
                msg += formatEventForDisplay(e) + '\n';
            });
            if (events.length > 10) msg += `   _...e mais ${events.length - 10} eventos_\n`;
            msg += '\n';
        } else {
            msg += `📅 _Nenhum evento ${periodLabel}_\n\n`;
        }



        // TRELLO
        if (todoCards.length > 0) {
            msg += `🗂️ *Trello (A Fazer):*\n`;
            todoCards.slice(0, 10).forEach(c => {
                msg += formatTrelloCardListItem(c, { showDesc: false }) + '\n';
            });
            if (todoCards.length > 10) msg += `   _...e mais ${todoCards.length - 10} cards_\n`;
        } else {
            msg += `🗂️ _Nenhum card pendente_\n`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

        // ============================================
        // TRELLO
        // ============================================
    } else if (intent.tipo === 'trello_create' || intent.tipo === 'trello') {
        const intentData = { ...intent };

        // FALLBACK: Tenta extrair status da descrição (Prioridade sobre o que a IA inferiu)
        if (intentData.desc) {
            // Match: "Status: Value", "Status : Value", "### Status\nValue"
            const statusMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Status(?:\*\*|__)?\s*(?::|(?:\s*-\s*)?|(?:\r?\n)+)(?:\s*-\s*)?([^\r\n]+)/i);

            if (statusMatch) {
                let extractedStatus = statusMatch[1].trim();
                // Limpa qualificadores extras: "Em andamento (dependendo de Wilfred)" → "Em andamento"
                extractedStatus = extractedStatus
                    .replace(/\s*\(.*?\)\s*/g, '')
                    .replace(/\s*-\s+dependendo.*$/i, '')
                    .replace(/\s*dependendo\s+de\s+.*/i, '')
                    .trim();
                // Override apenas se encontrou algo válido e diferente de "vazio"
                if (extractedStatus && extractedStatus.length > 2) {
                    intentData.list_query = extractedStatus;
                    log.bot('Fallback: Status extraído da descrição (Override)', { list: intentData.list_query });
                }
            }
        }

        // FALLBACK labels: Sempre tenta extrair extras da descrição, mesmo que já existam algumas
        if (intentData.desc) {
            const extraLabels = [];

            // Tipo de caso
            const tipoMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Tipo de caso(?:\*\*|__)?\s*(?::|(?:\r?\n)+)(?:\s*-\s*)?([^\r\n]+)/i);
            if (tipoMatch) extraLabels.push(tipoMatch[1].trim());

            // Prioridade
            const prioMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Prioridade(?:\*\*|__)?\s*(?::|(?:\s*-\s*)?|(?:\r?\n)+)(?:\s*[-:]?\s*)?([^\r\n]+)/i);
            if (prioMatch) extraLabels.push(prioMatch[1].trim());

            if (extraLabels.length > 0) {
                // Se já existe label_query, garante que é array e faz merge
                let currentLabels = [];
                if (intentData.label_query) {
                    currentLabels = Array.isArray(intentData.label_query) ? intentData.label_query : [intentData.label_query];
                }

                // Adiciona apenas se não duplicar
                for (const l of extraLabels) {
                    if (!currentLabels.some(cl => cl.toLowerCase() === l.toLowerCase())) {
                        currentLabels.push(l);
                    }
                }

                intentData.label_query = currentLabels;
                log.bot('Fallback: Labels mescladas da descrição', { labels: currentLabels });
            }
        }

        // FORÇA PRIORIDADE COMO LABEL (Se não for keyword padrão e ainda não estiver nas labels)
        if (intentData.priority) {
            const prio = intentData.priority;
            // Ignora keywords que já têm tratamento especial ou não devem virar label textualmente
            const ignore = ['high', 'medium', 'low', 'urgent', 'normal', 'urgente'];

            if (!ignore.includes(prio.toLowerCase())) {
                let currentLabels = [];
                if (intentData.label_query) {
                    currentLabels = Array.isArray(intentData.label_query) ? intentData.label_query : [intentData.label_query];
                }

                // Adiciona se não existir (case insensitive check)
                if (!currentLabels.some(l => l.toLowerCase() === prio.toLowerCase())) {
                    currentLabels.push(prio); // Usa o valor original (casing)
                    intentData.label_query = currentLabels;
                    log.bot('Label inferida de Prioridade (custom)', { label: prio });
                }
            }
        }

        let targetListId = process.env.TRELLO_LIST_ID_INBOX;

        // Busca lista específica se solicitada
        if (intentData.list_query) {
            const groups = await trelloService.listAllCardsGrouped();

            // LIMPEZA do list_query: Remove parênteses e qualificadores extras
            // Ex: "Em andamento (dependendo de Wilfred)" → "Em andamento"
            // Ex: "Parado (dependendo de Wellington)" → "Parado"
            let cleanListQuery = intentData.list_query
                .replace(/\s*\(.*?\)\s*/g, '')  // Remove conteúdo entre parênteses
                .replace(/\s*-\s+dependendo.*$/i, '')  // Remove "- dependendo de..."
                .replace(/\s*dependendo\s+de\s+.*/i, '')  // Remove "dependendo de ..."
                .trim();

            // Se a limpeza resultou em string vazia, usa o original
            if (!cleanListQuery) cleanListQuery = intentData.list_query.trim();

            // Log para debug
            log.bot('Buscando lista Trello', {
                queryOriginal: intentData.list_query,
                queryCleaned: cleanListQuery,
                availableLists: groups.map(g => g.name)
            });

            const normalize = str => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            const queryNorm = normalize(cleanListQuery);

            // 1. Tenta match exato normalizado primeiro
            let targetList = groups.find(g => normalize(g.name) === queryNorm);

            // 2. Tenta busca fuzzy
            if (!targetList) {
                targetList = findTrelloListFuzzy(groups, cleanListQuery);
            }

            // 3. Fallback: Busca bidirecional "contains" normalizado
            // Ex: "Parado" encontra "Lista Parado" (nome contém query)
            // Ex: "Em andamento extra texto" encontra "Em andamento" (query contém nome)
            if (!targetList) {
                targetList = groups.find(g => {
                    const nameNorm = normalize(g.name);
                    return nameNorm.includes(queryNorm) || queryNorm.includes(nameNorm);
                });
            }

            // 4. Fallback: Primeiro palavra significativa da query (ex: "Parado" de "Parado dependendo de X")
            if (!targetList) {
                const firstWord = queryNorm.split(/\s+/)[0];
                if (firstWord && firstWord.length > 2) {
                    targetList = groups.find(g => normalize(g.name).includes(firstWord));
                    if (targetList) {
                        log.bot('Match por primeira palavra', { firstWord, found: targetList.name });
                    }
                }
            }

            if (targetList) {
                intentData.idList = targetList.id;
                targetListId = targetList.id;
                log.bot('Usando lista Trello especificada', { listName: targetList.name, query: intentData.list_query });
            } else {
                await ctx.reply(`⚠️ Lista Trello "${intentData.list_query}" não encontrada. Criando na Inbox.`);
            }
        }

        // AUTO-NUMBERING: Adiciona prefixo numérico (ex: "01. ")
        try {
            if (targetListId) {
                const existingCards = await trelloService.listCards(targetListId);
                let maxNum = 0;

                existingCards.forEach(c => {
                    const match = c.name.match(/^(\d+)\./);
                    if (match) {
                        const num = parseInt(match[1], 10);
                        if (!isNaN(num) && num > maxNum) {
                            maxNum = num;
                        }
                    }
                });

                const nextNum = maxNum + 1;
                const prefix = String(nextNum).padStart(2, '0') + '. ';

                // Garante que temos um nome e evita duplicar prefixo
                if (!intentData.name && intentData.title) intentData.name = intentData.title; // Fallback comum

                if (intentData.name && !intentData.name.match(/^(\d+)\./)) {
                    intentData.name = prefix + intentData.name;
                }
            }
        } catch (error) {
            log.error('Erro ao calcular numeração automática do card', error);
            // Segue sem numeração em caso de erro
        }



        // Validação de data (Trello exige ISO 8601)
        if (intentData.due) {
            const dueTime = DateTime.fromISO(intentData.due, { zone: 'America/Sao_Paulo' });
            if (!dueTime.isValid) {
                log.warn('Data Trello inválida (create), ignorando data', { due: intentData.due });
                delete intentData.due;
            }
        }

        // --- RESOLUÇÃO DE LABELS (Tipo de caso, etc.) ---
        try {
            const boardLabels = await trelloService.getLabels();
            const availableLabelNames = boardLabels.map(l => l.name).filter(Boolean);
            log.bot('Labels disponíveis no Board', { count: boardLabels.length, names: availableLabelNames });

            let labelsToAdd = [];

            // 1. Label solicitada explicitamente (label_query) - Suporta string ou array
            if (intentData.label_query) {
                const queries = Array.isArray(intentData.label_query) ? intentData.label_query : [intentData.label_query];

                for (const rawQuery of queries) {
                    const query = rawQuery.trim();
                    if (!query) continue;

                    // Normalização para busca: remove acentos e espaços extras
                    const normalize = str => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
                    const normalizedQuery = normalize(query);

                    // 1. Match exato normalizado
                    let targetLabel = boardLabels.find(l =>
                        l.name && normalize(l.name) === normalizedQuery
                    );

                    // 2. Match parcial (fallback) se não achou exato
                    // Ex: "Rotina" matches "Rotinas" ou "Prioridade: Rotina" matches "Rotina"
                    if (!targetLabel) {
                        targetLabel = boardLabels.find(l =>
                            l.name && (normalize(l.name).includes(normalizedQuery) || normalizedQuery.includes(normalize(l.name)))
                        );
                        if (targetLabel) {
                            log.bot('Label match parcial', { query, found: targetLabel.name });
                        }
                    }

                    if (!targetLabel) {
                        try {
                            log.bot('Criando nova label no Trello', { name: query });
                            targetLabel = await trelloService.createLabel(query, 'sky');
                        } catch (err) {
                            log.error('Erro ao criar label automática', { query, error: err.message });
                        }
                    }

                    if (targetLabel) {
                        if (!labelsToAdd.includes(targetLabel.id)) {
                            labelsToAdd.push(targetLabel.id);
                            log.bot('Label vinculada', { query, label: targetLabel.name });
                        }
                    }
                }
            }

            // 2. Prioridade Alta (Label Vermelha)
            if (intentData.priority === 'high') {
                const redLabel = boardLabels.find(l => l.color === 'red');
                if (redLabel && !labelsToAdd.includes(redLabel.id)) {
                    labelsToAdd.push(redLabel.id);
                }
            }

            if (labelsToAdd.length > 0) {
                intentData.labels = labelsToAdd.join(',');
            }
        } catch (error) {
            log.error('Erro ao resolver labels na criação', error);
        }


        // FALLBACK Checklist: Extrair "Pendência atual"
        // Se a IA já enviou checklist direto, usa. Senão tenta extrair da desc.
        if (intentData.checklist && Array.isArray(intentData.checklist) && intentData.checklist.length > 0) {
            // IA já enviou checklist - verificar se itens precisam de split adicional
            const expandedItems = [];
            for (const item of intentData.checklist) {
                // Se o item contém ; ou , que parece separar sub-itens, faz split
                if (item.includes(';')) {
                    expandedItems.push(...item.split(';').map(s => s.trim()).filter(s => s));
                } else {
                    expandedItems.push(item.trim());
                }
            }
            intentData.checklist = expandedItems;

            // Usa checklist_name da IA se disponível
            if (intentData.checklist_name) {
                intentData.checklistName = intentData.checklist_name;
            } else {
                intentData.checklistName = 'Pendência atual';
            }
            log.bot('Checklist da IA processada', { name: intentData.checklistName, count: intentData.checklist.length });
        } else if (intentData.desc) {
            // FALLBACK: Tenta extrair "Pendência atual" da descrição
            const pendenciaMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Pendência atual(?:\*\*|__)?(?::|(?:\r?\n)+)(?:\s*-\s*)?((?:.|\n)*?)(?=(?:\n(?:###|(?:\*\*|__)?(?:Cliente|Tipo de caso|Observações|Prioridade|Status)(?:\*\*|__)?))|$)/i);

            if (pendenciaMatch) {
                const pendenciaText = pendenciaMatch[1].trim();
                if (pendenciaText) {
                    // Split inteligente: por quebra de linha, ; ou ,
                    let items;
                    if (pendenciaText.includes(';')) {
                        items = pendenciaText.split(';');
                    } else if (pendenciaText.includes('\n')) {
                        items = pendenciaText.split(/\r?\n/);
                    } else if (pendenciaText.includes(',') && pendenciaText.split(',').length > 1) {
                        items = pendenciaText.split(',');
                    } else {
                        items = [pendenciaText];
                    }

                    items = items.map(l => l.replace(/^-\s*/, '').replace(/^\d+\.\s*/, '').trim()).filter(l => l);

                    if (items.length > 0) {
                        intentData.checklist = items;
                        intentData.checklistName = 'Pendência atual';
                        log.bot('Fallback: Checklist extraída da descrição', { count: items.length });
                    }
                }
            }
        }

        // FALLBACK Title: Formatar como "Cliente - Tipo de Caso"
        if (intentData.desc) {
            const clienteMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Cliente(?:\*\*|__)?(?::|(?:\r?\n)+)(?:\s*-\s*)?([^\r\n]+)/i);
            const tipoMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Tipo de caso(?:\*\*|__)?(?::|(?:\r?\n)+)(?:\s*-\s*)?([^\r\n]+)/i);

            if (clienteMatch && tipoMatch) {
                intentData.name = `${clienteMatch[1].trim()} - ${tipoMatch[1].trim()}`;
                log.bot('Fallback: Nome do card atualizado', { name: intentData.name });
            }
        }

        // LIMPEZA DA DESCRIÇÃO: Manter apenas Observações
        if (intentData.desc) {
            const obsMatch = intentData.desc.match(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?Observações(?:\*\*|__)?(?::|(?:\r?\n)+)(?:\s*-\s*)?((?:.|\n)*?)(?=(?:\n(?:###|(?:\*\*|__)?(?:Cliente|Tipo de caso|Pendência atual|Prioridade|Status)(?:\*\*|__)?))|$)/i);

            if (obsMatch) {
                const obsText = obsMatch[1].trim();
                if (obsText) {
                    // Formata as observações como lista markdown se ainda não estiver
                    const obsLines = obsText.split(/\r?\n/).map(l => l.trim()).filter(l => l);
                    const formattedObs = obsLines.map(l => l.startsWith('-') ? l : `- ${l}`).join('\n');
                    intentData.desc = `### Observações\n${formattedObs}`;
                } else {
                    intentData.desc = '';
                }
            } else {
                // Se não encontrou observações explícitas, limpa campos conhecidos
                let cleanedDesc = intentData.desc
                    .replace(/(?:^|\n)(?:###\s*)?(?:\*\*|__)?(Cliente|Tipo de caso|Pendência atual|Prioridade|Status)(?:\*\*|__)?(?::|(?:\r?\n)+)(?:.*)(?=\n|$)/gi, '')
                    .trim();

                intentData.desc = cleanedDesc;
            }
        }

        const card = await trelloService.createCard(intentData);

        if (intentData.checklist && Array.isArray(intentData.checklist)) {
            await trelloService.addChecklist(card.id, intentData.checklistName || 'Checklist', intentData.checklist);
        }



        scheduler.invalidateCache('trello');

        let msg = `✅ *Card Criado:* [${card.name}](${card.shortUrl})`;
        if (intentData.priority === 'high') {
            msg = `🔴 *URGENTE* - ${msg}`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown' });

        // --- POST-ACTION SUGGESTIONS ---
        const suggestions = getTrelloSuggestions(card, intent);
        if (suggestions) {
            await ctx.reply(suggestions.message, { parse_mode: 'Markdown', ...suggestions.keyboard });
        }

    } else if (intent.tipo === 'trello_clear_list') {
        if (!intent.list_query) {
            return ctx.reply('⚠️ Qual lista você quer limpar? (Ex: "Limpar lista Feito")');
        }

        const groups = await trelloService.listAllCardsGrouped();
        const targetList = findTrelloListFuzzy(groups, intent.list_query);

        if (!targetList) {
            return ctx.reply(`⚠️ Lista "${intent.list_query}" não encontrada.`);
        }

        if (targetList.cards.length === 0) {
            return ctx.reply(`✅ A lista "*${targetList.name}*" já está vazia!`, { parse_mode: 'Markdown' });
        }

        await ctx.reply(`⏳ Arquivando ${targetList.cards.length} cards da lista "${targetList.name}"...`);

        // Arquiva em paralelo
        const promises = targetList.cards.map(c => trelloService.updateCard(c.id, { closed: true }));
        await Promise.all(promises);

        scheduler.invalidateCache('trello');
        await ctx.reply(`📦 Todos os cards da lista "*${targetList.name}*" foram arquivados!`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_list') {
        let groups = await trelloService.listAllCardsGrouped();
        if (groups.length === 0) return ctx.reply('🗂️ Nenhuma lista encontrada no Trello.');

        // Filtragem por lista
        if (intent.list_query) {
            // Reutiliza a lógica fuzzy para encontrar a lista certa ou filtrar
            const filtered = findTrelloListFuzzy(groups, intent.list_query);
            if (filtered) {
                groups = [filtered]; // Mostra apenas a lista encontrada
            } else {
                return ctx.reply(`⚠️ Nenhuma lista encontrada com o nome "${intent.list_query}".`);
            }
        }

        let msg = '*Quadro Trello:*\n\n';
        groups.forEach(group => {
            msg += `📁 *${group.name}*\n`;
            if (group.cards.length === 0) {
                msg += `   _(vazia)_\n`;
            } else {
                group.cards.forEach(c => {
                    msg += formatTrelloCardListItem(c, { descLength: 60 }) + '\n';
                });
            }
            msg += '\n';
        });

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } else if (intent.tipo === 'trello_update') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const updateData = { ...intent };
        // Validação de data
        if (updateData.due) {
            const dueTime = DateTime.fromISO(updateData.due, { zone: 'America/Sao_Paulo' });
            if (!dueTime.isValid) {
                log.warn('Data Trello inválida (update), ignorando data', { due: updateData.due });
                delete updateData.due;
            }
        }

        await trelloService.updateCard(card.id, updateData);
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

        const updateData = { idList: targetList.id };
        if (card.closed) {
            updateData.closed = false;
        }

        await trelloService.updateCard(card.id, updateData);
        scheduler.invalidateCache('trello');

        let msg = `✅ Card "${card.name}" movido para *${targetList.name}*!`;
        if (card.closed) {
            msg += ` (Restaurado do arquivo)`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown' });

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
        // TRELLO - NOVOS ENDPOINTS AVANÇADOS
        // ============================================
    } else if (intent.tipo === 'trello_delete') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        // Confirmação antes de deletar
        const confirmKeyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Sim, deletar', `trello_confirm_delete:${card.id}`),
                Markup.button.callback('❌ Não', `trello_cancel_delete:${card.id}`)
            ]
        ]);

        // Salva o nome na sessão para mensagem posterior
        ctx.session = ctx.session || {};
        ctx.session.pendingTrelloDelete = { id: card.id, name: card.name };

        await ctx.reply(
            `⚠️ *Tem certeza que deseja DELETAR PERMANENTEMENTE o card?*\n\n📌 *${cleanTrelloName(card.name)}*\n\n_Esta ação não pode ser desfeita!_`,
            { parse_mode: 'Markdown', ...confirmKeyboard }
        );

    } else if (intent.tipo === 'trello_search') {
        const cards = await trelloService.searchCards(intent.query);

        if (cards.length === 0) {
            return ctx.reply(`🔍 Nenhum card encontrado com "${intent.query}"`);
        }

        let msg = `🔍 *Busca: "${intent.query}"*\n\n`;
        msg += `📊 Encontrados: ${cards.length} cards\n\n`;

        cards.slice(0, 10).forEach((c, i) => {
            msg += `${i + 1}. ${formatTrelloCardListItem(c, { showEmoji: false, descLength: 100 }).trim()}\n\n`;
        });

        if (cards.length > 10) {
            msg += `_...e mais ${cards.length - 10} cards_`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } else if (intent.tipo === 'trello_get') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        // Busca detalhes completos
        const cardDetails = await trelloService.getCard(card.id);

        let msg = `📌 *${cleanTrelloName(cardDetails.name)}*\n`;
        msg += `🔗 [Abrir no Trello](${cardDetails.url})\n\n`;

        // Descrição
        if (cardDetails.desc) {
            msg += `📝 *Descrição:*\n${cardDetails.desc.substring(0, 500)}${cardDetails.desc.length > 500 ? '...' : ''}\n\n`;
        }

        // Due date
        if (cardDetails.due) {
            const dueEmoji = cardDetails.dueComplete ? '✅' : '📅';
            msg += `${dueEmoji} *Prazo:* ${formatFriendlyDate(cardDetails.due)}\n`;
        }

        // Labels
        if (cardDetails.labels && cardDetails.labels.length > 0) {
            const labelNames = cardDetails.labels.map(l => l.name || l.color).join(', ');
            msg += `🏷️ *Etiquetas:* ${labelNames}\n`;
        }

        // Members
        if (cardDetails.members && cardDetails.members.length > 0) {
            const memberNames = cardDetails.members.map(m => m.fullName || m.username).join(', ');
            msg += `👥 *Membros:* ${memberNames}\n`;
        }

        // Checklists summary
        if (cardDetails.checklists && cardDetails.checklists.length > 0) {
            msg += `\n☑️ *Checklists:*\n`;
            cardDetails.checklists.forEach(cl => {
                const completed = cl.checkItems.filter(i => i.state === 'complete').length;
                const total = cl.checkItems.length;
                msg += `   • ${cl.name} (${completed}/${total})\n`;
            });
        }

        // Attachments
        if (cardDetails.attachments && cardDetails.attachments.length > 0) {
            msg += `\n📎 *Anexos:* ${cardDetails.attachments.length} arquivo(s)\n`;
        }

        // Last activity
        if (cardDetails.dateLastActivity) {
            msg += `\n🕐 _Última atividade: ${formatFriendlyDate(cardDetails.dateLastActivity)}_`;
        }

        await ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } else if (intent.tipo === 'trello_checklist') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const checklists = await trelloService.getCardChecklists(card.id);

        if (checklists.length === 0) {
            return ctx.reply(`📌 O card "*${cleanTrelloName(card.name)}*" não tem checklists.`, { parse_mode: 'Markdown' });
        }

        let msg = `☑️ *Checklists de "${cleanTrelloName(card.name)}"*\n\n`;

        checklists.forEach((cl, clIndex) => {
            const completed = cl.checkItems.filter(i => i.state === 'complete').length;
            const total = cl.checkItems.length;
            msg += `📋 *${cl.name}* (${completed}/${total})\n`;

            cl.checkItems.forEach((item, itemIndex) => {
                const checked = item.state === 'complete' ? '✅' : '⬜';
                msg += `   ${itemIndex + 1}. ${checked} ${item.name}\n`;
            });
            msg += '\n';
        });

        msg += `\n_Dica: Diga "marca item 1 como feito no card ${card.name}" para marcar_`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_check_item') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const checklists = await trelloService.getCardChecklists(card.id);
        if (checklists.length === 0) {
            return ctx.reply(`⚠️ O card "${card.name}" não tem checklists.`);
        }

        // Encontra o item por nome ou posição
        let targetItem = null;
        let targetChecklist = null;
        const itemQuery = intent.item.toString().toLowerCase();
        const itemNum = parseInt(intent.item);

        // Tenta por número (posição global)
        if (!isNaN(itemNum) && itemNum > 0) {
            let globalIndex = 0;
            for (const cl of checklists) {
                for (const item of cl.checkItems) {
                    globalIndex++;
                    if (globalIndex === itemNum) {
                        targetItem = item;
                        targetChecklist = cl;
                        break;
                    }
                }
                if (targetItem) break;
            }
        }

        // Se não encontrou por número, tenta por nome
        if (!targetItem) {
            for (const cl of checklists) {
                const found = cl.checkItems.find(i =>
                    i.name.toLowerCase().includes(itemQuery)
                );
                if (found) {
                    targetItem = found;
                    targetChecklist = cl;
                    break;
                }
            }
        }

        if (!targetItem) {
            return ctx.reply(`⚠️ Item "${intent.item}" não encontrado nas checklists do card.`);
        }

        const newState = intent.state || 'complete';
        await trelloService.updateCheckItem(card.id, targetItem.id, { state: newState });
        scheduler.invalidateCache('trello');

        const emoji = newState === 'complete' ? '✅' : '⬜';
        await ctx.reply(
            `${emoji} Item "${targetItem.name}" ${newState === 'complete' ? 'marcado como feito' : 'desmarcado'} no card *${card.name}*`,
            { parse_mode: 'Markdown' }
        );

    } else if (intent.tipo === 'trello_delete_check_item') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        const checklists = await trelloService.getCardChecklists(card.id);
        if (checklists.length === 0) {
            return ctx.reply(`⚠️ O card "${card.name}" não tem checklists.`);
        }

        // Encontra o item por nome ou posição (mesma lógica do check_item)
        let targetItem = null;
        const itemQuery = intent.item.toString().toLowerCase();
        const itemNum = parseInt(intent.item);

        if (!isNaN(itemNum) && itemNum > 0) {
            let globalIndex = 0;
            for (const cl of checklists) {
                for (const item of cl.checkItems) {
                    globalIndex++;
                    if (globalIndex === itemNum) {
                        targetItem = item;
                        break;
                    }
                }
                if (targetItem) break;
            }
        }

        if (!targetItem) {
            for (const cl of checklists) {
                const found = cl.checkItems.find(i =>
                    i.name.toLowerCase().includes(itemQuery)
                );
                if (found) {
                    targetItem = found;
                    break;
                }
            }
        }

        if (!targetItem) {
            return ctx.reply(`⚠️ Item "${intent.item}" não encontrado nas checklists do card.`);
        }

        await trelloService.deleteCheckItem(card.id, targetItem.id);
        scheduler.invalidateCache('trello');

        await ctx.reply(`🗑️ Item "${targetItem.name}" removido do card *${card.name}*`, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'trello_remove_label') {
        const card = await findTrelloCardByQuery(intent.query);
        if (!card) return ctx.reply('⚠️ Card não encontrado.');

        // Busca detalhes do card para ver as labels
        const cardDetails = await trelloService.getCard(card.id);

        if (!cardDetails.labels || cardDetails.labels.length === 0) {
            return ctx.reply(`⚠️ O card "${card.name}" não tem etiquetas.`);
        }

        // Encontra a label
        const targetLabel = cardDetails.labels.find(l =>
            (l.name && l.name.toLowerCase() === intent.label.toLowerCase()) ||
            (l.color && l.color.toLowerCase() === intent.label.toLowerCase())
        );

        if (!targetLabel) {
            const available = cardDetails.labels.map(l => l.name || l.color).join(', ');
            return ctx.reply(`⚠️ Etiqueta "${intent.label}" não encontrada no card.\n🏷️ Etiquetas do card: ${available}`);
        }

        await trelloService.removeLabel(card.id, targetLabel.id);
        scheduler.invalidateCache('trello');

        await ctx.reply(`✅ Etiqueta *${targetLabel.name || targetLabel.color}* removida do card "${card.name}"`, { parse_mode: 'Markdown' });

        // ============================================
        // KNOWLEDGE BASE (MEMÓRIA DE LONGO PRAZO)
        // ============================================
    } else if (intent.tipo === 'store_info') {
        const stored = knowledgeService.storeInfo({
            key: intent.key,
            value: intent.value,
            category: intent.category || 'geral'
        });

        log.bot('Informação armazenada', { key: stored.key, category: stored.category });

        let msg = `🧠 *Guardado!*\n\n`;
        msg += `📝 *${stored.key}*\n`;
        msg += `${stored.value}\n\n`;
        msg += `🏷️ Categoria: _${stored.category}_`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'query_info') {
        const result = knowledgeService.queryInfo(intent.query);

        if (!result) {
            return ctx.reply(`🔍 Não encontrei nada sobre "${intent.query}" na memória.\n\n_Dica: Use "Guarda aí: ..." para salvar informações._`, { parse_mode: 'Markdown' });
        }

        log.bot('Informação consultada', { query: intent.query, found: result.key });

        let msg = `🧠 *Encontrei!*\n\n`;
        msg += `📝 *${result.key}*\n`;
        msg += `${result.value}`;

        // Botões de ação
        const buttons = Markup.inlineKeyboard([
            [
                Markup.button.callback('✏️ Atualizar', `kb_update:${result.id}`),
                Markup.button.callback('🗑️ Deletar', `kb_delete:${result.id}`)
            ]
        ]);

        await ctx.reply(msg, { parse_mode: 'Markdown', ...buttons });

    } else if (intent.tipo === 'list_info') {
        const items = knowledgeService.listInfo(intent.category);

        if (items.length === 0) {
            const catMsg = intent.category ? ` na categoria "${intent.category}"` : '';
            return ctx.reply(`🧠 Nenhuma informação guardada${catMsg}.\n\n_Dica: Use "Guarda aí: ..." para salvar informações._`, { parse_mode: 'Markdown' });
        }

        let msg = '🧠 *Memória*\n\n';

        // Agrupa por categoria
        const grouped = {};
        items.forEach(item => {
            const cat = item.category || 'geral';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(item);
        });

        for (const [category, catItems] of Object.entries(grouped)) {
            const categoryEmoji = {
                'pessoal': '👤',
                'casa': '🏠',
                'trabalho': '💼',
                'geral': '📁'
            }[category] || '📁';

            msg += `${categoryEmoji} *${category.charAt(0).toUpperCase() + category.slice(1)}*\n`;
            catItems.forEach(item => {
                msg += `   📝 *${item.key}*: ${item.value}\n`;
            });
            msg += '\n';
        }

        msg += `_Total: ${items.length} informações_`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });

    } else if (intent.tipo === 'delete_info') {
        const deleted = knowledgeService.deleteInfo(intent.key);

        if (deleted) {
            await ctx.reply(`🗑️ Informação "${intent.key}" deletada da memória.`);
        } else {
            await ctx.reply(`⚠️ Não encontrei "${intent.key}" na memória.`);
        }

        // ============================================
        // CHAT / FALLBACK
        // ============================================
    } else {
        await ctx.reply(intent.message || 'Olá! Posso ajudar com Agenda, Tarefas, Trello e Memória. Digite /ajuda para exemplos.', { parse_mode: 'Markdown' });
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
