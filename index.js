import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders, setExtensionPrompt } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { getSanitizedFilename } from "../../../utils.js";

const extName = "TT-Character-Backgrounds";
const TAB_ID = "bg_character_tab";
const TAB_LABEL = "Character";
const BG_MODULE_NAME = "tt_char_bg";
const SCENE_COUNT = 5;

if (!extension_settings[extName]) {
    extension_settings[extName] = {};
}
const extSettings = extension_settings[extName];
if (!extSettings.characterScenes)       extSettings.characterScenes       = {};
if (!extSettings.characterCurrentPath)  extSettings.characterCurrentPath  = {};
if (!extSettings.characterFallback)     extSettings.characterFallback     = {};
if (!extSettings.characterBackgroundFx) extSettings.characterBackgroundFx = {};
if (!extSettings.characterColors)       extSettings.characterColors       = {};

const DEFAULT_FX = { blur: 0, darkness: 0 };

function getFx(avatar) {
    return { ...DEFAULT_FX, ...(extSettings.characterBackgroundFx[avatar] ?? {}) };
}

const DEFAULT_COLOR = { mode: "gradient", c1: "#3b3f63", c2: "#15161f", angle: 160 };
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function getColor(avatar) {
    const saved = extSettings.characterColors[avatar];
    if (!saved || !HEX_COLOR.test(saved.c1)) return null;
    return {
        mode: saved.mode === "solid" ? "solid" : "gradient",
        c1: saved.c1,
        c2: HEX_COLOR.test(saved.c2) ? saved.c2 : saved.c1,
        angle: Number.isFinite(Number(saved.angle)) ? Number(saved.angle) : DEFAULT_COLOR.angle,
    };
}

function colorToCss(color) {
    const second = color.mode === "solid" ? color.c1 : color.c2;
    return `linear-gradient(${color.angle}deg, ${color.c1}, ${second})`;
}

function toUrl(value) {
    if (value.startsWith("data:")) return value;
    return value.split("/").map(encodeURIComponent).join("/");
}

function getGalleryFolder(char) {
    return extension_settings.gallery?.folders?.[char.avatar] ?? char.name;
}

const BG_FOLDER = "per-character-bg";
const BG_MAX_SIDE = 1920;
const BG_JPEG_QUALITY = 0.8;
const BG_PATH_PREFIX = `user/images/${BG_FOLDER}/`;

function isOwnCopy(value) {
    return typeof value === "string" && value.startsWith(BG_PATH_PREFIX) && !value.includes("..");
}

async function deleteOwnCopy(value) {
    if (!isOwnCopy(value)) return;
    try {
        await fetch("/api/images/delete", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: value }),
        });
    } catch (error) {
        console.warn("[Per-Character BG] Couldn't delete old copy", value, error);
    }
}

function notifyError(message) {
    if (window.toastr) toastr.error(message, "Per-Character BG");
}

function toSmallJpegDataUrl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, BG_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", BG_JPEG_QUALITY));
        };
        img.onerror = () => reject(new Error("Couldn't load image to make a small copy"));
        img.src = src;
    });
}

async function saveDataUrlToGallery(char, srcDataUrl) {
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
            filename: `${char.avatar.replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_")}_${Date.now()}`,
        }),
    });
    if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
    const { path } = await response.json();
    return String(path).replace(/^\/+/, "");
}

async function fetchGalleryImages(char) {
    const folder = getGalleryFolder(char);
    const response = await fetch("/api/images/list", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, sortField: "date", sortOrder: "desc", type: 1 }),
    });
    if (!response.ok) throw new Error(`Gallery request failed (${response.status})`);
    const files = await response.json();
    const safeFolder = await getSanitizedFilename(folder);
    return { folder, paths: files.map((file) => `user/images/${safeFolder}/${file}`) };
}

function getCurrentChar() {
    const ctx = getContext();
    const charId = ctx.characterId;
    if (charId === undefined || charId === null || charId === "") return null;
    return ctx.characters?.[charId] ?? null;
}

const OVERLAY_ID = "tt_char_bg_overlay";

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

function applyCharacterBackground() {
    const bg1 = document.getElementById("bg1");
    const overlay = getOverlay();
    if (!bg1 || !overlay) return;
    const char = getCurrentChar();
    let dataUrl = char ? extSettings.characterCurrentPath[char.avatar] : null;
    // If no active image, use the fallback slot (if one is set)
    if (!dataUrl && char) {
        const fbIdx = extSettings.characterFallback[char.avatar];
        if (typeof fbIdx === "number") {
            const fbSlot = getScenes(char.avatar)[fbIdx];
            if (fbSlot?.path) dataUrl = fbSlot.path;
        }
    }
    const color = char ? getColor(char.avatar) : null;
    if (dataUrl || color) {
        overlay.className = bg1.className;
        const fx = getFx(char.avatar);
        const blur = fx.blur;
        overlay.style.backgroundImage = dataUrl ? `url("${toUrl(dataUrl)}")` : colorToCss(color);
        overlay.style.filter    = `blur(${blur}px) brightness(${1 - fx.darkness / 100})`;
        overlay.style.transform = blur > 0 ? `scale(${1 + blur * 0.006})` : "";
        overlay.style.display   = "block";
    } else {
        overlay.style.backgroundImage = "";
        overlay.style.filter    = "";
        overlay.style.transform = "";
        overlay.style.display   = "none";
    }
}

/**
 * Normalises a scene name for comparison: lowercases, converts Unicode curly quotes/dashes
 * to ASCII equivalents, and collapses whitespace. The AI always outputs ASCII punctuation
 * even when the name was typed with curly quotes, so both sides must be normalised.
 */
function normalizeName(s) {
    return s
        .replace(/[‘’‚‛′]/g, "'")
        .replace(/[“”„‟″]/g, '"')
        .replace(/[–—―]/g, '-')
        .replace(/ /g, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Returns the 5-slot scenes array for the given avatar, normalised to exactly SCENE_COUNT slots. */
function getScenes(avatar) {
    const raw = extSettings.characterScenes[avatar];
    if (!Array.isArray(raw)) return Array(SCENE_COUNT).fill(null);
    const arr = raw.slice(0, SCENE_COUNT);
    while (arr.length < SCENE_COUNT) arr.push(null);
    return arr;
}

/** Injects available scene names into the AI prompt. */
function buildAndInjectBGData(char) {
    if (!char) {
        setExtensionPrompt(BG_MODULE_NAME, "", 0, 1);
        return;
    }
    const scenes = getScenes(char.avatar).filter(Boolean);
    if (!scenes.length) {
        setExtensionPrompt(BG_MODULE_NAME, "", 0, 1);
        return;
    }
    // Inject original names so AI echoes them back as typed; normalization only happens at match time
    const names = scenes.map(s => s.name);
    const prompt = `<BG_Data>\nAvailable backgrounds: ${names.join(", ")}\nTo set a background respond with: Background: <name>\n</BG_Data>`;
    setExtensionPrompt(BG_MODULE_NAME, prompt, 0, 1);
}

/** Looks for "Background: name" in the last AI message and applies the matching slot. */
function onMessageReceived() {
    const char = getCurrentChar();
    if (!char) return;
    const msgs = getContext().chat;
    if (!msgs?.length) return;
    let lastAi = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (!msgs[i].is_user) { lastAi = msgs[i]; break; }
    }
    if (!lastAi) return;

    console.log('[Per-Character BG] onMessageReceived — mes snippet:', JSON.stringify((lastAi.mes ?? '').slice(0, 200)));

    // No Background directive at all → keep whatever is currently shown
    const match = /Background:\s*([^\n\r<]+)/i.exec(lastAi.mes ?? "");
    if (!match) {
        console.log('[Per-Character BG] no Background: match found in mes');
        return;
    }

    // Strip surrounding quotes/asterisks, then normalise (handles curly vs straight apostrophes etc.)
    const requested = normalizeName(
        match[1].trim().replace(/<[^>]+>/g, "").replace(/^["""''*_`\s]+|["""''*_`.!\s]+$/g, "")
    );

    console.log('[Per-Character BG] requested:', JSON.stringify(requested));

    if (!requested || requested === "null" || requested === "none" || requested === "n/a") {
        // Explicit "no background" — clear and let fallback/color show
        delete extSettings.characterCurrentPath[char.avatar];
        saveSettingsDebounced();
        applyCharacterBackground();
        return;
    }

    const allScenes = getScenes(char.avatar);
    console.log('[Per-Character BG] stored names:', allScenes.map(s => s ? JSON.stringify(normalizeName(s.name)) : 'null'));
    const slot = allScenes.find(s => s && normalizeName(s.name) === requested);

    if (!slot) {
        // Unknown scene name — clear current path so the fallback slot (if set) takes over
        delete extSettings.characterCurrentPath[char.avatar];
        saveSettingsDebounced();
        applyCharacterBackground();
        return;
    }

    extSettings.characterCurrentPath[char.avatar] = slot.path;
    saveSettingsDebounced();
    applyCharacterBackground();
    const panel = document.getElementById(TAB_ID);
    if (panel) renderCharacterTab(panel);
}

function makeSlider(labelText, min, max, unit, value, onInput) {
    const row = document.createElement("label");
    row.className = "tt-char-bg-slider-row";
    const text = document.createElement("span");
    text.className = "tt-char-bg-slider-label";
    const updateText = (v) => { text.textContent = `${labelText}: ${v}${unit}`; };
    updateText(value);
    const input = document.createElement("input");
    input.type = "range"; input.min = min; input.max = max; input.step = 1;
    input.value = value; input.className = "tt-char-bg-slider";
    input.oninput = () => { const v = Number(input.value); updateText(v); onInput(v); };
    row.append(text, input);
    return row;
}

function renderGalleryPicker(box, char, onPick) {
    box.textContent = "Loading gallery...";
    fetchGalleryImages(char).then(({ folder, paths }) => {
        if (getCurrentChar()?.avatar !== char.avatar || !box.isConnected) return;
        box.textContent = "";
        if (!paths.length) {
            box.textContent = `No images in this character's gallery (folder: ${folder}).`;
            return;
        }
        for (const path of paths) {
            const fname = path.split("/").pop();
            const thumb = document.createElement("img");
            thumb.className = "tt-char-bg-gallery-thumb";
            thumb.loading = "lazy";
            thumb.src = toUrl(path);
            thumb.title = fname;
            thumb.onclick = () => {
                box.style.pointerEvents = "none";
                onPick(path, fname.replace(/\.[^.]+$/, ""));
            };
            box.appendChild(thumb);
        }
    }).catch((error) => {
        console.error("[Per-Character BG] Failed to load gallery", error);
        box.textContent = "Couldn't load the gallery.";
    });
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

function renderColorEditor(box, char, panel) {
    const draft = { ...(getColor(char.avatar) ?? DEFAULT_COLOR) };
    box.textContent = "";
    const swatch = document.createElement("div");
    swatch.className = "tt-char-bg-color-preview";
    const modeRow = document.createElement("label");
    modeRow.className = "tt-char-bg-color-row";
    const modeText = document.createElement("span");
    modeText.textContent = "Style";
    const mode = document.createElement("select");
    mode.className = "text_pole";
    mode.innerHTML = `<option value="gradient">Soft gradient</option><option value="solid">Solid color</option>`;
    mode.value = draft.mode;
    modeRow.append(modeText, mode);
    const colorOne = makeColorRow("Color",        draft.c1, (v) => { draft.c1 = v; refresh(); });
    const colorTwo = makeColorRow("Second color", draft.c2, (v) => { draft.c2 = v; refresh(); });
    const angle    = makeSlider("Angle", 0, 360, "°", draft.angle, (v) => { draft.angle = v; refresh(); });
    const refresh = () => {
        swatch.style.backgroundImage = colorToCss(draft);
        const g = draft.mode === "gradient";
        colorTwo.style.display = g ? "" : "none";
        angle.style.display    = g ? "" : "none";
    };
    mode.onchange = () => { draft.mode = mode.value; refresh(); };
    const applyBtn = document.createElement("button");
    applyBtn.className = "menu_button interactable tt-char-bg-color-apply-btn";
    applyBtn.textContent = "Apply";
    applyBtn.onclick = () => {
        extSettings.characterColors[char.avatar] = { ...draft };
        delete extSettings.characterCurrentPath[char.avatar];
        saveSettingsDebounced();
        applyCharacterBackground();
        renderCharacterTab(panel);
    };
    box.append(swatch, modeRow, colorOne, colorTwo, angle, applyBtn);
    refresh();
}

function renderCharacterTab(panel) {
    const char = getCurrentChar();
    panel.innerHTML = "";

    if (!char) {
        panel.textContent = "Open a character's chat to manage scene backgrounds.";
        return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "tt-char-bg-panel";

    const label = document.createElement("div");
    label.className = "tt-char-bg-label";
    label.textContent = `Scenes for ${char.name}`;
    wrapper.appendChild(label);

    const scenes = getScenes(char.avatar);

    for (let i = 0; i < SCENE_COUNT; i++) {
        const slot = scenes[i];
        const card = document.createElement("div");
        card.className = "tt-char-bg-slot";

        // ── Header: slot number | name input | clear ──
        const header = document.createElement("div");
        header.className = "tt-char-bg-slot-header";

        const numLabel = document.createElement("span");
        numLabel.className = "tt-char-bg-slot-num";
        numLabel.textContent = `Scene ${i + 1}`;
        header.appendChild(numLabel);

        if (slot) {
            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.className = "tt-char-bg-slot-name";
            nameInput.value = slot.name;
            nameInput.placeholder = "scene name";
            nameInput.title = "Name the AI uses for Background: <name>";
            nameInput.oninput = () => {
                const updated = getScenes(char.avatar);
                if (updated[i]) {
                    updated[i] = { ...updated[i], name: nameInput.value };
                    extSettings.characterScenes[char.avatar] = updated;
                    saveSettingsDebounced();
                    buildAndInjectBGData(char);
                }
            };
            header.appendChild(nameInput);

            const clearBtn = document.createElement("button");
            clearBtn.className = "menu_button interactable tt-char-bg-slot-clear";
            clearBtn.textContent = "✕";
            clearBtn.title = "Remove this scene";
            clearBtn.onclick = async () => {
                const updated = getScenes(char.avatar);
                const previous = updated[i]?.path;
                updated[i] = null;
                extSettings.characterScenes[char.avatar] = updated;
                if (extSettings.characterCurrentPath[char.avatar] === previous) {
                    delete extSettings.characterCurrentPath[char.avatar];
                }
                if (extSettings.characterFallback[char.avatar] === i) {
                    delete extSettings.characterFallback[char.avatar];
                }
                if (previous) await deleteOwnCopy(previous);
                saveSettingsDebounced();
                applyCharacterBackground();
                buildAndInjectBGData(char);
                renderCharacterTab(panel);
            };
            header.appendChild(clearBtn);
        }
        card.appendChild(header);

        // ── Thumbnail + Apply ──
        if (slot?.path) {
            const preview = document.createElement("img");
            preview.className = "tt-char-bg-preview";
            preview.src = toUrl(slot.path);
            card.appendChild(preview);

            const isActive = extSettings.characterCurrentPath[char.avatar] === slot.path;
            const applyBtn = document.createElement("button");
            applyBtn.className = "menu_button interactable";
            applyBtn.textContent = isActive ? "Applied ✓" : "Apply";
            applyBtn.onclick = () => {
                extSettings.characterCurrentPath[char.avatar] = slot.path;
                delete extSettings.characterColors[char.avatar];
                saveSettingsDebounced();
                applyCharacterBackground();
                renderCharacterTab(panel);
            };
            card.appendChild(applyBtn);
        }

        // ── Action buttons row ──
        const actionsRow = document.createElement("div");
        actionsRow.className = "tt-char-bg-slot-actions";

        // Gallery picker
        const galleryBtn = document.createElement("button");
        galleryBtn.className = "menu_button interactable";
        galleryBtn.textContent = slot ? "Change" : "Gallery";
        actionsRow.appendChild(galleryBtn);

        const galleryBox = document.createElement("div");
        galleryBox.className = "tt-char-bg-gallery";
        galleryBox.style.display = "none";

        galleryBtn.onclick = () => {
            const opening = galleryBox.style.display === "none";
            uploadBox.style.display = "none";
            galleryBox.style.display = opening ? "grid" : "none";
            if (opening) {
                renderGalleryPicker(galleryBox, char, async (pickedPath, name) => {
                    let path;
                    try {
                        path = await saveDataUrlToGallery(char, toUrl(pickedPath));
                    } catch (error) {
                        console.error("[Per-Character BG] Couldn't save gallery image as JPEG copy", error);
                        notifyError("Couldn't save that image. Nothing changed.");
                        return;
                    }
                    const previous = getScenes(char.avatar)[i]?.path;
                    if (previous) await deleteOwnCopy(previous);
                    const updated = getScenes(char.avatar);
                    updated[i] = { path, name };
                    extSettings.characterScenes[char.avatar] = updated;
                    saveSettingsDebounced();
                    buildAndInjectBGData(char);
                    renderCharacterTab(panel);
                });
            }
        };

        // File upload
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.className = "tt-char-bg-file-input";

        const uploadBox = document.createElement("div");
        uploadBox.style.cssText = "display:none; gap:4px; align-items:center; flex-wrap:wrap;";

        const uploadBtn = document.createElement("button");
        uploadBtn.className = "menu_button interactable";
        uploadBtn.textContent = "Upload";
        uploadBtn.onclick = () => {
            const opening = uploadBox.style.display === "none";
            galleryBox.style.display = "none";
            uploadBox.style.display = opening ? "flex" : "none";
        };
        actionsRow.appendChild(uploadBtn);

        const chooseFileBtn = document.createElement("button");
        chooseFileBtn.className = "menu_button interactable";
        chooseFileBtn.textContent = "Choose file…";
        chooseFileBtn.onclick = () => fileInput.click();
        uploadBox.appendChild(chooseFileBtn);
        uploadBox.appendChild(fileInput);

        fileInput.onchange = async () => {
            const file = fileInput.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                let path;
                try {
                    path = await saveDataUrlToGallery(char, reader.result);
                } catch (error) {
                    console.error("[Per-Character BG] Couldn't save uploaded image", error);
                    notifyError("Couldn't save that image. Nothing changed.");
                    return;
                }
                const name = file.name.replace(/\.[^.]+$/, "");
                const updated = getScenes(char.avatar);
                updated[i] = { path, name };
                extSettings.characterScenes[char.avatar] = updated;
                saveSettingsDebounced();
                buildAndInjectBGData(char);
                renderCharacterTab(panel);
            };
            reader.readAsDataURL(file);
        };

        // Fallback toggle
        const isFallback = extSettings.characterFallback[char.avatar] === i;
        const fallbackBtn = document.createElement("button");
        fallbackBtn.className = `menu_button interactable${isFallback ? " tt-char-bg-fallback-active" : ""}`;
        fallbackBtn.textContent = isFallback ? "Fallback ✓" : "Fallback";
        fallbackBtn.title = "Show this scene when no background has been set by the AI";
        fallbackBtn.onclick = () => {
            if (extSettings.characterFallback[char.avatar] === i) {
                delete extSettings.characterFallback[char.avatar];
            } else {
                extSettings.characterFallback[char.avatar] = i;
            }
            saveSettingsDebounced();
            applyCharacterBackground();
            renderCharacterTab(panel);
        };
        actionsRow.appendChild(fallbackBtn);

        card.appendChild(actionsRow);
        card.appendChild(galleryBox);
        card.appendChild(uploadBox);

        wrapper.appendChild(card);
    }

    // FX controls
    const fx = getFx(char.avatar);
    const setFx = (key, v) => {
        extSettings.characterBackgroundFx[char.avatar] = { ...getFx(char.avatar), [key]: v };
        saveSettingsDebounced();
        applyCharacterBackground();
    };
    wrapper.appendChild(makeSlider("Blur",     0,  20, "px", fx.blur,     (v) => setFx("blur", v)));
    wrapper.appendChild(makeSlider("Darkness", 0, 100, "%",  fx.darkness, (v) => setFx("darkness", v)));

    const color = getColor(char.avatar);
    const colorBtn = document.createElement("button");
    colorBtn.className = "menu_button interactable tt-char-bg-color-btn";
    colorBtn.textContent = color ? "Edit Color BG" : "Apply Color BG";
    wrapper.appendChild(colorBtn);

    const colorBox = document.createElement("div");
    colorBox.className = "tt-char-bg-color-editor";
    colorBox.style.display = "none";
    wrapper.appendChild(colorBox);

    colorBtn.onclick = () => {
        const opening = colorBox.style.display === "none";
        colorBox.style.display = opening ? "flex" : "none";
        if (opening) renderColorEditor(colorBox, char, panel);
    };

    if (extSettings.characterCurrentPath[char.avatar] || color) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "menu_button interactable tt-char-bg-remove-btn";
        removeBtn.textContent = "Clear Background";
        removeBtn.onclick = () => {
            delete extSettings.characterCurrentPath[char.avatar];
            delete extSettings.characterColors[char.avatar];
            delete extSettings.characterBackgroundFx[char.avatar];
            saveSettingsDebounced();
            applyCharacterBackground();
            renderCharacterTab(panel);
        };
        wrapper.appendChild(removeBtn);
    }

    panel.appendChild(wrapper);
}

/**
 * Creates the Character tab + panel if they don't exist yet. Does NOT touch panel content when
 * the tab already exists - content refresh is handled separately, only on CHAT_CHANGED. Rendering
 * content here too would mutate the DOM, which would retrigger the MutationObserver below on
 * every single render, in an infinite self-triggering loop - so this must stay a no-op once
 * the tab exists.
 */
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
    panel.id        = TAB_ID;
    panel.className = "bg_tab_panel ui-tabs-panel ui-corner-bottom ui-widget-content";
    panel.setAttribute("role", "tabpanel");
    tabsRoot.appendChild(panel);

    if (window.jQuery && jQuery.fn.tabs) {
        jQuery("#bg_tabs").tabs("refresh");
    }

    renderCharacterTab(panel);
}

let rafScheduled = false;
function scheduleEnsureCharacterTabExists() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
        rafScheduled = false;
        ensureCharacterTabExists();
    });
}

function onChatChanged() {
    applyCharacterBackground();
    requestAnimationFrame(() => {
        ensureCharacterTabExists();
        const panel = document.getElementById(TAB_ID);
        if (panel) renderCharacterTab(panel);
        buildAndInjectBGData(getCurrentChar());
    });
}

eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

eventSource.once(event_types.APP_READY, () => {
    eventSource.makeFirst?.(event_types.CHAT_CHANGED, onChatChanged);
    applyCharacterBackground();
    new MutationObserver(scheduleEnsureCharacterTabExists)
        .observe(document.body, { childList: true, subtree: true });
});

eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
