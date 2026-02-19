const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const { log } = require('../utils/logger');
const { withGoogleRetry } = require('../utils/retry');
const config = require('../config');

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/drive'
];

const TOKEN_PATH = path.join(__dirname, '../../tokens.json');
const CREDENTIALS_PATH = path.join(__dirname, '../../credentials.json');

async function loadCredentials() {
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        return {
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
        };
    }
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
        oAuth2Client.setCredentials(JSON.parse(process.env.GOOGLE_TOKENS));
    } else if (fs.existsSync(TOKEN_PATH)) {
        const token = fs.readFileSync(TOKEN_PATH);
        oAuth2Client.setCredentials(JSON.parse(token));
    } else {
        throw new Error('Token não encontrado.');
    }
    return oAuth2Client;
}

// --- CALENDAR ---

async function createEvent(eventData) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });

        const resource = {
            summary: eventData.summary,
            description: eventData.description,
            location: eventData.location,
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
        };

        if (eventData.start && eventData.start.includes('T')) {
            resource.start = { dateTime: eventData.start, timeZone: config.timezone };
        } else if (eventData.start) {
            resource.start = { date: eventData.start };
        }

        if (eventData.end && eventData.end.includes('T')) {
            resource.end = { dateTime: eventData.end, timeZone: config.timezone };
        } else if (eventData.end) {
            resource.end = { date: eventData.end };
        }

        if (eventData.attendees && Array.isArray(eventData.attendees)) {
            resource.attendees = eventData.attendees.map(email => ({ email }));
        }

        if (eventData.recurrence) {
            resource.recurrence = Array.isArray(eventData.recurrence) ? eventData.recurrence : [eventData.recurrence];
        }

        if (eventData.online) {
            resource.conferenceData = {
                createRequest: {
                    requestId: Math.random().toString(36).substring(7),
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
            };
        }

        log.google('Criando evento', { summary: eventData.summary });

        const response = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            resource: resource,
            conferenceDataVersion: 1,
        });

        log.google('Evento criado', { id: response.data.id, summary: response.data.summary });
        return response.data;
    }, 'createEvent');
}

async function listEvents(timeMin, timeMax) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });

        const response = await calendar.events.list({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        log.google('Eventos listados', { count: response.data.items?.length || 0 });
        return response.data.items || [];
    }, 'listEvents');
}

async function updateEvent(eventId, updates) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });

        const resource = {};
        if (updates.summary) resource.summary = updates.summary;
        if (updates.description) resource.description = updates.description;
        if (updates.location) resource.location = updates.location;
        if (updates.start) {
            resource.start = updates.start.includes('T')
                ? { dateTime: updates.start, timeZone: config.timezone }
                : { date: updates.start };
        }
        if (updates.end) {
            resource.end = updates.end.includes('T')
                ? { dateTime: updates.end, timeZone: config.timezone }
                : { date: updates.end };
        }
        if (updates.colorId) resource.colorId = updates.colorId;
        if (updates.conferenceData) resource.conferenceData = updates.conferenceData;
        if (updates.attendees) resource.attendees = updates.attendees;
        if (updates.recurrence) resource.recurrence = updates.recurrence;

        log.google('Atualizando evento', { eventId });

        const patchOptions = {
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            eventId: eventId,
            resource: resource
        };

        // conferenceDataVersion é necessário para criar/modificar Meet links
        if (updates.conferenceData) {
            patchOptions.conferenceDataVersion = 1;
        }

        const response = await calendar.events.patch(patchOptions);

        log.google('Evento atualizado', { id: response.data.id });
        return response.data;
    }, 'updateEvent');
}

async function deleteEvent(eventId) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });

        log.google('Deletando evento', { eventId });

        await calendar.events.delete({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            eventId: eventId
        });

        log.google('Evento deletado', { eventId });
    }, 'deleteEvent');
}

function generateAuthUrl() {
    const oAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
    );

    return oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
    });
}

async function getTokenFromCode(code) {
    const oAuth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
    );

    const { tokens } = await oAuth2Client.getToken(code);
    return tokens;
}

module.exports = {
    createEvent,
    listEvents,
    updateEvent,
    deleteEvent,
    generateAuthUrl,
    getTokenFromCode,
    // Status
    getStatus: async () => {
        try {
            const auth = await getAuthClient();
            return {
                online: true,
                authenticated: !!(auth.credentials && auth.credentials.access_token)
            };
        } catch (e) {
            return {
                online: true,
                authenticated: false,
                error: e.message
            };
        }
    }
};
