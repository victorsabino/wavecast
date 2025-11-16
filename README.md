<div align="center">

![Wavecast Logo](./assets/logo.png)

# Wavecast

**Transform audio into video, at scale**

[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-24C8D8?style=for-the-badge&logo=tauri)](https://tauri.app)
[![Powered by FFmpeg](https://img.shields.io/badge/Powered%20by-FFmpeg-007808?style=for-the-badge&logo=ffmpeg)](https://ffmpeg.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)

**Bulk audio-to-video converter for content creators, podcasters, and musicians**

### [📥 Download Latest Release](https://github.com/victorsabino/wavecast/releases/latest)

[Windows](https://github.com/victorsabino/wavecast/releases/latest/download/Wavecast_1.0.0_x64_en-US.msi) • [macOS](https://github.com/victorsabino/wavecast/releases/latest/download/Wavecast_1.0.0_universal.dmg) • [Linux](https://github.com/victorsabino/wavecast/releases/latest/download/wavecast_1.0.0_amd64.AppImage)

</div>

---

## 🎯 What is Wavecast?

Wavecast is a powerful desktop application that transforms your audio files into professional videos with customizable backgrounds and music. Perfect for creating social media content, podcast clips, music visualizers, and more.

### Why Wavecast?

- ⚡ **Batch Processing**: Convert hundreds of audio files to videos in one go
- 🎨 **Custom Backgrounds**: Use images or solid colors
- 🎵 **Background Music**: Add music tracks with random assignment
- ✂️ **Timeline Editor**: Trim, arrange, and edit your audio clips visually
- 📊 **Bulk Metadata**: Edit titles and descriptions for all videos at once
- 🎬 **Export Ready**: Generate MP4, MOV, or WebM videos optimized for social media

---

## ✨ Features

### 🎬 Bulk Audio Processing
- Upload multiple audio files (MP3, WAV, M4A, OGG)
- Process up to 500 files simultaneously
- Automatic sequential arrangement on timeline
- Individual file deletion and management

### 🎨 Background Options
- **Image Backgrounds**: Upload your own images
  - Fill (Cover) - Scale and crop to fill the frame
  - Fit (Contain) - Scale to fit with padding
  - Repeat - Tile the image in a 2x2 pattern
  - Center - Center the image with padding
- **Solid Color Backgrounds**: Choose from presets or custom colors

### 🎵 Music Pool
- **Random Mode**: Upload multiple tracks, each video gets a random one
- **Sequential Mode**: Specific music for each video
- Adjustable volume mixing (main audio + background music)
- Loop background music automatically

### ✂️ Timeline Editor
- Visual waveform display
- Drag and drop clip arrangement
- Trim clips with precision handles
- Split clips at playhead
- Zoom controls for detailed editing
- Keyboard shortcuts for efficiency
- Copy/paste clips

### 📝 Metadata Management
- Bulk title and description editing
- Auto-fill from filenames
- Template system for consistent metadata
- Preview before export

### 🚀 Export & Publishing
- Real-time progress tracking
- Multiple format support (MP4, MOV, WebM)
- Quality presets (High, Medium, Low)
- Batch preview of rendered videos
- Direct upload to Vimeo

---

## 📥 Installation

### Prerequisites
- macOS 10.13+ / Windows 10+ / Linux
- 4GB RAM minimum (8GB recommended for large batches)
- 1GB free disk space
- **FFmpeg** (auto-downloaded on first use)

### Download

**Coming Soon**: Pre-built binaries for all platforms

### Build from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/wavecast.git
cd wavecast

# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

---

## 🎮 Usage

### Quick Start (5 Steps)

1. **Upload Audio Files**
   - Click "Browse Audio Files" or drag & drop
   - Supports MP3, WAV, M4A, OGG

2. **Add Music Pool** (Optional)
   - Choose "Random Mode" for variety
   - Upload multiple background tracks

3. **Set Background**
   - Upload an image OR choose a solid color
   - Select background style

4. **Edit Timeline** (Optional)
   - Arrange clips by dragging
   - Trim unwanted parts
   - Adjust volumes

5. **Export**
   - Review metadata
   - Click "Create All Videos"
   - Wait for batch processing to complete

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Space` | Play/Pause |
| `S` | Split clip at playhead |
| `Delete` | Delete selected clip |
| `Cmd/Ctrl + C` | Copy clip |
| `Cmd/Ctrl + V` | Paste clip |
| `+` / `-` | Zoom in/out |

---

## 🛠️ Tech Stack

### Frontend
- **Framework**: TypeScript + Vite
- **UI**: Custom CSS with modern design system
- **Waveforms**: WaveSurfer.js
- **State Management**: Vanilla TypeScript

### Backend
- **Runtime**: Tauri (Rust)
- **Video Processing**: FFmpeg
- **File Handling**: Rust std::fs
- **Image Processing**: image-rs

### Build & Deploy
- **Build Tool**: Vite
- **Desktop Framework**: Tauri
- **Package Manager**: npm

---

## 🏗️ Project Structure

```
wavecast/
├── src/                    # Frontend source
│   ├── main.ts            # Main application logic
│   ├── styles-new.css     # Application styles
│   └── index.html         # HTML template
├── src-tauri/             # Rust backend
│   ├── src/
│   │   ├── main.rs       # Tauri entry point
│   │   └── lib.rs        # Core functionality
│   ├── Cargo.toml        # Rust dependencies
│   └── tauri.conf.json   # Tauri configuration
├── assets/                # Logos and images
│   ├── logo.png          # Main logo
│   ├── icon.png          # App icon
│   └── logo-full.png     # Full logo with tagline
└── README.md             # This file
```

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

### Development Setup

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Run Tauri in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

---

## 📋 Roadmap

- [x] Bulk audio to video conversion
- [x] Timeline editor with waveforms
- [x] Random music pool
- [x] Solid color backgrounds
- [x] Bulk metadata editing
- [x] Vimeo integration
- [ ] YouTube integration
- [ ] Google Drive integration
- [ ] Video templates
- [ ] Audio effects (EQ, compression)
- [ ] Text overlays
- [ ] Animated backgrounds
- [ ] Cloud rendering
- [ ] Collaboration features

---

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Tauri](https://tauri.app) - Desktop app framework
- [FFmpeg](https://ffmpeg.org) - Video processing
- [WaveSurfer.js](https://wavesurfer-js.org) - Waveform visualizations
- [Vite](https://vitejs.dev) - Build tool

---

<div align="center">

**Made with ❤️ for content creators everywhere**

⭐ Star this repo if you find it useful!

![Wavecast Icon](./assets/icon.png)

</div>
