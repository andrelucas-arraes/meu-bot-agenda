require('dotenv').config();
const { generateAuthUrl, getTokenFromCode } = require('./src/services/google');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function main() {
    try {
        console.log('--- Configuração de Autenticação Google ---');
        console.log('1. Certifique-se de ter preenchido o arquivo .env com CLIENT_ID e CLIENT_SECRET');
        console.log('2. Certifique-se de ter adicionado o REDIRECT_URI no console do Google Cloud (ex: http://localhost:3000/oauth2callback)');

        const url = await generateAuthUrl();

        console.log('\nACESSE ESTA URL NO SEU NAVEGADOR:');
        console.log('================================================================');
        console.log(url);
        console.log('================================================================');
        console.log('\nApós autorizar, você será redirecionado para uma página (pode dar erro de conexão, não tem problema).');
        console.log('Copie o código que aparece na URL (parâmetro "code=").');

        rl.question('\nCole o código aqui: ', async (code) => {
            // Decode URL component just in case users paste full URL or encoded chars
            const cleanCode = code.trim();
            try {
                await getTokenFromCode(cleanCode);
                console.log('\n✅ Autenticação realizada com sucesso! O arquivo tokens.json foi criado.');
                console.log('Agora você pode rodar o bot normalmente.');
            } catch (e) {
                console.error('\n❌ Erro ao obter token:', e.message);
            }
            rl.close();
        });

    } catch (error) {
        console.error('Erro na configuração:', error.message);
        rl.close();
    }
}

main();
