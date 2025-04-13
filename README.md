**Core Purpose:**  
The plugin allows users to filter the active editor view in Obsidian so that only lines matching a user-supplied regular expression are displayed. Users can edit these visible lines. Toggling the filter off restores the full view of the note with the edits preserved. Toggling it back on re-prompts for a regex (pre-filled with the last used one).

**Key Features to Highlight:**

- **Regex Filtering:** Filters the current note based on a JavaScript-compatible regex (including emoji support).
    
- **Live Editing:** Allows editing of the filtered (visible) lines directly. Edits are saved to the actual note.
    
- **Toggle Command:** Provides a command palette action (and assignable hotkey) to toggle the filter on/off.
    
- **Regex Input Modal:** A clean modal prompts for the regex when activating the filter.
    
- **Persistent History:** Remembers the last 5 unique regex strings used across sessions and displays them as clickable buttons in the input modal for quick reuse.
    
- **Empty Line Handling:** Includes a setting to choose whether empty lines (containing only whitespace) should also be hidden when the filter is active (defaults to true).
    
- **Visual Indicator:** Adds a subtle darkening effect (inset box-shadow) to the editor margins when the filter is active, providing clear visual feedback.
    
- **Implementation:** Uses CodeMirror 6 decorations (display: none) to hide non-matching lines without modifying the underlying file structure directly (until edits are made).

**Known Limitations:**

- **Folded text:** Matched lines within folded blocks of text will not be included in the filter.