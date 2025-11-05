# Timeline Editor Implementation Plan

This document outlines the step-by-step implementation plan to transform the MP3 to MP4 converter into a basic timeline editor with drag-and-drop and cutting capabilities.

## Overview

**Goal**: Add timeline-based editing with:
- Visual timeline with waveforms
- Drag-and-drop to reorder clips
- Cut/split clips at playhead
- Trim clip edges
- Time-based positioning (not just concatenation)

**Estimated Duration**: 6-8 weeks
**Approach**: Incremental development with sequential prompts

---

## Phase 1: Foundation & Data Model (Week 1)

### Prompt 1.1: Update Data Model & TypeScript Interfaces
**Chat Session**: New chat #1
**Dependencies**: None (starting point)

**Prompt**:
```
I'm working on the MP3 to MP4 converter in /Users/sabino/Documents/sm-editor/sm-editor.

I want to transform this into a timeline-based editor where audio clips can be positioned at specific times, not just concatenated.

Please update the data model in src/main.ts:

1. Replace the simple AudioFile interface with a comprehensive timeline model:
   - Clip interface: id, sourceFile, startTime, duration, trimStart, trimEnd
   - Track interface: id, type, clips array, volume, muted
   - Timeline interface: tracks array, totalDuration, playheadPosition

2. Update all references from the old audioFiles array to use the new Timeline structure

3. Add utility functions:
   - getClipById(clipId: string)
   - getTrackById(trackId: string)
   - getTotalTimelineDuration()
   - addClipToTrack(clip, trackId)
   - removeClipFromTrack(clipId, trackId)

4. Keep the existing file selection logic but adapt it to create Clip objects instead

DO NOT change the UI yet - just the data layer. Ensure the app still compiles.
```

**Expected Outcome**: New TypeScript interfaces, updated data structures, helper functions

---

### Prompt 1.2: Extract Audio Metadata (Duration)
**Chat Session**: New chat #2 (or continue #1)
**Dependencies**: Prompt 1.1 completed

**Prompt**:
```
Building on the previous changes to the data model in src/main.ts:

Now I need to extract audio file metadata (especially duration) to properly position clips on the timeline.

Please implement:

1. Create a new function `getAudioMetadata(filePath: string): Promise<AudioMetadata>` that uses the Web Audio API to:
   - Load the audio file
   - Extract duration in seconds
   - Extract sample rate
   - Return metadata object

2. Add a Tauri command in src-tauri/src/lib.rs called `get_audio_duration` that:
   - Takes a file path
   - Uses a library like `symphonia` or calls ffprobe
   - Returns the duration as f64 (seconds)

3. Update the selectAudio() function to:
   - Get metadata for each selected file
   - Create Clip objects with proper duration
   - Add clips to the default audio track

4. Show a loading indicator while metadata is being extracted

Test that file selection still works and clips now have accurate duration data.
```

**Expected Outcome**: Audio duration extraction working, clips have metadata

---

## Phase 2: Timeline UI Foundation (Week 2)

### Prompt 2.1: Create Basic Timeline Component
**Chat Session**: New chat #3
**Dependencies**: Prompts 1.1, 1.2 completed

**Prompt**:
```
Continuing the timeline editor in /Users/sabino/Documents/sm-editor/sm-editor:

Now let's build the visual timeline interface to replace the current playlist view.

Please implement:

1. In index.html, replace the #audio-playlist div with a new #timeline-container that includes:
   - Time ruler at the top (showing seconds/minutes)
   - Track lanes (rows for each audio track)
   - Playhead indicator (vertical line)

2. In src/main.ts, create new functions:
   - renderTimeline(): Main timeline render function
   - renderTimeRuler(duration: number): Draw time markers
   - renderTrack(track: Track): Draw track lane with clips
   - renderClip(clip: Clip): Draw individual clip block

3. In src/styles.css, add styling:
   - .timeline-container: scrollable horizontal area
   - .timeline-ruler: time markers at top
   - .timeline-track: horizontal track lane
   - .timeline-clip: visual clip block with borders
   - .timeline-playhead: red vertical line

4. Use a pixel-to-time scale (e.g., 100 pixels = 1 second) for positioning

5. Add zoom controls (+/- buttons) to adjust the scale

Replace the old playlist rendering with the new timeline. Clips should appear as colored blocks positioned horizontally by their startTime.
```

**Expected Outcome**: Visual timeline with clips as blocks, time ruler, basic layout

---

### Prompt 2.2: Add Waveform Visualization
**Chat Session**: New chat #4
**Dependencies**: Prompt 2.1 completed

**Prompt**:
```
Continuing the timeline editor - let's add waveform visualization to clips.

Please implement:

1. Install wavesurfer.js:
   - Add to package.json
   - Import in main.ts

2. Create a waveform rendering system:
   - Generate waveform data for each audio clip when loaded
   - Cache waveform data (don't regenerate on every render)
   - Draw waveforms inside clip blocks on the timeline

3. Update renderClip() function to:
   - Create a small canvas/container for the waveform
   - Use wavesurfer.js or canvas to draw the waveform
   - Show clip name overlay at the top

4. Add a loading state while waveforms are being generated

5. Optimize for performance:
   - Use lower resolution waveform data (peaks)
   - Lazy load waveforms (only visible clips)

The timeline should now show audio waveforms inside each clip block, making it easy to see the audio content visually.
```

**Expected Outcome**: Clips show waveforms, visual audio representation

---

## Phase 3: Drag & Drop Interaction (Week 3)

### Prompt 3.1: Implement Horizontal Drag-and-Drop
**Chat Session**: New chat #5
**Dependencies**: Prompts 2.1, 2.2 completed

**Prompt**:
```
Continuing the timeline editor - let's add drag-and-drop functionality to move clips horizontally along the timeline.

Please implement:

1. Add drag event listeners to clip elements:
   - mousedown: Start drag
   - mousemove: Update clip position
   - mouseup: Commit new position

2. Create drag handler functions:
   - startDrag(clipId, mouseX)
   - updateDrag(mouseX): Calculate new startTime based on mouse position and zoom scale
   - endDrag(): Update clip.startTime in the data model

3. Visual feedback during drag:
   - Make clip semi-transparent while dragging
   - Show snap guides when near other clips
   - Display time position tooltip

4. Add snap-to-grid behavior:
   - Snap to 0.5 second intervals
   - Snap to other clip edges (start/end)
   - Hold Shift to disable snapping

5. Prevent clips from overlapping (for now):
   - Check collision with other clips
   - Don't allow drop if it would overlap

6. Update the timeline after each drop to reflect new positions

Test by dragging clips left and right on the timeline. The conversion should use the new clip positions.
```

**Expected Outcome**: Clips can be dragged horizontally, reposition on timeline

---

### Prompt 3.2: Add Playhead & Scrubbing
**Chat Session**: New chat #6 (or continue #5)
**Dependencies**: Prompt 3.1 completed

**Prompt**:
```
Continuing the timeline editor - let's add playhead control and scrubbing.

Please implement:

1. Playhead positioning:
   - Click on time ruler to move playhead
   - Playhead should be a red vertical line across all tracks
   - Show current time next to playhead

2. Keyboard controls:
   - Space: Play/pause preview
   - Arrow keys: Move playhead left/right
   - Home/End: Jump to start/end
   - J/K/L: Reverse/pause/forward

3. Audio preview playback:
   - Use Web Audio API to play audio at playhead position
   - Mix audio from all clips at current time
   - Update playhead position during playback

4. Scrubbing:
   - Click and drag on time ruler to scrub
   - Audio should follow scrubbing (even if choppy)

5. Add transport controls:
   - Play/pause button
   - Stop button (returns to 0)
   - Current time display (MM:SS.mmm)

This allows users to navigate the timeline and preview audio before converting.
```

**Expected Outcome**: Playhead navigation, audio preview, transport controls

---

## Phase 4: Cutting & Trimming (Week 4-5)

### Prompt 4.1: Implement Split/Cut at Playhead
**Chat Session**: New chat #7
**Dependencies**: Prompts 3.1, 3.2 completed

**Prompt**:
```
Continuing the timeline editor - let's add the ability to split/cut clips.

Please implement:

1. Add a "Split" button or keyboard shortcut (S):
   - Find the clip under the playhead
   - Calculate split position within that clip
   - Create two new clips from the original

2. Splitting logic:
   - Clip A: Keep original startTime, trim end at split point
   - Clip B: New startTime at split point, trim start from split point
   - Both clips reference the same source file

3. Update the data model:
   - Remove original clip
   - Add two new clips with updated trim values
   - Recalculate durations

4. Add visual split indicator:
   - Show a dotted line on clips where playhead intersects
   - Highlight clip under playhead

5. Add context menu (right-click on clip):
   - Split at playhead
   - Delete clip
   - Duplicate clip

6. Ensure the FFmpeg export logic can handle trimmed clips

Test by splitting a clip multiple times and verifying the conversion works correctly.
```

**Expected Outcome**: Clips can be split at playhead, creating two clips

---

### Prompt 4.2: Implement Trim Handles
**Chat Session**: New chat #8
**Dependencies**: Prompt 4.1 completed

**Prompt**:
```
Continuing the timeline editor - let's add trim handles to adjust clip in/out points.

Please implement:

1. Add trim handles to clip edges:
   - Left edge: Trim start (adjust trimStart)
   - Right edge: Trim end (adjust trimEnd)
   - Handles should be small draggable areas (5-10px)

2. Trim drag logic:
   - Drag left handle: Adjust trimStart and startTime
   - Drag right handle: Adjust trimEnd only
   - Update clip duration in real-time

3. Visual feedback:
   - Cursor changes to resize icon on hover
   - Show trimmed portion in different color/opacity
   - Display trim values in tooltip

4. Constraints:
   - Cannot trim beyond source file bounds
   - Minimum clip duration (e.g., 0.1 seconds)
   - Snap to other clip edges

5. Update waveform display:
   - Show only the visible (non-trimmed) portion
   - Gray out trimmed regions

6. Keyboard shortcuts:
   - [ and ]: Trim left/right edge to playhead
   - Alt+Left/Right: Nudge trim by frame

Test trimming clips from both ends and verify FFmpeg export respects trim points.
```

**Expected Outcome**: Clips can be trimmed from edges, visual trim feedback

---

### Prompt 4.3: Add Gap Management & Ripple Delete
**Chat Session**: New chat #9
**Dependencies**: Prompt 4.2 completed

**Prompt**:
```
Continuing the timeline editor - let's add smart gap management.

Please implement:

1. Delete operations:
   - Delete: Remove clip, leave gap
   - Ripple Delete (Shift+Delete): Remove clip, close gap by shifting later clips left

2. Ripple logic:
   - Calculate gap size
   - Move all clips after the gap left by gap duration
   - Update all affected clip startTimes

3. Gap visualization:
   - Show empty space between clips clearly
   - Add "Remove Gap" button on gaps

4. Insert mode:
   - When dropping a clip on timeline, push existing clips right (optional mode)
   - Toggle between insert and overwrite mode

5. Magnetic timeline (optional):
   - Automatically close small gaps (<0.5s) when dragging clips
   - Hold Cmd/Ctrl to disable

Test deleting clips and ensure ripple delete closes gaps correctly without breaking the timeline.
```

**Expected Outcome**: Ripple delete, gap management, cleaner timeline workflow

---

## Phase 5: Export & FFmpeg Integration (Week 6)

### Prompt 5.1: Generate FFmpeg Filter Complex from Timeline
**Chat Session**: New chat #10
**Dependencies**: All Phase 4 prompts completed

**Prompt**:
```
Continuing the timeline editor - let's update the FFmpeg export to handle the complex timeline.

The current export just concatenates files. We need to support:
- Clips at specific time positions (with gaps)
- Trimmed clips (trimStart, trimEnd)
- Multiple clips from the same source file
- Overlapping clips (mix audio)

Please implement in src-tauri/src/lib.rs:

1. Create a new Rust struct matching the Timeline/Clip model:
   ```rust
   struct TimelineClip {
       source_path: String,
       start_time: f64,
       duration: f64,
       trim_start: f64,
       trim_end: f64,
   }
   ```

2. Create function `generate_filter_complex(clips: Vec<TimelineClip>) -> String`:
   - For each clip, generate: atrim, asetpts, adelay filters
   - Mix all processed clips with amix
   - Handle gaps by adding silence
   - Handle overlaps by mixing

3. Update the convert_to_video command to:
   - Accept a Timeline structure instead of Vec<String>
   - Generate the filter_complex string
   - Pass to FFmpeg

4. Example FFmpeg command to generate:
   ```bash
   ffmpeg -i audio1.mp3 -i audio2.mp3 \
     -filter_complex "
       [0:a]atrim=start=2:end=10,asetpts=PTS-STARTPTS,adelay=0|0[a1];
       [1:a]atrim=start=0:end=5,asetpts=PTS-STARTPTS,adelay=10000|10000[a2];
       [a1][a2]amix=inputs=2:duration=longest
     " output.mp3
   ```

5. Add error handling for complex filter generation

Test with various timeline configurations: gaps, trims, overlaps.
```

**Expected Outcome**: FFmpeg export respects timeline positions, trims, gaps

---

### Prompt 5.2: Add Export Progress & Preview
**Chat Session**: New chat #11
**Dependencies**: Prompt 5.1 completed

**Prompt**:
```
Continuing the timeline editor - let's improve the export experience.

Please implement:

1. FFmpeg progress tracking:
   - Parse FFmpeg output to get progress percentage
   - Update progress bar in real-time
   - Show estimated time remaining

2. Pre-export validation:
   - Check timeline for issues (empty tracks, gaps at start, etc.)
   - Show warnings to user before export
   - Confirm export settings

3. Export settings dialog:
   - Output format (mp4, mov, etc.)
   - Video resolution
   - Audio bitrate
   - Output filename

4. Preview before export:
   - "Preview" button that generates first 10 seconds
   - Quick preview playback in-app
   - Allows checking before full export

5. Background export:
   - Allow continuing editing while exporting
   - Show export in progress in status bar
   - Notification when complete

Test exporting various timeline configurations and verify progress tracking works.
```

**Expected Outcome**: Better export UX, progress tracking, preview capability

---

## Phase 6: Polish & Advanced Features (Week 7-8)

### Prompt 6.1: Add Undo/Redo System
**Chat Session**: New chat #12
**Dependencies**: All core features completed

**Prompt**:
```
Continuing the timeline editor - let's add undo/redo functionality.

Please implement:

1. Command pattern for all timeline operations:
   - AddClipCommand
   - RemoveClipCommand
   - MoveClipCommand
   - SplitClipCommand
   - TrimClipCommand

2. History manager:
   - Maintain stack of executed commands
   - Each command implements: execute(), undo()
   - Track current position in history

3. Undo/Redo functions:
   - Cmd/Ctrl+Z: Undo last operation
   - Cmd/Ctrl+Shift+Z: Redo
   - Update UI after each undo/redo

4. UI indicators:
   - Show "Undo: <action name>" in menu
   - Disable buttons when at history limits
   - Show history panel (optional)

5. State snapshots:
   - Deep clone timeline state before operations
   - Efficient diff-based undo (optional optimization)

Test by performing multiple operations and undoing/redoing them.
```

**Expected Outcome**: Full undo/redo system for all operations

---

### Prompt 6.2: Add Multi-Track Support
**Chat Session**: New chat #13
**Dependencies**: Prompt 6.1 completed

**Prompt**:
```
Continuing the timeline editor - let's support multiple audio tracks.

Please implement:

1. Track management:
   - "Add Track" button
   - "Remove Track" button
   - Track name editing
   - Track solo/mute buttons

2. Drag clips between tracks:
   - Vertical drag to move clip to different track
   - Visual feedback during cross-track drag
   - Update clip.trackId on drop

3. Track mixer:
   - Volume slider per track
   - Mute/solo buttons
   - Pan control (left/right balance)
   - Master volume control

4. FFmpeg export updates:
   - Process each track separately
   - Mix all tracks with proper volumes
   - Respect mute/solo settings

5. Visual track separation:
   - Alternating track colors
   - Track headers on left
   - Collapse/expand tracks

Test by creating a complex multi-track composition with different volumes per track.
```

**Expected Outcome**: Multiple audio tracks, per-track controls, mixing

---

### Prompt 6.3: Add Keyboard Shortcuts & Tools
**Chat Session**: New chat #14
**Dependencies**: All previous prompts completed

**Prompt**:
```
Continuing the timeline editor - let's add professional keyboard shortcuts and tool modes.

Please implement:

1. Tool system:
   - Selection tool (V): Default, select and move clips
   - Cut tool (C): Click to split clips
   - Hand tool (H): Pan timeline view
   - Zoom tool (Z): Click to zoom in/out

2. Comprehensive keyboard shortcuts:
   - V/C/H/Z: Switch tools
   - Cmd/Ctrl+A: Select all clips
   - Delete/Backspace: Delete selected clips
   - Cmd/Ctrl+D: Duplicate selected clips
   - Cmd/Ctrl+C/V: Copy/paste clips
   - +/- : Zoom in/out
   - Cmd/Ctrl+0: Fit timeline to window

3. Selection system:
   - Click to select clip (highlight)
   - Cmd+Click: Multi-select
   - Drag rectangle to select multiple
   - Arrow keys: Move selection

4. Shortcuts help panel:
   - Press ? to show shortcuts overlay
   - Searchable shortcut list
   - Printable reference

5. Preferences:
   - Settings for default tool
   - Snap sensitivity
   - Playback settings

Add a toolbar showing current tool and allow clicking to switch tools.
```

**Expected Outcome**: Professional tool system, comprehensive shortcuts

---

### Prompt 6.4: Performance Optimization & Polish
**Chat Session**: New chat #15
**Dependencies**: All features implemented

**Prompt**:
```
Final polish for the timeline editor - let's optimize performance and add finishing touches.

Please implement optimizations:

1. Performance improvements:
   - Virtual scrolling for long timelines
   - Debounce waveform rendering
   - RequestAnimationFrame for playhead updates
   - Web Worker for waveform generation
   - Cache rendered clip visuals

2. Visual polish:
   - Smooth animations for drag/drop
   - Better color scheme for clips
   - Shadows and depth
   - Loading skeletons
   - Empty state illustrations

3. User feedback:
   - Toast notifications for actions
   - Confirmation dialogs for destructive actions
   - Error messages with helpful suggestions
   - Onboarding tutorial (optional)

4. Project management:
   - Save timeline as project file (.json)
   - Load existing projects
   - Auto-save (localStorage)
   - Recent projects list

5. Bug fixes and edge cases:
   - Handle very short clips (<0.1s)
   - Handle very long audio files (>1hr)
   - Empty timeline state
   - Corrupted audio files

Test the entire application end-to-end with various scenarios.
```

**Expected Outcome**: Polished, performant, production-ready timeline editor

---

## Summary: Execution Order

Execute prompts in this order, each in a new chat session:

1. ✅ **Chat #1**: Data model refactor (Prompt 1.1)
2. ✅ **Chat #2**: Audio metadata extraction (Prompt 1.2)
3. ✅ **Chat #3**: Basic timeline UI (Prompt 2.1)
4. ✅ **Chat #4**: Waveform visualization (Prompt 2.2)
5. ✅ **Chat #5**: Drag-and-drop (Prompt 3.1)
6. ✅ **Chat #6**: Playhead & scrubbing (Prompt 3.2)
7. ✅ **Chat #7**: Split/cut clips (Prompt 4.1)
8. ✅ **Chat #8**: Trim handles (Prompt 4.2)
9. ✅ **Chat #9**: Gap management (Prompt 4.3)
10. ✅ **Chat #10**: FFmpeg filter complex (Prompt 5.1)
11. ✅ **Chat #11**: Export progress (Prompt 5.2)
12. ✅ **Chat #12**: Undo/redo (Prompt 6.1)
13. ✅ **Chat #13**: Multi-track (Prompt 6.2)
14. ✅ **Chat #14**: Shortcuts & tools (Prompt 6.3)
15. ✅ **Chat #15**: Polish & optimization (Prompt 6.4)

## Tips for Execution

- **Start each new chat with context**: "Continuing from the previous implementation..."
- **Reference files changed**: Always mention which files were modified in previous step
- **Verify before proceeding**: Test each step before moving to next
- **Save git commits**: Commit after each prompt for easy rollback
- **Document decisions**: Keep notes on architectural choices made

## Estimated Timeline

| Phase | Duration | Prompts |
|-------|----------|---------|
| Phase 1: Foundation | 1 week | 1.1-1.2 |
| Phase 2: Timeline UI | 1 week | 2.1-2.2 |
| Phase 3: Interaction | 1 week | 3.1-3.2 |
| Phase 4: Editing | 2 weeks | 4.1-4.3 |
| Phase 5: Export | 1 week | 5.1-5.2 |
| Phase 6: Polish | 2 weeks | 6.1-6.4 |
| **Total** | **6-8 weeks** | **15 prompts** |

## Alternative: MVP Fast Track

If you want a working prototype faster, execute only these prompts:

1. Chat #1: Data model (1.1)
2. Chat #2: Metadata (1.2)
3. Chat #3: Basic timeline (2.1)
4. Chat #5: Drag-and-drop (3.1)
5. Chat #7: Split clips (4.1)
6. Chat #10: FFmpeg export (5.1)

**MVP Timeline**: 2-3 weeks, 6 prompts

This gives you drag-and-drop reordering and basic splitting - the core value proposition - without all the polish.
