const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks'
];

const TOKEN_PATH = path.join(__dirname, '../../tokens.json');
const CREDENTIALS_PATH = path.join(__dirname, '../../credentials.json'); // User should place this

async function loadCredentials() {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return {
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
        };
    }
    // Fallback to file 
    if (fs.existsSync(CREDENTIALS_PATH)) {
        const content = fs.readFileSync(CREDENTIALS_PATH);
        const keys = JSON.parse(content);
        const key = keys.installed || keys.web;
        return {
            client_id: key.client_id,
            client_secret: key.client_secret,
            redirect_uri: key.redirect_uris[0]
        };
    }
    throw new Error('Credenciais do Google não encontradas no .env ou credentials.json');
}

async function getAuthClient() {
    const creds = await loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
        creds.client_id,
        creds.client_secret,
        creds.redirect_uri
    );

    if (process.env.GOOGLE_TOKENS) {
        // Carrega do ambiente (Ideal para Railway/Cloud)
        oAuth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKENS));
    } else if (fs.existsSync(TOKEN_PATH)) {
        // Carrega do arquivo local
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        throw new Error('Token não encontrado. Execute o script de setup localmente e configure a variável GOOGLE_TOKENS.');
    }

    return oAuth2Client;
}

async function createEvent(eventData) {
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const resource = {
        summary: eventData.summary,
        description: eventData.description,
        location: eventData.location,
        start: {
            dateTime: eventData.start,
            timeZone: eventData.timezone || 'America/Sao_Paulo',
        },
        end: {
            dateTime: eventData.end,
            timeZone: eventData.timezone || 'America/Sao_Paulo',
        },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 30 },
            ],
        },
    };

    if (eventData.online) {
        resource.conferenceData = {
            createRequest: {
                requestId: Math.random().toString(36).substring(7),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
        };
    }

    const response = await calendar.events.insert({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        resource: resource,
        conferenceDataVersion: 1,
    });

    return response.data;
}

async function createTask(taskData) {
    const auth = await getAuthClient();
    const tasks = google.tasks({ version: 'v1', auth });

    const resource = {
        title: taskData.title,
        notes: taskData.notes,
    };

    if (taskData.due) {
        // Google Tasks API expects RFC 3339 timestamp (T00:00:00.000Z) for due date (task only has Date, but API takes timestamp)
        // Actually, for "due", it's usually YYYY-MM-DDT00:00:00.000Z
        resource.due = taskData.due + 'T00:00:00.000Z';
    }

    const response = await tasks.tasks.insert({
        tasklist: '@default',
        resource: resource,
    });

    return response.data;
}

// Helper to generate Auth URL (exported for setup script)
async function generateAuthUrl() {
    const creds = await loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
        creds.client_id,
        creds.client_secret,
        creds.redirect_uri
    );

    return oAuth2Client.generateAuthUrl({
        access_type: 'offline', // Critical for refresh token
        scope: SCOPES,
    });
}

// Helper to get token from code
async function getTokenFromCode(code) {
    const creds = await loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
        creds.client_id,
        creds.client_secret,
        creds.redirect_uri
    );

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log('Token armazenado em', TOKEN_PATH);
    return tokens;
}


async function listEvents(timeMin, timeMax) {
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.list({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        timeMin: timeMin,
        timeMax: timeMax,
        singleEvents: true,
        orderBy: 'startTime',
    });

    return response.data.items;
}

async function listTasks(timeMin, timeMax) {
    const auth = await getAuthClient();
    const service = google.tasks({ version: 'v1', auth });

    // Google Tasks API filters are limited (showCompleted, dueMin, dueMax)
    // dueMax needs RFC 3339 timestamp
    const response = await service.tasks.list({
        tasklist: '@default',
        showCompleted: false,
        dueMin: timeMin,
        dueMax: timeMax,
    });

    return response.data.items || [];
}

module.exports = {
    createEvent,
    createTask,
    listEvents,
    listTasks,
    generateAuthUrl,
    getTokenFromCode
};
