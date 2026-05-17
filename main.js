const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
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
                            notebookState = {
                                pages: [{ strokes: [], text: "" }],
                                currentPageIndex: 0,
                                settings: currentSettings,
                            };
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
                                const pName = `📁 ${path.basename(path.dirname(filePath))}`;
                                if (parsed.settings) currentSettings = { ...currentSettings, ...parsed.settings, projectName: pName };
                                else currentSettings.projectName = pName;
                                notebookState.settings = currentSettings;
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
        let parsed = JSON.parse(data);
        // Embed file:// image assets as base64 data URLs for portability in browsers
        const extToMime = (ext) => {
            ext = ext.toLowerCase();
            if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
            if (ext === '.png') return 'image/png';
            if (ext === '.gif') return 'image/gif';
            if (ext === '.webp') return 'image/webp';
            return 'application/octet-stream';
        };

        if (parsed && Array.isArray(parsed.pages)) {
            parsed.pages.forEach(page => {
                if (!page.strokes || !Array.isArray(page.strokes)) return;
                page.strokes.forEach((stroke) => {
                    if (!stroke || stroke.type !== 'image') return;
                    // prefer existing data URLs
                    if (typeof stroke.src === 'string' && stroke.src.startsWith('data:')) return;
                    // try localPath then src
                    const fileUrl = (stroke.localPath && typeof stroke.localPath === 'string') ? stroke.localPath : stroke.src;
                    if (typeof fileUrl === 'string' && fileUrl.startsWith('file://')) {
                        try {
                            const filePath = fileUrl.replace('file://', '');
                            if (fs.existsSync(filePath)) {
                                const ext = path.extname(filePath);
                                const mime = extToMime(ext);
                                const buf = fs.readFileSync(filePath);
                                const b64 = buf.toString('base64');
                                stroke.src = `data:${mime};base64,${b64}`;
                            }
                        } catch (e) {
                            console.error('Failed to embed image for JSON:', e);
                        }
                    }
                });
            });
        }

        fs.writeFileSync(path.join(folderPath, `${folderName}.json`), JSON.stringify(parsed, null, 2));
        return true;
    } catch (e) {
        console.error('fs:saveJSON error:', e);
        // fallback: write raw data
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
    try {
        const assetsDir = path.join(folderPath, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        const filePath = path.join(assetsDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return pathToFileURL(filePath).toString();
    } catch (e) {
        console.error('Error saving asset:', e);
        throw e;
    }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });