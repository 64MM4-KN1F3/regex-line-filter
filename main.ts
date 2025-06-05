import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, EditorState } from 'obsidian'; // Added EditorState
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body';

// --- Settings ---
export interface SavedRegexItem {
  id: string;
  regex: string;
}

interface RegexLineFilterSettings {
    hideEmptyLines: boolean;
    includeChildItems: boolean; // New setting
    regexHistory: string[];
    savedRegexes: SavedRegexItem[];
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
    hideEmptyLines: true,
    includeChildItems: true, // Default to true
    regexHistory: [],
    savedRegexes: [],
}

// --- State & Effects ---
interface FilterState {
    regex: RegExp | null;
    enabled: boolean;
    hideEmptyLines: boolean;
    includeChildItems: boolean; // New state property
}
const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();
const setIncludeChildItemsEffect = StateEffect.define<boolean>(); // New effect

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

        buildDecorations(view: EditorView): DecorationSet {
            const builder = new RangeSetBuilder<Decoration>();
            const { regex, enabled, hideEmptyLines, includeChildItems } = view.state.field(filterStateField); // Get includeChildItems

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
                // Pass 1: Determine all lines to show.
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    if (regex.test(line.text)) {
                        isVisible[i] = true; // Show the matching line.

                        if (includeChildItems) { // Check the setting before including children
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
                }

                // Pass 2: Apply hiding decorations.
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

// --- StateField definition ---
const filterStateField = StateField.define<FilterState>({
    create(editorState: EditorState): FilterState { // editorState is available here but we use .init for plugin settings
        return { // This create is a fallback, .init() in plugin.onload will provide actual initial values
            regex: null,
            enabled: false,
            hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines,
            includeChildItems: DEFAULT_SETTINGS.includeChildItems,
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
            if (effect.is(setIncludeChildItemsEffect)) { // Handle new effect
                newValue.includeChildItems = effect.value;
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

        // Ensure settings components are initialized
        this.settings.savedRegexes = this.settings.savedRegexes || [];
        this.settings.regexHistory = (this.settings.regexHistory || []).slice(0, REGEX_HISTORY_LIMIT);
        if (typeof this.settings.includeChildItems !== 'boolean') {
            this.settings.includeChildItems = DEFAULT_SETTINGS.includeChildItems;
        }


        this.addCommand({
            id: 'toggle-regex-line-filter',
            name: 'Toggle Regex Line Filter',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.toggleFilter(editor, view);
            },
        });

        this.registerAllSavedRegexCommands();

        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));

        this.registerEditorExtension([
            filterStateField.init(() => ({ // Use .init for initial state per-editor from plugin settings
                regex: null,
                enabled: false,
                hideEmptyLines: this.settings.hideEmptyLines,
                includeChildItems: this.settings.includeChildItems,
            })),
            filterViewPlugin
        ]);

        this.addCssVariables();

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange)
        );

        this.app.workspace.onLayoutReady(() => {
            // Dispatch initial settings to ensure all views are consistent,
            // especially if they were created before settings were fully loaded or if .init wasn't enough.
            this.dispatchHideEmptyLinesToEditors(this.settings.hideEmptyLines);
            this.dispatchIncludeChildItemsToEditors(this.settings.includeChildItems);
            this.updateBodyClassForActiveLeaf();
        });
    }

    onunload() {
        console.log('Unloading Regex Line Filter plugin');
        this.removeCssVariables();
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
        this.settings.regexHistory = (this.settings.regexHistory || []).slice(0, REGEX_HISTORY_LIMIT);
        this.settings.savedRegexes = this.settings.savedRegexes || [];
        if (typeof this.settings.includeChildItems !== 'boolean') { // Ensure new setting is initialized
            this.settings.includeChildItems = DEFAULT_SETTINGS.includeChildItems;
        }
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

    dispatchHideEmptyLinesToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({ effects: setHideEmptyLinesEffect.of(newValue) });
                 }
            } catch (e) {
                console.warn("Regex Line Filter: Error dispatching hideEmptyLines setting", e);
            }
        });
    }

    dispatchIncludeChildItemsToEditors(newValue: boolean) { // New dispatch method
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({ effects: setIncludeChildItemsEffect.of(newValue) });
                 }
            } catch (e) {
                console.warn("Regex Line Filter: Error dispatching includeChildItems setting", e);
            }
        });
    }

    addCssVariables() {
        const cssId = 'regex-filter-dynamic-styles';
        if (document.getElementById(cssId)) return;
        const vignetteWidth = '160px'; const vignetteColor = 'rgba(0, 0, 0, 0.4)'; const transitionDuration = '0.3s';
        const cssVars = `:root { --regex-filter-vignette-width: ${vignetteWidth}; --regex-filter-vignette-color: ${vignetteColor}; --regex-filter-transition-duration: ${transitionDuration}; }`;
        this.cssStyleEl = document.createElement('style'); this.cssStyleEl.id = cssId; this.cssStyleEl.textContent = cssVars;
        document.head.appendChild(this.cssStyleEl);
    }
    removeCssVariables() {
        if (this.cssStyleEl) { this.cssStyleEl.remove(); this.cssStyleEl = null; }
        const existingStyle = document.getElementById('regex-filter-dynamic-styles');
        if (existingStyle) { existingStyle.remove(); }
        document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
    }


    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views."); return;
        }
        const currentFilterState = cm.state.field(filterStateField, false);
        if(currentFilterState === undefined) {
             new Notice("Filter state not found. Please try again or reload the note."); return;
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
            this.app, prefillValue, this.settings.regexHistory,
            (result) => {
                if (result) {
                    try {
                        const regex = new RegExp(result, 'u');
                        this.lastRegexStr = result; this.updateRegexHistory(result);
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

    truncateRegex(regex: string, maxLength = 30): string {
        if (regex.length <= maxLength) return regex;
        return regex.substring(0, maxLength) + "...";
    }

    registerAllSavedRegexCommands() {
        (this.settings.savedRegexes || []).forEach(item => this.registerCommandForSavedRegex(item));
    }

    registerCommandForSavedRegex(item: SavedRegexItem) {
        const commandId = `apply-saved-regex-${item.id}`;
        // Check if command already exists to prevent duplication if this is called multiple times
        // @ts-ignore
        if (this.app.commands.commands[`${this.manifest.id}:${commandId}`]) {
            return;
        }
        this.addCommand({
            id: commandId,
            name: `Apply Filter: /${this.truncateRegex(item.regex)}/`,
            editorCallback: (editor: Editor, view: MarkdownView) => this.applySpecificRegex(item.regex, editor, view)
        });
    }

    unregisterCommandForSavedRegex(itemSpecificIdPart: string) {
        const commandIdSuffix = `apply-saved-regex-${itemSpecificIdPart}`;
        const fullCommandId = `${this.manifest.id}:${commandIdSuffix}`;
        // @ts-ignore
        if (this.app.commands.commands[fullCommandId]) { delete this.app.commands.commands[fullCommandId]; }
        // @ts-ignore
        if (this.app.commands.editorCommands[fullCommandId]) { delete this.app.commands.editorCommands[fullCommandId]; }
    }

    applySpecificRegex(regexString: string, editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Regex filter currently only works in Live Preview or Source Mode views."); return;
        }
        try {
            const regex = new RegExp(regexString, 'u');
            cm.dispatch({ effects: [setRegexEffect.of(regex)] });
            this.updateBodyClassForActiveLeaf();
            new Notice(`Applied saved regex: /${regexString}/u`);
        } catch (e) {
            new Notice(`Invalid saved regex: /${regexString}/u. Error: ${(e as Error).message}`);
            try {
                const currentFilterState = cm.state.field(filterStateField);
                if (currentFilterState.enabled) { cm.dispatch({ effects: toggleFilterEffect.of(false) });}
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

    // Section for General Filter Options
    containerEl.createEl('h3', { text: 'General Filter Options' });

    new Setting(containerEl)
      .setName('Hide empty lines')
      .setDesc('When the filter is active, also hide lines that contain only whitespace.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.hideEmptyLines)
        .onChange(async (value) => {
          this.plugin.settings.hideEmptyLines = value;
          await this.plugin.saveSettings();
          this.plugin.dispatchHideEmptyLinesToEditors(value);
        }));

    new Setting(containerEl) // New Setting for includeChildItems
      .setName('Include child items')
      .setDesc('Automatically include indented child items (e.g., sub-bullets) when their parent line matches the filter.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeChildItems) // Default ON
        .onChange(async (value) => {
          this.plugin.settings.includeChildItems = value;
          await this.plugin.saveSettings();
          this.plugin.dispatchIncludeChildItemsToEditors(value); // Dispatch change
        }));

    containerEl.createEl('hr'); // Separator

    // Section for Saved Regex Filters
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
        settingControl.settingEl.style.border = 'none'; settingControl.settingEl.style.padding = '0';
        settingControl.addExtraButton(button => {
            button.setIcon('play').setTooltip('Apply this regex now')
                .onClick(() => {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView) { this.plugin.applySpecificRegex(savedRegexItem.regex, activeView.editor, activeView); }
                    else { new Notice('No active Markdown editor to apply the regex to.'); }
                });
        });
        settingControl.addExtraButton(button => {
            button.setIcon('edit').setTooltip('Edit Regex')
                .onClick(() => new AddSavedRegexModal(this.app, this.plugin, this, savedRegexItem, index).open());
        });
        settingControl.addExtraButton(button => {
            button.setIcon('trash').setTooltip('Delete Regex')
                .onClick(async () => await this.removeSavedRegex(index));
        });
    });
  }

  async removeSavedRegex(index: number): Promise<void> {
    const savedRegexes = this.plugin.settings.savedRegexes || [];
    const removedItem = savedRegexes[index];
    if (removedItem) {
        savedRegexes.splice(index, 1);
        this.plugin.settings.savedRegexes = savedRegexes;
        await this.plugin.saveSettings();
        this.plugin.unregisterCommandForSavedRegex(removedItem.id);
        this.initExistingSavedRegexes(this.savedRegexesDiv);
        new Notice(`Removed saved regex: /${this.plugin.truncateRegex(removedItem.regex)}/`);
    }
  }
}

// --- Modal Class definition (Existing RegexInputModal) ---
class RegexInputModal extends Modal {
    result: string; onSubmit: (result: string | null) => void; initialValue: string; history: string[];
    inputComponent: Setting; textInputEl: HTMLInputElement | null = null;
    constructor(app: App, initialValue: string, history: string[], onSubmit: (result: string | null) => void) {
        super(app); this.initialValue = initialValue; this.history = history; this.onSubmit = onSubmit; this.result = initialValue;
    }
    onOpen() {
        const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Enter regex filter' });
        this.inputComponent = new Setting(contentEl).setName('Regular expression (supports Unicode):')
            .addText((text) => {
                this.textInputEl = text.inputEl;
                text.setValue(this.initialValue).setPlaceholder('e.g., ^\\s*- \\[ \\].*💡').onChange((value) => { this.result = value; });
                text.inputEl.focus(); text.inputEl.select();
                text.inputEl.addEventListener('keydown', (e) => { if (e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey) {e.preventDefault();this.submit();}});
            });
         this.inputComponent.controlEl.addClass('regex-filter-input-control');
        if (this.history && this.history.length > 0) {
            const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
            historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' });
            this.history.forEach(histEntry => {
                const btn = historyEl.createEl('button', { text: `/${histEntry}/`, cls: 'regex-filter-history-item', attr: { title: histEntry } });
                btn.addEventListener('click', () => { if (this.textInputEl) { this.textInputEl.value = histEntry; this.result = histEntry; this.textInputEl.focus(); }});
            });
        }
        new Setting(contentEl)
            .addButton((btn) => btn.setButtonText('Apply filter').setCta().onClick(() => { this.submit(); }))
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null); }));
    }
    submit() {
        if (this.result && this.result.trim().length > 0) { this.close(); this.onSubmit(this.result); }
        else if (this.result === "") { this.close(); this.onSubmit(null); }
        else { new Notice("Please enter a valid regular expression."); if(this.textInputEl) this.textInputEl.focus(); }
    }
    onClose() { this.contentEl.empty(); }
}

// --- AddSavedRegexModal Class (New) ---
class AddSavedRegexModal extends Modal {
    plugin: RegexLineFilterPlugin; settingsTab: RegexLineFilterSettingTab; existingItem: SavedRegexItem | null;
    itemIndex: number; currentRegexText: string; inputEl: HTMLInputElement;
    constructor(app: App, plugin: RegexLineFilterPlugin, settingsTab: RegexLineFilterSettingTab, existingItemToEdit: SavedRegexItem | null, itemIndex: number) {
        super(app); this.plugin = plugin; this.settingsTab = settingsTab; this.existingItem = existingItemToEdit;
        this.itemIndex = itemIndex; this.currentRegexText = existingItemToEdit ? existingItemToEdit.regex : "";
    }
    onOpen() {
        const { contentEl } = this; contentEl.empty();
        contentEl.createEl('h2', { text: this.existingItem ? 'Edit Saved Regex' : 'Add New Saved Regex' });
        new Setting(contentEl).setName('Regular expression:').setDesc('Enter the regex string. It will be compiled with the \'u\' (unicode) flag.')
            .addText(text => {
                this.inputEl = text.inputEl;
                text.setValue(this.currentRegexText).setPlaceholder('e.g., ^\\s*- \\[ \\]').onChange(value => this.currentRegexText = value);
                text.inputEl.style.width = '100%';
                text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey) {e.preventDefault();this.doSubmit();}});
            });
        this.inputEl.focus(); this.inputEl.select();
        new Setting(contentEl)
            .addButton(button => button.setButtonText(this.existingItem ? 'Save Changes' : 'Save Regex').setCta().onClick(() => this.doSubmit()))
            .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
    }
    async doSubmit() {
        const trimmedRegex = this.currentRegexText.trim();
        if (trimmedRegex === "") { new Notice("Regex cannot be empty."); this.inputEl.focus(); return; }
        try { new RegExp(trimmedRegex, 'u'); } catch (e) { new Notice(`Invalid regex: ${(e as Error).message}`); this.inputEl.focus(); return; }
        const savedRegexes = this.plugin.settings.savedRegexes || [];
        if (this.itemIndex >= 0 && this.itemIndex < savedRegexes.length && this.existingItem) {
            const itemToUpdate = savedRegexes[this.itemIndex];
            if (itemToUpdate.regex !== trimmedRegex) {
                this.plugin.unregisterCommandForSavedRegex(itemToUpdate.id);
                itemToUpdate.regex = trimmedRegex;
                this.plugin.registerCommandForSavedRegex(itemToUpdate);
                new Notice('Saved regex updated!');
            } else { new Notice('No changes made to the regex.'); this.close(); return; }
        } else {
            const newItem: SavedRegexItem = { id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9), regex: trimmedRegex };
            savedRegexes.push(newItem); this.plugin.registerCommandForSavedRegex(newItem); new Notice('New regex saved!');
        }
        this.plugin.settings.savedRegexes = savedRegexes;
        await this.plugin.saveSettings();
        this.settingsTab.initExistingSavedRegexes(this.settingsTab.savedRegexesDiv); this.close();
    }
    onClose() { this.contentEl.empty(); }
}