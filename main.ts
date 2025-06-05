import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { EditorState, StateField, StateEffect, Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body';

// --- Settings ---
export interface SavedRegexItem { // Made exportable for potential future use - otherwise can be internal
  id: string;
  regex: string;
}

interface RegexLineFilterSettings {
    hideEmptyLines: boolean;
    regexHistory: string[];
    savedRegexes: SavedRegexItem[]; // Added for saved regexes
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
    hideEmptyLines: true,
    regexHistory: [],
    savedRegexes: [], // Default to empty array
}

// --- State & Effects --- (Existing code, no changes)
interface FilterState { regex: RegExp | null; enabled: boolean; hideEmptyLines: boolean; }
const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();

// --- ViewPlugin definition --- (Existing code, no changes)
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
            const isVisible = new Array(doc.lines + 1).fill(false);
            const getIndentLevel = (text: string): number => {
                const match = text.match(/^(\s*)/);
                return match ? match[1].length : 0;
            };

            try {
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    if (regex.test(line.text)) {
                        isVisible[i] = true;
                        const parentIndent = getIndentLevel(line.text);
                        for (let j = i + 1; j <= doc.lines; j++) {
                            const childLine = doc.line(j);
                            const childIndent = getIndentLevel(childLine.text);
                            if (childIndent > parentIndent) {
                                isVisible[j] = true;
                            } else {
                                break;
                            }
                        }
                    }
                }

                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    const isEmpty = line.text.trim().length === 0;
                    let shouldHide = !isVisible[i];
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

// --- StateField definition --- (Existing code, no changes)
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
                 }
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
});


// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings;
    lastRegexStr: string | null = null;
    cssStyleEl: HTMLElement | null = null;

    async onload() {
        console.log('Loading Regex Line Filter plugin');
        await this.loadSettings();

        // Ensure settings components are initialized (especially for users upgrading)
        if (!this.settings.savedRegexes) {
            this.settings.savedRegexes = [];
        }
        if (!Array.isArray(this.settings.regexHistory)) {
            this.settings.regexHistory = [];
        }


        this.addCommand({
            id: 'toggle-regex-line-filter',
            name: 'Toggle Regex Line Filter', // More descriptive name
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.toggleFilter(editor, view);
            },
        });

        this.registerAllSavedRegexCommands(); // Register commands for saved regexes

        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));
        this.registerEditorExtension([filterStateField, filterViewPlugin]);
        this.addCssVariables();

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange)
        );

        this.app.workspace.onLayoutReady(() => {
            this.dispatchSettingToEditors(this.settings.hideEmptyLines);
            this.updateBodyClassForActiveLeaf();
        });
    }

    onunload() {
        console.log('Unloading Regex Line Filter plugin');
        this.removeCssVariables();
        // Commands added by this.addCommand are usually cleaned up by Obsidian
        // However, for dynamically managed commands, explicit cleanup might be desired if issues arise,
        // but typically not needed if Obsidian handles plugin unload correctly.
    }

    private handleActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
        let filterIsEnabledOnActiveLeaf = false;
        if (leaf && leaf.view instanceof MarkdownView) {
            const cm = (leaf.view.editor as { cm?: EditorView })?.cm;
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

    private updateBodyClassForActiveLeaf(): void {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.handleActiveLeafChange(activeView ? activeView.leaf : null);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        // Ensure history limit
        this.settings.regexHistory = (this.settings.regexHistory || []).slice(0, REGEX_HISTORY_LIMIT);
        // Ensure savedRegexes is an array
        this.settings.savedRegexes = this.settings.savedRegexes || [];
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateRegexHistory(newRegexString: string) {
        const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString);
        const updatedHistory = [newRegexString, ...filteredHistory];
        this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT);
        this.saveSettings(); // Save settings when history is updated
    }

    dispatchSettingToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({ effects: setHideEmptyLinesEffect.of(newValue) });
                 }
            } catch (e) {
                console.warn("Regex Line Filter: Error dispatching setting to an editor view", e);
            }
        });
    }

    addCssVariables() { /* ... (existing code) ... */ }
    removeCssVariables() { /* ... (existing code) ... */ }


    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views.");
            return;
        }
        const currentFilterState = cm.state.field(filterStateField, false);
        if(currentFilterState === undefined) {
             new Notice("Filter state not found. Please try again or reload the note.");
            return;
        }
        if (currentFilterState.enabled) {
            cm.dispatch({ effects: toggleFilterEffect.of(false) });
            this.updateBodyClassForActiveLeaf();
            new Notice('Regex filter disabled.');
        } else {
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
                        cm.dispatch({ effects: [setRegexEffect.of(regex)] });
                        this.updateBodyClassForActiveLeaf();
                        new Notice(`Regex filter enabled: /${result}/u`);
                    } catch (e) {
                        new Notice(`Invalid regex: ${(e as Error).message}`);
                        try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch (cmError) { /* ignore */ }
                        this.updateBodyClassForActiveLeaf();
                    }
                } else {
                    new Notice('Regex filter cancelled.');
                    try { cm.dispatch({ effects: toggleFilterEffect.of(false) }); } catch (cmError) { /* ignore */ }
                    this.updateBodyClassForActiveLeaf();
                }
            }
        ).open();
    }

    // --- Saved Regex Command Management ---
    truncateRegex(regex: string, maxLength = 30): string {
        if (regex.length <= maxLength) return regex;
        return regex.substring(0, maxLength) + "...";
    }

    registerAllSavedRegexCommands() {
        (this.settings.savedRegexes || []).forEach(item => {
            this.registerCommandForSavedRegex(item);
        });
    }

    registerCommandForSavedRegex(item: SavedRegexItem) {
        const command = {
            id: `apply-saved-regex-${item.id}`,
            name: `Apply Filter: /${this.truncateRegex(item.regex)}/`,
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.applySpecificRegex(item.regex, editor, view);
            }
        };
        this.addCommand(command);
    }

    unregisterCommandForSavedRegex(itemSpecificIdPart: string) {
        const commandIdSuffix = `apply-saved-regex-${itemSpecificIdPart}`;
        const fullCommandId = `${this.manifest.id}:${commandIdSuffix}`;

        // @ts-ignore
        if (this.app.commands.commands[fullCommandId]) {
            // @ts-ignore
            delete this.app.commands.commands[fullCommandId];
        }
        // @ts-ignore
        if (this.app.commands.editorCommands[fullCommandId]) {
            // @ts-ignore
            delete this.app.commands.editorCommands[fullCommandId];
        }
    }

    applySpecificRegex(regexString: string, editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views.");
            return;
        }

        try {
            const regex = new RegExp(regexString, 'u');
            // Note: We are NOT updating lastRegexStr or regexHistory here by default.
            // This keeps saved filters distinct from ad-hoc typed filters.
            // If you want to update them, uncomment the following lines:
            // this.lastRegexStr = regexString;
            // this.updateRegexHistory(regexString);

            cm.dispatch({
                effects: [setRegexEffect.of(regex)] // This also sets enabled = true
            });
            this.updateBodyClassForActiveLeaf();
            new Notice(`Applied saved regex: /${regexString}/u`);
        } catch (e) {
            const errorMessage = (e instanceof Error) ? e.message : String(e);
            new Notice(`Invalid saved regex: /${regexString}/u. Error: ${errorMessage}`);
            console.error("Saved Regex Compile Error:", e);
            // Ensure filter is disabled if applying a bad saved regex
            try {
                const currentFilterState = cm.state.field(filterStateField);
                 // Only toggle off if it was enabled by this attempt or was already enabled
                if (currentFilterState.enabled) {
                     cm.dispatch({ effects: toggleFilterEffect.of(false) });
                }
            } catch (cmError) { /* ignore */ }
            this.updateBodyClassForActiveLeaf();
        }
    }
}

// --- Settings Tab Class ---
class RegexLineFilterSettingTab extends PluginSettingTab {
  plugin: RegexLineFilterPlugin;
  savedRegexesDiv: HTMLDivElement;

  constructor(app: App, plugin: RegexLineFilterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Regex Line Filter Settings' });

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

    containerEl.createEl('h3', { text: 'Saved Regex Filters' });
    containerEl.createEl('p', { text: 'Manage your saved regex filters. These can be assigned to hotkeys via Obsidian\'s hotkey settings (search for "Regex Line Filter: Apply Filter").' });

    new Setting(containerEl)
        .addButton(button => {
            button.setButtonText('Add New Saved Regex')
                .setCta()
                .onClick(() => {
                    new AddSavedRegexModal(this.app, this.plugin, this, null, -1).open();
                });
        });

    this.savedRegexesDiv = containerEl.createDiv('saved-regex-list');
    this.initExistingSavedRegexes(this.savedRegexesDiv);
  }

  initExistingSavedRegexes(container: HTMLDivElement): void {
    container.empty();

    const savedRegexes = this.plugin.settings.savedRegexes || [];

    if (savedRegexes.length === 0) {
        container.createEl('p', { text: 'No saved regex filters yet. Click "Add New Saved Regex" to create one.' });
        return;
    }

    const listEl = container.createDiv({ cls: 'saved-regex-items-wrapper' });

    savedRegexes.forEach((savedRegexItem, index) => {
        const itemDiv = listEl.createDiv({ cls: 'saved-regex-item' });
        const textSpan = itemDiv.createSpan({ cls: 'saved-regex-text' });
        textSpan.setText(`/${savedRegexItem.regex}/`);
        textSpan.setAttr('title', savedRegexItem.regex);

        const controlsDiv = itemDiv.createDiv({ cls: 'saved-regex-item-controls' });
        const settingControl = new Setting(controlsDiv);
        settingControl.settingEl.style.border = 'none';
        settingControl.settingEl.style.padding = '0';


        settingControl.addExtraButton(button => {
            button.setIcon('play')
                .setTooltip('Apply this regex now')
                .onClick(() => {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView) {
                        this.plugin.applySpecificRegex(savedRegexItem.regex, activeView.editor, activeView);
                    } else {
                        new Notice('No active Markdown editor to apply the regex to.');
                    }
                });
        });

        settingControl.addExtraButton(button => {
            button.setIcon('edit')
                .setTooltip('Edit Regex')
                .onClick(() => {
                    new AddSavedRegexModal(this.app, this.plugin, this, savedRegexItem, index).open();
                });
        });

        settingControl.addExtraButton(button => {
            button.setIcon('trash')
                .setTooltip('Delete Regex')
                .onClick(async () => {
                    // Optional: Add a confirmation dialog here for safety
                    // e.g., if (confirm(`Delete saved regex: /${savedRegexItem.regex}/?`)) { ... }
                    await this.removeSavedRegex(index);
                });
        });
    });
  }

  async removeSavedRegex(index: number): Promise<void> {
    const savedRegexes = this.plugin.settings.savedRegexes || [];
    const removedItem = savedRegexes[index];
    if (removedItem) {
        savedRegexes.splice(index, 1);
        this.plugin.settings.savedRegexes = savedRegexes; // Ensure the main settings object is updated
        await this.plugin.saveSettings();
        this.plugin.unregisterCommandForSavedRegex(removedItem.id);
        this.initExistingSavedRegexes(this.savedRegexesDiv); // Refresh UI
        new Notice(`Removed saved regex: /${this.plugin.truncateRegex(removedItem.regex)}/`);
    }
  }
}

// --- Modal Class definition (Existing RegexInputModal) ---
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
                text.setValue(this.initialValue)
                    .setPlaceholder('e.g., ^\\s*- \\[ \\].*💡')
                    .onChange((value) => { this.result = value; });
                text.inputEl.focus();
                text.inputEl.select();
                text.inputEl.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                         e.preventDefault(); this.submit();
                    }
                 });
            });
         this.inputComponent.controlEl.addClass('regex-filter-input-control');

        if (this.history && this.history.length > 0) {
            const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
            historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' });
            this.history.forEach(histEntry => {
                const btn = historyEl.createEl('button', { text: `/${histEntry}/`, cls: 'regex-filter-history-item', attr: { title: histEntry } });
                btn.addEventListener('click', () => {
                    if (this.textInputEl) {
                        this.textInputEl.value = histEntry; this.result = histEntry; this.textInputEl.focus();
                    }
                });
            });
        }

        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Apply filter').setCta().onClick(() => { this.submit(); }))
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null); }));
    }

    submit() {
        if (this.result && this.result.trim().length > 0) {
            this.close(); this.onSubmit(this.result);
        } else if (this.result === "") {
             this.close(); this.onSubmit(null);
        } else {
            new Notice("Please enter a valid regular expression.");
            if(this.textInputEl) this.textInputEl.focus();
        }
    }
    onClose() { this.contentEl.empty(); }
}


// --- AddSavedRegexModal Class (New) ---
class AddSavedRegexModal extends Modal {
    plugin: RegexLineFilterPlugin;
    settingsTab: RegexLineFilterSettingTab;
    existingItem: SavedRegexItem | null; // The original item if editing
    itemIndex: number; // Index in the array, -1 for new
    currentRegexText: string; // The text currently in the input field
    inputEl: HTMLInputElement;

    constructor(app: App, plugin: RegexLineFilterPlugin, settingsTab: RegexLineFilterSettingTab, existingItemToEdit: SavedRegexItem | null, itemIndex: number) {
        super(app);
        this.plugin = plugin;
        this.settingsTab = settingsTab;
        this.existingItem = existingItemToEdit; // Store the original item for reference if editing
        this.itemIndex = itemIndex;
        this.currentRegexText = existingItemToEdit ? existingItemToEdit.regex : "";
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: this.existingItem ? 'Edit Saved Regex' : 'Add New Saved Regex' });

        new Setting(contentEl)
            .setName('Regular expression:')
            .setDesc('Enter the regex string. It will be compiled with the \'u\' (unicode) flag.')
            .addText(text => {
                this.inputEl = text.inputEl;
                text.setValue(this.currentRegexText)
                    .setPlaceholder('e.g., ^\\s*- \\[ \\]')
                    .onChange(value => this.currentRegexText = value);
                text.inputEl.style.width = '100%';
                text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                         e.preventDefault();
                         this.doSubmit();
                    }
                 });
            });

        this.inputEl.focus();
        this.inputEl.select();

        new Setting(contentEl)
            .addButton(button => button
                .setButtonText(this.existingItem ? 'Save Changes' : 'Save Regex')
                .setCta()
                .onClick(() => this.doSubmit()))
            .addButton(button => button
                .setButtonText('Cancel')
                .onClick(() => this.close()));
    }

    async doSubmit() {
        const trimmedRegex = this.currentRegexText.trim();
        if (trimmedRegex === "") {
            new Notice("Regex cannot be empty.");
            this.inputEl.focus();
            return;
        }

        try {
            new RegExp(trimmedRegex, 'u'); // Validate regex syntax
        } catch (e) {
            new Notice(`Invalid regex: ${(e as Error).message}`);
            this.inputEl.focus();
            return;
        }

        const savedRegexes = this.plugin.settings.savedRegexes || [];

        if (this.itemIndex >= 0 && this.itemIndex < savedRegexes.length && this.existingItem) { // Editing existing item
            const itemToUpdate = savedRegexes[this.itemIndex];
            
            if (itemToUpdate.regex !== trimmedRegex) {
                this.plugin.unregisterCommandForSavedRegex(itemToUpdate.id); // Unregister old command
                itemToUpdate.regex = trimmedRegex; // Update regex string
                // ID (itemToUpdate.id) remains the same
                this.plugin.registerCommandForSavedRegex(itemToUpdate); // Register new command version
                new Notice('Saved regex updated!');
            } else {
                new Notice('No changes made to the regex.');
                // No need to save or re-register if no change
                this.close();
                return;
            }
        } else { // Adding new item
            const newItem: SavedRegexItem = {
                // Generate a somewhat unique ID
                id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
                regex: trimmedRegex
            };
            savedRegexes.push(newItem);
            this.plugin.registerCommandForSavedRegex(newItem);
            new Notice('New regex saved!');
        }
        
        this.plugin.settings.savedRegexes = savedRegexes; // Ensure the main settings object is updated
        await this.plugin.saveSettings();
        this.settingsTab.initExistingSavedRegexes(this.settingsTab.savedRegexesDiv); // Refresh UI
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}