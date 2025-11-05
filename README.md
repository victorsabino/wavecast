# MP3 to MP4 Converter

A beautiful cross-platform desktop application built with Tauri that converts audio files (MP3) to video files (MP4) with a static background image.

## Features

- **Select Background Image**: Choose any image (JPG, PNG) as your video background
- **Multiple Audio Files**: Select one or multiple MP3 files to combine into a single video
- **Background Styles**: Choose how the image should be displayed
  - **Fill (Cover)**: Scale and crop the image to fill the entire frame
  - **Fit (Contain)**: Scale the image to fit within the frame with padding
  - **Repeat**: Tile the image in a 2x2 pattern
  - **Center**: Center the image with padding
- **Playlist Management**: Add multiple audio files and remove them as needed
- **Progress Tracking**: Visual progress indicator during video conversion
- **Modern UI**: Clean, gradient-based interface with dark mode support

## Prerequisites

### FFmpeg Installation

This application requires FFmpeg to be installed on your system.

#### macOS
```bash
brew install ffmpeg
```

#### Windows
Download from [ffmpeg.org](https://ffmpeg.org/download.html) and add to PATH

#### Linux
```bash
sudo apt install ffmpeg  # Debian/Ubuntu
sudo dnf install ffmpeg  # Fedora
```

Verify installation:
```bash
ffmpeg -version
```

## Development

### Install Dependencies
```bash
npm install
```

### Run in Development Mode
```bash
npm run tauri dev
```

This will:
1. Start the Vite development server
2. Compile the Rust backend
3. Launch the desktop application

### Build for Production
```bash
npm run tauri build
```

The compiled application will be in `src-tauri/target/release/`.

## How It Works

### Frontend (TypeScript + HTML/CSS)
- File selection using Tauri's dialog plugin
- Playlist management for multiple audio files
- Modern, responsive UI with animations
- Dark mode support

### Backend (Rust)
- File system operations
- FFmpeg integration for video conversion
- Audio concatenation for multiple files
- Video encoding with configurable background styles

## Tech Stack

- **Tauri**: Cross-platform desktop framework
- **TypeScript**: Type-safe frontend development
- **Vite**: Fast frontend build tool
- **Rust**: High-performance backend
- **FFmpeg**: Audio/video processing

## Output

- Videos are saved as `output.mp4` in the same directory as your audio files
- Resolution: 1280x720 (720p)
- Video codec: H.264
- Audio codec: AAC (192kbps)
- Format: MP4

## Usage

1. **Launch the application**
2. **Select a background image** by clicking the "Background Image" area
3. **Choose your background style** from the dropdown (Fill, Fit, Repeat, Center)
4. **Select audio file(s)** by clicking the "Audio Files" area
   - You can select multiple MP3 files at once
   - They will be combined in the order selected
5. **Remove unwanted files** from the playlist using the X button
6. **Click "Convert to MP4"** to start the conversion
7. **Wait for the conversion** to complete
8. **Find your video** in the same folder as your audio files

## Notes

- Multiple audio files are automatically concatenated in the order they appear in the playlist
- The video duration matches the total audio duration
- Images are processed according to the selected background style
- The app checks for FFmpeg on startup and will show an error if not found

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
