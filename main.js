const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;

app.whenReady().then(() => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const menuTemplate = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'New Notebook Folder',
                    accelerator: 'CmdOrCtrl+N',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openDirectory', 'createDirectory']
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('menu-action', { action: 'new', path: result.filePaths[0] });
                        }
                    }
                },
                {
                    label: 'Open Notebook',
                    accelerator: 'CmdOrCtrl+O',
                    click: async () => {
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openFile'],
                            filters: [{ name: 'JSON', extensions: ['json'] }]
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            const filePath = result.filePaths[0];
                            const data = fs.readFileSync(filePath, 'utf-8');
                            mainWindow.webContents.send('menu-action', { 
                                action: 'open', data: data, folderPath: path.dirname(filePath), fileName: path.basename(filePath) 
                            });
                        }
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggledevtools' }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
    mainWindow.loadFile('index.html');
});

ipcMain.handle('fs:saveJSON', (event, folderPath, data) => {
    fs.writeFileSync(path.join(folderPath, 'data_editable.json'), data);
    return true;
});

ipcMain.handle('fs:savePDF', (event, folderPath, arrayBuffer) => {
    fs.writeFileSync(path.join(folderPath, 'notebook_export.pdf'), Buffer.from(arrayBuffer));
    return true;
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });