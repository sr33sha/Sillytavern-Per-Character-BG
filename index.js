import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } from "../../../../script.js";
import { extension_settings, getContext, setExtensionPrompt } from "../../../extensions.js";
import { getSanitizedFilename } from "../../../utils.js";

const extName = "TT-Character-Backgrounds";
const BG_MODULE_NAME = "char_bg_data";
const BG_FOLDER = "per-character-bg";
const OVERLAY_ID = "tt_char_bg_overlay";
const TAB_ID = "bg_character_tab";
const TAB_LABEL = "Character";
const NUM_SLOTS = 5;
const BG_MAX_SIDE = 1920;
const BG_JPEG_QUALITY = 0.8;
const DEFAULT_FX = { blur: 0, darkness: 0 };
const DEFAULT_COLOR = { mode: "gradient", c1: "#3b3f63", c2: "#15161f", angle: 160 };

if (!extension_settings[extName]) extension_settings[extName] = {};
const extSettings = extension_settings[extName];
if (!extSettings.characterScenes)       extSettings.characterScenes = {};
if (!extSettings.characterBackgroundFx) extSettings.characterBackgroundFx = {};

// ─── helpers ──────────────────────────────────────────────────────────────────

function getFx(avatar) {
    return { ...DEFAULT_FX, ...(extSettings.characterBackgroundFx[avatar] ?? {}) };
}

function getScenes(avatar) {
    if (!extSettings.characterScenes[avatar]) {
        extSettings.characterScenes[avatar] = Array(NUM_SLOTS).fill(null);
    }
    while (extSettings.characterScenes[avatar].length < NUM_SLOTS) {
        extSettings.characterScenes[avatar].push(null);
    }
    return extSettings.characterScenes[avatar];
}

function getCurrentChar() {
    const { characterId, characters } = getContext();
    if (characterId === undefined || characterId === null || characterId === "") return null;
    return characters?.[characterId] ?? null;
}

function safeId(s) {
    return (s || "").replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorToCss(slot) {
    if (slot.mode === "solid") return slot.c1;
    return `linear-gradient(${slot.angle ?? 160}deg, ${slot.c1}, ${slot.c2 ?? "#15161f"})`;
}

function toUrl(path) {
    if (!path) return "";
    if (path.startsWith("http") || path.startsWith("/")) return path;
    return `/${path}`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

// ─── image handling ────────────────────────────────────────────────────────────

async function toSmallJpegDataUrl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, BG_MAX_SIDE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
            const w = Math.round(img.naturalWidth * scale);
            const h = Math.round(img.naturalHeight * scale);
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", BG_JPEG_QUALITY));
        };
        img.onerror = reject;
        img.crossOrigin = "anonymous";
        img.src = src;
    });
}

async function uploadSceneImage(charName, sceneName, srcDataUrl) {
    const dataUrl = await toSmallJpegDataUrl(srcDataUrl);
    const match = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error("Not a base64 image data URL");
    const response = await fetch("/api/images/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: match[2],
            format: match[1].replace("jpeg", "jpg"),
            ch_name: BG_FOLDER,
            filename: `${safeId(charName)}_${safeId(sceneName)}`,
        }),
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const { path } = await response.json();
    return String(path).replace(/^\/+/, "");
}

async function fetchCharImages(charName) {
    try {
        const response = await fetch("/api/images/list", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder: BG_FOLDER, sortField: "date", sortOrder: "desc", type: 1 }),
        });
        if (!response.ok) return [];
        const files = await response.json();
        const safeFolder = await getSanitizedFilename(BG_FOLDER);
        const prefix = safeId(charName) + "_";
        return files
            .filter(f => f.startsWith(prefix))
            .map(f => ({ filename: f, path: `user/images/${safeFolder}/${f}` }));
    } catch {
        return [];
    }
}

async function deleteImage(path) {
    if (!path) return;
    try {
        await fetch("/api/images/delete", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch {}
}

// ─── overlay ──────────────────────────────────────────────────────────────────

function getOverlay() {
    const bg1 = document.getElementById("bg1");
    if (!bg1) return null;
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        bg1.insertAdjacentElement("afterend", overlay);
    }
    return overlay;
}

function applyCharacterBackground(sceneName) {
    const bg1 = document.getElementById("bg1");
    const overlay = getOverlay();
    if (!bg1 || !overlay) return;
    const char = getCurrentChar();
    if (!char) {
        overlay.style.display = "none";
        return;
    }
    const scenes = getScenes(char.avatar);
    const fx = getFx(char.avatar);
    let slot = null;
    if (sceneName !== undefined && sceneName !== null && sceneName !== "null") {
        const name = String(sceneName).trim().toLowerCase();
        slot = scenes.find(s => s && s.name && s.name.toLowerCase() === name) ?? null;
        if (!slot) slot = scenes.find(s => s !== null) ?? null;
    } else {
        slot = scenes.find(s => s !== null) ?? null;
    }
    if (!slot) {
        overlay.style.backgroundImage = "";
        overlay.style.background = "";
        overlay.style.filter = "";
        overlay.style.transform = "";
        overlay.style.display = "none";
        return;
    }
    overlay.className = bg1.className;
    if (slot.type === "image") {
        overlay.style.backgroundImage = `url("${toUrl(slot.path)}")`;
        overlay.style.background = "";
    } else {
        overlay.style.backgroundImage = "";
        overlay.style.background = colorToCss(slot);
    }
    const blur = slot.type === "image" ? fx.blur : 0;
    overlay.style.filter = `blur(${blur}px) brightness(${1 - fx.darkness / 100})`;
    overlay.style.transform = blur > 0 ? `scale(${1 + blur * 0.006})` : "";
    overlay.style.display = "block";
}

function applyFxToCurrentOverlay() {
    const char = getCurrentChar();
    if (!char) return;
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay || overlay.style.display === "none") return;
    const fx = getFx(char.avatar);
    const isImage = !!overlay.style.backgroundImage;
    const blur = isImage ? fx.blur : 0;
    overlay.style.filter = `blur(${blur}px) brightness(${1 - fx.darkness / 100})`;
    overlay.style.transform = blur > 0 ? `scale(${1 + blur * 0.006})` : "";
}

// ─── prompt injection ──────────────────────────────────────────────────────────

function buildAndInjectBGData() {
    const char = getCurrentChar();
    if (!char) {
        setExtensionPrompt(BG_MODULE_NAME, "", 0, 1);
        return;
    }
    const scenes = getScenes(char.avatar);
    const names = scenes.filter(s => s && s.name).map(s => `"${s.name}"`);
    if (!names.length) {
        setExtensionPrompt(BG_MODULE_NAME, "", 0, 1);
        return;
    }
    const injection = `<BG_Data>\nAvailable backgrounds: ${names.join(", ")}\nSelect the background name that best fits the current scene state, or null if none apply.\n</BG_Data>`;
    setExtensionPrompt(BG_MODULE_NAME, injection, 0, 1);
}

// ─── message parsing ───────────────────────────────────────────────────────────

function parseBGLine(mes) {
    const m = mes.match(/^Background:\s*(.+)$/im);
    if (!m) return undefined;
    const val = m[1].trim();
    return val === "null" ? null : val;
}

// ─── events ────────────────────────────────────────────────────────────────────

function onMessageReceived() {
    const { chat } = getContext();
    if (!chat?.length) return;
    const lastAiMsg = chat.slice().reverse().find(m => !m.is_user);
    if (!lastAiMsg?.mes) return;
    const bgName = parseBGLine(lastAiMsg.mes);
    if (bgName === undefined || bgName === null) return;
    applyCharacterBackground(bgName);
}

function onChatChanged() {
    buildAndInjectBGData();
    applyCharacterBackground(undefined);
    requestAnimationFrame(() => {
        ensureCharacterTabExists();
        const panel = document.getElementById(TAB_ID);
        if (panel) renderCharacterTab(panel);
    });
}

// ─── UI helpers ────────────────────────────────────────────────────────────────

function makeSlider(labelText, min, max, unit, value, onInput) {
    const row = document.createElement("label");
    row.className = "tt-char-bg-slider-row";
    const text = document.createElement("span");
    text.className = "tt-char-bg-slider-label";
    const updateText = v => { text.textContent = `${labelText}: ${v}${unit}`; };
    updateText(value);
    const input = document.createElement("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = 1; input.value = value;
    input.className = "tt-char-bg-slider";
    input.oninput = () => { const v = Number(input.value); updateText(v); onInput(v); };
    row.append(text, input);
    return row;
}

function makeColorRow(labelText, value, onInput) {
    const row = document.createElement("label");
    row.className = "tt-char-bg-color-row";
    const text = document.createElement("span");
    text.textContent = labelText;
    const input = document.createElement("input");
    input.type = "color"; input.value = value; input.className = "tt-char-bg-color-input";
    input.oninput = () => onInput(input.value);
    row.append(text, input);
    return row;
}

function renderColorEditor(box, idx, slot, scenes, char, panel, nameInput) {
    const draft = slot?.type === "color" ? { ...DEFAULT_COLOR, ...slot } : { ...DEFAULT_COLOR };
    box.textContent = "";
    const swatch = document.createElement("div");
    swatch.className = "tt-char-bg-color-preview";
    const modeRow = document.createElement("label");
    modeRow.className = "tt-char-bg-color-row";
    const modeText = document.createElement("span");
    modeText.textContent = "Style";
    const modeSelect = document.createElement("select");
    modeSelect.className = "text_pole";
    modeSelect.innerHTML = `<option value="gradient">Soft gradient</option><option value="solid">Solid color</option>`;
    modeSelect.value = draft.mode;
    modeRow.append(modeText, modeSelect);
    const c1Row = makeColorRow("Color", draft.c1, v => { draft.c1 = v; refresh(); });
    const c2Row = makeColorRow("Second color", draft.c2, v => { draft.c2 = v; refresh(); });
    const angleSlider = makeSlider("Angle", 0, 360, "°", draft.angle, v => { draft.angle = v; refresh(); });
    const refresh = () => {
        swatch.style.background = colorToCss(draft);
        const isGrad = draft.mode === "gradient";
        c2Row.style.display = isGrad ? "" : "none";
        angleSlider.style.display = isGrad ? "" : "none";
    };
    modeSelect.onchange = () => { draft.mode = modeSelect.value; refresh(); };
    const applyBtn = document.createElement("button");
    applyBtn.className = "menu_button interactable";
    applyBtn.textContent = "Apply";
    applyBtn.onclick = () => {
        let sceneName = nameInput?.value?.trim();
        if (!sceneName) { sceneName = `scene${idx + 1}`; if (nameInput) nameInput.value = sceneName; }
        if (scenes[idx]?.type === "image" && scenes[idx].path) deleteImage(scenes[idx].path);
        scenes[idx] = { type: "color", name: sceneName, ...draft };
        saveSettingsDebounced();
        buildAndInjectBGData();
        applyCharacterBackground(sceneName);
        renderCharacterTab(panel);
    };
    box.append(swatch, modeRow, c1Row, c2Row, angleSlider, applyBtn);
    refresh();
}

function buildSlotEl(idx, slot, char, scenes, panel) {
    const { name: charName } = char;
    const slotEl = document.createElement("div");
    slotEl.className = "tt-char-bg-slot";

    const headerRow = document.createElement("div");
    headerRow.className = "tt-char-bg-slot-header";
    const slotLabel = document.createElement("span");
    slotLabel.className = "tt-char-bg-slot-num";
    slotLabel.textContent = `Slot ${idx + 1}`;
    headerRow.appendChild(slotLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "text_pole tt-char-bg-slot-name";
    nameInput.placeholder = "Scene name (e.g. palace)";
    nameInput.value = slot?.name ?? "";
    nameInput.addEventListener("input", () => {
        if (scenes[idx]) scenes[idx] = { ...scenes[idx], name: nameInput.value.trim() };
        saveSettingsDebounced();
        buildAndInjectBGData();
    });
    headerRow.appendChild(nameInput);

    const clearBtn = document.createElement("button");
    clearBtn.className = "menu_button interactable tt-char-bg-slot-clear";
    clearBtn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
    clearBtn.title = "Clear slot";
    clearBtn.addEventListener("click", () => {
        if (scenes[idx]?.type === "image" && scenes[idx].path) deleteImage(scenes[idx].path);
        scenes[idx] = null;
        saveSettingsDebounced();
        buildAndInjectBGData();
        renderCharacterTab(panel);
    });
    headerRow.appendChild(clearBtn);
    slotEl.appendChild(headerRow);

    if (slot) {
        const previewWrap = document.createElement("div");
        previewWrap.className = "tt-char-bg-slot-preview";
        if (slot.type === "image") {
            const img = document.createElement("img");
            img.className = "tt-char-bg-preview";
            img.src = toUrl(slot.path);
            img.alt = slot.name;
            previewWrap.appendChild(img);
        } else {
            const swatch = document.createElement("div");
            swatch.className = "tt-char-bg-color-preview";
            swatch.style.background = colorToCss(slot);
            previewWrap.appendChild(swatch);
        }
        slotEl.appendChild(previewWrap);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "tt-char-bg-slot-actions";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.className = "tt-char-bg-file-input";
    fileInput.accept = "image/*";
    slotEl.appendChild(fileInput);

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "menu_button interactable";
    uploadBtn.innerHTML = `<i class="fa-solid fa-upload"></i> Upload`;
    uploadBtn.addEventListener("click", () => fileInput.click());
    actionsRow.appendChild(uploadBtn);

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files[0];
        if (!file) return;
        let sceneName = nameInput.value.trim();
        if (!sceneName) {
            sceneName = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase() || `scene${idx + 1}`;
            nameInput.value = sceneName;
        }
        fileInput.value = "";
        try {
            if (scenes[idx]?.type === "image" && scenes[idx].path) deleteImage(scenes[idx].path);
            const dataUrl = await readFileAsDataUrl(file);
            const path = await uploadSceneImage(charName, sceneName, dataUrl);
            scenes[idx] = { type: "image", name: sceneName, path };
            saveSettingsDebounced();
            buildAndInjectBGData();
            renderCharacterTab(panel);
        } catch (err) {
            console.error("[Per-Character BG] Upload failed:", err);
        }
    });

    const galleryBtn = document.createElement("button");
    galleryBtn.className = "menu_button interactable";
    galleryBtn.innerHTML = `<i class="fa-solid fa-images"></i> Gallery`;
    actionsRow.appendChild(galleryBtn);

    const colorBtn = document.createElement("button");
    colorBtn.className = "menu_button interactable";
    colorBtn.innerHTML = `<i class="fa-solid fa-palette"></i> Color`;
    actionsRow.appendChild(colorBtn);

    slotEl.appendChild(actionsRow);

    const galleryBox = document.createElement("div");
    galleryBox.className = "tt-char-bg-gallery";
    galleryBox.style.display = "none";
    slotEl.appendChild(galleryBox);

    galleryBtn.addEventListener("click", () => {
        const opening = galleryBox.style.display === "none";
        galleryBox.style.display = opening ? "grid" : "none";
        if (!opening) return;
        galleryBox.textContent = "Loading...";
        fetchCharImages(charName).then(images => {
            galleryBox.textContent = "";
            if (!images.length) { galleryBox.textContent = "No images found for this character."; return; }
            for (const { filename, path } of images) {
                const thumb = document.createElement("img");
                thumb.className = "tt-char-bg-gallery-thumb";
                thumb.loading = "lazy";
                thumb.src = toUrl(path);
                thumb.title = filename;
                thumb.addEventListener("click", () => {
                    const prefix = safeId(charName) + "_";
                    const bare = filename.replace(/\.[^/.]+$/, "");
                    const sceneName = bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
                    if (scenes[idx]?.type === "image" && scenes[idx].path !== path.replace(/^\/+/, "")) {
                        deleteImage(scenes[idx].path);
                    }
                    scenes[idx] = { type: "image", name: sceneName, path: path.replace(/^\/+/, "") };
                    nameInput.value = sceneName;
                    saveSettingsDebounced();
                    buildAndInjectBGData();
                    renderCharacterTab(panel);
                });
                galleryBox.appendChild(thumb);
            }
        }).catch(() => { galleryBox.textContent = "Couldn't load gallery."; });
    });

    const colorBox = document.createElement("div");
    colorBox.className = "tt-char-bg-color-editor";
    colorBox.style.display = "none";
    slotEl.appendChild(colorBox);

    colorBtn.addEventListener("click", () => {
        const opening = colorBox.style.display === "none";
        colorBox.style.display = opening ? "flex" : "none";
        if (opening) renderColorEditor(colorBox, idx, slot, scenes, char, panel, nameInput);
    });

    return slotEl;
}

function renderCharacterTab(panel) {
    const char = getCurrentChar();
    panel.innerHTML = "";
    if (!char) {
        panel.textContent = "Open a character's chat to assign a background.";
        return;
    }
    const { avatar } = char;
    const scenes = getScenes(avatar);
    const fx = getFx(avatar);
    const wrapper = document.createElement("div");
    wrapper.className = "tt-char-bg-panel";

    const header = document.createElement("div");
    header.className = "tt-char-bg-label";
    header.textContent = `Backgrounds for ${char.name}`;
    wrapper.appendChild(header);

    for (let i = 0; i < NUM_SLOTS; i++) {
        wrapper.appendChild(buildSlotEl(i, scenes[i], char, scenes, panel));
    }

    const divider = document.createElement("hr");
    wrapper.appendChild(divider);

    const fxHeader = document.createElement("div");
    fxHeader.className = "tt-char-bg-label";
    fxHeader.textContent = "Effects (all backgrounds)";
    wrapper.appendChild(fxHeader);

    wrapper.appendChild(makeSlider("Blur", 0, 20, "px", fx.blur, v => {
        if (!extSettings.characterBackgroundFx[avatar]) extSettings.characterBackgroundFx[avatar] = { ...DEFAULT_FX };
        extSettings.characterBackgroundFx[avatar].blur = v;
        saveSettingsDebounced();
        applyFxToCurrentOverlay();
    }));
    wrapper.appendChild(makeSlider("Darkness", 0, 100, "%", fx.darkness, v => {
        if (!extSettings.characterBackgroundFx[avatar]) extSettings.characterBackgroundFx[avatar] = { ...DEFAULT_FX };
        extSettings.characterBackgroundFx[avatar].darkness = v;
        saveSettingsDebounced();
        applyFxToCurrentOverlay();
    }));

    panel.appendChild(wrapper);
}

// ─── tab management ────────────────────────────────────────────────────────────

function ensureCharacterTabExists() {
    if (document.getElementById(TAB_ID)) return;
    const tabsList = document.querySelector("#bg_tabs .bg_tabs_list");
    const tabsRoot = document.getElementById("bg_tabs");
    if (!tabsList || !tabsRoot) return;

    const tabItem = document.createElement("li");
    tabItem.className = "bg_tab_button interactable ui-tabs-tab ui-corner-top ui-state-default ui-tab";
    tabItem.setAttribute("role", "tab");
    tabItem.innerHTML = `<a href="#${TAB_ID}" class="ui-tabs-anchor" tabindex="-1">${TAB_LABEL}</a>`;
    tabsList.appendChild(tabItem);

    const panel = document.createElement("div");
    panel.id = TAB_ID;
    panel.className = "bg_tab_panel ui-tabs-panel ui-corner-bottom ui-widget-content";
    panel.setAttribute("role", "tabpanel");
    tabsRoot.appendChild(panel);

    if (window.jQuery?.fn?.tabs) jQuery("#bg_tabs").tabs("refresh");
    renderCharacterTab(panel);
}

let rafScheduled = false;
function scheduleEnsureCharacterTabExists() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; ensureCharacterTabExists(); });
}

// ─── migration ─────────────────────────────────────────────────────────────────

function migrateOldData() {
    const hasBgs = extSettings.characterBackgrounds && Object.keys(extSettings.characterBackgrounds).length > 0;
    const hasColors = extSettings.characterColors && Object.keys(extSettings.characterColors).length > 0;
    if (!hasBgs && !hasColors) return;

    const avatars = new Set([
        ...Object.keys(extSettings.characterBackgrounds ?? {}),
        ...Object.keys(extSettings.characterColors ?? {}),
    ]);
    let migrated = false;
    for (const avatar of avatars) {
        if (extSettings.characterScenes[avatar]) continue;
        const scenes = Array(NUM_SLOTS).fill(null);
        const oldBg = extSettings.characterBackgrounds?.[avatar];
        const oldColor = extSettings.characterColors?.[avatar];
        if (oldBg && typeof oldBg === "string") {
            scenes[0] = { type: "image", name: "scene1", path: oldBg.replace(/^\/+/, "") };
        } else if (oldColor) {
            scenes[0] = { type: "color", name: "scene1", ...oldColor };
        }
        extSettings.characterScenes[avatar] = scenes;
        migrated = true;
    }
    if (migrated) {
        delete extSettings.characterBackgrounds;
        delete extSettings.characterColors;
        saveSettingsDebounced();
        console.log("[Per-Character BG] Migrated old background data to new slot format");
    }
}

// ─── init ──────────────────────────────────────────────────────────────────────

eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

eventSource.once(event_types.APP_READY, () => {
    eventSource.makeFirst?.(event_types.CHAT_CHANGED, onChatChanged);
    migrateOldData();
    applyCharacterBackground(undefined);
    buildAndInjectBGData();
    new MutationObserver(scheduleEnsureCharacterTabExists)
        .observe(document.body, { childList: true, subtree: true });
    console.log("[Per-Character BG] initialized — scene slots v2");
});
