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

const zoomSlider = document.getElementById('zoom-slider');
const zoomDisplay = document.getElementById('zoom-display');

const paginationControls = document.getElementById('pagination-controls');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const addPageBtn = document.getElementById('add-page-btn');
const pageDisplay = document.getElementById('page-display');

let currentTool = 'pen'; 
let currentNotebookPath = null;
let currentProjectFolder = ''; // Store project folder basename from server
let currentZoom = 1.0;
let eraserMode = 'delete'; // 'delete' or 'white' 

let notebookPages = [ { strokes: [], text: "" } ];
let currentPageIndex = 0;
let allStrokes = []; 

function generateStrokeId() {
    return `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureStrokeId(stroke) {
    if (!stroke) return stroke;
    if (!stroke.id) stroke.id = generateStrokeId();
    return stroke;
}

function ensurePageStrokeIds(page) {
    if (!page || !Array.isArray(page.strokes)) return page;
    page.strokes.forEach(ensureStrokeId);
    return page;
}

function ensureNotebookStrokeIds(pages) {
    if (!Array.isArray(pages)) return pages;
    pages.forEach(ensurePageStrokeIds);
    return pages;
}

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

// THE FIX: Added 'skipSave' so the app doesn't overwrite your notebook with a blank canvas
function loadPage(index, skipSave = false) {
    if (!skipSave) {
        saveCurrentPageToMemory(); 
    }
    
    currentPageIndex = index;
    ensureNotebookStrokeIds(notebookPages);
    allStrokes = notebookPages[currentPageIndex].strokes || [];
    setTextLayerContent(textLayer, notebookPages[currentPageIndex].text || "");
    
    if(pageDisplay) pageDisplay.innerText = `Page ${currentPageIndex + 1}/${notebookPages.length}`;
    resizeAndRedrawCanvas();
    triggerAutoSave();
}

function escapeHtml(text) {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractTextForStorage(layer) {
    const blockTags = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    let output = '';

    function appendNewline() {
        if (!output.endsWith('\n')) output += '\n';
    }

    function walk(node) {
        if (!node) return;

        if (node.nodeType === Node.TEXT_NODE) {
            output += node.nodeValue || '';
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;

        if (node.tagName === 'BR') {
            appendNewline();
            return;
        }

        let child = node.firstChild;
        while (child) {
            walk(child);
            child = child.nextSibling;
        }

        if (blockTags.has(node.tagName)) {
            appendNewline();
        }
    }

    walk(layer);

    return output.replace(/\u00a0/g, ' ');
}

function extractExportTextFromLayer(layer) {
    const temp = document.createElement('div');
    temp.innerHTML = layer.innerHTML || '';

    const blockTags = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

    function collectInlineText(node) {
        if (!node) return '';

        if (node.nodeType === Node.TEXT_NODE) {
            return node.nodeValue || '';
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        if (node.tagName === 'BR') {
            return '\n';
        }

        let output = '';
        let child = node.firstChild;
        while (child) {
            output += collectInlineText(child);
            child = child.nextSibling;
        }
        return output;
    }

    const lines = [];
    let sawBlock = false;

    let child = temp.firstChild;
    while (child) {
        if (child.nodeType === Node.TEXT_NODE) {
            const text = (child.nodeValue || '').replace(/\u00a0/g, ' ').replace(/\r/g, '');
            if (text.trim() !== '') {
                lines.push(text.replace(/[\t ]+/g, ' ').trim());
                sawBlock = true;
            }
        } else if (child.nodeType === Node.ELEMENT_NODE && blockTags.has(child.tagName)) {
            const rawLine = collectInlineText(child)
                .replace(/\u00a0/g, ' ')
                .replace(/\r/g, '');

            // A blank block such as <div><br></div> should contribute exactly one empty line.
            const normalizedLine = rawLine
                .replace(/\n+/g, '\n')
                .replace(/[\t ]+/g, ' ')
                .trim();

            lines.push(normalizedLine);
            sawBlock = true;
        } else if (child.nodeType === Node.ELEMENT_NODE && child.tagName === 'BR') {
            if (sawBlock) lines.push('');
        }

        child = child.nextSibling;
    }

    return lines.join('\n');
}

function normalizeWhitespaceForExport(rawText) {
    // Preserve blank lines, but collapse multiple spaces/tabs into one per line
    if (!rawText) return '';
    const lines = rawText.split('\n');
    const normalized = lines.map(line => {
        // replace tabs with spaces, collapse runs of spaces, and trim ends (HTML collapses whitespace)
        return line.replace(/\t/g, ' ').replace(/ {2,}/g, ' ').replace(/^\s+|\s+$/g, '');
    });
    return normalized.join('\n');
}

function setTextLayerContent(layer, value) {
    const text = String(value || '');
    if (!text) {
        layer.innerHTML = '';
        return;
    }

    const looksLikeLegacyHtml = /<\/?[a-z][\s\S]*>/i.test(text) || /&nbsp;|&lt;|&gt;|&amp;/.test(text);
    if (looksLikeLegacyHtml) {
        layer.innerHTML = text;
        return;
    }

    layer.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
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
        await ipcRenderer.invoke('fs:saveSBN', currentNotebookPath, JSON.stringify(projectData, null, 2));
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
                    const tmpCanvas = document.createElement('canvas');
                    const w = img.width;
                    const h = img.height;
                    tmpCanvas.width = w; tmpCanvas.height = h; tmpCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    baseImgWidth = w; baseImgHeight = h; currentImageScale = 1;
                    const dataUrl = tmpCanvas.toDataURL('image/png');
                    // keep the data URL for broadcasting to remote (browser) clients
                    imgPreview.dataset.dataUrl = dataUrl;
                    let finalSrc = dataUrl;
                    let assetTag = null;
                    // If running in Electron and a notebook folder is open, save the asset to disk
                    if (isElectron && currentNotebookPath && ipcRenderer) {
                        try {
                            const base64 = dataUrl.split(',')[1];
                            const fileName = `img-${Date.now()}.png`;
                            const savedFileUrl = await ipcRenderer.invoke('fs:saveAsset', currentNotebookPath, fileName, base64);
                            finalSrc = savedFileUrl;
                            assetTag = fileName;
                            imgPreview.dataset.assetTag = fileName;
                        } catch (err) {
                            console.error('Failed to save asset:', err);
                        }
                    }
                    // If browser client (not Electron), upload to server endpoint
                    else if (!isElectron && currentProjectFolder) {
                        console.log('Browser uploading image. Project folder:', currentProjectFolder);
                        try {
                            const fileName = `img-${Date.now()}.png`;
                            const response = await fetch('/upload-asset', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    project: currentProjectFolder, // Use the project folder basename from server
                                    fileName: fileName,
                                    base64Data: dataUrl
                                })
                            });
                            const data = await response.json();
                            console.log('Upload response:', data);
                            if (data.success && data.url) {
                                finalSrc = data.url;
                                assetTag = fileName;
                                imgPreview.dataset.assetTag = fileName;
                            }
                        } catch (err) {
                            console.error('Failed to upload asset:', err);
                        }
                    } else if (!isElectron) {
                        console.log('Browser mode but no project folder set. currentProjectFolder:', currentProjectFolder);
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
        allStrokes = []; textLayer.innerHTML = ""; selectedItemIndex = -1; resizeAndRedrawCanvas(); 
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
            applyPageSettings('white', 'infinite', 5000, pName);
            socket.emit('update-page-settings', { projectName: pName }); 
        } 
        else if (payload.action === 'open') {
            const data = JSON.parse(payload.data);
            const pName = `📁 ${payload.folderPath.split(/[\\/]/).pop()}`;
            
            if (data.pages) {
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

function buildWrappedLines(ctx, text, maxWidth) {
    const lines = [];
    const paragraphs = String(text || '').replace(/\r/g, '').split('\n');

    function splitTokenByWidth(token) {
        if (!token) return [''];
        if (ctx.measureText(token).width <= maxWidth) return [token];

        const chunks = [];
        let chunk = '';
        for (const ch of token) {
            const candidate = chunk + ch;
            if (chunk && ctx.measureText(candidate).width > maxWidth) {
                chunks.push(chunk);
                chunk = ch;
            } else {
                chunk = candidate;
            }
        }
        if (chunk) chunks.push(chunk);
        return chunks;
    }

    paragraphs.forEach((paragraph) => {
        if (paragraph.length === 0) {
            lines.push('');
            return;
        }

        const tokens = paragraph.match(/(\s+|\S+)/g) || [''];
        if (tokens.length === 0) {
            lines.push('');
            return;
        }

        let currentLine = '';
        for (const token of tokens) {
            const candidate = currentLine + token;
            if (ctx.measureText(candidate).width <= maxWidth) {
                currentLine = candidate;
            } else if (currentLine) {
                lines.push(currentLine);
                const chunks = splitTokenByWidth(token);
                if (chunks.length > 1) {
                    for (let i = 0; i < chunks.length - 1; i++) {
                        lines.push(chunks[i]);
                    }
                }
                currentLine = chunks[chunks.length - 1] || '';
            } else {
                const chunks = splitTokenByWidth(token);
                if (chunks.length > 1) {
                    for (let i = 0; i < chunks.length - 1; i++) {
                        lines.push(chunks[i]);
                    }
                }
                currentLine = chunks[chunks.length - 1] || '';
            }
        }
        lines.push(currentLine);
    });

    return lines;
}

function getRenderedTextBottom(ctx, text, canvasWidth, options) {
    const { padding, lineHeightPx } = options;
    const maxTextWidth = Math.max(1, canvasWidth - (padding * 2));
    const lines = buildWrappedLines(ctx, text, maxTextWidth);
    return padding + (lines.length * lineHeightPx);
}

function drawTextForExport(ctx, text, canvasWidth, options) {
    const { padding, lineHeightPx, fillStyle, font } = options;
    const maxTextWidth = Math.max(1, canvasWidth - (padding * 2));
    const lines = buildWrappedLines(ctx, text, maxTextWidth);

    ctx.save();
    ctx.font = font;
    ctx.fillStyle = fillStyle;
    ctx.textBaseline = 'top';

    let y = padding;
    lines.forEach((line) => {
        if (line) {
            ctx.fillText(line, padding, y);
        }
        y += lineHeightPx;
    });

    ctx.restore();
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
    
    const isA4Mode = sizeSelect.value === 'a4';
    const pdf = isA4Mode
        ? new jsPDF('p', 'pt', 'a4')
        : new jsPDF({ orientation: 'landscape', unit: 'pt', format: [1123.2, 794.16] });
    const pdfWidth = pdf.internal.pageSize.getWidth(); 
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const originalIndex = currentPageIndex;

    const pagesToExport = isA4Mode ? notebookPages.length : 1;

    for (let p = 0; p < pagesToExport; p++) {
        currentPageIndex = p;
        allStrokes = notebookPages[p].strokes || [];
        setTextLayerContent(textLayer, notebookPages[p].text || '');
        resizeAndRedrawCanvas();

        const pagePlainText = normalizeWhitespaceForExport(extractExportTextFromLayer(textLayer));
        const textStyle = window.getComputedStyle(textLayer);
        const textPadding = parseFloat(textStyle.paddingTop) || 40;
        const textFontSize = parseFloat(textStyle.fontSize) || 18;
        const textLineHeight = parseFloat(textStyle.lineHeight) || (textFontSize * 1.6);
        const textFontFamily = textStyle.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const exportFont = `${textFontSize}px ${textFontFamily}`;

        let maxContentY = 0;
        allStrokes.forEach(stroke => {
            if (stroke.type === 'image') maxContentY = Math.max(maxContentY, stroke.y + stroke.h);
            else if (stroke.path) stroke.path.forEach(pt => maxContentY = Math.max(maxContentY, pt.y));
        });
        const measureCanvas = document.createElement('canvas');
        const measureCtx = measureCanvas.getContext('2d');
        measureCtx.font = exportFont;
        maxContentY = Math.max(maxContentY, getRenderedTextBottom(measureCtx, pagePlainText, canvas.width, {
            padding: textPadding,
            lineHeightPx: textLineHeight,
        }));
        if (maxContentY === 0) maxContentY = isA4Mode ? 1123 : 1059;
        maxContentY += 100;

        const tempCanvas = document.createElement('canvas'); 
        tempCanvas.width = canvas.width; 
        tempCanvas.height = isA4Mode ? canvas.height : maxContentY;
        const tCtx = tempCanvas.getContext('2d'); 
        
        tCtx.fillStyle = bgSelect.value === 'black' ? '#121212' : '#ffffff'; 
        tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height); 
        drawTextForExport(tCtx, pagePlainText, tempCanvas.width, {
            padding: textPadding,
            lineHeightPx: textLineHeight,
            fillStyle: bgSelect.value === 'black' ? '#e0e0e0' : '#000000',
            font: exportFont,
        });
        tCtx.drawImage(canvas, 0, 0); 
        
        const imgData = tempCanvas.toDataURL('image/jpeg', 1.0);
        const ratio = pdfWidth / tempCanvas.width; 
        const scaledHeight = tempCanvas.height * ratio;

        let heightLeft = scaledHeight; let position = 0;
        
        if (p > 0) pdf.addPage(); 
        pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight); 
        heightLeft -= pdfHeight;
        
        while (heightLeft > 0.5) { 
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
    notebookPages = ensureNotebookStrokeIds(state.pages || []);
    applyPageSettings(state.settings.theme, state.settings.pageSize, state.settings.canvasHeight, state.settings.projectName);
    loadPage(state.currentPageIndex, true);
});
socket.on('set-project-folder', (folderName) => {
    console.log('Browser received project folder:', folderName);
    currentProjectFolder = folderName; // Store project folder for browser uploads
});
socket.on('receive-page-settings', (settings) => { applyPageSettings(settings.theme, settings.pageSize, settings.canvasHeight, settings.projectName); });
socket.on('remote-page-changed', (index) => { loadPage(index, true); });
socket.on('remote-page-added', (state) => { notebookPages = ensureNotebookStrokeIds(state.pages || []); loadPage(state.currentPageIndex, true); });
socket.on('receive-active-page', (pageData) => {
    const activePage = ensurePageStrokeIds(pageData || { strokes: [], text: '' });
    allStrokes = activePage.strokes || [];
    setTextLayerContent(textLayer, activePage.text || '');
    resizeAndRedrawCanvas();
    triggerAutoSave();
});
socket.on('receive-stroke-batch', (batch) => {
    const batchWithIds = (batch || []).map(ensureStrokeId);
    allStrokes.push(...batchWithIds);
    if (notebookPages[currentPageIndex]) notebookPages[currentPageIndex].strokes = allStrokes;
    resizeAndRedrawCanvas();
    triggerAutoSave();
});
socket.on('receive-stroke-deletion', ({ pageIndex, strokeIds }) => {
    if (!Array.isArray(strokeIds) || strokeIds.length === 0) return;
    const targetPage = notebookPages[pageIndex];
    if (targetPage && Array.isArray(targetPage.strokes)) {
        targetPage.strokes = targetPage.strokes.filter((stroke) => !strokeIds.includes(stroke.id));
    }
    if (pageIndex === currentPageIndex) {
        allStrokes = allStrokes.filter((stroke) => !strokeIds.includes(stroke.id));
        resizeAndRedrawCanvas();
        triggerAutoSave();
    }
});

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
            id: generateStrokeId(),
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
    currentStroke = { id: generateStrokeId(), type: 'stroke', color: eraserColor, isEraser: isEraser, eraserMode: isEraser ? eraserMode : null, size: activeSize, path: [{ x: lastX, y: lastY }] };
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

function distanceToSegment(point, start, end) {
    const segmentLengthSquared = ((end.x - start.x) ** 2) + ((end.y - start.y) ** 2);
    if (segmentLengthSquared === 0) {
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        return Math.sqrt((dx * dx) + (dy * dy));
    }

    const rawT = (((point.x - start.x) * (end.x - start.x)) + ((point.y - start.y) * (end.y - start.y))) / segmentLengthSquared;
    const t = Math.max(0, Math.min(1, rawT));
    const closestX = start.x + (t * (end.x - start.x));
    const closestY = start.y + (t * (end.y - start.y));
    const dx = point.x - closestX;
    const dy = point.y - closestY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isStrokeHitByEraser(strokePath, eraserPath, threshold) {
    if (!Array.isArray(strokePath) || strokePath.length === 0 || !Array.isArray(eraserPath) || eraserPath.length === 0) {
        return false;
    }

    if (strokePath.length === 1) {
        return eraserPath.some((pt) => distanceToSegment(pt, strokePath[0], strokePath[0]) <= threshold);
    }

    for (let i = 0; i < strokePath.length - 1; i += 1) {
        const strokeStart = strokePath[i];
        const strokeEnd = strokePath[i + 1];
        for (let j = 0; j < eraserPath.length - 1; j += 1) {
            const eraserStart = eraserPath[j];
            const eraserEnd = eraserPath[j + 1];
            if (distanceToSegment(eraserStart, strokeStart, strokeEnd) <= threshold) return true;
            if (distanceToSegment(eraserEnd, strokeStart, strokeEnd) <= threshold) return true;
            if (distanceToSegment(strokeStart, eraserStart, eraserEnd) <= threshold) return true;
            if (distanceToSegment(strokeEnd, eraserStart, eraserEnd) <= threshold) return true;
        }
    }

    return strokePath.some((strokePoint) => eraserPath.some((eraserPoint) => distanceToSegment(eraserPoint, strokePoint, strokePoint) <= threshold));
}

let strokeBatch = []; let batchSendTimer = null;   
function handlePointerUpOut(e) {
    if (currentTool === 'select' && isTransforming) { isTransforming = false; transformMode = null; saveCurrentPageToMemory(); socket.emit('update-active-page', notebookPages[currentPageIndex]); triggerAutoSave(); return; }
    if (!isDrawing || e.pointerType === 'touch') return;
    isDrawing = false;
    if (currentStroke.path && currentStroke.path.length > 0) {
        if (currentStroke.isEraser && eraserMode === 'delete') {
            clearTimeout(batchSendTimer);
            const removedStrokeIds = [];
            strokeBatch = strokeBatch.filter((stroke) => {
                if (!stroke || stroke.type === 'image' || !stroke.path) return true;
                const eraserRadius = Math.max(8, (currentStroke.size || 3) * 1.5);
                const shouldDelete = isStrokeHitByEraser(stroke.path, currentStroke.path, eraserRadius);
                if (shouldDelete && stroke.id) removedStrokeIds.push(stroke.id);
                return !shouldDelete;
            });
            const eraserRadius = Math.max(8, (currentStroke.size || 3) * 1.5);
            allStrokes = allStrokes.filter(stroke => {
                if (stroke.type === 'image') return true;
                if (!stroke.path) return true;
                const shouldDelete = isStrokeHitByEraser(stroke.path, currentStroke.path, eraserRadius);
                if (shouldDelete && stroke.id) removedStrokeIds.push(stroke.id);
                return !shouldDelete;
            });
            resizeAndRedrawCanvas();
            saveCurrentPageToMemory();
            if (removedStrokeIds.length > 0) {
                socket.emit('delete-strokes', { pageIndex: currentPageIndex, strokeIds: removedStrokeIds });
            }
            socket.emit('update-active-page', notebookPages[currentPageIndex]);
            strokeBatch = [];
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