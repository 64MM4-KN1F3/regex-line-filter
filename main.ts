import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile } from 'obsidian';
import { StateField, StateEffect, RangeSetBuilder, EditorState } from '@codemirror/state';
import { Templater } from './Templater';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body';
const FADE_TITLE_BODY_CLASS = 'regex-filter-fade-title';

// --- Settings ---
export interface SavedRegexItem {
  id: string;
  name?: string; // Optional name for the regex
  regex: string;
  pinned?: boolean; // New property for pinning
}

interface RegexLineFilterSettings {
  hideEmptyLines: boolean;
  includeChildItems: boolean;
  enableTemplateVariables: boolean;
  fadeNoteTitleOpacity: number;
  regexHistory: string[];
  savedRegexes: SavedRegexItem[];
  // activeFilters: string[]; // This will no longer be stored in settings
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
  hideEmptyLines: true,
  includeChildItems: true,
  enableTemplateVariables: false,
  fadeNoteTitleOpacity: 1.0,
  regexHistory: [],
  savedRegexes: [],
  // activeFilters: [], // This is now managed per-editor instance
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
  unresolvedRegexStrings: string[]; // Stores the original, UNRESOLVED strings
  hideEmptyLines: boolean;
  includeChildItems: boolean;
}

const toggleSpecificRegexStringEffect = StateEffect.define<string>();      // Adds/removes a specific regex string
const applyManualRegexStringEffect = StateEffect.define<string | null>(); // Sets activeRegexStrings to [newString] or []
const clearAllRegexesEffect = StateEffect.define<void>();                 // Clears all active regex strings
const setHideEmptyLinesEffect = StateEffect.define<boolean>();
const setIncludeChildItemsEffect = StateEffect.define<boolean>();




// --- StateField definition ---

const filterStateField = StateField.define<FilterState>({

create(editorState: EditorState): FilterState {
        // Initial state values will be set by .init() in plugin.onload
        return {
            unresolvedRegexStrings: [],
            hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines, // Fallback, should be overridden by .init
            includeChildItems: DEFAULT_SETTINGS.includeChildItems, // Fallback
        };
    },

update(value, tr): FilterState {
        let newState = { ...value };
        for (let effect of tr.effects) {
            if (effect.is(toggleSpecificRegexStringEffect)) {
                const str = effect.value;
                const index = newState.unresolvedRegexStrings.indexOf(str);
                let newStrings = [...newState.unresolvedRegexStrings];
                if (index > -1) {
                    newStrings.splice(index, 1);
                } else {
                    newStrings.push(str);
                }
                newState.unresolvedRegexStrings = newStrings;
            } else if (effect.is(applyManualRegexStringEffect)) {
                newState.unresolvedRegexStrings = effect.value === null ? [] : [effect.value];
            } else if (effect.is(clearAllRegexesEffect)) {
                newState.unresolvedRegexStrings = [];
            } else if (effect.is(setHideEmptyLinesEffect)) {
                newState.hideEmptyLines = effect.value;
            } else if (effect.is(setIncludeChildItemsEffect)) {
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



private createFilterViewPlugin() {
    const plugin = this;
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = this.buildDecorations(view);
            }

            update(update: ViewUpdate) {
                const stateChanged = update.state.field(filterStateField) !== update.startState.field(filterStateField);
                if (update.docChanged || update.viewportChanged || stateChanged) {
                    // If the state changed, we might need to re-resolve dynamic templates
                    if (stateChanged && plugin.settings.enableTemplateVariables) {
                        // This logic is now simplified. Resolution happens on activation.
                        // This update just rebuilds decorations.
                    }
                    this.decorations = this.buildDecorations(update.view);
                }
            }

            buildDecorations(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                const { unresolvedRegexStrings, hideEmptyLines, includeChildItems } = view.state.field(filterStateField);
                const enabled = unresolvedRegexStrings.length > 0;

                if (!enabled) {
                    return builder.finish();
                }

                // Resolve templates and build the combined regex
                const resolvedRegexStrings = plugin.settings.enableTemplateVariables
                    ? unresolvedRegexStrings.map(s => Templater.resolve(s))
                    : unresolvedRegexStrings;

                const combinedRegex = buildCombinedRegex(resolvedRegexStrings);

                if (!combinedRegex) {
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
                                    if (childIndent > parentIndent) {
                                        isVisible[j] = true;
                                    } else {
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    for (let i = 1; i <= doc.lines; i++) {
                        const line = doc.line(i);
                        const isEmpty = line.text.trim().length === 0;
                        let shouldHide = !isVisible[i];

                        if (isEmpty && !hideEmptyLines) {
                            shouldHide = false;
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
}

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
    filterStateField.init((editorState: EditorState) => ({
        unresolvedRegexStrings: [],
        hideEmptyLines: this.settings.hideEmptyLines,
        includeChildItems: this.settings.includeChildItems,
    })),
    this.createFilterViewPlugin()
]);



this.addCssVariables();
this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange));
this.app.workspace.onLayoutReady(() => {
this.dispatchHideEmptyLinesToEditors(this.settings.hideEmptyLines);
this.dispatchIncludeChildItemsToEditors(this.settings.includeChildItems);
this.updateBodyClassForActiveLeaf();
        });
this.updateBodyClassForActiveLeaf();
    }




onunload() {

console.log('Unloading Regex Line Filter plugin');
this.removeCssVariables();
    }




private handleActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
        let filterIsEnabledOnActiveLeaf = false;
        let shouldFadeTitle = false;

        if (leaf && leaf.view instanceof MarkdownView) {
            const cm = (leaf.view.editor as { cm?: EditorView })?.cm;
            if (cm && cm.state && typeof cm.state.field === 'function') {
                const fieldState = cm.state.field(filterStateField, false);
                if (fieldState && fieldState.unresolvedRegexStrings.length > 0) {
                    filterIsEnabledOnActiveLeaf = true;

                    if (this.settings.fadeNoteTitleOpacity < 1.0) {
                        const activeFile = this.app.workspace.getActiveFile();
                        if (activeFile) {
                            const title = activeFile.basename;
                            const resolvedRegexStrings = this.settings.enableTemplateVariables
                                ? fieldState.unresolvedRegexStrings.map(s => Templater.resolve(s))
                                : fieldState.unresolvedRegexStrings;
                            
                            const combinedRegex = buildCombinedRegex(resolvedRegexStrings);
                            if (combinedRegex && !combinedRegex.test(title)) {
                                shouldFadeTitle = true;
                            }
                        }
                    }
                }
            }
        }

        // Handle main body class for vignette
        if (filterIsEnabledOnActiveLeaf) {
            document.body.classList.add(ACTIVE_FILTER_BODY_CLASS);
        } else {
            document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
        }

        // Handle title fade class
        if (shouldFadeTitle) {
            document.body.classList.add(FADE_TITLE_BODY_CLASS);
        } else {
            document.body.classList.remove(FADE_TITLE_BODY_CLASS);
        }
    }




public updateBodyClassForActiveLeaf(): void {

const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
this.handleActiveLeafChange(activeView ? activeView.leaf : null);
    }




async loadSettings() {

this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
this.settings.regexHistory = (this.settings.regexHistory || []).slice(0, REGEX_HISTORY_LIMIT);
this.settings.savedRegexes = this.settings.savedRegexes || [];
// this.settings.activeFilters = this.settings.activeFilters || []; // No longer needed
if (typeof this.settings.includeChildItems !== 'boolean') {

this.settings.includeChildItems = DEFAULT_SETTINGS.includeChildItems;
        }

if (typeof this.settings.hideEmptyLines !== 'boolean') {

this.settings.hideEmptyLines = DEFAULT_SETTINGS.hideEmptyLines;
        }
if (typeof this.settings.enableTemplateVariables !== 'boolean') {
this.settings.enableTemplateVariables = DEFAULT_SETTINGS.enableTemplateVariables;
        }
if (typeof this.settings.fadeNoteTitleOpacity !== 'number') {
this.settings.fadeNoteTitleOpacity = DEFAULT_SETTINGS.fadeNoteTitleOpacity;
        }

    }




async saveSettings() {

await this.saveData(this.settings);
}

// This function is no longer needed as the state is not saved globally.
// setAndSaveActiveFilters(activeFilters: string[]) {
//   this.settings.activeFilters = activeFilters;
//   this.saveSettings();
// }




updateRegexHistory(newRegexString: string) {
const filteredHistory = (this.settings.regexHistory || []).filter(r => r !== newRegexString);
const updatedHistory = [newRegexString, ...filteredHistory];
this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT);
this.saveSettings();
    }




dispatchHideEmptyLinesToEditors(newValue: boolean) {
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as any).cm as EditorView;
                if (cm) {
                    try {
                        if (cm.state.field(filterStateField, false) !== undefined) {
                            cm.dispatch({ effects: setHideEmptyLinesEffect.of(newValue) });
                        }
                    } catch (e) { console.warn("Regex Line Filter: Error dispatching hideEmptyLines", e); }
                }
            }
        });
    }





dispatchIncludeChildItemsToEditors(newValue: boolean) {
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as any).cm as EditorView;
                if (cm) {
                    try {
                        if (cm.state.field(filterStateField, false) !== undefined) {
                            cm.dispatch({ effects: setIncludeChildItemsEffect.of(newValue) });
                        }
                    } catch (e) { console.warn("Regex Line Filter: Error dispatching includeChildItems", e); }
                }
            }
        });
    }




addCssVariables() {
const cssId = 'regex-filter-dynamic-styles'; if (document.getElementById(cssId)) return;
const vignetteWidth = '160px'; const vignetteColor = 'rgba(0, 0, 0, 0.4)'; const transitionDuration = '0.3s';
const cssVars = `:root { --regex-filter-vignette-width: ${vignetteWidth}; --regex-filter-vignette-color: ${vignetteColor}; --regex-filter-transition-duration: ${transitionDuration}; --regex-filter-title-fade-opacity: ${this.settings.fadeNoteTitleOpacity}; }`;
this.cssStyleEl = document.createElement('style'); this.cssStyleEl.id = cssId; this.cssStyleEl.textContent = cssVars;
document.head.appendChild(this.cssStyleEl);
    }

removeCssVariables() {
if (this.cssStyleEl) { this.cssStyleEl.remove(); this.cssStyleEl = null; }

const existingStyle = document.getElementById('regex-filter-dynamic-styles');
if (existingStyle) { existingStyle.remove(); }

document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
document.body.classList.remove(FADE_TITLE_BODY_CLASS);
    }




toggleGlobalFilter(editor: Editor, view: MarkdownView) {

const cm = (editor as { cm?: EditorView }).cm;
if (!cm || !(cm instanceof EditorView)) {

new Notice("Filter not available in this view.");
return;
        }

const currentFilterState = cm.state.field(filterStateField);

if (currentFilterState.unresolvedRegexStrings.length > 0) { // If ANY filter is active (saved or manual)

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
    this,
    prefillValue,
    this.settings.regexHistory,
    (result: string | null, isPinned: boolean): void => {
        if (result && result.trim() !== "") { // Ensure result is not null or just whitespace
            try {
                // Validate syntax AFTER resolving templates, if enabled
                const stringToValidate = this.settings.enableTemplateVariables ? Templater.resolve(result) : result;
                new RegExp(stringToValidate, 'u');

                // If validation passes, dispatch the original, unresolved string to the state
                this.lastRegexStr = result;
                this.updateRegexHistory(result);
                cm.dispatch({ effects: [applyManualRegexStringEffect.of(result)] });
                this.updateBodyClassForActiveLeaf();
                const finalRegex = this.settings.enableTemplateVariables ? Templater.resolve(result) : result;
                new Notice(`Regex filter enabled: /${this.truncateRegex(finalRegex)}/u`);

                // --- PINNING LOGIC ---
                const savedRegexes = this.settings.savedRegexes || [];
                const existingSaved = savedRegexes.find(r => r.regex === result);

                if (isPinned) {
                    if (existingSaved) {
                        if (!existingSaved.pinned) {
                            existingSaved.pinned = true;
                            this.registerToggleCommandForSavedRegex(existingSaved);
                            new Notice(`Pinned: ${existingSaved.name || `/${this.truncateRegex(existingSaved.regex)}/`}`);
                        }
                    } else {
                        const newItem: SavedRegexItem = {
                            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
                            regex: result,
                            pinned: true,
                            name: ''
                        };
                        this.settings.savedRegexes.push(newItem);
                        this.registerToggleCommandForSavedRegex(newItem);
                        new Notice(`Saved and pinned: /${this.truncateRegex(result)}/`);
                    }
                    this.saveSettings();
                } else { // isPinned is false
                    if (existingSaved && existingSaved.pinned) {
                        existingSaved.pinned = false;
                        this.unregisterCommandForSavedRegex(existingSaved.id);
                        new Notice(`Unpinned: ${existingSaved.name || `/${this.truncateRegex(existingSaved.regex)}/`}`);
                        this.saveSettings();
                    }
                }
                // --- END PINNING LOGIC ---

            } catch (e) {
                new Notice(`Invalid regex: ${(e as Error).message}`);
                cm.dispatch({ effects: applyManualRegexStringEffect.of(null) });
                this.updateBodyClassForActiveLeaf();
            }
        } else if (result === "" || result === null) { // User submitted empty or cancelled
            if (result === "") { // Explicit empty submission
                cm.dispatch({ effects: applyManualRegexStringEffect.of(null) });
                this.updateBodyClassForActiveLeaf();
                new Notice('Regex filter cleared by empty input.');
            } else { // Cancelled (result is null)
                new Notice('Regex filter input cancelled.');
            }
        }
    }
).open();
    }




toggleSpecificSavedRegex(regexString: string, editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm;
        if (!cm || !(cm instanceof EditorView)) { new Notice("Filter not available in this view."); return; }

        // Validate before dispatching if templates are on
        if (this.settings.enableTemplateVariables) {
            try {
                new RegExp(Templater.resolve(regexString), 'u');
            } catch (e) {
                new Notice(`Invalid regex in saved filter: ${(e as Error).message}`);
                return;
            }
        }

        const currentActiveStrings = cm.state.field(filterStateField).unresolvedRegexStrings;
        const isCurrentlyActive = currentActiveStrings.includes(regexString);

        // Dispatch the raw, unresolved string. Resolution will happen in the view.
        cm.dispatch({ effects: toggleSpecificRegexStringEffect.of(regexString) });
        this.updateBodyClassForActiveLeaf();

        if (isCurrentlyActive) {
            new Notice(`Filter deactivated: /${this.truncateRegex(regexString)}/`);
        } else {
            const finalRegex = this.settings.enableTemplateVariables ? Templater.resolve(regexString) : regexString;
            new Notice(`Filter activated: /${this.truncateRegex(finalRegex)}/`);
        }
    }


truncateRegex(regex: string, maxLength = 30): string {

if (regex.length <= maxLength) return regex;
return regex.substring(0, maxLength) + "...";
    }




registerAllToggleSavedRegexCommands() {
        (this.settings.savedRegexes || []).filter(item => item.pinned).forEach(item => this.registerToggleCommandForSavedRegex(item));
    }




registerToggleCommandForSavedRegex(item: SavedRegexItem) {
    const commandId = `toggle-saved-regex-${item.id}`;
    const fullCommandId = `${this.manifest.id}:${commandId}`;

    // If command exists, remove it before re-adding to ensure the name is updated.
    // @ts-ignore
    if (this.app.commands.commands[fullCommandId]) {
        this.unregisterCommandForSavedRegex(item.id);
    }

    const commandName = (item.name && item.name.trim() !== "")
        ? `Toggle Filter: ${item.name}`
        : `Toggle Filter: /${this.truncateRegex(item.regex)}/`;

    this.addCommand({
        id: commandId,
        name: commandName,
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

new Setting(containerEl)
    .setName('Enable {{date}} template variables')
    .setDesc('When enabled, any instance of {{date}} or {{date:format}} in a filter will be replaced with the current date at the moment the filter is activated. This feature is disabled by default for performance.')
    .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableTemplateVariables)
        .onChange(async (value) => {
            this.plugin.settings.enableTemplateVariables = value;
            await this.plugin.saveSettings();
        }));

new Setting(containerEl)
    .setName('Fade note title opacity')
    .setDesc('When a filter is active, fade the note title if it doesn\'t match. Set to 1.0 to disable.')
    .addSlider(slider => slider
        .setLimits(0, 1, 0.1)
        .setValue(this.plugin.settings.fadeNoteTitleOpacity)
        .setDynamicTooltip()
        .onChange(async (value) => {
            this.plugin.settings.fadeNoteTitleOpacity = value;
            await this.plugin.saveSettings();
            // Update the CSS variable in real-time
            document.documentElement.style.setProperty('--regex-filter-title-fade-opacity', value.toString());
            this.plugin.updateBodyClassForActiveLeaf();
        }));

containerEl.createEl('hr');
containerEl.createEl('h3', { text: 'Saved Regex Filters' });
const descEl = containerEl.createEl('p');
descEl.innerHTML = `
    Manage your saved regex filters. These can be assigned to hotkeys (search for "Regex Line Filter: Toggle Filter").<br>
    If template variables are enabled, you can use <code>{{date:YYYY-MM-DD}}</code> (the current date with optional formatting).
`;
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
const textDiv = itemDiv.createDiv({ cls: 'saved-regex-text-container' });

// Display name if it exists, otherwise show the regex
const displayName = (savedRegexItem.name && savedRegexItem.name.trim() !== "")
    ? savedRegexItem.name
    : `/${savedRegexItem.regex}/`;
const subText = (savedRegexItem.name && savedRegexItem.name.trim() !== "")
    ? `/${savedRegexItem.regex}/`
    : "";

textDiv.createEl('div', { text: displayName, cls: 'saved-regex-name' });
if (subText) {
    textDiv.createEl('div', { text: subText, cls: 'saved-regex-subtext' });
}
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

        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as any).cm as EditorView;
                if (cm) {
                    const state = cm.state.field(filterStateField, false);
                    if (state && state.unresolvedRegexStrings.includes(removedItem.regex)) {
                        cm.dispatch({ effects: toggleSpecificRegexStringEffect.of(removedItem.regex) }); // This will remove it
                    }
                }
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
onSubmit: (result: string | null, isPinned: boolean) => void;
initialValue: string;
history: string[];
inputComponent: Setting;
textInputEl: HTMLInputElement | null = null;
plugin: RegexLineFilterPlugin;



constructor(app: App, plugin: RegexLineFilterPlugin, initialValue: string, history: string[], onSubmit: (result: string | null, isPinned: boolean) => void) {

super(app);
this.plugin = plugin;
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
    text.setValue(this.initialValue).setPlaceholder('e.g., ^\\s*- \\[ \\].*💡').onChange((value) => {
        this.result = value;
        // When user types, check if the new regex matches a saved one and update pin status
        const existing = this.plugin.settings.savedRegexes.find(r => r.regex === value);
    });
    text.inputEl.focus(); text.inputEl.select();
    text.inputEl.addEventListener('keydown', (e) => { if (e.key==='Enter'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey&&!e.altKey) {e.preventDefault();this.submit();}});
})
this.inputComponent.controlEl.addClass('regex-filter-input-control');
// --- Pinned & History Display ---
const pinnedItems = this.plugin.settings.savedRegexes.filter(item => item.pinned);
const historyItems = (this.history || []).filter(histEntry => !pinnedItems.some(p => p.regex === histEntry));

// Pinned Items Section
if (pinnedItems.length > 0) {
    const pinnedEl = contentEl.createDiv({ cls: 'regex-filter-pinned-container' });
    pinnedEl.createSpan({ text: 'Pinned:', cls: 'regex-filter-section-label' });
    pinnedItems.forEach(pinnedItem => {
        this.createHistoryItem(pinnedEl, pinnedItem.regex, true);
    });
}

// History Items Section
if (historyItems.length > 0) {
    const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' });
    historyEl.createSpan({ text: 'History:', cls: 'regex-filter-section-label' });
    historyItems.forEach(histEntry => {
        this.createHistoryItem(historyEl, histEntry, false);
    });
}

const footerEl = contentEl.createDiv({ cls: 'regex-modal-footer-text' });
footerEl.setText('Pin items from history to keep them here. Pinned items can be saved to the main filter list for hotkey access.');

new Setting(contentEl)

            .addButton((btn) => btn.setButtonText('Apply filter').setCta().onClick(() => { this.submit(); }))
            .addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null, false); }));
    }

submit() {
if (this.result && this.result.trim().length > 0) {
    this.close();
    this.onSubmit(this.result, false); // isPinned is no longer relevant at modal submission level
} else if (this.result.trim() === "") { // Allow empty string to signify clearing
    this.close();
    this.onSubmit(this.result.trim(), false); // Cannot pin an empty regex
}

else { new Notice("Please enter a valid regular expression or leave empty to clear."); if(this.textInputEl) this.textInputEl.focus(); }

    }

onClose() { this.contentEl.empty(); }

createHistoryItem(container: HTMLElement, regexString: string, isPinned: boolean) {
    const itemContainer = container.createDiv({ cls: 'regex-history-item-container' });
    if (isPinned) {
        itemContainer.addClass('is-pinned');
    }

    const textEl = itemContainer.createEl('span', { text: `/${regexString}/`, cls: 'regex-filter-history-item' });
    textEl.addEventListener('click', () => {
        if (this.textInputEl) {
            this.textInputEl.value = regexString;
            this.result = regexString;
            this.textInputEl.focus();
        }
    });

    const controlsContainer = itemContainer.createDiv({ cls: 'regex-item-controls' });

    if (isPinned) {
        // UNPIN icon
        const unpinIcon = controlsContainer.createEl('span', { cls: 'clickable-icon' });
        unpinIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-pin-off"><line x1="12" x2="12" y1="17" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-3-3a3 3 0 0 0-3 3v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path><line x1="2" x2="22" y1="2" y2="22"></line></svg>`;
        unpinIcon.setAttribute('aria-label', 'Unpin - item may be purged if not used recently');
        unpinIcon.addEventListener('click', async () => {
            const itemToUnpin = this.plugin.settings.savedRegexes.find(r => r.regex === regexString);
            if (itemToUnpin) {
                itemToUnpin.pinned = false;
                this.plugin.unregisterCommandForSavedRegex(itemToUnpin.id);
                await this.plugin.saveSettings();
                new Notice(`Unpinned: /${this.plugin.truncateRegex(regexString)}/`);
                this.onOpen(); // Refresh the modal content
            }
        });

        // SAVE icon
        const saveIcon = controlsContainer.createEl('span', { cls: 'clickable-icon' });
        saveIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-save"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;
        saveIcon.setAttribute('aria-label', 'Save - this item will move to the custom filter list in plugin options, hotkey may then be assigned');
        saveIcon.addEventListener('click', () => {
            const itemToSave = this.plugin.settings.savedRegexes.find(r => r.regex === regexString);
            if (itemToSave) {
                this.close();
                new AddSavedRegexModal(this.app, this.plugin, new RegexLineFilterSettingTab(this.app, this.plugin), itemToSave, this.plugin.settings.savedRegexes.indexOf(itemToSave)).open();
            }
        });

    } else {
        // PIN icon for history items
        const pinIcon = controlsContainer.createEl('span', { cls: 'clickable-icon history-pin-icon' });
        pinIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-pin"><path d="M12 17v5"></path><path d="M9 10.75A2.75 2.75 0 0 1 12 8a2.75 2.75 0 0 1 3 2.75V17h-6Z"></path><path d="M12 8V2"></path></svg>`;
        pinIcon.setAttribute('aria-label', 'Pin item');
        pinIcon.addEventListener('click', async () => {
            let existing = this.plugin.settings.savedRegexes.find(r => r.regex === regexString);
            if (existing) {
                existing.pinned = true;
            } else {
                existing = {
                    id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
                    regex: regexString,
                    pinned: true,
                    name: ''
                };
                this.plugin.settings.savedRegexes.push(existing);
            }
            this.plugin.registerToggleCommandForSavedRegex(existing);
            await this.plugin.saveSettings();
            new Notice(`Pinned: /${this.plugin.truncateRegex(regexString)}/`);
            this.onOpen(); // Refresh the modal content
        });
    }
}
}




// --- AddSavedRegexModal Class ---

class AddSavedRegexModal extends Modal {

plugin: RegexLineFilterPlugin; settingsTab: RegexLineFilterSettingTab; existingItem: SavedRegexItem | null;
itemIndex: number;
currentRegexText: string;
currentNameText: string;
nameInputEl: HTMLInputElement;
regexInputEl: HTMLInputElement;

constructor(app: App, plugin: RegexLineFilterPlugin, settingsTab: RegexLineFilterSettingTab, existingItemToEdit: SavedRegexItem | null, itemIndex: number) {
    super(app);
    this.plugin = plugin;
    this.settingsTab = settingsTab;
    this.existingItem = existingItemToEdit;
    this.itemIndex = itemIndex;
    this.currentRegexText = existingItemToEdit ? existingItemToEdit.regex : "";
    this.currentNameText = existingItemToEdit ? (existingItemToEdit.name || "") : "";
}

onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.existingItem ? 'Edit Saved Filter' : 'Add New Saved Filter' });

    // Name Input
    new Setting(contentEl)
        .setName('Filter name (optional)')
        .setDesc('A friendly name for this filter, used in the command palette.')
        .addText(text => {
            this.nameInputEl = text.inputEl;
            text.setValue(this.currentNameText)
                .setPlaceholder('e.g., My Custom To-Do Filter')
                .onChange(value => this.currentNameText = value);
            this.nameInputEl.style.width = '100%';
        });

    // Regex Input
    new Setting(contentEl)
        .setName('Regular expression')
        .setDesc("Enter the regex string. It will be compiled with the 'u' (unicode) flag.")
        .addText(text => {
            this.regexInputEl = text.inputEl;
            text.setValue(this.currentRegexText)
                .setPlaceholder('e.g., ^\\s*- \\[ \\]')
                .onChange(value => this.currentRegexText = value);
            this.regexInputEl.style.width = '100%';
            this.regexInputEl.addEventListener('keydown', (e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    this.doSubmit();
                }
            });
        });

    this.nameInputEl.focus();

    // Buttons
    new Setting(contentEl)
        .addButton(button => button.setButtonText(this.existingItem ? 'Save Changes' : 'Save Filter').setCta().onClick(() => this.doSubmit()))
        .addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
}

async doSubmit() {
    const trimmedRegex = this.currentRegexText.trim();
    const trimmedName = this.currentNameText.trim();

    if (trimmedRegex === "") {
        new Notice("Regex cannot be empty.");
        this.regexInputEl.focus();
        return;
    }

    const savedRegexes = this.plugin.settings.savedRegexes || [];
    let isNew = true;
    let changesMade = false;

    if (this.itemIndex >= 0 && this.itemIndex < savedRegexes.length && this.existingItem) { // Editing
        isNew = false;
        const itemToUpdate = savedRegexes[this.itemIndex];
        const oldRegexString = itemToUpdate.regex;
        const oldNameString = itemToUpdate.name || "";

        if (oldRegexString !== trimmedRegex || oldNameString !== trimmedName) {
            changesMade = true;
            if (oldRegexString !== trimmedRegex) {
                // If regex string changes, unregister old command, update, register new
                this.plugin.unregisterCommandForSavedRegex(itemToUpdate.id);
                // If the old regex was active, remove it from active filters in all editors
                this.app.workspace.iterateAllLeaves(leaf => {
                    if (leaf.view instanceof MarkdownView) {
                        const cm = (leaf.view.editor as any).cm as EditorView;
                        if (cm) {
                            const state = cm.state.field(filterStateField, false);
                            if (state && state.unresolvedRegexStrings.includes(oldRegexString)) {
                                cm.dispatch({ effects: toggleSpecificRegexStringEffect.of(oldRegexString) }); // remove old
                                cm.dispatch({ effects: toggleSpecificRegexStringEffect.of(trimmedRegex) }); // add new if it was active
                            }
                        }
                    }
                });
            }
            itemToUpdate.regex = trimmedRegex;
            itemToUpdate.name = trimmedName;
            this.plugin.registerToggleCommandForSavedRegex(itemToUpdate); // Re-register to update name if changed
            new Notice('Saved filter updated!');
        }
    } else { // Adding new item
        changesMade = true;
        const newItem: SavedRegexItem = {
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
            name: trimmedName,
            regex: trimmedRegex,
            pinned: false // Default pinned to false
        };
        savedRegexes.push(newItem);
        // Do not register command on creation, only when pinned.
        new Notice('New filter saved!');
    }

    if (changesMade) {
        this.plugin.settings.savedRegexes = savedRegexes;
        await this.plugin.saveSettings();
        this.settingsTab.initExistingSavedRegexes(this.settingsTab.savedRegexesDiv);
        if (!isNew) this.plugin.updateBodyClassForActiveLeaf();
    } else {
        new Notice('No changes were made.');
    }

    this.close();
}

onClose() { this.contentEl.empty(); }

}