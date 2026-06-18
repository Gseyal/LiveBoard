// --- FOOLPROOF HOST DETECTION ---
const isElectron = (typeof window !== 'undefined' && (
    window.require || 
    (window.process && window.process.versions && window.process.versions.electron) ||
    navigator.userAgent.toLowerCase().includes('electron')
));
const ipcRenderer = isElectron ? (window.require ? window.require('electron').ipcRenderer : window.electron?.ipcRenderer) : null;
const jsPDF = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : null;

const serverIP = window.location.hostname || 'localhost';
const socket = io(`http://${serverIP}:3000`);

// DOM Elements
const scrollWrapper = document.getElementById('scroll-wrapper');
const pageStack = document.getElementById('page-stack'); 
const container = document.getElementById('notebook-container');
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
const statusPageNum = document.getElementById('status-page-num');

// App State
let currentTool = 'pen'; // Start in 'iPad Mode' (drawing locked)
let currentNotebookPath = null;
let currentZoom = 1.0;
let eraserMode = 'delete'; 
let totalNotebookPages = 0;

let notebookPages = []; 
let activePageIndex = 0; 

brushSizeSlider.addEventListener('input', (e) => { brushSizeVal.innerText = e.target.value; });

function applyZoom() {
    scrollWrapper.style.transform = `scale(${currentZoom})`;
    if(zoomDisplay) zoomDisplay.innerText = `${Math.round(currentZoom * 100)}%`;
    if(zoomSlider) zoomSlider.value = Math.round(currentZoom * 100);
}

function getCoords(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
}

function escapeHtml(text) { return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

// --- FILE SYNCING ENGINE ---
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

// --- DOM VIRTUALIZATION & INFINITE SCROLL ---
const pageObserver = new IntersectionObserver(async (entries) => {
    for (const entry of entries) {
        const pageIndex = parseInt(entry.target.dataset.pageIndex);

        if (entry.isIntersecting) {
            if (!entry.target.classList.contains('mounted')) {
                entry.target.classList.add('mounted');

                if (!notebookPages[pageIndex]) {
                    if (isElectron) {
                        notebookPages[pageIndex] = await ipcRenderer.invoke('fs:loadPage', currentNotebookPath, pageIndex);
                        buildPageUI(pageIndex, entry.target);
                    } else {
                        socket.emit('request-page', pageIndex);
                    }
                } else {
                    buildPageUI(pageIndex, entry.target);
                }
            }
        } else {
            if (entry.target.classList.contains('mounted')) {
                entry.target.classList.remove('mounted');
                syncPageToDisk(pageIndex); 
                entry.target.innerHTML = ''; 
                Object.keys(imageCache).forEach(k => delete imageCache[k]);
            }
        }
    }
}, { root: scrollWrapper, rootMargin: '1500px 0px' }); 

function initVirtualScroll(totalPages) {
    if (!pageStack) return;
    pageStack.innerHTML = ''; 
    pageObserver.disconnect();
    totalNotebookPages = totalPages;

    for (let i = 0; i < totalPages; i++) {
        const containerDiv = document.createElement('div');
        containerDiv.className = 'a4-page-container';
        containerDiv.dataset.pageIndex = i;
        pageStack.appendChild(containerDiv);
        pageObserver.observe(containerDiv); 
    }
}

function buildPageUI(pageIndex, containerDiv) {
    if (!notebookPages[pageIndex]) return; 
    containerDiv.innerHTML = ''; 

    const textDiv = document.createElement('div');
    textDiv.className = 'page-text-layer';
    textDiv.contentEditable = true;
    textDiv.innerHTML = escapeHtml(notebookPages[pageIndex].text || '').replace(/\n/g, '<br>');
    
    textDiv.addEventListener('focus', () => { activePageIndex = pageIndex; });
    textDiv.addEventListener('click', () => { activePageIndex = pageIndex; });

    let typingTimer;
    textDiv.addEventListener('input', (e) => {
        clearTimeout(typingTimer);
        notebookPages[pageIndex].text = e.target.innerText; // The plain text HTML fix
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

if (scrollWrapper) {
    scrollWrapper.addEventListener('scroll', () => {
        if (isElectron && !currentNotebookPath) return;
        if (!isElectron && totalNotebookPages === 0) return;

        const pageContainers = document.querySelectorAll('.a4-page-container');
        let maxVisibleArea = 0;
        
        pageContainers.forEach(container => {
            const rect = container.getBoundingClientRect();
            const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 60));
            
            if (visibleHeight > maxVisibleArea) {
                maxVisibleArea = visibleHeight;
                activePageIndex = parseInt(container.dataset.pageIndex);
                if (statusPageNum) statusPageNum.innerText = (activePageIndex + 1);
            }
        });

        if (scrollWrapper.scrollTop + scrollWrapper.clientHeight >= scrollWrapper.scrollHeight - 300) {
            const newIndex = totalNotebookPages;
            totalNotebookPages++;
            notebookPages[newIndex] = { strokes: [], text: "" }; 
            
            const containerDiv = document.createElement('div');
            containerDiv.className = 'a4-page-container';
            containerDiv.dataset.pageIndex = newIndex;
            pageStack.appendChild(containerDiv);
            
            pageObserver.observe(containerDiv); 
            pushPageUpdate(newIndex); 
        }
    });
}

// --- RENDER ENGINE ---
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
        
        ctx.strokeStyle = '#2b579a'; ctx.lineWidth = 4; ctx.setLineDash([10, 10]); ctx.strokeRect(img.x, img.y, img.w, img.h); ctx.setLineDash([]); 
        ctx.fillStyle = 'white'; const hSize = 24; 
        const drawHandle = (x, y) => { ctx.fillRect(x - hSize/2, y - hSize/2, hSize, hSize); ctx.strokeRect(x - hSize/2, y - hSize/2, hSize, hSize); };
        drawHandle(img.x, img.y); drawHandle(img.x + img.w, img.y); drawHandle(img.x, img.y + img.h); drawHandle(img.x + img.w, img.y + img.h); 
    }
}

// --- POINTER EVENTS (WITH SMART PALM REJECTION) ---
let isDrawing = false, lastX = 0, lastY = 0, currentStroke = {};

function attachPointerEvents(canvas, pageIndex) {
    // 1. SMART SCROLL LOCK: Block scrolling if ANY Draw tool is active
    canvas.addEventListener('touchstart', (e) => { 
        if (currentTool !== 'none') e.preventDefault(); 
    }, { passive: false });
    
    document.addEventListener('contextmenu', (e) => { 
        if (currentTool !== 'none') e.preventDefault(); 
    });

    canvas.addEventListener('pointerdown', (e) => {
        // 2. PALM REJECTION: Ignore fingers entirely if a Draw tool is active
        if (currentTool !== 'none' && e.pointerType === 'touch') return;
        
        activePageIndex = pageIndex; 
        const coords = getCoords(e, canvas);

        if (currentTool === 'image-placer') {
            const newImg = { id: generateStrokeId(), type: 'image', src: imgPreview.src || imgPreview.dataset.dataUrl, x: coords.x - imgPreview.width / 2, y: coords.y - imgPreview.height / 2, w: imgPreview.width, h: imgPreview.height };
            notebookPages[pageIndex].strokes.push(newImg); 
            imgPreview.style.display = 'none'; 
            if (penBtn) setTool('pen', penBtn); 
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
        const aColor = colorPicker ? colorPicker.value : '#2b579a'; 
        const isEraser = (currentTool === 'eraser'); 
        const aSize = brushSizeSlider ? parseInt(brushSizeSlider.value, 10) : 3;
        currentStroke = { id: generateStrokeId(), type: 'stroke', color: eraserMode === 'white' && isEraser ? '#ffffff' : aColor, isEraser: isEraser, eraserMode: isEraser ? eraserMode : null, size: aSize, path: [{ x: lastX, y: lastY }] };
        
        socket.emit('start-stream', { pageIndex: pageIndex, x: lastX, y: lastY });
    });

    canvas.addEventListener('pointermove', (e) => {
        // SMART PALM REJECTION
        if (currentTool !== 'none' && e.pointerType === 'touch') return;
        
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
        
        socket.emit('stream-point', { 
            pageIndex: pageIndex, color: currentStroke.color, isEraser: currentStroke.isEraser, 
            eraserMode: currentStroke.eraserMode, size: currentStroke.size, 
            x: coords.x, y: coords.y 
        });
        lastX = coords.x; lastY = coords.y;
    });

    const handlePointerUp = (e) => {
        if (currentTool === 'select' && isTransforming && selectedItemPage === pageIndex) { 
            isTransforming = false; transformMode = null; 
            requestRedraw(pageIndex); pushPageUpdate(pageIndex); return; 
        }
        
        // SMART PALM REJECTION
        if (currentTool !== 'none' && e.pointerType === 'touch') return;
        
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
                    requestRedraw(pageIndex); 
                    socket.emit('delete-strokes', { pageIndex: pageIndex, strokeIds: removedStrokeIds });
                }
            } else {
                pageStrokes.push(currentStroke); 
                requestRedraw(pageIndex); 
                socket.emit('add-stroke-batch', { pageIndex: pageIndex, strokes: [currentStroke] });
            }
            currentStroke = {}; 
        }
    };

    canvas.addEventListener('pointerup', handlePointerUp); 
    canvas.addEventListener('pointerout', handlePointerUp);
}

// --- UI EVENT LISTENERS & SMART TOOL TOGGLING ---
function setTool(toolName, btnElement) {
    if (currentTool === toolName) {
        // TURN OFF: Drop into Laptop Mode (Scroll/Type)
        currentTool = 'none';
        btnElement.classList.remove('active');
        if (deleteSelectedBtn) deleteSelectedBtn.classList.add('disabled');
    } else {
        // TURN ON: Activate iPad Mode (Draw/Select)
        currentTool = toolName;
        if (selectBtn) selectBtn.classList.remove('active');
        if (penBtn) penBtn.classList.remove('active');
        if (eraserBtn) eraserBtn.classList.remove('active');
        btnElement.classList.add('active');
        
        if (toolName === 'select' && deleteSelectedBtn) deleteSelectedBtn.classList.remove('disabled');
        else if (deleteSelectedBtn) deleteSelectedBtn.classList.add('disabled');
    }
    imgPreview.style.display = 'none';
    requestRedraw(activePageIndex);
    updateCanvasInteractivity();
}

if(selectBtn) selectBtn.addEventListener('click', () => setTool('select', selectBtn));
if(penBtn) penBtn.addEventListener('click', () => setTool('pen', penBtn));
if(eraserBtn) eraserBtn.addEventListener('click', () => setTool('eraser', eraserBtn));

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
    
    currentPageIndex = index;
    allStrokes = notebookPages[currentPageIndex].strokes || [];
    textLayer.innerHTML = notebookPages[currentPageIndex].text || "";
    
    if(pageDisplay) pageDisplay.innerText = `Page ${currentPageIndex + 1}/${notebookPages.length}`;
    resizeAndRedrawCanvas();
    triggerAutoSave();
}
if(bgSelect) bgSelect.addEventListener('change', (e) => applyTheme(e.target.value));

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
    if (selectedItemIndex < 0 || selectedItemPage < 0) return;
    notebookPages[selectedItemPage].strokes.splice(selectedItemIndex, 1);
    const updatedPage = selectedItemPage;
    selectedItemIndex = -1; selectedItemPage = -1; isTransforming = false; transformMode = null;
    requestRedraw(updatedPage); pushPageUpdate(updatedPage); 
}
if(deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', deleteSelectedItem);

if(eraserModeBtn) eraserModeBtn.addEventListener('click', () => { 
    eraserMode = eraserMode === 'delete' ? 'white' : 'delete'; 
    eraserModeBtn.innerText = eraserMode === 'delete' ? 'Stroke' : 'White'; 
});
if(colorPicker && penBtn) colorPicker.addEventListener('input', () => {
    if(currentTool !== 'pen') setTool('pen', penBtn);
});

document.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && currentTool === 'select' && selectedItemIndex > -1) {
        if (document.activeElement && !document.activeElement.classList.contains('page-text-layer')) {
            e.preventDefault(); deleteSelectedItem();
        }
    }
});

window.addEventListener('paste', async (e) => {
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

// --- RIBBON TAB SWITCHING LOGIC ---
const ribbonTabs = document.querySelectorAll('.tab:not(.file-tab)');
const ribbonToolbars = document.querySelectorAll('.ribbon-toolbar');

ribbonTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        ribbonTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        ribbonToolbars.forEach(tb => tb.style.display = 'none');

        const targetId = tab.getAttribute('data-target');
        if (targetId) {
            const targetToolbar = document.getElementById(targetId);
            if (targetToolbar) targetToolbar.style.display = 'flex';
        }
    });
});



// --- ELECTRON IPC LISTENERS ---
if (isElectron) {
    ipcRenderer.on('menu-action', (event, payload) => {
        if (payload.action === 'new') {
            currentNotebookPath = payload.path;
            if(projectNameDisplay) projectNameDisplay.innerText = `${payload.projectName}.scribe`;
            
            notebookPages = []; 
            activePageIndex = 0;
            initVirtualScroll(1);
            syncSettingsToDisk(); syncPageToDisk(0);
            
            socket.emit('host-set-full-state', { isOpen: true, totalPages: 1, settings: { theme: bgSelect ? bgSelect.value : 'white', projectName: payload.projectName } });
            updateCanvasInteractivity();
        } 
        else if (payload.action === 'open') {
            const data = JSON.parse(payload.data);
            currentNotebookPath = payload.folderPath;
            if(projectNameDisplay) projectNameDisplay.innerText = `${payload.projectName}.scribe`;
            
            notebookPages = []; 
            notebookPages[0] = data.firstPage || { strokes: [], text: "" };
            applyTheme(data.settings.theme || 'white');
            
            initVirtualScroll(data.totalPages || 1);
            
            socket.emit('host-set-full-state', { isOpen: true, totalPages: data.totalPages || 1, settings: { theme: data.settings ? data.settings.theme : 'white', projectName: payload.projectName } });
            updateCanvasInteractivity();
        }
    });
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
    notebookPages = state.pages;
    applyPageSettings(state.settings.theme, state.settings.pageSize, state.settings.canvasHeight, state.settings.projectName);
    loadPage(state.currentPageIndex, true);
});
socket.on('set-project-folder', (folderName) => {
    console.log('Browser received project folder:', folderName);
    currentProjectFolder = folderName; // Store project folder for browser uploads
});
socket.on('receive-page-settings', (settings) => { applyPageSettings(settings.theme, settings.pageSize, settings.canvasHeight, settings.projectName); });
socket.on('remote-page-changed', (index) => { loadPage(index, true); });
socket.on('remote-page-added', (state) => { notebookPages = state.pages; loadPage(state.currentPageIndex, true); });
socket.on('receive-active-page', (pageData) => { allStrokes = pageData.strokes; textLayer.innerHTML = pageData.text; resizeAndRedrawCanvas(); triggerAutoSave(); });
socket.on('receive-stroke-batch', (batch) => { allStrokes.push(...batch); resizeAndRedrawCanvas(); triggerAutoSave(); });

socket.on('deliver-page', (data) => {
    if (isElectron) return;
    notebookPages[data.pageIndex] = data.data;
    
    const containerDiv = document.querySelector(`.a4-page-container[data-page-index="${data.pageIndex}"]`);
    if (containerDiv && containerDiv.classList.contains('mounted')) {
        buildPageUI(data.pageIndex, containerDiv);
    }
});

let remoteStreams = {}; 

socket.on('remote-start-stream', (data) => { 
    if (!remoteStreams[data.pageIndex]) remoteStreams[data.pageIndex] = {};
    remoteStreams[data.pageIndex].x = data.x; 
    remoteStreams[data.pageIndex].y = data.y; 
});

socket.on('remote-stream-point', (data) => {
    const targetCanvas = document.querySelector(`.a4-page-container[data-page-index="${data.pageIndex}"] .page-ink-layer`);
    
    if (!targetCanvas || !remoteStreams[data.pageIndex]) return;
    const ctx = targetCanvas.getContext('2d');
    
    if (data.isEraser && data.eraserMode === 'delete') ctx.globalCompositeOperation = 'destination-out'; 
    else { ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = data.color; }
    
    ctx.lineWidth = (data.size || 3) * 2; 
    ctx.lineCap = 'round'; 
    ctx.lineJoin = 'round';
    ctx.beginPath(); 
    
    ctx.moveTo(remoteStreams[data.pageIndex].x, remoteStreams[data.pageIndex].y); 
    ctx.lineTo(data.x, data.y); 
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over'; 
    
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

socket.on('update-active-page', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex] = data.data;
        requestRedraw(data.pageIndex);
        const textDiv = document.querySelector(`.a4-page-container[data-page-index="${data.pageIndex}"] .page-text-layer`);
        if(textDiv && document.activeElement !== textDiv) {
            textDiv.innerHTML = escapeHtml(data.data.text || '').replace(/\n/g, '<br>');
        }
    }
});

socket.on('add-stroke-batch', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex].strokes.push(...data.strokes);
        requestRedraw(data.pageIndex);
    }
});

socket.on('delete-strokes', (data) => {
    if(notebookPages[data.pageIndex]) {
        notebookPages[data.pageIndex].strokes = notebookPages[data.pageIndex].strokes.filter(s => !data.strokeIds.includes(s.id));
        requestRedraw(data.pageIndex);
    }
});

// --- DESKTOP WELCOME SCREEN ---
function showWelcomeScreen() {
    if (!pageStack) return;
    
    isDrawing = true; lastX = coords.x; lastY = coords.y; const activeColor = colorPicker.value; const isEraser = (currentTool === 'eraser'); const activeSize = parseInt(brushSizeSlider.value, 10);
    const eraserColor = eraserMode === 'white' ? '#ffffff' : activeColor;
    currentStroke = { type: 'stroke', color: eraserColor, isEraser: isEraser, eraserMode: isEraser ? eraserMode : null, size: activeSize, path: [{ x: lastX, y: lastY }] };
    socket.emit('start-stream', { color: eraserColor, isEraser: isEraser, size: activeSize, x: lastX, y: lastY });
});

    // 1. Grab the buttons
    const newBtn = document.getElementById('welcome-new-btn');
    const openBtn = document.getElementById('welcome-open-btn');

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
document.addEventListener('DOMContentLoaded', () => {
    if (isElectron && !currentNotebookPath) {
        showWelcomeScreen();
    }
});

updateCanvasInteractivity();