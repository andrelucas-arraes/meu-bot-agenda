/**
 * Utilitários de Formatação para Trello
 * Garante que os cards sejam exibidos de forma limpa e sem quebrar o Markdown
 */

/**
 * Limpa o nome do card para evitar quebrar o Markdown do Telegram
 * @param {string} name 
 * @returns {string}
 */
function cleanTrelloName(name) {
    if (!name) return 'Sem título';
    // Remove caracteres que podem quebrar a formatação Markdown (brackets, parenteses, bold/italics markers)
    return name.replace(/[\[\]\(\)\*_`]/g, '').trim();
}

/**
 * Gera um snippet da descrição do card, limpando markdown e quebras de linha
 * Preserva informações úteis como pendências e observações
 * @param {string} desc 
 * @param {number} maxLength 
 * @returns {string}
 */
function cleanTrelloDesc(desc, maxLength = 120) {
    if (!desc) return '';

    // 1. Remove cabeçalhos markdown (### Seção) mas mantém o conteúdo
    let clean = desc
        .replace(/(?:^|\n)###\s*/gi, '');

    // 2. Remove rótulos de campos que são redundantes (nome do card já diz o cliente/tipo)
    //    Mas PRESERVA campos úteis como Pendência atual e Observações
    clean = clean
        .replace(/(?:^|\n)(?:Cliente|Tipo de caso|Prioridade|Status):[^\n]*/gi, '');

    // 3. Extrai a pendência atual se existir (é a info mais útil)
    const pendenciaMatch = desc.match(/(?:Pendência atual|Pendencia atual)\s*[:\-]\s*([^\n]+)/i);
    const observacoesMatch = desc.match(/(?:Observações|Observacoes)\s*[:\-]\s*([^\n]+)/i);

    // Se tem pendência, prioriza ela como snippet
    if (pendenciaMatch && pendenciaMatch[1].trim()) {
        let snippet = pendenciaMatch[1].trim();
        // Remove formatação markdown
        snippet = snippet.replace(/[*_`]/g, '').trim();
        if (snippet && snippet.toLowerCase() !== 'nenhuma' && snippet !== '-') {
            if (snippet.length > maxLength) {
                return snippet.substring(0, maxLength).trim() + '...';
            }
            return snippet;
        }
    }

    // Se tem observações, usa como fallback
    if (observacoesMatch && observacoesMatch[1].trim()) {
        let snippet = observacoesMatch[1].trim();
        snippet = snippet.replace(/[*_`]/g, '').trim();
        if (snippet && snippet !== '-') {
            if (snippet.length > maxLength) {
                return snippet.substring(0, maxLength).trim() + '...';
            }
            return snippet;
        }
    }

    // 4. Fallback: limpa a descrição toda
    // Remove caracters de formatação que podem quebrar se truncados ou causar conflitos
    clean = clean.replace(/[*_`]/g, '');

    // Transforma quebras de linha em espaços para manter tudo em uma linha
    clean = clean.replace(/\r?\n/g, ' ');

    // Colapsa espaços múltiplos e limpa as bordas
    clean = clean.replace(/\s+/g, ' ').trim();

    if (!clean) return '';

    // 5. Trunca com reticências se necessário
    if (clean.length > maxLength) {
        return clean.substring(0, maxLength).trim() + '...';
    }

    return clean;
}

/**
 * Formata um card para exibição em listas
 * @param {Object} card 
 * @param {Object} options 
 * @returns {string}
 */
function formatTrelloCardListItem(card, options = {}) {
    const {
        showDesc = true,
        descLength = 120,
        showEmoji = true,
        isClosed = false
    } = options;

    const emoji = isClosed || card.closed ? '📦 ' : (showEmoji ? '📌 ' : '');
    const name = cleanTrelloName(card.name);
    const url = card.shortUrl || card.url;

    let line = `   ${emoji}[${name}](${url})`;

    if (showDesc && card.desc) {
        const snippet = cleanTrelloDesc(card.desc, descLength);
        if (snippet) {
            line += ` - _${snippet}_`;
        }
    }

    return line;
}

/**
 * Divide uma mensagem longa em múltiplas mensagens respeitando o limite do Telegram (4096 chars)
 * Quebra sempre em linhas completas para não cortar cards no meio
 * @param {string} message - Mensagem completa
 * @param {number} maxLength - Limite de caracteres por mensagem (padrão 4000 para margem de segurança)
 * @returns {string[]} Array de mensagens
 */
function splitTelegramMessage(message, maxLength = 4000) {
    if (message.length <= maxLength) return [message];

    const lines = message.split('\n');
    const messages = [];
    let current = '';

    for (const line of lines) {
        // Se adicionar esta linha ultrapassa o limite, envia o acumulado e começa nova msg
        if (current.length + line.length + 1 > maxLength && current.length > 0) {
            messages.push(current.trimEnd());
            current = '';
        }
        current += line + '\n';
    }

    // Adiciona o restante
    if (current.trim()) {
        messages.push(current.trimEnd());
    }

    return messages;
}

module.exports = {
    cleanTrelloName,
    cleanTrelloDesc,
    formatTrelloCardListItem,
    splitTelegramMessage
};
