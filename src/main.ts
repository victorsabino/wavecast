import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import WaveSurfer from 'wavesurfer.js';

// Timeline-based data model
interface Clip {
  id: string;
  sourceFile: string;
  sourceName: string;
  trackId: string;
  startTime: number;      // Position in timeline (seconds)
  duration: number;       // Clip duration (after trimming)
  trimStart: number;      // Trim from source start (seconds)
  trimEnd: number;        // Trim from source end (seconds)
  sourceDuration: number; // Original file duration
}

interface Track {
  id: string;
  type: 'audio' | 'background';
  name: string;
  clips: Clip[];
  volume: number;
  muted: boolean;
}

interface Timeline {
  tracks: Track[];
  playheadPosition: number;
}

// Legacy interface for backward compatibility during migration
interface AudioFile {
  path: string;
  name: string;
  duration?: number;
}

let currentAudio: HTMLAudioElement | null = null;
let currentPlayingIndex: number | null = null;

// Timeline state
let timeline: Timeline = {
  tracks: [],
  playheadPosition: 0
};

// Legacy state (will be migrated)
let selectedImage: string | null = null;
let audioFiles: AudioFile[] = []; // Keep for backward compatibility during migration
let backgroundStyle: string = "cover";
let lastGeneratedVideo: string | null = null;
let vimeoToken: string = "";
let videoTitle: string = "Converted Video";
let autoUpload: boolean = false;
let bgMusicFile: string | null = null;
let bgMusicVolume: number = 30;
let mainAudioVolume: number = 100;

// ID generation
let nextClipId = 1;
let nextTrackId = 1;

// Timeline UI state
let pixelsPerSecond = 100; // Zoom level: 100px = 1 second
let minZoom = 20;
let maxZoom = 400;

// Drag state
interface DragState {
  clipId: string;
  trackId: string;
  startX: number;
  originalStartTime: number;
  isDragging: boolean;
}
let dragState: DragState | null = null;
const snapThreshold = 0.5; // Snap to 0.5 second intervals

// Trim state
interface TrimState {
  clipId: string;
  edge: 'left' | 'right';
  startX: number;
  originalStartTime: number;
  originalDuration: number;
  originalTrimStart: number;
  originalTrimEnd: number;
  isTrimming: boolean;
}
let trimState: TrimState | null = null;

// Playback state
let isPlaying = false;
let playbackStartTime = 0;
let playbackRequestId: number | null = null;
let _audioContext: AudioContext | null = null; // Will be used for audio preview
let _audioBuffers = new Map<string, AudioBuffer>(); // Will be used for audio preview

// Waveform cache: sourceFile path -> peaks data
interface WaveformData {
  peaks: number[];
  duration: number;
}
const waveformCache = new Map<string, WaveformData>();
const waveformLoadingSet = new Set<string>();

// DOM Elements
let timelineContainer: HTMLElement;
let timelineRuler: HTMLElement;
let timelineTracks: HTMLElement;
let timelinePlayhead: HTMLElement;
let zoomInBtn: HTMLElement;
let zoomOutBtn: HTMLElement;
let zoomLevelSpan: HTMLElement;
let timelinePlayBtn: HTMLElement;
let timelineTimeDisplay: HTMLElement;
let imageUploadArea: HTMLElement;
let imagePlaceholder: HTMLElement;
let imagePreview: HTMLImageElement;
let imageOptions: HTMLElement;
let audioUploadArea: HTMLElement;
let audioPlaylist: HTMLElement;
let convertBtn: HTMLButtonElement;
let progressSection: HTMLElement;
let resultSection: HTMLElement;
let resultMessage: HTMLElement;
let backgroundStyleSelect: HTMLSelectElement;
let bgMusicUploadArea: HTMLElement;
let bgMusicPlaceholder: HTMLElement;
let bgMusicInfo: HTMLElement;
let bgMusicName: HTMLElement;
let bgMusicRemove: HTMLElement;
let bgMusicOptions: HTMLElement;
let bgMusicVolumeSlider: HTMLInputElement;
let volumeValue: HTMLElement;
let audioVolumeControl: HTMLElement;
let audioVolumeSlider: HTMLInputElement;
let audioVolumeValue: HTMLElement;
let assemblyPreview: HTMLElement;
let assemblyTimeline: HTMLElement;

// ============================================================================
// Timeline Utility Functions
// ============================================================================

function generateClipId(): string {
  return `clip-${nextClipId++}`;
}

function generateTrackId(): string {
  return `track-${nextTrackId++}`;
}

// Will be used in Phase 3+
function _getClipById(clipId: string): Clip | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) return clip;
  }
  return null;
}

function getTrackById(trackId: string): Track | null {
  return timeline.tracks.find(t => t.id === trackId) || null;
}

// Will be used in Phase 2+
function _getTotalTimelineDuration(): number {
  let maxDuration = 0;
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const clipEnd = clip.startTime + clip.duration;
      if (clipEnd > maxDuration) {
        maxDuration = clipEnd;
      }
    }
  }
  return maxDuration;
}

function addClipToTrack(clip: Clip, trackId: string): boolean {
  const track = getTrackById(trackId);
  if (!track) return false;

  track.clips.push(clip);
  track.clips.sort((a, b) => a.startTime - b.startTime);
  return true;
}

// Will be used in Phase 4+
function _removeClipFromTrack(clipId: string, trackId: string): boolean {
  const track = getTrackById(trackId);
  if (!track) return false;

  const index = track.clips.findIndex(c => c.id === clipId);
  if (index === -1) return false;

  track.clips.splice(index, 1);
  return true;
}

// Expose unused functions to window to prevent TS errors (temporary)
(window as any).__timeline_utils = { _getClipById, _getTotalTimelineDuration, _removeClipFromTrack, _getClipAtPosition, _audioContext, _audioBuffers, _getGapAtTime };

function createDefaultAudioTrack(): Track {
  const track: Track = {
    id: generateTrackId(),
    type: 'audio',
    name: 'Audio Track 1',
    clips: [],
    volume: 100,
    muted: false
  };
  timeline.tracks.push(track);
  return track;
}

function getOrCreateMainAudioTrack(): Track {
  let mainTrack = timeline.tracks.find(t => t.type === 'audio');
  if (!mainTrack) {
    mainTrack = createDefaultAudioTrack();
  }
  return mainTrack;
}

// ============================================================================
// Waveform Generation Functions
// ============================================================================

async function generateWaveformData(sourceFile: string): Promise<WaveformData | null> {
  // Check cache first
  if (waveformCache.has(sourceFile)) {
    return waveformCache.get(sourceFile)!;
  }

  // Check if already loading
  if (waveformLoadingSet.has(sourceFile)) {
    return null;
  }

  waveformLoadingSet.add(sourceFile);

  try {
    // Create a temporary container for WaveSurfer (off-screen)
    const tempContainer = document.createElement('div');
    tempContainer.style.display = 'none';
    document.body.appendChild(tempContainer);

    // Create WaveSurfer instance
    const wavesurfer = WaveSurfer.create({
      container: tempContainer,
      height: 0,
      normalize: true,
      barWidth: 2,
    });

    // Load the audio file
    const audioUrl = convertFileSrc(sourceFile);
    await wavesurfer.load(audioUrl);

    // Wait for ready
    await new Promise<void>((resolve) => {
      wavesurfer.on('ready', () => resolve());
    });

    // Get the peaks data
    const backend = (wavesurfer as any).backend;
    const peaks = backend.getPeaks(500); // Get 500 samples
    const duration = wavesurfer.getDuration();

    const waveformData: WaveformData = {
      peaks: Array.from(peaks),
      duration
    };

    // Cache it
    waveformCache.set(sourceFile, waveformData);

    // Clean up
    wavesurfer.destroy();
    document.body.removeChild(tempContainer);

    return waveformData;
  } catch (error) {
    console.error('Error generating waveform:', error);
    return null;
  } finally {
    waveformLoadingSet.delete(sourceFile);
  }
}

function drawWaveformToCanvas(canvas: HTMLCanvasElement, peaks: number[], clipWidth: number, clipHeight: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  canvas.width = clipWidth;
  canvas.height = clipHeight;

  // Clear canvas
  ctx.clearRect(0, 0, clipWidth, clipHeight);

  // Draw waveform
  const barWidth = clipWidth / peaks.length;
  const heightScale = clipHeight / 2;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';

  for (let i = 0; i < peaks.length; i++) {
    const x = i * barWidth;
    const barHeight = Math.abs(peaks[i]) * heightScale;
    const y = heightScale - barHeight;

    ctx.fillRect(x, y, Math.max(1, barWidth - 0.5), barHeight * 2);
  }
}

// ============================================================================
// Drag & Drop Functions
// ============================================================================

function snapToGrid(time: number, snapInterval: number): number {
  return Math.round(time / snapInterval) * snapInterval;
}

// Will be used for snap-to-clip edges in future
function _getClipAtPosition(trackId: string, time: number, excludeClipId?: string): Clip | null {
  const track = getTrackById(trackId);
  if (!track) return null;

  for (const clip of track.clips) {
    if (excludeClipId && clip.id === excludeClipId) continue;
    if (time >= clip.startTime && time < clip.startTime + clip.duration) {
      return clip;
    }
  }
  return null;
}

function startDrag(clipId: string, trackId: string, mouseX: number) {
  const clip = _getClipById(clipId);
  if (!clip) return;

  dragState = {
    clipId,
    trackId,
    startX: mouseX,
    originalStartTime: clip.startTime,
    isDragging: true
  };

  // Add dragging class
  const clipEl = document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.classList.add('dragging');
  }
}

function updateDrag(mouseX: number) {
  if (!dragState || !dragState.isDragging) return;

  const clip = _getClipById(dragState.clipId);
  if (!clip) return;

  // Calculate new position
  const deltaX = mouseX - dragState.startX;
  const deltaTime = deltaX / pixelsPerSecond;
  let newStartTime = dragState.originalStartTime + deltaTime;

  // Snap to grid
  newStartTime = snapToGrid(newStartTime, snapThreshold);

  // Prevent negative time
  if (newStartTime < 0) newStartTime = 0;

  // Check for overlaps
  const track = getTrackById(dragState.trackId);
  if (track) {
    for (const otherClip of track.clips) {
      if (otherClip.id === clip.id) continue;

      const clipEnd = newStartTime + clip.duration;
      const otherEnd = otherClip.startTime + otherClip.duration;

      // Check if clips would overlap
      if (!(clipEnd <= otherClip.startTime || newStartTime >= otherEnd)) {
        // Overlap detected, don't allow this position
        return;
      }
    }
  }

  // Update clip position
  clip.startTime = newStartTime;

  // Update visual position
  const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.style.left = `${newStartTime * pixelsPerSecond}px`;
  }
}

function endDrag() {
  if (!dragState) return;

  // Remove dragging class
  const clipEl = document.querySelector(`[data-clip-id="${dragState.clipId}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.classList.remove('dragging');
  }

  // Re-sort clips in track
  const track = getTrackById(dragState.trackId);
  if (track) {
    track.clips.sort((a, b) => a.startTime - b.startTime);
  }

  dragState = null;

  // Re-render timeline to ensure consistency
  renderTimeline();
}

// ============================================================================
// Trim Functions
// ============================================================================

function startTrim(clipId: string, edge: 'left' | 'right', mouseX: number) {
  const clip = _getClipById(clipId);
  if (!clip) return;

  trimState = {
    clipId,
    edge,
    startX: mouseX,
    originalStartTime: clip.startTime,
    originalDuration: clip.duration,
    originalTrimStart: clip.trimStart,
    originalTrimEnd: clip.trimEnd,
    isTrimming: true
  };

  // Add trimming class
  const clipEl = document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.classList.add('trimming');
  }
}

function updateTrim(mouseX: number) {
  if (!trimState || !trimState.isTrimming) return;

  const clip = _getClipById(trimState.clipId);
  if (!clip) return;

  const deltaX = mouseX - trimState.startX;
  const deltaTime = deltaX / pixelsPerSecond;

  const minDuration = 0.1; // Minimum clip duration

  if (trimState.edge === 'left') {
    // Trim from start
    let newTrimStart = trimState.originalTrimStart + deltaTime;
    let newStartTime = trimState.originalStartTime + deltaTime;
    let newDuration = trimState.originalDuration - deltaTime;

    // Constraints
    if (newTrimStart < 0) {
      newTrimStart = 0;
      newStartTime = trimState.originalStartTime - trimState.originalTrimStart;
      newDuration = trimState.originalDuration + trimState.originalTrimStart;
    }
    if (newDuration < minDuration) {
      newDuration = minDuration;
      newTrimStart = trimState.originalTrimStart + (trimState.originalDuration - minDuration);
      newStartTime = trimState.originalStartTime + (trimState.originalDuration - minDuration);
    }
    if (newTrimStart + newDuration + trimState.originalTrimEnd > clip.sourceDuration) {
      return; // Can't trim beyond source
    }

    clip.trimStart = newTrimStart;
    clip.startTime = newStartTime;
    clip.duration = newDuration;

  } else {
    // Trim from end
    let newDuration = trimState.originalDuration + deltaTime;
    let newTrimEnd = trimState.originalTrimEnd - deltaTime;

    // Constraints
    if (newTrimEnd < 0) {
      newTrimEnd = 0;
      newDuration = clip.sourceDuration - trimState.originalTrimStart;
    }
    if (newDuration < minDuration) {
      newDuration = minDuration;
      newTrimEnd = trimState.originalTrimEnd + (trimState.originalDuration - minDuration);
    }
    if (trimState.originalTrimStart + newDuration + newTrimEnd > clip.sourceDuration) {
      return; // Can't trim beyond source
    }

    clip.duration = newDuration;
    clip.trimEnd = newTrimEnd;
  }

  // Update visual
  const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.style.left = `${clip.startTime * pixelsPerSecond}px`;
    clipEl.style.width = `${clip.duration * pixelsPerSecond}px`;
  }
}

function endTrim() {
  if (!trimState) return;

  // Remove trimming class
  const clipEl = document.querySelector(`[data-clip-id="${trimState.clipId}"]`) as HTMLElement;
  if (clipEl) {
    clipEl.classList.remove('trimming');
  }

  trimState = null;

  // Re-render timeline to update waveforms
  renderTimeline();
}

// ============================================================================
// Playback Functions
// ============================================================================

function setPlayheadPosition(time: number) {
  timeline.playheadPosition = Math.max(0, time);
  updatePlayheadPosition();
  updateTimeDisplay();
}

function updateTimeDisplay() {
  if (timelineTimeDisplay) {
    timelineTimeDisplay.textContent = formatTime(timeline.playheadPosition);
  }
}

function togglePlayPause() {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (isPlaying) return;

  isPlaying = true;
  playbackStartTime = performance.now() - (timeline.playheadPosition * 1000);

  // Update play button icon to pause
  if (timelinePlayBtn) {
    timelinePlayBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
      </svg>
    `;
  }

  // Start animation loop
  updatePlayback();
}

function stopPlayback() {
  isPlaying = false;

  if (playbackRequestId !== null) {
    cancelAnimationFrame(playbackRequestId);
    playbackRequestId = null;
  }

  // Update play button icon back to play
  if (timelinePlayBtn) {
    timelinePlayBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
    `;
  }
}

function updatePlayback() {
  if (!isPlaying) return;

  const currentTime = (performance.now() - playbackStartTime) / 1000;
  timeline.playheadPosition = currentTime;

  updatePlayheadPosition();
  updateTimeDisplay();

  // Stop at end of timeline
  const totalDuration = _getTotalTimelineDuration();
  if (currentTime >= totalDuration) {
    stopPlayback();
    timeline.playheadPosition = 0;
    updatePlayheadPosition();
    updateTimeDisplay();
    return;
  }

  playbackRequestId = requestAnimationFrame(updatePlayback);
}

function handleRulerClick(e: MouseEvent) {
  const ruler = e.currentTarget as HTMLElement;
  const rect = ruler.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const time = clickX / pixelsPerSecond;

  setPlayheadPosition(time);
}

function handleKeyboardShortcuts(e: KeyboardEvent) {
  // Don't trigger if typing in an input
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      setPlayheadPosition(timeline.playheadPosition - 1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      setPlayheadPosition(timeline.playheadPosition + 1);
      break;
    case 'Home':
      e.preventDefault();
      setPlayheadPosition(0);
      break;
    case 'End':
      e.preventDefault();
      setPlayheadPosition(_getTotalTimelineDuration());
      break;
    case 's':
    case 'S':
      e.preventDefault();
      splitClipAtPlayhead();
      break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      if (e.shiftKey) {
        rippleDeleteClipAtPlayhead();
      } else {
        deleteClipAtPlayhead();
      }
      break;
    case 'g':
    case 'G':
      e.preventDefault();
      closeGapAtPlayhead();
      break;
  }
}

// ============================================================================
// Clip Editing Functions
// ============================================================================

function findClipAtPlayhead(): { clip: Clip, track: Track } | null {
  const playheadTime = timeline.playheadPosition;

  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (playheadTime >= clip.startTime && playheadTime < clip.startTime + clip.duration) {
        return { clip, track };
      }
    }
  }
  return null;
}

function splitClipAtPlayhead() {
  const result = findClipAtPlayhead();
  if (!result) {
    alert('No clip at playhead position');
    return;
  }

  const { clip, track } = result;
  const splitTime = timeline.playheadPosition;
  const relativeTime = splitTime - clip.startTime;

  // Can't split at the very start or end
  if (relativeTime <= 0.1 || relativeTime >= clip.duration - 0.1) {
    alert('Cannot split at clip edge');
    return;
  }

  // Create two new clips from the original
  const clipA: Clip = {
    id: generateClipId(),
    sourceFile: clip.sourceFile,
    sourceName: clip.sourceName,
    trackId: track.id,
    startTime: clip.startTime,
    duration: relativeTime,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd + (clip.duration - relativeTime), // Trim end of first part
    sourceDuration: clip.sourceDuration
  };

  const clipB: Clip = {
    id: generateClipId(),
    sourceFile: clip.sourceFile,
    sourceName: clip.sourceName,
    trackId: track.id,
    startTime: splitTime,
    duration: clip.duration - relativeTime,
    trimStart: clip.trimStart + relativeTime, // Trim start of second part
    trimEnd: clip.trimEnd,
    sourceDuration: clip.sourceDuration
  };

  // Remove original clip
  const index = track.clips.indexOf(clip);
  if (index !== -1) {
    track.clips.splice(index, 1);
  }

  // Add new clips
  track.clips.push(clipA, clipB);
  track.clips.sort((a, b) => a.startTime - b.startTime);

  // Re-render timeline
  renderTimeline();
}

function deleteClipAtPlayhead() {
  const result = findClipAtPlayhead();
  if (!result) {
    alert('No clip at playhead position');
    return;
  }

  const { clip, track } = result;
  const index = track.clips.indexOf(clip);
  if (index !== -1) {
    track.clips.splice(index, 1);
  }

  renderTimeline();
}

function rippleDeleteClipAtPlayhead() {
  const result = findClipAtPlayhead();
  if (!result) {
    alert('No clip at playhead position');
    return;
  }

  const { clip, track } = result;
  const gapSize = clip.duration;
  const clipEndTime = clip.startTime + clip.duration;

  // Remove the clip
  const index = track.clips.indexOf(clip);
  if (index !== -1) {
    track.clips.splice(index, 1);
  }

  // Shift all clips after this one left by the gap size
  for (const c of track.clips) {
    if (c.startTime >= clipEndTime) {
      c.startTime -= gapSize;
    }
  }

  renderTimeline();
}

function closeGapAtPlayhead() {
  const playheadTime = timeline.playheadPosition;

  // Find the gap (space between clips)
  for (const track of timeline.tracks) {
    // Sort clips by start time
    const sortedClips = [...track.clips].sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < sortedClips.length - 1; i++) {
      const currentClip = sortedClips[i];
      const nextClip = sortedClips[i + 1];
      const gapStart = currentClip.startTime + currentClip.duration;
      const gapEnd = nextClip.startTime;
      const gapSize = gapEnd - gapStart;

      // Check if playhead is in this gap
      if (playheadTime >= gapStart && playheadTime <= gapEnd && gapSize > 0) {
        // Close the gap by shifting all clips after it
        for (const c of track.clips) {
          if (c.startTime >= gapEnd) {
            c.startTime -= gapSize;
          }
        }
        renderTimeline();
        return;
      }
    }
  }

  alert('No gap at playhead position');
}

// Will be used for future gap operations
function _getGapAtTime(time: number): { gapStart: number, gapEnd: number, track: Track } | null {
  for (const track of timeline.tracks) {
    const sortedClips = [...track.clips].sort((a, b) => a.startTime - b.startTime);

    for (let i = 0; i < sortedClips.length - 1; i++) {
      const currentClip = sortedClips[i];
      const nextClip = sortedClips[i + 1];
      const gapStart = currentClip.startTime + currentClip.duration;
      const gapEnd = nextClip.startTime;

      if (time >= gapStart && time <= gapEnd && gapEnd > gapStart) {
        return { gapStart, gapEnd, track };
      }
    }
  }
  return null;
}

// ============================================================================
// Timeline Rendering Functions
// ============================================================================

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

function renderTimelineRuler(durationSeconds: number) {
  if (!timelineRuler) return;

  timelineRuler.innerHTML = '';
  const totalWidth = durationSeconds * pixelsPerSecond;
  timelineRuler.style.width = `${totalWidth}px`;

  // Determine interval based on zoom level
  let interval = 1; // 1 second
  if (pixelsPerSecond < 50) interval = 10;
  else if (pixelsPerSecond < 100) interval = 5;

  for (let i = 0; i <= durationSeconds; i += interval) {
    const marker = document.createElement('div');
    marker.className = 'timeline-marker';
    marker.style.left = `${i * pixelsPerSecond}px`;

    const label = document.createElement('span');
    label.className = 'timeline-marker-label';
    label.textContent = formatTime(i);
    marker.appendChild(label);

    timelineRuler.appendChild(marker);
  }
}

function renderClip(clip: Clip): HTMLElement {
  const clipEl = document.createElement('div');
  clipEl.className = 'timeline-clip';
  clipEl.dataset.clipId = clip.id;
  const clipWidth = clip.duration * pixelsPerSecond;
  clipEl.style.left = `${clip.startTime * pixelsPerSecond}px`;
  clipEl.style.width = `${clipWidth}px`;

  // Waveform canvas (background)
  const waveformCanvas = document.createElement('canvas');
  waveformCanvas.className = 'timeline-clip-waveform';
  clipEl.appendChild(waveformCanvas);

  // Try to load and draw waveform
  generateWaveformData(clip.sourceFile).then(waveformData => {
    if (waveformData && waveformData.peaks.length > 0) {
      drawWaveformToCanvas(waveformCanvas, waveformData.peaks, clipWidth, 44);
    }
  });

  // Clip info overlay
  const clipInfo = document.createElement('div');
  clipInfo.className = 'timeline-clip-info';

  const clipName = document.createElement('div');
  clipName.className = 'timeline-clip-name';
  clipName.textContent = clip.sourceName;

  const clipDuration = document.createElement('div');
  clipDuration.className = 'timeline-clip-duration';
  clipDuration.textContent = formatTime(clip.duration);

  clipInfo.appendChild(clipName);
  clipInfo.appendChild(clipDuration);
  clipEl.appendChild(clipInfo);

  // Add trim handles
  const leftHandle = document.createElement('div');
  leftHandle.className = 'timeline-clip-trim-handle trim-left';
  leftHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    startTrim(clip.id, 'left', e.clientX);
  });
  clipEl.appendChild(leftHandle);

  const rightHandle = document.createElement('div');
  rightHandle.className = 'timeline-clip-trim-handle trim-right';
  rightHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    startTrim(clip.id, 'right', e.clientX);
  });
  clipEl.appendChild(rightHandle);

  // Add drag event listeners (on clip body, not handles)
  clipEl.addEventListener('mousedown', (e) => {
    // Don't start drag if clicking on a handle
    if ((e.target as HTMLElement).classList.contains('timeline-clip-trim-handle')) {
      return;
    }
    e.preventDefault();
    startDrag(clip.id, clip.trackId, e.clientX);
  });

  // Highlight if playhead is over this clip
  if (timeline.playheadPosition >= clip.startTime &&
      timeline.playheadPosition < clip.startTime + clip.duration) {
    clipEl.classList.add('clip-at-playhead');

    // Add split line indicator
    const splitIndicator = document.createElement('div');
    splitIndicator.className = 'clip-split-indicator';
    const relativePosition = (timeline.playheadPosition - clip.startTime) * pixelsPerSecond;
    splitIndicator.style.left = `${relativePosition}px`;
    clipEl.appendChild(splitIndicator);
  }

  return clipEl;
}

function renderTrack(track: Track): HTMLElement {
  const trackEl = document.createElement('div');
  trackEl.className = 'timeline-track';
  trackEl.dataset.trackId = track.id;

  const trackHeader = document.createElement('div');
  trackHeader.className = 'timeline-track-header';
  trackHeader.textContent = track.name;

  const trackContent = document.createElement('div');
  trackContent.className = 'timeline-track-content';

  // Sort clips by start time
  const sortedClips = [...track.clips].sort((a, b) => a.startTime - b.startTime);

  // Render all clips in this track
  sortedClips.forEach(clip => {
    const clipEl = renderClip(clip);
    trackContent.appendChild(clipEl);
  });

  // Render gaps with visual indicators
  for (let i = 0; i < sortedClips.length - 1; i++) {
    const currentClip = sortedClips[i];
    const nextClip = sortedClips[i + 1];
    const gapStart = currentClip.startTime + currentClip.duration;
    const gapEnd = nextClip.startTime;
    const gapSize = gapEnd - gapStart;

    if (gapSize > 0.1) { // Only show gaps larger than 0.1s
      const gapEl = document.createElement('div');
      gapEl.className = 'timeline-gap';
      gapEl.style.left = `${gapStart * pixelsPerSecond}px`;
      gapEl.style.width = `${gapSize * pixelsPerSecond}px`;

      // Add gap info
      const gapLabel = document.createElement('div');
      gapLabel.className = 'timeline-gap-label';
      gapLabel.textContent = formatTime(gapSize);
      gapEl.appendChild(gapLabel);

      trackContent.appendChild(gapEl);
    }
  }

  trackEl.appendChild(trackHeader);
  trackEl.appendChild(trackContent);

  return trackEl;
}

function renderTimeline() {
  if (!timelineTracks || !timelineContainer) return;

  // Show timeline, hide legacy playlist
  timelineContainer.style.display = 'block';
  if (audioPlaylist) audioPlaylist.style.display = 'none';

  // Clear existing tracks
  timelineTracks.innerHTML = '';

  // Calculate total duration
  const duration = _getTotalTimelineDuration() || 60;

  // Render ruler
  renderTimelineRuler(duration);

  // Render each track
  timeline.tracks.forEach(track => {
    const trackEl = renderTrack(track);
    timelineTracks.appendChild(trackEl);
  });

  // Update playhead position
  updatePlayheadPosition();
}

function updatePlayheadPosition() {
  if (!timelinePlayhead) return;
  timelinePlayhead.style.left = `${timeline.playheadPosition * pixelsPerSecond}px`;
}

function setZoom(newPixelsPerSecond: number) {
  pixelsPerSecond = Math.max(minZoom, Math.min(maxZoom, newPixelsPerSecond));
  if (zoomLevelSpan) {
    zoomLevelSpan.textContent = `${Math.round((pixelsPerSecond / 100) * 100)}%`;
  }
  renderTimeline();
}

function zoomIn() {
  setZoom(pixelsPerSecond * 1.5);
}

function zoomOut() {
  setZoom(pixelsPerSecond / 1.5);
}

// ============================================================================
// Legacy Functions (for backward compatibility)
// ============================================================================

function updateConvertButton() {
  if (convertBtn) {
    // Check both legacy and new timeline
    const hasAudio = audioFiles.length > 0 || timeline.tracks.some(t => t.clips.length > 0);
    convertBtn.disabled = !selectedImage || !hasAudio;
  }
}

async function selectImage() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{
        name: 'Image',
        extensions: ['png', 'jpg', 'jpeg']
      }]
    });

    if (selected) {
      selectedImage = selected as string;

      // Show preview
      if (imagePreview && imagePlaceholder && imageOptions) {
        imagePreview.src = convertFileSrc(selectedImage);
        imagePreview.style.display = 'block';
        imagePlaceholder.style.display = 'none';
        imageOptions.style.display = 'block';
      }

      updateConvertButton();
    }
  } catch (error) {
    console.error('Error selecting image:', error);
  }
}

async function selectAudio() {
  try {
    const selected = await open({
      multiple: true,
      filters: [{
        name: 'Audio',
        extensions: ['mp3']
      }]
    });

    if (selected) {
      const files = Array.isArray(selected) ? selected : [selected];
      const mainTrack = getOrCreateMainAudioTrack();

      // Calculate starting position (after existing clips)
      let currentPosition = 0;
      if (mainTrack.clips.length > 0) {
        const lastClip = mainTrack.clips[mainTrack.clips.length - 1];
        currentPosition = lastClip.startTime + lastClip.duration;
      }

      for (const filePath of files) {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';

        // Check if file already exists in legacy array
        const existsInLegacy = audioFiles.some(f => f.path === filePath);

        // Check if file already exists in timeline
        const existsInTimeline = mainTrack.clips.some(c => c.sourceFile === filePath);

        if (!existsInLegacy && !existsInTimeline) {
          // Add to legacy array for backward compatibility
          audioFiles.push({ path: filePath, name: fileName });

          // Create new clip and add to timeline
          // Note: Duration will be set to 0 initially, will be updated when we add metadata extraction
          const clip: Clip = {
            id: generateClipId(),
            sourceFile: filePath,
            sourceName: fileName,
            trackId: mainTrack.id,
            startTime: currentPosition,
            duration: 60, // Placeholder: will be replaced with actual duration in next step
            trimStart: 0,
            trimEnd: 0,
            sourceDuration: 60 // Placeholder
          };

          addClipToTrack(clip, mainTrack.id);
          currentPosition += clip.duration; // Position next clip after this one
        }
      }

      // Render timeline (new) or playlist (legacy fallback)
      if (timeline.tracks.length > 0 && timeline.tracks.some(t => t.clips.length > 0)) {
        renderTimeline();
      } else {
        renderPlaylist();
        renderAssemblyPreview();
      }

      updateConvertButton();

      // Show volume control when audio files are added
      if (audioVolumeControl && audioFiles.length > 0) {
        audioVolumeControl.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('Error selecting audio:', error);
  }
}

function playAudio(index: number) {
  const file = audioFiles[index];

  // Stop current audio if playing
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }

  // If clicking the same file that's playing, just stop it
  if (currentPlayingIndex === index) {
    currentPlayingIndex = null;
    renderPlaylist();
    return;
  }

  // Create and play new audio
  currentAudio = new Audio(convertFileSrc(file.path));
  currentPlayingIndex = index;

  currentAudio.play();
  currentAudio.onended = () => {
    currentPlayingIndex = null;
    currentAudio = null;
    renderPlaylist();
  };

  renderPlaylist();
}

function renderPlaylist() {
  if (!audioPlaylist) return;

  audioPlaylist.innerHTML = '';

  audioFiles.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'playlist-item';
    const isPlaying = currentPlayingIndex === index;

    item.innerHTML = `
      <div class="playlist-item-info">
        <button class="playlist-item-play" data-index="${index}">
          ${isPlaying ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="6" y="4" width="4" height="16"/>
              <rect x="14" y="4" width="4" height="16"/>
            </svg>
          ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          `}
        </button>
        <svg class="playlist-item-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 18V5l12-2v13"/>
          <circle cx="6" cy="18" r="3"/>
          <circle cx="18" cy="16" r="3"/>
        </svg>
        <span class="playlist-item-name">${file.name}</span>
      </div>
      <button class="playlist-item-remove" data-index="${index}">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    `;

    audioPlaylist.appendChild(item);
  });

  // Add event listeners to play buttons
  audioPlaylist.querySelectorAll('.playlist-item-play').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt((e.currentTarget as HTMLElement).dataset.index || '0');
      playAudio(index);
    });
  });

  // Add event listeners to remove buttons
  audioPlaylist.querySelectorAll('.playlist-item-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt((e.currentTarget as HTMLElement).dataset.index || '0');
      removeAudioFile(index);
    });
  });
}

function removeAudioFile(index: number) {
  audioFiles.splice(index, 1);
  renderPlaylist();
  renderAssemblyPreview();
  updateConvertButton();

  // Hide volume control if no audio files remain
  if (audioVolumeControl && audioFiles.length === 0) {
    audioVolumeControl.style.display = 'none';
  }
}

function renderAssemblyPreview() {
  if (!assemblyPreview || !assemblyTimeline) return;

  if (audioFiles.length === 0) {
    assemblyPreview.style.display = 'none';
    return;
  }

  assemblyPreview.style.display = 'block';
  assemblyTimeline.innerHTML = '';

  if (audioFiles.length === 1) {
    assemblyTimeline.innerHTML = `
      <div class="assembly-track" style="flex: 1;">
        ${audioFiles[0].name}
      </div>
    `;
  } else {
    // Show each file proportionally (equal width for simplicity)
    audioFiles.forEach((file, index) => {
      const track = document.createElement('div');
      track.className = 'assembly-track';
      track.style.flex = '1';
      track.textContent = `${index + 1}. ${file.name}`;
      track.title = file.name;
      assemblyTimeline.appendChild(track);
    });
  }
}

async function selectBgMusic() {
  try {
    const selected = await open({
      multiple: false,
      filters: [{
        name: 'Audio',
        extensions: ['mp3']
      }]
    });

    if (selected) {
      bgMusicFile = selected as string;
      const fileName = bgMusicFile.split('/').pop() || bgMusicFile.split('\\').pop() || 'Unknown';

      // Show the file info and hide placeholder
      if (bgMusicPlaceholder && bgMusicInfo && bgMusicName && bgMusicOptions) {
        bgMusicPlaceholder.style.display = 'none';
        bgMusicInfo.style.display = 'flex';
        bgMusicName.textContent = fileName;
        bgMusicOptions.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('Error selecting background music:', error);
  }
}

function removeBgMusic() {
  bgMusicFile = null;

  // Hide file info and show placeholder
  if (bgMusicPlaceholder && bgMusicInfo && bgMusicOptions) {
    bgMusicPlaceholder.style.display = 'flex';
    bgMusicInfo.style.display = 'none';
    bgMusicOptions.style.display = 'none';
  }
}

async function convertToVideo() {
  // Check both legacy and timeline for audio
  const hasLegacyAudio = audioFiles.length > 0;
  const hasTimelineAudio = timeline.tracks.some(t => t.clips.length > 0);

  if (!selectedImage || (!hasLegacyAudio && !hasTimelineAudio)) return;

  // Show progress
  if (progressSection && resultSection) {
    progressSection.style.display = 'block';
    resultSection.style.display = 'none';
  }

  if (convertBtn) {
    convertBtn.disabled = true;
  }

  try {
    let result: string;

    // Use timeline-based export if we have timeline clips
    if (hasTimelineAudio) {
      // Prepare timeline data for Rust
      const timelineData = {
        tracks: timeline.tracks.map(track => ({
          clips: track.clips.map(clip => ({
            source_file: clip.sourceFile,
            start_time: clip.startTime,
            duration: clip.duration,
            trim_start: clip.trimStart,
            trim_end: clip.trimEnd
          })),
          volume: track.volume / 100.0
        }))
      };

      result = await invoke<string>('convert_timeline_to_video', {
        imagePath: selectedImage,
        timeline: timelineData,
        backgroundStyle: backgroundStyle,
        bgMusicPath: bgMusicFile,
        bgMusicVolume: bgMusicVolume,
        mainAudioVolume: mainAudioVolume
      });
    } else {
      // Fallback to legacy mode
      const audioPaths = audioFiles.map(f => f.path);

      result = await invoke<string>('convert_to_video', {
        imagePath: selectedImage,
        audioPaths: audioPaths,
        backgroundStyle: backgroundStyle,
        bgMusicPath: bgMusicFile,
        bgMusicVolume: bgMusicVolume,
        mainAudioVolume: mainAudioVolume
      });
    }

    lastGeneratedVideo = result;

    // Show success
    if (progressSection && resultSection && resultMessage) {
      progressSection.style.display = 'none';
      resultSection.style.display = 'block';
      resultMessage.textContent = `Video created successfully: ${result}`;

      // Show upload button and load current settings
      const uploadActions = document.querySelector('#upload-actions') as HTMLElement;
      if (uploadActions) {
        uploadActions.style.display = 'block';

        // Load current title and auto-upload settings into the main form
        const titleInput = document.querySelector('#video-title-main') as HTMLInputElement;
        const autoUploadCheck = document.querySelector('#auto-upload-main') as HTMLInputElement;
        if (titleInput) titleInput.value = videoTitle;
        if (autoUploadCheck) autoUploadCheck.checked = autoUpload;
      }
    }

    // Auto-upload if enabled
    if (autoUpload && vimeoToken) {
      await uploadToVimeo();
    }
  } catch (error) {
    console.error('Error converting:', error);

    if (progressSection && resultSection && resultMessage) {
      progressSection.style.display = 'none';
      resultSection.style.display = 'block';
      resultMessage.textContent = `Error: ${error}`;
    }
  } finally {
    if (convertBtn) {
      convertBtn.disabled = false;
    }
  }
}

async function uploadToVimeo() {
  if (!lastGeneratedVideo || !vimeoToken) {
    alert('Please set your Vimeo access token in Settings first');
    return;
  }

  // Get current values from main form
  const titleInput = document.querySelector('#video-title-main') as HTMLInputElement;
  const autoUploadCheck = document.querySelector('#auto-upload-main') as HTMLInputElement;

  if (titleInput) {
    videoTitle = titleInput.value;
    localStorage.setItem('videoTitle', videoTitle);
  }
  if (autoUploadCheck) {
    autoUpload = autoUploadCheck.checked;
    localStorage.setItem('autoUpload', String(autoUpload));
  }

  const uploadBtn = document.querySelector('#upload-vimeo-btn') as HTMLButtonElement;
  if (uploadBtn) {
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
  }

  try {
    const result = await invoke<string>('upload_to_vimeo', {
      videoPath: lastGeneratedVideo,
      accessToken: vimeoToken,
      title: videoTitle
    });

    if (resultMessage) {
      resultMessage.textContent = `Video uploaded to Vimeo successfully! ${result}`;
    }
  } catch (error) {
    console.error('Error uploading to Vimeo:', error);
    if (resultMessage) {
      resultMessage.textContent = `Vimeo upload failed: ${error}`;
    }
  } finally {
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        Upload to Vimeo
      `;
    }
  }
}

function openSettings() {
  const modal = document.querySelector('#settings-modal') as HTMLElement;
  if (modal) {
    modal.style.display = 'flex';

    // Load saved settings
    const tokenInput = document.querySelector('#vimeo-token') as HTMLInputElement;

    if (tokenInput) tokenInput.value = vimeoToken;
  }
}

function closeSettings() {
  const modal = document.querySelector('#settings-modal') as HTMLElement;
  if (modal) {
    modal.style.display = 'none';
  }
}

function saveSettings() {
  const tokenInput = document.querySelector('#vimeo-token') as HTMLInputElement;

  if (tokenInput) vimeoToken = tokenInput.value;

  // Save to localStorage
  localStorage.setItem('vimeoToken', vimeoToken);

  closeSettings();
  alert('Settings saved!');
}

function loadSettings() {
  const savedToken = localStorage.getItem('vimeoToken');
  const savedTitle = localStorage.getItem('videoTitle');
  const savedAutoUpload = localStorage.getItem('autoUpload');

  if (savedToken) vimeoToken = savedToken;
  if (savedTitle) videoTitle = savedTitle;
  if (savedAutoUpload) autoUpload = savedAutoUpload === 'true';
}

window.addEventListener("DOMContentLoaded", () => {
  // Load saved settings
  loadSettings();

  // Get DOM elements
  imageUploadArea = document.querySelector("#image-upload-area")!;
  imagePlaceholder = document.querySelector("#image-placeholder")!;
  imagePreview = document.querySelector("#image-preview")!;
  imageOptions = document.querySelector("#image-options")!;
  audioUploadArea = document.querySelector("#audio-upload-area")!;
  audioPlaylist = document.querySelector("#audio-playlist")!;
  convertBtn = document.querySelector("#convert-btn")!;
  progressSection = document.querySelector("#progress-section")!;
  resultSection = document.querySelector("#result-section")!;
  resultMessage = document.querySelector("#result-message")!;
  backgroundStyleSelect = document.querySelector("#background-style")!;
  bgMusicUploadArea = document.querySelector("#bgmusic-upload-area")!;
  bgMusicPlaceholder = document.querySelector("#bgmusic-placeholder")!;
  bgMusicInfo = document.querySelector("#bgmusic-info")!;
  bgMusicName = document.querySelector("#bgmusic-name")!;
  bgMusicRemove = document.querySelector("#bgmusic-remove")!;
  bgMusicOptions = document.querySelector("#bgmusic-options")!;
  bgMusicVolumeSlider = document.querySelector("#bgmusic-volume")!;
  volumeValue = document.querySelector("#volume-value")!;
  audioVolumeControl = document.querySelector("#audio-volume-control")!;
  audioVolumeSlider = document.querySelector("#audio-volume")!;
  audioVolumeValue = document.querySelector("#audio-volume-value")!;
  assemblyPreview = document.querySelector("#assembly-preview")!;
  assemblyTimeline = document.querySelector("#assembly-timeline")!;

  // Timeline elements
  timelineContainer = document.querySelector("#timeline-container")!;
  timelineRuler = document.querySelector("#timeline-ruler")!;
  timelineTracks = document.querySelector("#timeline-tracks")!;
  timelinePlayhead = document.querySelector("#timeline-playhead")!;
  zoomInBtn = document.querySelector("#zoom-in")!;
  zoomOutBtn = document.querySelector("#zoom-out")!;
  zoomLevelSpan = document.querySelector("#zoom-level")!;

  // Event listeners
  imageUploadArea?.addEventListener('click', selectImage);
  audioUploadArea?.addEventListener('click', selectAudio);
  convertBtn?.addEventListener('click', convertToVideo);

  backgroundStyleSelect?.addEventListener('change', (e) => {
    backgroundStyle = (e.target as HTMLSelectElement).value;
  });

  // Background music listeners
  bgMusicUploadArea?.addEventListener('click', selectBgMusic);
  bgMusicRemove?.addEventListener('click', (e) => {
    e.stopPropagation();
    removeBgMusic();
  });

  bgMusicVolumeSlider?.addEventListener('input', (e) => {
    bgMusicVolume = parseInt((e.target as HTMLInputElement).value);
    if (volumeValue) {
      volumeValue.textContent = bgMusicVolume.toString();
    }
  });

  audioVolumeSlider?.addEventListener('input', (e) => {
    mainAudioVolume = parseInt((e.target as HTMLInputElement).value);
    if (audioVolumeValue) {
      audioVolumeValue.textContent = mainAudioVolume.toString();
    }
  });

  // Settings modal listeners
  document.querySelector('#settings-btn')?.addEventListener('click', openSettings);
  document.querySelector('#close-modal')?.addEventListener('click', closeSettings);
  document.querySelector('#save-settings')?.addEventListener('click', saveSettings);

  // Vimeo upload listener
  document.querySelector('#upload-vimeo-btn')?.addEventListener('click', uploadToVimeo);

  // Close modal when clicking outside
  document.querySelector('#settings-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      closeSettings();
    }
  });

  // Timeline zoom controls
  zoomInBtn?.addEventListener('click', zoomIn);
  zoomOutBtn?.addEventListener('click', zoomOut);

  // Global mouse event listeners for drag and trim
  document.addEventListener('mousemove', (e) => {
    if (dragState && dragState.isDragging) {
      updateDrag(e.clientX);
    } else if (trimState && trimState.isTrimming) {
      updateTrim(e.clientX);
    }
  });

  document.addEventListener('mouseup', () => {
    if (dragState && dragState.isDragging) {
      endDrag();
    } else if (trimState && trimState.isTrimming) {
      endTrim();
    }
  });

  // Playback controls
  timelinePlayBtn = document.querySelector('#timeline-play')!;
  timelineTimeDisplay = document.querySelector('#timeline-time')!;

  timelinePlayBtn?.addEventListener('click', togglePlayPause);
  timelineRuler?.addEventListener('click', handleRulerClick);

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboardShortcuts);

  // Initialize time display
  updateTimeDisplay();
});
