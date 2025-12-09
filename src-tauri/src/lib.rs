use std::path::PathBuf;
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::auto_download;
use ffmpeg_sidecar::event::FfmpegEvent;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Deserialize)]
struct VimeoUploadResponse {
    link: String,
}

#[derive(Clone, Serialize)]
struct ExportProgress {
    frame: u32,
    fps: f32,
    time: String,
    progress: f64,
}

// Timeline-based structures
#[derive(Serialize, Deserialize, Debug, Clone)]
struct TimelineClip {
    source_file: String,
    start_time: f64,
    duration: f64,
    trim_start: f64,
    trim_end: f64,
}

// Internal structure with track volume
#[derive(Debug, Clone)]
struct ClipWithVolume {
    clip: TimelineClip,
    track_volume: f64,
}

#[derive(Serialize, Deserialize, Debug)]
struct TimelineTrack {
    clips: Vec<TimelineClip>,
    volume: f64,
}

#[derive(Serialize, Deserialize, Debug)]
struct TimelineData {
    tracks: Vec<TimelineTrack>,
}

// Project data structure for export/import
#[derive(Serialize, Deserialize, Debug)]
struct ProjectClip {
    id: String,
    source_file: String,
    source_name: String,
    track_id: String,
    start_time: f64,
    duration: f64,
    trim_start: f64,
    trim_end: f64,
    source_duration: f64,
}

#[derive(Serialize, Deserialize, Debug)]
struct ProjectTrack {
    id: String,
    track_type: String,
    name: String,
    clips: Vec<ProjectClip>,
    volume: f64,
    muted: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct ProjectData {
    version: String,
    background_image: Option<String>,
    background_color: Option<String>,
    background_type: String, // "image" or "color"
    background_style: String,
    tracks: Vec<ProjectTrack>,
    video_title: String,
    video_description: String,
}

fn parse_time_to_seconds(time_str: &str) -> f64 {
    // Parse FFmpeg time format (HH:MM:SS.ms or just seconds)
    let parts: Vec<&str> = time_str.split(':').collect();

    match parts.len() {
        1 => {
            // Just seconds (e.g., "123.45")
            time_str.parse::<f64>().unwrap_or(0.0)
        }
        3 => {
            // HH:MM:SS.ms format
            let hours: f64 = parts[0].parse().unwrap_or(0.0);
            let minutes: f64 = parts[1].parse().unwrap_or(0.0);
            let seconds: f64 = parts[2].parse().unwrap_or(0.0);
            hours * 3600.0 + minutes * 60.0 + seconds
        }
        _ => 0.0
    }
}

fn generate_filter_complex(clips: &[ClipWithVolume], unique_sources: &[String], main_volume: f64, has_bg_music: bool) -> String {
    if clips.is_empty() {
        return String::new();
    }

    let mut filter_parts = Vec::new();

    for (i, clip_with_vol) in clips.iter().enumerate() {
        let clip = &clip_with_vol.clip;
        let track_vol = clip_with_vol.track_volume;

        // Find the input index for this clip's source file
        // Offset by 1 for the image input (always at index 0)
        // If background music exists, offset by an additional 1 (bg music at index 1)
        let base_offset = if has_bg_music { 2 } else { 1 };
        let input_idx = unique_sources.iter().position(|s| s == &clip.source_file).unwrap() + base_offset;

        eprintln!("  Clip {}: source '{}' -> FFmpeg input index {}, track volume: {}", i, clip.source_file, input_idx, track_vol);

        // Create filter for each clip: trim, adjust timing, delay to position, apply track volume
        let trim_end = clip.duration + clip.trim_start;
        let delay_ms = (clip.start_time * 1000.0) as i64;

        // Apply track volume to each clip individually
        filter_parts.push(format!(
            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,volume={},adelay={}|{}[a{}]",
            input_idx, clip.trim_start, trim_end, track_vol, delay_ms, delay_ms, i
        ));
    }

    // Mix all audio streams
    let stream_labels: Vec<String> = (0..clips.len()).map(|i| format!("[a{}]", i)).collect();
    filter_parts.push(format!(
        "{}amix=inputs={}:duration=longest,volume={}[aout]",
        stream_labels.join(""),
        clips.len(),
        main_volume
    ));

    filter_parts.join(";")
}

#[tauri::command]
fn create_solid_color_image(color: String, width: u32, height: u32) -> Result<String, String> {
    // Parse hex color
    let color_str = color.trim_start_matches('#');
    let r = u8::from_str_radix(&color_str[0..2], 16).map_err(|e| format!("Invalid color: {}", e))?;
    let g = u8::from_str_radix(&color_str[2..4], 16).map_err(|e| format!("Invalid color: {}", e))?;
    let b = u8::from_str_radix(&color_str[4..6], 16).map_err(|e| format!("Invalid color: {}", e))?;

    // Create a simple PNG using raw RGBA data
    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let temp_path = temp_dir.join(format!("solid_color_{}.png", timestamp));

    // Create image buffer
    let mut imgbuf = image::ImageBuffer::new(width, height);

    // Fill with solid color
    for pixel in imgbuf.pixels_mut() {
        *pixel = image::Rgb([r, g, b]);
    }

    // Save the image
    imgbuf.save(&temp_path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(temp_path.to_str().unwrap().to_string())
}

#[tauri::command]
fn convert_timeline_to_video(
    app: tauri::AppHandle,
    image_path: String,
    timeline: TimelineData,
    background_style: String,
    bg_music_path: Option<String>,
    bg_music_volume: i32,
    main_audio_volume: i32,
    output_filename: Option<String>,
) -> Result<String, String> {
    eprintln!("=== Starting timeline-based video conversion ===");
    eprintln!("Image path: {}", image_path);
    eprintln!("Timeline tracks: {}", timeline.tracks.len());
    eprintln!("Background style: {}", background_style);
    eprintln!("Main audio volume: {}", main_audio_volume);
    eprintln!("BG music path: {:?}", bg_music_path);
    eprintln!("BG music volume: {}", bg_music_volume);

    // Download FFmpeg if not present
    eprintln!("Checking for FFmpeg...");
    auto_download().map_err(|e| {
        let err_msg = format!("Failed to download FFmpeg: {}", e);
        eprintln!("ERROR: {}", err_msg);
        err_msg
    })?;
    eprintln!("FFmpeg ready");

    // Get all clips from all audio tracks with their track volumes
    let mut all_clips: Vec<ClipWithVolume> = Vec::new();
    for (i, track) in timeline.tracks.iter().enumerate() {
        eprintln!("Track {}: {} clips, volume: {}", i, track.clips.len(), track.volume);
        for clip in &track.clips {
            all_clips.push(ClipWithVolume {
                clip: clip.clone(),
                track_volume: track.volume,
            });
        }
    }

    if all_clips.is_empty() {
        let err_msg = "No audio clips in timeline".to_string();
        eprintln!("ERROR: {}", err_msg);
        return Err(err_msg);
    }
    eprintln!("Total clips to process: {}", all_clips.len());

    // Create output path
    let first_clip_with_vol = &all_clips[0];
    eprintln!("First clip source: {}", first_clip_with_vol.clip.source_file);
    let audio_dir = PathBuf::from(&first_clip_with_vol.clip.source_file)
        .parent()
        .ok_or_else(|| {
            eprintln!("ERROR: Could not determine audio directory");
            "Could not determine audio directory".to_string()
        })?
        .to_path_buf();
    eprintln!("Output directory: {}", audio_dir.display());

    // Use provided filename or default to "output.mp4"
    let output_name = output_filename
        .map(|name| {
            // Sanitize filename: remove invalid characters and ensure .mp4 extension
            let sanitized = name
                .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_")
                .trim()
                .to_string();
            if sanitized.to_lowercase().ends_with(".mp4") {
                sanitized
            } else {
                format!("{}.mp4", sanitized)
            }
        })
        .unwrap_or_else(|| "output.mp4".to_string());

    let output_path = audio_dir.join(&output_name);
    eprintln!("Output path: {}", output_path.display());

    // Determine filter based on background style
    let video_filter = match background_style.as_str() {
        "cover" => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        "contain" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "repeat" => "tile=2x2",
        "center" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        _ => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
    };

    let main_volume = main_audio_volume as f64 / 100.0;

    // Build FFmpeg command with all input files
    let mut cmd = FfmpegCommand::new();

    // IMPORTANT: -loop 1 must come BEFORE the image input
    cmd.args(&["-loop", "1"]);
    cmd.input(&image_path);

    // Add background music as input if provided
    let has_bg_music = bg_music_path.is_some();
    if let Some(ref music_path) = bg_music_path {
        eprintln!("Adding background music input: {}", music_path);
        cmd.input(music_path);
    }

    // Add each unique source file as input
    let mut unique_sources: Vec<String> = Vec::new();
    for clip_with_vol in &all_clips {
        if !unique_sources.contains(&clip_with_vol.clip.source_file) {
            unique_sources.push(clip_with_vol.clip.source_file.clone());
        }
    }

    for source in &unique_sources {
        cmd.input(source);
    }

    // Generate audio filter complex
    eprintln!("Generating audio filter complex...");
    let mut audio_filter = generate_filter_complex(&all_clips, &unique_sources, main_volume, has_bg_music);

    // If background music is provided, mix it with the main audio
    if has_bg_music {
        let bg_volume = bg_music_volume as f64 / 100.0;
        eprintln!("Adding background music mixing (volume: {})", bg_volume);

        // The filter complex from generate_filter_complex outputs to [aout]
        // We need to mix it with the background music (input 1)
        // Input 0: image
        // Input 1: background music (if provided)
        // Input 2+: audio clips

        audio_filter = format!(
            "{};[1:a]aloop=loop=-1:size=2e+09,volume={}[bgmusic];[aout][bgmusic]amix=inputs=2:duration=first:dropout_transition=2[final]",
            audio_filter, bg_volume
        );
    }

    eprintln!("Final audio filter complex: {}", audio_filter);

    let audio_output_label = if has_bg_music { "[final]" } else { "[aout]" };

    cmd.args(&[
        "-vf", video_filter,
        "-filter_complex", &audio_filter,
        "-map", "0:v",
        "-map", audio_output_label,
        "-c:v", "libx264",
        "-tune", "stillimage",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-shortest",
        "-progress", "pipe:1"
    ])
    .overwrite()
    .output(output_path.to_str().unwrap());

    // Log the complete FFmpeg command for debugging
    eprintln!("=== FFmpeg Command Debug ===");
    eprintln!("Image path: {}", image_path);
    if has_bg_music {
        if let Some(ref music_path) = bg_music_path {
            eprintln!("Music path: {}", music_path);
        }
    }
    eprintln!("Unique audio sources: {:?}", unique_sources);
    eprintln!("Video filter: {}", video_filter);
    eprintln!("Audio filter: {}", audio_filter);
    eprintln!("Output path: {}", output_path.display());
    eprintln!("===========================");

    // Spawn process and capture events
    eprintln!("Spawning FFmpeg process...");
    let mut child = cmd.spawn()
        .map_err(|e| {
            let err_msg = format!("Failed to spawn FFmpeg: {}", e);
            eprintln!("ERROR: {}", err_msg);
            err_msg
        })?;
    eprintln!("FFmpeg process started");

    // Calculate total duration for progress percentage
    let total_duration: f64 = all_clips.iter()
        .map(|clip_with_vol| clip_with_vol.clip.start_time + clip_with_vol.clip.duration)
        .fold(0.0, f64::max);
    eprintln!("Total duration: {:.2}s", total_duration);

    // Iterate over FFmpeg events
    eprintln!("Processing FFmpeg output...");
    let iter = child.iter()
        .map_err(|e| {
            let err_msg = format!("Failed to get FFmpeg iterator: {}", e);
            eprintln!("ERROR: {}", err_msg);
            err_msg
        })?;

    for event in iter {
        match event {
            FfmpegEvent::Progress(progress) => {
                // Parse time string (format: "HH:MM:SS.ms" or similar)
                let current_time = parse_time_to_seconds(&progress.time);
                let progress_pct = if total_duration > 0.0 {
                    (current_time / total_duration * 100.0).min(100.0)
                } else {
                    0.0
                };

                let progress_data = ExportProgress {
                    frame: progress.frame,
                    fps: progress.fps,
                    time: progress.time.clone(),
                    progress: progress_pct,
                };

                // Emit progress event
                let _ = app.emit("export-progress", progress_data);
            }
            FfmpegEvent::Log(_level, msg) => {
                // Optionally log messages
                eprintln!("FFmpeg: {}", msg);
            }
            _ => {}
        }
    }

    // Wait for completion
    eprintln!("Waiting for FFmpeg to complete...");
    let result = child.wait()
        .map_err(|e| {
            let err_msg = format!("Failed to execute FFmpeg: {}", e);
            eprintln!("ERROR: {}", err_msg);
            err_msg
        })?;

    if !result.success() {
        let err_msg = "FFmpeg encoding failed".to_string();
        eprintln!("ERROR: {}", err_msg);
        eprintln!("ERROR CONTEXT:");
        eprintln!("  - Image: {}", image_path);
        eprintln!("  - Audio sources: {:?}", unique_sources);
        eprintln!("  - Video filter: {}", video_filter);
        eprintln!("  - Audio filter: {}", audio_filter);
        eprintln!("  - Has BG music: {}", has_bg_music);
        eprintln!("  - Exit code: {:?}", result.code());
        return Err(err_msg);
    }

    eprintln!("=== Timeline video conversion completed successfully ===");
    eprintln!("Output file: {}", output_path.display());
    Ok(output_path.to_str().unwrap().to_string())
}

#[tauri::command]
fn convert_to_video(
    image_path: String,
    audio_paths: Vec<String>,
    background_style: String,
    bg_music_path: Option<String>,
    bg_music_volume: i32,
    main_audio_volume: i32,
) -> Result<String, String> {
    eprintln!("=== Starting video conversion ===");
    eprintln!("Image path: {}", image_path);
    eprintln!("Audio paths: {:?}", audio_paths);
    eprintln!("Background style: {}", background_style);
    eprintln!("BG music path: {:?}", bg_music_path);
    eprintln!("BG music volume: {}", bg_music_volume);
    eprintln!("Main audio volume: {}", main_audio_volume);

    // Download FFmpeg if not present (will use cached version if available)
    eprintln!("Checking for FFmpeg...");
    auto_download().map_err(|e| {
        let err_msg = format!("Failed to download FFmpeg: {}", e);
        eprintln!("ERROR: {}", err_msg);
        err_msg
    })?;
    eprintln!("FFmpeg ready");

    // Create output path in the same directory as the first audio file
    let first_audio = audio_paths.first()
        .ok_or_else(|| {
            eprintln!("ERROR: No audio files provided");
            "No audio files provided".to_string()
        })?;
    eprintln!("First audio file: {}", first_audio);

    let audio_dir = PathBuf::from(first_audio)
        .parent()
        .ok_or_else(|| {
            eprintln!("ERROR: Could not determine audio directory from path: {}", first_audio);
            "Could not determine audio directory".to_string()
        })?
        .to_path_buf();
    eprintln!("Output directory: {}", audio_dir.display());

    let output_path = audio_dir.join("output.mp4");
    eprintln!("Output path: {}", output_path.display());

    // If multiple audio files, concatenate them first
    let final_audio_path = if audio_paths.len() > 1 {
        eprintln!("Multiple audio files detected, concatenating {} files...", audio_paths.len());
        let concat_list_path = audio_dir.join("concat_list.txt");

        // Create concat file
        // Convert backslashes to forward slashes for FFmpeg compatibility on Windows
        let concat_content = audio_paths
            .iter()
            .map(|p| {
                let normalized_path = p.replace('\\', "/");
                format!("file '{}'", normalized_path)
            })
            .collect::<Vec<_>>()
            .join("\n");

        std::fs::write(&concat_list_path, &concat_content)
            .map_err(|e| {
                let err_msg = format!("Failed to create concat list: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?;
        eprintln!("Created concat list at: {}", concat_list_path.display());

        let temp_audio = audio_dir.join("temp_combined.mp3");
        eprintln!("Concatenating to: {}", temp_audio.display());

        // Concatenate audio files
        let mut concat_cmd = FfmpegCommand::new();
        concat_cmd
            .format("concat")
            .input(concat_list_path.to_str().unwrap())
            .args(&["-safe", "0", "-c", "copy"])
            .overwrite()
            .output(temp_audio.to_str().unwrap());

        eprintln!("Running FFmpeg concat command...");
        let concat_result = concat_cmd.spawn()
            .map_err(|e| {
                let err_msg = format!("Failed to spawn FFmpeg concat: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?
            .wait()
            .map_err(|e| {
                let err_msg = format!("Failed to concatenate audio: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?;

        if !concat_result.success() {
            let err_msg = "FFmpeg concatenation failed".to_string();
            eprintln!("ERROR: {}", err_msg);
            return Err(err_msg);
        }
        eprintln!("Audio concatenation successful");

        // Clean up concat list
        let _ = std::fs::remove_file(concat_list_path);

        temp_audio.to_str().unwrap().to_string()
    } else {
        eprintln!("Single audio file, no concatenation needed");
        audio_paths[0].clone()
    };
    eprintln!("Final audio path: {}", final_audio_path);

    // Determine filter based on background style
    let video_filter = match background_style.as_str() {
        "cover" => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        "contain" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "repeat" => "tile=2x2",
        "center" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        _ => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
    };
    eprintln!("Video filter: {}", video_filter);

    // Calculate volumes as decimals (0-100 -> 0.0-1.0)
    let main_volume = main_audio_volume as f32 / 100.0;
    eprintln!("Main volume: {}", main_volume);

    // If background music is provided, we need to mix the audio
    let _output = if let Some(bg_music) = bg_music_path {
        eprintln!("Background music detected: {}", bg_music);
        let bg_volume = bg_music_volume as f32 / 100.0;
        eprintln!("Background music volume: {}", bg_volume);

        // Create audio filter for mixing: loop bg music, adjust volumes, and mix
        let audio_filter = format!(
            "[1:a]aloop=loop=-1:size=2e+09[bg];[bg]volume={}[bg_vol];[0:a]volume={}[main];[bg_vol][main]amix=inputs=2:duration=first:dropout_transition=2",
            bg_volume, main_volume
        );
        eprintln!("Audio filter: {}", audio_filter);

        let mut cmd = FfmpegCommand::new();
        cmd
            .args(&["-loop", "1"])
            .input(&image_path)
            .input(&bg_music)
            .input(&final_audio_path)
            .args(&[
                "-vf", video_filter,
                "-filter_complex", &audio_filter,
                "-c:v", "libx264",
                "-tune", "stillimage",
                "-c:a", "aac",
                "-b:a", "192k",
                "-pix_fmt", "yuv420p",
                "-shortest"
            ])
            .overwrite()
            .output(output_path.to_str().unwrap());

        eprintln!("Running FFmpeg with background music...");
        let result = cmd.spawn()
            .map_err(|e| {
                let err_msg = format!("Failed to spawn FFmpeg: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?
            .wait()
            .map_err(|e| {
                let err_msg = format!("Failed to execute FFmpeg: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?;

        if !result.success() {
            let err_msg = "FFmpeg encoding failed (with background music)".to_string();
            eprintln!("ERROR: {}", err_msg);
            return Err(err_msg);
        }
        eprintln!("FFmpeg encoding successful (with background music)");
        result
    } else {
        // No background music, but still apply main audio volume
        eprintln!("No background music, encoding with main audio only");
        let audio_filter = format!("volume={}", main_volume);
        eprintln!("Audio filter: {}", audio_filter);

        let mut cmd = FfmpegCommand::new();
        cmd
            .args(&["-loop", "1"])
            .input(&image_path)
            .input(&final_audio_path)
            .args(&[
                "-vf", video_filter,
                "-af", &audio_filter,
                "-c:v", "libx264",
                "-tune", "stillimage",
                "-c:a", "aac",
                "-b:a", "192k",
                "-pix_fmt", "yuv420p",
                "-shortest"
            ])
            .overwrite()
            .output(output_path.to_str().unwrap());

        eprintln!("Running FFmpeg without background music...");
        let result = cmd.spawn()
            .map_err(|e| {
                let err_msg = format!("Failed to spawn FFmpeg: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?
            .wait()
            .map_err(|e| {
                let err_msg = format!("Failed to execute FFmpeg: {}", e);
                eprintln!("ERROR: {}", err_msg);
                err_msg
            })?;

        if !result.success() {
            let err_msg = "FFmpeg encoding failed (without background music)".to_string();
            eprintln!("ERROR: {}", err_msg);
            return Err(err_msg);
        }
        eprintln!("FFmpeg encoding successful (without background music)");
        result
    };

    // Clean up temporary combined audio if it exists
    if audio_paths.len() > 1 {
        eprintln!("Cleaning up temporary concatenated audio file...");
        let temp_audio = audio_dir.join("temp_combined.mp3");
        let _ = std::fs::remove_file(temp_audio);
    }

    eprintln!("=== Video conversion completed successfully ===");
    eprintln!("Output file: {}", output_path.display());
    Ok(output_path.to_str().unwrap().to_string())
}

#[tauri::command]
async fn upload_to_vimeo(
    video_path: String,
    access_token: String,
    title: String,
) -> Result<String, String> {
    // Read the video file
    let video_data = std::fs::read(&video_path)
        .map_err(|e| format!("Failed to read video file: {}", e))?;

    // Create HTTP client
    let client = reqwest::Client::new();

    // Step 1: Create upload request
    let create_response = client
        .post("https://api.vimeo.com/me/videos")
        .header("Authorization", format!("bearer {}", access_token))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "upload": {
                "approach": "post",
                "size": video_data.len().to_string()
            },
            "name": title
        }))
        .send()
        .await
        .map_err(|e| format!("Failed to create upload: {}", e))?;

    if !create_response.status().is_success() {
        let error_text = create_response.text().await.unwrap_or_default();
        return Err(format!("Vimeo API error: {}", error_text));
    }

    let create_json: serde_json::Value = create_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let upload_link = create_json["upload"]["upload_link"]
        .as_str()
        .ok_or("No upload link in response")?;

    let video_uri = create_json["uri"]
        .as_str()
        .ok_or("No video URI in response")?;

    // Step 2: Upload the video file
    let upload_response = client
        .post(upload_link)
        .header("Tus-Resumable", "1.0.0")
        .header("Upload-Offset", "0")
        .header("Content-Type", "application/offset+octet-stream")
        .body(video_data)
        .send()
        .await
        .map_err(|e| format!("Failed to upload video: {}", e))?;

    if !upload_response.status().is_success() {
        let error_text = upload_response.text().await.unwrap_or_default();
        return Err(format!("Upload failed: {}", error_text));
    }

    let video_link = format!("https://vimeo.com{}", video_uri.replace("/videos/", "/"));
    Ok(video_link)
}

#[tauri::command]
async fn export_project(
    app: tauri::AppHandle,
    project_data: ProjectData,
) -> Result<String, String> {
    // Show save dialog
    let file_path = app.dialog()
        .file()
        .set_title("Export Project")
        .add_filter("JSON", &["json"])
        .set_file_name("project.json")
        .blocking_save_file();

    if let Some(path) = file_path {
        let json_string = serde_json::to_string_pretty(&project_data)
            .map_err(|e| format!("Failed to serialize project: {}", e))?;

        let path_str = path.as_path()
            .ok_or("Failed to get path")?;

        std::fs::write(path_str, json_string)
            .map_err(|e| format!("Failed to write file: {}", e))?;

        Ok(path_str.to_string_lossy().to_string())
    } else {
        Err("Save cancelled".to_string())
    }
}

#[tauri::command]
async fn import_project(
    app: tauri::AppHandle,
) -> Result<ProjectData, String> {
    // Show open dialog
    let file_path = app.dialog()
        .file()
        .set_title("Import Project")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();

    if let Some(path) = file_path {
        let path_str = path.as_path()
            .ok_or("Failed to get path")?;

        let json_string = std::fs::read_to_string(path_str)
            .map_err(|e| format!("Failed to read file: {}", e))?;

        let project_data: ProjectData = serde_json::from_str(&json_string)
            .map_err(|e| format!("Failed to parse project file: {}", e))?;

        Ok(project_data)
    } else {
        Err("Open cancelled".to_string())
    }
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try xdg-open on the parent directory
        if let Some(parent) = path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to reveal file: {}", e))?;
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![convert_to_video, convert_timeline_to_video, upload_to_vimeo, export_project, import_project, create_solid_color_image, reveal_in_folder])
        .setup(|app| {
            // File menu
            let export_project_item = MenuItemBuilder::with_id("export_project", "Export Project")
                .accelerator("CmdOrCtrl+E")
                .build(app)?;
            let import_project_item = MenuItemBuilder::with_id("import_project", "Import Project")
                .accelerator("CmdOrCtrl+I")
                .build(app)?;
            let clear_project_item = MenuItemBuilder::with_id("clear_project", "Clear Project")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?;
            let upload_item = MenuItemBuilder::with_id("upload", "Upload to Vimeo")
                .accelerator("CmdOrCtrl+U")
                .build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&export_project_item)
                .item(&import_project_item)
                .item(&clear_project_item)
                .separator()
                .item(&upload_item)
                .separator()
                .item(&settings_item)
                .separator()
                .close_window()
                .build()?;

            // Edit menu
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            // Help menu
            let about_item = MenuItemBuilder::with_id("about", "About Vimeo MP3 Uploader").build(app)?;

            let help_menu = SubmenuBuilder::new(app, "Help")
                .item(&about_item)
                .build()?;

            // Build the menu
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&help_menu)
                .build()?;

            app.set_menu(menu)?;

            // Handle menu events
            app.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "settings" => {
                        let _ = app.emit("open-settings", ());
                    }
                    "about" => {
                        let _ = app.emit("open-about", ());
                    }
                    "export_project" => {
                        let _ = app.emit("export-project", ());
                    }
                    "import_project" => {
                        let _ = app.emit("import-project", ());
                    }
                    "clear_project" => {
                        let _ = app.emit("clear-project", ());
                    }
                    "upload" => {
                        let _ = app.emit("upload-video", ());
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
