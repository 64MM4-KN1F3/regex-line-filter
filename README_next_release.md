## Regex Line Filter plugin for Obsidian
![image](/images/logo_05.png)

#### Purpose:
The plugin allows users to filter the active editor view in Obsidian so that only lines matching a user-supplied regular expression are displayed. Users can edit these visible lines. Toggling the filter off restores the full view of the note with the edits preserved. Toggling it back on re-prompts for a regex (pre-filled with the last used one).

#### Key Features:

- **Regex Filtering:** Filters the current note based on a JavaScript-compatible regex (including emoji support).
    
- **Live Editing:** Allows editing of the filtered (visible) lines directly. Edits are saved to the actual note.
    
- **Toggle Command:** Provides a command palette action (and assignable hotkey) to toggle the filter on/off.
    
- **Regex Input Modal:** A clean modal prompts for the regex when activating the filter.
    
- **Persistent History:** Remembers the last 5 unique regex strings used across sessions and displays them as clickable buttons in the input modal for quick reuse.
    
- **Empty Line Handling:** Includes a setting to choose whether empty lines (containing only whitespace) should also be hidden when the filter is active (defaults to true).
    
- **Visual Indicator:** Adds a subtle darkening effect (inset box-shadow) to the editor margins when the filter is active, providing clear visual feedback.
    
- **Hotkey Assignable Custom Filters:** Create custom filters and assign individual hotkeys to them. Toggling multiple custom filters will allow for incremental additive/subtractive filter output.

- **Child indents:** Child indents will be included in an active filter by default. This behaviour can be disabled in plugin settings if desired.

##### Known Limitations:

- **Copying filtered text:** Highlighting and copying filtered lines will implicitly copy all the lines that are filtered between the beginnning and end of the highlighted text.

#### How To:
![image](/images/regex-line-filter.gif)

*Demo showing a number of regex filters used with the plugin assigned to a HotKey.*


**Thank You:**
- To **SkepticMystic** for the inspiration for saveable individual filters in your **Advanced Cursors** plugin.
- To **FelipeRearden** for the above enhancement suggestion!

**License:**
Apache 2.0

<a href="https://coff.ee/64mm4kn1f3"><img src="/images/coffee.png" align="left" width="20%" height="20%" ></a>
