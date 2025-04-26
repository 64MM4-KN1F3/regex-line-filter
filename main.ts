import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
// Core CM State & View
import { EditorState, StateField, StateEffect, Extension, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
// Folding Imports - Using Namespace Import
import * as Language from '@codemirror/language';

// --- Constants ---
const REGEX_HISTORY_LIMIT = 5;
const ACTIVE_FILTER_BODY_CLASS = 'regex-filter-active-body';

// --- Settings ---
interface RegexLineFilterSettings { hideEmptyLines: boolean; regexHistory: string[]; }
const DEFAULT_SETTINGS: RegexLineFilterSettings = { hideEmptyLines: true, regexHistory: [], }

// --- State & Effects (Filter Logic) ---
interface FilterState { regex: RegExp | null; enabled: boolean; hideEmptyLines: boolean; }
const setRegexEffect = StateEffect.define<RegExp | null>();
const toggleFilterEffect = StateEffect.define<boolean>();
const setHideEmptyLinesEffect = StateEffect.define<boolean>();


// --- StateField definition (Filter Logic) ---
const filterStateField = StateField.define<FilterState>({
    create(state): FilterState { return { regex: null, enabled: false, hideEmptyLines: DEFAULT_SETTINGS.hideEmptyLines }; },
    update(value, tr): FilterState {
        let newValue: FilterState = { ...value };
        for (let effect of tr.effects) {
            if (effect.is(setRegexEffect)) { if (newValue.regex?.source !== effect.value?.source || newValue.regex?.flags !== effect.value?.flags) { newValue.regex = effect.value; newValue.enabled = !!effect.value; } else if (!newValue.enabled && !!effect.value) { newValue.enabled = true; } }
            if (effect.is(toggleFilterEffect)) { if (newValue.enabled !== effect.value) { newValue.enabled = effect.value; if (effect.value && !newValue.regex) newValue.enabled = false; if (!effect.value) newValue.enabled = false; } }
            if (effect.is(setHideEmptyLinesEffect)) { if (newValue.hideEmptyLines !== effect.value) { newValue.hideEmptyLines = effect.value; } }
        }
        if (!newValue.regex && newValue.enabled) { newValue.enabled = false; } return newValue;
    },
    // *** REMOVED Incorrect 'provide' function ***
    // The dependency is implicit because regexFoldService reads this field.
});


// --- Fold Service Definition ---
const regexFoldService = Language.foldService.of((state: EditorState, from: number, to: number): { from: number, to: number }[] | null => {
    // Reads filterStateField, establishing the dependency
    const filterState = state.field(filterStateField, false);
    if (!filterState || !filterState.enabled || !filterState.regex) { return null; }
    const { regex, hideEmptyLines } = filterState; const doc = state.doc; const ranges: { from: number, to: number }[] = [];
    try {
        for (let i = 1; i <= doc.lines; i++) { const line = doc.line(i); if (line.length === 0 && i === doc.lines) continue; const lineText = line.text; const isEmpty = lineText.trim().length === 0; let shouldHide = false; let matchesRegex = regex.test(lineText); if (!matchesRegex) { shouldHide = true; } if (hideEmptyLines && isEmpty) { shouldHide = true; } if (shouldHide) { ranges.push({ from: line.from, to: line.to }); } }
    } catch (e) { console.error("Regex Line Filter: Error during fold range calculation:", e); return null; }
    return ranges.length > 0 ? ranges : null;
});


// --- Plugin Class definition ---
export default class RegexLineFilterPlugin extends Plugin {
    settings: RegexLineFilterSettings;
    lastRegexStr: string | null = null;
    cssStyleEl: HTMLElement | null = null;

    async onload() {
        console.log('Loading Regex Line Filter plugin (Folding Mode - Implicit Dependency)');
        await this.loadSettings();
        this.addCommand({ id: 'toggle-regex-line-filter', name: 'Toggle Regex Line Filter', editorCallback: (editor: Editor, view: MarkdownView) => { this.toggleFilter(editor, view); } });
        this.addSettingTab(new RegexLineFilterSettingTab(this.app, this));

        // Register the CodeMirror 6 extensions
        this.registerEditorExtension([
            filterStateField,       // Defines filter state
            Language.foldState,     // Core fold state (reads foldServices)
            regexFoldService,       // Calculates folds based on filterStateField
            Language.foldGutter({}) // Fold gutter UI
        ]);

        this.addCss();
        this.app.workspace.onLayoutReady(() => {
            this.dispatchSettingToEditors(this.settings.hideEmptyLines); // Should trigger fold update
            this.updateBodyClass();
        });
    }

    onunload() {
        console.log('Unloading Regex Line Filter plugin'); this.removeCss(); document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS);
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                const currentFilterState = cm.state.field(filterStateField, false);
                if (currentFilterState?.enabled) {
                     cm.dispatch({ effects: [ toggleFilterEffect.of(false) ]}); // Should trigger fold update
                }
            } catch (e) { console.error("Error during unload dispatch:", e); }
        });
    }

    async loadSettings() { /* ... unchanged ... */
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); if (!Array.isArray(this.settings.regexHistory)) { this.settings.regexHistory = []; } this.settings.regexHistory = this.settings.regexHistory.slice(0, REGEX_HISTORY_LIMIT);
    }
    async saveSettings() { /* ... unchanged ... */ await this.saveData(this.settings); }
    updateRegexHistory(newRegexString: string) { /* ... unchanged ... */
        const filteredHistory = this.settings.regexHistory.filter(r => r !== newRegexString); const updatedHistory = [newRegexString, ...filteredHistory]; this.settings.regexHistory = updatedHistory.slice(0, REGEX_HISTORY_LIMIT); this.saveSettings();
    }

    dispatchSettingToEditors(newValue: boolean) {
        this.app.workspace.iterateCodeMirrors(cm => {
            try {
                 const currentFilterState = cm.state.field(filterStateField, false);
                 if (currentFilterState !== undefined && currentFilterState.hideEmptyLines !== newValue) {
                     cm.dispatch({ effects: [ setHideEmptyLinesEffect.of(newValue) ] }); // Should trigger fold update
                 } else if (currentFilterState === undefined) { console.warn("Regex Line Filter: filterStateField not found on an editor."); }
            } catch (e) { console.warn("Regex Line Filter: Error dispatching setting to an editor view", e); }
        });
    }

    addCss() { /* ... unchanged ... */
        const cssId = 'regex-filter-styles'; if (document.getElementById(cssId)) return; const vignetteWidth = '160px'; const vignetteColor = 'rgba(0, 0, 0, 0.4)'; const transitionDuration = '0.3s'; const css = `/* Vignette + Optional Fold Hiding CSS */ /* body.${ACTIVE_FILTER_BODY_CLASS} .cm-editor .cm-foldGutterElement > span[aria-label="Folded lines"], body.${ACTIVE_FILTER_BODY_CLASS} .cm-editor .cm-foldGutterElement > span[aria-label="Unfold lines"] { display: none !important; } body.${ACTIVE_FILTER_BODY_CLASS} .cm-editor .cm-foldPlaceholder { background: transparent !important; color: transparent !important; border: none !important; font-size: 0 !important; } */ .workspace-leaf.mod-active .view-content { position: relative; } .workspace-leaf.mod-active .view-content::before, .workspace-leaf.mod-active .view-content::after { content: ''; position: absolute; top: 0; bottom: 0; width: ${vignetteWidth}; z-index: 5; pointer-events: none; opacity: 0; transition: opacity ${transitionDuration} ease-in-out; } .workspace-leaf.mod-active .view-content::before { left: 0; background: linear-gradient(to right, ${vignetteColor} 0%, transparent 100%); } .workspace-leaf.mod-active .view-content::after { right: 0; background: linear-gradient(to left, ${vignetteColor} 0%, transparent 100%); } body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .view-content::before, body.${ACTIVE_FILTER_BODY_CLASS} .workspace-leaf.mod-active .view-content::after { opacity: 1; }`; this.cssStyleEl = document.createElement('style'); this.cssStyleEl.id = cssId; this.cssStyleEl.textContent = css; document.head.appendChild(this.cssStyleEl);
    }
    removeCss() { /* ... unchanged ... */
        if (this.cssStyleEl) { this.cssStyleEl.remove(); this.cssStyleEl = null; } const existingStyle = document.getElementById('regex-filter-styles'); if (existingStyle) { existingStyle.remove(); }
    }
    updateBodyClass() { /* ... unchanged ... */
        let isAnyFilterActive = false; this.app.workspace.iterateCodeMirrors(cm => { try { const state = cm.state.field(filterStateField, false); if (state?.enabled) { isAnyFilterActive = true; } } catch (e) { /* ignore */ } }); if (isAnyFilterActive) { document.body.classList.add(ACTIVE_FILTER_BODY_CLASS); } else { document.body.classList.remove(ACTIVE_FILTER_BODY_CLASS); }
    }

    toggleFilter(editor: Editor, view: MarkdownView) {
        const cm = (editor as { cm?: EditorView }).cm; if (!cm || !(cm instanceof EditorView)) { new Notice("Regex filter currently only works in Live Preview or Source Mode views."); return; }
        const currentFilterState = cm.state.field(filterStateField, false); if (currentFilterState === undefined) { new Notice("Filter state not found for this editor. Try reopening the note or reloading Obsidian."); return; }

        if (currentFilterState.enabled) {
            cm.dispatch({ effects: [ toggleFilterEffect.of(false) ]}); // Should trigger fold update
            new Notice('Regex filter disabled.');
            this.updateBodyClass();
        } else {
            this.promptForRegex(cm);
        }
    }

    promptForRegex(cm: EditorView) {
        const prefillValue = this.lastRegexStr ?? this.settings.regexHistory[0] ?? "";
        new RegexInputModal( this.app, prefillValue, this.settings.regexHistory, (result) => {
                if (result === null) { new Notice('Regex filter cancelled.'); this.ensureFilterDisabled(cm); return; }
                if (result.trim().length === 0) { new Notice("Regex cannot be empty. Filter cancelled."); this.ensureFilterDisabled(cm); return; }

                try { // --- Valid Regex ---
                    const regex = new RegExp(result, 'u'); this.lastRegexStr = result; this.updateRegexHistory(result);
                    cm.dispatch({ effects: [ setRegexEffect.of(regex) ] }); // Should trigger fold update
                    new Notice(`Regex filter enabled: /${result}/u`);
                    this.updateBodyClass();

                } catch (e) { // --- Invalid Regex ---
                    const errorMessage = (e instanceof Error) ? e.message : String(e); new Notice(`Invalid Regex: ${errorMessage}`); console.error("Regex Compile Error:", e);
                    this.ensureFilterDisabled(cm);
                }
            }
        ).open();
    }

    ensureFilterDisabled(cm: EditorView) {
         try {
            const currentState = cm.state.field(filterStateField);
            if (currentState.enabled) {
                 cm.dispatch({ effects: [ toggleFilterEffect.of(false) ] }); // Should trigger fold update
            }
         } catch (err) { console.error("Error accessing filter state", err); }
         this.updateBodyClass();
    }

} // End of Plugin Class


// --- Settings Tab Class --- (Unchanged)
class RegexLineFilterSettingTab extends PluginSettingTab { /* ... */ plugin: RegexLineFilterPlugin; constructor(app: App, plugin: RegexLineFilterPlugin) { super(app, plugin); this.plugin = plugin; } display(): void { const {containerEl} = this; containerEl.empty(); containerEl.createEl('h2', {text: 'Regex Line Filter Settings'}); new Setting(containerEl).setName('Hide empty lines').setDesc('When the filter is active, also hide (fold) lines that contain only whitespace.').addToggle(toggle => toggle.setValue(this.plugin.settings.hideEmptyLines).onChange(async (value) => { this.plugin.settings.hideEmptyLines = value; await this.plugin.saveSettings(); this.plugin.dispatchSettingToEditors(value); })); containerEl.createEl('h3', { text: 'Recent Regex History' }); const historyList = containerEl.createEl('ul', { cls: 'regex-filter-settings-history' }); if (this.plugin.settings.regexHistory.length > 0) { this.plugin.settings.regexHistory.forEach(regex => { historyList.createEl('li', { text: `/${regex}/u` }); }); } else { historyList.createEl('li', { text: 'No history yet.' }); } } }

// --- Modal Class definition --- (Unchanged)
class RegexInputModal extends Modal { /* ... */ result: string; onSubmit: (result: string | null) => void; initialValue: string; history: string[]; inputComponent: Setting; textInputEl: HTMLInputElement | null = null; constructor(app: App, initialValue: string, history: string[], onSubmit: (result: string | null) => void) { super(app); this.initialValue = initialValue; this.history = history; this.onSubmit = onSubmit; this.result = initialValue; } onOpen() { const { contentEl } = this; contentEl.empty(); contentEl.createEl('h2', { text: 'Enter Regex Filter' }); this.inputComponent = new Setting(contentEl).setName('Regular Expression (Unicode):').addText((text) => { this.textInputEl = text.inputEl; text.setValue(this.initialValue).setPlaceholder('e.g., - \\[ \\]').onChange((value) => { this.result = value; }); text.inputEl.focus(); text.inputEl.select(); text.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.submit(); } }); }); this.inputComponent.controlEl.addClass('regex-filter-input-control'); if (this.history && this.history.length > 0) { const historyEl = contentEl.createDiv({ cls: 'regex-filter-history-container' }); historyEl.createSpan({ text: 'History:', cls: 'regex-filter-history-label' }); this.history.forEach(histEntry => { const btn = historyEl.createEl('button', { text: `/${histEntry}/`, cls: 'regex-filter-history-item', attr: { title: `Use: /${histEntry}/u` } }); btn.addEventListener('click', () => { if (this.textInputEl) { this.textInputEl.value = histEntry; this.result = histEntry; this.textInputEl.focus(); } }); }); } new Setting(contentEl).addButton((btn) => btn.setButtonText('Apply Filter').setCta().onClick(() => { this.submit(); })).addButton((btn) => btn.setButtonText('Cancel').onClick(() => { this.close(); this.onSubmit(null); })); } submit() { this.close(); this.onSubmit(this.result); } onClose() { let { contentEl } = this; contentEl.empty(); } }