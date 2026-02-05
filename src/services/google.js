const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

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
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    const resource = {
        summary: eventData.summary,
        description: eventData.description,
        location: eventData.location,
        start: { dateTime: eventData.start, timeZone: 'America/Sao_Paulo' },
        end: { dateTime: eventData.end, timeZone: 'America/Sao_Paulo' },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    };

    if (eventData.attendees && Array.isArray(eventData.attendees)) {
        resource.attendees = eventData.attendees.map(email => ({ email }));
    }

    if (eventData.recurrence) {
        // Ex: 'RRULE:FREQ=WEEKLY;COUNT=10'
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

    const response = await calendar.events.insert({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        resource: resource,
        conferenceDataVersion: 1,
    });
    return response.data;
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
    return response.data.items || [];
}

async function updateEvent(eventId, updates) {
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    // First get the event to merge properties if necessary, but PATCH semantics usually handle this.
    // However, for start/end, we need the full object structure.

    const resource = {};
    if (updates.summary) resource.summary = updates.summary;
    if (updates.description) resource.description = updates.description;
    if (updates.location) resource.location = updates.location;
    if (updates.start) resource.start = { dateTime: updates.start, timeZone: 'America/Sao_Paulo' };
    if (updates.end) resource.end = { dateTime: updates.end, timeZone: 'America/Sao_Paulo' };
    if (updates.colorId) resource.colorId = updates.colorId;

    const response = await calendar.events.patch({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        eventId: eventId,
        resource: resource
    });
    return response.data;
}

async function deleteEvent(eventId) {
    const auth = await getAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });

    await calendar.events.delete({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        eventId: eventId
    });
}

// --- TASKS ---

async function createTask(taskData, taskListId = '@default') {
    const auth = await getAuthClient();
    const tasks = google.tasks({ version: 'v1', auth });

    const resource = {
        title: taskData.title,
        notes: taskData.notes,
    };
    if (taskData.due) {
        // If it looks like a full DateTime (has 'T'), just append Z if missing
        if (taskData.due.includes('T')) {
            resource.due = taskData.due.endsWith('Z') ? taskData.due : taskData.due + 'Z';
        } else {
            // Assume it's just a date YYYY-MM-DD
            resource.due = taskData.due + 'T00:00:00.000Z';
        }
    }

    const response = await tasks.tasks.insert({
        tasklist: taskListId,
        resource: resource,
    });
    return response.data;
}

async function listTasks(timeMin, timeMax, showCompleted = false) {
    const grouped = await listTasksGrouped(timeMin, timeMax, showCompleted);
    // Flatten
    return grouped.reduce((acc, group) => acc.concat(group.tasks), []);
}

async function updateTask(taskId, updates, taskListId = '@default') {
    const auth = await getAuthClient();
    const service = google.tasks({ version: 'v1', auth });

    const resource = {};
    if (updates.title) resource.title = updates.title;
    if (updates.notes) resource.notes = updates.notes;
    if (updates.due) resource.due = updates.due + 'T00:00:00.000Z';
    if (updates.status) resource.status = updates.status;

    const response = await service.tasks.patch({
        tasklist: taskListId,
        task: taskId,
        resource: resource
    });
    return response.data;
}

async function completeTask(taskId, taskListId = '@default') {
    return updateTask(taskId, { status: 'completed' }, taskListId);
}

async function deleteTask(taskId, taskListId = '@default') {
    const auth = await getAuthClient();
    const service = google.tasks({ version: 'v1', auth });

    await service.tasks.delete({
        tasklist: taskListId,
        task: taskId
    });
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
    const auth = await getAuthClient();
    const service = google.tasks({ version: 'v1', auth });

    try {
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

            // Enrich items with list info just in case
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
        return result;
    } catch (error) {
        console.error('Error listing tasks:', error);
        return [];
    }
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
