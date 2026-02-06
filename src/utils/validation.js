/**
 * Validação de JSON da IA usando Zod
 * Garante que as respostas da IA têm formato correto
 */

const { z } = require('zod');
const { log } = require('./logger');

// Schema base para todas as respostas
const baseSchema = z.object({
    tipo: z.string()
}).passthrough();

// Schema para eventos do Calendar
const eventSchema = z.object({
    tipo: z.enum(['create_event', 'evento']),
    summary: z.string().min(1, 'Título do evento é obrigatório'),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    online: z.boolean().optional(),
    attendees: z.array(z.string().email()).optional(),
    recurrence: z.array(z.string()).optional(),
});

const listEventsSchema = z.object({
    tipo: z.literal('list_events'),
    period: z.enum(['day', 'week', 'month']).optional().default('day'),
});

const updateEventSchema = z.object({
    tipo: z.literal('update_event'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    target_date: z.string().optional(),
    summary: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
});

const deleteEventSchema = z.object({
    tipo: z.enum(['delete_event', 'complete_event']),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    target_date: z.string().optional(),
});

// Schema para Tasks
const taskSchema = z.object({
    tipo: z.enum(['create_task', 'tarefa']),
    title: z.string().optional(),
    name: z.string().optional(),
    notes: z.string().optional(),
    due: z.string().optional(),
}).refine(data => data.title || data.name, {
    message: 'Título da tarefa é obrigatório (title ou name)'
});

const listTasksSchema = z.object({
    tipo: z.literal('list_tasks'),
});

const updateTaskSchema = z.object({
    tipo: z.literal('update_task'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    title: z.string().optional(),
    notes: z.string().optional(),
    due: z.string().optional(),
});

const completeDeleteTaskSchema = z.object({
    tipo: z.enum(['complete_task', 'delete_task']),
    query: z.string().min(1, 'Query de busca é obrigatória'),
});

// Schema para Trello
const trelloCreateSchema = z.object({
    tipo: z.enum(['trello_create', 'trello']),
    name: z.string().min(1, 'Nome do card é obrigatório'),
    desc: z.string().optional(),
    due: z.string().optional(),
    checklist: z.array(z.string()).optional(),
});

const trelloListSchema = z.object({
    tipo: z.literal('trello_list'),
});

const trelloUpdateSchema = z.object({
    tipo: z.literal('trello_update'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    name: z.string().optional(),
    desc: z.string().optional(),
    due: z.string().optional(),
});

const trelloMoveSchema = z.object({
    tipo: z.literal('trello_move'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    list: z.string().min(1, 'Nome da lista destino é obrigatório'),
});

const trelloArchiveSchema = z.object({
    tipo: z.literal('trello_archive'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
});

const trelloAddCommentSchema = z.object({
    tipo: z.literal('trello_add_comment'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    comment: z.string().min(1, 'Comentário é obrigatório'),
});

const trelloAddLabelSchema = z.object({
    tipo: z.literal('trello_add_label'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    label: z.string().min(1, 'Nome da etiqueta é obrigatório'),
});

const trelloAddMemberSchema = z.object({
    tipo: z.literal('trello_add_member'),
    query: z.string().min(1, 'Query de busca é obrigatória'),
    member: z.string().min(1, 'Nome do membro é obrigatório'),
});

// Schema para chat
const chatSchema = z.object({
    tipo: z.enum(['chat', 'neutro']),
    message: z.string(),
});

// Mapeamento de tipo para schema
const schemaMap = {
    'create_event': eventSchema,
    'evento': eventSchema,
    'list_events': listEventsSchema,
    'update_event': updateEventSchema,
    'delete_event': deleteEventSchema,
    'complete_event': deleteEventSchema,
    'create_task': taskSchema,
    'tarefa': taskSchema,
    'list_tasks': listTasksSchema,
    'update_task': updateTaskSchema,
    'complete_task': completeDeleteTaskSchema,
    'delete_task': completeDeleteTaskSchema,
    'trello_create': trelloCreateSchema,
    'trello': trelloCreateSchema,
    'trello_list': trelloListSchema,
    'trello_update': trelloUpdateSchema,
    'trello_move': trelloMoveSchema,
    'trello_archive': trelloArchiveSchema,
    'trello_add_comment': trelloAddCommentSchema,
    'trello_add_label': trelloAddLabelSchema,
    'trello_add_member': trelloAddMemberSchema,
    'chat': chatSchema,
    'neutro': chatSchema,
};

/**
 * Valida uma resposta da IA
 * @param {Object} response - Resposta JSON da IA
 * @returns {{ valid: boolean, data?: Object, errors?: string[] }}
 */
function validateAIResponse(response) {
    try {
        // Valida estrutura básica
        const baseResult = baseSchema.safeParse(response);
        if (!baseResult.success) {
            return {
                valid: false,
                errors: ['Resposta não é um objeto JSON válido']
            };
        }

        const tipo = response.tipo;
        const schema = schemaMap[tipo];

        // Se não temos schema para este tipo, aceitar como está (passthrough)
        if (!schema) {
            log.warn('Schema não encontrado para tipo', { tipo });
            return { valid: true, data: response };
        }

        // Valida com o schema específico
        const result = schema.safeParse(response);

        if (!result.success) {
            const errors = result.error.errors.map(e =>
                `${e.path.join('.')}: ${e.message}`
            );

            log.warn('Validação falhou', { tipo, errors });

            return {
                valid: false,
                errors,
                data: response // Retorna dados originais para fallback
            };
        }

        return { valid: true, data: result.data };

    } catch (error) {
        log.error('Erro na validação', { error: error.message });
        return {
            valid: false,
            errors: [error.message]
        };
    }
}

/**
 * Valida um array de respostas (múltiplas ações)
 * @param {Array} responses - Array de respostas
 * @returns {{ valid: boolean, data?: Array, errors?: string[] }}
 */
function validateAIResponseArray(responses) {
    if (!Array.isArray(responses)) {
        return validateAIResponse(responses);
    }

    const results = [];
    const allErrors = [];

    for (const [index, response] of responses.entries()) {
        const validation = validateAIResponse(response);
        if (!validation.valid) {
            allErrors.push(`[${index}] ${validation.errors.join(', ')}`);
        }
        results.push(validation.data || response);
    }

    if (allErrors.length > 0) {
        return {
            valid: false,
            errors: allErrors,
            data: results
        };
    }

    return { valid: true, data: results };
}

/**
 * Corrige problemas comuns na resposta da IA
 * @param {Object} response - Resposta da IA
 * @returns {Object} - Resposta corrigida
 */
function sanitizeAIResponse(response) {
    const sanitized = { ...response };

    // Normaliza tipo
    if (sanitized.tipo) {
        sanitized.tipo = sanitized.tipo.toLowerCase().trim();
    }

    // Garante que title/name existam para tarefas
    if (sanitized.tipo === 'create_task' || sanitized.tipo === 'tarefa') {
        sanitized.title = sanitized.title || sanitized.name;
    }

    // Garante que summary existe para eventos
    if (sanitized.tipo === 'create_event' || sanitized.tipo === 'evento') {
        sanitized.summary = sanitized.summary || 'Evento sem título';
    }

    return sanitized;
}

module.exports = {
    validateAIResponse,
    validateAIResponseArray,
    sanitizeAIResponse,
    // Export schemas for testing
    schemas: schemaMap
};
