require('dotenv').config();
const { Telegraf } = require('telegraf');
const { interpretMessage } = require('./services/ai');
const { createEvent, createTask } = require('./services/google');
const { DateTime } = require('luxon');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Middleware para segurança (permitir apenas usuários autorizados)
bot.use(async (ctx, next) => {
    const allowedIds = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(id => id.trim());
    const userId = String(ctx.from.id);

    if (allowedIds.length > 0 && !allowedIds.includes(userId) && allowedIds[0] !== '') {
        return ctx.reply(`🚫 Acesso negado. Seu ID é: ${userId}`);
    }
    return next();
});

bot.start((ctx) => ctx.reply('👋 Olá! Sou seu assistente pessoal. Me diga o que agendar ou lembrar.'));

// Comando /hoje
bot.command('hoje', async (ctx) => {
    const start = DateTime.now().setZone('America/Sao_Paulo').startOf('day');
    const end = start.endOf('day');

    await listAndReplyEvents(ctx, start, end, 'Hoje');
});

// Comando /amanha
bot.command('amanha', async (ctx) => {
    const start = DateTime.now().setZone('America/Sao_Paulo').plus({ days: 1 }).startOf('day');
    const end = start.endOf('day');

    await listAndReplyEvents(ctx, start, end, 'Amanhã');
});

// Comando /semana
bot.command('semana', async (ctx) => {
    const start = DateTime.now().setZone('America/Sao_Paulo').startOf('week');
    const end = start.endOf('week');

    await listAndReplyEvents(ctx, start, end, 'Esta Semana');
});

// Comando /mes
bot.command('mes', async (ctx) => {
    const start = DateTime.now().setZone('America/Sao_Paulo').startOf('month');
    const end = start.endOf('month');

    await listAndReplyEvents(ctx, start, end, 'Este Mês');
});

async function listAndReplyEvents(ctx, start, end, title, includeTasks = true) {
    const { listEvents, listTasks } = require('./services/google');
    await ctx.sendChatAction('typing');

    try {
        // Busca eventos e tarefas em paralelo
        // Tasks API filter uses RFC3339 format for dueMin/dueMax which is what toISO() provides
        const [events, tasks] = await Promise.all([
            listEvents(start.toISO(), end.toISO()),
            includeTasks ? listTasks(start.toISO(), end.toISO()) : Promise.resolve([])
        ]);

        const hasEvents = events && events.length > 0;
        const hasTasks = tasks && tasks.length > 0;

        if (!hasEvents && !hasTasks) {
            return ctx.reply(`📅 *${title}:* Nada encontrado (eventos ou tarefas)!`, { parse_mode: 'Markdown' });
        }

        let msg = `📅 *Agenda de ${title}:*\n\n`;

        // --- EVENTOS ---
        if (hasEvents) {
            msg += `🔵 *Compromissos:*\n`;

            // Agrupar eventos por dia
            const eventsByDay = {};
            events.forEach(ev => {
                const time = DateTime.fromISO(ev.start.dateTime || ev.start.date).setZone('America/Sao_Paulo');
                const dayKey = time.setLocale('pt-BR').toFormat('dd/MM (cccc)');
                if (!eventsByDay[dayKey]) eventsByDay[dayKey] = [];
                eventsByDay[dayKey].push(ev);
            });

            for (const [day, dayEvents] of Object.entries(eventsByDay)) {
                msg += `*${day}*\n`;
                dayEvents.forEach(ev => {
                    const time = DateTime.fromISO(ev.start.dateTime || ev.start.date).setZone('America/Sao_Paulo');
                    // Se for dia inteiro, data apenas, sem hora
                    const timeStr = ev.start.date ? 'Dia todo' : time.toFormat('HH:mm');
                    msg += `   ▪️ ${timeStr} - [${ev.summary}](${ev.htmlLink})\n`;
                });
                msg += '\n';
            }
        }

        // --- TAREFAS ---
        if (hasTasks) {
            msg += `🟡 *Tarefas (Vencimento):*\n`;
            tasks.forEach(task => {
                if (!task.due) {
                    msg += `   ▫️ (Sem data) ${task.title}\n`;
                } else {
                    const due = DateTime.fromISO(task.due).setZone('America/Sao_Paulo');
                    const dueStr = due.setLocale('pt-BR').toFormat('dd/MM (ccc)');
                    msg += `   ▫️ [${dueStr}] ${task.title}\n`;
                }
            });
            msg += '\n';
        }

        // Telegram tem limite de 4096 caracteres
        if (msg.length > 4000) {
            msg = msg.substring(0, 4000) + '... (muitos itens, veja no app do Google)';
        }

        // Desabilitar preview para não poluir
        ctx.reply(msg, { parse_mode: 'Markdown', disable_web_page_preview: true });

    } catch (e) {
        console.error(e);
        ctx.reply('❌ Erro ao buscar agenda/tarefas.');
    }
}

bot.on('text', async (ctx) => {
    const text = ctx.message.text;

    // UX: Mostrar que está escrevendo
    await ctx.sendChatAction('typing');

    try {
        // 1. Interpretar com IA
        const intent = await interpretMessage(text);
        console.log('Intenção identificada:', intent);

        if (intent.tipo === 'evento') {
            const event = await createEvent(intent);

            // Formata data para exibir
            const start = DateTime.fromISO(intent.start).setZone('America/Sao_Paulo');

            let msg = `✅ *Evento criado:*\n[${intent.summary}](${event.htmlLink})\n`;
            msg += `📅 ${start.toFormat('dd/MM')} às ${start.toFormat('HH:mm')}`;
            if (intent.location) msg += `\n📍 ${intent.location}`;
            if (intent.online) msg += `\n📹 Meet criado`;

            // Botão para abrir
            const kb = {
                inline_keyboard: [[{ text: "🔗 Abrir no Calendar", url: event.htmlLink }]]
            };

            await ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: kb });

        } else if (intent.tipo === 'tarefa') {
            const task = await createTask(intent);

            let msg = `✅ *Tarefa criada:*\n${intent.title}\n`;
            if (intent.due) {
                const due = DateTime.fromISO(intent.due);
                msg += `🗓 Prazo: ${due.toFormat('dd/MM')}`;
            }
            // Tasks usually don't have a direct public htmlLink easily accessible without ID hacks, 
            // but we can try to link to the tasks app generally or just keep it simple.
            await ctx.reply(msg, { parse_mode: 'Markdown' });

        } else if (intent.tipo === 'neutro') {
            await ctx.reply(intent.message || "Olá! Como posso ajudar?");

        } else {
            // Fallback ou erro
            await ctx.reply(`❓ Não entendi. Tente reformular.\nRaw: ${JSON.stringify(intent)}`);
        }

    } catch (error) {
        console.error('Erro geral:', error);
        let errorMsg = '❌ Ocorreu um erro ao processar sua solicitação.';
        if (error.message.includes('Token')) {
            errorMsg += '\n⚠️ Erro de autenticação do Google. Verifique os tokens.';
        }
        await ctx.reply(errorMsg);
    }
});

// Tratamento de erros globais (polling stop, etc)
bot.catch((err, ctx) => {
    console.log(`Ooops, encountered an error for ${ctx.updateType}`, err);
});

console.log('🤖 Bot iniciado...');
bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
