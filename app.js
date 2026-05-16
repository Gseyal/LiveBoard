const isElectron = (typeof window !== 'undefined' && window.require);
const ipcRenderer = isElectron ? window.require('electron').ipcRenderer : null;
const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

const serverIP = window.location.hostname || 'localhost';
const socket = io(`http://${serverIP}:3000`);

const canvas = document.getElementById('ink-layer');
const ctx = canvas.getContext('2d');
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
const penBtn = document.getElementById('pen-btn');
const eraserBtn = document.getElementById('eraser-btn');
const brushSizeSlider = document.getElementById('brush-size');
const brushSizeVal = document.getElementById('brush-size-val'); 
const projectNameDisplay = document.getElementById('current-notebook-name');

const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomDisplay = document.getElementById('zoom-display');

const paginationControls = document.getElementById('pagination-controls');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');
const addPageBtn = document.getElementById('add-page-btn');
const pageDisplay = document.getElementById('page-display');

let currentTool = 'pen'; 
let currentNotebookPath = null;
let currentZoom = 1.0; 

let notebookPages = [ { strokes: [], text: "" } ];
let currentPageIndex = 0;
let allStrokes = []; 

brushSizeSlider.addEventListener('input', (e) => { brushSizeVal.innerText = e.target.value; });

function applyZoom() {
    scrollWrapper.style.transform = `scale(${currentZoom})`;
    zoomDisplay.innerText = `${Math.round(currentZoom * 100)}%`;
}

zoomInBtn.addEventListener('click', () => { currentZoom = Math.min(currentZoom + 0.1, 3.0); applyZoom(); });
zoomOutBtn.addEventListener('click', () => { currentZoom = Math.max(currentZoom - 0.1, 0.3); applyZoom(); });

function saveCurrentPageToMemory() {
    notebookPages[currentPageIndex] = { strokes: [...allStrokes], text: textLayer.innerHTML };
}

function loadPage(index) {
    saveCurrentPageToMemory(); 
    currentPageIndex = index;
    allStrokes = notebookPages[currentPageIndex].strokes || [];
    textLayer.innerHTML = notebookPages[currentPageIndex].text || "";
    
    pageDisplay.innerText = `Page ${currentPageIndex + 1}/${notebookPages.length}`;
    resizeAndRedrawCanvas();
    triggerAutoSave();
}

prevPageBtn.addEventListener('click', () => {
    if (currentPageIndex > 0) {
        loadPage(currentPageIndex - 1);
        socket.emit('change-page', currentPageIndex);
    }
});

nextPageBtn.addEventListener('click', () => {
    if (currentPageIndex < notebookPages.length - 1) {
        loadPage(currentPageIndex + 1);
        socket.emit('change-page', currentPageIndex);
    }
});

addPageBtn.addEventListener('click', () => {
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
        const projectData = { pages: notebookPages, settings: { theme: bgSelect.value, pageSize: sizeSelect.value, canvasHeight: currentCanvasHeight } };
        await ipcRenderer.invoke('fs:saveJSON', currentNotebookPath, JSON.stringify(projectData, null, 2));
    }, 1500); 
}

const imageCache = {}; 
const imgPreview = document.createElement('img');
imgPreview.style.position = 'absolute'; imgPreview.style.pointerEvents = 'none'; imgPreview.style.opacity = '0.5'; imgPreview.style.display = 'none'; imgPreview.style.zIndex = '100';
scrollWrapper.appendChild(imgPreview);

let baseImgWidth = 0, baseImgHeight = 0, currentImageScale = 1, currentMouseX = 0, currentMouseY = 0;
let selectedItemIndex = -1, isTransforming = false, transformMode = null, dragOffsetX = 0, dragOffsetY = 0;

selectBtn.addEventListener('click', () => { currentTool = 'select'; selectBtn.classList.add('active'); penBtn.classList.remove('active'); eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; });
penBtn.addEventListener('click', () => { currentTool = 'pen'; selectedItemIndex = -1; penBtn.classList.add('active'); selectBtn.classList.remove('active'); eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; resizeAndRedrawCanvas(); });
eraserBtn.addEventListener('click', () => { currentTool = 'eraser'; selectedItemIndex = -1; eraserBtn.classList.add('active'); penBtn.classList.remove('active'); selectBtn.classList.remove('active'); imgPreview.style.display = 'none'; resizeAndRedrawCanvas(); });
colorPicker.addEventListener('input', () => penBtn.click());

window.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile(); const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const tmpCanvas = document.createElement('canvas'); const MAX_WIDTH = 600; let w = img.width, h = img.height;
                    if (w > MAX_WIDTH) { h = Math.round((h * MAX_WIDTH) / w); w = MAX_WIDTH; }
                    tmpCanvas.width = w; tmpCanvas.height = h; tmpCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    baseImgWidth = w; baseImgHeight = h; currentImageScale = 1;
                    imgPreview.src = tmpCanvas.toDataURL('image/jpeg', 0.8); imgPreview.width = baseImgWidth; imgPreview.height = baseImgHeight; imgPreview.style.display = 'block';
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
            paginationControls.style.display = 'flex'; 
        } else { 
            container.classList.remove('size-a4'); 
            paginationControls.style.display = 'none'; 
            
            if (currentPageIndex !== 0) {
                loadPage(0);
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
            notebookPages = data.pages || [ { strokes: data.strokes || [], text: data.text || "" } ];
            applyPageSettings(data.settings.theme, data.settings.pageSize, data.settings.canvasHeight, pName);
            loadPage(data.currentPageIndex || 0);
            socket.emit('load-full-state', { pages: notebookPages, currentPageIndex: currentPageIndex, settings: { ...data.settings, projectName: pName } });
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

    loadPage(originalIndex);

    const arrayBuffer = pdf.output('arraybuffer');
    await ipcRenderer.invoke('fs:savePDF', currentNotebookPath, arrayBuffer);
    exportBtn.innerText = "🖨️ Export PDF"; 
    alert(`PDF Exported Successfully! (${pagesToExport} pages)`);
});

const shareBtn = document.getElementById('share-btn'); const qrModal = document.getElementById('qr-modal'); const closeModalBtn = document.getElementById('close-modal-btn'); const copyUrlBtn = document.getElementById('copy-url-btn'); const urlInput = document.getElementById('local-url-input'); const qrContainer = document.getElementById('qrcode');
function getLocalIPAddress() { return isElectron ? window.require('os').networkInterfaces()[Object.keys(window.require('os').networkInterfaces())[0]][1].address : window.location.hostname; }

shareBtn.addEventListener('click', () => { 
    if (!isElectron) return alert("You are already on the browser!");
    const connectionUrl = `http://${getLocalIPAddress()}:3000`; urlInput.value = connectionUrl; 
    qrContainer.innerHTML = ''; new QRCode(qrContainer, { text: connectionUrl, width: 200, height: 200 }); qrModal.classList.remove('hidden'); 
});
closeModalBtn.addEventListener('click', () => qrModal.classList.add('hidden'));

socket.on('load-full-state', (state) => {
    notebookPages = state.pages;
    applyPageSettings(state.settings.theme, state.settings.pageSize, state.settings.canvasHeight, state.settings.projectName);
    loadPage(state.currentPageIndex);
});
socket.on('receive-page-settings', (settings) => { applyPageSettings(settings.theme, settings.pageSize, settings.canvasHeight, settings.projectName); });
socket.on('remote-page-changed', (index) => { loadPage(index); });
socket.on('remote-page-added', (state) => { notebookPages = state.pages; loadPage(state.currentPageIndex); });
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
    if (data.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = data.color; }
    ctx.lineWidth = data.size || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(remoteX, remoteY); ctx.lineTo(data.x, data.y); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over'; remoteX = data.x; remoteY = data.y;
});

function resizeAndRedrawCanvas() {
    canvas.width = scrollWrapper.clientWidth; canvas.height = scrollWrapper.scrollHeight; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    allStrokes.forEach((strokeData) => {
        if (!strokeData) return;
        if (strokeData.type === 'image') {
            if (imageCache[strokeData.src]) { ctx.globalCompositeOperation = 'destination-over'; ctx.drawImage(imageCache[strokeData.src], strokeData.x, strokeData.y, strokeData.w, strokeData.h); ctx.globalCompositeOperation = 'source-over'; } 
            else { const img = new Image(); img.onload = () => { imageCache[strokeData.src] = img; resizeAndRedrawCanvas(); }; img.src = strokeData.src; }
            return; 
        }
        if (!strokeData.path || strokeData.path.length === 0) return;
        if (strokeData.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = strokeData.color; }
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
    if (!isIpadMode && e.pointerType === 'touch') return;
    if (isIpadMode && currentTool !== 'select' && e.pointerType === 'touch') return; 
    
    const coords = getCoordinates(e);
    if (currentTool === 'image-placer') {
        const newImg = { type: 'image', src: imgPreview.src, x: coords.x - imgPreview.width / 2, y: coords.y - imgPreview.height / 2, w: imgPreview.width, h: imgPreview.height };
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
    currentStroke = { type: 'stroke', color: activeColor, isEraser: isEraser, size: activeSize, path: [{ x: lastX, y: lastY }] };
    socket.emit('start-stream', { color: activeColor, isEraser: isEraser, size: activeSize, x: lastX, y: lastY });
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || !isIpadMode || (e.pointerType === 'touch') || currentTool === 'image-placer' || currentTool === 'select') return;
    const coords = getCoordinates(e);
    if (currentStroke.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = currentStroke.color; }
    ctx.lineWidth = currentStroke.size; ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(coords.x, coords.y); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; 
    currentStroke.path.push({ x: coords.x, y: coords.y }); socket.emit('stream-point', { color: currentStroke.color, isEraser: currentStroke.isEraser, size: currentStroke.size, x: coords.x, y: coords.y }); lastX = coords.x; lastY = coords.y;
});

let strokeBatch = []; let batchSendTimer = null;   
function handlePointerUpOut(e) {
    if (currentTool === 'select' && isTransforming) { isTransforming = false; transformMode = null; saveCurrentPageToMemory(); socket.emit('update-active-page', notebookPages[currentPageIndex]); triggerAutoSave(); return; }
    if (!isDrawing || e.pointerType === 'touch') return;
    isDrawing = false;
    if (currentStroke.path && currentStroke.path.length > 0) {
        allStrokes.push(currentStroke); strokeBatch.push(currentStroke); currentStroke = {}; triggerAutoSave(); 
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