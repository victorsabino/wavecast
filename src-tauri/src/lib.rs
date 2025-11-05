use std::path::PathBuf;
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::download::auto_download;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct VimeoUploadResponse {
    link: String,
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
    let output = if let Some(bg_music) = bg_music_path {
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
        .invoke_handler(tauri::generate_handler![convert_to_video, upload_to_vimeo])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
