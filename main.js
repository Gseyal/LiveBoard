const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

let mainWindow;

// =========================================================
// 1. NATIVE LOCAL SERVER (Handles Asset Routing & iPad Sync)
// =========================================================
const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server, { cors: { origin: "*" } });

expressApp.use(express.static(__dirname));
expressApp.use(express.json({ limit: '50mb' }));

let activeNotebookPath = '';

// Dynamically serve images from the currently open notebook folder
expressApp.use('/active-assets', (req, res, next) => {
    if (activeNotebookPath) {
        express.static(path.join(activeNotebookPath, 'assets'))(req, res, next);
    } else {
        next();
    }
});

// Auto-detect the computer's Wi-Fi IP address for the iPad QR code
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

// =========================================================
// 2. CRASH-PROOF SOCKET.IO RELAY (The Sync Brain)
// =========================================================
let globalNotebookState = { isOpen: false, pages: [] };

io.on('connection', (socket) => {
    // iPad connects -> Send it the current notebook state
    socket.emit('load-full-state', globalNotebookState);

    // Smooth Ink Relaying
    socket.on('start-stream', (data) => socket.broadcast.emit('remote-start-stream', data));
    socket.on('stream-point', (data) => socket.broadcast.emit('remote-stream-point', data));

    // Page Level Syncing (With Safety Checks to prevent crashes)
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

    // Laptop master override when opening a new file
    socket.on('host-set-full-state', (state) => {
        globalNotebookState = state;
        if (!globalNotebookState.pages) globalNotebookState.pages = []; 
        socket.broadcast.emit('load-full-state', globalNotebookState);
    });

    // Lazy Loading: iPad asks for a page it doesn't have yet
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


// =========================================================
// 3. ELECTRON WINDOW & KEYBOARD SHORTCUTS
// =========================================================
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    mainWindow.loadFile('index.html');
    createMenu();
}

app.whenReady().then(createWindow);

// Handles macOS quitting behavior correctly
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

function createMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Notebook',
                    accelerator: 'CmdOrCtrl+N',
                    click: async () => {
                        // UX ILLUSION: Ask them to save a "file", but we use it to name our folder!
                        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
                            title: 'Create New ScribeSync Notebook',
                            defaultPath: 'Untitled.scribe',
                            buttonLabel: 'Create Notebook'
                        });
                        
                        if (!canceled && filePath) {
                            activeNotebookPath = filePath;
                            
                            // Force the .scribe extension to visually lock it as a project
                            if (!activeNotebookPath.endsWith('.scribe')) activeNotebookPath += '.scribe';
                            
                            // Create the master folder
                            if (!fs.existsSync(activeNotebookPath)) {
                                fs.mkdirSync(activeNotebookPath, { recursive: true });
                            }
                            
                            mainWindow.webContents.send('menu-action', { action: 'new', path: activeNotebookPath });
                        }
                    }
                },
                {
                    label: 'Open Notebook',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, { 
                            title: 'Open ScribeSync Notebook',
                            properties: ['openDirectory'] 
                        });
                        
                        if (!canceled && filePaths.length > 0) {
                            let selectedPath = filePaths[0];
                            
                            // --- THE UX AUTO-CORRECTOR ---
                            // If they clicked too deep into the subfolders, bump them up!
                            const folderName = path.basename(selectedPath);
                            if (folderName === 'pages' || folderName === 'assets') {
                                selectedPath = path.dirname(selectedPath);
                            }
                            
                            // --- THE BOUNCER ---
                            // Check if this is actually a notebook
                            const settingsPath = path.join(selectedPath, 'settings.json');
                            if (!fs.existsSync(settingsPath) && !selectedPath.endsWith('.scribe')) {
                                dialog.showErrorBox("Invalid File", "This does not appear to be a valid ScribeSync notebook.");
                                return; // Abort securely
                            }
                            
                            activeNotebookPath = selectedPath;
                            const pagesDir = path.join(activeNotebookPath, 'pages');
                            const pageFiles = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter(f => f.endsWith('.json')) : [];
                            const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
                            
                            // Lazy load Page 0
                            const firstPagePath = path.join(pagesDir, 'page_0.json');
                            const firstPage = fs.existsSync(firstPagePath) ? JSON.parse(fs.readFileSync(firstPagePath, 'utf8')) : { strokes: [], text: "" };
                            
                            mainWindow.webContents.send('menu-action', { 
                                action: 'open', 
                                folderPath: activeNotebookPath,
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
                { role: 'reload', accelerator: 'CmdOrCtrl+R' }, // Reload App
                { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' }, // Hard Reload
                { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' }, // Open Inspector
                { type: 'separator' },
                { role: 'resetZoom', accelerator: 'CmdOrCtrl+0' }, // Reset Zoom
                { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' }, // Zoom In
                { role: 'zoomOut', accelerator: 'CmdOrCtrl+-' }, // Zoom Out
                { type: 'separator' },
                { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Command+F' : 'F11' } // Fullscreen
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}


// =========================================================
// 4. IPC HANDLERS (Hard Drive Saving/Loading)
// =========================================================

ipcMain.handle('fs:saveSettings', (event, folderPath, settings) => {
    fs.writeFileSync(path.join(folderPath, 'settings.json'), JSON.stringify(settings, null, 2));
});

ipcMain.handle('fs:savePage', (event, folderPath, pageIndex, pageData) => {
    const pagesDir = path.join(folderPath, 'pages');
    if (!fs.existsSync(pagesDir)) fs.mkdirSync(pagesDir, { recursive: true });
    // Compact JSON (no spacing) to save hard drive space
    fs.writeFileSync(path.join(pagesDir, `page_${pageIndex}.json`), JSON.stringify(pageData)); 
});

// Used by DOM Virtualization to fetch pages on the fly
ipcMain.handle('fs:loadPage', (event, folderPath, pageIndex) => {
    const pagePath = path.join(folderPath, 'pages', `page_${pageIndex}.json`);
    return fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : { strokes: [], text: "" };
});

// Saves base64 images to hard drive, returns a local URL for the frontend to render
ipcMain.handle('fs:saveAsset', (event, folderPath, fileName, base64Data) => {
    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, fileName), Buffer.from(base64Data, 'base64'));
    return `http://${getLocalIPAddress()}:3000/active-assets/${fileName}`;
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    fs.writeFileSync(path.join(folderPath, `${path.basename(folderPath)}.pdf`), Buffer.from(arrayBuffer));
});