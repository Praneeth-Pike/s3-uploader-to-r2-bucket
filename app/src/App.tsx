import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import "./app.css";

interface ConnectionConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

interface UploadEntry {
  id: string;
  fileName: string;
  filePath: string;
  destinationKey: string;
  status: "queued" | "uploading" | "completed" | "failed";
  bytesUploaded: number;
  totalBytes: number;
  error?: string;
}

interface UploadProgressEvent {
  id: string;
  bytesUploaded: number;
  totalBytes: number;
  status: string;
  error?: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export default function App() {
  const [config, setConfig] = useState<ConnectionConfig | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [configForm, setConfigForm] = useState<ConnectionConfig>({
    accessKeyId: "",
    secretAccessKey: "",
    endpoint: "",
    bucket: "",
  });

  const configRef = useRef(config);
  const currentPathRef = useRef(currentPath);
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    invoke<ConnectionConfig | null>("load_config")
      .then((cfg) => {
        if (cfg) {
          setConfig(cfg);
          setConfigForm(cfg);
        } else {
          setShowSettings(true);
        }
      })
      .catch(() => setShowSettings(true));
  }, []);

  useEffect(() => {
    const unlisten = listen<UploadProgressEvent>("upload-progress", (event) => {
      const p = event.payload;
      setUploads((prev) =>
        prev.map((u) =>
          u.id === p.id
            ? {
                ...u,
                bytesUploaded: p.bytesUploaded,
                totalBytes: p.totalBytes,
                status: p.status as UploadEntry["status"],
                error: p.error,
              }
            : u,
        ),
      );
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type === "hover") {
        setIsDragOver(true);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        startUpload(event.payload.paths);
      } else {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const startUpload = useCallback(async (paths: string[]) => {
    if (!configRef.current) {
      setShowSettings(true);
      return;
    }
    try {
      const result = await invoke<UploadEntry[]>("upload_files", {
        filePaths: paths,
        destinationFolder: currentPathRef.current,
      });
      setUploads((prev) => [...result, ...prev]);
    } catch (err) {
      console.error("Upload start failed:", err);
    }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await open({ multiple: true, title: "Select files to upload" });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        startUpload(paths);
      }
    } catch (err) {
      console.error("File picker failed:", err);
    }
  };

  const handleSaveConfig = async () => {
    if (!configForm.accessKeyId || !configForm.secretAccessKey || !configForm.endpoint || !configForm.bucket) return;
    try {
      await invoke("save_config", { config: configForm });
      setConfig(configForm);
      setShowSettings(false);
    } catch (err) {
      console.error("Failed to save config:", err);
    }
  };

  const handleResume = async (uploadId: string) => {
    try {
      setUploads((prev) =>
        prev.map((u) => (u.id === uploadId ? { ...u, status: "uploading" as const, error: undefined } : u)),
      );
      await invoke("resume_upload", { uploadId });
    } catch (err) {
      console.error("Resume failed:", err);
    }
  };

  const pct = (u: UploadEntry) => (u.totalBytes > 0 ? Math.round((u.bytesUploaded / u.totalBytes) * 100) : 0);

  const isFormValid =
    configForm.accessKeyId && configForm.secretAccessKey && configForm.endpoint && configForm.bucket;

  return (
    <div className="app">
      <div className="header">
        <h1>S3/R2 Uploader</h1>
        <div className="header-right">
          {config && (
            <div className="connection-status">
              <span className="status-dot" />
              {config.bucket}
            </div>
          )}
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      <div className="folder-bar">
        <label>Path</label>
        <input
          type="text"
          value={currentPath}
          onChange={(e) => setCurrentPath(e.target.value)}
          placeholder="e.g. releases/v1.0"
        />
      </div>

      <div className={`drop-zone ${isDragOver ? "drag-over" : ""}`} onClick={handleBrowse}>
        <div className="drop-zone-icon">{isDragOver ? "📥" : "📂"}</div>
        <div className="drop-zone-text">{isDragOver ? "Drop files here" : "Drag & drop files here"}</div>
        <div className="drop-zone-hint">or click to browse</div>
      </div>

      {uploads.length > 0 && (
        <div className="upload-section">
          <div className="upload-section-header">
            Uploads ({uploads.filter((u) => u.status === "completed").length}/{uploads.length})
          </div>
          <div className="upload-list">
            {uploads.map((u) => (
              <div key={u.id} className="upload-item">
                <div className="upload-item-header">
                  <span className="upload-item-name" title={u.fileName}>
                    {u.fileName}
                  </span>
                  <span className={`upload-item-status ${u.status}`}>
                    {u.status === "completed"
                      ? "Done"
                      : u.status === "failed"
                        ? "Failed"
                        : u.status === "uploading"
                          ? `${pct(u)}%`
                          : "Queued"}
                  </span>
                </div>
                <div className="progress-bar">
                  <div className={`progress-fill ${u.status}`} style={{ width: `${pct(u)}%` }} />
                </div>
                <div className="upload-item-footer">
                  <span>
                    {formatBytes(u.bytesUploaded)} / {formatBytes(u.totalBytes)}
                  </span>
                  {u.status === "failed" && (
                    <button className="retry-btn" onClick={() => handleResume(u.id)}>
                      Retry
                    </button>
                  )}
                </div>
                {u.error && <div className="upload-error">{u.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => config && setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Connection Settings</h2>
            <div className="form-group">
              <label>Access Key ID</label>
              <input
                type="text"
                value={configForm.accessKeyId}
                onChange={(e) => setConfigForm((p) => ({ ...p, accessKeyId: e.target.value }))}
                placeholder="Your access key"
              />
            </div>
            <div className="form-group">
              <label>Secret Access Key</label>
              <input
                type="password"
                value={configForm.secretAccessKey}
                onChange={(e) => setConfigForm((p) => ({ ...p, secretAccessKey: e.target.value }))}
                placeholder="Your secret key"
              />
            </div>
            <div className="form-group">
              <label>Endpoint URL</label>
              <input
                type="text"
                value={configForm.endpoint}
                onChange={(e) => setConfigForm((p) => ({ ...p, endpoint: e.target.value }))}
                placeholder="https://xxx.r2.cloudflarestorage.com"
              />
            </div>
            <div className="form-group">
              <label>Bucket</label>
              <input
                type="text"
                value={configForm.bucket}
                onChange={(e) => setConfigForm((p) => ({ ...p, bucket: e.target.value }))}
                placeholder="my-bucket"
              />
            </div>
            <div className="modal-actions">
              {config && (
                <button className="btn-secondary" onClick={() => setShowSettings(false)}>
                  Cancel
                </button>
              )}
              <button className="btn-primary" onClick={handleSaveConfig} disabled={!isFormValid}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
