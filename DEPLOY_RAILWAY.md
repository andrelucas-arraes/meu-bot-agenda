## 🚂 Deploy no Railway

1. **Crie um repositório no GitHub** e envie este código.
2. **Crie um projeto no Railway**.
3. **Variáveis de Ambiente**:
   No dashboard do Railway, adicione as mesmas variáveis do `.env`:
   - `TELEGRAM_BOT_TOKEN`: Seu token.
   - `GEMINI_API_KEY`: Sua chave da API do Google AI.
   - `GOOGLE_CLIENT_ID`: ID do cliente OAuth.
   - `GOOGLE_CLIENT_SECRET`: Segredo do cliente OAuth.
   - `GOOGLE_REDIRECT_URI`: A mesma URI usada (ex: http://localhost:3000/oauth2callback).
   - `GOOGLE_CALENDAR_ID`: `primary`.
   - `ALLOWED_CHAT_IDS`: Seu ID.

4. **Token de Acesso do Google (CRÍTICO)**:
   - Rode o bot localmente primeiro com `node setup-auth.js` e faça o login.
   - Isso vai gerar um arquivo `tokens.json`.
   - Abra esse arquivo, copie TODO o conteúdo (o JSON inteiro).
   - No Railway, crie uma variável chamada `GOOGLE_TOKENS` e cole esse JSON como valor.
   
   Isso permite que o bot funcione na nuvem sem precisar logar via navegador lá.

5. **Deploy**:
   O Railway detectará o `package.json` e iniciará automaticamente com `npm start`.
