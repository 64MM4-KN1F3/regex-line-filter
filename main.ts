import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, TFile, Events, TAbstractFile } from 'obsidian';
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
}

interface RegexLineFilterSettings {
  hideEmptyLines: boolean;
  includeChildItems: boolean;
  includeHeadingChildItems: boolean;
  enableTemplateVariables: boolean;
  noteTitleTransparency: number;
  regexHistory: string[];
  savedRegexes: SavedRegexItem[];
  pinnedRegexes: string[];
  persistedFilters: { [filePath: string]: string[] };
  // activeFilters: string[]; // This will no longer be stored in settings
}

const DEFAULT_SETTINGS: RegexLineFilterSettings = {
  hideEmptyLines: true,
  includeChildItems: true,
  includeHeadingChildItems: false,
  enableTemplateVariables: false,
  noteTitleTransparency: 0,
  regexHistory: [],
  savedRegexes: [],
  pinnedRegexes: [],
  persistedFilters: {},
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
  includeHeadingChildItems: boolean;
}

const toggleSpecificRegexStringEffect = StateEffect.define<string>();      // Adds/removes a specific regex string
const applyManualRegexStringEffect = StateEffect.define<string | null>(); // Sets activeRegexStrings to [newString] or []
const clearAllRegexesEffect = StateEffect.define<void>();                 // Clears all active regex strings
const replaceAllRegexStringsEffect = StateEffect.define<string[]>();      // Replaces all strings, used for loading from persistence
const setHideEmptyLinesEffect = StateEffect.define<boolean>();
const setIncludeChildItemsEffect = StateEffect.define<boolean>();
const setIncludeHeadingChildItemsEffect = StateEffect.define<boolean>();




// --- StateField definition ---

const filterStateField = StateField.define<FilterState>({

create(editorState: EditorState): FilterState {
        // Initial state values will be set by .init() in plugin.onload
        return {
            unresolvedRegexStrings: [],
            hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines, // Fallback, should be overridden by .init
            includeChildItems: DEFAULT_SETTINGS.includeChildItems, // Fallback
            includeHeadingChildItems: DEFAULT_SETTINGS.includeHeadingChildItems, // Fallback
        };
    },

update(value, tr): FilterState {
        let newState = { ...value };
        for (let effect of tr.effects) {
            console.log("Regex Filter: Processing effect", effect);
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
                console.log("Regex Filter: New unresolved strings (toggle)", newState.unresolvedRegexStrings);
            } else if (effect.is(applyManualRegexStringEffect)) {
                newState.unresolvedRegexStrings = effect.value === null ? [] : [effect.value];
                console.log("Regex Filter: New unresolved strings (manual)", newState.unresolvedRegexStrings);
            } else if (effect.is(clearAllRegexesEffect)) {
                newState.unresolvedRegexStrings = [];
            } else if (effect.is(replaceAllRegexStringsEffect)) {
                newState.unresolvedRegexStrings = effect.value;
            } else if (effect.is(setHideEmptyLinesEffect)) {
                newState.hideEmptyLines = effect.value;
            } else if (effect.is(setIncludeChildItemsEffect)) {
                newState.includeChildItems = effect.value;
            } else if (effect.is(setIncludeHeadingChildItemsEffect)) {
               newState.includeHeadingChildItems = effect.value;
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
events = new Events();



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
                const { unresolvedRegexStrings, hideEmptyLines, includeChildItems, includeHeadingChildItems } = view.state.field(filterStateField);
                console.log("Regex Filter: buildDecorations called. Unresolved strings:", unresolvedRegexStrings);
                const enabled = unresolvedRegexStrings.length > 0;

                if (!enabled) {
                    console.log("Regex Filter: No filters enabled, finishing decoration build.");
                    return builder.finish();
                }

                // Resolve templates and build the combined regex
                const resolvedRegexStrings = plugin.settings.enableTemplateVariables
                    ? unresolvedRegexStrings.map(s => Templater.resolve(s))
                    : unresolvedRegexStrings;
                console.log("Regex Filter: Resolved strings:", resolvedRegexStrings);

                const combinedRegex = buildCombinedRegex(resolvedRegexStrings);
                console.log("Regex Filter: Combined Regex:", combinedRegex);

                if (!combinedRegex) {
                    console.log("Regex Filter: Combined regex is null, finishing decoration build.");
                    return builder.finish();
                }

                const doc = view.state.doc;
                const isVisible = new Array(doc.lines + 1).fill(false);
                const getIndentLevel = (text: string): number => {
                    const match = text.match(/^(\s*)/);
                    return match ? match[1].length : 0;
                };
                const getHeadingLevel = (text: string): number => {
                    const match = text.match(/^(#+)\s/);
                    return match ? match[1].length : 0;
                }

                try {
                    for (let i = 1; i <= doc.lines; i++) {
                        const line = doc.line(i);
                        if (combinedRegex.test(line.text)) {
                            isVisible[i] = true;
                            // Handle indented children
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
                            // Handle heading children
                            if (includeHeadingChildItems) {
                                const parentHeadingLevel = getHeadingLevel(line.text);
                                if (parentHeadingLevel > 0) {
                                    for (let j = i + 1; j <= doc.lines; j++) {
                                        const childLine = doc.line(j);
                                        const childHeadingLevel = getHeadingLevel(childLine.text);
                                        if (childHeadingLevel > 0 && childHeadingLevel <= parentHeadingLevel) {
                                            break;
                                        }
                                        isVisible[j] = true;
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
                            // console.log(`Regex Filter: Hiding line ${i}`); // This can be very noisy
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
        includeHeadingChildItems: this.settings.includeHeadingChildItems,
    })),
    this.createFilterViewPlugin()
]);



this.addCssVariables();
this.registerEvent(this.app.workspace.on('active-leaf-change', this.handleActiveLeafChange));
this.registerEvent(this.app.vault.on('rename', this.handleFileRename));
this.app.workspace.onLayoutReady(() => {
this.dispatchHideEmptyLinesToEditors(this.settings.hideEmptyLines);
this.dispatchIncludeChildItemsToEditors(this.settings.includeChildItems);
this.dispatchIncludeHeadingChildItemsToEditors(this.settings.includeHeadingChildItems);
this.updateBodyClassForActiveLeaf();
        });
this.updateBodyClassForActiveLeaf();

        // Register listeners that will trigger a settings tab refresh if it's open
        this.registerEvent(this.app.workspace.on('layout-change', () => this.events.trigger('filter-changed')));
        this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.events.trigger('filter-changed')));
    }




onunload() {

console.log('Unloading Regex Line Filter plugin');
this.removeCssVariables();
    }

private handleFileRename = async (file: TAbstractFile, oldPath: string): Promise<void> => {
    if (file instanceof TFile) {
        if (this.settings.persistedFilters.hasOwnProperty(oldPath)) {
            this.settings.persistedFilters[file.path] = this.settings.persistedFilters[oldPath];
            delete this.settings.persistedFilters[oldPath];
            await this.saveSettings();
        }
    }
}




private handleActiveLeafChange = (leaf: WorkspaceLeaf | null): void => {
        // Part 1: Load persisted filters for the view if it's a MarkdownView
        if (leaf && leaf.view instanceof MarkdownView) {
            const view = leaf.view;
            const file = view.file;
            if (file) {
                const persistedFilters = this.settings.persistedFilters[file.path] || [];
                const cm = (view.editor as any).cm as EditorView;
                if (cm) {
                    const currentState = cm.state.field(filterStateField, false);
                    // Only dispatch if the state is different from what's persisted
                    if (currentState && JSON.stringify(currentState.unresolvedRegexStrings) !== JSON.stringify(persistedFilters)) {
                        cm.dispatch({ effects: replaceAllRegexStringsEffect.of(persistedFilters) });
                        // The state is now updated. The rest of this function will use the new state.
                    }
                }
            }
        }

        // Part 2: Update body classes based on the (potentially new) state
        let filterIsEnabledOnActiveLeaf = false;
        let shouldFadeTitle = false;

        if (leaf && leaf.view instanceof MarkdownView) {
            const cm = (leaf.view.editor as { cm?: EditorView })?.cm;
            if (cm && cm.state && typeof cm.state.field === 'function') {
                const fieldState = cm.state.field(filterStateField, false);
                if (fieldState && fieldState.unresolvedRegexStrings.length > 0) {
                    filterIsEnabledOnActiveLeaf = true;

                    if (this.settings.noteTitleTransparency > 0) {
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
this.settings.pinnedRegexes = this.settings.pinnedRegexes || [];
this.settings.persistedFilters = this.settings.persistedFilters || {};
// this.settings.activeFilters = this.settings.activeFilters || []; // No longer needed
if (typeof this.settings.includeChildItems !== 'boolean') {

this.settings.includeChildItems = DEFAULT_SETTINGS.includeChildItems;
        }
if (typeof this.settings.includeHeadingChildItems !== 'boolean') {
this.settings.includeHeadingChildItems = DEFAULT_SETTINGS.includeHeadingChildItems;
        }

if (typeof this.settings.hideEmptyLines !== 'boolean') {

this.settings.hideEmptyLines = DEFAULT_SETTINGS.hideEmptyLines;
        }
if (typeof this.settings.enableTemplateVariables !== 'boolean') {
this.settings.enableTemplateVariables = DEFAULT_SETTINGS.enableTemplateVariables;
        }
if (typeof this.settings.noteTitleTransparency !== 'number') {
this.settings.noteTitleTransparency = DEFAULT_SETTINGS.noteTitleTransparency;
        }

    }




async saveSettings() {

await this.saveData(this.settings);
}

async saveFiltersForFile(filePath: string, regexStrings: string[]) {
    if (regexStrings.length > 0) {
        this.settings.persistedFilters[filePath] = [...regexStrings];
    } else {
        if (this.settings.persistedFilters.hasOwnProperty(filePath)) {
            delete this.settings.persistedFilters[filePath];
        }
    }
    await this.saveSettings();
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

dispatchIncludeHeadingChildItemsToEditors(newValue: boolean) {
        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView) {
                const cm = (leaf.view.editor as any).cm as EditorView;
                if (cm) {
                    try {
                        if (cm.state.field(filterStateField, false) !== undefined) {
                            cm.dispatch({ effects: setIncludeHeadingChildItemsEffect.of(newValue) });
                        }
                    } catch (e) { console.warn("Regex Line Filter: Error dispatching includeHeadingChildItems", e); }
                }
            }
        });
    }




addCssVariables() {
const cssId = 'regex-filter-dynamic-styles'; if (document.getElementById(cssId)) return;
const vignetteWidth = '160px'; const vignetteColor = 'rgba(0, 0, 0, 0.4)'; const transitionDuration = '0.3s';
const opacity = 1 - this.settings.noteTitleTransparency;
const cssVars = `:root { --regex-filter-vignette-width: ${vignetteWidth}; --regex-filter-vignette-color: ${vignetteColor}; --regex-filter-transition-duration: ${transitionDuration}; --regex-filter-title-fade-opacity: ${opacity}; }`;
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

// Save cursor position before clearing
const currentSelection = cm.state.selection;
cm.dispatch({
    effects: clearAllRegexesEffect.of(),
    selection: currentSelection // Restore selection after clearing
});

if (view.file) {
    this.saveFiltersForFile(view.file.path, []);
}

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
                
                // Save the new state
                const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
                if (file) {
                    this.saveFiltersForFile(file.path, [result]);
                }
                
                this.updateBodyClassForActiveLeaf();
                const finalRegex = this.settings.enableTemplateVariables ? Templater.resolve(result) : result;
                new Notice(`Regex filter enabled: /${this.truncateRegex(finalRegex)}/u`);

                // Pinning is now handled inside the RegexInputModal

            } catch (e) {
                new Notice(`Invalid regex: ${(e as Error).message}`);
                cm.dispatch({ effects: applyManualRegexStringEffect.of(null) });
                this.updateBodyClassForActiveLeaf();
            }
        } else if (result === "" || result === null) { // User submitted empty or cancelled
            if (result === "") { // Explicit empty submission
                const currentSelection = cm.state.selection;
                cm.dispatch({
                    effects: applyManualRegexStringEffect.of(null),
                    selection: currentSelection
                });
                
                // Save the cleared state
                const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
                if (file) {
                    this.saveFiltersForFile(file.path, []);
                }
                
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
        console.log(`Regex Filter: Dispatching toggle for "${regexString}"`);
        const currentSelection = cm.state.selection;
        cm.dispatch({
            effects: toggleSpecificRegexStringEffect.of(regexString),
            selection: currentSelection
        });
        
        // Save the new state
        const newActiveStrings = cm.state.field(filterStateField).unresolvedRegexStrings;
        if (view.file) {
            this.saveFiltersForFile(view.file.path, newActiveStrings);
        }
        
        this.updateBodyClassForActiveLeaf();
        this.events.trigger('filter-changed');

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
        (this.settings.savedRegexes || []).forEach(item => this.registerToggleCommandForSavedRegex(item));
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

    private onFilterChanged = () => {
        if (this.containerEl.isShown() && this.savedRegexesDiv) {
            this.initExistingSavedRegexes(this.savedRegexesDiv);
        }
    }

    hide() {
        this.plugin.events.off('filter-changed', this.onFilterChanged);
    }


display(): void {

const {containerEl} = this;
containerEl.empty();
containerEl.createEl('h2', { text: 'Regex Line Filter Settings' });
containerEl.createEl('h3', { text: 'General Filter Options' });
const hideEmptyLinesDesc = 'When the filter is active, also hide lines that contain only whitespace.';
const hideEmptyLinesSetting = new Setting(containerEl)
    .setName('Hide empty lines')
    .addToggle(toggle => {
        toggle
            .setValue(this.plugin.settings.hideEmptyLines)
            .onChange(async (value) => {
                this.plugin.settings.hideEmptyLines = value;
                await this.plugin.saveSettings();
                this.plugin.dispatchHideEmptyLinesToEditors(value);
            });
    });
hideEmptyLinesSetting.nameEl.setAttribute('title', hideEmptyLinesDesc);
hideEmptyLinesSetting.controlEl.setAttribute('title', hideEmptyLinesDesc);

const includeIndentsDesc = 'Automatically include indented child items (tabs, bullets, numbers) when their parent line matches the filter.';
const includeIndentsSetting = new Setting(containerEl)
    .setName('Include indents under filter match')
    .addToggle(toggle => {
        toggle
            .setValue(this.plugin.settings.includeChildItems)
            .onChange(async (value) => {
                this.plugin.settings.includeChildItems = value;
                await this.plugin.saveSettings();
                this.plugin.dispatchIncludeChildItemsToEditors(value);
            });
    });
includeIndentsSetting.nameEl.setAttribute('title', includeIndentsDesc);
includeIndentsSetting.controlEl.setAttribute('title', includeIndentsDesc);

const includeHeadingDesc = 'Automatically include all lines under a heading when the heading line matches the filter.';
const includeHeadingSetting = new Setting(containerEl)
    .setName('Include section when heading/title matches')
    .addToggle(toggle => {
        toggle
            .setValue(this.plugin.settings.includeHeadingChildItems)
            .onChange(async (value) => {
                this.plugin.settings.includeHeadingChildItems = value;
                await this.plugin.saveSettings();
                this.plugin.dispatchIncludeHeadingChildItemsToEditors(value);
            });
    });
includeHeadingSetting.nameEl.setAttribute('title', includeHeadingDesc);
includeHeadingSetting.controlEl.setAttribute('title', includeHeadingDesc);

const templateVarsDesc = 'When enabled, templates resolve to dates or date ranges. ' +
    'Simple variables like {{today}} or {{yesterday}} resolve to a single date. ' +
    'Range variables like {{last-week}}, {{this-month}}, or {{next-year}} resolve to a regex matching all dates in that range (e.g., (2023-01-01|2023-01-02|...)). ' +
    'You can also specify a custom format, e.g., {{today:DD-MM-YYYY}} or {{last-week:DD/MM/YYYY}}. ' +
    'Supported variables: today, yesterday, tomorrow, this-week, last-week, next-week, this-month, last-month, next-month, this-year, last-year, next-year.';
const templateVarsSetting = new Setting(containerEl)
    .setName('Enable template variables')
    .addToggle(toggle => {
        toggle
            .setValue(this.plugin.settings.enableTemplateVariables)
            .onChange(async (value) => {
                this.plugin.settings.enableTemplateVariables = value;
                await this.plugin.saveSettings();
            });
    });
templateVarsSetting.nameEl.setAttribute('title', templateVarsDesc);
templateVarsSetting.controlEl.setAttribute('title', templateVarsDesc);

const transparencyDesc = 'Sets the transparency amount for the note title when a filter is active and the title does not match the filter. 0 is fully opaque, 1 is fully transparent.';
const transparencySetting = new Setting(containerEl)
    .setName('Note title transparency')
    .addSlider(slider => {
        slider
            .setLimits(0, 1, 0.1)
            .setValue(this.plugin.settings.noteTitleTransparency)
            .setDynamicTooltip()
            .onChange(async (value) => {
                this.plugin.settings.noteTitleTransparency = value;
                await this.plugin.saveSettings();
                // Update the CSS variable in real-time
                const opacity = 1 - value;
                document.documentElement.style.setProperty('--regex-filter-title-fade-opacity', opacity.toString());
                this.plugin.updateBodyClassForActiveLeaf();
            });
    });
transparencySetting.nameEl.setAttribute('title', transparencyDesc);
transparencySetting.controlEl.setAttribute('title', transparencyDesc);

containerEl.createEl('hr');
containerEl.createEl('h3', { text: 'Saved Regex Filters' });
const descEl = containerEl.createEl('p');
descEl.innerHTML = `
    Manage your saved regex filters. These can be assigned to hotkeys (search for "Regex Line Filter: Toggle Filter").<br>
`;
new Setting(containerEl)

        .addButton(button => {

button.setButtonText('Add New Saved Regex').setCta()

                .onClick(() => new AddSavedRegexModal(this.app, this.plugin, this, null, -1).open());
        });
this.savedRegexesDiv = containerEl.createDiv('saved-regex-list');
this.initExistingSavedRegexes(this.savedRegexesDiv);

        // Listen for the custom event from the plugin
        this.plugin.events.on('filter-changed', this.onFilterChanged);
  }




initExistingSavedRegexes(container: HTMLDivElement): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    let activeFilters: string[] = [];
    if (activeView) {
        const cm = (activeView.editor as any).cm as EditorView;
        if (cm && cm.state.field(filterStateField, false)) {
            const state = cm.state.field(filterStateField);
            activeFilters = state.unresolvedRegexStrings;
        }
    }

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
    const isCurrentlyActive = activeFilters.includes(savedRegexItem.regex);
    button
        .setIcon(isCurrentlyActive ? 'pause' : 'play')
        .setTooltip(isCurrentlyActive ? 'Deactivate this filter' : 'Activate this filter');

    if (isCurrentlyActive) {
        button.extraSettingsEl.addClass('is-active');
    }

    button.onClick(() => {
        const currentActiveView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (currentActiveView) {
            this.plugin.toggleSpecificSavedRegex(savedRegexItem.regex, currentActiveView.editor, currentActiveView);
            // The 'filter-changed' event will handle the refresh
        } else {
            new Notice('No active Markdown editor to toggle the filter on.');
        }
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
                        const currentSelection = cm.state.selection;
                                                cm.dispatch({
                                                    effects: toggleSpecificRegexStringEffect.of(removedItem.regex),
                                                    selection: currentSelection
                                                }); // This will remove it
                                                
                                                // After dispatch, the state is updated. Get the new state and save it.
                                                const newFilters = cm.state.field(filterStateField).unresolvedRegexStrings;
                                                if (leaf.view.file) {
                                                    this.plugin.saveFiltersForFile(leaf.view.file.path, newFilters);
                                                }
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
this.plugin.events.trigger('filter-changed');

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
const pinnedItems = this.plugin.settings.pinnedRegexes || [];
const historyItems = (this.history || []).filter(histEntry => !pinnedItems.includes(histEntry));

// Pinned Items Section
if (pinnedItems.length > 0) {
    const pinnedEl = contentEl.createDiv({ cls: 'regex-filter-pinned-container' });
    pinnedEl.createSpan({ text: 'Pinned:', cls: 'regex-filter-section-label' });
    pinnedItems.forEach(pinnedRegex => {
        this.createHistoryItem(pinnedEl, pinnedRegex, true);
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
        this.result = regexString;
        this.close();
        this.onSubmit(this.result, isPinned);
    });

    const controlsContainer = itemContainer.createDiv({ cls: 'regex-item-controls' });

    if (isPinned) {
        // UNPIN icon
        const unpinIcon = controlsContainer.createEl('span', { cls: 'clickable-icon' });
        unpinIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-pin-off"><line x1="12" x2="12" y1="17" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-3-3a3 3 0 0 0-3 3v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path><line x1="2" x2="22" y1="2" y2="22"></line></svg>`;
        unpinIcon.setAttribute('aria-label', 'Unpin - item may be purged if not used recently');
        unpinIcon.addEventListener('click', async () => {
            const index = this.plugin.settings.pinnedRegexes.indexOf(regexString);
            if (index > -1) {
                this.plugin.settings.pinnedRegexes.splice(index, 1);
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
            // Create a temporary SavedRegexItem to pass to the Add modal
            const itemToSave: SavedRegexItem = {
                id: '', // ID will be generated on actual save
                regex: regexString,
                name: ''
            };
            this.close();
            // The Add modal will handle adding it to the *real* saved list
            // and removing it from the pinned list.
            new AddSavedRegexModal(this.app, this.plugin, new RegexLineFilterSettingTab(this.app, this.plugin), itemToSave, -1).open();
        });

    } else {
        // PIN icon for history items
        const pinIcon = controlsContainer.createEl('span', { cls: 'clickable-icon history-pin-icon' });
        pinIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-pin"><path d="M12 17v5"></path><path d="M9 10.75A2.75 2.75 0 0 1 12 8a2.75 2.75 0 0 1 3 2.75V17h-6Z"></path><path d="M12 8V2"></path></svg>`;
        pinIcon.setAttribute('aria-label', 'Pin item');
        pinIcon.addEventListener('click', async () => {
            if (!this.plugin.settings.pinnedRegexes.includes(regexString)) {
                this.plugin.settings.pinnedRegexes.push(regexString);
                await this.plugin.saveSettings();
                new Notice(`Pinned: /${this.plugin.truncateRegex(regexString)}/`);
                this.onOpen(); // Refresh the modal content
            }
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
                                const currentSelection = cm.state.selection;
                                cm.dispatch({
                                    effects: [
                                        toggleSpecificRegexStringEffect.of(oldRegexString),
                                        toggleSpecificRegexStringEffect.of(trimmedRegex)
                                    ],
                                    selection: currentSelection
                                });
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
        };
        savedRegexes.push(newItem);
        this.plugin.registerToggleCommandForSavedRegex(newItem);
        new Notice('New filter saved!');
    }

    if (changesMade) {
        // Upon saving, remove the item from the temporary pinned list.
        const pinnedIndex = this.plugin.settings.pinnedRegexes.indexOf(trimmedRegex);
        if (pinnedIndex > -1) {
            this.plugin.settings.pinnedRegexes.splice(pinnedIndex, 1);
        }

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