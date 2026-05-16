const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let mainWindow;

// --- NATIVE SERVER ---
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, { cors: { origin: "*" } });

expressApp.use(express.static(__dirname));

let currentStrokes = [];
let currentText = "";
let currentSettings = { theme: 'white', pageSize: 'infinite', canvasHeight: 5000, projectName: '📁 No Project' };

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
    socket.on('trigger-remote-export', () => {
        socket.broadcast.emit('trigger-remote-export');
    });
});

server.listen(3000, '0.0.0.0', () => {
    console.log('Internal Sync Server is running on Port 3000');
});

// --- ELECTRON APP ---
app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 1200, height: 800,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });

    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Notebook Folder',
                    accelerator: 'CmdOrCtrl+N',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
                        if (!result.canceled && result.filePaths.length > 0) {
                            currentStrokes = []; currentText = "";
                            const pName = `📁 ${path.basename(result.filePaths[0])}`;
                            currentSettings = { theme: 'white', pageSize: 'infinite', canvasHeight: 5000, projectName: pName };
                            mainWindow.webContents.send('menu-action', { action: 'new', path: result.filePaths[0] });
                        }
                    }
                },
                {
                    label: 'Open Notebook',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            const data = fs.readFileSync(filePath, 'utf-8');
                            try {
                                const parsed = JSON.parse(data);
                                currentStrokes = parsed.strokes || [];
                                currentText = parsed.text || "";
                                const pName = `📁 ${path.basename(path.dirname(filePath))}`;
                                if (parsed.settings) currentSettings = { ...currentSettings, ...parsed.settings, projectName: pName };
                                else currentSettings.projectName = pName;
                            } catch (e) { console.error("Error parsing JSON:", e); }
                            mainWindow.webContents.send('menu-action', { action: 'open', data: data, folderPath: path.dirname(filePath), fileName: path.basename(filePath) });
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggledevtools' }] }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
    mainWindow.loadFile('index.html');
});

// --- DYNAMIC FILE SAVING ---
ipcMain.handle('fs:saveJSON', (event, folderPath, data) => {
    const folderName = path.basename(folderPath); 
    fs.writeFileSync(path.join(folderPath, `${folderName}.json`), data); 
    return true;
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    const folderName = path.basename(folderPath);
    fs.writeFileSync(path.join(folderPath, `${folderName}.pdf`), Buffer.from(arrayBuffer)); 
    return true;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });