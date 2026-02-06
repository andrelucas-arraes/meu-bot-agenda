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

// --- TASKLISTS (Gerenciamento de Listas) ---

async function createTaskList(title) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        log.google('Criando lista de tarefas', { title });

        const response = await service.tasklists.insert({
            resource: { title }
        });

        log.google('Lista criada', { id: response.data.id });
        return response.data;
    }, 'createTaskList');
}

async function deleteTaskList(taskListId) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        log.google('Deletando lista de tarefas', { taskListId });

        await service.tasklists.delete({
            tasklist: taskListId
        });
    }, 'deleteTaskList');
}

async function updateTaskList(taskListId, title) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        log.google('Atualizando lista de tarefas', { taskListId, title });

        const response = await service.tasklists.patch({
            tasklist: taskListId,
            resource: { title }
        });

        return response.data;
    }, 'updateTaskList');
}

async function clearCompletedTasks(taskListId) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        log.google('Limpando tarefas concluídas', { taskListId });

        await service.tasks.clear({
            tasklist: taskListId
        });
    }, 'clearCompletedTasks');
}

// --- TASKS AVANÇADO ---

async function getTask(taskId, taskListId = '@default') {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const response = await service.tasks.get({
            tasklist: taskListId,
            task: taskId
        });

        return response.data;
    }, 'getTask');
}

async function moveTask(taskId, taskListId = '@default', parent = null, previous = null) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const params = {
            tasklist: taskListId,
            task: taskId
        };
        if (parent) params.parent = parent;
        if (previous) params.previous = previous;

        log.google('Movendo tarefa', { taskId, parent, previous });

        const response = await service.tasks.move(params);
        return response.data;
    }, 'moveTask');
}

// Atualização do createTask para suportar hierarquia
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

        const params = {
            tasklist: taskListId,
            resource: resource,
        };

        // Suporte a hierarquia (subtarefas)
        if (taskData.parent) params.parent = taskData.parent;
        if (taskData.previous) params.previous = taskData.previous;

        log.google('Criando tarefa', { title: resource.title, parent: taskData.parent });

        const response = await tasks.tasks.insert(params);

        log.google('Tarefa criada', { id: response.data.id });
        return response.data;
    }, 'createTask');
}

async function listTasks(taskListId = '@default') {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const response = await service.tasks.list({
            tasklist: taskListId,
            showCompleted: false,
            showHidden: false
        });

        log.google('Tarefas listadas', { count: response.data.items?.length || 0, taskListId });
        return response.data.items || [];
    }, 'listTasks');
}

async function listTasksGrouped() {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const taskListsResponse = await service.tasklists.list();
        const taskLists = taskListsResponse.data.items || [];
        const groupedTasks = [];

        for (const list of taskLists) {
            const tasksResponse = await service.tasks.list({
                tasklist: list.id,
                showCompleted: false,
                showHidden: false
            });

            if (tasksResponse.data.items && tasksResponse.data.items.length > 0) {
                groupedTasks.push({
                    title: list.title,
                    id: list.id,
                    tasks: tasksResponse.data.items
                });
            }
        }

        log.google('Tarefas agrupadas listadas', { listCount: groupedTasks.length });
        return groupedTasks;
    }, 'listTasksGrouped');
}

async function updateTask(taskId, taskListId = '@default', updates) {
    return withGoogleRetry(async () => {
        const auth = await getAuthClient();
        const service = google.tasks({ version: 'v1', auth });

        const task = await service.tasks.get({
            tasklist: taskListId,
            task: taskId
        });

        const resource = {
            ...task.data,
        };

        if (updates.title) resource.title = updates.title;
        if (updates.notes) resource.notes = updates.notes;
        if (updates.status) resource.status = updates.status;
        if (updates.due) {
            if (updates.due.includes('T')) {
                resource.due = updates.due.endsWith('Z') ? updates.due : updates.due + 'Z';
            } else {
                resource.due = updates.due + 'T00:00:00.000Z';
            }
        }
        delete resource.id;
        delete resource.etag;
        delete resource.updated;
        delete resource.selfLink;
        delete resource.position;


        log.google('Atualizando tarefa', { taskId });

        const response = await service.tasks.update({
            tasklist: taskListId,
            task: taskId,
            resource: resource
        });

        log.google('Tarefa atualizada', { id: response.data.id });
        return response.data;
    }, 'updateTask');
}

async function completeTask(taskId, taskListId = '@default') {
    return updateTask(taskId, taskListId, { status: 'completed' });
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

        log.google('Tarefa deletada', { taskId });
    }, 'deleteTask');
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
    createTask,
    listTasks,
    listTasksGrouped,
    updateTask,
    completeTask,
    deleteTask,
    generateAuthUrl,
    getTokenFromCode,
    // Novos endpoints
    createTaskList,
    deleteTaskList,
    updateTaskList,
    clearCompletedTasks,
    getTask,
    moveTask
};
