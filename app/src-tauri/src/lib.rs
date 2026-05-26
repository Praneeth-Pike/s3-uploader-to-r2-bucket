use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use aws_credential_types::Credentials;
use aws_sdk_s3::config::{Builder as S3ConfigBuilder, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{CompletedMultipartUpload, CompletedPart};
use aws_sdk_s3::Client;

const PART_SIZE: usize = 10 * 1024 * 1024; // 10 MB

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionConfig {
    access_key_id: String,
    secret_access_key: String,
    endpoint: String,
    bucket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadEntry {
    id: String,
    file_name: String,
    file_path: String,
    destination_key: String,
    status: String,
    bytes_uploaded: u64,
    total_bytes: u64,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    id: String,
    bytes_uploaded: u64,
    total_bytes: u64,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UploadState {
    id: String,
    file_path: String,
    destination_key: String,
    bucket: String,
    multipart_upload_id: Option<String>,
    completed_parts: Vec<PartInfo>,
    total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PartInfo {
    part_number: i32,
    e_tag: String,
}

struct AppState {
    config: Mutex<Option<ConnectionConfig>>,
    uploads: Mutex<HashMap<String, UploadState>>,
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn config_path(app: &AppHandle) -> PathBuf {
    config_dir(app).join("config.json")
}

fn create_s3_client(config: &ConnectionConfig) -> Client {
    let creds = Credentials::new(
        &config.access_key_id,
        &config.secret_access_key,
        None,
        None,
        "s3-r2-uploader",
    );

    let s3_config = S3ConfigBuilder::new()
        .endpoint_url(&config.endpoint)
        .region(Region::new("auto"))
        .credentials_provider(creds)
        .force_path_style(true)
        .behavior_version_latest()
        .build();

    Client::from_conf(s3_config)
}

#[tauri::command]
async fn load_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<ConnectionConfig>, String> {
    let path = config_path(&app);
    if path.exists() {
        let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let config: ConnectionConfig = serde_json::from_str(&data).map_err(|e| e.to_string())?;
        *state.config.lock().unwrap() = Some(config.clone());
        Ok(Some(config))
    } else {
        Ok(None)
    }
}

#[tauri::command]
async fn save_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<(), String> {
    let dir = config_dir(&app);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(&app), data).map_err(|e| e.to_string())?;
    *state.config.lock().unwrap() = Some(config);
    Ok(())
}

#[tauri::command]
async fn upload_files(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    file_paths: Vec<String>,
    destination_folder: String,
) -> Result<Vec<UploadEntry>, String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("No connection configured")?;

    let mut entries = Vec::new();

    for file_path in &file_paths {
        let path = PathBuf::from(file_path);
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let key = if destination_folder.is_empty() {
            file_name.clone()
        } else {
            let folder = destination_folder.trim_matches('/');
            format!("{}/{}", folder, file_name)
        };

        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|e| e.to_string())?;
        let total_bytes = metadata.len();

        let id = uuid::Uuid::new_v4().to_string();

        let entry = UploadEntry {
            id: id.clone(),
            file_name,
            file_path: file_path.clone(),
            destination_key: key.clone(),
            status: "uploading".to_string(),
            bytes_uploaded: 0,
            total_bytes,
            error: None,
        };
        entries.push(entry);

        let upload_state = UploadState {
            id: id.clone(),
            file_path: file_path.clone(),
            destination_key: key.clone(),
            bucket: config.bucket.clone(),
            multipart_upload_id: None,
            completed_parts: Vec::new(),
            total_bytes,
        };
        state
            .uploads
            .lock()
            .unwrap()
            .insert(id.clone(), upload_state);

        let app_handle = app.clone();
        let cfg = config.clone();
        let fp = file_path.clone();

        tokio::spawn(async move {
            if let Err(e) = do_upload(&app_handle, &cfg, &id, &fp, &key, total_bytes).await {
                let _ = app_handle.emit(
                    "upload-progress",
                    UploadProgress {
                        id,
                        bytes_uploaded: 0,
                        total_bytes,
                        status: "failed".to_string(),
                        error: Some(e),
                    },
                );
            }
        });
    }

    Ok(entries)
}

async fn do_upload(
    app: &AppHandle,
    config: &ConnectionConfig,
    upload_id: &str,
    file_path: &str,
    key: &str,
    total_bytes: u64,
) -> Result<(), String> {
    let client = create_s3_client(config);

    if total_bytes < PART_SIZE as u64 {
        let body = tokio::fs::read(file_path)
            .await
            .map_err(|e| e.to_string())?;

        client
            .put_object()
            .bucket(&config.bucket)
            .key(key)
            .body(ByteStream::from(body))
            .send()
            .await
            .map_err(|e| format!("{e}"))?;

        app.emit(
            "upload-progress",
            UploadProgress {
                id: upload_id.to_string(),
                bytes_uploaded: total_bytes,
                total_bytes,
                status: "completed".to_string(),
                error: None,
            },
        )
        .ok();

        return Ok(());
    }

    let create_resp = client
        .create_multipart_upload()
        .bucket(&config.bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("{e}"))?;

    let mp_upload_id = create_resp
        .upload_id()
        .ok_or("No upload ID returned")?
        .to_string();

    if let Ok(mut uploads) = app.state::<AppState>().uploads.lock() {
        if let Some(st) = uploads.get_mut(upload_id) {
            st.multipart_upload_id = Some(mp_upload_id.clone());
        }
    }

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| e.to_string())?;

    let mut completed_parts: Vec<CompletedPart> = Vec::new();
    let mut part_info_list: Vec<PartInfo> = Vec::new();
    let mut part_number: i32 = 1;
    let mut bytes_uploaded: u64 = 0;

    loop {
        let mut buf = vec![0u8; PART_SIZE];
        let mut total_read = 0;

        while total_read < PART_SIZE {
            let n = file
                .read(&mut buf[total_read..])
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            total_read += n;
        }

        if total_read == 0 {
            break;
        }
        buf.truncate(total_read);

        let resp = client
            .upload_part()
            .bucket(&config.bucket)
            .key(key)
            .upload_id(&mp_upload_id)
            .part_number(part_number)
            .body(ByteStream::from(buf))
            .send()
            .await
            .map_err(|e| format!("{e}"))?;

        let e_tag = resp.e_tag().unwrap_or_default().to_string();
        completed_parts.push(
            CompletedPart::builder()
                .e_tag(&e_tag)
                .part_number(part_number)
                .build(),
        );
        part_info_list.push(PartInfo {
            part_number,
            e_tag: e_tag.clone(),
        });

        if let Ok(mut uploads) = app.state::<AppState>().uploads.lock() {
            if let Some(st) = uploads.get_mut(upload_id) {
                st.completed_parts = part_info_list.clone();
            }
        }

        bytes_uploaded += total_read as u64;
        app.emit(
            "upload-progress",
            UploadProgress {
                id: upload_id.to_string(),
                bytes_uploaded,
                total_bytes,
                status: "uploading".to_string(),
                error: None,
            },
        )
        .ok();

        part_number += 1;
    }

    client
        .complete_multipart_upload()
        .bucket(&config.bucket)
        .key(key)
        .upload_id(&mp_upload_id)
        .multipart_upload(
            CompletedMultipartUpload::builder()
                .set_parts(Some(completed_parts))
                .build(),
        )
        .send()
        .await
        .map_err(|e| format!("{e}"))?;

    app.emit(
        "upload-progress",
        UploadProgress {
            id: upload_id.to_string(),
            bytes_uploaded: total_bytes,
            total_bytes,
            status: "completed".to_string(),
            error: None,
        },
    )
    .ok();

    app.state::<AppState>()
        .uploads
        .lock()
        .ok()
        .map(|mut u| u.remove(upload_id));

    Ok(())
}

#[tauri::command]
async fn resume_upload(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    upload_id: String,
) -> Result<(), String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or("No connection configured")?;

    let upload_state = state
        .uploads
        .lock()
        .unwrap()
        .get(&upload_id)
        .cloned()
        .ok_or("Upload not found")?;

    let app_handle = app.clone();

    tokio::spawn(async move {
        let result = do_resume(&app_handle, &config, &upload_state).await;
        if let Err(e) = result {
            let _ = app_handle.emit(
                "upload-progress",
                UploadProgress {
                    id: upload_state.id.clone(),
                    bytes_uploaded: 0,
                    total_bytes: upload_state.total_bytes,
                    status: "failed".to_string(),
                    error: Some(e),
                },
            );
        }
    });

    Ok(())
}

async fn do_resume(
    app: &AppHandle,
    config: &ConnectionConfig,
    us: &UploadState,
) -> Result<(), String> {
    let client = create_s3_client(config);

    if let Some(mp_upload_id) = &us.multipart_upload_id {
        let bytes_already = us.completed_parts.len() as u64 * PART_SIZE as u64;

        let mut file = tokio::fs::File::open(&us.file_path)
            .await
            .map_err(|e| e.to_string())?;
        file.seek(std::io::SeekFrom::Start(bytes_already))
            .await
            .map_err(|e| e.to_string())?;

        let mut completed_parts: Vec<CompletedPart> = us
            .completed_parts
            .iter()
            .map(|p| {
                CompletedPart::builder()
                    .e_tag(&p.e_tag)
                    .part_number(p.part_number)
                    .build()
            })
            .collect();

        let mut part_number = us
            .completed_parts
            .last()
            .map(|p| p.part_number + 1)
            .unwrap_or(1);
        let mut bytes_uploaded = bytes_already;

        loop {
            let mut buf = vec![0u8; PART_SIZE];
            let mut total_read = 0;

            while total_read < PART_SIZE {
                let n = file
                    .read(&mut buf[total_read..])
                    .await
                    .map_err(|e| e.to_string())?;
                if n == 0 {
                    break;
                }
                total_read += n;
            }

            if total_read == 0 {
                break;
            }
            buf.truncate(total_read);

            let resp = client
                .upload_part()
                .bucket(&us.bucket)
                .key(&us.destination_key)
                .upload_id(mp_upload_id)
                .part_number(part_number)
                .body(ByteStream::from(buf))
                .send()
                .await
                .map_err(|e| format!("{e}"))?;

            completed_parts.push(
                CompletedPart::builder()
                    .e_tag(resp.e_tag().unwrap_or_default())
                    .part_number(part_number)
                    .build(),
            );

            bytes_uploaded += total_read as u64;
            app.emit(
                "upload-progress",
                UploadProgress {
                    id: us.id.clone(),
                    bytes_uploaded,
                    total_bytes: us.total_bytes,
                    status: "uploading".to_string(),
                    error: None,
                },
            )
            .ok();

            part_number += 1;
        }

        client
            .complete_multipart_upload()
            .bucket(&us.bucket)
            .key(&us.destination_key)
            .upload_id(mp_upload_id)
            .multipart_upload(
                CompletedMultipartUpload::builder()
                    .set_parts(Some(completed_parts))
                    .build(),
            )
            .send()
            .await
            .map_err(|e| format!("{e}"))?;
    } else {
        do_upload(
            app,
            config,
            &us.id,
            &us.file_path,
            &us.destination_key,
            us.total_bytes,
        )
        .await?;
    }

    app.emit(
        "upload-progress",
        UploadProgress {
            id: us.id.clone(),
            bytes_uploaded: us.total_bytes,
            total_bytes: us.total_bytes,
            status: "completed".to_string(),
            error: None,
        },
    )
    .ok();

    app.state::<AppState>()
        .uploads
        .lock()
        .ok()
        .map(|mut u| u.remove(&us.id));

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            config: Mutex::new(None),
            uploads: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            upload_files,
            resume_upload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
