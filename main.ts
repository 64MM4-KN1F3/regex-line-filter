import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian'; // Added WorkspaceLeaf
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
            const { regex, enabled, hideEmptyLines } = view.state.field(filterStateField); // hideEmptyLines from state
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
                    // If hideEmptyLines is true, empty lines are hidden regardless of match,
                    // which is a common interpretation of such a setting.
                    if (hideEmptyLines && isEmpty) {
                        shouldHide = true;
                    }

                    if (shouldHide) {
                        builder.add(line.from, line.from, Decoration.line({ attributes: { class: 'regex-filter-hidden-line' } }));
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
                newValue.enabled = !!effect.value;
            }
            if (effect.is(toggleFilterEffect)) {
                 newValue.enabled = effect.value;
                 if (effect.value && !newValue.regex) {
                    newValue.enabled = false;
                    // console.warn("Attempted to enable filter without a regex."); // User will be prompted or it won't enable.
                 }
                 if (!effect.value) { // Explicitly ensure enabled is false if toggling off
                    newValue.enabled = false;
                 }
            }
            if (effect.is(setHideEmptyLinesEffect)) {
                newValue.hideEmptyLines = effect.value;
            }
        }
        return newValue;
    },
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
        this.registerEditorExtension([filterStateField, filterViewPlugin]);
        this.addCssVariables();

        // Register event listener for active leaf changes
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange)
        );

        this.app.workspace.onLayoutReady(() => {
            this.dispatchSettingToEditors(this.settings.hideEmptyLines);
            // Set initial body class based on the currently active leaf after layout is ready
            this.updateBodyClassForActiveLeaf();
        });
    }

    onunload() {
        console.log('Unloading Regex Line Filter plugin');
        this.removeCssVariables(); // This also removes the body class as a final cleanup
        // Events registered with this.registerEvent are automatically cleaned up by Obsidian
    }

    // Method to handle active leaf changes - use arrow function for `this`
    private handleActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
        let filterIsEnabledOnActiveLeaf = false;
        if (leaf && leaf.view instanceof MarkdownView) {
            const markdownView = leaf.view;
            const editor = markdownView.editor;
            // Safely access CodeMirror EditorView instance
            const cm = (editor as { cm?: EditorView })?.cm;

            // Check if CM instance and our state field exist
            if (cm && cm.state && typeof cm.state.field === 'function' && cm.state.field(filterStateField, false) !== undefined) {
                const currentFilterState = cm.state.field(filterStateField);
                if (currentFilterState.enabled && currentFilterState.regex) {
                    filterIsEnabledOnActiveLeaf = true;
                }
            }
        }

        if (filterIsEnabledOnActiveLeaf) {
            document.body.classList.add(ACTIVE_FILTER_BODY_CLASS);
        } else {
            document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
        }
    }

    // Method to update body class based on the current active leaf's filter state
    private updateBodyClassForActiveLeaf(): void {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
            this.handleActiveLeafChange(activeView.leaf);
        } else {
            // No active MarkdownView, so treat as no filter active for vignette purposes
            this.handleActiveLeafChange(null);
        }
    }


    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        if (!Array.isArray(this.settings.regexHistory)) {
            this.settings.regexHistory = [];
        }
        this.settings.regexHistory = this.settings.regexHistory.slice(0, REGEX_HISTORY_LIMIT);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateRegexHistory(newRegexString: string) {
        const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString);
        const updatedHistory = [newRegexString, ...filteredHistory];
        this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT);
        this.saveSettings();
    }

    dispatchSettingToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({
                        effects: setHideEmptyLinesEffect.of(newValue)
                    });
                 }
            } catch (e) {
                console.warn("Regex Line Filter: Error dispatching setting to an editor view", e);
            }
        });
    }

    addCssVariables() {
        const cssId = 'regex-filter-dynamic-styles';
        if (document.getElementById(cssId)) return;

        const vignetteWidth = '160px';
        const vignetteColor = 'rgba(0, 0, 0, 0.4)';
        const transitionDuration = '0.3s';

        const cssVars = `
            :root {
              --regex-filter-vignette-width: ${vignetteWidth};
              --regex-filter-vignette-color: ${vignetteColor};
              --regex-filter-transition-duration: ${transitionDuration};
            }
        `;
        this.cssStyleEl = document.createElement('style');
        this.cssStyleEl.id = cssId;
        this.cssStyleEl.textContent = cssVars;
        document.head.appendChild(this.cssStyleEl);
    }

    removeCssVariables() {
        if (this.cssStyleEl) {
            this.cssStyleEl.remove();
            this.cssStyleEl = null;
        }
        const existingStyle = document.getElementById('regex-filter-dynamic-styles');
        if (existingStyle) {
            existingStyle.remove();
        }
        document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
    }


    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views.");
            console.warn("Regex Line Filter: Could not get CodeMirror EditorView instance from editor.");
            return;
        }

        const currentFilterState = cm.state.field(filterStateField, false);
        if(currentFilterState === undefined) {
             new Notice("Filter state not found for this editor. Please try toggling again, or reload the note.");
            return;
        }

        if (currentFilterState.enabled) {
            cm.dispatch({ effects: toggleFilterEffect.of(false) });
            this.updateBodyClassForActiveLeaf(); // Update based on new state
            new Notice('Regex filter disabled.');
        } else {
            // Prompting will lead to state change and then updateBodyClassForActiveLeaf call
            this.promptForRegex(cm);
        }
    }

    promptForRegex(cm: EditorView) {
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";
        new RegexInputModal(
            this.app,
            prefillValue,
            this.settings.regexHistory,
            (result) => {
                if (result) {
                    try {
                        const regex = new RegExp(result, 'u');
                        this.lastRegexStr = result;
                        this.updateRegexHistory(result);

                        cm.dispatch({
                           effects: [
                                setRegexEffect.of(regex) // This also sets enabled = true
                           ]
                        });
                        this.updateBodyClassForActiveLeaf(); // Update based on new state
                        new Notice(`Regex filter enabled: /${result}/u`);
                    } catch (e) {
                        const errorMessage = (e instanceof Error) ? e.message : String(e);
                        new Notice(`Invalid regex: ${errorMessage}`);
                        console.error("Regex Compile Error:", e);
                        // Ensure filter is disabled in CM state if regex compilation failed
                        try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch (cmError) { /* ignore */ }
                        this.updateBodyClassForActiveLeaf(); // Update based on new state (filter disabled)
                    }
                } else { // User cancelled or submitted empty
                    new Notice('Regex filter cancelled.');
                     // Ensure filter is disabled in CM state
                    try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch (cmError) { /* ignore */ }
                    this.updateBodyClassForActiveLeaf(); // Update based on new state (filter disabled)
                }
            }
        ).open();
    }
}

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

    new Setting(containerEl)
      .setName('Hide empty lines')
      .setDesc('When the filter is active, also hide lines that contain only whitespace.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideEmptyLines)
        .onChange(async (value) => {
          this.plugin.settings.hideEmptyLines = value;
          await this.plugin.saveSettings();
          this.plugin.dispatchSettingToEditors(value); // This will trigger view updates and buildDecorations
        }));
  }
}

// --- Modal Class definition ---
class RegexInputModal extends Modal {
    result: string;
    onSubmit: (result: string | null) => void;
    initialValue: string;
    history: string[];
    inputComponent: Setting;
    textInputEl: HTMLInputElement | null = null;

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

        contentEl.createEl('h2', { text: 'Enter regex filter' });

        this.inputComponent = new Setting(contentEl)
            .setName('Regular expression (supports Unicode):')
            .addText((text) => {
                this.textInputEl = text.inputEl;
                text
                    .setValue(this.initialValue)
                    .setPlaceholder('e.g., ^\\s*- \\[ \\].*💡')
                    .onChange((value) => {
                        this.result = value;
                    });
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

        if (this.history && this.history.length > 0) {
            const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
            historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' });
            this.history.forEach(histEntry => {
                const btn = historyEl.createEl('button', {
                    text: `/${histEntry}/`,
                    cls: 'regex-filter-history-item',
                    attr: { title: histEntry }
                });
                btn.addEventListener('click', () => {
                    if (this.textInputEl) {
                        this.textInputEl.value = histEntry;
                        this.result = histEntry; // Update internal result
                        this.textInputEl.focus();
                    }
                });
            });
        }

        new Setting(contentEl)
            .addButton((btn) => btn
                .setButtonText('Apply filter')
                .setCta()
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
        if (this.result && this.result.trim().length > 0) {
            this.close();
            this.onSubmit(this.result);
        } else if (this.result === "") { // Explicitly handle empty string submission
             // Notice handled by caller (promptForRegex) if needed, or here directly.
             // For consistency, let onSubmit(null) signify "no valid regex".
             this.close();
             this.onSubmit(null);
        } else { // Whitespace only
            new Notice("Please enter a valid regular expression.");
            if(this.textInputEl) this.textInputEl.focus();
            // Do not close, do not submit.
        }
    }

    onClose() {
        let { contentEl } = this;
        contentEl.empty();
    }
}