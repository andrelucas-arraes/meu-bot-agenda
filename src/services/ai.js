const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { DateTime } = require('luxon');

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using the specific model requested: gemini-2.5-flash
// If it fails in 2026, user might need to adjust, but assuming it exists per context.
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const PROMPT_PATH = path.join(__dirname, '../prompts/classifier.txt');

async function interpretMessage(text) {
    try {
        let promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf-8');

        const now = DateTime.now().setZone('America/Sao_Paulo');

        // Replace placeholders
        const promptSystem = promptTemplate
            .replace('{{CURRENT_DATE}}', now.toFormat('yyyy-MM-dd'))
            .replace('{{CURRENT_WEEKDAY}}', now.setLocale('pt-BR').toFormat('cccc'))
            .replace('{{CURRENT_YEAR}}', now.year.toString());

        // Construct the prompt for Gemini
        // Gemini supports system instructions in newer models, or we can prepend it.
        // For best compatibility/simplicity, we'll send it as part of the chat.

        // Configura geração para JSON
        const generationConfig = {
            temperature: 0,
            responseMimeType: "application/json",
        };

        const chat = model.startChat({
            generationConfig,
            history: [
                {
                    role: "user",
                    parts: [{ text: promptSystem }],
                },
                {
                    role: "model",
                    parts: [{ text: "Entendido. Enviarei apenas o JSON correpondente às suas mensagens." }],
                }
            ],
        });

        const result = await chat.sendMessage(text);
        const responseText = result.response.text();

        console.log("Raw Gemini Response:", responseText);

        // Clean up potential markdown blocks if the model adds them despite MIME type
        const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

        const json = JSON.parse(cleanJson);
        return json;

    } catch (error) {
        console.error('Erro na AI (Gemini):', error);
        // Fallback in case of AI failure
        return {
            tipo: 'neutro',
            message: 'Desculpe, não consegui entender ou houve um erro técnico. Poderia repetir?'
        };
    }
}

module.exports = { interpretMessage };
