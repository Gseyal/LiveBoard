const isElectron = (typeof window !== 'undefined' && window.require);
const ipcRenderer = isElectron ? window.require('electron').ipcRenderer : null;
const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

const serverIP = window.location.hostname || 'localhost';
const socket = io(`http://${serverIP}:3000`);

const scrollWrapper = document.getElementById('scroll-wrapper');
const pageStack = document.getElementById('page-stack'); 
const container = document.getElementById('notebook-container');
const toggleBtn = document.getElementById('mode-toggle');
const clearBtn = document.getElementById('clear-btn');
const colorPicker = document.getElementById('pen-color');
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

let currentTool = 'pen'; 
let currentNotebookPath = null;
let currentZoom = 1.0;
let eraserMode = 'delete'; 
let isIpadMode = false;
let totalNotebookPages = 0;

function updateCanvasInteractivity() {
    if (!container) return;
    if (!isIpadMode && (currentTool === 'pen' || currentTool === 'eraser')) container.classList.add('text-mode-active');
    else container.classList.remove('text-mode-active');
}

// Sparse Array: Pages are 'undefined' until lazy-loaded!
let notebookPages = []; 
let activePageIndex = 0; 

const CANVAS_W = 2246;  
const CANVAS_H = 1588;

const bufferCanvas = document.createElement('canvas');
bufferCanvas.width = CANVAS_W;  
bufferCanvas.height = CANVAS_H;
const bufferCtx = bufferCanvas.getContext('2d', { willReadFrequently: true });

const imageCache = {}; 
const imgPreview = document.createElement('img');
imgPreview.style.position = 'absolute'; imgPreview.style.pointerEvents = 'none'; 
imgPreview.style.opacity = '0.5'; imgPreview.style.display = 'none'; imgPreview.style.zIndex = '1000';
document.body.appendChild(imgPreview);

let selectedItemIndex = -1; let selectedItemPage = -1;
let isTransforming = false; let transformMode = null; 
let dragOffsetX = 0, dragOffsetY = 0;

function generateStrokeId() { return `stroke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }

function perpendicularDistance(point, lineStart, lineEnd) {
    let dx = lineEnd.x - lineStart.x; let dy = lineEnd.y - lineStart.y;
    if (dx === 0 && dy === 0) { dx = point.x - lineStart.x; dy = point.y - lineStart.y; return Math.sqrt(dx * dx + dy * dy); }
    const length = Math.sqrt(dx * dx + dy * dy);
    return Math.abs((dy * point.x) - (dx * point.y) + (lineEnd.x * lineStart.y) - (lineEnd.y * lineStart.x)) / length;
}

function simplifyStrokeRDP(points, epsilon) {
    if (!points || points.length <= 2) return points;
    let maxDistance = 0; let index = 0; const end = points.length - 1;
    for (let i = 1; i < end; i++) {
        const d = perpendicularDistance(points[i], points[0], points[end]);
        if (d > maxDistance) { index = i; maxDistance = d; }
    }
    if (maxDistance > epsilon) {
        const left = simplifyStrokeRDP(points.slice(0, index + 1), epsilon);
        const right = simplifyStrokeRDP(points.slice(index), epsilon);
        return left.slice(0, left.length - 1).concat(right);
    } else { return [points[0], points[end]]; }
}

function distanceToSegment(point, start, end) {
    const segmentLengthSquared = ((end.x - start.x) ** 2) + ((end.y - start.y) ** 2);
    if (segmentLengthSquared === 0) { const dx = point.x - start.x; const dy = point.y - start.y; return Math.sqrt((dx * dx) + (dy * dy)); }
    const rawT = (((point.x - start.x) * (end.x - start.x)) + ((point.y - start.y) * (end.y - start.y))) / segmentLengthSquared;
    const t = Math.max(0, Math.min(1, rawT));
    const closestX = start.x + (t * (end.x - start.x)); const closestY = start.y + (t * (end.y - start.y));
    const dx = point.x - closestX; const dy = point.y - closestY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function isStrokeHitByEraser(strokePath, eraserPath, threshold) {
    if (!strokePath || strokePath.length === 0 || !eraserPath || eraserPath.length === 0) return false;
    if (strokePath.length === 1) return eraserPath.some((pt) => distanceToSegment(pt, strokePath[0], strokePath[0]) <= threshold);
    for (let i = 0; i < strokePath.length - 1; i++) {
        const sStart = strokePath[i]; const sEnd = strokePath[i + 1];
        for (let j = 0; j < eraserPath.length - 1; j++) {
            const eStart = eraserPath[j]; const eEnd = eraserPath[j + 1];
            if (distanceToSegment(eStart, sStart, sEnd) <= threshold || distanceToSegment(eEnd, sStart, sEnd) <= threshold || distanceToSegment(sStart, eStart, eEnd) <= threshold || distanceToSegment(sEnd, eStart, eEnd) <= threshold) return true;
        }
    }
    return strokePath.some((sPt) => eraserPath.some((ePt) => distanceToSegment(ePt, sPt, sPt) <= threshold));
}

let saveTimers = {};

function syncSettingsToDisk() {
    if (!isElectron || !currentNotebookPath || !bgSelect) return;
    ipcRenderer.invoke('fs:saveSettings', currentNotebookPath, { theme: bgSelect.value });
}

function syncPageToDisk(pageIndex) {
    if (!isElectron || !currentNotebookPath || !notebookPages[pageIndex]) return; 
    clearTimeout(saveTimers[pageIndex]);
    saveTimers[pageIndex] = setTimeout(() => {
        ipcRenderer.invoke('fs:savePage', currentNotebookPath, pageIndex, notebookPages[pageIndex]);
    }, 800);
}

function pushPageUpdate(pageIndex) {
    socket.emit('update-active-page', { pageIndex, data: notebookPages[pageIndex] });
    syncPageToDisk(pageIndex);
}

function getCoords(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// --- DOM VIRTUALIZATION ENGINE ---

// The observer monitors scroll position and mounts/unmounts heavy canvases
const pageObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
        const pageIndex = parseInt(entry.target.dataset.pageIndex);

        if (entry.isIntersecting) {
            activePageIndex = pageIndex; 
            
            // Mount the Canvas if it isn't already there
            if (!entry.target.classList.contains('mounted')) {
                entry.target.classList.add('mounted');

                // 1. LAZY LOAD DATA
                if (!notebookPages[pageIndex]) {
                    if (isElectron) {
                        notebookPages[pageIndex] = await ipcRenderer.invoke('fs:loadPage', currentNotebookPath, pageIndex);
                        buildPageUI(pageIndex, entry.target);
                    } else {
                        // iPad asks Server for data. We build UI when the server responds!
                        socket.emit('request-page', pageIndex);
                    }
                } else {
                    buildPageUI(pageIndex, entry.target);
                }
            }
        } else {
            // Unmount the Canvas to free up RAM!
            if (entry.target.classList.contains('mounted')) {
                entry.target.classList.remove('mounted');
                syncPageToDisk(pageIndex); // Safe save before destruction
                
                // Destroy heavy DOM elements, leaving the empty skeleton
                entry.target.innerHTML = ''; 
                
                // Flush image cache to prevent memory leaks
                Object.keys(imageCache).forEach(k => delete imageCache[k]);
            }
        }
    }
}, { root: scrollWrapper, rootMargin: '1500px 0px' }); // Render pages 1500px before they appear on screen

function initVirtualScroll(totalPages) {
    if (!pageStack) return;
    pageStack.innerHTML = ''; 
    pageObserver.disconnect();
    totalNotebookPages = totalPages;

    // Create empty skeletons for every page
    for (let i = 0; i < totalPages; i++) {
        const containerDiv = document.createElement('div');
        containerDiv.className = 'a4-page-container';
        containerDiv.dataset.pageIndex = i;
        pageStack.appendChild(containerDiv);
        pageObserver.observe(containerDiv); 
    }
}

// Injects the actual Text and Canvas layers into a skeleton
function buildPageUI(pageIndex, containerDiv) {
    if (!notebookPages[pageIndex]) return; 
    containerDiv.innerHTML = ''; // Clear skeleton

    const textDiv = document.createElement('div');
    textDiv.className = 'page-text-layer';
    textDiv.contentEditable = true;
    textDiv.innerHTML = escapeHtml(notebookPages[pageIndex].text || '').replace(/\n/g, '<br>');
    
    let typingTimer;
    textDiv.addEventListener('input', (e) => {
        clearTimeout(typingTimer);
        notebookPages[pageIndex].text = e.target.innerHTML;
        typingTimer = setTimeout(() => pushPageUpdate(pageIndex), 500); 
    });

    const inkCanvas = document.createElement('canvas');
    inkCanvas.className = 'page-ink-layer a4-canvas';
    inkCanvas.width = CANVAS_W;
    inkCanvas.height = CANVAS_H;
    
    containerDiv.appendChild(textDiv);
    containerDiv.appendChild(inkCanvas);

    attachPointerEvents(inkCanvas, pageIndex);
    requestRedraw(pageIndex);
}

// Infinite Scroll Trigger
if (scrollWrapper) {
    scrollWrapper.addEventListener('scroll', () => {
        if (isElectron && !currentNotebookPath) return;
        if (!isElectron && totalNotebookPages === 0) return;

        // If user scrolls to the bottom, append a new skeleton!
        if (scrollWrapper.scrollTop + scrollWrapper.clientHeight >= scrollWrapper.scrollHeight - 300) {
            const newIndex = totalNotebookPages;
            totalNotebookPages++;
            notebookPages[newIndex] = { strokes: [], text: "" }; // Initialize empty data
            
            const containerDiv = document.createElement('div');
            containerDiv.className = 'a4-page-container';
            containerDiv.dataset.pageIndex = newIndex;
            pageStack.appendChild(containerDiv);
            
            pageObserver.observe(containerDiv); // Track the new page
            pushPageUpdate(newIndex); 
        }
    });
}

let renderFlags = {};

function requestRedraw(pageIndex) {
    if (!renderFlags[pageIndex]) {
        renderFlags[pageIndex] = true;
        requestAnimationFrame(() => {
            redrawPageCanvas(pageIndex);
            renderFlags[pageIndex] = false;
        });
    }
}

function redrawPageCanvas(pageIndex) {
    const pageData = notebookPages[pageIndex];
    if (!pageData) return;
    
    const targetCanvas = document.querySelector(`.a4-page-container[data-page-index="${pageIndex}"] .page-ink-layer`);
    if (!targetCanvas) return;
    const ctx = targetCanvas.getContext('2d');

    bufferCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    bufferCtx.lineCap = 'round'; 
    bufferCtx.lineJoin = 'round';

    pageData.strokes.forEach((strokeData, sIndex) => {
        if (!strokeData) return;
        if (isTransforming && pageIndex === selectedItemPage && sIndex === selectedItemIndex) return;

        if (strokeData.type === 'image') {
            const keySrc = strokeData.src;
            if (imageCache[keySrc] && imageCache[keySrc] !== 'loading') { 
                bufferCtx.globalCompositeOperation = 'destination-over'; 
                bufferCtx.drawImage(imageCache[keySrc], strokeData.x, strokeData.y, strokeData.w, strokeData.h); 
                bufferCtx.globalCompositeOperation = 'source-over'; 
            } else if (!imageCache[keySrc]) { 
                imageCache[keySrc] = 'loading'; 
                const img = new Image(); 
                img.onload = () => { imageCache[keySrc] = img; requestRedraw(pageIndex); };
                img.onerror = () => { delete imageCache[keySrc]; }; 
                img.src = keySrc; 
            }
            return; 
        }

        if (!strokeData.path || strokeData.path.length === 0) return;
        
        if (strokeData.isEraser && strokeData.eraserMode === 'delete') bufferCtx.globalCompositeOperation = 'destination-out'; 
        else { bufferCtx.globalCompositeOperation = 'source-over'; bufferCtx.strokeStyle = strokeData.color; }
        
        bufferCtx.lineWidth = (strokeData.size || 3) * 2; 
        bufferCtx.beginPath(); 
        bufferCtx.moveTo(strokeData.path[0].x, strokeData.path[0].y);
        for (let i = 1; i < strokeData.path.length; i++) bufferCtx.lineTo(strokeData.path[i].x, strokeData.path[i].y);
        bufferCtx.stroke();
    });
    
    bufferCtx.globalCompositeOperation = 'source-over'; 
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.drawImage(bufferCanvas, 0, 0);

    if (pageIndex === selectedItemPage && selectedItemIndex > -1 && pageData.strokes[selectedItemIndex].type === 'image') {
        const img = pageData.strokes[selectedItemIndex];
        if (isTransforming && imageCache[img.src] && imageCache[img.src] !== 'loading') {
            ctx.globalCompositeOperation = 'destination-over'; 
            ctx.drawImage(imageCache[img.src], img.x, img.y, img.w, img.h); 
            ctx.globalCompositeOperation = 'source-over'; 
        }
        
        ctx.strokeStyle = '#2196f3'; ctx.lineWidth = 4; ctx.setLineDash([10, 10]); ctx.strokeRect(img.x, img.y, img.w, img.h); ctx.setLineDash([]); 
        ctx.fillStyle = 'white'; const hSize = 24; 
        const drawHandle = (x, y) => { ctx.fillRect(x - hSize/2, y - hSize/2, hSize, hSize); ctx.strokeRect(x - hSize/2, y - hSize/2, hSize, hSize); };
        drawHandle(img.x, img.y); drawHandle(img.x + img.w, img.y); drawHandle(img.x, img.y + img.h); drawHandle(img.x + img.w, img.y + img.h); 
    }
}

// --- POINTER EVENTS ---
let isDrawing = false, lastX = 0, lastY = 0, currentStroke = {};

function attachPointerEvents(canvas, pageIndex) {
    canvas.addEventListener('touchstart', (e) => { if (isIpadMode) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', (e) => { if (isIpadMode) e.preventDefault(); });

    canvas.addEventListener('pointerdown', (e) => {
        if (isIpadMode && e.pointerType === 'touch' && currentTool !== 'select' && currentTool !== 'image-placer') return;
        activePageIndex = pageIndex; 
        const coords = getCoords(e, canvas);

        if (currentTool === 'image-placer') {
            const newImg = { id: generateStrokeId(), type: 'image', src: imgPreview.src || imgPreview.dataset.dataUrl, x: coords.x - imgPreview.width / 2, y: coords.y - imgPreview.height / 2, w: imgPreview.width, h: imgPreview.height };
            notebookPages[pageIndex].strokes.push(newImg); 
            imgPreview.style.display = 'none'; 
            if (penBtn) penBtn.click(); 
            requestRedraw(pageIndex); 
            pushPageUpdate(pageIndex); 
            return; 
        }

        if (currentTool === 'select') {
            const pageStrokes = notebookPages[pageIndex].strokes;
            if (selectedItemIndex > -1 && selectedItemPage === pageIndex) {
                const img = pageStrokes[selectedItemIndex]; const hit = (hx, hy) => coords.x > hx - 40 && coords.x < hx + 40 && coords.y > hy - 40 && coords.y < hy + 40;
                if (hit(img.x, img.y)) { transformMode = 'resize-nw'; isTransforming = true; return; } 
                if (hit(img.x + img.w, img.y)) { transformMode = 'resize-ne'; isTransforming = true; return; }
                if (hit(img.x, img.y + img.h)) { transformMode = 'resize-sw'; isTransforming = true; return; } 
                if (hit(img.x + img.w, img.y + img.h)) { transformMode = 'resize-se'; isTransforming = true; return; }
                if (coords.x >= img.x && coords.x <= img.x + img.w && coords.y >= img.y && coords.y <= img.y + img.h) { transformMode = 'drag'; isTransforming = true; dragOffsetX = coords.x - img.x; dragOffsetY = coords.y - img.y; return; }
            }
            selectedItemIndex = -1; selectedItemPage = -1;
            for (let i = pageStrokes.length - 1; i >= 0; i--) { 
                const item = pageStrokes[i];
                if (item.type === 'image' && coords.x >= item.x && coords.x <= item.x + item.w && coords.y >= item.y && coords.y <= item.y + item.h) {
                    selectedItemIndex = i; selectedItemPage = pageIndex; transformMode = 'drag'; isTransforming = true; dragOffsetX = coords.x - item.x; dragOffsetY = coords.y - item.y; break;
                }
            }
            requestRedraw(pageIndex); return;
        }
        
        isDrawing = true; lastX = coords.x; lastY = coords.y; 
        const aColor = colorPicker ? colorPicker.value : '#000000'; 
        const isEraser = (currentTool === 'eraser'); 
        const aSize = brushSizeSlider ? parseInt(brushSizeSlider.value, 10) : 3;
        currentStroke = { id: generateStrokeId(), type: 'stroke', color: eraserMode === 'white' && isEraser ? '#ffffff' : aColor, isEraser: isEraser, eraserMode: isEraser ? eraserMode : null, size: aSize, path: [{ x: lastX, y: lastY }] };
        
        socket.emit('start-stream', { x: lastX, y: lastY });
    });

    canvas.addEventListener('pointermove', (e) => {
        if (isIpadMode && e.pointerType === 'touch' && currentTool !== 'select' && currentTool !== 'image-placer') return;
        const coords = getCoords(e, canvas);

        if (currentTool === 'image-placer' && imgPreview.style.display === 'block') { 
            const globalCoords = { x: e.clientX, y: e.clientY };
            imgPreview.style.left = (globalCoords.x - imgPreview.width / 2) + 'px'; 
            imgPreview.style.top = (globalCoords.y - imgPreview.height / 2) + 'px'; 
            return; 
        }

        if (currentTool === 'select' && isTransforming && selectedItemPage === pageIndex) {
            const img = notebookPages[pageIndex].strokes[selectedItemIndex];
            if (transformMode === 'drag') { img.x = coords.x - dragOffsetX; img.y = coords.y - dragOffsetY; } 
            else if (transformMode === 'resize-se') { img.w = coords.x - img.x; img.h = coords.y - img.y; } 
            else if (transformMode === 'resize-sw') { img.w = (img.x + img.w) - coords.x; img.x = coords.x; img.h = coords.y - img.y; } 
            else if (transformMode === 'resize-ne') { img.w = coords.x - img.x; img.h = (img.y + img.h) - coords.y; img.y = coords.y; } 
            else if (transformMode === 'resize-nw') { img.w = (img.x + img.w) - coords.x; img.h = (img.y + img.h) - coords.y; img.x = coords.x; img.y = coords.y; }
            if (img.w < 20) img.w = 20; if (img.h < 20) img.h = 20; 
            requestRedraw(pageIndex); return;
        }

        if (!isDrawing) return;
        
        const ctx = canvas.getContext('2d');
        if (currentStroke.isEraser && eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; 
        else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = currentStroke.color; }
        ctx.lineWidth = currentStroke.size * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(coords.x, coords.y); ctx.stroke(); 
        ctx.globalCompositeOperation = 'source-over'; 
        
        currentStroke.path.push({ x: coords.x, y: coords.y }); 
        
        socket.emit('stream-point', { color: currentStroke.color, isEraser: currentStroke.isEraser, eraserMode: currentStroke.eraserMode, size: currentStroke.size, x: coords.x, y: coords.y });
        lastX = coords.x; lastY = coords.y;
    });

    const handlePointerUp = (e) => {
        if (currentTool === 'select' && isTransforming && selectedItemPage === pageIndex) { 
            isTransforming = false; transformMode = null; 
            requestRedraw(pageIndex); pushPageUpdate(pageIndex); return; 
        }
        
        if (isIpadMode && e.pointerType === 'touch') return; 
        if (!isDrawing) return;
        isDrawing = false;
        
        if (currentStroke.path && currentStroke.path.length > 0) {
            let pageStrokes = notebookPages[pageIndex].strokes;
            if (!currentStroke.isEraser) { currentStroke.path = simplifyStrokeRDP(currentStroke.path, 1.2); }

            if (currentStroke.isEraser && eraserMode === 'delete') {
                const removedStrokeIds = []; const eRadius = Math.max(15, (currentStroke.size || 3) * 3);
                notebookPages[pageIndex].strokes = pageStrokes.filter(stroke => {
                    if (stroke.type === 'image' || !stroke.path) return true;
                    const shouldDelete = isStrokeHitByEraser(stroke.path, currentStroke.path, eRadius);
                    if (shouldDelete && stroke.id) removedStrokeIds.push(stroke.id);
                    return !shouldDelete;
                });
                
                if (removedStrokeIds.length > 0) {
                    requestRedraw(pageIndex); syncPageToDisk(pageIndex);
                    socket.emit('delete-strokes', { pageIndex: pageIndex, strokeIds: removedStrokeIds });
                }
            } else {
                pageStrokes.push(currentStroke); 
                requestRedraw(pageIndex); syncPageToDisk(pageIndex);
                socket.emit('add-stroke-batch', { pageIndex: pageIndex, strokes: [currentStroke] });
            }
            currentStroke = {}; 
        }
    };

    canvas.addEventListener('pointerup', handlePointerUp); 
    canvas.addEventListener('pointerout', handlePointerUp);
}

if(brushSizeSlider) brushSizeSlider.addEventListener('input', (e) => { if(brushSizeVal) brushSizeVal.innerText = e.target.value; });

if(zoomSlider) {
    zoomSlider.addEventListener('input', (e) => { 
        currentZoom = parseInt(e.target.value, 10) / 100; 
        document.documentElement.style.setProperty('--zoom', currentZoom);
        if(zoomDisplay) zoomDisplay.innerText = `${Math.round(currentZoom * 100)}%`;
    });
}

function applyTheme(theme) {
    if (theme && bgSelect && container) { 
        bgSelect.value = theme; 
        if (theme === 'black') container.classList.add('theme-black'); else container.classList.remove('theme-black'); 
        syncSettingsToDisk();
    }
}
if(bgSelect) bgSelect.addEventListener('change', (e) => applyTheme(e.target.value));

if(toggleBtn) {
    toggleBtn.addEventListener('click', () => {
        isIpadMode = !isIpadMode;
        if (isIpadMode) { container.classList.add('ipad-mode'); toggleBtn.innerText = "✏️ iPad Mode"; toggleBtn.style.backgroundColor = "#e3f2fd"; toggleBtn.style.color = "#0d47a1"; } 
        else { container.classList.remove('ipad-mode'); toggleBtn.innerText = "💻 Laptop Mode"; toggleBtn.style.backgroundColor = "white"; toggleBtn.style.color = "black"; }
        updateCanvasInteractivity(); 
    });
}

if(clearBtn) {
    clearBtn.addEventListener('click', () => { 
        if (confirm(`Clear all ink on Page ${activePageIndex + 1}?`)) { 
            notebookPages[activePageIndex].strokes = []; 
            const textDiv = document.querySelector(`.a4-page-container[data-page-index="${activePageIndex}"] .page-text-layer`);
            if(textDiv) textDiv.innerHTML = "";
            notebookPages[activePageIndex].text = "";
            selectedItemIndex = -1; selectedItemPage = -1;
            requestRedraw(activePageIndex); pushPageUpdate(activePageIndex); 
        } 
    });
}

function deleteSelectedItem() {
    if (selectedItemIndex < 0 || selectedItemPage < 0) return;
    notebookPages[selectedItemPage].strokes.splice(selectedItemIndex, 1);
    const updatedPage = selectedItemPage;
    selectedItemIndex = -1; selectedItemPage = -1; isTransforming = false; transformMode = null;
    requestRedraw(updatedPage); pushPageUpdate(updatedPage); 
}
if(deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', deleteSelectedItem);

if(selectBtn) selectBtn.addEventListener('click', () => { currentTool = 'select'; selectBtn.classList.add('active'); if(penBtn) penBtn.classList.remove('active'); if(eraserBtn) eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; if(eraserModeBtn) eraserModeBtn.style.display = 'none'; if(deleteSelectedBtn) deleteSelectedBtn.style.display = 'inline-block'; updateCanvasInteractivity(); });
if(penBtn) penBtn.addEventListener('click', () => { currentTool = 'pen'; selectedItemIndex = -1; penBtn.classList.add('active'); if(selectBtn) selectBtn.classList.remove('active'); if(eraserBtn) eraserBtn.classList.remove('active'); imgPreview.style.display = 'none'; if(eraserModeBtn) eraserModeBtn.style.display = 'none'; if(deleteSelectedBtn) deleteSelectedBtn.style.display = 'none'; requestRedraw(activePageIndex); updateCanvasInteractivity(); });
if(eraserBtn) eraserBtn.addEventListener('click', () => { currentTool = 'eraser'; selectedItemIndex = -1; eraserBtn.classList.add('active'); if(penBtn) penBtn.classList.remove('active'); if(selectBtn) selectBtn.classList.remove('active'); imgPreview.style.display = 'none'; if(eraserModeBtn) eraserModeBtn.style.display = 'inline-block'; if(deleteSelectedBtn) deleteSelectedBtn.style.display = 'none'; requestRedraw(activePageIndex); updateCanvasInteractivity(); });
if(eraserModeBtn) eraserModeBtn.addEventListener('click', () => { eraserMode = eraserMode === 'delete' ? 'white' : 'delete'; eraserModeBtn.innerText = eraserMode === 'delete' ? 'Delete' : 'White'; eraserModeBtn.style.backgroundColor = eraserMode === 'delete' ? '#ffcdd2' : '#fff9c4'; });
if(colorPicker && penBtn) colorPicker.addEventListener('input', () => penBtn.click());

document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && currentTool === 'select' && selectedItemIndex > -1) {
        if (document.activeElement && !document.activeElement.classList.contains('page-text-layer')) {
            e.preventDefault(); deleteSelectedItem();
        }
    }
});

window.addEventListener('paste', async (e) => {
    if (!isIpadMode) return;
    if (document.activeElement && document.activeElement.classList.contains('page-text-layer')) return;

    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile(); const reader = new FileReader();
            reader.onload = async (event) => {
                const img = new Image();
                img.onload = async () => {
                    const tmpCanvas = document.createElement('canvas'); const w = img.width; const h = img.height;
                    tmpCanvas.width = w; tmpCanvas.height = h; tmpCanvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    const dataUrl = tmpCanvas.toDataURL('image/png');
                    
                    imgPreview.dataset.dataUrl = dataUrl; let finalSrc = dataUrl;
                    
                    if (isElectron && currentNotebookPath && ipcRenderer) {
                        try {
                            const base64 = dataUrl.split(',')[1]; const fileName = `img-${Date.now()}.png`;
                            finalSrc = await ipcRenderer.invoke('fs:saveAsset', currentNotebookPath, fileName, base64);
                        } catch (err) { console.error('Failed to save asset:', err); }
                    }
                    
                    imgPreview.src = finalSrc; imgPreview.width = w; imgPreview.height = h; imgPreview.style.display = 'block';
                    currentTool = 'image-placer'; updateCanvasInteractivity(); 
                    if(penBtn) penBtn.classList.remove('active'); if(eraserBtn) eraserBtn.classList.remove('active'); if(selectBtn) selectBtn.classList.remove('active');
                };
                img.src = event.target.result;
            };
            reader.readAsDataURL(blob);
        }
    }
});

// --- ELECTRON IPC LISTENERS ---
if (isElectron) {
    ipcRenderer.on('menu-action', (event, payload) => {
        if (payload.action === 'new') {
            currentNotebookPath = payload.path;
            const pName = `📁 ${currentNotebookPath.split(/[\\/]/).pop()}`;
            if(projectNameDisplay) projectNameDisplay.innerText = pName;
            
            notebookPages = [ { strokes: [], text: "" } ]; 
            initVirtualScroll(1);
            syncSettingsToDisk(); syncPageToDisk(0);
            
            socket.emit('host-set-full-state', { isOpen: true, totalPages: 1, settings: { theme: bgSelect ? bgSelect.value : 'white', projectName: pName } });
            updateCanvasInteractivity();
        } 
        else if (payload.action === 'open') {
            const data = JSON.parse(payload.data);
            currentNotebookPath = payload.folderPath;
            const pName = `📁 ${currentNotebookPath.split(/[\\/]/).pop()}`;
            if(projectNameDisplay) projectNameDisplay.innerText = pName;
            
            notebookPages = []; 
            notebookPages[0] = data.firstPage || { strokes: [], text: "" };
            applyTheme(data.settings.theme || 'white');
            
            initVirtualScroll(data.totalPages || 1);
            
            socket.emit('host-set-full-state', { isOpen: true, totalPages: data.totalPages || 1, settings: { theme: data.settings ? data.settings.theme : 'white', projectName: pName } });
            updateCanvasInteractivity();
        }
    });
}

function buildWrappedLines(ctx, text, maxWidth) {
    const lines = []; const paragraphs = String(text || '').replace(/\r/g, '').split('\n');
    function splitToken(token) {
        if (!token) return ['']; if (ctx.measureText(token).width <= maxWidth) return [token];
        const chunks = []; let chunk = '';
        for (const ch of token) { const candidate = chunk + ch; if (chunk && ctx.measureText(candidate).width > maxWidth) { chunks.push(chunk); chunk = ch; } else chunk = candidate; }
        if (chunk) chunks.push(chunk); return chunks;
    }
    paragraphs.forEach((p) => {
        if (p.length === 0) { lines.push(''); return; }
        const tokens = p.match(/(\s+|\S+)/g) || ['']; if (tokens.length === 0) { lines.push(''); return; }
        let cLine = '';
        for (const t of tokens) {
            const candidate = cLine + t;
            if (ctx.measureText(candidate).width <= maxWidth) { cLine = candidate; } 
            else if (cLine) { lines.push(cLine); const chunks = splitToken(t); if (chunks.length > 1) { for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]); } cLine = chunks[chunks.length - 1] || ''; } 
            else { const chunks = splitToken(t); if (chunks.length > 1) { for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]); } cLine = chunks[chunks.length - 1] || ''; }
        }
        lines.push(cLine);
    });
    return lines;
}

if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
        if (!isElectron) return alert("Export is only supported in the Desktop App.");
        if (!currentNotebookPath) return alert("Open a Notebook Folder first!");
        if (!jsPDF) return alert("PDF Engine failed to load.");
        
        exportBtn.innerText = "⏳ Exporting..."; 

        let lastContentIndex = 0;
        for (let i = 0; i < totalNotebookPages; i++) {
            // Lazy load pages during export if they aren't in memory
            if (!notebookPages[i]) notebookPages[i] = await ipcRenderer.invoke('fs:loadPage', currentNotebookPath, i);
            const pageData = notebookPages[i];
            
            const hasStrokes = pageData.strokes && pageData.strokes.length > 0;
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = pageData.text || '';
            const hasText = tempDiv.innerText.trim().length > 0;

            if (hasStrokes || hasText) { lastContentIndex = i; }
        }
        const pagesToExport = lastContentIndex + 1;

        const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: [1123, 794] });

        for (let p = 0; p < pagesToExport; p++) {
            const pageData = notebookPages[p];
            const tempCanvas = document.createElement('canvas'); 
            tempCanvas.width = CANVAS_W; tempCanvas.height = CANVAS_H;
            const tCtx = tempCanvas.getContext('2d'); 
            
            tCtx.fillStyle = bgSelect.value === 'black' ? '#1e1e1e' : '#ffffff'; 
            tCtx.fillRect(0, 0, CANVAS_W, CANVAS_H); 

            const rawText = escapeHtml(pageData.text || '').replace(/<br>/g, '\n').replace(/&nbsp;/g, ' ');
            tCtx.font = '36px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
            tCtx.fillStyle = bgSelect.value === 'black' ? '#e0e0e0' : '#000000';
            tCtx.textBaseline = 'top';
            const lines = buildWrappedLines(tCtx, rawText, CANVAS_W - 160);
            let y = 80; lines.forEach((line) => { if (line) tCtx.fillText(line, 80, y); y += 57.6; });

            pageData.strokes.forEach(stroke => {
                if (stroke.type === 'image' && imageCache[stroke.src] && imageCache[stroke.src] !== 'loading') {
                    tCtx.drawImage(imageCache[stroke.src], stroke.x, stroke.y, stroke.w, stroke.h);
                } else if (stroke.path && stroke.path.length > 0) {
                    tCtx.strokeStyle = stroke.color; tCtx.lineWidth = (stroke.size || 3) * 2; tCtx.lineCap = 'round'; tCtx.lineJoin = 'round';
                    tCtx.beginPath(); tCtx.moveTo(stroke.path[0].x, stroke.path[0].y);
                    for (let i = 1; i < stroke.path.length; i++) tCtx.lineTo(stroke.path[i].x, stroke.path[i].y);
                    tCtx.stroke();
                }
            });

            if (p > 0) pdf.addPage(); 
            pdf.addImage(tempCanvas.toDataURL('image/jpeg', 1.0), 'JPEG', 0, 0, 1123, 794); 
        }

        const arrayBuffer = pdf.output('arraybuffer');
        await ipcRenderer.invoke('fs:savePDF', currentNotebookPath, arrayBuffer);
        exportBtn.innerText = "🖨️ Export PDF"; 
        alert(`PDF Exported Successfully! (${pagesToExport} pages)`);
    });
}

const shareBtn = document.getElementById('share-btn'); 
const qrModal = document.getElementById('qr-modal'); 
const closeModalBtn = document.getElementById('close-modal-btn'); 
const urlInput = document.getElementById('local-url-input'); 
const qrContainer = document.getElementById('qrcode');

if(shareBtn) shareBtn.addEventListener('click', () => { 
    if (!isElectron) return;
    const os = window.require('os'); const interfaces = os.networkInterfaces(); let ip = '127.0.0.1';
    for (const name of Object.keys(interfaces)) { for (const net of interfaces[name]) { if (net.family === 'IPv4' && !net.internal) ip = net.address; } }
    const url = `http://${ip}:3000`; if(urlInput) urlInput.value = url; 
    if(qrContainer) { qrContainer.innerHTML = ''; new QRCode(qrContainer, { text: url, width: 200, height: 200 }); }
    if(qrModal) qrModal.classList.remove('hidden'); 
});
if(closeModalBtn && qrModal) closeModalBtn.addEventListener('click', () => qrModal.classList.add('hidden'));

// --- SOCKET.IO REMOTE LISTENING ---
socket.on('load-full-state', (state) => {
    if (isElectron) return; 

    if (state && state.isOpen) {
        notebookPages = []; 
        applyTheme(state.settings ? state.settings.theme : 'white');
        if (state.settings && state.settings.projectName && projectNameDisplay) projectNameDisplay.innerText = state.settings.projectName;
        
        initVirtualScroll(state.totalPages);
    } else {
        if (pageStack) {
            pageStack.innerHTML = `<div style="margin: auto; margin-top: 20vh; text-align: center; color: #888;">
                <h2>Waiting for ScribeSync Host...</h2>
                <p>Please open a notebook on your computer to begin syncing.</p>
            </div>`;
        }
    }
});

// The iPad requested a page and the server delivered it!
socket.on('deliver-page', (data) => {
    if (isElectron) return;
    notebookPages[data.pageIndex] = data.data;
    
    // Find the skeleton and inject the UI now that we have data
    const containerDiv = document.querySelector(`.a4-page-container[data-page-index="${data.pageIndex}"]`);
    if (containerDiv && containerDiv.classList.contains('mounted')) {
        buildPageUI(data.pageIndex, containerDiv);
    }
});

let remoteX = 0, remoteY = 0;
socket.on('remote-start-stream', (data) => { remoteX = data.x; remoteY = data.y; });

socket.on('remote-stream-point', (data) => {
    const targetCanvas = document.querySelector(`.a4-page-container[data-page-index="${activePageIndex}"] .page-ink-layer`);
    if (!targetCanvas) return;
    const ctx = targetCanvas.getContext('2d');
    
    if (data.isEraser && data.eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; 
    else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = data.color; }
    
    ctx.lineWidth = (data.size || 3) * 2; 
    ctx.lineCap = 'round'; 
    ctx.lineJoin = 'round';
    ctx.beginPath(); 
    ctx.moveTo(remoteX, remoteY); 
    ctx.lineTo(data.x, data.y); 
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over'; 
    
    remoteX = data.x; remoteY = data.y;
});

socket.on('update-active-page', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex] = data.data;
        requestRedraw(data.pageIndex);
        const textDiv = document.querySelector(`.a4-page-container[data-page-index="${data.pageIndex}"] .page-text-layer`);
        if(textDiv && document.activeElement !== textDiv) textDiv.innerHTML = data.data.text || '';
        
        syncPageToDisk(data.pageIndex); 
    }
});

socket.on('add-stroke-batch', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex].strokes.push(...data.strokes);
        requestRedraw(data.pageIndex);
        syncPageToDisk(data.pageIndex); 
    }
});

socket.on('delete-strokes', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex].strokes = notebookPages[data.pageIndex].strokes.filter(s => !data.strokeIds.includes(s.id));
        requestRedraw(data.pageIndex);
        syncPageToDisk(data.pageIndex); 
    }
});

updateCanvasInteractivity();