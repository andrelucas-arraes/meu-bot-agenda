# 🤖 Bot de Agendamento Telegram (Google Calendar & Tasks)

Um bot assistente pessoal que interpreta linguagem natural usando IA (Google Gemini 2.5 Flash) para criar eventos no Google Calendar e tarefas no Google Tasks automaticamente.

## 🚀 Funcionalidades

- **Inteligência Natural**: "Reunião amanhã às 14h com João" -> Cria evento.
- **Diferenciação Automática**: Entende a diferença entre compromisso (com hora marcada) e tarefa (pendência).
- **Google Calendar**: Cria eventos com título, descrição, local e link do Meet (se for online).
- **Google Tasks**: Cria tarefas com título, nota e data de vencimento.
- **Feedback Imediato**: Confirmação visual no chat.

## 🛠️ Pré-requisitos

- Node.js instalado.
- Conta no Telegram (para criar o bot).
- Conta na OpenAI (API Key).
- Conta no Google Cloud (para API do Calendar e Tasks).

## 📦 Instalação

1. Clone o repositório e entre na pasta:
   ```bash
   cd telegram-assistant-bot
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure o ambiente:
   - Renomeie `.env.example` para `.env`
   - Preencha as chaves (ver abaixo como obter).

## 🔑 Configuração das Chaves

### 1. Telegram Bot
1. Fale com o **@BotFather** no Telegram.
2. Crie um novo bot com `/newbot`.
3. Copie o TOKEN e cole no `.env` em `TELEGRAM_BOT_TOKEN`.
4. (Opcional) Obtenha seu ID de usuário (use o bot **@userinfobot**) e coloque em `ALLOWED_CHAT_IDS` no `.env`.

### 2. Google Gemini (IA)
1. Acesse [aistudio.google.com](https://aistudio.google.com/).
2. Crie uma API Key.
3. Cole no `.env` em `GEMINI_API_KEY`.

### 3. Google Cloud (A parte chata, mas necessária)
1. Acesse [console.cloud.google.com](https://console.cloud.google.com/).
2. Crie um novo projeto.
3. No menu "APIs e Serviços" -> "Biblioteca", ative:
   - **Google Calendar API**
   - **Google Tasks API**
4. Vá em "Tela de permissão OAuth":
   - Tipo: **Externo**.
   - Adicione seu email em "Usuários de teste".
5. Vá em "Credenciais" -> "Criar Credenciais" -> **ID do cliente OAuth**:
   - Tipo de aplicativo: **App da Web**.
   - URIs de redirecionamento autorizados: Adicione `http://localhost:3000/oauth2callback`.
6. Copie o **Client ID** e **Client Secret** para o seu `.env`.

## 🔐 Autenticação Google

Antes de rodar o bot, você precisa autorizar o acesso à sua conta. Rode o script:

```bash
node setup-auth.js
```

1. Ele vai gerar um link. Abra no navegador.
2. Faça login e autorize (se aparecer "App não verificado", clique em Avançado -> Ir para... (seguro)).
3. Copie o código da URL final (ex: `code=4/0Ad...`) e cole no terminal.
4. Isso criará o arquivo `tokens.json`.

## ▶️ Como Rodar

Para desenvolvimento (local):
```bash
node src/index.js
```

Para produção (24h):
Recomendo usar o **PM2**:

```bash
npm install pm2 -g
pm2 start src/index.js --name "bot-agenda"
pm2 save
pm2 startup
```

## 🧠 Arquitetura

- **`src/index.js`**: Ponto de entrada, gerencia mensagens do Telegram.
- **`src/services/ai.js`**: Envia o texto para o GPT-4o com um System Prompt especializado (`src/prompts/classifier.txt`).
- **`src/services/google.js`**: Gerencia a autenticação e chamadas para as APIs do Google.
