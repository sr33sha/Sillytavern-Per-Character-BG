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
 * A saved background is normally a relative path to one of our small copies
 * (user/images/per-character-bg/<file>); a data: URL or a gallery path can still show up from older versions
 * until the startup cleanup converts them. Paths need their segments URL-encoded so
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

const BG_FOLDER = "per-character-bg"; // saved under user/images/per-character-bg/
const BG_MAX_SIDE = 1920;   // longest edge of the saved copy, in px
const BG_JPEG_QUALITY = 0.8;
const BG_PATH_PREFIX = `user/images/${BG_FOLDER}/`;

/** True only for files this extension created itself (the small copies in its own folder). */
function isOwnCopy(value) {
    return typeof value === "string" && value.startsWith(BG_PATH_PREFIX) && !value.includes("..");
}

/**
 * Deletes one of our own small copies. Guarded so it can never touch anything outside our folder:
 * ST's delete endpoint will remove any file under user/images, including gallery originals.
 */
async function deleteOwnCopy(value) {
    if (!isOwnCopy(value)) {
        return;
    }
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
    if (window.toastr) {
        toastr.error(message, "Per-Character BG");
    }
}

/** Loads any image src (data: URL or site path) and returns a downscaled JPEG data: URL. */
function toSmallJpegDataUrl(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, BG_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#000"; // JPEG has no alpha; flatten transparent PNGs onto black
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", BG_JPEG_QUALITY));
        };
        img.onerror = () => reject(new Error("Couldn't load image to make a small copy"));
        img.src = src;
    });
}

/**
 * Saves a small JPEG copy of an image into the extension's own folder via ST's upload endpoint and returns
 * the relative path (user/images/per-character-bg/<file>).
 * Keeps settings.json tiny: embedding the image in settings made it a multi-MB file that ST has
 * to download on every startup.
 */
async function saveDataUrlToGallery(char, srcDataUrl) {
    const dataUrl = await toSmallJpegDataUrl(srcDataUrl); // always a small JPEG copy, never the original
    const match = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(dataUrl);
    if (!match) {
        throw new Error("Not a base64 image data URL");
    }
    const response = await fetch("/api/images/upload", {
        method: "POST",
        headers: getRequestHeaders(),
        body: JSON.stringify({
            image: match[2],
            format: match[1].replace("jpeg", "jpg"),
            ch_name: BG_FOLDER, // our own folder, so character galleries are never touched
            filename: `${char.avatar.replace(/\.png$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_")}_${Date.now()}`,
        }),
    });
    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
    }
    const { path } = await response.json();
    return String(path).replace(/^\/+/, "");
}

/**
 * Cleanup that runs on startup: every background that isn't already one of our small copies (an
 * image embedded in settings, or a path pointing at a full-size gallery original) becomes a small
 * JPEG in our own folder. Originals are only read, never changed. Entries for characters that no
 * longer exist are converted too, so nothing keeps settings.json large.
 */
async function migrateBackgrounds() {
    for (const [avatar, value] of Object.entries({ ...extSettings.characterBackgrounds })) {
        if (typeof value !== "string" || !value || isOwnCopy(value)) {
            continue;
        }
        try {
            const src = value.startsWith("data:") ? value : new URL(toUrl(value), location.href).href;
            const path = await saveDataUrlToGallery({ avatar }, src);
            if (extSettings.characterBackgrounds[avatar] !== value) {
                deleteOwnCopy(path); // the user changed it while we were converting; don't clobber that
                continue;
            }
            extSettings.characterBackgrounds[avatar] = path;
            saveSettingsDebounced();
            if (getCurrentChar()?.avatar === avatar) {
                applyCharacterBackground();
            }
        } catch (error) {
            // e.g. the original file is gone; leave the entry as it is and try again next startup
            console.error("[Per-Character BG] Couldn't convert background for", avatar, error);
        }
    }
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
            thumb.onclick = async () => {
                box.style.pointerEvents = "none"; // ignore extra clicks while the copy is being made
                const previous = extSettings.characterBackgrounds[char.avatar];
                let value = path; // fallback: point at the original if the small copy can't be made
                try {
                    value = await saveDataUrlToGallery(char, new URL(toUrl(path), location.href).href);
                } catch (error) {
                    console.error("[Per-Character BG] Small copy failed, using the original", error);
                }
                extSettings.characterBackgrounds[char.avatar] = value;
                saveSettingsDebounced();
                if (previous !== value) {
                    deleteOwnCopy(previous);
                }
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
        reader.onload = async () => {
            // Never embed the image in settings.json, even if saving the copy fails.
            let value;
            try {
                value = await saveDataUrlToGallery(char, reader.result);
            } catch (error) {
                console.error("[Per-Character BG] Couldn't save the uploaded background", error);
                notifyError("Couldn't save that background. Nothing was changed.");
                return;
            }
            const previous = extSettings.characterBackgrounds[char.avatar];
            extSettings.characterBackgrounds[char.avatar] = value;
            saveSettingsDebounced();
            deleteOwnCopy(previous);
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
            deleteOwnCopy(extSettings.characterBackgrounds[char.avatar]);
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
    migrateBackgrounds();

    // The Backgrounds drawer's content may not exist in the DOM until it's been opened at least
    // once, and Tauri Tavern's own chat-surface re-renders can tear down subtrees on navigation,
    // so watch document.body rather than assuming #bg_tabs is there or stays there. This only
    // ever (re)creates the tab if it's missing - see ensureCharacterTabExists - so it stays a
    // no-op once the tab exists, instead of fighting with our own renders.
    new MutationObserver(scheduleEnsureCharacterTabExists)
        .observe(document.body, { childList: true, subtree: true });
});
