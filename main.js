const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let mainWindow;

// --- NATIVE LOCAL SERVER ---
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, { cors: { origin: "*" } });

expressApp.use(express.static(__dirname));
expressApp.use(express.json({ limit: '50mb' }));

let activeNotebookPath = '';
expressApp.use('/active-assets', (req, res, next) => {
    if (activeNotebookPath) {
        express.static(path.join(activeNotebookPath, 'assets'))(req, res, next);
    } else {
        next();
    }
});

function getLocalIPAddress() {
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(networkInterfaces)) {
        for (const interfaceInfo of networkInterfaces[interfaceName] || []) {
            if (interfaceInfo && interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) {
                return interfaceInfo.address;
            }
        }
    }
    return '127.0.0.1';
}

server.listen(3000, '0.0.0.0', () => {
    console.log(`Sync server running at http://${getLocalIPAddress()}:3000`);
});

// --- SOCKET.IO RELAY (CRASH-PROOF) ---
let globalNotebookState = { isOpen: false, pages: [] };

io.on('connection', (socket) => {
    socket.emit('load-full-state', globalNotebookState);

    socket.on('start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
    socket.on('stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

    socket.on('update-active-page', (data) => {
        if (globalNotebookState.pages && globalNotebookState.pages[data.pageIndex]) {
            globalNotebookState.pages[data.pageIndex] = data.data;
        }
        socket.broadcast.emit('update-active-page', data);
    });

    socket.on('add-stroke-batch', (data) => {
        if (globalNotebookState.pages && globalNotebookState.pages[data.pageIndex]) {
            if (!globalNotebookState.pages[data.pageIndex].strokes) globalNotebookState.pages[data.pageIndex].strokes = [];
            globalNotebookState.pages[data.pageIndex].strokes.push(...data.strokes);
        }
        socket.broadcast.emit('add-stroke-batch', data);
    });

    socket.on('delete-strokes', (data) => {
        if (globalNotebookState.pages && globalNotebookState.pages[data.pageIndex] && globalNotebookState.pages[data.pageIndex].strokes) {
            globalNotebookState.pages[data.pageIndex].strokes = globalNotebookState.pages[data.pageIndex].strokes.filter(
                s => !data.strokeIds.includes(s.id)
            );
        }
        socket.broadcast.emit('delete-strokes', data);
    });

    socket.on('host-set-full-state', (state) => {
        globalNotebookState = state;
        if (!globalNotebookState.pages) globalNotebookState.pages = []; 
        socket.broadcast.emit('load-full-state', globalNotebookState);
    });

    socket.on('request-page', (pageIndex) => {
        if (!activeNotebookPath) return;
        try {
            const pagePath = path.join(activeNotebookPath, 'pages', `page_${pageIndex}.json`);
            let pageData = { strokes: [], text: "" };
            if (fs.existsSync(pagePath)) pageData = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
            socket.emit('deliver-page', { pageIndex, data: pageData });
        } catch (err) { console.error(err); }
    });
});

// --- ELECTRON WINDOW & MENU ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    mainWindow.loadFile('index.html');
    createMenu();
}

function createMenu() {
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Notebook Folder',
                    click: async () => {
                        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
                        if (!canceled) {
                            activeNotebookPath = filePaths[0];
                            mainWindow.webContents.send('menu-action', { action: 'new', path: activeNotebookPath });
                        }
                    }
                },
                {
                    label: 'Open Notebook Folder',
                    click: async () => {
                        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
                        if (!canceled) {
                            activeNotebookPath = filePaths[0];
                            const pagesDir = path.join(activeNotebookPath, 'pages');
                            const pageFiles = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir) : [];
                            const settings = fs.existsSync(path.join(activeNotebookPath, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(activeNotebookPath, 'settings.json'))) : {};
                            
                            const firstPage = fs.existsSync(path.join(pagesDir, 'page_0.json')) ? JSON.parse(fs.readFileSync(path.join(pagesDir, 'page_0.json'))) : { strokes: [], text: "" };
                            
                            mainWindow.webContents.send('menu-action', { 
                                action: 'open', 
                                folderPath: activeNotebookPath,
                                data: JSON.stringify({ totalPages: Math.max(1, pageFiles.length), firstPage, settings }) 
                            });
                        }
                    }
                },
                { role: 'quit' }
            ]
        },
        { role: 'viewMenu' }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(createWindow);

// --- IPC HANDLERS ---
ipcMain.handle('fs:saveSettings', (event, folderPath, settings) => {
    fs.writeFileSync(path.join(folderPath, 'settings.json'), JSON.stringify(settings, null, 2));
});

ipcMain.handle('fs:savePage', (event, folderPath, pageIndex, pageData) => {
    const pagesDir = path.join(folderPath, 'pages');
    if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(path.join(pagesDir, `page_${pageIndex}.json`), JSON.stringify(pageData));
});

ipcMain.handle('fs:loadPage', (event, folderPath, pageIndex) => {
    const pagePath = path.join(folderPath, 'pages', `page_${pageIndex}.json`);
    return fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : { strokes: [], text: "" };
});

ipcMain.handle('fs:saveAsset', (event, folderPath, fileName, base64Data) => {
    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, fileName), Buffer.from(base64Data, 'base64'));
    return `http://${getLocalIPAddress()}:3000/active-assets/${fileName}`;
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    fs.writeFileSync(path.join(folderPath, `${path.basename(folderPath)}.pdf`), Buffer.from(arrayBuffer));
});