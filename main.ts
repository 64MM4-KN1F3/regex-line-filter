import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, editorInfoField, TFile } from 'obsidian';
import { EditorState, StateField, StateEffect, Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body';

// --- Settings ---
interface RegexLineFilterSettings { hideEmptyLines: boolean; regexHistory: string[]; }
const DEFAULT_SETTINGS: RegexLineFilterSettings = { hideEmptyLines: true, regexHistory: [], }

// --- State & Effects ---
interface FilterState { regex: RegExp | null; enabled: boolean; hideEmptyLines: boolean; }
const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();

// --- ViewPlugin definition ---
const filterViewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = this.buildDecorations(view); }
        update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged || update.state.field(filterStateField) !== update.startState.field(filterStateField)) { this.decorations = this.buildDecorations(update.view); } }
        buildDecorations(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();
            const { regex, enabled, hideEmptyLines } = view.state.field(filterStateField);
            if (!enabled || !regex) {
                return builder.finish();
            }
            const doc = view.state.doc;
            try {
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    const lineText = line?.text;
                    if (typeof lineText !== 'string') {
                        continue;
                    }
                    const isEmpty = lineText.trim().length === 0;
                    let shouldHide = false;
                    let matchesRegex = regex.test(lineText);

                    if (!matchesRegex) {
                        shouldHide = true;
                    }
                    if (hideEmptyLines && isEmpty) {
                        shouldHide = true;
                    }

                    if (shouldHide) {
                        // Hide the entire line by marking its start position
                        builder.add(line.from, line.from, Decoration.line({ attributes: { class: 'regex-filter-hidden-line' } }));
                    }
                }
            } catch (e) {
                console.error("Regex Line Filter: Error during decoration build:", e);
                // Potentially dispatch an effect to disable the filter on error?
            }
            return builder.finish();
        }
    },
    {
        decorations: (v) => v.decorations,
    }
);

// --- StateField definition ---
const filterStateField = StateField.define<FilterState>({
    create(state): FilterState {
        return {
            regex: null,
            enabled: false,
            hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines, // Initial value from defaults
        };
    },
    update(value, tr): FilterState {
        let newValue: FilterState = { ...value }; // Create a new object to avoid mutation

        for (let effect of tr.effects) {
            if (effect.is(setRegexEffect)) {
                newValue.regex = effect.value;
                newValue.enabled = !!effect.value; // Enable only if regex is valid and set
            }
            if (effect.is(toggleFilterEffect)) {
                 newValue.enabled = effect.value;
                 // If toggling on, ensure there's a regex. If not, force disable.
                 if (effect.value && !newValue.regex) {
                    newValue.enabled = false;
                    console.warn("Attempted to enable filter without a regex.");
                 }
                 // If toggling off, ensure enabled is false
                 if (!effect.value) {
                    newValue.enabled = false;
                 }
            }
            if (effect.is(setHideEmptyLinesEffect)) {
                newValue.hideEmptyLines = effect.value;
            }
        }
        return newValue;
    },
    // Provide the state field to the view plugin if needed
    // provide: f => EditorView.decorations.from(f) // This might not be needed if using ViewPlugin explicitly
});


// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings;
    lastRegexStr: string | null = null;
    cssStyleEl: HTMLElement | null = null;

    async onload() {
        console.log('Loading Regex Line Filter plugin');
        await this.loadSettings();

        this.addCommand({
            id: 'toggle-regex-line-filter',
            name: 'Toggle',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.toggleFilter(editor, view);
            },
        });

        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));

        // Register the CodeMirror 6 extension
        this.registerEditorExtension([filterStateField, filterViewPlugin]);

        // Add the CSS rules
        this.addCss();

        // Ensure settings are applied to existing editors when layout is ready
         this.app.workspace.onLayoutReady(() => {
            this.dispatchSettingToEditors(this.settings.hideEmptyLines);
        });
    }

    onunload() {
        console.log('Unloading Regex Line Filter plugin');
        this.removeCss(); // Remove CSS styles
        // Ensure filter is turned off in all editors
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                const currentFilterState = cm.state.field(filterStateField, false);
                if (currentFilterState?.enabled) {
                    cm.dispatch({ effects: toggleFilterEffect.of(false) });
                }
            } catch (e) { /* Ignore errors if field doesn't exist */ }
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        // Ensure regexHistory is an array and trim it
        if (!Array.isArray(this.settings.regexHistory)) {
            this.settings.regexHistory = [];
        }
        this.settings.regexHistory = this.settings.regexHistory.slice(0, REGEX_HISTORY_LIMIT);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateRegexHistory(newRegexString: string) {
        // Remove existing entry if it exists
        const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString);
        // Add new entry to the beginning
        const updatedHistory = [newRegexString, ...filteredHistory];
        // Trim to the limit
        this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT);
        this.saveSettings();
    }

    // Dispatch hideEmptyLines setting changes to all open editors
    dispatchSettingToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                // Check if the state field exists before dispatching
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({
                        effects: setHideEmptyLinesEffect.of(newValue)
                    });
                 }
            } catch (e) {
                // It's possible an editor doesn't have the state field (e.g., canvas?)
                console.warn("Regex Line Filter: Error dispatching setting to an editor view", e);
            }
        });
    }

    // ----- Add CSS Modified for LEFT/RIGHT Vignette using Pseudo-elements -----
    addCss() {
        const cssId = 'regex-filter-styles';
        if (document.getElementById(cssId)) return; // Don't add if already exists

        // --- Adjust these values for vignette appearance ---
        const vignetteWidth = '160px';       // How WIDE the vignette area is at left/right
        const vignetteColor = 'rgba(0, 0, 0, 0.4)'; // Darkness and opacity of the vignette
        const transitionDuration = '0.3s';   // Fade-in/out speed
        // --- End Adjust ---

        const css = `
            /* Rule to hide non-matching lines (Keep this) */
            .regex-filter-hidden-line {
                display: none !important;
            }

            /* Make view-content a positioning context for pseudo-elements */
            .workspace-leaf.mod-active .view-content {
                position: relative;
                /* Optional: May help prevent horizontal scrollbars if content is very close to edges */
                /* overflow: hidden; */
            }

            /* Define the pseudo-elements base styles */
            .workspace-leaf.mod-active .view-content::before,
            .workspace-leaf.mod-active .view-content::after {
                content: '';
                position: absolute;
                top: 0;  /* Stretch full height */
                bottom: 0; /* Stretch full height */
                width: ${vignetteWidth}; /* Define the width of the vignette */
                z-index: 5;
                pointer-events: none;
                opacity: 0;
                transition: opacity ${transitionDuration} ease-in-out;
                /* Background gradient is set below */
            }

            /* Left vignette gradient */
            .workspace-leaf.mod-active .view-content::before {
                left: 0; /* Position on the left */
                background: linear-gradient(
                    to right, /* Fade from left to right */
                    ${vignetteColor} 0%,
                    transparent 100%
                );
            }

            /* Right vignette gradient */
            .workspace-leaf.mod-active .view-content::after {
                right: 0; /* Position on the right */
                background: linear-gradient(
                    to left, /* Fade from right to left */
                    ${vignetteColor} 0%,
                    transparent 100%
                );
            }

            /* Rule to fade IN the vignettes ONLY when filter is active */
            body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .view-content::before,
            body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .view-content::after {
                opacity: 1; /* Fade in */
            }
        `;
        this.cssStyleEl = document.createElement('style');
        this.cssStyleEl.id = cssId;
        this.cssStyleEl.textContent = css;
        document.head.appendChild(this.cssStyleEl);
        }
    // ----- End addCss -----


    removeCss() {
        // Remove our specific style element
        if (this.cssStyleEl) {
            this.cssStyleEl.remove();
            this.cssStyleEl = null;
        }
        // As a fallback, try removing by ID again in case the reference was lost
        const existingStyle = document.getElementById('regex-filter-styles');
        if (existingStyle) {
            existingStyle.remove();
        }
        // Clean up the body class
        document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
    }

    toggleFilter(editor: Editor, view: MarkdownView) {
        // Access the internal CodeMirror EditorView instance more safely
        // Assert that the editor object *might* have a 'cm' property of type EditorView
        const cm = (editor as { cm?: EditorView }).cm;

        // Ensure we actually got an EditorView instance
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views.");
            console.warn("Regex Line Filter: Could not get CodeMirror EditorView instance from editor."); // Added warning
            return;
        }

        // Ensure we have a CodeMirror EditorView instance
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views.");
            return;
        }

        // Check if the state field actually exists in this editor instance
        const currentFilterState = cm.state.field(filterStateField, false); // Use false to avoid throwing error if field not present
        if(currentFilterState === undefined) {
            // This might happen if the editor was opened before the plugin loaded its extensions completely
             new Notice("Filter state not found for this editor. Please try toggling again, or reload the note.");
            return;
        }


        if (currentFilterState.enabled) {
            // Disable filter
            cm.dispatch({ effects: toggleFilterEffect.of(false) });
            document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
            new Notice('Regex filter disabled.');
        } else {
            // Enable filter - Prompt for regex first
            this.promptForRegex(cm);
        }
    }

    promptForRegex(cm: EditorView) {
        // Prefill with the last used regex, or the most recent history entry, or empty
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";
        new RegexInputModal(
            this.app,
            prefillValue,
            this.settings.regexHistory, // Pass history
            (result) => {
                if (result) {
                    try {
                        // Create RegExp - use 'u' flag for Unicode support
                        const regex = new RegExp(result, 'u');

                        this.lastRegexStr = result; // Store last used regex (session only)
                        this.updateRegexHistory(result); // Update persistent history

                        // Dispatch effects to update regex and enable the filter
                        cm.dispatch({
                           effects: [
                                setRegexEffect.of(regex) // This will also set enabled = true in the state field logic
                           ]
                        });
                        document.body.classList.add(ACTIVE_FILTER_BODY_CLASS); // Add body class for CSS styling
                        new Notice(`Regex filter enabled: /${result}/u`);
                    } catch (e) {
                        const errorMessage = (e instanceof Error) ? e.message : String(e);
                        new Notice(`Invalid Regex: ${errorMessage}`);
                        console.error("Regex Compile Error:", e);
                        // Ensure filter is disabled if regex is invalid
                        document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
                        try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore error if field somehow not available */ }
                    }
                } else {
                    // User cancelled
                    new Notice('Regex filter cancelled.');
                     // Ensure filter is disabled if cancelled
                    document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
                    try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore error */ }
                }
            }
        ).open();
    }
} // End of Plugin Class

// --- Settings Tab Class ---
class RegexLineFilterSettingTab extends PluginSettingTab {
	plugin: RegexLineFilterPlugin;

	constructor(app: App, plugin: RegexLineFilterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		containerEl.createEl('h2', {text: 'Regex Line Filter Settings'});

		new Setting(containerEl)
			.setName('Hide empty lines')
			.setDesc('When the filter is active, also hide lines that contain only whitespace.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideEmptyLines)
				.onChange(async (value) => {
					this.plugin.settings.hideEmptyLines = value;
					await this.plugin.saveSettings();
                    // Dispatch the change to all open editors
                    this.plugin.dispatchSettingToEditors(value);
				}));
	}
}

// --- Modal Class definition ---
class RegexInputModal extends Modal {
    result: string;
    onSubmit: (result: string | null) => void;
    initialValue: string;
    history: string[]; // Added history property
    inputComponent: Setting; // To access the input element later
    textInputEl: HTMLInputElement | null = null; // Reference to the input element

    constructor(app: App, initialValue: string, history: string[], onSubmit: (result: string | null) => void) {
        super(app);
        this.initialValue = initialValue;
        this.history = history; // Store history
        this.onSubmit = onSubmit;
        this.result = initialValue; // Initialize result with initial value
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty(); // Clear previous content

        contentEl.createEl('h2', { text: 'Enter Regex Filter' });

        this.inputComponent = new Setting(contentEl) // Store the Setting object
            .setName('Regular Expression (supports Unicode):')
            .addText((text) => {
                this.textInputEl = text.inputEl; // Get the input element
                text
                    .setValue(this.initialValue)
                    .setPlaceholder('e.g., ^\\s*- \\[ \\].*💡')
                    .onChange((value) => {
                        this.result = value;
                    });
                // Focus and select the text input when the modal opens
                text.inputEl.focus();
                text.inputEl.select();

                // Add keydown listener for Enter key
                text.inputEl.addEventListener('keydown', (e) => {
                    // Submit on Enter unless Shift/Ctrl/Meta/Alt is pressed
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                         e.preventDefault(); // Prevent default Enter behavior (like newline)
                         this.submit();
                    }
                 });

            });

        // Add a specific class to the control element for potential styling
         this.inputComponent.controlEl.addClass('regex-filter-input-control');


        // Display history buttons if history is not empty
        if (this.history && this.history.length > 0) {
            const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
            historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' });
            this.history.forEach(histEntry => {
                const btn = historyEl.createEl('button', {
                    text: `/${histEntry}/`, // Display regex clearly
                    cls: 'regex-filter-history-item',
                    attr: { title: histEntry } // Full regex on hover
                });
                btn.addEventListener('click', () => {
                    if (this.textInputEl) {
                        this.textInputEl.value = histEntry; // Set input value
                        this.result = histEntry; // Update internal result
                        this.textInputEl.focus(); // Refocus input
                    }
                });
            });
        }

        // Add Submit and Cancel buttons
        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText('Apply Filter')
                .setCta() // Make it the prominent button
                .onClick(() => {
                    this.submit();
                }))
            .addButton((btn) => btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                    this.onSubmit(null); // Indicate cancellation
                }));
    }

    submit() {
        // Only submit if the result is not just whitespace
        if (this.result && this.result.trim().length > 0) {
            this.close();
            this.onSubmit(this.result);
        } else if (this.result === "") {
             // Handle empty string submission explicitly
             new Notice("Regex cannot be empty. Filter cancelled.");
             this.close();
             this.onSubmit(null);
        } else {
            // Handle whitespace-only input
            new Notice("Please enter a valid regular expression.");
            // Optionally clear the input or keep it as is
            if(this.textInputEl) this.textInputEl.focus();
        }
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty(); // Clean up the modal content
    }
}