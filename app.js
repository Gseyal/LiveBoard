// --- 1. SOCKET.IO SETUP ---
// Dynamically connect using the laptop's Wi-Fi IP address
const socket = io(`http://${window.location.hostname}:3000`);

// --- 2. DOM ELEMENTS & STATE ---
const canvas = document.getElementById('ink-layer');
const ctx = canvas.getContext('2d');
const scrollWrapper = document.getElementById('scroll-wrapper');
const textLayer = document.getElementById('text-layer');
const container = document.getElementById('notebook-container');
const toggleBtn = document.getElementById('mode-toggle');
const clearBtn = document.getElementById('clear-btn');

let allStrokes = [];

// --- 3. THE SYNC ENGINE (RECEIVING) ---

// A. Initial Load / Full Replacements (Clearing)
socket.on('init-data', (data) => {
    if (data.text) textLayer.innerHTML = data.text;
    if (data.strokes) allStrokes = data.strokes;
    resizeAndRedrawCanvas();
});

socket.on('receive-strokes', (fullArray) => {
    allStrokes = fullArray;
    resizeAndRedrawCanvas();
});

// B. Receive Text
socket.on('receive-text', (newText) => {
    if (document.activeElement !== textLayer) {
        textLayer.innerHTML = newText;
        resizeAndRedrawCanvas();
    }
});

// C. Receive Batch Strokes (When other device pauses)
socket.on('receive-stroke-batch', (batch) => {
    allStrokes.push(...batch);
    resizeAndRedrawCanvas();
});

// --- 4. THE SYNC ENGINE (SENDING TEXT) ---
let typingTimer;
textLayer.addEventListener('input', () => {
    resizeAndRedrawCanvas(); 
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        socket.emit('update-text', textLayer.innerHTML);
    }, 500); 
});

// --- 5. LIVE STREAMING RECEIVERS (Visual Illusion) ---
let remoteX = 0;
let remoteY = 0;

socket.on('remote-start-stream', (coords) => {
    remoteX = coords.x;
    remoteY = coords.y;
});

socket.on('remote-stream-point', (coords) => {
    ctx.beginPath();
    ctx.moveTo(remoteX, remoteY);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    remoteX = coords.x;
    remoteY = coords.y;
});

// --- 6. CLEAR INK LOGIC ---
clearBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear all ink?")) {
        allStrokes = []; 
        resizeAndRedrawCanvas(); 
        socket.emit('update-strokes', []); 
    }
});

// --- 7. CANVAS RENDERING LOGIC ---
function resizeAndRedrawCanvas() {
    canvas.width = scrollWrapper.clientWidth;
    canvas.height = scrollWrapper.scrollHeight; 
    
    ctx.strokeStyle = 'rgba(0, 110, 255, 0.8)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    allStrokes.forEach(stroke => {
        if (!stroke || stroke.length === 0) return;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) {
            ctx.lineTo(stroke[i].x, stroke[i].y);
        }
        ctx.stroke();
    });
}
window.addEventListener('resize', resizeAndRedrawCanvas);

// --- 8. DEVICE MODE TOGGLE ---
let isIpadMode = false;
toggleBtn.addEventListener('click', () => {
    isIpadMode = !isIpadMode;
    if (isIpadMode) {
        container.classList.add('ipad-mode');
        toggleBtn.innerText = "Current Mode: iPad (Drawing)";
        toggleBtn.style.backgroundColor = "#e3f2fd";
        toggleBtn.style.borderColor = "#2196f3";
        toggleBtn.style.color = "#0d47a1";
    } else {
        container.classList.remove('ipad-mode');
        toggleBtn.innerText = "Current Mode: Laptop (Typing)";
        toggleBtn.style.backgroundColor = "white";
        toggleBtn.style.borderColor = "#ccc";
        toggleBtn.style.color = "black";
    }
});

// --- 9. INTERACTIVE DRAWING ENGINE ---
let isDrawing = false;
let lastX = 0, lastY = 0;
let currentStroke = [];

function getCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
    // Palm Rejection
    if (!isIpadMode || (e.pointerType === 'touch')) return;
    
    isDrawing = true;
    const coords = getCoordinates(e);
    lastX = coords.x; lastY = coords.y;
    currentStroke = [{ x: lastX, y: lastY }];

    socket.emit('start-stream', { x: lastX, y: lastY });
});

canvas.addEventListener('pointermove', (e) => {
    if (!isDrawing || !isIpadMode || (e.pointerType === 'touch')) return;
    
    const coords = getCoordinates(e);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    
    currentStroke.push({ x: coords.x, y: coords.y });
    
    socket.emit('stream-point', { x: coords.x, y: coords.y });

    lastX = coords.x; lastY = coords.y;
});

// --- 10. THE IDLE BATCH SENDER (Zero-Lag Fix) ---
// --- 10. THE IDLE BATCH SENDER (Bulletproof Version) ---
let strokeBatch = []; 
let batchSendTimer = null;   

function handlePointerUpOut(e) {
    // STRICT GUARD: If we aren't currently drawing, ignore this completely.
    if (!isDrawing) return; 
    
    // Ignore palm touches
    if (e.pointerType === 'touch') return;

    // We are officially lifting the pen.
    isDrawing = false;
        
    if (currentStroke.length > 0) {
        // 1. Instantly free the pen
        const strokeToSave = currentStroke;
        currentStroke = []; 
        
        // 2. Save locally
        async function saveStroke() {
            await allStrokes.push(strokeToSave);
        }
        saveStroke();
        
        // 3. Add to batch box
        async function addToBatch() {
            await strokeBatch.push(strokeToSave);
        }
        addToBatch();
        
        // --- THE TIMER LOGIC ---
        // Cancel the previous countdown
        clearTimeout(batchSendTimer);
        
        console.log("batc");
        
        // Start a fresh 2-second countdown
        batchSendTimer = setTimeout(() => {
            if (strokeBatch.length > 0) {
                console.log("🚀 5 Seconds Idle! Sending batch to network now.");
                socket.emit('add-stroke-batch', strokeBatch);
                strokeBatch = []; // Empty the box
            }
        }, 5000); 
    }
}

// Ensure these are the ONLY pointerup/pointerout listeners for the canvas in your whole file!
canvas.addEventListener('pointerup', handlePointerUpOut);
canvas.addEventListener('pointerout', handlePointerUpOut);