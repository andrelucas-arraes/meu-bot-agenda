const cron = require('node-cron');
const { DateTime } = require('luxon');
const googleService = require('./google');
const trelloService = require('./trello');
const { log } = require('../utils/logger');
const { formatFriendlyDate, getEventStatusEmoji } = require('../utils/dateFormatter');
const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');

// Garante que o diretório existe
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        log.error('Não foi possível criar diretório data', { error: e.message });
    }
}

const CACHE_FILE = path.join(DATA_DIR, 'scheduler_cache.json');

// Cache em memória
let memoryCache = {
    events: [],
    tasks: [],
    trelloCards: [],
    lastUpdate: null
};

// Cache para evitar notificações duplicadas
const notifiedEvents = new Set();

// --- PERSISTÊNCIA (SALVAR/LER DISCO) ---

function saveCacheToDisk() {
    try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify(memoryCache, null, 2));
    } catch (e) {
        log.error('Erro ao salvar cache no disco', { error: e.message });
    }
}

function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE);
            memoryCache = JSON.parse(data);
            if (!memoryCache.trelloCards) memoryCache.trelloCards = [];

            log.scheduler('Cache carregado do disco', {
                events: memoryCache.events.length,
                tasks: memoryCache.tasks.length,
                cards: memoryCache.trelloCards.length
            });

            // Verifica se está muito velho (ex: mais de 2 horas)
            const lastUpdate = DateTime.fromISO(memoryCache.lastUpdate);
            const diff = DateTime.now().diff(lastUpdate, 'hours').hours;
            if (diff > 2) {
                log.scheduler('Cache antigo, forçando atualização');
                refreshDataCache();
            }
        }
    } catch (e) {
        log.error('Erro ao ler cache do disco', { error: e.message });
    }
}

// --- ATUALIZAÇÃO ---

async function refreshDataCache() {
    try {
        log.scheduler('Atualizando cache de dados');
        const now = DateTime.now().setZone('America/Sao_Paulo');

        // 1. Eventos (próximas 12h)
        const end = now.plus({ hours: 12 });
        const events = await googleService.listEvents(now.toISO(), end.toISO());

        // 2. Tarefas (de todas as listas)
        const taskGroups = await googleService.listTasksGrouped();
        const tasks = taskGroups.flatMap(group =>
            group.tasks.map(t => ({ ...t, listName: group.title }))
        );

        // 3. Trello
        const trelloCards = await trelloService.listAllCards();

        // 4. Salva
        memoryCache.events = events;
        memoryCache.tasks = tasks;
        memoryCache.trelloCards = trelloCards;
        memoryCache.lastUpdate = now.toISO();

        log.scheduler('Dados atualizados', {
            events: events.length,
            tasks: tasks.length,
            cards: trelloCards.length
        });

        saveCacheToDisk();

    } catch (error) {
        log.apiError('Scheduler', error);
    }
}

// Função para invalidar cache específico
async function invalidateCache(type = 'all') {
    log.scheduler('Invalidando cache', { type });

    const now = DateTime.now().setZone('America/Sao_Paulo');

    try {
        if (type === 'all' || type === 'events') {
            const end = now.plus({ hours: 12 });
            memoryCache.events = await googleService.listEvents(now.toISO(), end.toISO());
        }

        if (type === 'all' || type === 'tasks') {
            const taskGroups = await googleService.listTasksGrouped();
            memoryCache.tasks = taskGroups.flatMap(group =>
                group.tasks.map(t => ({ ...t, listName: group.title }))
            );
        }

        if (type === 'all' || type === 'trello') {
            memoryCache.trelloCards = await trelloService.listAllCards();
        }

        memoryCache.lastUpdate = now.toISO();
        saveCacheToDisk();

    } catch (error) {
        log.apiError('Scheduler', error, { operation: 'invalidateCache', type });
    }
}

function initScheduler(bot) {
    const chatIds = (process.env.ALLOWED_CHAT_IDS || '').split(',').map(id => id.trim()).filter(id => id);

    if (chatIds.length === 0) {
        log.warn('Scheduler: Nenhum ALLOWED_CHAT_IDS configurado');
        return;
    }

    log.scheduler('Iniciando scheduler persistente');

    // 1. Tenta carregar do disco primeiro
    loadCacheFromDisk();

    // 2. Se vazio ou sem tarefas, busca agora
    if (memoryCache.events.length === 0 && memoryCache.tasks.length === 0) {
        refreshDataCache();
    }

    // ============================================
    // CRON 1: ATUALIZADOR DE CACHE (A cada 1 HORA)
    // ============================================
    cron.schedule('0 * * * *', () => {
        refreshDataCache();
    });

    // ============================================
    // CRON 2: RESUMO DIÁRIO (08:00)
    // ============================================
    cron.schedule('0 8 * * *', async () => {
        await refreshDataCache();

        const now = DateTime.now().setZone('America/Sao_Paulo');
        const todayStr = now.toFormat('yyyy-MM-dd');

        // Filtra eventos de HOJE
        const todaysEvents = memoryCache.events.filter(e => {
            return (e.start.dateTime && e.start.dateTime.startsWith(todayStr)) ||
                (e.start.date && e.start.date === todayStr);
        });

        // Eventos não concluídos
        const pendingEvents = todaysEvents.filter(e => !e.summary.startsWith('✅'));

        // Tarefas com prazo hoje
        const tasksWithDeadlineToday = memoryCache.tasks.filter(t => {
            if (!t.due) return false;
            return t.due.startsWith(todayStr);
        });

        // Trello "A Fazer"
        const todoCards = memoryCache.trelloCards.filter(c =>
            c.listName && (
                c.listName.toLowerCase().includes('a fazer') ||
                c.listName.toLowerCase().includes('to do') ||
                c.listName.toLowerCase().includes('todo')
            )
        );

        let msg = `☀️ *Bom dia! Resumo de hoje (${now.toFormat('dd/MM')}):*\n\n`;

        // ESTATÍSTICAS RÁPIDAS
        msg += `📊 *Resumo:*\n`;
        msg += `   • ${pendingEvents.length} eventos pendentes\n`;
        msg += `   • ${memoryCache.tasks.length} tarefas pendentes\n`;
        msg += `   • ${todoCards.length} cards no Trello\n\n`;

        // ALERTAS DE PRAZO
        if (tasksWithDeadlineToday.length > 0) {
            msg += `⚠️ *VENCENDO HOJE:*\n`;
            tasksWithDeadlineToday.forEach(t => {
                msg += `   🔴 ${t.title}\n`;
            });
            msg += '\n';
        }

        if (todaysEvents.length === 0 && memoryCache.tasks.length === 0 && todoCards.length === 0) {
            msg += '🎉 Nada pendente. Você está livre!';
        } else {
            if (todaysEvents.length > 0) {
                msg += `📅 *Compromissos:*\n`;
                todaysEvents.forEach(e => {
                    const emoji = getEventStatusEmoji(e);
                    const time = formatFriendlyDate(e.start.dateTime || e.start.date, { relative: false });
                    msg += `   ${emoji} ${time} - ${e.summary}\n`;
                });
                msg += '\n';
            }

            if (memoryCache.tasks.length > 0) {
                msg += `📝 *Pendências (Google Tasks):*\n`;
                memoryCache.tasks.slice(0, 10).forEach(t => {
                    const prefix = t.listName ? `[${t.listName}] ` : '';
                    msg += `   ▫️ ${prefix}${t.title}\n`;
                });
                if (memoryCache.tasks.length > 10) msg += `   ...e mais ${memoryCache.tasks.length - 10} tarefas.\n`;
                msg += '\n';
            }

            if (todoCards.length > 0) {
                msg += `🗂️ *Trello (A Fazer):*\n`;
                todoCards.slice(0, 10).forEach(c => {
                    msg += `   🔹 [${c.name}](${c.shortUrl})\n`;
                });
                if (todoCards.length > 10) msg += `   ...e mais ${todoCards.length - 10} cards.\n`;
                msg += '\n';
            }
        }

        // Frase Motivacional Aleatória
        const phrases = [
            '"O sucesso é a soma de pequenos esforços repetidos dia após dia." 💪',
            '"Não pare até se orgulhar." 🚀',
            '"A disciplina é a mãe do êxito." 🎯',
            '"Foco na meta!" 🏹',
            '"Você é capaz de coisas incríveis." ✨',
            '"Vamos fazer acontecer!" 🔥',
            '"Um passo de cada vez." 👣',
            '"Acredite no seu potencial." 💡',
            '"Persistência é o caminho do êxito." 🛣️'
        ];
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
        msg += `\n_${randomPhrase}_`;

        chatIds.forEach(id => bot.telegram.sendMessage(id, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(e => { }));
    }, { timezone: "America/Sao_Paulo" });

    // ============================================
    // CRON 3: ALERTA DE SEGUNDA METADE (14:00)
    // ============================================
    cron.schedule('0 14 * * *', async () => {
        await refreshDataCache();

        const now = DateTime.now().setZone('America/Sao_Paulo');
        const tasks = memoryCache.tasks;

        // Eventos Restantes Hoje
        // Eventos Restantes Hoje
        const remainingEvents = memoryCache.events.filter(e => {
            if (e.start.date) {
                const eventDate = DateTime.fromISO(e.start.date).setZone('America/Sao_Paulo');
                return eventDate.hasSame(now, 'day');
            }
            if (e.start.dateTime) {
                return DateTime.fromISO(e.start.dateTime) > now;
            }
            return false;
        });

        // Trello "A Fazer"
        const todoCards = memoryCache.trelloCards.filter(c =>
            c.listName && (
                c.listName.toLowerCase().includes('a fazer') ||
                c.listName.toLowerCase().includes('to do') ||
                c.listName.toLowerCase().includes('todo')
            )
        );

        let msg = `🕑 *Check das 14h:*\n\n`;

        // 1. Agenda
        if (remainingEvents.length > 0) {
            msg += `📅 *Próximos Eventos:*\n`;
            remainingEvents.forEach(e => {
                const emoji = getEventStatusEmoji(e);
                const time = formatFriendlyDate(e.start.dateTime || e.start.date, { relative: false, showYear: false });
                msg += `   ${emoji} ${time} - ${e.summary}\n`;
            });
            msg += '\n';
        }

        // 2. Tarefas
        if (tasks.length > 0) {
            msg += `📝 *Pendências (${tasks.length}):*\n`;
            tasks.slice(0, 5).forEach(t => {
                const prefix = t.listName ? `[${t.listName}] ` : '';
                msg += `   ▫️ ${prefix}${t.title || t.name}\n`;
            });
            if (tasks.length > 5) msg += `   ...e mais ${tasks.length - 5}.\n`;
            msg += '\n';
        }

        // 3. Trello
        if (todoCards.length > 0) {
            msg += `🗂️ *Trello A Fazer (${todoCards.length}):*\n`;
            todoCards.slice(0, 5).forEach(c => {
                msg += `   🔹 [${c.name}](${c.shortUrl})\n`;
            });
            if (todoCards.length > 5) msg += `   ...e mais ${todoCards.length - 5}.\n`;
            msg += '\n';
        }

        if (remainingEvents.length === 0 && tasks.length === 0 && todoCards.length === 0) {
            msg += '✅ Tudo limpo por enquanto!\n\n';
        }

        // Frase Motivacional Aleatória
        const phrases = [
            '"O sucesso é a soma de pequenos esforços repetidos dia após dia." 💪',
            '"Não pare até se orgulhar." 🚀',
            '"A disciplina é a mãe do êxito." 🎯',
            '"Foco na meta!" 🏹',
            '"Você é capaz de coisas incríveis." ✨',
            '"Vamos fazer acontecer!" 🔥',
            '"Um passo de cada vez." 👣',
            '"Acredite no seu potencial." 💡',
            '"Persistência é o caminho do êxito." 🛣️'
        ];
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

        msg += `_${randomPhrase}_`;

        chatIds.forEach(id => bot.telegram.sendMessage(id, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }).catch(e => { }));
    }, { timezone: "America/Sao_Paulo" });

    // ============================================
    // CRON 4: MONITOR LOCAL (Minuto a Minuto)
    // ============================================
    cron.schedule('* * * * *', async () => {
        const now = DateTime.now().setZone('America/Sao_Paulo');

        for (const event of memoryCache.events) {
            if (!event.start.dateTime) continue;

            const startTime = DateTime.fromISO(event.start.dateTime).setZone('America/Sao_Paulo');
            const diffMinutes = startTime.diff(now, 'minutes').minutes;

            if (diffMinutes >= 14 && diffMinutes <= 15.5 && !notifiedEvents.has(event.id)) {
                const emoji = getEventStatusEmoji(event);
                const msg = `🔔 *Daqui a 15 min:*\n${emoji} ${event.summary}`;
                const kb = event.hangoutLink
                    ? { inline_keyboard: [[{ text: "📹 Entrar", url: event.hangoutLink }]] }
                    : undefined;

                chatIds.forEach(id => bot.telegram.sendMessage(id, msg, { parse_mode: 'Markdown', reply_markup: kb }).catch(e => { }));

                notifiedEvents.add(event.id);
                log.scheduler('Lembrete enviado', { eventId: event.id, summary: event.summary });
            }
        }
    }, { timezone: "America/Sao_Paulo" });
}

module.exports = {
    initScheduler,
    refreshEventsCache: refreshDataCache,
    invalidateCache
};
