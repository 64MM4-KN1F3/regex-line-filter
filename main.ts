import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, EditorState } from 'obsidian';
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
    includeChildItems: boolean;
    regexHistory: string[];
    savedRegexes: SavedRegexItem[];
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
    hideEmptyLines: true,
    includeChildItems: true,
    regexHistory: [],
    savedRegexes: [],
}

// --- Helper to build combined regex ---
function buildCombinedRegex(regexStrings: string[]): RegExp | null {
    if (regexStrings.length === 0) {
        return null;
    }
    try {
        // Ensure each part is a valid regex segment and handle empty strings if they somehow get in
        const validPatterns = regexStrings.filter(s => s.trim() !== "").map(s => `(?:${s})`);
        if (validPatterns.length === 0) return null;
        const pattern = validPatterns.join('|');
        return new RegExp(pattern, 'u');
    } catch (e) {
        console.error("Regex Line Filter: Error building combined regex", e, regexStrings);
        new Notice("Error building combined filter. Some patterns may be invalid. Check console.");
        return null; // Return null if combined regex is invalid
    }
}

// --- State & Effects ---
interface FilterState {
    activeRegexStrings: string[]; // Stores the raw strings of active regexes
    combinedRegex: RegExp | null;  // The single RegExp object used for filtering (ORed strings)
    enabled: boolean;              // True if activeRegexStrings.length > 0 and combinedRegex is valid
    hideEmptyLines: boolean;
    includeChildItems: boolean;
}

const toggleSpecificRegexStringEffect = StateEffect.define<string>();      // Adds/removes a specific regex string
const applyManualRegexStringEffect = StateEffect.define<string | null>(); // Sets activeRegexStrings to [newString] or []
const clearAllRegexesEffect = StateEffect.define<void>();                 // Clears all active regex strings
const setHideEmptyLinesEffect = StateEffect.define<boolean>();
const setIncludeChildItemsEffect = StateEffect.define<boolean>();

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
            const { combinedRegex, enabled, hideEmptyLines, includeChildItems } = view.state.field(filterStateField);

            if (!enabled || !combinedRegex) {
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
                    if (combinedRegex.test(line.text)) {
                        isVisible[i] = true;
                        if (includeChildItems) {
                            const parentIndent = getIndentLevel(line.text);
                            for (let j = i + 1; j <= doc.lines; j++) {
                                const childLine = doc.line(j);
                                const childIndent = getIndentLevel(childLine.text);
                                if (childIndent > parentIndent) { isVisible[j] = true; }
                                else { break; }
                            }
                        }
                    }
                }
                for (let i = 1; i <= doc.lines; i++) {
                    const line = doc.line(i);
                    const isEmpty = line.text.trim().length === 0;
                    let shouldHide = !isVisible[i];
                    if (hideEmptyLines && isEmpty) { shouldHide = true; }
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
    { decorations: (v) => v.decorations, }
);

// --- StateField definition ---
const filterStateField = StateField.define<FilterState>({
    create(editorState: EditorState): FilterState {
        // Initial state values will be set by .init() in plugin.onload
        return {
            activeRegexStrings: [],
            combinedRegex: null,
            enabled: false,
            hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines, // Fallback, should be overridden by .init
            includeChildItems: DEFAULT_SETTINGS.includeChildItems, // Fallback
        };
    },
    update(value, tr): FilterState {
        let newActiveStrings = [...value.activeRegexStrings];
        let needsRebuild = false; // Flag to rebuild combinedRegex

        for (let effect of tr.effects) {
            if (effect.is(toggleSpecificRegexStringEffect)) {
                const str = effect.value;
                const index = newActiveStrings.indexOf(str);
                if (index > -1) { newActiveStrings.splice(index, 1); }
                else { newActiveStrings.push(str); }
                needsRebuild = true;
            }
            if (effect.is(applyManualRegexStringEffect)) {
                if (effect.value === null) { newActiveStrings = []; }
                else { newActiveStrings = [effect.value]; } // Manual input replaces all others
                needsRebuild = true;
            }
            if (effect.is(clearAllRegexesEffect)) {
                newActiveStrings = [];
                needsRebuild = true;
            }
        }

        let newState = { ...value, activeRegexStrings: newActiveStrings };

        if (needsRebuild) {
            newState.combinedRegex = buildCombinedRegex(newActiveStrings);
            newState.enabled = newActiveStrings.length > 0 && newState.combinedRegex !== null;
        }

        // Handle other effects after regex state is potentially updated
        for (let effect of tr.effects) {
            if (effect.is(setHideEmptyLinesEffect)) {
                newState.hideEmptyLines = effect.value;
            }
            if (effect.is(setIncludeChildItemsEffect)) {
                newState.includeChildItems = effect.value;
            }
        }
        return newState;
    },
});


// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings;
    lastRegexStr: string | null = null; // For pre-filling manual input modal
    cssStyleEl: HTMLElement | null = null;

    async onload() {
        console.log('Loading Regex Line Filter plugin');
        await this.loadSettings(); // Ensures settings are loaded before .init() uses them

        this.addCommand({
            id: 'toggle-regex-line-filter',
            name: 'Toggle Regex Line Filter (Manual/Clear All)',
            editorCallback: (editor: Editor, view: MarkdownView) => this.toggleGlobalFilter(editor, view),
        });

        this.registerAllToggleSavedRegexCommands();

        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));

        this.registerEditorExtension([
            filterStateField.init((editorState: EditorState) => ({ // Use .init for initial state per-editor
                activeRegexStrings: [], // Start with no active regexes
                combinedRegex: null,
                enabled: false,
                hideEmptyLines: this.settings.hideEmptyLines,
                includeChildItems: this.settings.includeChildItems,
            })),
            filterViewPlugin
        ]);

        this.addCssVariables();
        this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange));
        this.app.workspace.onLayoutReady(() => {
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
            if (cm && cm.state && typeof cm.state.field === 'function') {
                const fieldState = cm.state.field(filterStateField, false); // Don't error if not found
                if (fieldState) {
                    filterIsEnabledOnActiveLeaf = fieldState.enabled;
                }
            }
        }
        if (filterIsEnabledOnActiveLeaf) document.body.classList.add(ACTIVE_FILTER_BODY_CLASS);
        else document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
    }

    private updateBodyClassForActiveLeaf(): void {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        this.handleActiveLeafChange(activeView ? activeView.leaf : null);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.settings.regexHistory = (this.settings.regexHistory || []).slice(0, REGEX_HISTORY_LIMIT);
        this.settings.savedRegexes = this.settings.savedRegexes || [];
        if (typeof this.settings.includeChildItems !== 'boolean') {
            this.settings.includeChildItems = DEFAULT_SETTINGS.includeChildItems;
        }
        if (typeof this.settings.hideEmptyLines !== 'boolean') {
            this.settings.hideEmptyLines = DEFAULT_SETTINGS.hideEmptyLines;
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    updateRegexHistory(newRegexString: string) {
        const filteredHistory = (this.settings.regexHistory || []).filter(r => r !== newRegexString);
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
            } catch (e) { console.warn("Regex Line Filter: Error dispatching hideEmptyLines", e); }
        });
    }

    dispatchIncludeChildItemsToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 if (cm.state.field(filterStateField, false) !== undefined) {
                    cm.dispatch({ effects: setIncludeChildItemsEffect.of(newValue) });
                 }
            } catch (e) { console.warn("Regex Line Filter: Error dispatching includeChildItems", e); }
        });
    }

    addCssVariables() {
        const cssId = 'regex-filter-dynamic-styles'; if (document.getElementById(cssId)) return;
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

    toggleGlobalFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) {
            new Notice("Filter not available in this view.");
            return;
        }
        const currentFilterState = cm.state.field(filterStateField);

        if (currentFilterState.enabled) { // If ANY filter is active (saved or manual)
            cm.dispatch({ effects: clearAllRegexesEffect.of() }); // Clear ALL active regexes
            this.updateBodyClassForActiveLeaf();
            new Notice('All regex filters disabled.');
        } else { // If NO filters are active
            this.promptForManualRegex(cm); // Prompt for a new, single manual filter
        }
    }

    promptForManualRegex(cm: EditorView) {
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";
        new RegexInputModal(
            this.app,
            prefillValue,
            this.settings.regexHistory,
            (result: string | null): void => {
                if (result && result.trim() !== "") { // Ensure result is not null or just whitespace
                    try {
                        new RegExp(result, 'u'); // Validate syntax before applying
                        this.lastRegexStr = result;
                        this.updateRegexHistory(result);
                        // applyManualRegexStringEffect will set this as the ONLY active filter
                        cm.dispatch({ effects: [applyManualRegexStringEffect.of(result)] });
                        this.updateBodyClassForActiveLeaf();
                        new Notice(`Regex filter enabled: /${result}/u`);
                    } catch (e) {
                        new Notice(`Invalid regex: ${(e as Error).message}`);
                        // If manual input is invalid, ensure all filters are cleared
                        cm.dispatch({ effects: applyManualRegexStringEffect.of(null) });
                        this.updateBodyClassForActiveLeaf();
                    }
                } else if (result === "" || result === null) { // User submitted empty or cancelled
                    // If user explicitly submitted empty string from modal, or cancelled,
                    // and the intent of this prompt is to set a new *single* filter or clear,
                    // then clearing is appropriate.
                    // If filters were already active, toggleGlobalFilter would have cleared them.
                    // If no filters were active, and user cancels/empties, state remains no filters.
                    if (result === "") { // Explicit empty submission
                         cm.dispatch({ effects: applyManualRegexStringEffect.of(null) });
                         this.updateBodyClassForActiveLeaf();
                         new Notice('Regex filter cleared by empty input.');
                    } else { // Cancelled (result is null)
                        new Notice('Regex filter input cancelled.');
                    }
                    // No change to body class or filter state if cancelled unless explicitly cleared
                }
            }
        ).open();
    }

    toggleSpecificSavedRegex(regexString: string, editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) { new Notice("Filter not available in this view."); return; }

        const currentActiveStrings = cm.state.field(filterStateField).activeRegexStrings;
        const isCurrentlyActive = currentActiveStrings.includes(regexString);

        cm.dispatch({ effects: toggleSpecificRegexStringEffect.of(regexString) });
        this.updateBodyClassForActiveLeaf();

        if (isCurrentlyActive) {
            new Notice(`Filter deactivated: /${this.truncateRegex(regexString)}/`);
        } else {
            new Notice(`Filter activated: /${this.truncateRegex(regexString)}/`);
        }
        // Check if any filters are active after toggle to update body class
        const finalState = cm.state.field(filterStateField);
        if (finalState.enabled) {
            document.body.classList.add(ACTIVE_FILTER_BODY_CLASS);
        } else {
            document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
        }
    }

    truncateRegex(regex: string, maxLength = 30): string {
        if (regex.length <= maxLength) return regex;
        return regex.substring(0, maxLength) + "...";
    }

    registerAllToggleSavedRegexCommands() {
        (this.settings.savedRegexes || []).forEach(item => this.registerToggleCommandForSavedRegex(item));
    }

    registerToggleCommandForSavedRegex(item: SavedRegexItem) {
        const commandId = `toggle-saved-regex-${item.id}`;
        // @ts-ignore
        if (this.app.commands.commands[`${this.manifest.id}:${commandId}`]) return; // Avoid re-registering
        this.addCommand({
            id: commandId,
            name: `Toggle Filter: /${this.truncateRegex(item.regex)}/`,
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.toggleSpecificSavedRegex(item.regex, editor, view);
            }
        });
    }

    unregisterCommandForSavedRegex(itemSpecificIdPart: string) {
        const commandIdSuffix = `toggle-saved-regex-${itemSpecificIdPart}`;
        const fullCommandId = `${this.manifest.id}:${commandIdSuffix}`;
        // @ts-ignore
        if (this.app.commands.commands[fullCommandId]) delete this.app.commands.commands[fullCommandId];
        // @ts-ignore
        if (this.app.commands.editorCommands[fullCommandId]) delete this.app.commands.editorCommands[fullCommandId];
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
    new Setting(containerEl)
      .setName('Include child items')
      .setDesc('Automatically include indented child items when their parent line matches the filter.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.includeChildItems)
        .onChange(async (value) => {
          this.plugin.settings.includeChildItems = value;
          await this.plugin.saveSettings();
          this.plugin.dispatchIncludeChildItemsToEditors(value);
        }));
    containerEl.createEl('hr');
    containerEl.createEl('h3', { text: 'Saved Regex Filters' });
    containerEl.createEl('p', { text: 'Manage your saved regex filters. These can be assigned to hotkeys (search for "Regex Line Filter: Toggle Filter").' });
    new Setting(containerEl)
        .addButton(button => {
            button.setButtonText('Add New Saved Regex').setCta()
                .onClick(() => new AddSavedRegexModal(this.app, this.plugin, this, null, -1).open());
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
            button.setIcon('play').setTooltip('Toggle this regex filter')
                .onClick(() => {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (activeView) this.plugin.toggleSpecificSavedRegex(savedRegexItem.regex, activeView.editor, activeView);
                    else new Notice('No active Markdown editor to toggle the regex on.');
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
        // Also remove it from active filters if it's currently active in any editor
        this.app.workspace.iterateCodeMirrors(cm => {
            const state = cm.state.field(filterStateField, false);
            if (state && state.activeRegexStrings.includes(removedItem.regex)) {
                cm.dispatch({effects: toggleSpecificRegexStringEffect.of(removedItem.regex)}); // This will remove it
            }
        });

        savedRegexes.splice(index, 1);
        this.plugin.settings.savedRegexes = savedRegexes;
        await this.plugin.saveSettings();
        this.plugin.unregisterCommandForSavedRegex(removedItem.id);
        this.initExistingSavedRegexes(this.savedRegexesDiv);
        new Notice(`Removed saved regex: /${this.plugin.truncateRegex(removedItem.regex)}/`);
        this.plugin.updateBodyClassForActiveLeaf(); // Update body class in case the removed filter was the last active one
    }
  }
}

// --- Modal Class definition (RegexInputModal) ---
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
        else if (this.result.trim() === "") { // Allow empty string to signify clearing or specific handling by caller
            this.close(); this.onSubmit(this.result.trim()); // Pass trimmed empty string
        }
        else { new Notice("Please enter a valid regular expression or leave empty to clear."); if(this.textInputEl) this.textInputEl.focus(); }
    }
    onClose() { this.contentEl.empty(); }
}

// --- AddSavedRegexModal Class ---
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
        let isNew = true;

        if (this.itemIndex >= 0 && this.itemIndex < savedRegexes.length && this.existingItem) { // Editing
            isNew = false;
            const itemToUpdate = savedRegexes[this.itemIndex];
            const oldRegexString = itemToUpdate.regex;

            if (oldRegexString !== trimmedRegex) {
                // If regex string changes, unregister old command, update, register new
                this.plugin.unregisterCommandForSavedRegex(itemToUpdate.id);
                
                // If the old regex was active, remove it from active filters in all editors
                this.app.workspace.iterateCodeMirrors(cm => {
                    const state = cm.state.field(filterStateField, false);
                    if (state && state.activeRegexStrings.includes(oldRegexString)) {
                        cm.dispatch({effects: toggleSpecificRegexStringEffect.of(oldRegexString)}); // remove old
                        cm.dispatch({effects: toggleSpecificRegexStringEffect.of(trimmedRegex)}); // add new if it was active
                    }
                });

                itemToUpdate.regex = trimmedRegex;
                this.plugin.registerToggleCommandForSavedRegex(itemToUpdate); // Register with new (or same) regex text
                new Notice('Saved regex updated!');
            } else {
                new Notice('No changes made to the regex.');
                this.close(); return;
            }
        } else { // Adding new item
            const newItem: SavedRegexItem = { id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9), regex: trimmedRegex };
            savedRegexes.push(newItem);
            this.plugin.registerToggleCommandForSavedRegex(newItem);
            new Notice('New regex saved!');
        }
        
        this.plugin.settings.savedRegexes = savedRegexes;
        await this.plugin.saveSettings();
        this.settingsTab.initExistingSavedRegexes(this.settingsTab.savedRegexesDiv);
        if (!isNew) this.plugin.updateBodyClassForActiveLeaf(); // Update if an active filter might have changed
        this.close();
    }
    onClose() { this.contentEl.empty(); }
}