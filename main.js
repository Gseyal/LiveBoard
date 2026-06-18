const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
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

expressApp.use(express.static(__dirname));
expressApp.use(express.json({ limit: '50mb' })); // Allow large base64 images

const projectMap = {};

let currentProjectFolder = ''; // Track current project folder basename
let currentStrokes = [];
let currentText = "";
let currentSettings = { theme: 'white', pageSize: 'infinite', canvasHeight: 5000, projectName: '📁 No Project' };
let notebookState = {
    pages: [{ strokes: [], text: "" }],
    currentPageIndex: 0,
    settings: currentSettings,
};

function normalizeNotebookImages(pages) {
    if (!Array.isArray(pages)) return pages;
    pages.forEach((page) => {
        if (!page || !Array.isArray(page.strokes)) return;
        page.strokes.forEach((stroke) => {
            if (!stroke || stroke.type !== 'image') return;
            delete stroke.localPath;
        });
    });
    return pages;
}

io.on('connection', (socket) => {
    console.log('[Socket] New client connected. Current project folder:', currentProjectFolder);
    socket.emit('receive-strokes', currentStrokes);
    socket.emit('receive-text', currentText);
    socket.emit('receive-page-settings', currentSettings);
    socket.emit('load-full-state', notebookState);
    socket.emit('receive-active-page', notebookState.pages[notebookState.currentPageIndex] || { strokes: [], text: "" });
    socket.emit('set-project-folder', currentProjectFolder); // Send project folder to browser clients

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
            pages: normalizeNotebookImages(state.pages || [{ strokes: [], text: "" }]),
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
        const normalizedPage = { ...pageData, strokes: normalizeNotebookImages(pageData.strokes ? [{ strokes: pageData.strokes, text: pageData.text || "" }] : [{ strokes: [], text: pageData.text || "" }])[0].strokes };
        notebookState.pages[notebookState.currentPageIndex] = normalizedPage;
        currentStrokes = normalizedPage.strokes || [];
        currentText = normalizedPage.text || "";
        socket.broadcast.emit('receive-active-page', normalizedPage);
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
    socket.on('trigger-remote-export', () => {
        socket.broadcast.emit('trigger-remote-export');
    });
});

server.listen(3000, '0.0.0.0', () => {
    console.log('Internal Sync Server is running on Port 3000');
});

expressApp.get('/notebook-assets/:project/:file', (req, res) => {
    const folderPath = projectMap[req.params.project];
    if (!folderPath) return res.status(404).send('Project not found');

    const filePath = path.join(folderPath, 'assets', req.params.file);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    return res.sendFile(filePath);
});

// POST endpoint for browser clients to upload images
expressApp.post('/upload-asset', (req, res) => {
    const { project, fileName, base64Data } = req.body;
    console.log('[Upload] Received request for project:', project, 'file:', fileName);
    if (!project || !fileName || !base64Data) {
        console.error('[Upload] Missing parameters. project:', project, 'fileName:', fileName, 'base64Data:', !!base64Data);
        return res.status(400).json({ error: 'Missing project, fileName, or base64Data' });
    }

    const folderPath = projectMap[project];
    console.log('[Upload] Project folder path:', folderPath, 'Project map keys:', Object.keys(projectMap));
    if (!folderPath) {
        console.error('[Upload] Project not found in map');
        return res.status(404).json({ error: 'Project not found' });
    }

    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
    }

    try {
        // Remove data:image/...;base64, prefix if present
        let base64 = base64Data;
        if (base64.includes(',')) {
            base64 = base64.split(',')[1];
        }

        const buffer = Buffer.from(base64, 'base64');
        const filePath = path.join(assetsDir, fileName);
        fs.writeFileSync(filePath, buffer);
        console.log('[Upload] File saved to:', filePath);

        const httpUrl = `http://localhost:3000/notebook-assets/${encodeURIComponent(project)}/${encodeURIComponent(fileName)}`;
        console.log('[Upload] Returning URL:', httpUrl);
        res.json({ success: true, url: httpUrl });
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
                {
                    label: 'New Notebook Folder',
                    accelerator: 'CmdOrCtrl+N',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
                        if (!result.canceled && result.filePaths.length > 0) {
                            currentStrokes = []; currentText = "";
                            const folderPath = result.filePaths[0];
                            const baseName = path.basename(folderPath);
                            currentProjectFolder = baseName; // Update current project folder
                            console.log('[Menu] New project opened:', baseName);
                            projectMap[baseName] = folderPath;
                            const pName = `📁 ${baseName}`;
                            currentSettings = { theme: 'white', pageSize: 'infinite', canvasHeight: 5000, projectName: pName };
                            notebookState = {
                                pages: [{ strokes: [], text: "" }],
                                currentPageIndex: 0,
                                settings: currentSettings,
                            };
                            io.sockets.emit('set-project-folder', baseName); // Broadcast to all connected clients
                            console.log('[Socket] Broadcasting project folder:', baseName);
                            mainWindow.webContents.send('menu-action', { action: 'new', path: result.filePaths[0] });
                        }
                    }
                },
                {
                    label: 'Open Notebook',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'], filters: [{ name: 'ScribeSync Notebook', extensions: ['sbn'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            const data = fs.readFileSync(filePath, 'utf-8');
                            try {
                                const parsed = JSON.parse(data);
                                if (parsed.pages) {
                                    notebookState.pages = parsed.pages;
                                    notebookState.currentPageIndex = parsed.currentPageIndex || 0;
                                    currentStrokes = notebookState.pages[notebookState.currentPageIndex]?.strokes || [];
                                    currentText = notebookState.pages[notebookState.currentPageIndex]?.text || "";
                                } else {
                                    currentStrokes = parsed.strokes || [];
                                    currentText = parsed.text || "";
                                    notebookState.pages = [{ strokes: currentStrokes, text: currentText }];
                                    notebookState.currentPageIndex = 0;
                                }
                                const folderPath = path.dirname(filePath);
                                const baseName = path.basename(folderPath);
                                currentProjectFolder = baseName; // Update current project folder
                                console.log('[Menu] Notebook opened:', baseName);
                                projectMap[baseName] = folderPath;
                                const pName = `📁 ${baseName}`;
                                if (parsed.settings) currentSettings = { ...currentSettings, ...parsed.settings, projectName: pName };
                                else currentSettings.projectName = pName;
                                notebookState.settings = currentSettings;
                                io.sockets.emit('set-project-folder', baseName); // Broadcast to all connected clients
                                console.log('[Socket] Broadcasting project folder:', baseName);
                            } catch (e) { console.error("Error parsing notebook file:", e); }
                            mainWindow.webContents.send('menu-action', { action: 'open', data: data, folderPath: path.dirname(filePath), fileName: path.basename(filePath) });
                        }
                    }
                },
                { type: 'separator' },
                isMac ? { role: 'close' } : { role: 'quit', accelerator: 'CmdOrCtrl+Q' }
            ]
        },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggledevtools' }] }
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
        const parsed = JSON.parse(data);
        const imageUrlFor = (stroke) => {
            if (!stroke || stroke.type !== 'image') return null;
            // If src is already a non-base64 URL, keep it
            if (typeof stroke.src === 'string' && !stroke.src.startsWith('data:')) return stroke.src;
            // If src is base64 but tag exists, rebuild the HTTP URL from tag
            if (typeof stroke.tag === 'string' && stroke.tag) {
                return `http://localhost:3000/notebook-assets/${encodeURIComponent(folderName)}/${encodeURIComponent(stroke.tag)}`;
            }
            // For browser-only clients, keep the base64 src as-is
            if (typeof stroke.src === 'string' && stroke.src.startsWith('data:')) return stroke.src;
            return null;
        };

        if (Array.isArray(parsed.pages)) {
            parsed.pages.forEach((page) => {
                if (!page || !Array.isArray(page.strokes)) return;
                page.strokes.forEach((stroke) => {
                    if (!stroke || stroke.type !== 'image') return;
                    const url = imageUrlFor(stroke);
                    if (url) {
                        stroke.src = url;
                        delete stroke.localPath;
                    }
                });
            });
        }

        fs.writeFileSync(path.join(folderPath, `${folderName}.sbn`), JSON.stringify(parsed, null, 2));
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

ipcMain.handle('fs:saveAsset', (event, folderPath, fileName, base64Data) => {
    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const filePath = path.join(assetsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    const folderName = path.basename(folderPath);
    return `http://localhost:3000/notebook-assets/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`;
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