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

// Video metadata for bulk export
interface VideoMetadata {
  clipId: string;
  audioFileName: string;
  musicTrackName: string;
  title: string;
  description: string;
}

interface ProcessedVideo {
  title: string;
  videoPath: string;
  metadata: VideoMetadata;
  status: 'success' | 'failed';
  error?: string;
  vimeoUrl?: string;
}

let videoMetadataList: VideoMetadata[] = [];
let processedVideos: ProcessedVideo[] = [];

// Dialog state management
let isDialogOpen = false;

let currentAudio: HTMLAudioElement | null = null;
let currentPlayingIndex: number | null = null;

// Timeline audio playback
let timelineAudioElements: Map<string, HTMLAudioElement> = new Map();
let activeTimelineClips: Set<string> = new Set();
let autoplayBlocked = false; // Track if autoplay was blocked

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
  if (!toastContainer || !document.body.contains(toastContainer)) {
    // Check if one already exists in DOM
    const existing = document.querySelector('.toast-container');
    if (existing) {
      toastContainer = existing as HTMLElement;
    } else {
      toastContainer = document.createElement('div');
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
    }
    console.log('initToastContainer: using', toastContainer, 'in body:', document.body.contains(toastContainer));
  }
}

function showToast(message: string, type: 'error' | 'warning' | 'success' | 'info' = 'info', duration = 3000) {
  console.log('showToast called:', message, type);
  initToastContainer();
  console.log('toastContainer:', toastContainer);
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

  // Force visibility with inline styles
  toast.style.cssText = `
    display: flex !important;
    visibility: visible !important;
    opacity: 1 !important;
    background: ${type === 'error' ? '#fee2e2' : type === 'success' ? '#d1fae5' : type === 'warning' ? '#fef3c7' : '#dbeafe'};
    border-left: 4px solid ${type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : type === 'warning' ? '#f59e0b' : '#3b82f6'};
    padding: 1rem;
    border-radius: 8px;
    margin-bottom: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    color: #1f2937;
  `;

  console.log('Appending toast to container:', toast);
  toastContainer.appendChild(toast);
  console.log('Toast container children:', toastContainer.children.length);

  // Auto-dismiss after duration
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, duration);
}

// Show a loading toast that can be updated later
function showLoadingToast(message: string): HTMLElement {
  initToastContainer();
  if (!toastContainer) return document.createElement('div');

  const toast = document.createElement('div');
  toast.className = 'toast toast-loading';

  toast.innerHTML = `
    <div class="toast-spinner"></div>
    <div class="toast-message">${message}</div>
  `;

  toastContainer.appendChild(toast);
  return toast;
}

// Update a toast to success with optional video link
function updateToastSuccess(toast: HTMLElement, message: string, videoUrl?: string) {
  toast.className = 'toast toast-success';

  const successIcon = `<svg class="toast-icon toast-success" viewBox="0 0 20 20" fill="currentColor">
    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
  </svg>`;

  let messageHtml = message;
  if (videoUrl) {
    messageHtml = `${message}<br><a href="${videoUrl}" target="_blank" rel="noopener noreferrer">View on Vimeo →</a>`;
  }

  toast.innerHTML = `
    ${successIcon}
    <div class="toast-message">${messageHtml}</div>
  `;

  // Auto-dismiss after 8 seconds for success with link
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, videoUrl ? 8000 : 4000);
}

// Update a toast to error
function updateToastError(toast: HTMLElement, message: string) {
  toast.className = 'toast toast-error';

  const errorIcon = `<svg class="toast-icon toast-error" viewBox="0 0 20 20" fill="currentColor">
    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
  </svg>`;

  toast.innerHTML = `
    ${errorIcon}
    <div class="toast-message">${message}</div>
  `;

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 5000);
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

// Helper function to get file type icon
function getFileIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';

  const icons: Record<string, string> = {
    'mp3': '🎵',
    'wav': '🎵',
    'm4a': '🎵',
    'ogg': '🎵',
    'flac': '🎵',
    'aac': '🎵',
    'mp4': '🎬',
    'mov': '🎬',
    'avi': '🎬',
    'webm': '🎬',
    'mkv': '🎬',
    'jpg': '🖼️',
    'jpeg': '🖼️',
    'png': '🖼️',
    'gif': '🖼️',
    'svg': '🖼️',
    'webp': '🖼️'
  };

  return icons[ext] || '📄';
}

// Helper function to format file size
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper function to format duration
function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Reusable component for file item display
interface FileItemOptions {
  fileName: string;
  index: number;
  dataAttribute: string;
  metaText?: string;
  duration?: number;
  fileSize?: number;
  isSelected?: boolean;
}

function createFileItem(options: FileItemOptions): HTMLDivElement {
  const { fileName, index, dataAttribute, metaText, duration, fileSize, isSelected = false } = options;

  const fileItem = document.createElement('div');
  fileItem.className = 'file-item';
  fileItem.setAttribute('draggable', 'true');
  fileItem.setAttribute('data-file-index', index.toString());

  if (isSelected) {
    fileItem.classList.add('selected');
  }

  const icon = getFileIcon(fileName);
  // Always include meta span to maintain grid structure, even if empty
  const metaBadge = metaText ? `<span class="file-meta">${metaText}</span>` : '<span class="file-meta-placeholder"></span>';

  // Build metadata display
  let metadataRow = '';
  if (duration || fileSize) {
    const durationStr = duration ? `<span class="file-duration">⏱️ ${formatDuration(duration)}</span>` : '';
    const sizeStr = fileSize ? `<span class="file-size">💾 ${formatFileSize(fileSize)}</span>` : '';
    metadataRow = `
      <div class="file-metadata">
        ${durationStr}
        ${sizeStr}
      </div>
    `;
  }

  fileItem.innerHTML = `
    <div class="file-info">
      <span class="file-icon">${icon}</span>
      <span class="file-number">${index + 1}</span>
      <div class="file-name-container">
        <span class="file-name" title="${fileName}">${fileName}</span>
        ${metadataRow}
      </div>
      ${metaBadge}
    </div>
    <div class="file-actions">
      <button class="icon-btn danger" ${dataAttribute}="${index}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;

  // Add drag and drop event listeners
  fileItem.addEventListener('dragstart', (e) => {
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', index.toString());
    fileItem.classList.add('dragging');
  });

  fileItem.addEventListener('dragend', () => {
    fileItem.classList.remove('dragging');
  });

  fileItem.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
  });

  // Add selection on click
  fileItem.addEventListener('click', (e) => {
    // Don't trigger selection if clicking the delete button
    if ((e.target as HTMLElement).closest('.icon-btn')) {
      return;
    }

    const container = fileItem.parentElement;
    if (!container) return;

    if (e.ctrlKey || e.metaKey) {
      // Multi-select
      fileItem.classList.toggle('selected');
    } else {
      // Single select - deselect all others first
      container.querySelectorAll('.file-item.selected').forEach(item => {
        item.classList.remove('selected');
      });
      fileItem.classList.add('selected');
    }
  });

  return fileItem;
}

// Metadata table functions
function getMusicTrackForAudioClip(audioClip: Clip): string {
  // Find if there's a background track (music) that overlaps with this audio clip
  const musicTracks = timeline.tracks.filter(t => t.type === 'background');

  if (musicTracks.length === 0) {
    return 'No music';
  }

  // Check which music tracks have clips that overlap with this audio clip
  for (const musicTrack of musicTracks) {
    if (musicTrack.clips.length > 0) {
      // For simplicity, if there's any music track with clips, use it
      if (musicTrack.mode === 'random' && musicTrack.randomPool && musicTrack.randomPool.length > 0) {
        return `${musicTrack.name} (${musicTrack.randomPool.length} files)`;
      } else if (musicTrack.clips[0]) {
        return musicTrack.clips[0].sourceName;
      }
    }
  }

  return 'No music';
}

function autoFillTitleFromFilename(filename: string): string {
  // Remove file extension
  let title = filename.replace(/\.(mp3|wav|m4a|ogg|flac|aac)$/i, '');

  // Replace underscores and hyphens with spaces
  title = title.replace(/[_-]/g, ' ');

  // Capitalize first letter of each word
  title = title.replace(/\b\w/g, (char) => char.toUpperCase());

  return title;
}

function updateProcessButton() {
  const processBtn = document.getElementById('process-all-btn') as HTMLButtonElement;
  const processCount = document.getElementById('process-count');

  if (processBtn && processCount) {
    const count = videoMetadataList.length;
    processCount.textContent = count.toString();
    processBtn.disabled = count === 0;
  }
}

function populateMetadataTable() {
  const metadataTbody = document.getElementById('metadata-tbody');
  if (!metadataTbody) return;

  // Clear existing rows
  metadataTbody.innerHTML = '';
  videoMetadataList = [];

  // Get all audio clips from audio tracks (not background tracks)
  const audioTracks = timeline.tracks.filter(t => t.type === 'audio');

  let rowIndex = 0;
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      rowIndex++;

      const musicTrack = getMusicTrackForAudioClip(clip);
      const title = autoFillTitleFromFilename(clip.sourceName);

      // Create metadata entry
      const metadata: VideoMetadata = {
        clipId: clip.id,
        audioFileName: clip.sourceName,
        musicTrackName: musicTrack,
        title: title,
        description: ''
      };

      videoMetadataList.push(metadata);

      // Create table row
      const row = document.createElement('tr');
      row.setAttribute('data-clip-id', clip.id);
      row.innerHTML = `
        <td class="text-center">${rowIndex}</td>
        <td title="${clip.sourceName}">${clip.sourceName}</td>
        <td>${musicTrack}</td>
        <td>
          <input type="text" class="metadata-input title-input" value="${title}" data-clip-id="${clip.id}">
        </td>
        <td>
          <input type="text" class="metadata-input description-input" value="" data-clip-id="${clip.id}" placeholder="Add description...">
        </td>
        <td class="text-center">
          <button class="icon-btn" title="Clear">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </td>
      `;

      metadataTbody.appendChild(row);

      // Add event listeners for input changes
      const titleInput = row.querySelector('.title-input') as HTMLInputElement;
      const descInput = row.querySelector('.description-input') as HTMLInputElement;

      if (titleInput) {
        titleInput.addEventListener('input', (e) => {
          const input = e.target as HTMLInputElement;
          const clipId = input.getAttribute('data-clip-id');
          const entry = videoMetadataList.find(m => m.clipId === clipId);
          if (entry) {
            entry.title = input.value;
          }
        });
      }

      if (descInput) {
        descInput.addEventListener('input', (e) => {
          const input = e.target as HTMLInputElement;
          const clipId = input.getAttribute('data-clip-id');
          const entry = videoMetadataList.find(m => m.clipId === clipId);
          if (entry) {
            entry.description = input.value;
          }
        });
      }

      // Add clear button handler
      const clearBtn = row.querySelector('.icon-btn');
      if (clearBtn) {
        clearBtn.addEventListener('click', () => {
          if (titleInput) titleInput.value = '';
          if (descInput) descInput.value = '';
          const entry = videoMetadataList.find(m => m.clipId === clip.id);
          if (entry) {
            entry.title = '';
            entry.description = '';
          }
        });
      }
    }
  }

  console.log(`📋 Populated metadata table with ${rowIndex} entries`);
  updateProcessButton();
}

// Process all videos for bulk export
async function processAllVideos() {
  console.log('=== Starting bulk video processing ===');

  if (videoMetadataList.length === 0) {
    showToast('No videos to process', 'warning');
    return;
  }

  // Check for background - check if color tab is active or if an image is selected
  const colorTabActive = document.querySelector('.bg-tab[data-tab="color"]')?.classList.contains('active');
  const hasBackground = selectedImage || colorTabActive;

  console.log('Background check:', { selectedImage, colorTabActive, hasBackground });

  if (!hasBackground) {
    console.log('No background selected - showing error toast');
    showToast('Please select a background image or color', 'error');
    return;
  }

  console.log('Background check passed, proceeding...');

  // Disable process button
  const processBtn = document.getElementById('process-all-btn') as HTMLButtonElement;
  if (processBtn) {
    processBtn.disabled = true;
  }

  // Show progress overlay
  const progressOverlay = document.getElementById('progress-overlay');
  const progressText = document.getElementById('progress-text');
  const progressDetails = document.getElementById('progress-details');
  const progressBar = document.getElementById('progress-bar');

  if (progressOverlay) {
    progressOverlay.style.display = 'flex';
  }

  try {
    const totalVideos = videoMetadataList.length;
    let successCount = 0;
    let failCount = 0;
    processedVideos = []; // Clear previous results

    // Get background image path
    let imagePathToUse = selectedImage;
    if (!selectedImage && colorTabActive) {
      const bgColorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
      const solidColor = bgColorPicker?.value || '#667eea';

      imagePathToUse = await invoke<string>('create_solid_color_image', {
        color: solidColor,
        width: 1280,
        height: 720
      });
      console.log('Created temporary solid color image:', imagePathToUse);
    }

    // Get background music tracks
    const musicTracks = timeline.tracks.filter(t => t.type === 'background');

    // Process each video
    for (let i = 0; i < videoMetadataList.length; i++) {
      const metadata = videoMetadataList[i];
      const videoNum = i + 1;

      // Update progress
      const progress = ((i / totalVideos) * 100).toFixed(0);
      if (progressBar) {
        progressBar.style.width = `${progress}%`;
      }
      if (progressText) {
        progressText.textContent = `${progress}%`;
      }
      if (progressDetails) {
        progressDetails.textContent = `Processing video ${videoNum} of ${totalVideos}: ${metadata.title || metadata.audioFileName}`;
      }

      try {
        // Find the audio clip
        const audioTracks = timeline.tracks.filter(t => t.type === 'audio');
        let audioClip: Clip | null = null;

        for (const track of audioTracks) {
          const clip = track.clips.find(c => c.id === metadata.clipId);
          if (clip) {
            audioClip = clip;
            break;
          }
        }

        if (!audioClip) {
          console.error(`Audio clip not found for ${metadata.audioFileName}`);
          failCount++;
          continue;
        }

        // Get music for this audio
        let bgMusicPath: string | null = null;
        if (musicTracks.length > 0) {
          const musicTrack = musicTracks[0]; // Use first music track for now
          if (musicTrack.mode === 'random' && musicTrack.randomPool && musicTrack.randomPool.length > 0) {
            // Pick random music from pool
            bgMusicPath = selectRandomFile(musicTrack.randomPool);
          } else if (musicTrack.clips.length > 0) {
            bgMusicPath = musicTrack.clips[0].sourceFile;
          }
        }

        // Create timeline data for this single audio file
        const singleAudioTimeline = {
          tracks: [{
            clips: [{
              source_file: audioClip.sourceFile,
              start_time: 0, // Start at 0 for individual video
              duration: audioClip.duration,
              trim_start: audioClip.trimStart,
              trim_end: audioClip.trimEnd
            }],
            volume: 1.0
          }]
        };

        console.log(`Processing video ${videoNum}: ${metadata.title}`);
        console.log(`  Audio: ${audioClip.sourceName}`);
        console.log(`  Music: ${bgMusicPath || 'None'}`);

        // Generate output filename from audio file name (remove audio extension)
        const outputFilename = audioClip.sourceName.replace(/\.(mp3|wav|m4a|ogg|flac|aac)$/i, '');

        // Call Rust backend to create video
        const result = await invoke<string>('convert_timeline_to_video', {
          imagePath: imagePathToUse,
          timeline: singleAudioTimeline,
          backgroundStyle: backgroundStyle,
          bgMusicPath: bgMusicPath,
          bgMusicVolume: bgMusicVolume,
          mainAudioVolume: mainAudioVolume,
          outputFilename: outputFilename
        });

        console.log(`✅ Video ${videoNum} created:`, result);
        successCount++;

        // Store successful result
        processedVideos.push({
          title: metadata.title || metadata.audioFileName,
          videoPath: result,
          metadata: metadata,
          status: 'success'
        });

      } catch (error) {
        console.error(`Failed to process video ${videoNum}:`, error);
        failCount++;

        // Store failed result with error message
        processedVideos.push({
          title: metadata.title || metadata.audioFileName,
          videoPath: '',
          metadata: metadata,
          status: 'failed',
          error: String(error)
        });
      }
    }

    // Final progress update
    if (progressBar) {
      progressBar.style.width = '100%';
    }
    if (progressText) {
      progressText.textContent = '100%';
    }
    if (progressDetails) {
      progressDetails.textContent = `Completed: ${successCount} succeeded, ${failCount} failed`;
    }

    // Show completion message
    showToast(`Bulk processing complete! ${successCount}/${totalVideos} videos created successfully`, successCount === totalVideos ? 'success' : 'warning');

    // Keep progress overlay visible for a moment, then show results modal
    setTimeout(() => {
      if (progressOverlay) {
        progressOverlay.style.display = 'none';
      }
      // Show processed videos modal
      showProcessedVideosModal();
    }, 2000);

  } catch (error) {
    console.error('Bulk processing error:', error);
    showToast('Bulk processing failed: ' + error, 'error');

    if (progressOverlay) {
      progressOverlay.style.display = 'none';
    }
  } finally {
    // Re-enable button
    if (processBtn) {
      processBtn.disabled = false;
    }
  }
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

  // ✅ Reset autoplay flag - user interaction allows playback
  autoplayBlocked = false;

  // ✅ Preload audio for upcoming clips to ensure smooth playback
  preloadUpcomingAudio(timeline.playheadPosition);

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

// ✅ Preload audio for clips that will play soon
function preloadUpcomingAudio(currentTime: number) {
  const PRELOAD_AHEAD = 10; // Preload clips within next 10 seconds

  for (const track of timeline.tracks) {
    // Skip muted tracks and tracks with zero volume
    if (track.muted || track.volume === 0) continue;

    for (const clip of track.clips) {
      const clipStart = clip.startTime;
      const clipEnd = clip.startTime + clip.duration;

      // Check if clip is upcoming (within preload window)
      if (clipStart >= currentTime && clipStart <= currentTime + PRELOAD_AHEAD) {
        // Create audio element if it doesn't exist
        if (!timelineAudioElements.has(clip.id)) {
          const audio = new Audio(convertFileSrc(clip.sourceFile));
          audio.preload = 'auto';
          timelineAudioElements.set(clip.id, audio);
        }
      }
    }
  }
}

function updateTimelineAudio(currentTime: number) {
  const newActiveClips = new Set<string>();
  const SYNC_TOLERANCE = 0.3; // Allow 300ms drift before resyncing

  // Find all clips that should be playing at current time
  for (const track of timeline.tracks) {
    // ✅ FIX 1: Skip muted tracks
    if (track.muted) continue;

    // ✅ FIX 2: Skip tracks with zero volume (optimization)
    if (track.volume === 0) continue;

    for (const clip of track.clips) {
      const clipStart = clip.startTime;
      const clipEnd = clip.startTime + clip.duration;

      if (currentTime >= clipStart && currentTime < clipEnd) {
        newActiveClips.add(clip.id);

        // Get or create audio element for this clip
        let audio = timelineAudioElements.get(clip.id);
        const isNewAudio = !audio;

        if (isNewAudio) {
          audio = new Audio(convertFileSrc(clip.sourceFile));
          // Preload the audio for smoother playback
          audio.preload = 'auto';
          timelineAudioElements.set(clip.id, audio);
        }

        // ✅ FIX 3: Always update volume (track or main volume might have changed)
        const targetVolume = (track.volume / 100) * (mainAudioVolume / 100);
        audio.volume = targetVolume;

        // Calculate where the audio should be playing
        const relativeTime = currentTime - clipStart;

        // ✅ FIX 4: Check if audio needs to play or resync
        const needsToPlay = audio.paused || audio.ended;
        const isOutOfSync = Math.abs(audio.currentTime - relativeTime) > SYNC_TOLERANCE;

        if (needsToPlay || isOutOfSync) {
          // ✅ FIX 5: Check if audio is ready before attempting playback
          if (audio.readyState >= 2) { // HAVE_CURRENT_DATA or better
            // Resync if needed (but not too aggressively to avoid stuttering)
            if (isOutOfSync || isNewAudio) {
              audio.currentTime = Math.max(0, relativeTime);
            }

            // ✅ FIX 6: Proper promise handling with retry logic
            if (needsToPlay) {
              audio.play().catch(err => {
                // Handle autoplay restrictions gracefully
                if (err.name === 'NotAllowedError') {
                  if (!autoplayBlocked) {
                    autoplayBlocked = true;
                    console.warn('Autoplay blocked - pausing playback. Click play again to enable audio.');
                    showToast('Browser blocked audio autoplay. Click Play again to enable audio.', 'warning', 4000);
                    stopPlayback();
                  }
                } else if (err.name === 'NotSupportedError') {
                  console.error(`Audio format not supported for "${clip.sourceName}":`, err);
                  showToast(`Audio format not supported: ${clip.sourceName}`, 'error');
                } else {
                  console.error(`Error playing clip "${clip.sourceName}":`, err);
                }
              });
            }
          } else {
            // Audio not ready yet, wait for it to load
            if (isNewAudio) {
              // Set up one-time listener for when audio is ready
              const onCanPlay = () => {
                audio!.currentTime = Math.max(0, currentTime - clipStart);
                audio!.play().catch(err => {
                  console.error(`Error playing clip "${clip.sourceName}" after load:`, err);
                });
                audio!.removeEventListener('canplay', onCanPlay);
              };
              audio.addEventListener('canplay', onCanPlay);
            }
          }
        }
      }
    }
  }

  // ✅ FIX 7: Stop clips that are no longer active
  for (const clipId of activeTimelineClips) {
    if (!newActiveClips.has(clipId)) {
      const audio = timelineAudioElements.get(clipId);
      if (audio) {
        audio.pause();
      }
    }
  }

  // ✅ FIX 8: Cleanup distant audio elements to prevent memory leaks
  // Remove audio elements for clips that are far from current playhead
  const CLEANUP_DISTANCE = 30; // seconds - keep audio within 30s of playhead
  for (const [clipId, audio] of timelineAudioElements.entries()) {
    // Find the clip in timeline
    let clipFound = false;
    let clipTime = 0;

    for (const track of timeline.tracks) {
      const clip = track.clips.find(c => c.id === clipId);
      if (clip) {
        clipFound = true;
        clipTime = clip.startTime;
        break;
      }
    }

    // If clip not found or is far from playhead, remove it
    if (!clipFound || Math.abs(clipTime - currentTime) > CLEANUP_DISTANCE) {
      audio.pause();
      audio.src = ''; // Release media resources
      timelineAudioElements.delete(clipId);
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
  (volumeSlider as any).orient = 'vertical'; // For Firefox
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

function renderMusicPoolUI() {
  const musicList = document.getElementById('music-list');
  const musicTable = document.getElementById('music-table');
  const musicCount = document.getElementById('music-count');
  const musicDropZone = document.getElementById('music-drop-zone');

  if (!musicTable) return;

  // Get all background tracks from timeline
  const backgroundTracks = timeline.tracks.filter(t => t.type === 'background');

  // If no background tracks, show drop zone and hide list
  if (backgroundTracks.length === 0) {
    if (musicList) musicList.style.display = 'none';
    if (musicDropZone) musicDropZone.style.display = 'flex';
    if (musicCount) musicCount.textContent = '0 tracks';
    musicTable.innerHTML = '';
    return;
  }

  // Show music list, hide drop zone
  if (musicList) musicList.style.display = 'block';
  if (musicDropZone) musicDropZone.style.display = 'none';

  // Clear existing items
  musicTable.innerHTML = '';

  // Collect all files from all background tracks
  let totalFileCount = 0;
  let globalIndex = 0;

  backgroundTracks.forEach(track => {
    if (track.mode === 'random' && track.randomPool) {
      // Add files from random pool
      track.randomPool.forEach((filePath) => {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
        const musicItem = createFileItem({
          fileName,
          index: globalIndex,
          dataAttribute: 'data-music-index',
          metaText: '🎲 Random Pool'
        });
        musicTable.appendChild(musicItem);
        globalIndex++;
        totalFileCount++;
      });
    } else {
      // Add files from clips (sequential mode)
      track.clips.forEach((clip) => {
        const musicItem = createFileItem({
          fileName: clip.sourceName,
          index: globalIndex,
          dataAttribute: 'data-music-index',
          metaText: '📋 Sequential'
        });
        musicTable.appendChild(musicItem);
        globalIndex++;
        totalFileCount++;
      });
    }
  });

  // Update count badge
  if (musicCount) {
    musicCount.textContent = `${totalFileCount} track${totalFileCount !== 1 ? 's' : ''}`;
  }

  console.log(`Rendered ${totalFileCount} music files from ${backgroundTracks.length} background track(s)`);
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

      // Show preview in new bulk UI
      const bgImagePreview = document.getElementById('bg-image-preview') as HTMLImageElement;
      const imageDropZone = document.getElementById('image-drop-zone');
      const newImageOptions = document.getElementById('image-options');

      if (bgImagePreview) {
        bgImagePreview.src = convertFileSrc(selectedImage);
        bgImagePreview.style.display = 'block';
      }

      if (imageDropZone) {
        // Hide the SVG and button, keep the drop zone visible with the preview
        const svg = imageDropZone.querySelector('svg');
        const button = imageDropZone.querySelector('button');
        if (svg) (svg as any).style.display = 'none';
        if (button) (button as any).style.display = 'none';
      }

      if (newImageOptions) {
        newImageOptions.style.display = 'block';
      }

      // Legacy support for old UI
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
  try {
    const selected = await open({
      multiple: true,
      filters: [{
        name: 'Audio',
        extensions: ['mp3', 'wav', 'm4a', 'ogg']
      }]
    });

    console.log('Audio files selected:', selected);

    if (selected) {
      const files = Array.isArray(selected) ? selected : [selected];
      console.log(`Selected ${files.length} audio files`);

      // Create or update the Audio Files track
      let audioTrack = timeline.tracks.find(t => t.name === 'Audio Files');

      if (!audioTrack) {
        // Create new Audio Files track
        audioTrack = {
          id: generateTrackId(),
          type: 'audio',
          name: 'Audio Files',
          clips: [],
          volume: 100,
          muted: false,
          mode: 'single'
        };
        timeline.tracks.push(audioTrack);
      } else {
        // Clear existing clips
        audioTrack.clips = [];
      }

      // Add all audio files as sequential clips
      let currentStartTime = 0;
      for (const filePath of files) {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';

        const clip: Clip = {
          id: generateClipId(),
          trackId: audioTrack.id,
          sourceFile: filePath,
          sourceName: fileName,
          startTime: currentStartTime,
          duration: 60, // Placeholder, will be updated with actual duration
          trimStart: 0,
          trimEnd: 0,
          sourceDuration: 60
        };

        audioTrack.clips.push(clip);
        console.log(`Added audio file "${fileName}" at ${currentStartTime}s`);
        currentStartTime += 60;
      }

      // Show timeline section and container
      const timelineSection = document.getElementById('step-timeline');
      const timelineContainer = document.getElementById('timeline-container');
      if (timelineSection) {
        timelineSection.style.display = 'block';
      }
      if (timelineContainer) {
        timelineContainer.style.display = 'block';
      }

      renderTimeline();
      updateConvertButton();
      populateMetadataTable();

      // Update audio count badge and show file list
      const audioCount = document.getElementById('audio-count');
      const audioList = document.getElementById('audio-list');
      const audioTable = document.getElementById('audio-table');

      if (audioCount) {
        audioCount.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}`;
      }

      if (audioList && audioTable) {
        // Show the audio list container
        audioList.style.display = 'block';
        console.log('🔍 audioList display:', audioList.style.display);
        console.log('🔍 audioList computed style:', window.getComputedStyle(audioList).display);
        console.log('🔍 audioTable children count:', audioTable.children.length);

        // Hide the drop zone
        const audioDropZone = document.getElementById('audio-drop-zone');
        if (audioDropZone) {
          audioDropZone.style.display = 'none';
        }

        // Clear existing items
        audioTable.innerHTML = '';

        // Add each audio file to the list
        files.forEach((filePath, index) => {
          const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
          const audioItem = createFileItem({
            fileName,
            index,
            dataAttribute: 'data-audio-index'
          });
          console.log('🎯 NEW CODE: Created audio item:', audioItem);
          console.log('🎯 Audio item HTML:', audioItem.innerHTML);
          audioTable.appendChild(audioItem);
          console.log('🎯 Audio item in DOM? Parent:', audioItem.parentElement);
          console.log('🎯 Audio item dimensions:', audioItem.getBoundingClientRect());
        });

        console.log(`✅ Added ${files.length} audio files to UI list (NEW CODE)`);
      }
    }
  } catch (error) {
    console.error('Error selecting audio files:', error);
  }
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
  // Bug #1 Fix: Guard flag to prevent multiple dialogs
  if (isDialogOpen) {
    console.log('Dialog already open, ignoring request');
    return;
  }

  try {
    isDialogOpen = true;
    console.log('addNewTrackWithFiles called');

    // Show mode selection dialog
    const modeDialog = document.createElement('div');
    modeDialog.className = 'mode-selection-dialog';
    console.log('Created mode dialog element:', modeDialog);
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
    console.log('Appended mode dialog to body. Dialog visible?', modeDialog.offsetHeight > 0);
    console.log('Dialog styles:', window.getComputedStyle(modeDialog).display, window.getComputedStyle(modeDialog).zIndex);

    const processMode = async (selectedMode: 'single' | 'random') => {
      // Bug #6 Fix: Add error handling around Tauri file picker
      try {
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
          // User selected files, return result (dialog cleanup happens in handlers)
          return { mode: selectedMode, files: selected };
        } else {
          // User cancelled file picker, return null
          return null;
        }
      } catch (error) {
        console.error('Error opening file picker:', error);
        return null;
      }
    };

    // Bug #3 Fix: Named handler functions for proper cleanup
    const cleanupDialog = () => {
      if (document.body.contains(modeDialog)) {
        document.body.removeChild(modeDialog);
      }
    };

    const result = await new Promise<{ mode: 'single' | 'random', files: string | string[] } | null>((resolve) => {
      // Get button references FIRST (before handlers that use them)
      const singleBtn = document.getElementById('mode-single');
      const randomBtn = document.getElementById('mode-random');
      const cancelBtn = document.getElementById('mode-cancel');

      // Named handler functions
      const handleSingleMode = async () => {
        const result = await processMode('single');
        // Bug #2 Fix: Always resolve, even if result is null
        cleanupDialog();
        // Bug #3 Fix: Remove listeners before resolving
        singleBtn?.removeEventListener('click', handleSingleMode);
        randomBtn?.removeEventListener('click', handleRandomMode);
        cancelBtn?.removeEventListener('click', handleCancel);
        modeDialog.removeEventListener('click', handleBackdropClick);
        resolve(result);
      };

      const handleRandomMode = async () => {
        const result = await processMode('random');
        // Bug #2 Fix: Always resolve, even if result is null
        cleanupDialog();
        // Bug #3 Fix: Remove listeners before resolving
        singleBtn?.removeEventListener('click', handleSingleMode);
        randomBtn?.removeEventListener('click', handleRandomMode);
        cancelBtn?.removeEventListener('click', handleCancel);
        modeDialog.removeEventListener('click', handleBackdropClick);
        resolve(result);
      };

      const handleCancel = () => {
        cleanupDialog();
        // Bug #3 Fix: Remove listeners before resolving
        singleBtn?.removeEventListener('click', handleSingleMode);
        randomBtn?.removeEventListener('click', handleRandomMode);
        cancelBtn?.removeEventListener('click', handleCancel);
        modeDialog.removeEventListener('click', handleBackdropClick);
        resolve(null);
      };

      // Bug #5 Fix: Add backdrop click handler
      const handleBackdropClick = (e: Event) => {
        if (e.target === modeDialog) {
          handleCancel();
        }
      };

      // Attach event listeners
      singleBtn?.addEventListener('click', handleSingleMode);
      randomBtn?.addEventListener('click', handleRandomMode);
      cancelBtn?.addEventListener('click', handleCancel);
      modeDialog.addEventListener('click', handleBackdropClick);
    });

    if (!result) return; // User cancelled

    const { mode, files: selected } = result;

    if (selected) {
      const files = Array.isArray(selected) ? selected : [selected];
      console.log('Processing files:', files);

      if (mode === 'random') {
        // Random mode: Store all files, pick one randomly
        const chosenFile = selectRandomFile(files);
        const fileName = chosenFile.split('/').pop() || chosenFile.split('\\').pop() || 'Unknown';

        const newTrack: Track = {
          id: generateTrackId(),
          type: 'background',
          name: `Music Track ${nextTrackId - 1}`,
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
          type: 'background',
          name: `Music Track ${nextTrackId - 1}`,
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
      populateMetadataTable();

      // Update the Music Pool UI to show all tracks
      renderMusicPoolUI();
    }
  } catch (error) {
    console.error('Error adding new track with files:', error);
  } finally {
    // Bug #1 Fix: Always reset flag in finally block
    isDialogOpen = false;
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

      // ✅ FIX: Separate audio tracks from background tracks
      // Only send 'audio' type tracks to the main audio processing
      // Background tracks should be handled separately or via bgMusicFile
      const audioTracks = timeline.tracks.filter(t => t.type === 'audio');
      const backgroundTracks = timeline.tracks.filter(t => t.type === 'background');

      console.log(`Audio tracks: ${audioTracks.length}, Background tracks: ${backgroundTracks.length}`);

      // ✅ Only include audio tracks that have clips
      const audioTracksWithClips = audioTracks.filter(t => t.clips.length > 0);

      if (audioTracksWithClips.length === 0) {
        showToast('No audio clips found in audio tracks. Please add audio clips to your timeline.', 'error');
        if (convertBtn) convertBtn.disabled = false;
        return;
      }

      // Prepare timeline data for Rust (only audio tracks, not background)
      const timelineData = {
        tracks: audioTracksWithClips.map(track => ({
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
        totalClips: timelineData.tracks.reduce((sum, t) => sum + t.clips.length, 0),
        audioOnly: true,
        backgroundTracksIgnored: backgroundTracks.length
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
    showToast('Please set your Vimeo access token in Settings first', 'error');
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

  const loadingToast = showLoadingToast(`Uploading "${videoTitle}" to Vimeo...`);

  try {
    const result = await invoke<string>('upload_to_vimeo', {
      videoPath: lastGeneratedVideo,
      accessToken: vimeoToken,
      title: videoTitle
    });

    updateToastSuccess(loadingToast, `Video uploaded successfully!`, result);

    if (resultMessage) {
      resultMessage.textContent = `Video uploaded to Vimeo successfully! ${result}`;
    }
  } catch (error) {
    console.error('Error uploading to Vimeo:', error);
    updateToastError(loadingToast, `Upload failed: ${error}`);

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

// Show processed videos modal with results
function showProcessedVideosModal() {
  const modal = document.getElementById('videos-result-modal');
  const tbody = document.getElementById('videos-result-tbody');

  if (!modal || !tbody) return;

  // Clear existing rows
  tbody.innerHTML = '';

  // Populate table with processed videos
  processedVideos.forEach((video, index) => {
    const row = document.createElement('tr');

    if (video.status === 'success') {
      row.innerHTML = `
        <td>${index + 1}</td>
        <td>${video.title}</td>
        <td>
          <button class="icon-btn preview-btn" data-index="${index}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Play
          </button>
        </td>
        <td>
          <button class="icon-btn reveal-btn" data-path="${video.videoPath}" title="Show in folder">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            Open
          </button>
        </td>
        <td>
          <button class="icon-btn publish-btn" data-index="${index}" data-video-path="${video.videoPath}" data-title="${video.title}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            Publish
          </button>
        </td>
      `;
    } else {
      row.innerHTML = `
        <td>${index + 1}</td>
        <td>${video.title}</td>
        <td><span class="failed-status" data-index="${index}" style="color: #ff6b6b; cursor: pointer; text-decoration: underline;" title="Click to see error">Failed</span></td>
        <td><span style="color: #999;">N/A</span></td>
        <td><span style="color: #999;">N/A</span></td>
      `;
    }

    tbody.appendChild(row);
  });

  // Add event listeners to preview buttons
  tbody.querySelectorAll('.preview-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const index = parseInt((e.currentTarget as HTMLElement).dataset.index || '0');
      previewVideo(index);
    });
  });

  // Add event listeners to reveal buttons (open in folder)
  tbody.querySelectorAll('.reveal-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget as HTMLElement;
      const path = target.dataset.path || '';
      if (path) {
        try {
          await invoke('reveal_in_folder', { path });
        } catch (error) {
          console.error('Failed to reveal file:', error);
        }
      }
    });
  });

  // Add event listeners to publish buttons
  tbody.querySelectorAll('.publish-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget as HTMLElement;
      const videoPath = target.dataset.videoPath || '';
      const title = target.dataset.title || '';

      // Upload to Vimeo
      await uploadSingleVideoToVimeo(videoPath, title, target as HTMLButtonElement);
    });
  });

  // Add event listeners to failed status to show error
  tbody.querySelectorAll('.failed-status').forEach(span => {
    span.addEventListener('click', (e) => {
      const index = parseInt((e.currentTarget as HTMLElement).dataset.index || '0');
      const video = processedVideos[index];
      if (video && video.error) {
        showToast(`Error: ${video.error}`, 'error', 8000);
      } else {
        showToast('Unknown error occurred during processing', 'error', 5000);
      }
    });
  });

  // Show modal
  modal.style.display = 'flex';
}

// Preview video in modal
function previewVideo(index: number) {
  const video = processedVideos[index];
  if (!video || video.status !== 'success') return;

  const previewModal = document.getElementById('video-preview-modal');
  const videoPlayer = document.getElementById('preview-video-player') as HTMLVideoElement;
  const titleElement = document.getElementById('preview-video-title');

  if (!previewModal || !videoPlayer) return;

  // Set video source
  videoPlayer.src = convertFileSrc(video.videoPath);
  if (titleElement) titleElement.textContent = video.title;

  // Show modal
  previewModal.style.display = 'flex';
}

// Upload single video to Vimeo
async function uploadSingleVideoToVimeo(videoPath: string, title: string, button: HTMLButtonElement) {
  if (!vimeoToken) {
    showToast('Please set your Vimeo access token in Settings first', 'error');
    return;
  }

  const originalText = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Uploading...';

  const loadingToast = showLoadingToast(`Uploading "${title}" to Vimeo...`);

  try {
    const result = await invoke<string>('upload_to_vimeo', {
      videoPath: videoPath,
      accessToken: vimeoToken,
      title: title
    });

    updateToastSuccess(loadingToast, `"${title}" uploaded successfully!`, result);

    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg> Uploaded`;
    button.style.color = '#51cf66';
  } catch (error) {
    console.error('Error uploading to Vimeo:', error);
    updateToastError(loadingToast, `Failed to upload "${title}": ${error}`);

    button.innerHTML = originalText;
    button.disabled = false;
  }
}

// Upload all videos to Vimeo
function showVimeoError(message: string) {
  const errorDiv = document.getElementById('vimeo-error-message');
  const errorText = document.getElementById('vimeo-error-text');
  if (errorDiv && errorText) {
    errorText.textContent = message;
    errorDiv.style.display = 'block';
  }
}

function hideVimeoError() {
  const errorDiv = document.getElementById('vimeo-error-message');
  if (errorDiv) {
    errorDiv.style.display = 'none';
  }
}

async function uploadAllVideosToVimeo() {
  console.log('uploadAllVideosToVimeo called');
  console.log('vimeoToken:', vimeoToken ? 'set' : 'not set');
  console.log('processedVideos:', processedVideos);

  if (!vimeoToken) {
    showVimeoError('Vimeo access token not set.');
    return;
  }

  hideVimeoError();

  const successfulVideos = processedVideos.filter(v => v.status === 'success');
  console.log('successfulVideos:', successfulVideos);

  if (successfulVideos.length === 0) {
    showVimeoError('No successful videos to upload.');
    return;
  }

  const publishAllBtn = document.getElementById('publish-all-btn') as HTMLButtonElement;
  if (publishAllBtn) {
    publishAllBtn.disabled = true;
    publishAllBtn.textContent = 'Uploading...';
  }

  let successCount = 0;
  let failCount = 0;
  const totalVideos = successfulVideos.length;

  const progressToast = showLoadingToast(`Uploading batch: 0/${totalVideos} videos...`);

  for (let i = 0; i < successfulVideos.length; i++) {
    const video = successfulVideos[i];

    // Update progress toast
    const messageDiv = progressToast.querySelector('.toast-message');
    if (messageDiv) {
      messageDiv.textContent = `Uploading: "${video.title}" (${i + 1}/${totalVideos})...`;
    }

    try {
      const result = await invoke<string>('upload_to_vimeo', {
        videoPath: video.videoPath,
        accessToken: vimeoToken,
        title: video.title
      });
      successCount++;
      console.log(`✅ Uploaded: ${video.title} -> ${result}`);
    } catch (error) {
      failCount++;
      console.error(`❌ Failed to upload ${video.title}:`, error);
    }
  }

  if (publishAllBtn) {
    publishAllBtn.disabled = false;
    publishAllBtn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="17 8 12 3 7 8"/>
        <line x1="12" y1="3" x2="12" y2="15"/>
      </svg>
      Publish All to Vimeo
    `;
  }

  // Update final status
  if (failCount === 0) {
    updateToastSuccess(progressToast, `All ${successCount} videos uploaded successfully!`);
  } else if (successCount === 0) {
    updateToastError(progressToast, `All ${failCount} uploads failed`);
  } else {
    // Show warning for partial success
    progressToast.className = 'toast toast-warning';
    const warningIcon = `<svg class="toast-icon toast-warning" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/>
    </svg>`;
    progressToast.innerHTML = `
      ${warningIcon}
      <div class="toast-message">Batch upload complete: ${successCount} succeeded, ${failCount} failed</div>
    `;
    setTimeout(() => {
      progressToast.classList.add('toast-fade-out');
      setTimeout(() => progressToast.remove(), 300);
    }, 6000);
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

  // Processed videos modal listeners
  document.querySelector('#close-videos-modal')?.addEventListener('click', () => {
    const modal = document.getElementById('videos-result-modal');
    if (modal) modal.style.display = 'none';
  });
  document.querySelector('#close-videos-modal-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('videos-result-modal');
    if (modal) modal.style.display = 'none';
  });
  // Publish all button - Vimeo only
  document.querySelector('#publish-all-btn')?.addEventListener('click', async () => {
    await uploadAllVideosToVimeo();
  });

  // Open settings link from Vimeo error message
  document.querySelector('#open-settings-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    // Close the videos modal
    const videosModal = document.getElementById('videos-result-modal');
    if (videosModal) videosModal.style.display = 'none';
    // Open settings modal
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal) settingsModal.style.display = 'flex';
  });

  // Video preview modal listeners
  document.querySelector('#close-preview-modal')?.addEventListener('click', () => {
    const modal = document.getElementById('video-preview-modal');
    const videoPlayer = document.getElementById('preview-video-player') as HTMLVideoElement;
    if (modal) modal.style.display = 'none';
    if (videoPlayer) {
      videoPlayer.pause();
      videoPlayer.src = '';
    }
  });
  document.querySelector('#close-preview-modal-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('video-preview-modal');
    const videoPlayer = document.getElementById('preview-video-player') as HTMLVideoElement;
    if (modal) modal.style.display = 'none';
    if (videoPlayer) {
      videoPlayer.pause();
      videoPlayer.src = '';
    }
  });

  // Close modals when clicking outside
  document.querySelector('#videos-result-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      const modal = document.getElementById('videos-result-modal');
      if (modal) modal.style.display = 'none';
    }
  });
  document.querySelector('#video-preview-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      const modal = document.getElementById('video-preview-modal');
      const videoPlayer = document.getElementById('preview-video-player') as HTMLVideoElement;
      if (modal) modal.style.display = 'none';
      if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.src = '';
      }
    }
  });

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

  // Reset All button listener
  document.querySelector('#reset-all')?.addEventListener('click', () => {
    clearProject();
  });

  // Theme toggle functionality with localStorage persistence
  const themeToggleBtn = document.querySelector('#theme-toggle-btn') as HTMLButtonElement;
  const sunIcon = document.querySelector('.theme-icon-sun') as HTMLElement;
  const moonIcon = document.querySelector('.theme-icon-moon') as HTMLElement;
  const themeLabel = document.querySelector('.theme-label') as HTMLElement;

  console.log('Theme toggle button found:', themeToggleBtn);
  console.log('Sun icon:', sunIcon);
  console.log('Moon icon:', moonIcon);
  console.log('Theme label:', themeLabel);

  if (themeToggleBtn) {
    // Load saved theme or default to 'dark'
    const savedTheme = localStorage.getItem('timeline-theme') || 'dark';
    console.log('Saved theme from localStorage:', savedTheme);

    // Function to apply theme globally to document.body
    function applyTheme(theme: string) {
      console.log('Applying theme:', theme);
      document.body.setAttribute('data-theme', theme);
      console.log('Body data-theme attribute set to:', document.body.getAttribute('data-theme'));

      // Update icons and label based on theme
      if (theme === 'light') {
        if (sunIcon) sunIcon.style.display = 'none';
        if (moonIcon) moonIcon.style.display = 'block';
        if (themeLabel) themeLabel.textContent = 'Light';
      } else {
        if (sunIcon) sunIcon.style.display = 'block';
        if (moonIcon) moonIcon.style.display = 'none';
        if (themeLabel) themeLabel.textContent = 'Dark';
      }
    }

    // Toggle theme on button click
    themeToggleBtn.addEventListener('click', () => {
      const currentTheme = document.body.getAttribute('data-theme') || 'dark';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      applyTheme(newTheme);
      localStorage.setItem('timeline-theme', newTheme);
    });

    // Apply saved theme on load
    applyTheme(savedTheme);
  }
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

// ============================================================================
// NEW BULK PROCESSING UI EVENT LISTENERS
// ============================================================================

// Initialize new bulk processing UI after a short delay to ensure DOM is ready
setTimeout(() => {
  const browseAudioBtn = document.getElementById('browse-audio-btn');
  const browseMusicBtn = document.getElementById('browse-music-btn');
  const browseImageBtn = document.getElementById('browse-image-btn');
  const audioDropZone = document.getElementById('audio-drop-zone');
  const musicDropZone = document.getElementById('music-drop-zone');

  console.log('Checking for bulk UI elements...');
  console.log('browseAudioBtn:', browseAudioBtn);

  if (browseAudioBtn) {
    console.log('🎵 Bulk processing UI detected - initializing...');

    // Browse Audio Files button
    browseAudioBtn.addEventListener('click', async () => {
      console.log('Browse audio clicked');
      await selectAudio();
    });
  }

  // Browse Music button
  if (browseMusicBtn) {
    browseMusicBtn.addEventListener('click', async () => {
      console.log('Browse music clicked');
      await addNewTrackWithFiles();
    });
  }

  // Browse Image button - use delegation on the drop zone
  const imageDropZone = document.getElementById('image-drop-zone');
  if (imageDropZone) {
    imageDropZone.addEventListener('click', async (e) => {
      // Only trigger if clicking the button or the drop zone itself (not SVG)
      const target = e.target as HTMLElement;
      if (target.id === 'browse-image-btn' || target.closest('#browse-image-btn') || target === imageDropZone) {
        e.preventDefault();
        e.stopPropagation();
        console.log('Browse image clicked');
        await selectImage();
      }
    });
  }

  // Background tab switching (Image/Solid Color)
  const bgTabs = document.querySelectorAll('.bg-tab');
  bgTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.getAttribute('data-tab');
      console.log('Background tab clicked:', targetTab);

      // Remove active class from all tabs and contents
      document.querySelectorAll('.bg-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.bg-content').forEach(c => c.classList.remove('active'));

      // Add active class to clicked tab and corresponding content
      tab.classList.add('active');
      const content = document.getElementById(`bg-${targetTab}-content`);
      if (content) {
        content.classList.add('active');
      }
    });
  });

  // Drag & Drop for audio files
  if (audioDropZone) {
    audioDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      audioDropZone.classList.add('dragover');
    });

    audioDropZone.addEventListener('dragleave', () => {
      audioDropZone.classList.remove('dragover');
    });

    audioDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      audioDropZone.classList.remove('dragover');
      console.log('Files dropped on audio zone');
    });

    // Click zone to browse
    audioDropZone.addEventListener('click', async (e) => {
      if (e.target === audioDropZone || (e.target as HTMLElement).closest('.drop-zone')) {
        console.log('Audio drop zone clicked');
        await selectAudio();
      }
    });
  }

  // Drag & Drop for music files
  if (musicDropZone) {
    musicDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      musicDropZone.classList.add('dragover');
    });

    musicDropZone.addEventListener('dragleave', () => {
      musicDropZone.classList.remove('dragover');
    });

    musicDropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      musicDropZone.classList.remove('dragover');
      console.log('Files dropped on music zone');
    });

    // Click zone to browse
    musicDropZone.addEventListener('click', async (e) => {
      if (e.target === musicDropZone || (e.target as HTMLElement).closest('.drop-zone')) {
        console.log('Music drop zone clicked');
        await addNewTrackWithFiles();
      }
    });
  }

  // Metadata table buttons
  const autoFillMetadataBtn = document.getElementById('auto-fill-metadata');
  if (autoFillMetadataBtn) {
    autoFillMetadataBtn.addEventListener('click', () => {
      console.log('Auto-fill metadata clicked');
      populateMetadataTable();
      showToast('Metadata auto-filled from filenames', 'success');
    });
  }

  // Process all videos button
  const processAllBtn = document.getElementById('process-all-btn');
  if (processAllBtn) {
    processAllBtn.addEventListener('click', async () => {
      console.log('Process all videos clicked');
      await processAllVideos();
    });
  }

  // Audio file list buttons
  const addMoreAudioBtn = document.getElementById('add-more-audio');
  console.log('addMoreAudioBtn:', addMoreAudioBtn);
  if (addMoreAudioBtn) {
    addMoreAudioBtn.addEventListener('click', async () => {
      console.log('Add more audio clicked');
      await selectAudio();
    });
  }

  const clearAudioBtn = document.getElementById('clear-audio');
  console.log('clearAudioBtn:', clearAudioBtn);
  if (clearAudioBtn) {
    clearAudioBtn.addEventListener('click', () => {
      console.log('Clear audio clicked');
      const audioTrack = timeline.tracks.find(t => t.name === 'Audio Files');
      if (audioTrack) {
        audioTrack.clips = [];
        renderTimeline();
        updateConvertButton();
        populateMetadataTable();

        // Hide audio list and show drop zone
        const audioList = document.getElementById('audio-list');
        const audioDropZone = document.getElementById('audio-drop-zone');
        const audioCount = document.getElementById('audio-count');

        if (audioList) audioList.style.display = 'none';
        if (audioDropZone) audioDropZone.style.display = 'flex';
        if (audioCount) audioCount.textContent = '0 files';

        showToast('All audio files cleared', 'success');
      }
    });
  }

  // Event delegation for individual audio file delete buttons
  const audioTable = document.getElementById('audio-table');
  if (audioTable) {
    audioTable.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest('[data-audio-index]');

      if (deleteBtn) {
        const index = parseInt(deleteBtn.getAttribute('data-audio-index') || '0');
        console.log('Delete audio file at index:', index);

        const audioTrack = timeline.tracks.find(t => t.name === 'Audio Files');
        if (audioTrack && audioTrack.clips[index]) {
          // Remove the clip
          audioTrack.clips.splice(index, 1);

          // Re-arrange remaining clips
          let currentTime = 0;
          for (const clip of audioTrack.clips) {
            clip.startTime = currentTime;
            currentTime += clip.duration;
          }

          renderTimeline();
          updateConvertButton();
          populateMetadataTable();

          // Update the UI list
          const audioList = document.getElementById('audio-list');
          const audioDropZone = document.getElementById('audio-drop-zone');
          const audioCount = document.getElementById('audio-count');

          if (audioTrack.clips.length === 0) {
            // No more files, hide list and show drop zone
            if (audioList) audioList.style.display = 'none';
            if (audioDropZone) audioDropZone.style.display = 'flex';
            if (audioCount) audioCount.textContent = '0 files';
          } else {
            // Rebuild the list
            audioTable.innerHTML = '';
            audioTrack.clips.forEach((clip, idx) => {
              const audioItem = createFileItem({
                fileName: clip.sourceName,
                index: idx,
                dataAttribute: 'data-audio-index'
              });
              audioTable.appendChild(audioItem);
            });

            if (audioCount) {
              audioCount.textContent = `${audioTrack.clips.length} file${audioTrack.clips.length !== 1 ? 's' : ''}`;
            }
          }

          showToast('Audio file removed', 'success');
        }
      }
    });
  }

  // Music file list buttons
  const addMoreMusicBtn = document.getElementById('add-more-music');
  console.log('addMoreMusicBtn:', addMoreMusicBtn);
  if (addMoreMusicBtn) {
    addMoreMusicBtn.addEventListener('click', async () => {
      console.log('Add more music clicked');
      await addNewTrackWithFiles();
    });
  }

  const clearMusicBtn = document.getElementById('clear-music');
  console.log('clearMusicBtn:', clearMusicBtn);
  if (clearMusicBtn) {
    clearMusicBtn.addEventListener('click', () => {
      console.log('Clear music clicked');
      // Remove all background tracks
      timeline.tracks = timeline.tracks.filter(t => t.type !== 'background');

      renderTimeline();
      updateConvertButton();
      populateMetadataTable();

      // Update the Music Pool UI
      renderMusicPoolUI();

      showToast('All music tracks cleared', 'success');
    });
  }

  // Color preset buttons
  const colorPresets = document.querySelectorAll('.color-preset');
  console.log('Color presets found:', colorPresets.length);
  colorPresets.forEach(preset => {
    preset.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const color = preset.getAttribute('data-color');
      const colorPicker = document.getElementById('bg-color-picker') as HTMLInputElement;
      console.log('Color preset clicked! Color:', color, 'Picker:', colorPicker);
      if (color && colorPicker) {
        colorPicker.value = color;
        console.log('Color picker value set to:', colorPicker.value);

        // Trigger input event so any listeners are notified
        const event = new Event('input', { bubbles: true });
        colorPicker.dispatchEvent(event);
      }
    });
  });

  // Event delegation for individual music file delete buttons
  const musicTable = document.getElementById('music-table');
  if (musicTable) {
    musicTable.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const deleteBtn = target.closest('[data-music-index]');

      if (deleteBtn) {
        const globalIndex = parseInt(deleteBtn.getAttribute('data-music-index') || '0');
        console.log('Delete music file at global index:', globalIndex);

        // Find which track and local index this global index maps to
        const backgroundTracks = timeline.tracks.filter(t => t.type === 'background');
        let currentGlobalIndex = 0;
        let targetTrack: Track | null = null;
        let localIndex = -1;

        for (const track of backgroundTracks) {
          const fileCount = track.mode === 'random' && track.randomPool
            ? track.randomPool.length
            : track.clips.length;

          if (globalIndex < currentGlobalIndex + fileCount) {
            targetTrack = track;
            localIndex = globalIndex - currentGlobalIndex;
            break;
          }
          currentGlobalIndex += fileCount;
        }

        if (targetTrack && localIndex >= 0) {
          // Remove the file from the track
          if (targetTrack.mode === 'random' && targetTrack.randomPool) {
            targetTrack.randomPool.splice(localIndex, 1);

            // If pool is empty, remove the track
            if (targetTrack.randomPool.length === 0) {
              timeline.tracks = timeline.tracks.filter(t => t.id !== targetTrack.id);
            }
          } else if (targetTrack.clips[localIndex]) {
            targetTrack.clips.splice(localIndex, 1);

            // If no more clips, remove the track
            if (targetTrack.clips.length === 0) {
              timeline.tracks = timeline.tracks.filter(t => t.id !== targetTrack.id);
            }
          }

          renderTimeline();
          updateConvertButton();
          populateMetadataTable();

          // Update the Music Pool UI
          renderMusicPoolUI();

          showToast('Music track removed', 'success');
        }
      }
    });
  }

  console.log('✅ Bulk processing UI initialized');
}, 100);
