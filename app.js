const isElectron = (typeof window !== 'undefined' && window.require);
const ipcRenderer = isElectron ? window.require('electron').ipcRenderer : null;
const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

const serverIP = window.location.hostname || 'localhost';
const socket = io(`http://${serverIP}:3000`);

const canvas = document.getElementById('ink-layer');
const ctx = canvas.getContext('2d');
canvas.style.touchAction = 'none';
const scrollWrapper = document.getElementById('scroll-wrapper');
const textLayer = document.getElementById('text-layer');
const container = document.getElementById('notebook-container');

const toggleBtn = document.getElementById('mode-toggle');
const clearBtn = document.getElementById('clear-btn');
const colorPicker = document.getElementById('pen-color');
const sizeSelect = document.getElementById('page-size');
const bgSelect = document.getElementById('bg-color');
const exportBtn = document.getElementById('export-btn'); 

const selectBtn = document.getElementById('select-btn'); 
const deleteSelectedBtn = document.getElementById('delete-selected-btn');
const penBtn = document.getElementById('pen-btn');
const eraserBtn = document.getElementById('eraser-btn');
const eraserModeBtn = document.getElementById('eraser-mode-btn');
const brushSizeSlider = document.getElementById('brush-size');
const brushSizeVal = document.getElementById('brush-size-val'); 
const projectNameDisplay = document.getElementById('current-notebook-name');

// Typing toolbar elements
const typingToolbar = document.getElementById('typing-toolbar');
const boldBtn = document.getElementById('bold-btn');
const italicBtn = document.getElementById('italic-btn');
const underlineBtn = document.getElementById('underline-btn');
const fontSelect = document.getElementById('font-select');
const fontSizeSelect = document.getElementById('font-size-select');
const fontColor = document.getElementById('font-color');
const alignLeftBtn = document.getElementById('align-left-btn');
const alignCenterBtn = document.getElementById('align-center-btn');
const alignRightBtn = document.getElementById('align-right-btn');
const alignJustifyBtn = document.getElementById('align-justify-btn');
const undoBtn = document.getElementById('undo-btn');
const redoBtn = document.getElementById('redo-btn');
const olistBtn = document.getElementById('olist-btn');
const ulistBtn = document.getElementById('ulist-btn');
const clearFormatBtn = document.getElementById('clear-format-btn');

let isLaptopMode = true;

// Custom undo/redo stack
const undoRedoStack = {
    history: [],
    currentIndex: -1,
    lastSnapshotText: '',
    maxHistory: 100,

    captureSnapshot(text) {
        // Only capture if text has actually changed and differs from last snapshot
        if (text === this.lastSnapshotText) return;
        
        // Remove any redo steps if user makes a new edit after undoing
        this.history = this.history.slice(0, this.currentIndex + 1);
        
        // Add new snapshot
        this.history.push(text);
        this.currentIndex = this.history.length - 1;
        this.lastSnapshotText = text;
        
        // Limit history size
        if (this.history.length > this.maxHistory) {
            this.history.shift();
            this.currentIndex--;
        }
    },

    undo() {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            return this.history[this.currentIndex];
        }
        return null;
    },

    redo() {
        if (this.currentIndex < this.history.length - 1) {
            this.currentIndex++;
            return this.history[this.currentIndex];
        }
        return null;
    },

    clear() {
        this.history = [];
        this.currentIndex = -1;
        this.lastSnapshotText = '';
    }
};

// Capture initial state
undoRedoStack.captureSnapshot(textLayer.innerHTML);

// Listen for text changes and capture snapshots on every character (letter by letter)
textLayer.addEventListener('input', (e) => {
    const currentText = textLayer.innerHTML;
    // Capture snapshot on every input event (every character typed)
    undoRedoStack.captureSnapshot(currentText);
});

// Also capture on blur to save final state
textLayer.addEventListener('blur', () => {
    undoRedoStack.captureSnapshot(textLayer.innerHTML);
});

function getSelectionBlockParent() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    while (node && node !== document.body) {
        const display = window.getComputedStyle(node).display;
        if (display === 'block' || /^(P|DIV|LI|BLOCKQUOTE|TD)$/.test(node.nodeName)) return node;
        node = node.parentNode;
    }
    return null;
}

function getBlockTextAlign() {
    const parent = getSelectionBlockParent();
    if (!parent) return 'left';
    return window.getComputedStyle(parent).textAlign || 'left';
}

function clearAlignmentActive() {
    [alignLeftBtn, alignCenterBtn, alignRightBtn, alignJustifyBtn].forEach(b => { if (b) b.classList.remove('active'); });
}

function applyAlignment(command) {
    // command: 'left'|'center'|'right'|'justify'
    const current = getBlockTextAlign();
    if ((command === 'center' && current === 'center') || (command === 'left' && current === 'left')) {
        document.execCommand('justifyLeft');
        clearAlignmentActive();
        if (alignLeftBtn) alignLeftBtn.classList.add('active');
        return;
    }
    if (command === 'left') document.execCommand('justifyLeft');
    else if (command === 'center') document.execCommand('justifyCenter');
    else if (command === 'right') document.execCommand('justifyRight');
    else if (command === 'justify') document.execCommand('justifyFull');

    clearAlignmentActive();
    if (command === 'left' && alignLeftBtn) alignLeftBtn.classList.add('active');
    if (command === 'center' && alignCenterBtn) alignCenterBtn.classList.add('active');
    if (command === 'right' && alignRightBtn) alignRightBtn.classList.add('active');
    if (command === 'justify' && alignJustifyBtn) alignJustifyBtn.classList.add('active');
}

function setMode(laptop) {
    isLaptopMode = laptop;
    if (isLaptopMode) {
        container.classList.remove('ipad-mode');
        if (typingToolbar) typingToolbar.style.display = 'flex';
        if (textLayer) { textLayer.contentEditable = true; textLayer.focus(); }
        if (toggleBtn) toggleBtn.innerText = '💻 Laptop Mode';
    } else {
        container.classList.add('ipad-mode');
        if (typingToolbar) typingToolbar.style.display = 'none';
        if (textLayer) textLayer.contentEditable = false;
        if (toggleBtn) toggleBtn.innerText = '📱 iPad Mode';
    }
    setTimeout(resizeAndRedrawCanvas, 150);
}

if (toggleBtn) toggleBtn.addEventListener('click', () => setMode(!isLaptopMode));
setMode(true);

// Typing toolbar actions
if (boldBtn) boldBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('bold'); textLayer.focus(); });
if (italicBtn) italicBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('italic'); textLayer.focus(); });
if (underlineBtn) underlineBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('underline'); textLayer.focus(); });
if (undoBtn) undoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const undoText = undoRedoStack.undo();
    if (undoText !== null) {
        textLayer.innerHTML = undoText;
        // Move cursor to end of text after undo
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(textLayer);
        range.collapse(false); // false = end of content
        sel.removeAllRanges();
        sel.addRange(range);
        textLayer.focus();
    }
});

if (redoBtn) redoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const redoText = undoRedoStack.redo();
    if (redoText !== null) {
        textLayer.innerHTML = redoText;
        // Move cursor to end of text after redo
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(textLayer);
        range.collapse(false); // false = end of content
        sel.removeAllRanges();
        sel.addRange(range);
        textLayer.focus();
    }
});
if (olistBtn) olistBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('insertOrderedList'); textLayer.focus(); });
if (ulistBtn) ulistBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('insertUnorderedList'); textLayer.focus(); });
if (clearFormatBtn) clearFormatBtn.addEventListener('click', (e) => { e.preventDefault(); document.execCommand('removeFormat'); textLayer.focus(); });
if (alignLeftBtn) alignLeftBtn.addEventListener('click', (e) => { e.preventDefault(); applyAlignment('left'); textLayer.focus(); });
if (alignCenterBtn) alignCenterBtn.addEventListener('click', (e) => { e.preventDefault(); applyAlignment('center'); textLayer.focus(); });
if (alignRightBtn) alignRightBtn.addEventListener('click', (e) => { e.preventDefault(); applyAlignment('right'); textLayer.focus(); });
if (alignJustifyBtn) alignJustifyBtn.addEventListener('click', (e) => { e.preventDefault(); applyAlignment('justify'); textLayer.focus(); });
if (fontSelect) fontSelect.addEventListener('change', (e) => { document.execCommand('fontName', false, e.target.value); textLayer.focus(); });
if (fontSizeSelect) fontSizeSelect.addEventListener('change', (e) => { document.execCommand('fontSize', false, e.target.value); textLayer.focus(); });
if (fontColor) fontColor.addEventListener('input', (e) => { document.execCommand('foreColor', false, e.target.value); textLayer.focus(); });

const zoomSlider = document.getElementById('zoom-slider');
const zoomDisplay = document.getElementById('zoom-display');

const paginationControls = document.getElementById('pagination-controls');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const addPageBtn = document.getElementById('add-page-btn');
const pageDisplay = document.getElementById('page-display');

let currentTool = 'pen'; 
let currentNotebookPath = null;
let currentZoom = 1.0;
let eraserMode = 'delete'; // 'delete' or 'white' 

let notebookPages = [ { strokes: [], text: "" } ];
let currentPageIndex = 0;
let allStrokes = []; 

brushSizeSlider.addEventListener('input', (e) => { brushSizeVal.innerText = e.target.value; });

function applyZoom() {
    scrollWrapper.style.transform = `scale(${currentZoom})`;
    if(zoomDisplay) zoomDisplay.innerText = `${Math.round(currentZoom * 100)}%`;
    if(zoomSlider) zoomSlider.value = Math.round(currentZoom * 100);
}

if(zoomSlider) {
    zoomSlider.addEventListener('input', (e) => { 
        currentZoom = parseInt(e.target.value, 10) / 100; 
        applyZoom(); 
    });
}

function saveCurrentPageToMemory() {
    notebookPages[currentPageIndex] = { strokes: [...allStrokes], text: textLayer.innerHTML };
}

// THE FIX: Added 'skipSave' so the app doesn't overwrite your JSON with a blank canvas
function loadPage(index, skipSave = false) {
    if (!skipSave) {
        saveCurrentPageToMemory(); 
    }
    
    currentPageIndex = index;
    allStrokes = notebookPages[currentPageIndex].strokes || [];
    textLayer.innerHTML = notebookPages[currentPageIndex].text || "";
    
    // Reset undo/redo stack when loading a new page
    undoRedoStack.clear();
    undoRedoStack.captureSnapshot(textLayer.innerHTML);
    
    if(pageDisplay) pageDisplay.innerText = `Page ${currentPageIndex + 1}/${notebookPages.length}`;
    resizeAndRedrawCanvas();
    triggerAutoSave();
}

if(prevPageBtn) prevPageBtn.addEventListener('click', () => {
    if (currentPageIndex > 0) {
        loadPage(currentPageIndex - 1);
        socket.emit('change-page', currentPageIndex);
    }
});

if(nextPageBtn) nextPageBtn.addEventListener('click', () => {
    if (currentPageIndex < notebookPages.length - 1) {
        loadPage(currentPageIndex + 1);
        socket.emit('change-page', currentPageIndex);
    }
});

if(addPageBtn) addPageBtn.addEventListener('click', () => {
    saveCurrentPageToMemory();
    notebookPages.push({ strokes: [], text: "" });
    loadPage(notebookPages.length - 1);
    socket.emit('add-page');
});

let autoSaveTimer = null;
function triggerAutoSave() {
    if (!isElectron || !currentNotebookPath) return; 
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        saveCurrentPageToMemory();
        const currentCanvasHeight = parseInt(window.getComputedStyle(scrollWrapper).minHeight) || 5000;
        const projectData = { 
            pages: notebookPages, 
            currentPageIndex: currentPageIndex, // Added this so it remembers what page you left off on
            settings: { theme: bgSelect.value, pageSize: sizeSelect.value, canvasHeight: currentCanvasHeight } 
        };
        await ipcRenderer.invoke('fs:saveJSON', currentNotebookPath, JSON.stringify(projectData, null, 2));
    }, 1500); 
}

const imageCache = {}; 
const imgPreview = document.createElement('img');
imgPreview.style.position = 'absolute'; imgPreview.style.pointerEvents = 'none'; imgPreview.style.opacity = '0.5'; imgPreview.style.display = 'none'; imgPreview.style.zIndex = '100';
scrollWrapper.appendChild(imgPreview);

let baseImgWidth = 0, baseImgHeight = 0, currentImageScale = 1, currentMouseX = 0, currentMouseY = 0;
let selectedItemIndex = -1, isTransforming = false, transformMode = null, dragOffsetX = 0, dragOffsetY = 0;

function deleteSelectedItem() {
    if (selectedItemIndex < 0 || !allStrokes[selectedItemIndex] || allStrokes[selectedItemIndex].type !== 'image') return;
    allStrokes.splice(selectedItemIndex, 1);
    selectedItemIndex = -1;
    isTransforming = false;
    transformMode = null;
    saveCurrentPageToMemory();
    resizeAndRedrawCanvas();
    socket.emit('update-active-page', notebookPages[currentPageIndex]);
    triggerAutoSave();
}

if(selectBtn) selectBtn.addEventListener('click', () => { currentTool = 'select'; selectBtn.classList.add('active'); penBtn.classList.remove('active'); eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; eraserModeBtn.style.display = 'none'; });
if(deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', deleteSelectedItem);
if(penBtn) penBtn.addEventListener('click', () => { currentTool = 'pen'; selectedItemIndex = -1; penBtn.classList.add('active'); selectBtn.classList.remove('active'); eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; eraserModeBtn.style.display = 'none'; resizeAndRedrawCanvas(); });
if(eraserBtn) eraserBtn.addEventListener('click', () => { currentTool = 'eraser'; selectedItemIndex = -1; eraserBtn.classList.add('active'); penBtn.classList.remove('active'); selectBtn.classList.remove('active'); imgPreview.style.display = 'none'; eraserModeBtn.style.display = 'inline-block'; resizeAndRedrawCanvas(); });
if(eraserModeBtn) eraserModeBtn.addEventListener('click', () => { eraserMode = eraserMode === 'delete' ? 'white' : 'delete'; eraserModeBtn.innerText = eraserMode === 'delete' ? 'Delete' : 'White'; eraserModeBtn.style.backgroundColor = eraserMode === 'delete' ? '#ffcdd2' : '#fff9c4'; });
if(colorPicker) colorPicker.addEventListener('input', () => penBtn.click());

document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && currentTool === 'select' && selectedItemIndex > -1 && document.activeElement !== textLayer) {
        e.preventDefault();
        deleteSelectedItem();
    }
});

window.addEventListener('paste', async (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile(); const reader = new FileReader();
            reader.onload = async (event) => {
                const img = new Image();
                img.onload = async () => {
                    const tmpCanvas = document.createElement('canvas'); const MAX_WIDTH = 600; let w = img.width, h = img.height;
                    if (w > MAX_WIDTH) { h = Math.round((h * MAX_WIDTH) / w); w = MAX_WIDTH; }
                    tmpCanvas.width = w; tmpCanvas.height = h; tmpCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    baseImgWidth = w; baseImgHeight = h; currentImageScale = 1;
                    const dataUrl = tmpCanvas.toDataURL('image/jpeg', 0.8);
                    // keep the data URL for broadcasting to remote (browser) clients
                    imgPreview.dataset.dataUrl = dataUrl;
                    let finalSrc = dataUrl;
                    // If running in Electron and a notebook folder is open, save the asset to disk
                    if (isElectron && currentNotebookPath && ipcRenderer) {
                        try {
                            const base64 = dataUrl.split(',')[1];
                            const fileName = `img-${Date.now()}.jpg`;
                            const savedFileUrl = await ipcRenderer.invoke('fs:saveAsset', currentNotebookPath, fileName, base64);
                            finalSrc = savedFileUrl;
                            imgPreview.dataset.assetTag = fileName;
                        } catch (err) {
                            console.error('Failed to save asset:', err);
                        }
                    }
                    imgPreview.src = finalSrc; imgPreview.width = baseImgWidth; imgPreview.height = baseImgHeight; imgPreview.style.display = 'block';
                    currentTool = 'image-placer'; penBtn.classList.remove('active'); eraserBtn.classList.remove('active'); selectBtn.classList.remove('active');
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(blob);
        }
    }
});

function applyPageSettings(theme, size, canvasHeight, projectName) {
    if (theme) { 
        bgSelect.value = theme; 
        if (theme === 'black') container.classList.add('theme-black'); 
        else container.classList.remove('theme-black'); 
    }
    
    if (size) { 
        sizeSelect.value = size; 
        if (size === 'a4') { 
            container.classList.add('size-a4'); 
            if(paginationControls) paginationControls.style.display = 'flex'; 
        } else { 
            container.classList.remove('size-a4'); 
            if(paginationControls) paginationControls.style.display = 'none'; 
            
            if (currentPageIndex !== 0) {
                loadPage(0, true);
                socket.emit('change-page', 0);
            }
        } 
    }
    
    if (canvasHeight && size !== 'a4') { scrollWrapper.style.minHeight = canvasHeight + 'px'; }
    if (projectName) { projectNameDisplay.innerText = projectName; } 
    
    setTimeout(resizeAndRedrawCanvas, 350); 
    triggerAutoSave(); 
}

sizeSelect.addEventListener('change', (e) => { applyPageSettings(null, e.target.value, null, null); socket.emit('update-page-settings', { pageSize: e.target.value }); });
bgSelect.addEventListener('change', (e) => { applyPageSettings(e.target.value, null, null, null); socket.emit('update-page-settings', { theme: e.target.value }); });

let isIpadMode = false;
toggleBtn.addEventListener('click', () => {
    isIpadMode = !isIpadMode;
    if (isIpadMode) { container.classList.add('ipad-mode'); toggleBtn.innerText = "✏️ iPad Mode"; toggleBtn.style.backgroundColor = "#e3f2fd"; toggleBtn.style.color = "#0d47a1"; } 
    else { container.classList.remove('ipad-mode'); toggleBtn.innerText = "💻 Laptop Mode"; toggleBtn.style.backgroundColor = "white"; toggleBtn.style.color = "black"; }
    resizeAndRedrawCanvas(); 
});

clearBtn.addEventListener('click', () => { 
    if (confirm("Clear all ink on this page?")) { 
        allStrokes = []; textLayer.innerHTML = ""; selectedItemIndex = -1; 
        undoRedoStack.clear();
        undoRedoStack.captureSnapshot("");
        resizeAndRedrawCanvas(); 
        saveCurrentPageToMemory();
        socket.emit('update-active-page', notebookPages[currentPageIndex]); 
        triggerAutoSave(); 
    } 
});

if (isElectron) {
    ipcRenderer.on('menu-action', (event, payload) => {
        if (payload.action === 'new') {
            currentNotebookPath = payload.path;
            const pName = `📁 ${currentNotebookPath.split(/[\\/]/).pop()}`;
            projectNameDisplay.innerText = pName;
            notebookPages = [ { strokes: [], text: "" } ];
            currentPageIndex = 0;
            allStrokes = []; textLayer.innerHTML = "";
            undoRedoStack.clear();
            undoRedoStack.captureSnapshot("");
            applyPageSettings('white', 'infinite', 5000, pName);
            socket.emit('update-page-settings', { projectName: pName }); 
        } 
        else if (payload.action === 'open') {
            const data = JSON.parse(payload.data);
            const pName = `📁 ${payload.folderPath.split(/[\\/]/).pop()}`;
            
            // THE FIX: Safely reads old JSON files
            if (data.strokes && !data.pages) {
                notebookPages = [ { strokes: data.strokes, text: data.text || "" } ];
            } else if (data.pages) {
                notebookPages = data.pages;
            }

            const safeSettings = data.settings || {};
            applyPageSettings(safeSettings.theme || 'white', safeSettings.pageSize || 'infinite', safeSettings.canvasHeight || 5000, pName);
            
            // THE FIX: Passes 'true' so the canvas doesn't save a blank screen!
            loadPage(data.currentPageIndex || 0, true);
            
            socket.emit('load-full-state', { pages: notebookPages, currentPageIndex: currentPageIndex, settings: { ...safeSettings, projectName: pName } });
            currentNotebookPath = payload.folderPath;
        }
    });
    socket.on('trigger-remote-export', () => { if (currentNotebookPath) exportBtn.click(); });
}

exportBtn.addEventListener('click', async () => {
    if (!isElectron) {
        socket.emit('trigger-remote-export');
        exportBtn.innerText = "⏳ Laptop Exporting...";
        setTimeout(() => { exportBtn.innerText = "🖨️ Export PDF"; }, 2500);
        return;
    }
    if (!currentNotebookPath) return alert("Use 'File > New Notebook Folder' on your laptop first!");
    if (!jsPDF) return alert("PDF Engine failed to load, check internet connection.");
    
    exportBtn.innerText = "⏳ Exporting..."; 
    saveCurrentPageToMemory();
    
    const pdf = new jsPDF('p', 'pt', 'a4'); 
    const pdfWidth = pdf.internal.pageSize.getWidth(); 
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const originalIndex = currentPageIndex;

    const pagesToExport = sizeSelect.value === 'a4' ? notebookPages.length : 1;

    for (let p = 0; p < pagesToExport; p++) {
        currentPageIndex = p;
        allStrokes = notebookPages[p].strokes || [];
        textLayer.innerHTML = notebookPages[p].text || '';
        resizeAndRedrawCanvas();

        let maxContentY = 0;
        allStrokes.forEach(stroke => {
            if (stroke.type === 'image') maxContentY = Math.max(maxContentY, stroke.y + stroke.h);
            else if (stroke.path) stroke.path.forEach(pt => maxContentY = Math.max(maxContentY, pt.y));
        });
        if (maxContentY === 0) maxContentY = 1123; maxContentY += 100;

        const tempCanvas = document.createElement('canvas'); 
        tempCanvas.width = canvas.width; 
        tempCanvas.height = sizeSelect.value === 'a4' ? canvas.height : maxContentY;
        const tCtx = tempCanvas.getContext('2d'); 
        
        tCtx.fillStyle = bgSelect.value === 'black' ? '#121212' : '#ffffff'; 
        tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height); 
        tCtx.drawImage(canvas, 0, 0); 
        
        const imgData = tempCanvas.toDataURL('image/jpeg', 1.0);
        const ratio = pdfWidth / tempCanvas.width; 
        const scaledHeight = tempCanvas.height * ratio;

        let heightLeft = scaledHeight; let position = 0;
        
        if (p > 0) pdf.addPage(); 
        pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight); 
        heightLeft -= pdfHeight;
        
        while (heightLeft >= 0) { 
            position = heightLeft - scaledHeight; 
            pdf.addPage(); 
            pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight); 
            heightLeft -= pdfHeight; 
        }
    }

    loadPage(originalIndex, true);

    const arrayBuffer = pdf.output('arraybuffer');
    await ipcRenderer.invoke('fs:savePDF', currentNotebookPath, arrayBuffer);
    exportBtn.innerText = "🖨️ Export PDF"; 
    alert(`PDF Exported Successfully! (${pagesToExport} pages)`);
});

const shareBtn = document.getElementById('share-btn'); const qrModal = document.getElementById('qr-modal'); const closeModalBtn = document.getElementById('close-modal-btn'); const copyUrlBtn = document.getElementById('copy-url-btn'); const urlInput = document.getElementById('local-url-input'); const qrContainer = document.getElementById('qrcode');
function getLocalIPAddress() { return isElectron ? window.require('os').networkInterfaces()[Object.keys(window.require('os').networkInterfaces())[0]][1].address : window.location.hostname; }

if(shareBtn) shareBtn.addEventListener('click', () => { 
    if (!isElectron) return alert("You are already on the browser!");
    const connectionUrl = `http://${getLocalIPAddress()}:3000`; urlInput.value = connectionUrl; 
    qrContainer.innerHTML = ''; new QRCode(qrContainer, { text: connectionUrl, width: 200, height: 200 }); qrModal.classList.remove('hidden'); 
});
if(closeModalBtn) closeModalBtn.addEventListener('click', () => qrModal.classList.add('hidden'));

socket.on('load-full-state', (state) => {
    notebookPages = state.pages;
    applyPageSettings(state.settings.theme, state.settings.pageSize, state.settings.canvasHeight, state.settings.projectName);
    loadPage(state.currentPageIndex, true);
});
socket.on('receive-page-settings', (settings) => { applyPageSettings(settings.theme, settings.pageSize, settings.canvasHeight, settings.projectName); });
socket.on('remote-page-changed', (index) => { loadPage(index, true); });
socket.on('remote-page-added', (state) => { notebookPages = state.pages; loadPage(state.currentPageIndex, true); });
socket.on('receive-active-page', (pageData) => { allStrokes = pageData.strokes; textLayer.innerHTML = pageData.text; resizeAndRedrawCanvas(); triggerAutoSave(); });
socket.on('receive-stroke-batch', (batch) => { allStrokes.push(...batch); resizeAndRedrawCanvas(); triggerAutoSave(); });

let typingTimer;
textLayer.addEventListener('input', () => { 
    resizeAndRedrawCanvas(); 
    clearTimeout(typingTimer); 
    typingTimer = setTimeout(() => {
        saveCurrentPageToMemory();
        socket.emit('update-active-page', notebookPages[currentPageIndex]);
    }, 500); 
    triggerAutoSave(); 
});

let remoteX = 0, remoteY = 0;
socket.on('remote-start-stream', (data) => { remoteX = data.x; remoteY = data.y; });
socket.on('remote-stream-point', (data) => {
    if (data.isEraser && data.eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = data.color; }
    ctx.lineWidth = data.size || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(remoteX, remoteY); ctx.lineTo(data.x, data.y); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over'; remoteX = data.x; remoteY = data.y;
});

function resizeAndRedrawCanvas() {
    canvas.width = scrollWrapper.clientWidth; canvas.height = scrollWrapper.scrollHeight; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    allStrokes.forEach((strokeData) => {
        if (!strokeData) return;
        if (strokeData.type === 'image') {
            const keySrc = strokeData.src;
            if (imageCache[keySrc]) { ctx.globalCompositeOperation = 'destination-over'; ctx.drawImage(imageCache[keySrc], strokeData.x, strokeData.y, strokeData.w, strokeData.h); ctx.globalCompositeOperation = 'source-over'; } 
            else { const img = new Image(); img.onload = () => { imageCache[keySrc] = img; resizeAndRedrawCanvas(); }; img.src = keySrc; }
            return; 
        }
        if (!strokeData.path || strokeData.path.length === 0) return;
        if (strokeData.isEraser && strokeData.eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = strokeData.color; }
        ctx.lineWidth = strokeData.size || 3;
        ctx.beginPath(); ctx.moveTo(strokeData.path[0].x, strokeData.path[0].y);
        for (let i = 1; i < strokeData.path.length; i++) ctx.lineTo(strokeData.path[i].x, strokeData.path[i].y);
        ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over'; 
    if (selectedItemIndex > -1 && allStrokes[selectedItemIndex] && allStrokes[selectedItemIndex].type === 'image') {
        const img = allStrokes[selectedItemIndex];
        ctx.strokeStyle = '#2196f3'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]); ctx.strokeRect(img.x, img.y, img.w, img.h); ctx.setLineDash([]); 
        ctx.fillStyle = 'white'; const handleSize = 12; const drawHandle = (x, y) => { ctx.fillRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize); ctx.strokeRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize); };
        drawHandle(img.x, img.y); drawHandle(img.x + img.w, img.y); drawHandle(img.x, img.y + img.h); drawHandle(img.x + img.w, img.y + img.h); 
    }
}
window.addEventListener('resize', resizeAndRedrawCanvas);

let isDrawing = false, lastX = 0, lastY = 0, currentStroke = {};
function getCoordinates(e) { const rect = canvas.getBoundingClientRect(); return { x: (e.clientX - rect.left) / currentZoom, y: (e.clientY - rect.top) / currentZoom }; }

document.addEventListener('contextmenu', (e) => { if (isIpadMode) e.preventDefault(); });
canvas.addEventListener('touchstart', (e) => { if (isIpadMode) e.preventDefault(); }, { passive: false });

canvas.addEventListener('pointermove', (e) => {
    if (isIpadMode && e.pointerType === 'touch') return;
    const coords = getCoordinates(e); currentMouseX = coords.x; currentMouseY = coords.y;
    if (currentTool === 'image-placer' && imgPreview.style.display === 'block') { imgPreview.style.left = (coords.x - imgPreview.width / 2) + 'px'; imgPreview.style.top = (coords.y - imgPreview.height / 2) + 'px'; return; }
    if (currentTool === 'select' && isTransforming) {
        const img = allStrokes[selectedItemIndex];
        if (transformMode === 'drag') { img.x = coords.x - dragOffsetX; img.y = coords.y - dragOffsetY; } 
        else if (transformMode === 'resize-se') { img.w = coords.x - img.x; img.h = coords.y - img.y; } 
        else if (transformMode === 'resize-sw') { img.w = (img.x + img.w) - coords.x; img.x = coords.x; img.h = coords.y - img.y; } 
        else if (transformMode === 'resize-ne') { img.w = coords.x - img.x; img.h = (img.y + img.h) - coords.y; img.y = coords.y; } 
        else if (transformMode === 'resize-nw') { img.w = (img.x + img.w) - coords.x; img.h = (img.y + img.h) - coords.y; img.x = coords.x; img.y = coords.y; }
        if (img.w < 20) img.w = 20; if (img.h < 20) img.h = 20; resizeAndRedrawCanvas(); 
    }
});

canvas.addEventListener('pointerdown', (e) => {
    if (isIpadMode) e.preventDefault(); 
    if ((isIpadMode && e.pointerType === 'touch') || (!isIpadMode && e.pointerType === 'touch')) return;
    
    const coords = getCoordinates(e);
    if (currentTool === 'image-placer') {
        const newImg = {
            type: 'image',
            // keep a single URL field in the saved stroke object
            src: imgPreview.src || imgPreview.dataset.dataUrl,
            x: coords.x - imgPreview.width / 2,
            y: coords.y - imgPreview.height / 2,
            w: imgPreview.width,
            h: imgPreview.height,
            tag: imgPreview.dataset.assetTag || null
        };
        allStrokes.push(newImg); saveCurrentPageToMemory(); socket.emit('update-active-page', notebookPages[currentPageIndex]); imgPreview.style.display = 'none'; penBtn.click(); resizeAndRedrawCanvas(); triggerAutoSave(); return; 
    }

    if (currentTool === 'select') {
        if (selectedItemIndex > -1) {
            const img = allStrokes[selectedItemIndex]; const hit = (hx, hy) => coords.x > hx - 15 && coords.x < hx + 15 && coords.y > hy - 15 && coords.y < hy + 15;
            if (hit(img.x, img.y)) { transformMode = 'resize-nw'; isTransforming = true; return; } if (hit(img.x + img.w, img.y)) { transformMode = 'resize-ne'; isTransforming = true; return; }
            if (hit(img.x, img.y + img.h)) { transformMode = 'resize-sw'; isTransforming = true; return; } if (hit(img.x + img.w, img.y + img.h)) { transformMode = 'resize-se'; isTransforming = true; return; }
            if (coords.x >= img.x && coords.x <= img.x + img.w && coords.y >= img.y && coords.y <= img.y + img.h) { transformMode = 'drag'; isTransforming = true; dragOffsetX = coords.x - img.x; dragOffsetY = coords.y - img.y; return; }
        }
        selectedItemIndex = -1; 
        for (let i = allStrokes.length - 1; i >= 0; i--) { 
            const item = allStrokes[i];
            if (item.type === 'image' && coords.x >= item.x && coords.x <= item.x + item.w && coords.y >= item.y && coords.y <= item.y + item.h) {
                selectedItemIndex = i; transformMode = 'drag'; isTransforming = true; dragOffsetX = coords.x - item.x; dragOffsetY = coords.y - item.y; break;
            }
        }
        resizeAndRedrawCanvas(); return;
    }
    
    isDrawing = true; lastX = coords.x; lastY = coords.y; const activeColor = colorPicker.value; const isEraser = (currentTool === 'eraser'); const activeSize = parseInt(brushSizeSlider.value, 10);
    const eraserColor = eraserMode === 'white' ? '#ffffff' : activeColor;
    currentStroke = { type: 'stroke', color: eraserColor, isEraser: isEraser, eraserMode: isEraser ? eraserMode : null, size: activeSize, path: [{ x: lastX, y: lastY }] };
    socket.emit('start-stream', { color: eraserColor, isEraser: isEraser, size: activeSize, x: lastX, y: lastY });
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || (e.pointerType === 'touch') || currentTool === 'image-placer' || currentTool === 'select') return;
    const coords = getCoordinates(e);
    if (currentStroke.isEraser && eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = currentStroke.color; }
    ctx.lineWidth = currentStroke.size; ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(coords.x, coords.y); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; 
    currentStroke.path.push({ x: coords.x, y: coords.y }); socket.emit('stream-point', { color: currentStroke.color, isEraser: currentStroke.isEraser, eraserMode: currentStroke.eraserMode, size: currentStroke.size, x: coords.x, y: coords.y }); lastX = coords.x; lastY = coords.y;
});

function isPointNearPath(point, path, threshold) {
    for (let i = 0; i < path.length; i++) {
        const dx = point.x - path[i].x;
        const dy = point.y - path[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < threshold) return true;
    }
    return false;
}

let strokeBatch = []; let batchSendTimer = null;   
function handlePointerUpOut(e) {
    if (currentTool === 'select' && isTransforming) { isTransforming = false; transformMode = null; saveCurrentPageToMemory(); socket.emit('update-active-page', notebookPages[currentPageIndex]); triggerAutoSave(); return; }
    if (!isDrawing || e.pointerType === 'touch') return;
    isDrawing = false;
    if (currentStroke.path && currentStroke.path.length > 0) {
        if (currentStroke.isEraser && eraserMode === 'delete') {
            const eraserRadius = (currentStroke.size || 3) * 1.5;
            allStrokes = allStrokes.filter(stroke => {
                if (stroke.type === 'image') return true;
                if (!stroke.path) return true;
                return !stroke.path.some(pt => isPointNearPath(pt, currentStroke.path, eraserRadius));
            });
            resizeAndRedrawCanvas();
            saveCurrentPageToMemory();
            socket.emit('update-active-page', notebookPages[currentPageIndex]);
        } else {
            allStrokes.push(currentStroke); strokeBatch.push(currentStroke);
        }
        currentStroke = {}; triggerAutoSave(); 
        clearTimeout(batchSendTimer); batchSendTimer = setTimeout(() => { if (strokeBatch.length > 0) { socket.emit('add-stroke-batch', strokeBatch); strokeBatch = []; } }, 100); 
    }
}
canvas.addEventListener('pointerup', handlePointerUpOut); canvas.addEventListener('pointerout', handlePointerUpOut);

container.addEventListener('scroll', () => {
    if (sizeSelect.value !== 'a4' && container.scrollTop + container.clientHeight >= scrollWrapper.scrollHeight - 500) {
        const currentHeight = parseInt(window.getComputedStyle(scrollWrapper).minHeight);
        const newHeight = currentHeight + 2000;
        scrollWrapper.style.minHeight = newHeight + 'px'; 
        resizeAndRedrawCanvas(); socket.emit('update-page-settings', { canvasHeight: newHeight }); triggerAutoSave(); 
    }
});