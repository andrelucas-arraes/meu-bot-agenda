/**
 * Knowledge Base Service (Segundo Cérebro)
 * Armazena e recupera informações que não são eventos nem tarefas
 * Implementa um RAG Lite para memória de longo prazo
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const Fuse = require('fuse.js');
const config = require('../config');

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../../data');
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');

// Estrutura da Knowledge Base
let knowledgeBase = {
    items: [],
    lastUpdated: null
};

// Garante que o diretório existe
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        log.error('Erro ao criar diretório data', { error: e.message });
    }
}

// --- PERSISTÊNCIA ---

function loadKnowledge() {
    try {
        if (fs.existsSync(KNOWLEDGE_FILE)) {
            const data = fs.readFileSync(KNOWLEDGE_FILE, 'utf-8');
            knowledgeBase = JSON.parse(data);
            log.info('Knowledge Base carregada', { items: knowledgeBase.items.length });
        }
    } catch (e) {
        log.error('Erro ao carregar Knowledge Base', { error: e.message });
    }
}

function saveKnowledge() {
    try {
        knowledgeBase.lastUpdated = new Date().toISOString();
        const data = JSON.stringify(knowledgeBase, null, 2);

        // Valida JSON antes de salvar (evita corrupção)
        try {
            JSON.parse(data);
        } catch (parseError) {
            log.error('CRÍTICO: JSON inválido, abortando save', { error: parseError.message });
            return;
        }

        // Faz backup do arquivo anterior se existir
        if (fs.existsSync(KNOWLEDGE_FILE)) {
            const backupFile = KNOWLEDGE_FILE.replace('.json', `.backup_${Date.now()}.json`);
            try {
                fs.copyFileSync(KNOWLEDGE_FILE, backupFile);

                // Mantém apenas os backups configurados
                const backupDir = path.dirname(KNOWLEDGE_FILE);
                const backups = fs.readdirSync(backupDir)
                    .filter(f => f.startsWith('knowledge.backup_') && f.endsWith('.json'))
                    .sort()
                    .reverse();

                // Remove backups antigos (mantém conforme config)
                backups.slice(config.knowledge.maxBackups).forEach(f => {
                    try {
                        fs.unlinkSync(path.join(backupDir, f));
                    } catch (e) {
                        // Ignora erro ao deletar backup antigo
                    }
                });
            } catch (backupError) {
                log.warn('Falha ao criar backup', { error: backupError.message });
                // Continua salvando mesmo sem backup
            }
        }

        // Salva o arquivo
        fs.writeFileSync(KNOWLEDGE_FILE, data);
    } catch (e) {
        log.error('CRÍTICO: Erro ao salvar Knowledge Base', { error: e.message });
    }
}

// Carrega na inicialização
loadKnowledge();

// --- OPERAÇÕES CRUD ---

/**
 * Armazena uma nova informação na base de conhecimento
 * @param {Object} info - { key, value, category, tags }
 * @returns {Object} - Informação armazenada
 */
function storeInfo(info) {
    const item = {
        id: Date.now().toString(36) + Math.random().toString(36).substr(2),
        key: info.key || extractKey(info.value),
        value: info.value,
        category: info.category || 'geral',
        tags: info.tags || extractTags(info.value),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    // Verifica se já existe uma informação similar (atualiza ao invés de duplicar)
    const existingIndex = findSimilarIndex(item.key);
    if (existingIndex !== -1) {
        knowledgeBase.items[existingIndex] = {
            ...knowledgeBase.items[existingIndex],
            value: item.value,
            tags: item.tags,
            updatedAt: new Date().toISOString()
        };
        saveKnowledge();
        log.info('Knowledge atualizada', { key: item.key });
        return knowledgeBase.items[existingIndex];
    }

    knowledgeBase.items.push(item);
    saveKnowledge();
    log.info('Knowledge armazenada', { key: item.key, category: item.category });
    return item;
}

/**
 * Busca informação na base de conhecimento
 * @param {string} query - Termo de busca
 * @returns {Object|null} - Informação encontrada ou null
 */
function queryInfo(query) {
    if (knowledgeBase.items.length === 0) {
        return null;
    }

    // Configuração do Fuse.js para busca fuzzy
    const fuse = new Fuse(knowledgeBase.items, {
        keys: [
            { name: 'key', weight: 0.4 },
            { name: 'value', weight: 0.3 },
            { name: 'tags', weight: 0.2 },
            { name: 'category', weight: 0.1 }
        ],
        threshold: config.knowledge.fuzzyThreshold,
        includeScore: true
    });

    const results = fuse.search(query);

    if (results.length === 0) {
        return null;
    }

    // Retorna o melhor resultado
    const best = results[0].item;
    log.info('Knowledge encontrada', { query, key: best.key, score: results[0].score });
    return best;
}

/**
 * Lista todas as informações (opcionalmente por categoria)
 * @param {string} category - Categoria para filtrar (opcional)
 * @returns {Array} - Lista de informações
 */
function listInfo(category = null) {
    if (category) {
        return knowledgeBase.items.filter(item =>
            item.category.toLowerCase() === category.toLowerCase()
        );
    }
    return knowledgeBase.items;
}

/**
 * Deleta uma informação pelo ID ou key
 * @param {string} identifier - ID ou key
 * @returns {boolean} - Sucesso
 */
function deleteInfo(identifier) {
    const initialLength = knowledgeBase.items.length;

    knowledgeBase.items = knowledgeBase.items.filter(item =>
        item.id !== identifier &&
        item.key.toLowerCase() !== identifier.toLowerCase()
    );

    if (knowledgeBase.items.length < initialLength) {
        saveKnowledge();
        log.info('Knowledge deletada', { identifier });
        return true;
    }
    return false;
}

/**
 * Atualiza o valor de uma informação existente pelo ID ou key
 * @param {string} identifier - ID ou key
 * @param {string} newValue - Novo valor
 * @returns {Object|null} - Item atualizado ou null se não encontrado
 */
function updateInfo(identifier, newValue) {
    const item = knowledgeBase.items.find(i =>
        i.id === identifier ||
        i.key.toLowerCase() === identifier.toLowerCase()
    );

    if (!item) {
        log.warn('Knowledge não encontrada para atualização', { identifier });
        return null;
    }

    item.value = newValue;
    item.tags = extractTags(newValue);
    item.updatedAt = new Date().toISOString();

    saveKnowledge();
    log.info('Knowledge atualizada', { id: item.id, key: item.key });
    return item;
}

// --- HELPERS ---

/**
 * Extrai uma chave semântica do valor
 */
function extractKey(value) {
    // Remove palavras comuns e mantém as chaves
    const stopWords = [
        'é', 'da', 'do', 'de', 'a', 'o', 'que', 'e', 'um', 'uma',
        'em', 'no', 'na', 'para', 'com', 'por', 'meu', 'minha',
        'seu', 'sua', 'guarda', 'anota', 'lembra', 'qual', 'como'
    ];
    const words = value.toLowerCase()
        .replace(/[^\w\sáàâãéèêíìîóòôõúùûç]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.includes(w));

    return words.slice(0, 5).join(' ');
}

/**
 * Extrai tags do valor
 */
function extractTags(value) {
    const tagPatterns = {
        'senha': /senha|password|código|code|pin/i,
        'contato': /telefone|email|whatsapp|celular|número/i,
        'endereço': /endereço|rua|av\.|avenida|bairro|cep/i,
        'documento': /cpf|rg|cnpj|documento/i,
        'conta': /conta|banco|agência|pix/i,
        'pessoal': /mãe|pai|família|amigo|parente/i,
        'trabalho': /trabalho|empresa|cliente|projeto/i,
        'receita': /receita|ingrediente|culinária|comida/i,
        'medicamento': /remédio|medicamento|médico|farmácia/i
    };

    const tags = [];
    for (const [tag, pattern] of Object.entries(tagPatterns)) {
        if (pattern.test(value)) {
            tags.push(tag);
        }
    }

    return tags.length > 0 ? tags : ['geral'];
}

/**
 * Encontra índice de item similar
 */
function findSimilarIndex(key) {
    const normalizedKey = key.toLowerCase().trim();

    return knowledgeBase.items.findIndex(item => {
        const itemKey = item.key.toLowerCase().trim();
        // Verifica se as chaves são muito similares
        return itemKey === normalizedKey ||
            itemKey.includes(normalizedKey) ||
            normalizedKey.includes(itemKey);
    });
}

/**
 * Busca contextual para uso pelo Gemini
 * Retorna informações relevantes para um contexto
 */
function getContextualInfo(context) {
    if (knowledgeBase.items.length === 0) {
        return [];
    }

    const fuse = new Fuse(knowledgeBase.items, {
        keys: ['key', 'value', 'tags'],
        threshold: 0.5
    });

    const results = fuse.search(context);
    return results.slice(0, 3).map(r => r.item);
}

/**
 * Formata informação para exibição
 */
function formatInfoForDisplay(item) {
    let msg = `📝 *${item.key}*\n`;
    msg += `   ${item.value}\n`;
    if (item.tags && item.tags.length > 0) {
        msg += `   🏷️ ${item.tags.join(', ')}\n`;
    }
    return msg;
}

module.exports = {
    storeInfo,
    queryInfo,
    listInfo,
    deleteInfo,
    updateInfo,
    getContextualInfo,
    formatInfoForDisplay,
    loadKnowledge,
    saveKnowledge
};
