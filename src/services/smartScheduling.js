/**
 * Smart Scheduling Service
 * Verificação de conflitos e agendamento inteligente
 */

const { DateTime } = require('luxon');
const googleService = require('./google');
const { log } = require('../utils/logger');
const config = require('../config');

/**
 * Verifica se há conflitos com um novo evento
 * @param {Object} eventData - Dados do evento a ser criado
 * @returns {Object} - { hasConflict, conflicts, suggestions }
 */
async function checkConflicts(eventData) {
    try {
        // Se não tem horário específico (dia inteiro), não verifica conflitos
        if (!eventData.start || !eventData.start.includes('T')) {
            return { hasConflict: false, conflicts: [], suggestions: [] };
        }

        const startTime = DateTime.fromISO(eventData.start, { zone: config.timezone });
        const endTime = eventData.end
            ? DateTime.fromISO(eventData.end, { zone: config.timezone })
            : startTime.plus({ hours: 1 });

        // Busca eventos do dia
        const dayStart = startTime.startOf('day').toISO();
        const dayEnd = startTime.endOf('day').toISO();
        const events = await googleService.listEvents(dayStart, dayEnd);

        const conflicts = [];

        for (const event of events) {
            if (!event.start.dateTime) continue; // Ignora eventos de dia inteiro

            const eventStart = DateTime.fromISO(event.start.dateTime);
            const eventEnd = DateTime.fromISO(event.end.dateTime);

            // Verifica sobreposição
            if (startTime < eventEnd && endTime > eventStart) {
                conflicts.push({
                    id: event.id,
                    summary: event.summary,
                    start: eventStart.toFormat('HH:mm'),
                    end: eventEnd.toFormat('HH:mm'),
                    htmlLink: event.htmlLink
                });
            }
        }

        if (conflicts.length === 0) {
            return { hasConflict: false, conflicts: [], suggestions: [] };
        }

        // Gera sugestões de horários alternativos
        const suggestions = generateAlternativeTimes(startTime, endTime, events);

        log.info('Conflito detectado', {
            newEvent: eventData.summary,
            conflicts: conflicts.map(c => c.summary)
        });

        return {
            hasConflict: true,
            conflicts,
            suggestions
        };

    } catch (error) {
        log.error('Erro ao verificar conflitos', { error: error.message });
        return { hasConflict: false, conflicts: [], suggestions: [] };
    }
}

/**
 * Gera sugestões de horários alternativos
 */
function generateAlternativeTimes(originalStart, originalEnd, existingEvents) {
    const duration = originalEnd.diff(originalStart, 'minutes').minutes;
    const suggestions = [];

    // Tenta horários próximos (30 min antes, 30 min depois, 1h depois)
    const offsets = [-30, 30, 60, 90, 120];

    for (const offset of offsets) {
        const newStart = originalStart.plus({ minutes: offset });
        const newEnd = newStart.plus({ minutes: duration });

        // Verifica se o novo horário não conflita
        let hasConflict = false;
        for (const event of existingEvents) {
            if (!event.start.dateTime) continue;

            const eventStart = DateTime.fromISO(event.start.dateTime);
            const eventEnd = DateTime.fromISO(event.end.dateTime);

            if (newStart < eventEnd && newEnd > eventStart) {
                hasConflict = true;
                break;
            }
        }

        const now = DateTime.now().setZone(config.timezone);
        if (!hasConflict && newStart > now) {
            suggestions.push({
                start: newStart.toFormat('HH:mm'),
                end: newEnd.toFormat('HH:mm'),
                startISO: newStart.toISO(),
                endISO: newEnd.toISO(),
                label: offset < 0
                    ? `${Math.abs(offset)} min antes`
                    : offset === 0
                        ? 'Horário sugerido'
                        : `${offset} min depois`
            });
        }

        if (suggestions.length >= 3) break;
    }

    return suggestions;
}

/**
 * Detecta prioridade/urgência de uma mensagem
 * @param {string} text - Texto da mensagem
 * @returns {Object} - { priority, emoji, label }
 */
function detectPriority(text) {
    const lowText = text.toLowerCase();

    // Padrões de alta prioridade
    const highPatterns = [
        /urgent[e]?/i,
        /urge?nt?e?/i,
        /imediato/i,
        /agora/i,
        /o? ?mais r[aá]pido/i,
        /prior(idade|it[aá]rio)/i,
        /importante/i,
        /cri?tico/i,
        /deadline/i,
        /prazo\s*(final|máximo)/i,
        /não pode atrasar/i,
        /preciso\s+(muito|urgente)/i,
        /asap/i
    ];

    // Padrões de média prioridade
    const mediumPatterns = [
        /essa semana/i,
        /até (amanhã|segunda|terça|quarta|quinta|sexta)/i,
        /não esquece?r/i,
        /lembr(ar|ete)/i,
        /pendente/i
    ];

    for (const pattern of highPatterns) {
        if (pattern.test(lowText)) {
            return { priority: 'high', emoji: '🔴', label: 'Urgente' };
        }
    }

    for (const pattern of mediumPatterns) {
        if (pattern.test(lowText)) {
            return { priority: 'medium', emoji: '🟡', label: 'Média' };
        }
    }

    return { priority: 'normal', emoji: '🟢', label: 'Normal' };
}

/**
 * Formata mensagem de conflito para o usuário
 */
function formatConflictMessage(eventData, conflictResult) {
    let msg = `⚠️ *Conflito Detectado!*\n\n`;
    msg += `Você quer agendar: *${eventData.summary}*\n\n`;
    msg += `Mas você já tem:\n`;

    for (const conflict of conflictResult.conflicts) {
        msg += `📅 *${conflict.summary}* (${conflict.start} - ${conflict.end})\n`;
    }

    if (conflictResult.suggestions.length > 0) {
        msg += `\n💡 *Sugestões de horários:*\n`;
        for (let i = 0; i < conflictResult.suggestions.length; i++) {
            const sug = conflictResult.suggestions[i];
            msg += `${i + 1}. ${sug.start} - ${sug.end} (${sug.label})\n`;
        }
    }

    msg += `\n_Quer forçar o agendamento ou escolher outro horário?_`;

    return msg;
}

/**
 * Verifica condições contextuais para agendamento
 * @param {Object} eventData - Dados do evento
 * @returns {Object} - { isValid, warnings }
 */
function validateSchedulingContext(eventData) {
    const warnings = [];

    if (!eventData.start) {
        return { isValid: false, warnings: ['Horário não especificado'] };
    }

    const startTime = DateTime.fromISO(eventData.start, { zone: config.timezone });

    // IMPORTANTE: Valida se a data é válida (ex: 31/02 é inválido!)
    if (!startTime.isValid) {
        return {
            isValid: false,
            warnings: [`Data inválida: ${startTime.invalidReason || 'verifique dia/mês/ano'}`]
        };
    }

    const now = DateTime.now().setZone(config.timezone);

    // Verifica se é no passado
    if (startTime < now && eventData.start.includes('T')) {
        return { isValid: false, warnings: ['Não é possível agendar no passado'] };
    }

    // Avisos (não bloqueiam, apenas informam)
    const hour = startTime.hour;

    // Muito cedo (antes das 6h)
    if (hour < 6) {
        warnings.push('⏰ Evento marcado para madrugada');
    }

    // Muito tarde (depois das 22h)
    if (hour >= 22) {
        warnings.push('🌙 Evento marcado para tarde da noite');
    }

    // Fim de semana
    if (startTime.weekday >= 6) {
        warnings.push('📅 Evento no fim de semana');
    }

    // Evento longo (mais de 3 horas)
    if (eventData.end) {
        const endTime = DateTime.fromISO(eventData.end, { zone: 'America/Sao_Paulo' });

        // Também valida data de fim
        if (!endTime.isValid) {
            warnings.push('⚠️ Data de término inválida, usando 1h de duração');
        } else {
            const duration = endTime.diff(startTime, 'hours').hours;
            if (duration > 3) {
                warnings.push(`⏱️ Evento longo (${Math.round(duration)} horas)`);
            }
        }
    }

    return { isValid: true, warnings };
}

module.exports = {
    checkConflicts,
    detectPriority,
    formatConflictMessage,
    validateSchedulingContext,
    generateAlternativeTimes
};
