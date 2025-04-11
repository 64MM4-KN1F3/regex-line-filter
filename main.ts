import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, editorInfoField, TFile } from 'obsidian';
import { EditorState, StateField, StateEffect, Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5; // Max number of regex strings to store

// --- Settings ---
interface RegexLineFilterSettings {
    hideEmptyLines: boolean;
    regexHistory: string[]; // Stores previously used regex strings
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
    hideEmptyLines: true,
    regexHistory: [], // Initialize empty history for regex strings
}

// --- State & Effects ---
interface FilterState {
    regex: RegExp | null;
    enabled: boolean;
    hideEmptyLines: boolean;
}

const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();

// --- ViewPlugin definition ---
const filterViewPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;
        constructor(view: EditorView) { this.decorations = this.buildDecorations(view); }
        update(update: ViewUpdate) {
            if (update.docChanged || update.viewportChanged || update.state.field(filterStateField) !== update.startState.field(filterStateField)) {
                 this.decorations = this.buildDecorations(update.view);
            }
        }

        // Build decorations - Iterates ALL lines and includes typeof check
        buildDecorations(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();
            const { regex, enabled, hideEmptyLines } = view.state.field(filterStateField);

            if (!enabled || !regex) {
                return builder.finish();
            }

            const doc = view.state.doc;

            try {
                // Iterate using line numbers to ensure all lines (including folded) are checked
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    const lineText = line?.text; // Safely access text

                    // Defensive check for valid string text
                    if (typeof lineText !== 'string') {
                        console.warn(`Regex Line Filter: Skipping line ${i} due to non-string text.`);
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
                        builder.add(line.from, line.from, Decoration.line({
                            attributes: { class: 'regex-filter-hidden-line' }
                        }));
                    }
                }
            } catch (e) {
                console.error("Regex Line Filter: Error during decoration build:", e);
            }
            return builder.finish();
        }
    },
    {
        decorations: (v) => v.decorations,
    }
);
// --- End of ViewPlugin definition ---


// --- StateField definition ---
const filterStateField = StateField.define<FilterState>({
    create(state): FilterState {
        return {
             regex: null,
             enabled: false,
             hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines,
        };
    },
    update(value, tr): FilterState {
        let newValue: FilterState = { ...value };
        for (let effect of tr.effects) {
            if (effect.is(setRegexEffect)) {
                newValue.regex = effect.value;
                newValue.enabled = !!effect.value; // Enable if regex is set, disable if null
            }
            if (effect.is(toggleFilterEffect)) {
                newValue.enabled = effect.value;
                if (!effect.value) { // Disabling
                    newValue.enabled = false;
                } else if (!newValue.regex) { // Trying to enable without regex
                    newValue.enabled = false;
                    console.warn("Attempted to enable filter without a regex.");
                }
            }
            if (effect.is(setHideEmptyLinesEffect)) {
                newValue.hideEmptyLines = effect.value;
            }
        }
        return newValue;
    }
});
// --- End of State Field Definition ---


// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings;
    lastRegexStr: string | null = null; // Stores the most recent successful regex string for pre-filling
    cssStyleEl: HTMLElement | null = null;

    async onload() {
        console.log('Loading Regex Line Filter plugin');
        await this.loadSettings();

        this.addCommand({
            id: 'toggle-regex-filter',
            name: 'Toggle Regex Line Filter',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.toggleFilter(editor, view);
            },
        });

        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));
        this.registerEditorExtension([filterStateField, filterViewPlugin]);
        this.addCss();

        this.app.workspace.onLayoutReady(() => {
            this.dispatchSettingToEditors(this.settings.hideEmptyLines);
        });
     }

    onunload() {
        console.log('Unloading Regex Line Filter plugin');
        this.removeCss();
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                const currentFilterState = cm.state.field(filterStateField, false);
                if (currentFilterState?.enabled) {
                    cm.dispatch({ effects: toggleFilterEffect.of(false) });
                }
            } catch (e) { /* Ignore */ }
        });
     }

    // Load settings, ensuring regexHistory exists and is trimmed
    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!Array.isArray(this.settings.regexHistory)) {
            this.settings.regexHistory = [];
        }
        this.settings.regexHistory = this.settings.regexHistory.slice(0, REGEX_HISTORY_LIMIT);
    }

    // Save settings
    async saveSettings() {
        await this.saveData(this.settings);
    }

    // Update regex string history
    updateRegexHistory(newRegexString: string) {
        const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString);
        const updatedHistory = [newRegexString, ...filteredHistory];
        this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT);
        this.saveSettings(); // Persist history
    }


    dispatchSettingToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({ effects: setHideEmptyLinesEffect.of(newValue) });
                }
            } catch (e) { console.warn("Regex Line Filter: Error dispatching setting", e); }
        });
     }

    addCss() {
        if (document.getElementById('regex-filter-styles')) return;
        const css = `.regex-filter-hidden-line { display: none !important; }`;
        this.cssStyleEl = document.createElement('style');
        this.cssStyleEl.id = 'regex-line-filter-styles';
        this.cssStyleEl.textContent = css;
        document.head.appendChild(this.cssStyleEl);
     }

    removeCss() {
         if (this.cssStyleEl) { this.cssStyleEl.remove(); this.cssStyleEl = null; }
         const existingStyle = document.getElementById('regex-filter-styles');
         if (existingStyle) { existingStyle.remove(); }
    }

    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as any).cm as EditorView;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter only works in Live Preview or Source Mode.");
            return;
        }
        const currentFilterState = cm.state.field(filterStateField, false);
        if(currentFilterState === undefined) {
            new Notice("Filter not ready. Please try toggling again.");
            return;
        }

        if (currentFilterState.enabled) {
            cm.dispatch({ effects: toggleFilterEffect.of(false) });
            new Notice('Regex filter disabled.');
        } else {
            // Prompt for regex, passing CM view for dispatching later
            this.promptForRegex(cm);
        }
    }

    // promptForRegex uses history for pre-fill and passes it to Modal
    promptForRegex(cm: EditorView) {
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";

        new RegexInputModal(this.app, prefillValue, this.settings.regexHistory, (result) => {
            if (result) { // result is the regex string from the modal
                try {
                    const regex = new RegExp(result, 'u');

                    // Update history and last used string *before* dispatching
                    this.lastRegexStr = result;
                    this.updateRegexHistory(result);

                    // Dispatch only the effect to set the regex
                    cm.dispatch({
                        effects: [ setRegexEffect.of(regex) ]
                    });
                    new Notice(`Regex filter enabled: /${result}/u`);
                } catch (e) {
                    const errorMessage = (e instanceof Error) ? e.message : String(e);
                    new Notice(`Invalid Regex: ${errorMessage}`);
                    console.error("Regex Compile Error:", e);
                    try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore */ }
                }
            } else {
                 new Notice('Regex filter cancelled.');
                 try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch(e) { /* Ignore */ }
            }
        }).open();
    }
} // End of Plugin Class

// --- Settings Tab Class ---
class RegexLineFilterSettingTab extends PluginSettingTab {
	plugin: RegexLineFilterPlugin;
	constructor(app: App, plugin: RegexLineFilterPlugin) { super(app, plugin); this.plugin = plugin; }
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
                    this.plugin.dispatchSettingToEditors(value);
				}));
        // You could add a "Clear History" button here if desired later
	}
}

// --- Modal Class definition (Includes History Display) ---
class RegexInputModal extends Modal {
    result: string;
    onSubmit: (result: string | null) => void;
    initialValue: string;
    history: string[]; // Stores the regex strings
    inputComponent: Setting;
    textInputEl: HTMLInputElement | null = null; // Reference to the actual input element

    constructor(app: App, initialValue: string, history: string[], onSubmit: (result: string | null) => void) {
        super(app);
        this.initialValue = initialValue;
        this.history = history;
        this.onSubmit = onSubmit;
        this.result = initialValue;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Enter Regex Filter' });

        this.inputComponent = new Setting(contentEl)
            .setName('Regular Expression (supports emoji):')
            .addText((text) => {
                this.textInputEl = text.inputEl; // Store reference
                text.setValue(this.initialValue)
                    .setPlaceholder('e.g., ^\\s*- \\[ \\].*💡')
                    .onChange((value) => { this.result = value; });
                text.inputEl.focus();
                text.inputEl.select();
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                        this.submit();
                    }
                });
            });
        this.inputComponent.controlEl.addClass('regex-filter-input-control');

        // --- Add Regex String History Section ---
        if (this.history && this.history.length > 0) {
            const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
            historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' });

            this.history.forEach(histEntry => { // histEntry is a regex string
                const btn = historyEl.createEl('button', {
                    text: `/${histEntry}/`, // Display the regex string nicely
                    cls: 'regex-filter-history-item',
                    attr: { title: histEntry } // Show full regex on hover if needed
                });
                btn.addEventListener('click', () => {
                    if (this.textInputEl) {
                        this.textInputEl.value = histEntry; // Update input field text
                        this.result = histEntry; // Update internal result state
                        this.textInputEl.focus(); // Keep focus on input
                    }
                });
            });
        }
        // --- End History Section ---

        // Action buttons
        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Apply Filter').setCta().onClick(() => { this.submit(); }))
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null); }));
    }

    submit() {
        // Use the current value of this.result (reflects typed or clicked history)
        if (this.result && this.result.trim().length > 0) {
             this.close();
             this.onSubmit(this.result);
        } else if (this.result === "") {
             new Notice("Regex cannot be empty. Filter cancelled.");
             this.close();
             this.onSubmit(null);
        } else {
             new Notice("Please enter a regular expression.");
        }
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}
// --- End of Modal Class definition ---