"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { EditRecipe, ExportResult, ExportStatus, MAX_FILE_SIZE, OverlayPosition } from "@/lib/types";
import { DEFAULT_RECIPE, SPEED_STEPS } from "@/lib/constants";
import { getPresetById } from "@/lib/presets";
import { loadFFmpeg, exportVideo, terminateFFmpeg, FFmpegLoadError } from "@/lib/ffmpeg";
import { suggestPreset } from "@/lib/presetSuggestion";

const DEFAULT_TITLE = "Reframe — Resize, trim, and export videos in your browser";

/* ---------------- METADATA ---------------- */

export function extractMetadata(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");

    video.preload = "metadata";

    video.onloadedmetadata = () => {
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: isFinite(video.duration) ? video.duration : 0,
      });
      URL.revokeObjectURL(url);
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to load video metadata"));
    };

    video.src = url;
  });
}

/* ---------------- MAGIC BYTE CHECK ---------------- */

function verifyMagicBytes(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onloadend = (e) => {
      if (!e.target?.result) {
        resolve(false);
        return;
      }

      const arr = new Uint8Array(e.target.result as ArrayBuffer);
      const hex = Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      const ascii = String.fromCharCode(...arr);

      if (hex.startsWith("1A45DFA3")) resolve(true);
      else if (hex.startsWith("52494646")) resolve(true);
      else if (ascii.substring(0, 12).includes("ftyp")) resolve(true);
      else resolve(false);
    };

    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 12));
  });
}

/* ---------------- VALIDATION ---------------- */

function validateRecipe(recipe: EditRecipe, duration: number): string | null {
  if (recipe.trimStart < 0) return "Trim start cannot be < 0";
  if (recipe.trimEnd !== null && recipe.trimEnd > duration) return "Trim end exceeds duration";
  if (recipe.trimStart >= (recipe.trimEnd ?? duration)) return "Invalid trim range";

  return null;
}

/* ---------------- MAIN HOOK ---------------- */

export function useVideoEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [videoMetadata, setVideoMetadata] = useState<any>(null);

  const [recipe, setRecipe] = useState(DEFAULT_RECIPE);
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);

  /* ---------------- FILE SELECT ---------------- */

  const handleFileSelect = useCallback(async (selectedFile: File) => {
    setError(null);

    if (!selectedFile.type.startsWith("video/")) {
      setError("Only video files allowed");
      return;
    }

    if (selectedFile.size > MAX_FILE_SIZE) {
      setError("File too large");
      return;
    }

    const isValid = await verifyMagicBytes(selectedFile);
    if (!isValid) {
      setError("Invalid file");
      return;
    }

    const meta = await extractMetadata(selectedFile);
    setFile(selectedFile);
    setVideoMetadata(meta);
    setDuration(meta.duration);
  }, []);

  /* ---------------- EXPORT ---------------- */

  const handleExport = useCallback(async () => {
    if (!file) return;

    const err = validateRecipe(recipe, duration);
    if (err) {
      setError(err);
      return;
    }

    try {
      setStatus("loading-engine");
      const ffmpeg = await loadFFmpeg();

      setStatus("exporting");

      const result = await exportVideo(
        ffmpeg,
        file,
        recipe,
        setProgress,
        new AbortController().signal
      );

      setResult(result);
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setError("Export failed");
    }
  }, [file, recipe, duration]);

  /* ---------------- CLEAN FIXED EFFECT ---------------- */

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (status !== "exporting") return;

    const interval = setInterval(() => {}, 1000);
    return () => clearInterval(interval);
  }, [status]);

  /* ---------------- SEEK ---------------- */

  const seekTo = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  }, []);

  /* ---------------- RETURN ---------------- */

  return {
    file,
    duration,
    recipe,
    status,
    progress,
    result,
    error,
    videoRef,
    seekTo,
    handleFileSelect,
    handleExport,
  };
}