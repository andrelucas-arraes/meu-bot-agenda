# 🤖 Assis - Assistente Inteligente (Telegram Bot)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Telegram](https://img.shields.io/badge/Telegram-Bot-blue.svg?logo=telegram)](https://t.me/BotFather)
[![Gemini AI](https://img.shields.io/badge/AI-Gemini-orange.svg)](https://ai.google.dev/)

O **Assis** é um assistente pessoal inteligente integrado ao Telegram, projetado para centralizar sua produtividade. Ele combina o poder do **Google Gemini AI** com integrações robustas ao **Google Calendar** e **Trello**, permitindo que você gerencie sua vida diretamente do chat.

---

## ✨ Funcionalidades

- 🧠 **IA Cognitiva**: Conversas naturais com contexto, alimentadas pelo Google Gemini.
- 📅 **Google Calendar**: Agende, liste, edite e cancele eventos usando linguagem natural.

- 📋 **Trello**: Gerencie quadros, listas, crie cards e mova itens entre listas.
- ⏰ **Agendamento Inteligente**: O bot entende "amanhã às 14h", "próxima sexta", etc.
- 📚 **Memória de Longo Prazo**: Guarde informações importantes (senhas, códigos, notas) e recupere quando precisar.
- 🔒 **Segurança**: Acesso restrito apenas a usuários autorizados via ID do Telegram.

---

## 🚀 Guia de Configuração (Passo a Passo)

Siga estas etapas para configurar todas as credenciais necessárias.

### 1. Criar o Bot no Telegram
1. Abra o Telegram e procure por [@BotFather](https://t.me/BotFather).
2. Envie `/newbot`.
3. Escolha um nome e um username para o bot.
4. Copie o **HTTP API Token** gerado.

### 2. Obter Chave da IA (Google Gemini)
1. Acesse o [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Crie uma nova API Key.
3. Copie a chave gerada.

### 3. Configurar Google Cloud (Calendar)
1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Crie um novo projeto.
3. No menu "APIs e Serviços" > "Biblioteca", ative:
   - **Google Calendar API**

4. Vá em "Credenciais" > "Criar Credenciais" > **ID do cliente OAuth**.
5. Tipo de aplicativo: **Aplicação da Web**.
6. Em "URIs de redirecionamento autorizados", adicione:
   - `http://localhost:3000/oauth2callback`
7. Baixe o arquivo JSON ou copie o **ID do Cliente** e a **Chave Secreta**.

### 4. Configurar Trello (Opcional)
1. Acesse [Trello Power-Up Admin](https://trello.com/power-ups/admin).
2. Crie uma nova integração "Power-Up".
3. Copie a **API Key**.
4. Gere um **Token** manualmente clicando no link de geração de token.
5. Para pegar o ID do Quadro (Board ID), abra seu quadro no navegador e adicione `.json` ao final da URL. O ID estará no começo do arquivo.

---

## 🛠️ Instalação e Execução

### 1. Clonar e Instalar
```bash
git clone https://github.com/seu-usuario/telegram-assistant-bot.git
cd telegram-assistant-bot
npm install
```

### 2. Configurar Variáveis de Ambiente
Crie um arquivo `.env` na raiz do projeto e preencha:

```env
# Telegram
TELEGRAM_BOT_TOKEN=seu_token_aqui
ALLOWED_CHAT_IDS=seu_id_telegram,outro_id

# Google Gemini
GEMINI_API_KEY=sua_chave_gemini

# Google Cloud OAuth
GOOGLE_CLIENT_ID=seu_client_id
GOOGLE_CLIENT_SECRET=seu_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
GOOGLE_CALENDAR_ID=primary

# Trello (Opcional)
TRELLO_API_KEY=sua_trello_key
TRELLO_TOKEN=seu_trello_token
TRELLO_BOARD_ID=id_do_quadro
TRELLO_LIST_ID_INBOX=id_da_lista_entrada
```

> **Dica:** Para descobrir seu ID do Telegram, envie uma mensagem para [@userinfobot](https://t.me/userinfobot).

### 3. Autenticação Google
Execute o script de configuração inicial:
```bash
node setup-auth.js
```
1. Abra o link gerado no navegador.
2. Autorize o app com sua conta Google.
3. Copie o código `code=...` da URL de redirecionamento.
4. Cole no terminal.
5. Um arquivo `tokens.json` será criado automaticamente.

### 4. Iniciar o Bot
```bash
npm start
```

---

## 📖 Manual de Uso

Aqui estão alguns exemplos do que você pode dizer ao bot:

### 📅 Agenda (Google Calendar)
- **Agendar:** "Reunião com equipe amanhã às 14h"
- **Consultar:** "O que tenho hoje?", "Agenda da semana"
- **Editar:** "Muda a reunião das 14h para 15h"
- **Cancelar:** "Cancela o evento de amanhã"



### 🗂️ Trello
- **Criar Card:** "Criar card 'Corrigir bug do login' na lista Backlog"
- **Mover:** "Mover card 'Bug login' para Em Andamento"
- **Listar:** "Ver meu quadro"

### 🧠 Memória (Segundo Cérebro)
- **Guardar:** "Guarda aí: o código do alarme é 4590"
- **Recuperar:** "Qual o código do alarme?", "O que você sabe sobre mim?"

### ⚙️ Comandos do Sistema
- `/start` - Reinicia o bot e mostra o menu principal.
- `/ajuda` - Exibe o guia de comandos interativo.
- `/api` - Verifica o status de conexão com Google, Trello e IA.
- `/desfazer` - Desfaz a última ação realizada (ex: apagar evento criado por engano).

---

## ☁️ Deploy (Hospedagem)

Para rodar o bot na nuvem (ex: Railway, Heroku, Render), você precisa configurar as variáveis de ambiente no painel da plataforma.

**Importante sobre o Google Auth:**
Como não é possível abrir o navegador no servidor, você deve usar o conteúdo do `tokens.json` gerado localmente.
1. Crie uma variável de ambiente chamada `GOOGLE_TOKENS`.
2. Cole todo o conteúdo do arquivo `tokens.json` nela.
3. O bot irá ler essa variável se o arquivo não existir.

---
