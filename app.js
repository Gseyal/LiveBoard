// --- 1. ENVIRONMENT CHECK & SAFE IPC BRIDGE ---
const isElectron = (typeof window !== 'undefined' && window.require);
const ipcRenderer = isElectron ? window.require('electron').ipcRenderer : null;
const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

const serverIP = window.location.hostname || 'localhost';
const socket = io(`http://${serverIP}:3000`);

// --- 2. DOM ELEMENTS ---
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
const exportBtn = document.getElementById('export-btn'); // New Single Export Button

const selectBtn = document.getElementById('select-btn'); 
const penBtn = document.getElementById('pen-btn');
const eraserBtn = document.getElementById('eraser-btn');
const brushSizeSlider = document.getElementById('brush-size');
const projectNameDisplay = document.getElementById('current-notebook-name');

let allStrokes = [];
let currentTool = 'pen'; 
let currentNotebookPath = null;

// ==========================================
// THE NEW AUTO-SAVE ENGINE
// ==========================================
let autoSaveTimer = null;
function triggerAutoSave() {
    // Only auto-save if we are on the laptop and a folder is actually open
    if (!isElectron || !currentNotebookPath) return; 
    
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
        const projectData = { strokes: allStrokes, text: textLayer.innerHTML, settings: { theme: bgSelect.value, pageSize: sizeSelect.value } };
        await ipcRenderer.invoke('fs:saveJSON', currentNotebookPath, JSON.stringify(projectData, null, 2));
        console.log("Auto-saved to JSON."); // Silent background save
    }, 1500); // Waits 1.5 seconds after you stop drawing/typing to save
}

// --- 3. IMAGE STAMP STATE ---
const imageCache = {}; 
const imgPreview = document.createElement('img');
imgPreview.style.position = 'absolute'; imgPreview.style.pointerEvents = 'none'; imgPreview.style.opacity = '0.5'; imgPreview.style.display = 'none'; imgPreview.style.zIndex = '100';
scrollWrapper.appendChild(imgPreview);

let baseImgWidth = 0, baseImgHeight = 0, currentImageScale = 1, currentMouseX = 0, currentMouseY = 0;
let selectedItemIndex = -1, isTransforming = false, transformMode = null, dragOffsetX = 0, dragOffsetY = 0;

// --- 4. TOOL LOGIC & PASTE ---
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

// --- 5. PAGE SETTINGS ---
function applyPageSettings(theme, size) {
    if (theme) { bgSelect.value = theme; if (theme === 'black') container.classList.add('theme-black'); else container.classList.remove('theme-black'); }
    if (size) { sizeSelect.value = size; if (size === 'a4') container.classList.add('size-a4'); else container.classList.remove('size-a4'); setTimeout(resizeAndRedrawCanvas, 350); }
    triggerAutoSave(); // Save when settings change!
}

sizeSelect.addEventListener('change', (e) => { applyPageSettings(null, e.target.value); socket.emit('update-page-settings', { pageSize: e.target.value }); });
bgSelect.addEventListener('change', (e) => { applyPageSettings(e.target.value, null); socket.emit('update-page-settings', { theme: e.target.value }); });

let isIpadMode = false;
toggleBtn.addEventListener('click', () => {
    isIpadMode = !isIpadMode;
    if (isIpadMode) { container.classList.add('ipad-mode'); toggleBtn.innerText = "✏️ iPad Mode"; toggleBtn.style.backgroundColor = "#e3f2fd"; toggleBtn.style.color = "#0d47a1"; } 
    else { container.classList.remove('ipad-mode'); toggleBtn.innerText = "💻 Laptop Mode"; toggleBtn.style.backgroundColor = "white"; toggleBtn.style.color = "black"; }
    resizeAndRedrawCanvas(); 
});
clearBtn.addEventListener('click', () => { 
    if (confirm("Clear all ink on this page?")) { 
        allStrokes = []; selectedItemIndex = -1; resizeAndRedrawCanvas(); socket.emit('update-strokes', []); triggerAutoSave(); 
    } 
});

// --- 6. NATIVE MENU LISTENER & EXPORT PDF ---
if (isElectron) {
    ipcRenderer.on('menu-action', (event, payload) => {
        if (payload.action === 'new') {
            currentNotebookPath = payload.path;
            projectNameDisplay.innerText = `📁 ${currentNotebookPath.split(/[\\/]/).pop()}`;
            allStrokes = []; textLayer.innerHTML = ""; resizeAndRedrawCanvas();
            triggerAutoSave(); // Save immediately to initialize the folder
        } 
        else if (payload.action === 'open') {
            const data = JSON.parse(payload.data);
            allStrokes = data.strokes || []; textLayer.innerHTML = data.text || '';
            applyPageSettings(data.settings.theme, data.settings.pageSize);
            socket.emit('update-strokes', allStrokes); socket.emit('update-text', data.text);
            resizeAndRedrawCanvas();
            currentNotebookPath = payload.folderPath;
            projectNameDisplay.innerText = `📁 ${payload.fileName.replace('.json', '')}`;
        }
    });
}

// Single Export Button Logic (Updates the PDF)
exportBtn.addEventListener('click', async () => {
    if (!isElectron) return alert("Please click export directly on your laptop.");
    if (!currentNotebookPath) return alert("Use 'File > New Notebook Folder' on your laptop first!");
    if (allStrokes.length === 0) return alert("Nothing to export!");
    if (!jsPDF) return alert("PDF Engine failed to load, check internet connection.");
    
    exportBtn.innerText = "⏳ Exporting..."; // Visual feedback
    
    let maxContentY = 0;
    allStrokes.forEach(stroke => {
        if (stroke.type === 'image') maxContentY = Math.max(maxContentY, stroke.y + stroke.h);
        else if (stroke.path) stroke.path.forEach(pt => maxContentY = Math.max(maxContentY, pt.y));
    });
    if (maxContentY === 0) maxContentY = 1123; maxContentY += 100;

    const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvas.width; tempCanvas.height = sizeSelect.value === 'a4' ? canvas.height : maxContentY;
    const tCtx = tempCanvas.getContext('2d'); tCtx.fillStyle = '#ffffff'; tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height); tCtx.drawImage(canvas, 0, 0);
    const imgData = tempCanvas.toDataURL('image/jpeg', 1.0);

    const pdf = new jsPDF('p', 'pt', 'a4'); const pdfWidth = pdf.internal.pageSize.getWidth(); const pdfHeight = pdf.internal.pageSize.getHeight();
    const ratio = pdfWidth / tempCanvas.width; const scaledHeight = tempCanvas.height * ratio;

    let heightLeft = scaledHeight; let position = 0;
    pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight); heightLeft -= pdfHeight;

    while (heightLeft >= 0) { position = heightLeft - scaledHeight; pdf.addPage(); pdf.addImage(imgData, 'JPEG', 0, position, pdfWidth, scaledHeight); heightLeft -= pdfHeight; }

    const arrayBuffer = pdf.output('arraybuffer');
    await ipcRenderer.invoke('fs:savePDF', currentNotebookPath, arrayBuffer);
    
    exportBtn.innerText = "🖨️ Export PDF"; // Reset button
    alert("PDF Exported Successfully!");
});

// --- 7. QR LOGIC & DATA SYNC ---
const shareBtn = document.getElementById('share-btn'); const qrModal = document.getElementById('qr-modal'); const closeModalBtn = document.getElementById('close-modal-btn'); const copyUrlBtn = document.getElementById('copy-url-btn'); const urlInput = document.getElementById('local-url-input'); const qrContainer = document.getElementById('qrcode');
function getLocalIPAddress() { return isElectron ? window.require('os').networkInterfaces()[Object.keys(window.require('os').networkInterfaces())[0]][1].address : window.location.hostname; }

shareBtn.addEventListener('click', () => { 
    if (!isElectron) return alert("You are already on the browser!");
    const connectionUrl = `http://${getLocalIPAddress()}:3000`; urlInput.value = connectionUrl; 
    qrContainer.innerHTML = ''; new QRCode(qrContainer, { text: connectionUrl, width: 200, height: 200 }); 
    qrModal.classList.remove('hidden'); 
});
closeModalBtn.addEventListener('click', () => qrModal.classList.add('hidden'));

// When iPad sends strokes/text back to Laptop, Trigger Auto-save!
socket.on('receive-page-settings', (settings) => { applyPageSettings(settings.theme, settings.pageSize); triggerAutoSave(); });
socket.on('receive-strokes', (fullArray) => { allStrokes = fullArray; resizeAndRedrawCanvas(); triggerAutoSave(); });
socket.on('receive-stroke-batch', (batch) => { allStrokes.push(...batch); resizeAndRedrawCanvas(); triggerAutoSave(); });

let typingTimer;
textLayer.addEventListener('input', () => { 
    resizeAndRedrawCanvas(); 
    clearTimeout(typingTimer); 
    typingTimer = setTimeout(() => socket.emit('update-text', textLayer.innerHTML), 500); 
    triggerAutoSave(); // Save text typing
});

let remoteX = 0, remoteY = 0;
socket.on('remote-start-stream', (data) => { remoteX = data.x; remoteY = data.y; });
socket.on('remote-stream-point', (data) => {
    const scaleFactor = isIpadMode ? 1 : 0.6; 
    if (data.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = data.color; }
    ctx.lineWidth = (data.size || 3) * scaleFactor; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(remoteX, remoteY); ctx.lineTo(data.x, data.y); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over'; remoteX = data.x; remoteY = data.y;
});

// --- 8. RENDERING ENGINE ---
function resizeAndRedrawCanvas() {
    canvas.width = scrollWrapper.clientWidth;
    canvas.height = scrollWrapper.scrollHeight; 
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const scaleFactor = isIpadMode ? 1 : 0.6; 

    allStrokes.forEach((strokeData) => {
        if (!strokeData) return;
        if (strokeData.type === 'image') {
            if (imageCache[strokeData.src]) { ctx.globalCompositeOperation = 'destination-over'; ctx.drawImage(imageCache[strokeData.src], strokeData.x, strokeData.y, strokeData.w, strokeData.h); ctx.globalCompositeOperation = 'source-over'; } 
            else { const img = new Image(); img.onload = () => { imageCache[strokeData.src] = img; resizeAndRedrawCanvas(); }; img.src = strokeData.src; }
            return; 
        }
        if (!strokeData.path || strokeData.path.length === 0) return;
        if (strokeData.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = strokeData.color; }
        ctx.lineWidth = (strokeData.size || 3) * scaleFactor;
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

// --- 9. DRAWING & TRANSFORM ENGINE ---
let isDrawing = false, lastX = 0, lastY = 0, currentStroke = {};
function getCoordinates(e) { const rect = canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top }; }

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
        if (img.w < 20) img.w = 20; if (img.h < 20) img.h = 20;
        resizeAndRedrawCanvas(); 
    }
});

canvas.addEventListener('pointerdown', (e) => {
    if (isIpadMode) e.preventDefault(); 
    if (!isIpadMode || (e.pointerType === 'touch')) return;
    const coords = getCoordinates(e);

    if (currentTool === 'image-placer') {
        const newImg = { type: 'image', src: imgPreview.src, x: coords.x - imgPreview.width / 2, y: coords.y - imgPreview.height / 2, w: imgPreview.width, h: imgPreview.height };
        allStrokes.push(newImg); socket.emit('add-stroke-batch', [newImg]); 
        imgPreview.style.display = 'none'; penBtn.click(); resizeAndRedrawCanvas(); 
        triggerAutoSave(); // Save after placing image
        return; 
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
    const coords = getCoordinates(e); const scaleFactor = isIpadMode ? 1 : 0.6;
    if (currentStroke.isEraser) ctx.globalCompositeOperation = 'destination-out'; else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = currentStroke.color; }
    ctx.lineWidth = currentStroke.size * scaleFactor; ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(coords.x, coords.y); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; 
    currentStroke.path.push({ x: coords.x, y: coords.y }); socket.emit('stream-point', { color: currentStroke.color, isEraser: currentStroke.isEraser, size: currentStroke.size, x: coords.x, y: coords.y }); lastX = coords.x; lastY = coords.y;
});

let strokeBatch = []; let batchSendTimer = null;   
function handlePointerUpOut(e) {
    if (currentTool === 'select' && isTransforming) { isTransforming = false; transformMode = null; socket.emit('update-strokes', allStrokes); triggerAutoSave(); return; }
    if (!isDrawing || e.pointerType === 'touch') return;
    isDrawing = false;
    if (currentStroke.path && currentStroke.path.length > 0) {
        allStrokes.push(currentStroke); strokeBatch.push(currentStroke); currentStroke = {}; 
        
        triggerAutoSave(); // Save after a stroke finishes!

        clearTimeout(batchSendTimer); batchSendTimer = setTimeout(() => { if (strokeBatch.length > 0) { socket.emit('add-stroke-batch', strokeBatch); strokeBatch = []; } }, 2000); 
    }
}
canvas.addEventListener('pointerup', handlePointerUpOut); canvas.addEventListener('pointerout', handlePointerUpOut);

// --- 10. AUTO-EXPAND INFINITE CANVAS ---
container.addEventListener('scroll', () => {
    if (sizeSelect.value !== 'a4' && container.scrollTop + container.clientHeight >= scrollWrapper.scrollHeight - 500) {
        const currentHeight = parseInt(window.getComputedStyle(scrollWrapper).minHeight);
        scrollWrapper.style.minHeight = (currentHeight + 2000) + 'px'; 
        resizeAndRedrawCanvas(); 
    }
});