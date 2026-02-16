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
 * @param {string} desc 
 * @param {number} maxLength 
 * @returns {string}
 */
function cleanTrelloDesc(desc, maxLength = 50) {
    if (!desc) return '';

    // 1. Remove cabeçalhos markdown (ex: ### Observações) e rótulos comuns
    let clean = desc
        .replace(/(?:^|\n)###\s*[^\n]*/gi, '')
        .replace(/(?:^|\n)(?:Cliente|Tipo de caso|Pendência atual|Prioridade|Status):[^\n]*/gi, '');

    // 2. Remove caracters de formatação que podem quebrar se truncados ou causar conflitos
    clean = clean.replace(/[*_`]/g, '');

    // 3. Transforma quebras de linha em espaços para manter tudo em uma linha
    clean = clean.replace(/\r?\n/g, ' ');

    // 4. Colapsa espaços múltiplos e limpa as bordas
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
        descLength = 50,
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

module.exports = {
    cleanTrelloName,
    cleanTrelloDesc,
    formatTrelloCardListItem
};
