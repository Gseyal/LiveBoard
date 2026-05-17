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
        console.error('Asset upload failed:', err);
        res.status(500).json({ error: 'Failed to save asset' });
    }
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
                            properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }]
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

        fs.writeFileSync(path.join(folderPath, `${folderName}.json`), JSON.stringify(parsed, null, 2));
        return true;
    } catch (e) {
        console.error('fs:saveJSON error:', e);
        fs.writeFileSync(path.join(folderPath, `${folderName}.json`), data);
        return false;
    }
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    const folderName = path.basename(folderPath);
    fs.writeFileSync(path.join(folderPath, `${folderName}.pdf`), Buffer.from(arrayBuffer)); 
    return true;
});

ipcMain.handle('fs:saveAsset', (event, folderPath, fileName, base64Data) => {
    const assetsDir = path.join(folderPath, 'assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const filePath = path.join(assetsDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

    const folderName = path.basename(folderPath);
    return `http://localhost:3000/notebook-assets/${encodeURIComponent(folderName)}/${encodeURIComponent(fileName)}`;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });