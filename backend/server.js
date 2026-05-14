const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable CORS so your local HTML file is allowed to connect
const io = new Server(server, {
    cors: { origin: "*" } 
});

// --- THE IN-MEMORY DATABASE ---
let notebookData = {
    text: "",
    strokes: []
};

io.on('connection', (socket) => {
    console.log('✅ A device connected:', socket.id);

    // 1. Immediately send the current notebook state on load
    socket.emit('init-data', notebookData);

    // 2. Listen for text changes
    socket.on('update-text', (newText) => {
        notebookData.text = newText;
        socket.broadcast.emit('receive-text', newText);
    });

    // 3. Replace entire stroke array (Used by the "Clear Ink" button)
    socket.on('update-strokes', (newStrokes) => {
        notebookData.strokes = newStrokes; 
        socket.broadcast.emit('receive-strokes', newStrokes);
    });

    // 4. Add a single completed stroke (Saves massive bandwidth when lifting pen)
    socket.on('add-stroke', (newStroke) => {
        if (newStroke && newStroke.id) {
            // if we already have a stroke with this id, merge/replace to avoid duplicates
            const existing = notebookData.strokes.find(s => s.id === newStroke.id);
            if (existing) {
                // replace points in-place
                existing.length = 0;
                for (const p of newStroke) existing.push(p);
                existing.id = newStroke.id;
                socket.broadcast.emit('receive-new-stroke', existing);
                return;
            }
        }

        notebookData.strokes.push(newStroke);
        socket.broadcast.emit('receive-new-stroke', newStroke);
    });

    // 4b. Append stroke segments while streaming so storage happens during draw
    socket.on('append-stroke', (data) => {
        // data: { id, points: [{x,y}, ...] }
        if (!data || !data.id || !Array.isArray(data.points)) return;

        // find existing stroke by id
        let existing = notebookData.strokes.find(s => s.id === data.id);
        if (!existing) {
            // create a new array and tag id on it
            existing = [];
            existing.id = data.id;
            notebookData.strokes.push(existing);
        }

        // append points
        for (const p of data.points) existing.push(p);

        // broadcast the appended segment to other clients
        socket.broadcast.emit('receive-stroke-segment', { id: data.id, points: data.points });
    });

    // 5. Live Streaming Relays (Instantly passes drawing coordinates frame-by-frame)
    socket.on('start-stream', (coords) => {
        socket.broadcast.emit('remote-start-stream', coords);
    });

    socket.on('stream-point', (coords) => {
        socket.broadcast.emit('remote-stream-point', coords);
    });

    socket.on('disconnect', () => {
        console.log('❌ A device disconnected:', socket.id);
    });
});

// Listen on '0.0.0.0' to open the server to your entire Wi-Fi network
server.listen(3000, '0.0.0.0', () => {
    console.log('🚀 ScribeSync Server running on Port 3000');
    console.log('📱 To connect iPad, type your laptop IP into Safari (e.g., http://192.168.x.x:5500)');
});