const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AdmZip = require('adm-zip');

// --- GLOBAL STATE ---
let mainWindow;
let expressApp;
let server;
let io;
let serverPort = 3000;

// File System State
let activeNotebookPath = null; // Temp folder where unzipped files live while editing
let realScribeFilePath = null; // The actual .scribe file on the user's hard drive

// --- NETWORK & SERVER SETUP ---
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return '127.0.0.1';
}

function startServer() {
    expressApp = express();
    server = http.createServer(expressApp);
    io = new Server(server, { cors: { origin: "*" } });

    // Serve the UI files to the iPad
    expressApp.use(express.static(__dirname));

    // WebSocket Syncing Engine
    let currentSessionState = { isOpen: false, totalPages: 0, settings: { theme: 'white' } };

    io.on('connection', (socket) => {
        // When iPad connects, send current state
        socket.emit('load-full-state', currentSessionState);

        // Host updates the master state
        socket.on('host-set-full-state', (state) => {
            currentSessionState = state;
            socket.broadcast.emit('load-full-state', state);
        });

        // Virtualized Pagination Syncing
        socket.on('request-page', (pageIndex) => socket.broadcast.emit('request-page', pageIndex));
        socket.on('deliver-page', (data) => socket.broadcast.emit('deliver-page', data));
        socket.on('update-active-page', (data) => socket.broadcast.emit('update-active-page', data));

        // Real-Time Drawing Relays
        socket.on('start-stream', (data) => socket.broadcast.emit('start-stream', data));
        socket.on('stream-point', (data) => socket.broadcast.emit('stream-point', data));
        socket.on('remote-start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
        socket.on('remote-stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

        // Batch Actions
        socket.on('add-stroke-batch', (data) => socket.broadcast.emit('add-stroke-batch', data));
        socket.on('delete-strokes', (data) => socket.broadcast.emit('delete-strokes', data));
    });

    server.listen(serverPort, () => {
        console.log(`Sync server running at http://${getLocalIP()}:${serverPort}`);
    });
}

// --- FILE SYSTEM UTILITIES ---
function packageScribeFile() {
    if (!activeNotebookPath || !realScribeFilePath) return;
    try {
        const zip = new AdmZip();
        zip.addLocalFolder(activeNotebookPath);
        zip.writeZip(realScribeFilePath);
    } catch (err) {
        console.error("Failed to package .scribe file:", err);
    }
}

async function createNewNotebook() {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Create New Scribe Notebook',
        defaultPath: 'Untitled.scribe',
        filters: [{ name: 'Scribe Notebook', extensions: ['scribe'] }] 
    });
    
    if (!canceled && filePath) {
        realScribeFilePath = filePath;
        // Create an isolated temp workspace
        activeNotebookPath = path.join(os.tmpdir(), `scribe_${Date.now()}`);
        fs.mkdirSync(activeNotebookPath, { recursive: true });
        fs.mkdirSync(path.join(activeNotebookPath, 'pages'));
        fs.mkdirSync(path.join(activeNotebookPath, 'assets'));
        
        // Save the blank project to disk immediately
        packageScribeFile(); 
        
        // Boot up the UI
        mainWindow.webContents.send('menu-action', { 
            action: 'new', 
            path: activeNotebookPath, 
            projectName: path.basename(realScribeFilePath, '.scribe') 
        });
    }
}

async function openExistingNotebook() {
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
            // Unzip the file into the temp workspace
            const zip = new AdmZip(realScribeFilePath);
            zip.extractAllTo(activeNotebookPath, true);
        } catch (err) {
            dialog.showErrorBox("Corrupt Notebook", "Failed to extract this notebook. It may be damaged.");
            return;
        }
        
        // Read project data
        const pagesDir = path.join(activeNotebookPath, 'pages');
        const pageFiles = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter(f => f.endsWith('.json')) : [];
        const settingsPath = path.join(activeNotebookPath, 'settings.json');
        const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
        
        const firstPagePath = path.join(pagesDir, 'page_0.json');
        const firstPage = fs.existsSync(firstPagePath) ? JSON.parse(fs.readFileSync(firstPagePath, 'utf8')) : { strokes: [], text: "" };
        
        // Boot up the UI with data
        mainWindow.webContents.send('menu-action', { 
            action: 'open', 
            folderPath: activeNotebookPath,
            projectName: path.basename(realScribeFilePath, '.scribe'),
            data: JSON.stringify({ totalPages: Math.max(1, pageFiles.length), firstPage, settings }) 
        });
    }
}

function createMenu() {
    const isMac = process.platform === 'darwin';
    const template = [
        {
            label: 'File',
            submenu: [
                { label: 'New Notebook', accelerator: 'CmdOrCtrl+N', click: createNewNotebook },
                { label: 'Open Notebook', accelerator: 'CmdOrCtrl+O', click: openExistingNotebook },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggledevtools' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- ELECTRON WINDOW LIFECYCLE ---
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        
        // WINDOW CONTROLS OVERLAY (The Microsoft Word Header)
        titleBarStyle: 'hidden', 
        titleBarOverlay: {
            color: '#2b579a', 
            symbolColor: '#ffffff', 
            height: 32 
        },

        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.setMenuBarVisibility(false); // Hides the ugly text menu natively
    mainWindow.loadFile('index.html');
    createMenu();
}

app.whenReady().then(() => {
    startServer();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC LISTENERS (App Backend API) ---

// UI Menu Buttons (Triggered from HTML Welcome Screen)
ipcMain.on('trigger-menu-item', (event, action) => {
    if (action === 'new-file') createNewNotebook();
    if (action === 'open-file') openExistingNotebook();
});

// Page Saving (Debounced from frontend)
ipcMain.handle('fs:savePage', async (event, folderPath, pageIndex, pageData) => {
    try {
        const pagesDir = path.join(folderPath, 'pages');
        if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
        
        fs.writeFileSync(path.join(pagesDir, `page_${pageIndex}.json`), JSON.stringify(pageData));
        packageScribeFile(); // Bundle the zip immediately
        return true;
    } catch (err) {
        console.error(err);
        return false;
    }
});

// Settings Saving
ipcMain.handle('fs:saveSettings', async (event, folderPath, settings) => {
    try {
        fs.writeFileSync(path.join(folderPath, 'settings.json'), JSON.stringify(settings));
        packageScribeFile();
        return true;
    } catch (err) { return false; }
});

// Image / Asset Saving
ipcMain.handle('fs:saveAsset', async (event, folderPath, fileName, base64Data) => {
    try {
        const assetsDir = path.join(folderPath, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        
        const filePath = path.join(assetsDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        
        packageScribeFile();
        // Return local protocol path so the HTML image tag can render it
        return `file://${filePath}`; 
    } catch (err) {
        console.error("Asset save error:", err);
        throw err;
    }
});

// Lazy-Load Pages
ipcMain.handle('fs:loadPage', async (event, folderPath, pageIndex) => {
    try {
        const pagePath = path.join(folderPath, 'pages', `page_${pageIndex}.json`);
        if (fs.existsSync(pagePath)) {
            const raw = fs.readFileSync(pagePath, 'utf8');
            return JSON.parse(raw);
        }
        return { strokes: [], text: "" };
    } catch (err) {
        return { strokes: [], text: "" };
    }
});

// PDF Export (Drops a PDF next to the original .scribe file)
ipcMain.handle('fs:savePDF', async (event, folderPath, arrayBuffer) => {
    try {
        if (!realScribeFilePath) return;
        const pdfPath = realScribeFilePath.replace('.scribe', '_Export.pdf');
        fs.writeFileSync(pdfPath, Buffer.from(arrayBuffer));
        return true;
    } catch (err) {
        console.error("PDF Export error:", err);
        return false;
    }
});

// Network Dashboard Tool
ipcMain.handle('network:refresh', async () => {
    // Simply fetch and return the IP, assuming server is still healthy.
    // If you needed to force-restart ports, you would close `server` and `startServer()` here.
    return `http://${getLocalIP()}:${serverPort}`;
});