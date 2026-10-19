import { eventSource, event_types, saveSettingsDebounced, getRequestHeaders } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { getSanitizedFilename } from "../../../utils.js";

const extName = "TT-Character-Backgrounds";
const TAB_ID = "bg_character_tab";
const TAB_LABEL = "Character";

if (!extension_settings[extName]) {
    extension_settings[extName] = {};
}
const extSettings = extension_settings[extName];
if (!extSettings.characterBackgrounds) {
    extSettings.characterBackgrounds = {};
}
if (!extSettings.characterBackgroundFx) {
    extSettings.characterBackgroundFx = {};
}

const DEFAULT_FX = { blur: 0, darkness: 0 }; // blur in px (0-20), darkness in % (0-100)

function getFx(avatar) {
    return { ...DEFAULT_FX, ...(extSettings.characterBackgroundFx[avatar] ?? {}) };
}

/**
 * A saved background is either a data: URL (uploaded from disk) or a relative path into the
 * character's gallery (user/images/<folder>/<file>). Paths need their segments URL-encoded so
 * spaces, #, ?, quotes etc. in file names don't break the CSS url() or the <img> src.
 */
function toUrl(value) {
    if (value.startsWith("data:")) {
        return value;
    }
    return value.split("/").map(encodeURIComponent).join("/");
}

/** Same rule ST's gallery uses: a per-character folder override, otherwise the character's name. */
function getGalleryFolder(char) {
    return extension_settings.gallery?.folders?.[char.avatar] ?? char.name;
}

/** Lists the image paths in the character's gallery folder, newest first. */
async function fetchGalleryImages(char) {
    const folder = getGalleryFolder(char);
    const response = await fetch("/api/images/list", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, sortField: "date", sortOrder: "desc", type: 1 }), // 1 = images only
    });
    if (!response.ok) {
        throw new Error(`Gallery request failed (${response.status})`);
    }
    const files = await response.json();
    const safeFolder = await getSanitizedFilename(folder);
    return { folder, paths: files.map((file) => `user/images/${safeFolder}/${file}`) };
}

function getCurrentChar() {
    const ctx = getContext();
    const charId = ctx.characterId;
    if (charId === undefined || charId === null || charId === "") {
        return null;
    }
    return ctx.characters?.[charId] ?? null;
}

const OVERLAY_ID = "tt_char_bg_overlay";

/**
 * Returns our own overlay layer, creating it right after #bg1 if needed. We never write to #bg1
 * itself: ST stores the global/chat background as an inline style there, so clearing or setting
 * it from an extension wipes (or overwrites) the global background.
 */
function getOverlay() {
    const bg1 = document.getElementById("bg1");
    if (!bg1) {
        return null;
    }
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = OVERLAY_ID;
        bg1.insertAdjacentElement("afterend", overlay);
    }
    return overlay;
}

/**
 * Shows the current character's background on the overlay, or hides the overlay if they have
 * none. #bg1 (global/chat background) is left completely untouched.
 */
function applyCharacterBackground() {
    const bg1 = document.getElementById("bg1");
    const overlay = getOverlay();
    if (!bg1 || !overlay) {
        return;
    }
    const char = getCurrentChar();
    const dataUrl = char ? extSettings.characterBackgrounds[char.avatar] : null;
    if (dataUrl) {
        // Mirror ST's fitting class (cover/contain/stretch/center) so it matches the global bg.
        overlay.className = bg1.className;
        overlay.style.backgroundImage = `url("${toUrl(dataUrl)}")`;
        const fx = getFx(char.avatar);
        overlay.style.filter = `blur(${fx.blur}px) brightness(${1 - fx.darkness / 100})`;
        // Scale up a bit so the blurred edges don't show a see-through fringe.
        overlay.style.transform = fx.blur > 0 ? `scale(${1 + fx.blur * 0.006})` : "";
        overlay.style.display = "block";
    } else {
        overlay.style.backgroundImage = "";
        overlay.style.filter = "";
        overlay.style.transform = "";
        overlay.style.display = "none";
    }
}

function makeSlider(labelText, min, max, unit, value, onInput) {
    const row = document.createElement("label");
    row.className = "tt-char-bg-slider-row";

    const text = document.createElement("span");
    text.className = "tt-char-bg-slider-label";
    const updateText = (v) => { text.textContent = `${labelText}: ${v}${unit}`; };
    updateText(value);

    const input = document.createElement("input");
    input.type = "range";
    input.min = min;
    input.max = max;
    input.step = 1;
    input.value = value;
    input.className = "tt-char-bg-slider";
    input.oninput = () => {
        const v = Number(input.value);
        updateText(v);
        onInput(v);
    };

    row.append(text, input);
    return row;
}

function renderGalleryPicker(box, char, panel) {
    box.textContent = "Loading gallery...";
    fetchGalleryImages(char).then(({ folder, paths }) => {
        if (getCurrentChar()?.avatar !== char.avatar || !box.isConnected) {
            return; // switched character (or re-rendered) while loading
        }
        box.textContent = "";
        if (!paths.length) {
            box.textContent = `No images in this character's gallery (folder: ${folder}).`;
            return;
        }
        for (const path of paths) {
            const thumb = document.createElement("img");
            thumb.className = "tt-char-bg-gallery-thumb";
            thumb.loading = "lazy";
            thumb.src = toUrl(path);
            thumb.title = path.split("/").pop();
            thumb.onclick = () => {
                extSettings.characterBackgrounds[char.avatar] = path;
                saveSettingsDebounced();
                applyCharacterBackground();
                renderCharacterTab(panel);
            };
            box.appendChild(thumb);
        }
    }).catch((error) => {
        console.error("[Per-Character BG] Failed to load gallery", error);
        box.textContent = "Couldn't load the gallery.";
    });
}

function renderCharacterTab(panel) {
    const char = getCurrentChar();
    panel.innerHTML = "";

    if (!char) {
        panel.textContent = "Open a character's chat to assign a background.";
        return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "tt-char-bg-panel";

    const label = document.createElement("div");
    label.className = "tt-char-bg-label";
    label.textContent = `Background for ${char.name}`;
    wrapper.appendChild(label);

    const dataUrl = extSettings.characterBackgrounds[char.avatar];
    if (dataUrl) {
        const preview = document.createElement("img");
        preview.className = "tt-char-bg-preview";
        preview.src = toUrl(dataUrl);
        preview.onerror = () => {
            // e.g. the gallery image was deleted/renamed, or the character's gallery folder changed
            const note = document.createElement("div");
            note.textContent = "Saved image can't be loaded (moved or deleted?). Pick another or remove it.";
            preview.replaceWith(note);
        };
        wrapper.appendChild(preview);

        const fx = getFx(char.avatar);
        const setFx = (key, v) => {
            extSettings.characterBackgroundFx[char.avatar] = { ...getFx(char.avatar), [key]: v };
            saveSettingsDebounced();
            applyCharacterBackground(); // live update, no re-render needed
        };
        wrapper.appendChild(makeSlider("Blur", 0, 20, "px", fx.blur, (v) => setFx("blur", v)));
        wrapper.appendChild(makeSlider("Darkness", 0, 100, "%", fx.darkness, (v) => setFx("darkness", v)));
    }

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.className = "tt-char-bg-file-input";
    fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            extSettings.characterBackgrounds[char.avatar] = reader.result;
            saveSettingsDebounced();
            applyCharacterBackground();
            renderCharacterTab(panel);
        };
        reader.readAsDataURL(file);
    };
    wrapper.appendChild(fileInput);

    const uploadBtn = document.createElement("button");
    uploadBtn.className = "menu_button interactable tt-char-bg-upload-btn";
    uploadBtn.textContent = dataUrl ? "Replace Background" : "Upload Background";
    uploadBtn.onclick = () => fileInput.click();
    wrapper.appendChild(uploadBtn);

    const galleryBtn = document.createElement("button");
    galleryBtn.className = "menu_button interactable tt-char-bg-gallery-btn";
    galleryBtn.textContent = "Choose from Gallery";
    wrapper.appendChild(galleryBtn);

    const galleryBox = document.createElement("div");
    galleryBox.className = "tt-char-bg-gallery";
    galleryBox.style.display = "none";
    wrapper.appendChild(galleryBox);
    galleryBtn.onclick = () => {
        const opening = galleryBox.style.display === "none";
        galleryBox.style.display = opening ? "grid" : "none";
        if (opening) {
            renderGalleryPicker(galleryBox, char, panel);
        }
    };

    if (dataUrl) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "menu_button interactable tt-char-bg-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.onclick = () => {
            delete extSettings.characterBackgrounds[char.avatar];
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
 * every single render, in an infinite self-triggering loop that kept destroying and recreating
 * the upload button (and its file input) many times a second - so this must stay a no-op once
 * the tab exists.
 */
function ensureCharacterTabExists() {
    if (document.getElementById(TAB_ID)) {
        return;
    }

    const tabsList = document.querySelector("#bg_tabs .bg_tabs_list");
    const tabsRoot = document.getElementById("bg_tabs");
    if (!tabsList || !tabsRoot) {
        return; // Backgrounds drawer not rendered yet
    }

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

    // Registers the new tab with jQuery UI's existing Tabs instance (click handling, active
    // state, ARIA, panel show/hide) instead of reimplementing all of that by hand.
    if (window.jQuery && jQuery.fn.tabs) {
        jQuery("#bg_tabs").tabs("refresh");
    }

    renderCharacterTab(panel);
}

let rafScheduled = false;
function scheduleEnsureCharacterTabExists() {
    if (rafScheduled) {
        return;
    }
    rafScheduled = true;
    requestAnimationFrame(() => {
        rafScheduled = false;
        ensureCharacterTabExists();
    });
}

eventSource.on(event_types.CHAT_CHANGED, () => {
    applyCharacterBackground();
    ensureCharacterTabExists();
    const panel = document.getElementById(TAB_ID);
    if (panel) {
        renderCharacterTab(panel); // refresh content for whichever character we just switched to
    }
});

eventSource.once(event_types.APP_READY, () => {
    applyCharacterBackground();

    // The Backgrounds drawer's content may not exist in the DOM until it's been opened at least
    // once, and Tauri Tavern's own chat-surface re-renders can tear down subtrees on navigation,
    // so watch document.body rather than assuming #bg_tabs is there or stays there. This only
    // ever (re)creates the tab if it's missing - see ensureCharacterTabExists - so it stays a
    // no-op once the tab exists, instead of fighting with our own renders.
    new MutationObserver(scheduleEnsureCharacterTabExists)
        .observe(document.body, { childList: true, subtree: true });
});
