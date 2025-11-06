use std::path::PathBuf;
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::auto_download;
use ffmpeg_sidecar::event::FfmpegEvent;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

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

#[derive(Serialize, Deserialize, Debug)]
struct TimelineTrack {
    clips: Vec<TimelineClip>,
    volume: f64,
}

#[derive(Serialize, Deserialize, Debug)]
struct TimelineData {
    tracks: Vec<TimelineTrack>,
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

fn generate_filter_complex(clips: &[TimelineClip], main_volume: f64) -> String {
    if clips.is_empty() {
        return String::new();
    }

    let mut filter_parts = Vec::new();

    for (i, clip) in clips.iter().enumerate() {
        // Create filter for each clip: trim, adjust timing, delay to position
        let trim_end = clip.duration + clip.trim_start;
        let delay_ms = (clip.start_time * 1000.0) as i64;

        filter_parts.push(format!(
            "[{}:a]atrim=start={}:end={},asetpts=PTS-STARTPTS,adelay={}|{}[a{}]",
            i, clip.trim_start, trim_end, delay_ms, delay_ms, i
        ));
    }

    // Mix all audio streams
    let stream_labels: Vec<String> = (0..clips.len()).map(|i| format!("[a{}]", i)).collect();
    filter_parts.push(format!(
        "{}amix=inputs={}:duration=longest,volume={}",
        stream_labels.join(""),
        clips.len(),
        main_volume
    ));

    filter_parts.join(";")
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
) -> Result<String, String> {
    // Download FFmpeg if not present
    auto_download().map_err(|e| format!("Failed to download FFmpeg: {}", e))?;

    // Get all clips from all audio tracks
    let mut all_clips: Vec<TimelineClip> = Vec::new();
    for track in &timeline.tracks {
        all_clips.extend(track.clips.clone());
    }

    if all_clips.is_empty() {
        return Err("No audio clips in timeline".to_string());
    }

    // Create output path
    let first_clip = &all_clips[0];
    let audio_dir = PathBuf::from(&first_clip.source_file)
        .parent()
        .ok_or("Could not determine audio directory")?
        .to_path_buf();

    let output_path = audio_dir.join("output.mp4");

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
    cmd.input(&image_path);

    // Add each unique source file as input
    let mut unique_sources: Vec<String> = Vec::new();
    for clip in &all_clips {
        if !unique_sources.contains(&clip.source_file) {
            unique_sources.push(clip.source_file.clone());
        }
    }

    for source in &unique_sources {
        cmd.input(source);
    }

    // Generate audio filter complex
    let audio_filter = generate_filter_complex(&all_clips, main_volume);

    cmd.args(&[
        "-loop", "1",
        "-vf", video_filter,
        "-filter_complex", &audio_filter,
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

    // Spawn process and capture events
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn FFmpeg: {}", e))?;

    // Calculate total duration for progress percentage
    let total_duration: f64 = all_clips.iter()
        .map(|clip| clip.start_time + clip.duration)
        .fold(0.0, f64::max);

    // Iterate over FFmpeg events
    let iter = child.iter()
        .map_err(|e| format!("Failed to get FFmpeg iterator: {}", e))?;

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
                println!("FFmpeg: {}", msg);
            }
            _ => {}
        }
    }

    // Wait for completion
    let result = child.wait()
        .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?;

    if !result.success() {
        return Err("FFmpeg encoding failed".to_string());
    }

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
    // Download FFmpeg if not present (will use cached version if available)
    auto_download().map_err(|e| format!("Failed to download FFmpeg: {}", e))?;

    // Create output path in the same directory as the first audio file
    let first_audio = audio_paths.first()
        .ok_or("No audio files provided")?;

    let audio_dir = PathBuf::from(first_audio)
        .parent()
        .ok_or("Could not determine audio directory")?
        .to_path_buf();

    let output_path = audio_dir.join("output.mp4");

    // If multiple audio files, concatenate them first
    let final_audio_path = if audio_paths.len() > 1 {
        let concat_list_path = audio_dir.join("concat_list.txt");

        // Create concat file
        let concat_content = audio_paths
            .iter()
            .map(|p| format!("file '{}'", p))
            .collect::<Vec<_>>()
            .join("\n");

        std::fs::write(&concat_list_path, concat_content)
            .map_err(|e| format!("Failed to create concat list: {}", e))?;

        let temp_audio = audio_dir.join("temp_combined.mp3");

        // Concatenate audio files
        let mut concat_cmd = FfmpegCommand::new();
        concat_cmd
            .format("concat")
            .input(concat_list_path.to_str().unwrap())
            .args(&["-safe", "0", "-c", "copy"])
            .overwrite()
            .output(temp_audio.to_str().unwrap());

        concat_cmd.spawn()
            .map_err(|e| format!("Failed to spawn FFmpeg concat: {}", e))?
            .wait()
            .map_err(|e| format!("Failed to concatenate audio: {}", e))?;

        // Clean up concat list
        let _ = std::fs::remove_file(concat_list_path);

        temp_audio.to_str().unwrap().to_string()
    } else {
        audio_paths[0].clone()
    };

    // Determine filter based on background style
    let video_filter = match background_style.as_str() {
        "cover" => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        "contain" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        "repeat" => "tile=2x2",
        "center" => "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2",
        _ => "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
    };

    // Calculate volumes as decimals (0-100 -> 0.0-1.0)
    let main_volume = main_audio_volume as f32 / 100.0;

    // If background music is provided, we need to mix the audio
    let _output = if let Some(bg_music) = bg_music_path {
        let bg_volume = bg_music_volume as f32 / 100.0;

        // Create audio filter for mixing: loop bg music, adjust volumes, and mix
        let audio_filter = format!(
            "[1:a]aloop=loop=-1:size=2e+09[bg];[bg]volume={}[bg_vol];[0:a]volume={}[main];[bg_vol][main]amix=inputs=2:duration=first:dropout_transition=2",
            bg_volume, main_volume
        );

        let mut cmd = FfmpegCommand::new();
        cmd
            .input(&image_path)
            .input(&bg_music)
            .input(&final_audio_path)
            .args(&[
                "-loop", "1",
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

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn FFmpeg: {}", e))?
            .wait()
            .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?
    } else {
        // No background music, but still apply main audio volume
        let audio_filter = format!("volume={}", main_volume);

        let mut cmd = FfmpegCommand::new();
        cmd
            .input(&image_path)
            .input(&final_audio_path)
            .args(&[
                "-loop", "1",
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

        cmd.spawn()
            .map_err(|e| format!("Failed to spawn FFmpeg: {}", e))?
            .wait()
            .map_err(|e| format!("Failed to execute FFmpeg: {}", e))?
    };

    // Clean up temporary combined audio if it exists
    if audio_paths.len() > 1 {
        let temp_audio = audio_dir.join("temp_combined.mp3");
        let _ = std::fs::remove_file(temp_audio);
    }

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![convert_to_video, convert_timeline_to_video, upload_to_vimeo])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
