const canvas = document.getElementById('ink-layer');
const ctx = canvas.getContext('2d');
const scrollWrapper = document.getElementById('scroll-wrapper');
const textLayer = document.getElementById('text-layer');
const container = document.getElementById('notebook-container');
const toggleBtn = document.getElementById('mode-toggle');

// --- 1. THE INK DATABASE (Memory) ---
let allStrokes = []; // Stores every finished line
let currentStroke = []; // Stores the line you are currently drawing

// --- 2. CANVAS SETUP & REDRAW LOGIC ---
function resizeAndRedrawCanvas() {
    // Resize canvas to match the full height of the text (even the hidden scrolled parts)
    canvas.width = scrollWrapper.clientWidth;
    canvas.height = scrollWrapper.scrollHeight; 
    
    // Resizing a canvas clears it, so we must reapply our pen styles
    ctx.strokeStyle = 'rgba(0, 110, 255, 0.8)'; // Nice pen blue
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Loop through memory and redraw all saved strokes
    allStrokes.forEach(stroke => {
        if (stroke.length === 0) return;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) {
            ctx.lineTo(stroke[i].x, stroke[i].y);
        }
        ctx.stroke();
    });
}

// Keep canvas synced when window resizes OR when user types (which expands the page)
window.addEventListener('resize', resizeAndRedrawCanvas);
textLayer.addEventListener('input', resizeAndRedrawCanvas);

// Initialize
resizeAndRedrawCanvas(); 


// --- 3. DEVICE MODE TOGGLE ---
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


// --- 4. INTERACTIVE DRAWING ENGINE ---
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// This calculates the exact mouse position relative to the canvas, accounting for scroll!
function getCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

function startDrawing(e) {
    if (!isIpadMode) return;
    isDrawing = true;
    const coords = getCoordinates(e);
    lastX = coords.x;
    lastY = coords.y;
    currentStroke = [{ x: lastX, y: lastY }]; // Start a fresh stroke in memory
}

function draw(e) {
    if (!isDrawing || !isIpadMode) return;
    const coords = getCoordinates(e);

    // Visually draw the ink on the screen
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();

    // Save this point to our memory array
    currentStroke.push({ x: coords.x, y: coords.y });

    lastX = coords.x;
    lastY = coords.y;
}

function stopDrawing() {
    if (isDrawing) {
        isDrawing = false;
        // The pen lifted! Save the finished stroke to our master database
        if (currentStroke.length > 0) {
            allStrokes.push(currentStroke);
        }
        currentStroke = [];
    }
}

// Using 'pointer' events supports mouse, touch, AND Apple Pencil automatically
canvas.addEventListener('pointerdown', startDrawing);
canvas.addEventListener('pointermove', draw);
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointerout', stopDrawing);