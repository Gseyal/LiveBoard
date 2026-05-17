const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

let currentStrokes = [];
let currentText = "";
let currentSettings = { theme: 'white', pageSize: 'infinite' };
let notebookState = {
    pages: [{ strokes: [], text: "" }],
    currentPageIndex: 0,
    settings: currentSettings,
};

io.on('connection', (socket) => {
    socket.emit('receive-strokes', currentStrokes);
    socket.emit('receive-text', currentText);
    socket.emit('receive-page-settings', currentSettings);
    socket.emit('load-full-state', notebookState);
    socket.emit('receive-active-page', notebookState.pages[notebookState.currentPageIndex] || { strokes: [], text: "" });

    socket.on('start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
    socket.on('stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

    socket.on('add-stroke-batch', (batch) => {
        currentStrokes.push(...batch);
        if (notebookState.pages[notebookState.currentPageIndex]) {
            notebookState.pages[notebookState.currentPageIndex].strokes = currentStrokes;
        }
        socket.broadcast.emit('receive-stroke-batch', batch);
    });
    socket.on('update-strokes', (strokes) => {
        currentStrokes = strokes;
        if (notebookState.pages[notebookState.currentPageIndex]) {
            notebookState.pages[notebookState.currentPageIndex].strokes = strokes;
        }
        socket.broadcast.emit('receive-strokes', strokes);
    });
    socket.on('update-text', (text) => {
        currentText = text;
        if (notebookState.pages[notebookState.currentPageIndex]) {
            notebookState.pages[notebookState.currentPageIndex].text = text;
        }
        socket.broadcast.emit('receive-text', text);
    });
    socket.on('update-page-settings', (settings) => {
        currentSettings = { ...currentSettings, ...settings };
        notebookState.settings = currentSettings;
        socket.broadcast.emit('receive-page-settings', currentSettings);
    });
    socket.on('load-full-state', (state) => {
        notebookState = {
            pages: state.pages || [{ strokes: [], text: "" }],
            currentPageIndex: state.currentPageIndex || 0,
            settings: { ...currentSettings, ...(state.settings || {}) },
        };
        currentSettings = notebookState.settings;
        const activePage = notebookState.pages[notebookState.currentPageIndex] || { strokes: [], text: "" };
        currentStrokes = activePage.strokes || [];
        currentText = activePage.text || "";
        socket.broadcast.emit('load-full-state', notebookState);
        socket.broadcast.emit('receive-active-page', activePage);
        socket.broadcast.emit('receive-page-settings', currentSettings);
    });
    socket.on('update-active-page', (pageData) => {
        notebookState.pages[notebookState.currentPageIndex] = pageData;
        currentStrokes = pageData.strokes || [];
        currentText = pageData.text || "";
        socket.broadcast.emit('receive-active-page', pageData);
    });
    socket.on('change-page', (index) => {
        notebookState.currentPageIndex = index;
        socket.broadcast.emit('remote-page-changed', index);
        const activePage = notebookState.pages[index] || { strokes: [], text: "" };
        currentStrokes = activePage.strokes || [];
        currentText = activePage.text || "";
        socket.broadcast.emit('receive-active-page', activePage);
    });
    socket.on('add-page', () => {
        notebookState.pages.push({ strokes: [], text: "" });
        notebookState.currentPageIndex = notebookState.pages.length - 1;
        currentStrokes = [];
        currentText = "";
        socket.broadcast.emit('remote-page-added', notebookState);
        socket.broadcast.emit('load-full-state', notebookState);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on Port ${PORT} - Ready for iPad`);
});