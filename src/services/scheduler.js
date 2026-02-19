const cron = require('node-cron');
const { DateTime } = require('luxon');
const googleService = require('./google');
const trelloService = require('./trello');
const { log } = require('../utils/logger');
const { formatFriendlyDate, getEventStatusEmoji } = require('../utils/dateFormatter');
const { formatTrelloCardListItem } = require('../utils/trelloFormatter');
const fs = require('fs');
const path = require('path');
const config = require('../config');

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
    trelloCards: [],
    lastUpdate: null
};

const CACHE_TTL = config.cache.ttlMs;

/**
 * Verifica se uma lista é de cards concluídos
 * Função utilitária compartilhada para evitar duplicação
 */
function isCompletedList(listName) {
    if (!listName) return false;
    const name = listName.toLowerCase();
    return name.includes('concluido') ||
        name.includes('concluído') ||
        name.includes('feito') ||
        name.includes('done') ||
        name.includes('finalizado') ||
        name.includes('arquivado');
}

/**
 * Verifica se o cache está desatualizado
 */
function isCacheStale() {
    if (!memoryCache.lastUpdate) return true;
    const age = Date.now() - DateTime.fromISO(memoryCache.lastUpdate).toMillis();
    return age > CACHE_TTL;
}

/**
 * Retorna os dados do cache
 * Se o cache estiver stale (TTL expirado), atualiza antes de retornar
 */
async function getData() {
    if (isCacheStale()) {
        log.scheduler('Cache stale via getData, atualizando...');
        await refreshDataCache();
    }
    return memoryCache;
}

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

async function loadCacheFromDisk() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE);
            memoryCache = JSON.parse(data);
            if (!memoryCache.trelloCards) memoryCache.trelloCards = [];

            log.scheduler('Cache carregado do disco', {
                events: memoryCache.events.length,
                cards: memoryCache.trelloCards.length
            });

            // Verifica se está muito velho (ex: baseado no config)
            const lastUpdate = DateTime.fromISO(memoryCache.lastUpdate);
            const diff = DateTime.now().diff(lastUpdate, 'hours').hours;
            if (diff > config.cache.staleThresholdHours) {
                log.scheduler('Cache antigo, forçando atualização');
                await refreshDataCache();
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

        // 2. Trello
        const trelloCards = await trelloService.listAllCards();

        // 3. Salva
        memoryCache.events = events;
        memoryCache.trelloCards = trelloCards;
        memoryCache.lastUpdate = now.toISO();

        log.scheduler('Dados atualizados', {
            events: events.length,
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

        if (type === 'all' || type === 'trello') {
            memoryCache.trelloCards = await trelloService.listAllCards();
        }

        // Limpa o Set de notificações antigas (para não crescer infinitamente)
        // Mantém apenas os IDs do cache atual para evitar re-notificar se o cache for invalidado
        const currentEventIds = new Set(memoryCache.events.map(e => e.id));
        for (const id of notifiedEvents) {
            if (!currentEventIds.has(id)) {
                notifiedEvents.delete(id);
            }
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

    // 1. Tenta carregar do disco primeiro (async)
    (async () => {
        await loadCacheFromDisk();

        // 2. Se vazio, busca agora
        if (memoryCache.events.length === 0) {
            await refreshDataCache();
        }
    })().catch(e => log.error('Erro ao inicializar cache do scheduler', { error: e.message }));

    // ============================================
    // CRON 1: ATUALIZADOR DE CACHE (Duração baseada no config)
    // ============================================
    const refreshInterval = config.cache.refreshIntervalMs === 3600000 ? '0 * * * *' : '* * * * *';
    cron.schedule(refreshInterval, () => {
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

        // Tarefas pendentes (todos os cards exceto os em listas de conclusão)
        const todoCards = memoryCache.trelloCards.filter(c => !isCompletedList(c.listName));

        let msg = `☀️ *Bom dia! Resumo de hoje (${now.toFormat('dd/MM')}):*\n\n`;

        // ESTATÍSTICAS RÁPIDAS
        msg += `📊 *Resumo:*\n`;
        msg += `   • ${pendingEvents.length} eventos pendentes\n`;
        msg += `   • ${todoCards.length} cards no Trello\n\n`;

        if (todaysEvents.length === 0 && todoCards.length === 0) {
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

            if (todoCards.length > 0) {
                msg += `🗂️ *Trello (A Fazer):*\n`;
                todoCards.slice(0, 10).forEach(c => {
                    msg += formatTrelloCardListItem(c, { showDesc: false }) + '\n';
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

        // Trello Pendentes
        const todoCards = memoryCache.trelloCards.filter(c => !isCompletedList(c.listName));

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

        // 2. Trello
        if (todoCards.length > 0) {
            msg += `🗂️ *Trello A Fazer (${todoCards.length}):*\n`;
            todoCards.slice(0, 5).forEach(c => {
                msg += formatTrelloCardListItem(c, { showDesc: false }) + '\n';
            });
            if (todoCards.length > 5) msg += `   ...e mais ${todoCards.length - 5}.\n`;
            msg += '\n';
        }

        if (remainingEvents.length === 0 && todoCards.length === 0) {
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

            if (diffMinutes >= (config.scheduler.reminderMinutes - 1) && diffMinutes <= (config.scheduler.reminderMinutes + 0.5) && !notifiedEvents.has(event.id)) {
                const emoji = getEventStatusEmoji(event);
                const msg = `🔔 *Daqui a ${config.scheduler.reminderMinutes} min:*\n${emoji} ${event.summary}`;
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
    invalidateCache,
    getData
};
