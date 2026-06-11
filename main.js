const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AdmZip = require('adm-zip');

let mainWindow;

// --- FILE SYSTEM STATE ---
let realScribeFilePath = null; 
let activeNotebookPath = null; 

// =========================================================
// 1. NATIVE LOCAL SERVER & SOCKET RELAY
// =========================================================
const expressApp = express();
let server = http.createServer(expressApp);
const io = new Server(server, { cors: { origin: "*" } });

expressApp.use(express.static(__dirname));
expressApp.use(express.json({ limit: '50mb' }));

expressApp.use('/active-assets', (req, res, next) => {
    if (activeNotebookPath) express.static(path.join(activeNotebookPath, 'assets'))(req, res, next);
    else next();
});

function getLocalIPAddress() {
    const networkInterfaces = os.networkInterfaces();
    for (const interfaceName of Object.keys(networkInterfaces)) {
        for (const interfaceInfo of networkInterfaces[interfaceName] || []) {
            if (interfaceInfo && interfaceInfo.family === 'IPv4' && !interfaceInfo.internal) return interfaceInfo.address;
        }
    }
    return '127.0.0.1';
}

let activeServer = server.listen(3000, '0.0.0.0', () => console.log(`Sync server running at http://${getLocalIPAddress()}:3000`));

let globalNotebookState = { isOpen: false, pages: [] };

io.on('connection', (socket) => {
    socket.emit('load-full-state', globalNotebookState);
    socket.on('start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
    socket.on('stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

    socket.on('update-active-page', (data) => {
        socket.broadcast.emit('update-active-page', data);
        if (activeNotebookPath) {
            try {
                const pagePath = path.join(activeNotebookPath, 'pages', `page_${data.pageIndex}.json`);
                fs.writeFileSync(pagePath, JSON.stringify(data.data));
                triggerBackgroundSave(); 
            } catch (err) {}
        }
    });

    socket.on('add-stroke-batch', (data) => {
        socket.broadcast.emit('add-stroke-batch', data);
        if (activeNotebookPath) {
            try {
                const pagePath = path.join(activeNotebookPath, 'pages', `page_${data.pageIndex}.json`);
                let pageData = { strokes: [], text: "" };
                if (fs.existsSync(pagePath)) pageData = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
                if (!pageData.strokes) pageData.strokes = [];
                pageData.strokes.push(...data.strokes);
                fs.writeFileSync(pagePath, JSON.stringify(pageData));
                triggerBackgroundSave();
            } catch (err) {}
        }
    });

    socket.on('delete-strokes', (data) => {
        socket.broadcast.emit('delete-strokes', data);
        if (activeNotebookPath) {
            try {
                const pagePath = path.join(activeNotebookPath, 'pages', `page_${data.pageIndex}.json`);
                if (fs.existsSync(pagePath)) {
                    let pageData = JSON.parse(fs.readFileSync(pagePath, 'utf8'));
                    if (pageData.strokes) {
                        pageData.strokes = pageData.strokes.filter(s => !data.strokeIds.includes(s.id));
                        fs.writeFileSync(pagePath, JSON.stringify(pageData));
                        triggerBackgroundSave();
                    }
                }
            } catch (err) {}
        }
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
        } catch (err) {}
    });
});

// =========================================================
// 2. BACKGROUND PACKAGER (.scribe Zip Engine)
// =========================================================
let packTimer = null;

function packageScribeFile() {
    if (!realScribeFilePath || !activeNotebookPath) return;
    try {
        const zip = new AdmZip();
        zip.addLocalFolder(activeNotebookPath); 
        zip.writeZip(realScribeFilePath); 
    } catch (err) {
        console.error("Failed to package .scribe file:", err);
    }
}

function triggerBackgroundSave() {
    clearTimeout(packTimer);
    packTimer = setTimeout(() => { packageScribeFile(); }, 3000);
}

app.on('before-quit', () => { packageScribeFile(); });

// =========================================================
// 3. ELECTRON WINDOW & MENU
// =========================================================
function createWindow() {
    mainWindow = new BrowserWindow({ width: 1400, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    mainWindow.loadFile('index.html');
    createMenu();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function createMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Notebook',
                    accelerator: 'CmdOrCtrl+N',
                    click: async () => {
                        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
                            title: 'Create New Scribe Notebook',
                            defaultPath: 'Untitled.scribe',
                            filters: [{ name: 'Scribe Notebook', extensions: ['scribe'] }] 
                        });
                        
                        if (!canceled && filePath) {
                            realScribeFilePath = filePath;
                            activeNotebookPath = path.join(os.tmpdir(), `scribe_${Date.now()}`);
                            fs.mkdirSync(activeNotebookPath, { recursive: true });
                            fs.mkdirSync(path.join(activeNotebookPath, 'pages'));
                            fs.mkdirSync(path.join(activeNotebookPath, 'assets'));
                            
                            packageScribeFile(); 
                            mainWindow.webContents.send('menu-action', { action: 'new', path: activeNotebookPath, projectName: path.basename(realScribeFilePath, '.scribe') });
                        }
                    }
                },
                {
                    label: 'Open Notebook',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { 
                            title: 'Open Scribe Notebook',
                            properties: ['openFile'], 
                            filters: [{ name: 'Scribe Notebook', extensions: ['scribe'] }]
                        });
                        
                        if (!canceled && filePaths.length > 0) {
                            realScribeFilePath = filePaths[0];
                            activeNotebookPath = path.join(os.tmpdir(), `scribe_${Date.now()}`);
                            fs.mkdirSync(activeNotebookPath, { recursive: true });
                            
                            try {
                                const zip = new AdmZip(realScribeFilePath);
                                zip.extractAllTo(activeNotebookPath, true);
                            } catch (err) {
                                dialog.showErrorBox("Corrupt Notebook", "Failed to extract this notebook. It may be damaged.");
                                return;
                            }
                            
                            const pagesDir = path.join(activeNotebookPath, 'pages');
                            const pageFiles = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter(f => f.endsWith('.json')) : [];
                            const settingsPath = path.join(activeNotebookPath, 'settings.json');
                            const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
                            
                            const firstPagePath = path.join(pagesDir, 'page_0.json');
                            const firstPage = fs.existsSync(firstPagePath) ? JSON.parse(fs.readFileSync(firstPagePath, 'utf8')) : { strokes: [], text: "" };
                            
                            mainWindow.webContents.send('menu-action', { 
                                action: 'open', 
                                folderPath: activeNotebookPath,
                                projectName: path.basename(realScribeFilePath, '.scribe'),
                                data: JSON.stringify({ totalPages: Math.max(1, pageFiles.length), firstPage, settings }) 
                            });
                        }
                    }
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload', accelerator: 'CmdOrCtrl+R' },
                { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
                { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
                { type: 'separator' },
                { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
                { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
                { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
                { type: 'separator' },
                { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Command+F' : 'F11' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// =========================================================
// 4. IPC HANDLERS
// =========================================================
ipcMain.handle('fs:saveSettings', (event, folderPath, settings) => {
    fs.writeFileSync(path.join(folderPath, 'settings.json'), JSON.stringify(settings, null, 2));
    triggerBackgroundSave(); 
});

ipcMain.handle('fs:savePage', (event, folderPath, pageIndex, pageData) => {
    const pagesDir = path.join(folderPath, 'pages');
    if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
    fs.writeFileSync(path.join(pagesDir, `page_${pageIndex}.json`), JSON.stringify(pageData));
    triggerBackgroundSave(); 
});

ipcMain.handle('fs:loadPage', (event, folderPath, pageIndex) => {
    const pagePath = path.join(folderPath, 'pages', `page_${pageIndex}.json`);
    return fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : { strokes: [], text: "" };
});

ipcMain.handle('fs:saveAsset', (event, folderPath, fileName, base64Data) => {
    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, fileName), Buffer.from(base64Data, 'base64'));
    triggerBackgroundSave(); 
    return `http://${getLocalIPAddress()}:3000/active-assets/${fileName}`;
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    fs.writeFileSync(path.join(path.dirname(realScribeFilePath), `${path.basename(realScribeFilePath, '.scribe')}.pdf`), Buffer.from(arrayBuffer));
});

ipcMain.handle('network:refresh', () => {
    return new Promise((resolve) => {
        io.disconnectSockets(); 
        activeServer.close(() => { 
            activeServer = server.listen(3000, '0.0.0.0', () => { 
                resolve(`http://${getLocalIPAddress()}:3000`);
            });
        });
    });
});