import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";

interface AudioFile {
  path: string;
  name: string;
  duration?: number;
}

let currentAudio: HTMLAudioElement | null = null;
let currentPlayingIndex: number | null = null;

let selectedImage: string | null = null;
let audioFiles: AudioFile[] = [];
let backgroundStyle: string = "cover";
let lastGeneratedVideo: string | null = null;
let vimeoToken: string = "";
let videoTitle: string = "Converted Video";
let autoUpload: boolean = false;
let bgMusicFile: string | null = null;
let bgMusicVolume: number = 30;
let mainAudioVolume: number = 100;

// DOM Elements
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

function updateConvertButton() {
  if (convertBtn) {
    convertBtn.disabled = !selectedImage || audioFiles.length === 0;
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

      files.forEach((filePath: string) => {
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';

        // Check if file already exists
        if (!audioFiles.some(f => f.path === filePath)) {
          audioFiles.push({ path: filePath, name: fileName });
        }
      });

      renderPlaylist();
      renderAssemblyPreview();
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
  if (!selectedImage || audioFiles.length === 0) return;

  // Show progress
  if (progressSection && resultSection) {
    progressSection.style.display = 'block';
    resultSection.style.display = 'none';
  }

  if (convertBtn) {
    convertBtn.disabled = true;
  }

  try {
    const result = await invoke<string>('convert_to_video', {
      imagePath: selectedImage,
      audioPaths: audioFiles.map(f => f.path),
      backgroundStyle: backgroundStyle,
      bgMusicPath: bgMusicFile,
      bgMusicVolume: bgMusicVolume,
      mainAudioVolume: mainAudioVolume
    });

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
});
