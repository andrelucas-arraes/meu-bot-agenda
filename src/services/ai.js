const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { DateTime } = require('luxon');
const { log } = require('../utils/logger');
const { validateAIResponse, validateAIResponseArray, sanitizeAIResponse } = require('../utils/validation');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const PROMPT_PATH = path.join(__dirname, '../prompts/classifier.txt');

// --- Simple In-Memory Session Storage (with Persistence) ---
let userSessions = {};

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');
const HISTORY_FILE = path.join(DATA_DIR, 'chat_history.json');

// Load history from disk on startup
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(HISTORY_FILE)) {
        userSessions = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        log.ai('Memória carregada', { sessions: Object.keys(userSessions).length });
    }
} catch (e) {
    log.error('Erro ao carregar memória do chat', { error: e.message });
}

function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(userSessions, null, 2));
    } catch (e) {
        log.error('Erro ao salvar memória', { error: e.message });
    }
}

const MAX_HISTORY_LENGTH = 10;

function getSystemPrompt(userContext = '') {
    let promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf-8');
    const now = DateTime.now().setZone('America/Sao_Paulo');
    const tomorrow = now.plus({ days: 1 });

    // Calcula próxima segunda, terça, etc.
    const getNextWeekday = (weekday) => {
        let target = now;
        while (target.weekday !== weekday) {
            target = target.plus({ days: 1 });
        }
        return target.toFormat('yyyy-MM-dd');
    };

    return promptTemplate
        .replace(/{{USER_CONTEXT}}/g, userContext)
        .replace(/{{CURRENT_DATE}}/g, now.toFormat('yyyy-MM-dd'))
        .replace(/{{CURRENT_WEEKDAY}}/g, now.setLocale('pt-BR').toFormat('cccc'))
        .replace(/{{CURRENT_TIME}}/g, now.toFormat('HH:mm'))
        .replace(/{{CURRENT_YEAR}}/g, now.year.toString())
        .replace(/{{TOMORROW}}/g, tomorrow.toFormat('yyyy-MM-dd'))
        .replace(/{{NEXT_MONDAY}}/g, getNextWeekday(1))
        .replace(/{{NEXT_TUESDAY}}/g, getNextWeekday(2))
        .replace(/{{NEXT_WEDNESDAY}}/g, getNextWeekday(3))
        .replace(/{{NEXT_THURSDAY}}/g, getNextWeekday(4))
        .replace(/{{NEXT_FRIDAY}}/g, getNextWeekday(5))
        .replace(/{{NEXT_SATURDAY}}/g, getNextWeekday(6))
        .replace(/{{NEXT_SUNDAY}}/g, getNextWeekday(7));
}

async function interpretMessage(text, userId, userContext = '') {
    const startTime = Date.now();

    try {
        const promptSystem = getSystemPrompt(userContext);

        // Initialize history if new user
        if (!userSessions[userId]) {
            userSessions[userId] = [];
            log.ai('Nova sessão criada', { userId });
        }

        const history = [
            {
                role: "user",
                parts: [{ text: promptSystem }],
            },
            {
                role: "model",
                parts: [{ text: "Entendido. Atuarei como seu assistente inteligente e responderei apenas com JSON válido." }],
            }
        ];

        // Append recent user history
        history.push(...userSessions[userId]);

        const generationConfig = {
            temperature: 0.2,
            responseMimeType: "application/json",
        };

        const chat = model.startChat({
            generationConfig,
            history: history,
        });

        const result = await chat.sendMessage(text);
        const responseText = result.response.text();
        const elapsedMs = Date.now() - startTime;

        log.ai('Resposta recebida', {
            userId,
            inputLength: text.length,
            responseLength: responseText.length,
            elapsedMs
        });

        // Update User History
        userSessions[userId].push(
            { role: "user", parts: [{ text: text }] },
            { role: "model", parts: [{ text: responseText }] }
        );

        saveHistory();

        // Prune history
        if (userSessions[userId].length > MAX_HISTORY_LENGTH * 2) {
            userSessions[userId] = userSessions[userId].slice(-(MAX_HISTORY_LENGTH * 2));
        }

        // Parse JSON
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        let parsed;

        try {
            parsed = JSON.parse(cleanJson);
        } catch (parseError) {
            log.error('JSON inválido da IA', {
                error: parseError.message,
                response: cleanJson.substring(0, 200)
            });
            return {
                tipo: 'chat',
                message: '❌ Desculpe, tive dificuldade em entender. Pode reformular?'
            };
        }

        // Validate response
        const isArray = Array.isArray(parsed);
        const validation = isArray
            ? validateAIResponseArray(parsed)
            : validateAIResponse(sanitizeAIResponse(parsed));

        if (!validation.valid) {
            log.warn('Validação falhou', {
                errors: validation.errors,
                tipo: isArray ? 'array' : parsed.tipo
            });

            // Tenta usar os dados mesmo assim (graceful degradation)
            if (validation.data) {
                return isArray
                    ? validation.data.map(sanitizeAIResponse)
                    : sanitizeAIResponse(validation.data);
            }

            return {
                tipo: 'chat',
                message: '❌ Não consegui processar sua solicitação. Tente novamente com mais detalhes.'
            };
        }

        // Return validated and sanitized data
        return isArray
            ? validation.data.map(sanitizeAIResponse)
            : sanitizeAIResponse(validation.data);

    } catch (error) {
        log.apiError('AI', error, { userId, text: text.substring(0, 100) });

        // Mensagens de erro mais específicas
        if (error.message?.includes('quota')) {
            return {
                tipo: 'chat',
                message: '⚠️ Limite de uso atingido. Tente novamente em alguns minutos.'
            };
        }

        if (error.message?.includes('API key')) {
            return {
                tipo: 'chat',
                message: '🔑 Problema de configuração. Contate o administrador.'
            };
        }

        return {
            tipo: 'chat',
            message: '❌ Desculpe, tive um problema técnico. Tente novamente?'
        };
    }
}

module.exports = { interpretMessage };
