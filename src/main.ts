import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  mode?: 'single' | 'random'; // Random mode for random file selection
  randomPool?: string[]; // Pool of file paths for random selection
  currentRandomFile?: string; // Currently selected random file
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

// Timeline audio playback
let timelineAudioElements: Map<string, HTMLAudioElement> = new Map();
let activeTimelineClips: Set<string> = new Set();

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

// Simplified drag state
interface DragState {
  clipId: string;
  trackId: string;
  originalStartTime: number;
  isDragging: boolean;
  timelineLeft: number; // Left edge of timeline in viewport coordinates
  mouseOffset: number; // Offset from clip's left edge where user grabbed (in seconds)
}
let dragState: DragState | null = null;

// Simple snapping
let snapEnabled = true; // Toggle with 'S' key
const SNAP_DISTANCE_PX = 10; // Snap when within 10 pixels of a snap point

// Clipboard for copy/paste
let clipboardClip: Clip | null = null;

// Selected clip
let selectedClip: { clip: Clip, track: Track } | null = null;

// Snap indicator element
let snapIndicatorElement: HTMLElement | null = null;

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
let splitClipBtn: HTMLButtonElement;
let imageUploadArea: HTMLElement;
let imagePlaceholder: HTMLElement;
let imagePreview: HTMLImageElement;
let imageOptions: HTMLElement;
let audioUploadArea: HTMLElement;
let audioPlaylist: HTMLElement;
let convertBtn: HTMLButtonElement;
let progressSection: HTMLElement;
let progressBar: HTMLElement;
let progressText: HTMLElement;
let progressDetails: HTMLElement;
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
// Toast Notification System
// ============================================================================

let toastContainer: HTMLElement | null = null;

function initToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

function showToast(message: string, type: 'error' | 'warning' | 'success' | 'info' = 'info', duration = 3000) {
  initToastContainer();
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  // Icon based on type
  let iconSvg = '';
  switch (type) {
    case 'error':
      iconSvg = `<svg class="toast-icon toast-error" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
      </svg>`;
      break;
    case 'warning':
      iconSvg = `<svg class="toast-icon toast-warning" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
      </svg>`;
      break;
    case 'success':
      iconSvg = `<svg class="toast-icon toast-success" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
      </svg>`;
      break;
    case 'info':
      iconSvg = `<svg class="toast-icon toast-info" viewBox="0 0 20 20" fill="currentColor">
        <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/>
      </svg>`;
      break;
  }

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-message">${message}</div>
  `;

  toastContainer.appendChild(toast);

  // Auto-dismiss after duration
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, duration);
}

// ============================================================================
// Timeline Utility Functions
// ============================================================================

function generateClipId(): string {
  return `clip-${nextClipId++}`;
}

function generateTrackId(): string {
  return `track-${nextTrackId++}`;
}

// Cryptographically secure unbiased random selection
function selectRandomFile(files: string[]): string {
  if (files.length === 0) {
    throw new Error('Cannot select from empty array');
  }
  if (files.length === 1) {
    return files[0];
  }
  const randomValues = new Uint32Array(1);
  crypto.getRandomValues(randomValues);
  const randomIndex = randomValues[0] % files.length;
  return files[randomIndex];
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

function removeTrack(trackId: string): void {
  const trackIndex = timeline.tracks.findIndex(t => t.id === trackId);
  if (trackIndex === -1) {
    console.warn('Track not found:', trackId);
    return;
  }

  const track = timeline.tracks[trackIndex];

  // Stop and clean up any playing audio from this track's clips
  for (const clip of track.clips) {
    const audio = timelineAudioElements.get(clip.id);
    if (audio) {
      audio.pause();
      audio.src = '';
      timelineAudioElements.delete(clip.id);
    }
  }

  // Remove the track from the timeline
  timeline.tracks.splice(trackIndex, 1);

  // Re-render the timeline
  renderTimeline();
  updateConvertButton();
  updateVideoPreview();

  console.log(`Track removed: ${track.name}`);
}

function rerollRandomTrack(trackId: string): void {
  const track = timeline.tracks.find(t => t.id === trackId);
  if (!track || track.mode !== 'random' || !track.randomPool || track.randomPool.length === 0) {
    console.warn('Cannot reroll: track not found or not in random mode');
    return;
  }

  // Select a new random file
  const newFile = selectRandomFile(track.randomPool);
  const fileName = newFile.split('/').pop() || newFile.split('\\').pop() || 'Unknown';

  track.currentRandomFile = newFile;

  // Update the clip to use the new file
  if (track.clips.length > 0) {
    const clip = track.clips[0]; // Random tracks have exactly one clip

    // Stop any currently playing audio for this clip
    const audio = timelineAudioElements.get(clip.id);
    if (audio) {
      audio.pause();
      audio.src = '';
      timelineAudioElements.delete(clip.id);
    }

    // Update clip with new file
    clip.sourceFile = newFile;
    clip.sourceName = fileName;
  }

  console.log(`Rerolled random track "${track.name}" to: ${fileName}`);

  // Re-render timeline to show the new file
  renderTimeline();
  updateVideoPreview();
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
// Edge Scrolling System
// ============================================================================

interface EdgeScrollState {
  animationFrame: number | null;
  lastTimestamp: number;
  currentVelocity: number;
  mouseX: number;
}

let edgeScrollState: EdgeScrollState = {
  animationFrame: null,
  lastTimestamp: 0,
  currentVelocity: 0,
  mouseX: 0
};

const EDGE_SCROLL_CONFIG = {
  edgeZone: 80,           // Distance from edge to trigger scrolling (px)
  minSpeed: 150,          // Minimum scroll speed (px/s)
  maxSpeed: 1000,         // Maximum scroll speed (px/s)
  acceleration: 0.15,     // How quickly speed ramps up (0-1)
  deceleration: 0.25      // How quickly speed ramps down (0-1)
};

function calculateEdgeScrollVelocity(mouseX: number, containerRect: DOMRect): number {
  const leftEdge = containerRect.left + EDGE_SCROLL_CONFIG.edgeZone;
  const rightEdge = containerRect.right - EDGE_SCROLL_CONFIG.edgeZone;

  // Check if mouse is in left edge zone
  if (mouseX < leftEdge) {
    const distanceIntoZone = leftEdge - mouseX;
    const intensity = Math.min(1, distanceIntoZone / EDGE_SCROLL_CONFIG.edgeZone);
    const targetSpeed = -(EDGE_SCROLL_CONFIG.minSpeed + (EDGE_SCROLL_CONFIG.maxSpeed - EDGE_SCROLL_CONFIG.minSpeed) * intensity);
    return targetSpeed;
  }

  // Check if mouse is in right edge zone
  if (mouseX > rightEdge) {
    const distanceIntoZone = mouseX - rightEdge;
    const intensity = Math.min(1, distanceIntoZone / EDGE_SCROLL_CONFIG.edgeZone);
    const targetSpeed = EDGE_SCROLL_CONFIG.minSpeed + (EDGE_SCROLL_CONFIG.maxSpeed - EDGE_SCROLL_CONFIG.minSpeed) * intensity;
    return targetSpeed;
  }

  return 0; // No scrolling
}

function smoothLerp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

function startEdgeScrolling(mouseX: number) {
  if (!timelineContainer) return;

  // Update stored mouse position
  edgeScrollState.mouseX = mouseX;

  const containerRect = timelineContainer.getBoundingClientRect();
  const targetVelocity = calculateEdgeScrollVelocity(mouseX, containerRect);

  // If we're not in an edge zone and not currently scrolling, don't start
  if (targetVelocity === 0 && edgeScrollState.currentVelocity === 0) {
    return;
  }

  // If already animating, the loop will handle velocity changes
  if (edgeScrollState.animationFrame !== null) {
    return;
  }

  const animate = (timestamp: number) => {
    if (!timelineContainer) {
      stopEdgeScrolling();
      return;
    }

    // Calculate delta time
    if (edgeScrollState.lastTimestamp === 0) {
      edgeScrollState.lastTimestamp = timestamp;
    }
    const deltaTime = (timestamp - edgeScrollState.lastTimestamp) / 1000; // Convert to seconds
    edgeScrollState.lastTimestamp = timestamp;

    // Get current target velocity using stored mouse position
    const containerRect = timelineContainer.getBoundingClientRect();
    const targetVelocity = calculateEdgeScrollVelocity(edgeScrollState.mouseX, containerRect);

    // Smoothly interpolate to target velocity
    const factor = targetVelocity === 0 ? EDGE_SCROLL_CONFIG.deceleration : EDGE_SCROLL_CONFIG.acceleration;
    edgeScrollState.currentVelocity = smoothLerp(edgeScrollState.currentVelocity, targetVelocity, factor);

    // Stop if velocity is very close to zero
    if (Math.abs(edgeScrollState.currentVelocity) < 1 && targetVelocity === 0) {
      stopEdgeScrolling();
      return;
    }

    // Apply scroll
    const scrollAmount = edgeScrollState.currentVelocity * deltaTime;
    timelineContainer.scrollLeft += scrollAmount;

    // Continue animation
    edgeScrollState.animationFrame = requestAnimationFrame(animate);
  };

  edgeScrollState.animationFrame = requestAnimationFrame(animate);
}

function stopEdgeScrolling() {
  if (edgeScrollState.animationFrame !== null) {
    cancelAnimationFrame(edgeScrollState.animationFrame);
    edgeScrollState.animationFrame = null;
  }
  edgeScrollState.lastTimestamp = 0;
  edgeScrollState.currentVelocity = 0;
  edgeScrollState.mouseX = 0;
}

// ============================================================================
// Drag & Drop Functions
// ============================================================================

function snapToGrid(time: number, snapInterval: number): number {
  return Math.round(time / snapInterval) * snapInterval;
}

// Find nearby clip edges for magnetic snapping
// Simple snapping: get all snap points (other clips + playhead + grid)
function getSnapPoints(trackId: string, excludeClipId: string): number[] {
  const snapPoints: number[] = [];

  // Add playhead position
  snapPoints.push(timeline.playheadPosition);

  // Add all clip edges on this track
  const track = getTrackById(trackId);
  if (track) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      snapPoints.push(clip.startTime);
      snapPoints.push(clip.startTime + clip.duration);
    }
  }

  // Add grid markers (every second)
  const duration = _getTotalTimelineDuration();
  for (let i = 0; i <= duration; i++) {
    snapPoints.push(i);
  }

  return snapPoints;
}

// Find closest snap point within snap distance
function applySnapping(time: number, trackId: string, excludeClipId: string): { snappedTime: number; snapPoint: number | null } {
  if (!snapEnabled) {
    return { snappedTime: time, snapPoint: null };
  }

  const snapPoints = getSnapPoints(trackId, excludeClipId);
  const snapDistanceTime = SNAP_DISTANCE_PX / pixelsPerSecond;

  let closestPoint: number | null = null;
  let closestDistance = Infinity;

  for (const point of snapPoints) {
    const distance = Math.abs(time - point);
    if (distance < snapDistanceTime && distance < closestDistance) {
      closestPoint = point;
      closestDistance = distance;
    }
  }

  if (closestPoint !== null) {
    return { snappedTime: closestPoint, snapPoint: closestPoint };
  }

  return { snappedTime: time, snapPoint: null };
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

  const clipEl = document.querySelector(`[data-clip-id="${clipId}"]`) as HTMLElement;
  if (!clipEl) return;

  const clipRect = clipEl.getBoundingClientRect();

  // Calculate where within the clip the user grabbed (in seconds)
  const grabOffsetPx = mouseX - clipRect.left;
  const mouseOffset = grabOffsetPx / pixelsPerSecond;

  dragState = {
    clipId,
    trackId,
    originalStartTime: clip.startTime,
    isDragging: true,
    timelineLeft: clipRect.left - (clip.startTime * pixelsPerSecond), // Calculate timeline's left edge from clip position
    mouseOffset: mouseOffset
  };

  // Add dragging class for visual feedback
  clipEl.classList.add('dragging');
}

function updateDrag(mouseX: number) {
  if (!dragState || !dragState.isDragging) return;

  const clip = _getClipById(dragState.clipId);
  if (!clip) return;

  const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`) as HTMLElement;
  if (!clipEl) return;

  // 1. Direct pixel-to-time conversion, accounting for where user grabbed
  const timelineRelativeX = mouseX - dragState.timelineLeft;
  let newStartTime = (timelineRelativeX / pixelsPerSecond) - dragState.mouseOffset;

  // 2. Clamp to valid range
  newStartTime = Math.max(0, newStartTime);

  // 3. Apply snapping
  const snapResult = applySnapping(newStartTime, dragState.trackId, clip.id);
  newStartTime = snapResult.snappedTime;

  // 4. Check for overlaps with other clips
  const track = getTrackById(dragState.trackId);
  let hasOverlap = false;
  if (track) {
    const draggedEnd = newStartTime + clip.duration;
    for (const otherClip of track.clips) {
      if (otherClip.id === clip.id) continue;
      const otherEnd = otherClip.startTime + otherClip.duration;
      if (!(draggedEnd <= otherClip.startTime || newStartTime >= otherEnd)) {
        hasOverlap = true;
        break;
      }
    }
  }

  // 5. Update visual position
  const deltaX = (newStartTime - dragState.originalStartTime) * pixelsPerSecond;
  clipEl.style.transform = `translateX(${deltaX}px)`;
  clipEl.style.opacity = '0.8';

  // 6. Visual feedback for snapping and overlaps
  if (snapResult.snapPoint !== null) {
    clipEl.classList.add('snapped');
    showSnapIndicator(snapResult.snapPoint);
  } else {
    clipEl.classList.remove('snapped');
    hideSnapIndicator();
  }

  if (hasOverlap) {
    clipEl.classList.add('overlapping');
  } else {
    clipEl.classList.remove('overlapping');
  }
}

function endDrag() {
  if (!dragState) return;

  const clip = _getClipById(dragState.clipId);
  const clipEl = document.querySelector(`[data-clip-id="${dragState.clipId}"]`) as HTMLElement;

  if (clip && clipEl) {
    // Get the current transform to determine final position
    const transform = clipEl.style.transform;
    const translateMatch = transform.match(/translateX\(([^)]+)px\)/);

    if (translateMatch) {
      const translateX = parseFloat(translateMatch[1]);
      const newStartTime = dragState.originalStartTime + (translateX / pixelsPerSecond);
      clip.startTime = Math.max(0, newStartTime);
    }

    // Clean up styles
    clipEl.style.transform = '';
    clipEl.style.opacity = '';
    clipEl.classList.remove('dragging', 'snapped', 'overlapping');
  }

  hideSnapIndicator();
  dragState = null;

  // Re-render timeline
  renderTimeline();
}

// Show visual snap indicator line
function showSnapIndicator(snapTime: number) {
  if (!snapIndicatorElement) {
    snapIndicatorElement = document.createElement('div');
    snapIndicatorElement.className = 'snap-indicator';
    document.getElementById('timeline-container')?.appendChild(snapIndicatorElement);
  }

  const TIMELINE_PADDING_LEFT = 216;
  const left = TIMELINE_PADDING_LEFT + (snapTime * pixelsPerSecond);
  snapIndicatorElement.style.left = `${left}px`;
  snapIndicatorElement.style.display = 'block';
}

function hideSnapIndicator() {
  if (snapIndicatorElement) {
    snapIndicatorElement.style.display = 'none';
  }
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
  updateSplitButtonState();
}

function updateTimeDisplay() {
  if (timelineTimeDisplay) {
    timelineTimeDisplay.textContent = formatTime(timeline.playheadPosition);
  }
}

function updateSplitButtonState() {
  if (!splitClipBtn) return;

  const result = findClipAtPlayhead();
  if (result) {
    const { clip } = result;
    const relativeTime = timeline.playheadPosition - clip.startTime;
    // Enable if within valid split range (not too close to edges)
    const canSplit = relativeTime > 0.1 && relativeTime < clip.duration - 0.1;
    splitClipBtn.disabled = !canSplit;
  } else {
    splitClipBtn.disabled = true;
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

  // Stop all timeline audio
  timelineAudioElements.forEach((audio) => {
    audio.pause();
  });
  activeTimelineClips.clear();

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
  updateTimelineAudio(currentTime);

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

function updateTimelineAudio(currentTime: number) {
  const newActiveClips = new Set<string>();

  // Find all clips that should be playing at current time
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const clipStart = clip.startTime;
      const clipEnd = clip.startTime + clip.duration;

      if (currentTime >= clipStart && currentTime < clipEnd) {
        newActiveClips.add(clip.id);

        // Get or create audio element for this clip
        let audio = timelineAudioElements.get(clip.id);
        if (!audio) {
          audio = new Audio(convertFileSrc(clip.sourceFile));
          audio.volume = (track.volume / 100) * (mainAudioVolume / 100);
          timelineAudioElements.set(clip.id, audio);
        } else {
          // Update volume for existing audio elements (track volume * main volume)
          audio.volume = (track.volume / 100) * (mainAudioVolume / 100);
        }

        // If this clip wasn't playing before, start it
        if (!activeTimelineClips.has(clip.id)) {
          const relativeTime = currentTime - clipStart;
          audio.currentTime = relativeTime;
          audio.play().catch(err => {
            console.error('Error playing clip audio:', err);
          });
        }
      }
    }
  }

  // Stop clips that are no longer active
  for (const clipId of activeTimelineClips) {
    if (!newActiveClips.has(clipId)) {
      const audio = timelineAudioElements.get(clipId);
      if (audio) {
        audio.pause();
      }
    }
  }

  activeTimelineClips = newActiveClips;
}

function handleRulerClick(e: MouseEvent) {
  const ruler = e.currentTarget as HTMLElement;
  const rect = ruler.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  // Ruler is in the content area (after padding), so clickX is already
  // in the correct coordinate system. No offset needed here.
  const time = clickX / pixelsPerSecond;

  setPlayheadPosition(time);
}

// Playhead dragging
let playheadDragging = false;
let playheadDragStartX = 0;

function startPlayheadDrag(e: MouseEvent) {
  playheadDragging = true;
  playheadDragStartX = e.clientX;
  e.preventDefault();
  e.stopPropagation();
}

function updatePlayheadDrag(e: MouseEvent) {
  if (!playheadDragging) return;

  const ruler = timelineRuler;
  if (!ruler) return;

  const rect = ruler.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  // Ruler is in the content area (after padding), so mouseX is already
  // in the correct coordinate system. No offset needed here.
  const time = Math.max(0, mouseX / pixelsPerSecond);

  setPlayheadPosition(time);
}

function endPlayheadDrag() {
  playheadDragging = false;
}

function handleKeyboardShortcuts(e: KeyboardEvent) {
  // Don't trigger if typing in an input
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
    return;
  }

  // Handle Ctrl/Cmd shortcuts
  const isMod = e.ctrlKey || e.metaKey;

  if (isMod && e.key === 'c') {
    e.preventDefault();
    copyClipAtPlayhead();
    return;
  }

  if (isMod && e.key === 'v') {
    e.preventDefault();
    pasteClipAtPlayhead();
    return;
  }

  if (isMod && e.key === 'd') {
    e.preventDefault();
    duplicateClipAtPlayhead();
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
      if (e.shiftKey) {
        // Shift+S: Split clip
        splitClipAtPlayhead();
      } else {
        // S: Toggle snapping
        snapEnabled = !snapEnabled;
        console.log('Snapping:', snapEnabled ? 'ON' : 'OFF');
        // Show notification
        const notification = document.createElement('div');
        notification.className = 'snap-notification';
        notification.textContent = `Snapping ${snapEnabled ? 'ON' : 'OFF'}`;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 1000);
      }
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
// Clip Selection Functions
// ============================================================================

function selectClip(clipId: string) {
  // Find the clip and track
  for (const track of timeline.tracks) {
    const clip = track.clips.find(c => c.id === clipId);
    if (clip) {
      selectedClip = { clip, track };
      renderTimeline(); // Re-render to show selection
      console.log('Selected clip:', clip.sourceName);
      return;
    }
  }
}

function deselectClip() {
  selectedClip = null;
  renderTimeline(); // Re-render to remove selection
}

function getSelectedOrPlayheadClip(): { clip: Clip, track: Track } | null {
  // Prefer selected clip, fallback to playhead
  if (selectedClip) {
    return selectedClip;
  }
  return findClipAtPlayhead();
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
  const splitTime = timeline.playheadPosition;
  let clipsToSplit: { clip: Clip, track: Track }[] = [];

  // Find ALL clips at playhead position across ALL tracks
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (splitTime >= clip.startTime && splitTime < clip.startTime + clip.duration) {
        const relativeTime = splitTime - clip.startTime;
        // Only split if not too close to edges
        if (relativeTime > 0.1 && relativeTime < clip.duration - 0.1) {
          clipsToSplit.push({ clip, track });
        }
      }
    }
  }

  if (clipsToSplit.length === 0) {
    showToast('No clips at playhead position to split, or playhead too close to clip edges.', 'warning');
    return;
  }

  // Split all clips at playhead
  for (const { clip, track } of clipsToSplit) {
    const relativeTime = splitTime - clip.startTime;

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
  }

  // Re-render timeline
  renderTimeline();

  // Show success message
  const trackWord = clipsToSplit.length === 1 ? 'clip' : `${clipsToSplit.length} clips`;
  showToast(`Split ${trackWord} at ${formatTime(splitTime)}`, 'success', 2000);
}

function deleteClipAtPlayhead() {
  const result = getSelectedOrPlayheadClip();
  if (!result) {
    showToast('No clip selected or at playhead position', 'warning');
    return;
  }

  const { clip, track } = result;
  const index = track.clips.indexOf(clip);
  if (index !== -1) {
    track.clips.splice(index, 1);
  }

  // Clear selection since clip is deleted
  if (selectedClip && selectedClip.clip.id === clip.id) {
    selectedClip = null;
  }

  renderTimeline();
}

function rippleDeleteClipAtPlayhead() {
  const result = getSelectedOrPlayheadClip();
  if (!result) {
    showToast('No clip selected or at playhead position', 'warning');
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

  // Clear selection since clip is deleted
  if (selectedClip && selectedClip.clip.id === clip.id) {
    selectedClip = null;
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

  showToast('No gap at playhead position', 'warning');
}

function copyClipAtPlayhead() {
  const result = getSelectedOrPlayheadClip();
  if (!result) {
    showToast('No clip selected or at playhead position', 'warning');
    return;
  }

  const { clip } = result;

  // Deep clone the clip for clipboard
  clipboardClip = {
    id: clip.id, // Will be replaced with new ID on paste
    sourceFile: clip.sourceFile,
    sourceName: clip.sourceName,
    trackId: clip.trackId, // Will be updated on paste
    startTime: clip.startTime, // Will be updated on paste
    duration: clip.duration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    sourceDuration: clip.sourceDuration
  };

  showToast(`Copied clip: ${clip.sourceName}`, 'success', 2000);
  console.log('Clip copied to clipboard:', clipboardClip);
}

function pasteClipAtPlayhead() {
  if (!clipboardClip) {
    showToast('No clip in clipboard', 'warning');
    return;
  }

  // Find the track at playhead - default to first track if none found
  let targetTrack: Track | null = null;
  const result = findClipAtPlayhead();

  if (result) {
    targetTrack = result.track;
  } else if (timeline.tracks.length > 0) {
    targetTrack = timeline.tracks[0];
  } else {
    showToast('No track available to paste clip', 'error');
    return;
  }

  // Create new clip at playhead position
  const newClip: Clip = {
    id: generateClipId(),
    sourceFile: clipboardClip.sourceFile,
    sourceName: clipboardClip.sourceName,
    trackId: targetTrack.id,
    startTime: timeline.playheadPosition,
    duration: clipboardClip.duration,
    trimStart: clipboardClip.trimStart,
    trimEnd: clipboardClip.trimEnd,
    sourceDuration: clipboardClip.sourceDuration
  };

  // Add the clip to the track
  targetTrack.clips.push(newClip);

  // Generate waveform for the new clip
  generateWaveformData(newClip.sourceFile).then(() => {
    renderTimeline();
  });

  // Render the timeline first to create the DOM element
  renderTimeline();

  // Now immediately start dragging the new clip so user can position it
  const timelineRect = timelineTracks?.getBoundingClientRect();
  if (timelineRect) {
    const TIMELINE_PADDING_LEFT = 216;
    const mouseX = timelineRect.left + TIMELINE_PADDING_LEFT + (timeline.playheadPosition * pixelsPerSecond);

    // Small delay to ensure DOM is ready
    setTimeout(() => {
      startDrag(newClip.id, targetTrack.id, mouseX);
      showToast(`Pasting ${newClip.sourceName} - move cursor and click to place`, 'info', 2000);
    }, 10);
  } else {
    showToast(`Pasted clip: ${newClip.sourceName}`, 'success', 2000);
  }

  console.log('Clip pasted and ready to position:', newClip);
}

function duplicateClipAtPlayhead() {
  const result = getSelectedOrPlayheadClip();
  if (!result) {
    showToast('No clip selected or at playhead position', 'warning');
    return;
  }

  const { clip, track } = result;

  // Create duplicate at playhead position (or slightly after original if playhead is over it)
  let newStartTime = timeline.playheadPosition;

  // If playhead is over the original clip, place duplicate right after it
  if (newStartTime >= clip.startTime && newStartTime < clip.startTime + clip.duration) {
    newStartTime = clip.startTime + clip.duration;
  }

  const newClip: Clip = {
    id: generateClipId(),
    sourceFile: clip.sourceFile,
    sourceName: clip.sourceName,
    trackId: clip.trackId,
    startTime: newStartTime,
    duration: clip.duration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    sourceDuration: clip.sourceDuration
  };

  // Add the clip to the track
  track.clips.push(newClip);

  // Render the timeline first to create the DOM element
  renderTimeline();

  // Now immediately start dragging the new clip so user can position it
  // We need to simulate a mouse position at the playhead
  const timelineRect = timelineTracks?.getBoundingClientRect();
  if (timelineRect) {
    const TIMELINE_PADDING_LEFT = 216;
    const mouseX = timelineRect.left + TIMELINE_PADDING_LEFT + (newStartTime * pixelsPerSecond);

    // Small delay to ensure DOM is ready
    setTimeout(() => {
      startDrag(newClip.id, track.id, mouseX);
      showToast(`Duplicating ${newClip.sourceName} - position and click to place`, 'info', 2000);
    }, 10);
  } else {
    showToast(`Duplicated clip: ${newClip.sourceName}`, 'success', 2000);
  }

  console.log('Clip duplicated and ready to position:', newClip);
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

  // Add hover split preview (but not if playhead is already over this clip)
  const playheadIsOverClip = timeline.playheadPosition >= clip.startTime &&
                             timeline.playheadPosition < clip.startTime + clip.duration;

  if (!playheadIsOverClip) {
    const hoverSplitPreview = document.createElement('div');
    hoverSplitPreview.className = 'clip-hover-split-preview';
    clipEl.appendChild(hoverSplitPreview);

    // Update hover preview position on mouse move
    clipEl.addEventListener('mousemove', (e) => {
      const rect = clipEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const relativeTime = mouseX / pixelsPerSecond;

      // Check if within valid split range (not too close to edges)
      if (relativeTime > 0.1 && relativeTime < clip.duration - 0.1) {
        hoverSplitPreview.style.left = `${mouseX}px`;
        hoverSplitPreview.style.opacity = '1';
      } else {
        hoverSplitPreview.style.opacity = '0.3';
      }
    });
  }

  // Add drag event listeners (on clip body, not handles)
  clipEl.addEventListener('mousedown', (e) => {
    console.log('Clip mousedown event fired!', clip.sourceName);
    // Don't start drag if clicking on a handle
    if ((e.target as HTMLElement).classList.contains('timeline-clip-trim-handle')) {
      console.log('Ignoring - clicked on trim handle');
      return;
    }
    e.preventDefault();

    // Select the clip
    selectClip(clip.id);

    console.log('Starting drag for clip:', clip.id);
    startDrag(clip.id, clip.trackId, e.clientX);
  });

  // Highlight if selected
  if (selectedClip && selectedClip.clip.id === clip.id) {
    clipEl.classList.add('clip-selected');
  }

  // Highlight if playhead is over this clip
  if (timeline.playheadPosition >= clip.startTime &&
      timeline.playheadPosition < clip.startTime + clip.duration) {
    clipEl.classList.add('clip-at-playhead');

    // Add split line indicator - position it at the playhead's absolute position
    const splitIndicator = document.createElement('div');
    splitIndicator.className = 'clip-split-indicator';
    // Calculate position relative to the clip (both in same coordinate system now)
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

  // Track name
  const trackName = document.createElement('span');
  trackName.className = 'timeline-track-name';
  trackName.textContent = track.name;
  trackHeader.appendChild(trackName);

  // Volume control container
  const volumeControl = document.createElement('div');
  volumeControl.className = 'timeline-track-volume';

  // Volume button with icon
  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'timeline-track-volume-btn';
  volumeBtn.title = `Volume: ${track.volume}%`;
  volumeBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
    </svg>
  `;

  // Volume slider popup
  const volumePopup = document.createElement('div');
  volumePopup.className = 'timeline-track-volume-popup';

  // Volume value display at top
  const volumeValue = document.createElement('span');
  volumeValue.className = 'timeline-track-volume-value';
  volumeValue.textContent = `${track.volume}%`;
  volumePopup.appendChild(volumeValue);

  // Vertical slider
  const volumeSlider = document.createElement('input');
  volumeSlider.type = 'range';
  volumeSlider.min = '0';
  volumeSlider.max = '100';
  volumeSlider.value = String(track.volume);
  volumeSlider.className = 'timeline-track-volume-slider';
  volumeSlider.orient = 'vertical'; // For Firefox
  volumeSlider.addEventListener('input', (e) => {
    const newVolume = Number((e.target as HTMLInputElement).value);
    track.volume = newVolume;
    volumeValue.textContent = `${newVolume}%`;
    volumeBtn.title = `Volume: ${newVolume}%`;

    // Update all playing clips from this track
    for (const clip of track.clips) {
      const audio = timelineAudioElements.get(clip.id);
      if (audio) {
        audio.volume = (newVolume / 100) * (mainAudioVolume / 100);
      }
    }
  });
  volumePopup.appendChild(volumeSlider);

  volumeControl.appendChild(volumeBtn);
  volumeControl.appendChild(volumePopup);

  // Toggle popup on click
  volumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    volumePopup.classList.toggle('visible');
  });

  // Close popup when clicking outside
  document.addEventListener('click', (e) => {
    if (!volumeControl.contains(e.target as Node)) {
      volumePopup.classList.remove('visible');
    }
  });

  trackHeader.appendChild(volumeControl);

  // Add clip button (not shown for random tracks)
  if (track.mode !== 'random') {
    const addClipBtn = document.createElement('button');
    addClipBtn.className = 'timeline-track-add-btn';
    addClipBtn.title = 'Add audio clip to this track';
    addClipBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    `;
    addClipBtn.addEventListener('click', () => {
      selectAudioForTrack(track.id);
    });
    trackHeader.appendChild(addClipBtn);
  }

  // Shuffle button for random tracks
  if (track.mode === 'random' && track.randomPool && track.randomPool.length > 1) {
    const shuffleBtn = document.createElement('button');
    shuffleBtn.className = 'timeline-track-shuffle-btn';
    shuffleBtn.title = `Reroll random file (${track.randomPool.length} files in pool)`;
    shuffleBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>
      </svg>
    `;
    shuffleBtn.addEventListener('click', () => {
      rerollRandomTrack(track.id);
    });
    trackHeader.appendChild(shuffleBtn);
  }

  // Delete track button
  const deleteTrackBtn = document.createElement('button');
  deleteTrackBtn.className = 'timeline-track-delete-btn';
  deleteTrackBtn.title = 'Delete this track';
  deleteTrackBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  `;
  deleteTrackBtn.addEventListener('click', () => {
    removeTrack(track.id);
  });
  trackHeader.appendChild(deleteTrackBtn);

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

  // Show timeline, hide upload area and legacy playlist
  timelineContainer.style.display = 'block';
  if (audioUploadArea) audioUploadArea.style.display = 'none';
  if (audioPlaylist) audioPlaylist.style.display = 'none';

  // Clear existing tracks
  timelineTracks.innerHTML = '';

  // Calculate total duration
  const duration = _getTotalTimelineDuration() || 60;
  const totalWidth = duration * pixelsPerSecond;

  // Render ruler
  renderTimelineRuler(duration);

  // Set tracks container width to match ruler
  timelineTracks.style.width = `${totalWidth}px`;

  // Render each track
  timeline.tracks.forEach(track => {
    const trackEl = renderTrack(track);
    timelineTracks.appendChild(trackEl);
  });

  // Add "Add Track" button
  const addTrackBtn = document.createElement('button');
  addTrackBtn.className = 'timeline-add-track-btn';
  addTrackBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
    <span>Add Track</span>
  `;
  addTrackBtn.addEventListener('click', async () => {
    await addNewTrackWithFiles();
  });
  timelineTracks.appendChild(addTrackBtn);

  // Update playhead position
  updatePlayheadPosition();
}

function updatePlayheadPosition() {
  if (!timelinePlayhead) return;
  // CRITICAL: Timeline container has padding-left for track headers.
  // Ruler and track-content flow within this padding (content box).
  // Playhead is absolutely positioned, so we must add the padding offset
  // to align with ruler markers and clip positions.
  const TIMELINE_PADDING_LEFT = 216; // calc(1rem + 200px) = 16px + 200px
  timelinePlayhead.style.left = `${TIMELINE_PADDING_LEFT + (timeline.playheadPosition * pixelsPerSecond)}px`;
  timelinePlayhead.setAttribute('data-time', formatTime(timeline.playheadPosition));

  // Create draggable handle if it doesn't exist
  let handle = timelinePlayhead.querySelector('.timeline-playhead-handle') as HTMLElement;
  if (!handle) {
    handle = document.createElement('div');
    handle.className = 'timeline-playhead-handle';
    handle.addEventListener('mousedown', startPlayheadDrag);
    timelinePlayhead.appendChild(handle);
  }

  // Update clip highlighting and split indicators based on playhead position
  updateClipHighlighting();
}

function updateClipHighlighting() {
  // Remove all existing highlights and split indicators
  document.querySelectorAll('.timeline-clip').forEach(clipEl => {
    clipEl.classList.remove('clip-at-playhead');
    const existingSplitIndicator = clipEl.querySelector('.clip-split-indicator');
    if (existingSplitIndicator) {
      existingSplitIndicator.remove();
    }
  });

  // Find and highlight clips at playhead position
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (timeline.playheadPosition >= clip.startTime &&
          timeline.playheadPosition < clip.startTime + clip.duration) {
        const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`) as HTMLElement;
        if (clipEl) {
          clipEl.classList.add('clip-at-playhead');

          // Add split line indicator
          const splitIndicator = document.createElement('div');
          splitIndicator.className = 'clip-split-indicator';
          const relativePosition = (timeline.playheadPosition - clip.startTime) * pixelsPerSecond;
          splitIndicator.style.left = `${relativePosition}px`;
          clipEl.appendChild(splitIndicator);
        }
      }
    }
  }
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
    const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
    const hasBackground = selectedImage || bgTypeColor?.checked;
    convertBtn.disabled = !hasBackground || !hasAudio;
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
      updateVideoPreview();
    }
  } catch (error) {
    console.error('Error selecting image:', error);
  }
}

function updateVideoPreview() {
  const previewImage = document.getElementById('preview-image') as HTMLImageElement;
  const previewOverlay = document.getElementById('preview-overlay') as HTMLElement;
  const previewTitle = document.getElementById('preview-title') as HTMLElement;
  const previewPlaceholder = document.querySelector('.preview-placeholder') as HTMLElement;
  const previewDuration = document.getElementById('preview-duration') as HTMLElement;
  const previewClips = document.getElementById('preview-clips') as HTMLElement;
  const videoTitleInput = document.getElementById('video-title') as HTMLInputElement;
  const videoPreviewFrame = document.getElementById('video-preview') as HTMLElement;
  const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
  const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;

  // Check if using solid color
  const usingSolidColor = bgTypeColor?.checked;

  if (usingSolidColor && bgColorPicker && videoPreviewFrame) {
    // Show solid color background
    videoPreviewFrame.style.background = bgColorPicker.value;
    if (previewImage) previewImage.style.display = 'none';
    if (previewPlaceholder) previewPlaceholder.style.display = 'none';
  } else if (selectedImage && previewImage && previewPlaceholder && videoPreviewFrame) {
    // Show image background
    videoPreviewFrame.style.background = '#1a1a1a';
    previewImage.src = convertFileSrc(selectedImage);
    previewImage.style.display = 'block';
    previewPlaceholder.style.display = 'none';
  } else if (!usingSolidColor && previewImage && previewPlaceholder && videoPreviewFrame) {
    // No image selected and not using solid color - show placeholder
    videoPreviewFrame.style.background = '#1a1a1a';
    previewImage.style.display = 'none';
    previewPlaceholder.style.display = 'flex';
  }

  // Update title overlay
  if (previewOverlay && previewTitle && videoTitleInput) {
    const title = videoTitleInput.value || 'Video Title';
    previewTitle.textContent = title;
    if (selectedImage || usingSolidColor) {
      previewOverlay.style.display = 'block';
    }
  }

  // Update stats
  const totalDuration = _getTotalTimelineDuration();
  const totalClips = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);

  if (previewDuration) {
    previewDuration.textContent = totalDuration > 0 ? formatTime(totalDuration) : '--';
  }
  if (previewClips) {
    previewClips.textContent = totalClips.toString();
  }
}

async function selectAudio() {
  // Use the same logic as addNewTrackWithFiles
  await addNewTrackWithFiles();
}

async function selectAudioForTrack(trackId: string) {
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
      const track = getTrackById(trackId);

      if (!track) {
        console.error('Track not found:', trackId);
        return;
      }

      for (const filePath of files) {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';

        // Find the end position of the last clip in this track
        const lastClip = track.clips.length > 0
          ? track.clips.reduce((latest, clip) =>
              (clip.startTime + clip.duration > latest.startTime + latest.duration) ? clip : latest
            )
          : null;

        const startTime = lastClip ? lastClip.startTime + lastClip.duration : 0;

        // Create new clip and add to this track
        const clip: Clip = {
          id: generateClipId(),
          trackId: track.id,
          sourceFile: filePath,
          sourceName: fileName,
          startTime: startTime,
          duration: 60, // Placeholder - actual duration will be determined by audio file
          trimStart: 0,
          trimEnd: 0,
          sourceDuration: 60
        };

        track.clips.push(clip);
        console.log(`Added clip "${fileName}" to track "${track.name}" at ${startTime}s`);
      }

      renderTimeline();
      updateConvertButton();
      updateVideoPreview();
    }
  } catch (error) {
    console.error('Error selecting audio for track:', error);
  }
}

async function addNewTrackWithFiles() {
  try {
    console.log('addNewTrackWithFiles called');

    // Show mode selection dialog
    const modeDialog = document.createElement('div');
    modeDialog.className = 'mode-selection-dialog';
    modeDialog.innerHTML = `
      <div class="mode-selection-content">
        <h3>Select Track Mode</h3>
        <p>How would you like to add audio files?</p>
        <div class="mode-options">
          <button id="mode-single" class="mode-option-btn">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18V5l12-2v13"/>
              <circle cx="6" cy="18" r="3"/>
              <circle cx="18" cy="16" r="3"/>
            </svg>
            <span>Single Mode</span>
            <small>Add multiple files in sequence</small>
          </button>
          <button id="mode-random" class="mode-option-btn">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>
            </svg>
            <span>Random Mode</span>
            <small>Randomly pick one from multiple files</small>
          </button>
        </div>
        <button id="mode-cancel" class="mode-cancel-btn">Cancel</button>
      </div>
    `;
    document.body.appendChild(modeDialog);

    const mode = await new Promise<'single' | 'random' | null>((resolve) => {
      document.getElementById('mode-single')?.addEventListener('click', () => {
        document.body.removeChild(modeDialog);
        resolve('single');
      });
      document.getElementById('mode-random')?.addEventListener('click', () => {
        document.body.removeChild(modeDialog);
        resolve('random');
      });
      document.getElementById('mode-cancel')?.addEventListener('click', () => {
        document.body.removeChild(modeDialog);
        resolve(null);
      });
    });

    if (!mode) return; // User cancelled

    // Open file selection based on mode
    const selected = await open({
      multiple: true,
      filters: [{
        name: 'Audio',
        extensions: ['mp3', 'mp4'] // Support mp4 audio as requested
      }]
    });

    console.log('File selection result:', selected);

    if (selected) {
      const files = Array.isArray(selected) ? selected : [selected];
      console.log('Processing files:', files);

      if (mode === 'random') {
        // Random mode: Store all files, pick one randomly
        const chosenFile = selectRandomFile(files);
        const fileName = chosenFile.split('/').pop() || chosenFile.split('\\').pop() || 'Unknown';

        const newTrack: Track = {
          id: generateTrackId(),
          type: 'audio',
          name: `Random Track ${timeline.tracks.length + 1}`,
          clips: [],
          volume: 100,
          muted: false,
          mode: 'random',
          randomPool: files,
          currentRandomFile: chosenFile
        };

        // Create clip for the randomly chosen file
        const clip: Clip = {
          id: generateClipId(),
          trackId: newTrack.id,
          sourceFile: chosenFile,
          sourceName: fileName,
          startTime: 0,
          duration: 60,
          trimStart: 0,
          trimEnd: 0,
          sourceDuration: 60
        };

        newTrack.clips.push(clip);
        timeline.tracks.push(newTrack);
        console.log(`Created random track with ${files.length} files in pool, chose: ${fileName}`);
      } else {
        // Single mode: Add all files as sequential clips
        const newTrack: Track = {
          id: generateTrackId(),
          type: 'audio',
          name: `Audio Track ${timeline.tracks.length + 1}`,
          clips: [],
          volume: 100,
          muted: false,
          mode: 'single'
        };
        timeline.tracks.push(newTrack);

        let currentStartTime = 0;
        for (const filePath of files) {
          const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';

          const clip: Clip = {
            id: generateClipId(),
            trackId: newTrack.id,
            sourceFile: filePath,
            sourceName: fileName,
            startTime: currentStartTime,
            duration: 60,
            trimStart: 0,
            trimEnd: 0,
            sourceDuration: 60
          };

          newTrack.clips.push(clip);
          console.log(`Added clip "${fileName}" to new track "${newTrack.name}" at ${currentStartTime}s`);
          currentStartTime += 60;
        }
      }

      renderTimeline();
      updateConvertButton();
      updateVideoPreview();
    }
  } catch (error) {
    console.error('Error adding new track with files:', error);
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
  console.log('=== Starting video conversion ===');

  // Check both legacy and timeline for audio
  const hasLegacyAudio = audioFiles.length > 0;
  const hasTimelineAudio = timeline.tracks.some(t => t.clips.length > 0);

  // Check for background (image or solid color)
  const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
  const hasBackground = selectedImage || bgTypeColor?.checked;

  console.log('Selected image:', selectedImage);
  console.log('Background type - Color:', bgTypeColor?.checked);
  console.log('Has background:', hasBackground);
  console.log('Has legacy audio:', hasLegacyAudio, '(files:', audioFiles.length, ')');
  console.log('Has timeline audio:', hasTimelineAudio);

  if (!hasBackground || (!hasLegacyAudio && !hasTimelineAudio)) {
    console.error('Cannot convert: missing background or audio');
    console.error('hasBackground:', hasBackground, 'hasLegacyAudio:', hasLegacyAudio, 'hasTimelineAudio:', hasTimelineAudio);
    return;
  }

  // Show progress
  if (progressSection && resultSection) {
    progressSection.style.display = 'block';
    resultSection.style.display = 'none';
  }

  // Reset progress UI
  if (progressBar) {
    progressBar.style.width = '0%';
  }
  if (progressText) {
    progressText.textContent = '0%';
  }
  if (progressDetails) {
    progressDetails.textContent = 'Starting export...';
  }

  if (convertBtn) {
    convertBtn.disabled = true;
  }

  try {
    let result: string;

    // Handle solid color background - need to generate a temporary image
    let imagePathToUse = selectedImage;
    if (!selectedImage && bgTypeColor?.checked) {
      console.log('Solid color background selected, generating temporary image...');
      const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
      const solidColor = bgColorPicker?.value || '#667eea';
      console.log('Color:', solidColor);

      // Call Rust command to create solid color image
      imagePathToUse = await invoke<string>('create_solid_color_image', {
        color: solidColor,
        width: 1280,
        height: 720
      });
      console.log('Temporary image created at:', imagePathToUse);
    }

    // Use timeline-based export if we have timeline clips
    if (hasTimelineAudio) {
      console.log('Using timeline-based export');

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

      console.log('Timeline data:', {
        trackCount: timelineData.tracks.length,
        totalClips: timelineData.tracks.reduce((sum, t) => sum + t.clips.length, 0)
      });

      console.log('Invoking convert_timeline_to_video...');
      result = await invoke<string>('convert_timeline_to_video', {
        imagePath: imagePathToUse,
        timeline: timelineData,
        backgroundStyle: backgroundStyle,
        bgMusicPath: bgMusicFile,
        bgMusicVolume: bgMusicVolume,
        mainAudioVolume: mainAudioVolume
      });
      console.log('Timeline conversion result:', result);
    } else {
      // Fallback to legacy mode
      console.log('Using legacy mode export');
      const audioPaths = audioFiles.map(f => f.path);
      console.log('Audio paths:', audioPaths);

      console.log('Invoking convert_to_video...');
      result = await invoke<string>('convert_to_video', {
        imagePath: imagePathToUse,
        audioPaths: audioPaths,
        backgroundStyle: backgroundStyle,
        bgMusicPath: bgMusicFile,
        bgMusicVolume: bgMusicVolume,
        mainAudioVolume: mainAudioVolume
      });
      console.log('Legacy conversion result:', result);
    }

    lastGeneratedVideo = result;
    console.log('Video conversion successful!');

    // Show success
    if (progressSection && resultSection && resultMessage) {
      progressSection.style.display = 'none';
      resultSection.style.display = 'block';
      resultMessage.textContent = `Video created successfully: ${result}`;
      console.log('UI updated to show success');

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
      console.log('Auto-upload enabled, starting upload...');
      await uploadToVimeo();
    }

    console.log('=== Video conversion completed successfully ===');
  } catch (error) {
    console.error('=== ERROR during video conversion ===');
    console.error('Error type:', typeof error);
    console.error('Error object:', error);
    console.error('Error string:', String(error));

    // Try to extract more information from the error
    if (error && typeof error === 'object') {
      console.error('Error keys:', Object.keys(error));
      if ('message' in error) {
        console.error('Error message:', (error as any).message);
      }
      if ('stack' in error) {
        console.error('Error stack:', (error as any).stack);
      }
    }

    if (progressSection && resultSection && resultMessage) {
      progressSection.style.display = 'none';
      resultSection.style.display = 'block';
      resultMessage.textContent = `Error: ${error}`;
      console.log('UI updated to show error');
    }
  } finally {
    if (convertBtn) {
      convertBtn.disabled = false;
      console.log('Convert button re-enabled');
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
  progressBar = document.querySelector("#progress-bar")!;
  progressText = document.querySelector("#progress-text")!;
  progressDetails = document.querySelector("#progress-details")!;
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
  splitClipBtn = document.querySelector("#split-clip-btn")!;

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

  // Split button
  splitClipBtn?.addEventListener('click', splitClipAtPlayhead);

  // Global mouse event listeners for drag, trim, and playhead
  document.addEventListener('mousemove', (e) => {
    if (dragState && dragState.isDragging) {
      updateDrag(e.clientX);
      startEdgeScrolling(e.clientX);
    } else if (trimState && trimState.isTrimming) {
      updateTrim(e.clientX);
      startEdgeScrolling(e.clientX);
    } else if (playheadDragging) {
      updatePlayheadDrag(e);
    }
  });

  document.addEventListener('mouseup', () => {
    if (dragState && dragState.isDragging) {
      endDrag();
      stopEdgeScrolling();
    } else if (trimState && trimState.isTrimming) {
      endTrim();
      stopEdgeScrolling();
    } else if (playheadDragging) {
      endPlayheadDrag();
    }
  });

  // Track Shift/Ctrl/Cmd key state for fine control mode
  // Removed old fine control mode handlers

  // Playback controls
  timelinePlayBtn = document.querySelector('#timeline-play')!;
  timelineTimeDisplay = document.querySelector('#timeline-time')!;

  timelinePlayBtn?.addEventListener('click', togglePlayPause);
  timelineRuler?.addEventListener('click', handleRulerClick);

  // Click on timeline tracks to deselect clips
  timelineTracks?.addEventListener('click', (e) => {
    // Only deselect if clicking directly on the tracks container (not on a clip)
    if (e.target === timelineTracks) {
      deselectClip();
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboardShortcuts);

  // Initialize time display
  updateTimeDisplay();

  // Video title input listener for preview
  const videoTitleInput = document.getElementById('video-title') as HTMLInputElement;
  videoTitleInput?.addEventListener('input', updateVideoPreview);

  // Background type selector listeners
  const bgTypeImage = document.getElementById('bg-type-image') as HTMLInputElement;
  const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
  const colorPickerArea = document.getElementById('color-picker-area') as HTMLElement;
  const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;

  bgTypeImage?.addEventListener('change', () => {
    if (imageUploadArea) imageUploadArea.style.display = 'block';
    if (colorPickerArea) colorPickerArea.style.display = 'none';
    updateVideoPreview();
  });

  bgTypeColor?.addEventListener('change', () => {
    if (imageUploadArea) imageUploadArea.style.display = 'none';
    if (colorPickerArea) colorPickerArea.style.display = 'block';
    selectedImage = null; // Clear image selection
    updateVideoPreview();
    updateConvertButton();
  });

  bgColorPicker?.addEventListener('input', updateVideoPreview);

  // Listen for export progress events from Rust
  listen('export-progress', (event: any) => {
    const progress = event.payload;

    if (progressBar) {
      progressBar.style.width = `${progress.progress}%`;
    }
    if (progressText) {
      progressText.textContent = `${Math.round(progress.progress)}%`;
    }
    if (progressDetails) {
      progressDetails.textContent = `Frame: ${progress.frame} | FPS: ${progress.fps.toFixed(1)} | Time: ${progress.time}`;
    }
  });

  // Listen for menu events
  listen('open-settings', () => {
    openSettings();
  });

  listen('open-about', () => {
    alert('Vimeo MP3 Uploader\nVersion 0.1.0\n\nA tool for creating videos from audio files.');
  });

  // Listen for export/import project events
  listen('export-project', async () => {
    await exportProject();
  });

  listen('import-project', async () => {
    await importProject();
  });

  listen('clear-project', () => {
    clearProject();
  });
});

// ============================================================================
// Project Export/Import Functions
// ============================================================================

async function exportProject() {
  try {
    // Gather all project data
    const videoTitleInput = document.getElementById('video-title') as HTMLInputElement;
    const videoDescInput = document.getElementById('video-description') as HTMLTextAreaElement;
    const bgTypeImage = document.getElementById('bg-type-image') as HTMLInputElement;
    const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
    const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;

    const projectData = {
      version: '1.0.0',
      background_image: selectedImage,
      background_color: bgTypeColor?.checked ? bgColorPicker?.value : null,
      background_type: bgTypeImage?.checked ? 'image' : 'color',
      background_style: backgroundStyle,
      tracks: timeline.tracks.map(track => ({
        id: track.id,
        track_type: track.type,
        name: track.name,
        clips: track.clips.map(clip => ({
          id: clip.id,
          source_file: clip.sourceFile,
          source_name: clip.sourceName,
          track_id: clip.trackId,
          start_time: clip.startTime,
          duration: clip.duration,
          trim_start: clip.trimStart,
          trim_end: clip.trimEnd,
          source_duration: clip.sourceDuration
        })),
        volume: track.volume,
        muted: track.muted
      })),
      video_title: videoTitleInput?.value || 'Converted Video',
      video_description: videoDescInput?.value || ''
    };

    const result = await invoke<string>('export_project', { projectData });
    showToast(`Project exported successfully to: ${result}`, 'success', 3000);
  } catch (error) {
    console.error('Error exporting project:', error);
    showToast(`Failed to export project: ${error}`, 'error', 5000);
  }
}

async function importProject() {
  try {
    const projectData: any = await invoke('import_project');

    // Reset timeline
    timeline.tracks = [];
    timeline.playheadPosition = 0;
    nextClipId = 1;
    nextTrackId = 1;

    // Load background
    if (projectData.background_type === 'image' && projectData.background_image) {
      selectedImage = projectData.background_image;
      const bgTypeImage = document.getElementById('bg-type-image') as HTMLInputElement;
      if (bgTypeImage) bgTypeImage.checked = true;

      if (imagePreview && imagePlaceholder && imageOptions) {
        imagePreview.src = convertFileSrc(selectedImage);
        imagePreview.style.display = 'block';
        imagePlaceholder.style.display = 'none';
        imageOptions.style.display = 'block';
      }
    } else if (projectData.background_type === 'color' && projectData.background_color) {
      selectedImage = null;
      const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
      const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
      if (bgTypeColor) bgTypeColor.checked = true;
      if (bgColorPicker) bgColorPicker.value = projectData.background_color;

      const imageUploadArea = document.getElementById('image-upload-area');
      const colorPickerArea = document.getElementById('color-picker-area');
      if (imageUploadArea) imageUploadArea.style.display = 'none';
      if (colorPickerArea) colorPickerArea.style.display = 'block';
    }

    // Load background style
    backgroundStyle = projectData.background_style || 'cover';
    if (backgroundStyleSelect) {
      backgroundStyleSelect.value = backgroundStyle;
    }

    // Load video metadata
    const videoTitleInput = document.getElementById('video-title') as HTMLInputElement;
    const videoDescInput = document.getElementById('video-description') as HTMLTextAreaElement;
    if (videoTitleInput) videoTitleInput.value = projectData.video_title || 'Converted Video';
    if (videoDescInput) videoDescInput.value = projectData.video_description || '';

    // Load tracks
    for (const trackData of projectData.tracks) {
      // Update nextTrackId to avoid conflicts
      const trackIdNum = parseInt(trackData.id.replace('track-', ''));
      if (!isNaN(trackIdNum) && trackIdNum >= nextTrackId) {
        nextTrackId = trackIdNum + 1;
      }

      const track: Track = {
        id: trackData.id,
        type: trackData.track_type as 'audio' | 'background',
        name: trackData.name,
        clips: [],
        volume: trackData.volume,
        muted: trackData.muted
      };

      // Load clips
      for (const clipData of trackData.clips) {
        // Update nextClipId to avoid conflicts
        const clipIdNum = parseInt(clipData.id.replace('clip-', ''));
        if (!isNaN(clipIdNum) && clipIdNum >= nextClipId) {
          nextClipId = clipIdNum + 1;
        }

        const clip: Clip = {
          id: clipData.id,
          sourceFile: clipData.source_file,
          sourceName: clipData.source_name,
          trackId: clipData.track_id,
          startTime: clipData.start_time,
          duration: clipData.duration,
          trimStart: clipData.trim_start,
          trimEnd: clipData.trim_end,
          sourceDuration: clipData.source_duration
        };

        track.clips.push(clip);
      }

      timeline.tracks.push(track);
    }

    // Render timeline
    renderTimeline();
    updateConvertButton();
    updateVideoPreview();

    showToast('Project imported successfully!', 'success', 3000);
  } catch (error) {
    console.error('Error importing project:', error);
    if (error !== 'Open cancelled') {
      showToast(`Failed to import project: ${error}`, 'error', 5000);
    }
  }
}

function clearProject() {
  // Confirm with user
  const confirmed = confirm('Are you sure you want to clear the entire project? This cannot be undone.');
  if (!confirmed) {
    return;
  }

  // Stop all playing audio
  for (const audio of timelineAudioElements.values()) {
    audio.pause();
    audio.src = '';
  }
  timelineAudioElements.clear();

  // Reset timeline
  timeline.tracks = [];
  timeline.playheadPosition = 0;
  nextClipId = 1;
  nextTrackId = 1;

  // Reset background image
  selectedImage = null;
  if (imagePreview && imagePlaceholder && imageOptions) {
    imagePreview.src = '';
    imagePreview.style.display = 'none';
    imagePlaceholder.style.display = 'flex';
    imageOptions.style.display = 'none';
  }

  // Reset background type to image
  const bgTypeImage = document.getElementById('bg-type-image') as HTMLInputElement;
  const bgTypeColor = document.getElementById('bg-type-color') as HTMLInputElement;
  if (bgTypeImage) bgTypeImage.checked = true;
  if (bgTypeColor) bgTypeColor.checked = false;

  // Reset background color picker
  const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
  if (bgColorPicker) bgColorPicker.value = '#667eea';

  // Show image upload area, hide color picker
  const imageUploadArea = document.getElementById('image-upload-area');
  const colorPickerArea = document.getElementById('color-picker-area');
  if (imageUploadArea) imageUploadArea.style.display = 'block';
  if (colorPickerArea) colorPickerArea.style.display = 'none';

  // Reset background style
  backgroundStyle = 'cover';
  if (backgroundStyleSelect) {
    backgroundStyleSelect.value = 'cover';
  }

  // Reset video metadata
  const videoTitleInput = document.getElementById('video-title') as HTMLInputElement;
  const videoDescInput = document.getElementById('video-description') as HTMLTextAreaElement;
  if (videoTitleInput) videoTitleInput.value = 'Converted Video';
  if (videoDescInput) videoDescInput.value = '';

  // Reset legacy audio files (if any)
  audioFiles = [];

  // Hide timeline and show upload area
  if (timelineContainer) timelineContainer.style.display = 'none';
  if (audioUploadArea) audioUploadArea.style.display = 'block';
  if (audioPlaylist) {
    audioPlaylist.style.display = 'none';
    audioPlaylist.innerHTML = '';
  }

  // Hide progress and result sections
  if (progressSection) progressSection.style.display = 'none';
  if (resultSection) resultSection.style.display = 'none';

  // Update UI state
  updateConvertButton();
  updateVideoPreview();

  showToast('Project cleared successfully!', 'success', 2000);
  console.log('Project cleared');
}
