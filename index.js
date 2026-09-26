import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";

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
        overlay.style.backgroundImage = `url("${dataUrl}")`;
        overlay.style.display = "block";
    } else {
        overlay.style.backgroundImage = "";
        overlay.style.display = "none";
    }
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
        preview.src = dataUrl;
        wrapper.appendChild(preview);
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

    if (dataUrl) {
        const removeBtn = document.createElement("button");
        removeBtn.className = "menu_button interactable tt-char-bg-remove-btn";
        removeBtn.textContent = "Remove";
        removeBtn.onclick = () => {
            delete extSettings.characterBackgrounds[char.avatar];
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
