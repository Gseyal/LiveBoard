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

io.on('connection', (socket) => {
    socket.emit('receive-strokes', currentStrokes);
    socket.emit('receive-text', currentText);
    socket.emit('receive-page-settings', currentSettings);

    socket.on('start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
    socket.on('stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

    socket.on('add-stroke-batch', (batch) => {
        currentStrokes.push(...batch);
        socket.broadcast.emit('receive-stroke-batch', batch);
    });
    socket.on('update-strokes', (strokes) => {
        currentStrokes = strokes;
        socket.broadcast.emit('receive-strokes', strokes);
    });
    socket.on('update-text', (text) => {
        currentText = text;
        socket.broadcast.emit('receive-text', text);
    });
    socket.on('update-page-settings', (settings) => {
        currentSettings = { ...currentSettings, ...settings };
        socket.broadcast.emit('receive-page-settings', currentSettings);
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on Port ${PORT} - Ready for iPad`);
});