const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime } = require('luxon');
const { log } = require('../utils/logger');
const { withGoogleRetry } = require('../utils/retry');

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
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
            resource.start = { dateTime: eventData.start, timeZone: 'America/Sao_Paulo' };
        } else if (eventData.start) {
            resource.start = { date: eventData.start };
        }

        if (eventData.end && eventData.end.includes('T')) {
            resource.end = { dateTime: eventData.end, timeZone: 'America/Sao_Paulo' };
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
                ? { dateTime: updates.start, timeZone: 'America/Sao_Paulo' }
                : { date: updates.start };
        }
        if (updates.end) {
            resource.end = updates.end.includes('T')
                ? { dateTime: updates.end, timeZone: 'America/Sao_Paulo' }
                : { date: updates.end };
        }
        if (updates.colorId) resource.colorId = updates.colorId;

        log.google('Atualizando evento', { eventId });

        const response = await calendar.events.patch({
            calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
            eventId: eventId,
            resource: resource
        });

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

// --- TASKS ---

async function createTask(taskData, taskListId = '@default') {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const tasks = google.tasks({ version: 'v1', auth });

        const resource = {
            title: taskData.title || taskData.name,
            notes: taskData.notes,
        };
        if (taskData.due) {
            if (taskData.due.includes('T')) {
                resource.due = taskData.due.endsWith('Z') ? taskData.due : taskData.due + 'Z';
            } else {
                resource.due = taskData.due + 'T00:00:00.000Z';
            }
        }

        log.google('Criando tarefa', { title: resource.title });

        const response = await tasks.tasks.insert({
            tasklist: taskListId,
            resource: resource,
        });

        log.google('Tarefa criada', { id: response.data.id });
        return response.data;
    }, 'createTask');
}

async function listTasks(timeMin, timeMax, showCompleted = false) {
    const grouped = await listTasksGrouped(timeMin, timeMax, showCompleted);
    return grouped.reduce((acc, group) => acc.concat(group.tasks), []);
}

async function updateTask(taskId, updates, taskListId = '@default') {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const resource = {};
        if (updates.title) resource.title = updates.title;
        if (updates.notes) resource.notes = updates.notes;
        if (updates.due) resource.due = updates.due + 'T00:00:00.000Z';
        if (updates.status) resource.status = updates.status;

        log.google('Atualizando tarefa', { taskId });

        const response = await service.tasks.patch({
            tasklist: taskListId,
            task: taskId,
            resource: resource
        });
        return response.data;
    }, 'updateTask');
}

async function completeTask(taskId, taskListId = '@default') {
    log.google('Completando tarefa', { taskId });
    return updateTask(taskId, { status: 'completed' }, taskListId);
}

async function deleteTask(taskId, taskListId = '@default') {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        log.google('Deletando tarefa', { taskId });

        await service.tasks.delete({
            tasklist: taskListId,
            task: taskId
        });
    }, 'deleteTask');
}

// --- HELPERS ---

async function generateAuthUrl() {
    const creds = await loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
        creds.client_id, creds.client_secret, creds.redirect_uri
    );
    return oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
}

async function getTokenFromCode(code) {
    const creds = await loadCredentials();
    const oAuth2Client = new google.auth.OAuth2(
        creds.client_id, creds.client_secret, creds.redirect_uri
    );
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    return tokens;
}

async function listTasksGrouped(timeMin, timeMax, showCompleted = false) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const listsResponse = await service.tasklists.list();
        const taskLists = listsResponse.data.items || [];

        const result = [];

        for (const list of taskLists) {
            const params = {
                tasklist: list.id,
                showCompleted: showCompleted,
            };
            if (timeMin) params.dueMin = timeMin;
            if (timeMax) params.dueMax = timeMax;

            const res = await service.tasks.list(params);
            const items = res.data.items || [];

            items.forEach(t => {
                t.taskListId = list.id;
                t.taskListName = list.title;
            });

            result.push({
                id: list.id,
                title: list.title,
                tasks: items
            });
        }

        log.google('Tarefas listadas', {
            lists: result.length,
            totalTasks: result.reduce((sum, g) => sum + g.tasks.length, 0)
        });

        return result;
    }, 'listTasksGrouped');
}

module.exports = {
    createEvent,
    listEvents,
    updateEvent,
    deleteEvent,
    createTask,
    listTasks,
    listTasksGrouped,
    updateTask,
    completeTask,
    deleteTask,
    generateAuthUrl,
    getTokenFromCode
};
