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
 clean-fix-console-log

  const videoRef = useRef<HTMLVideoElement>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const [fileError, setFileError] = useState("");
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  const exportCancelledRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const [musicFile, setMusicFile] = useState<File | null>(null);
  const [musicVolume, setMusicVolume] = useState(70);
  const [originalAudioVolume, setOriginalAudioVolume] = useState(40);
  const [loopMusic, setLoopMusic] = useState(false);

  const [overlayFile, setOverlayFile] = useState<File | null>(null);
  const [overlayPosition, setOverlayPosition] = useState<OverlayPosition>("bottom-right");
  const [overlaySize, setOverlaySize] = useState(150);
  const [overlayOpacity, setOverlayOpacity] = useState(100);

 const updateRecipe = useCallback((patch: Partial<EditRecipe>) => {
  setRecipe((prev) => {
    const next = { ...prev, ...patch };
    // GIF has no audio — force keepAudio off
    if (next.format === "gif") {
      next.keepAudio = false;
    }
    return next;
  });
}, []);
  const isValidValue = (key: keyof EditRecipe, val: any): boolean => {
    switch (key) {
      case "preset":
        return typeof val === "string";
      case "customWidth":
        return typeof val === "number" && !isNaN(val) && val >= 16 && val <= 7680;
      case "customHeight":
        return typeof val === "number" && !isNaN(val) && val >= 16 && val <= 7680;
      case "framing":
        return val === "fit" || val === "fill";
      case "trimStart":
        return typeof val === "number" && !isNaN(val) && val >= 0;
      case "trimEnd":
        return val === null || (typeof val === "number" && !isNaN(val) && val >= 0);
      case "rotate":
        return val === 0 || val === 90 || val === 180 || val === 270;
      case "speed":
        return typeof val === "number" && !isNaN(val) && [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4].includes(val);
      case "quality":
        return typeof val === "number" && !isNaN(val) && val >= 18 && val <= 30;
      case "format":
        return val === "mp4" || val === "webm" || val === "mkv" || val === "gif";
      case "brightness":
        return typeof val === "number" && !isNaN(val) && val >= -1 && val <= 1;
      case "contrast":
        return typeof val === "number" && !isNaN(val) && val >= 0 && val <= 2;
      case "saturation":
        return typeof val === "number" && !isNaN(val) && val >= 0 && val <= 3;
      default:
        return true;
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      const recipeKeys = Object.keys(DEFAULT_RECIPE) as Array<keyof EditRecipe>;
      const hasRecipeParams = recipeKeys.some(key => params.has(key));

      if (hasRecipeParams) {
        const updatedPatch: Partial<EditRecipe> = {};
        recipeKeys.forEach((key) => {
          const paramVal = params.get(key);
          if (paramVal !== null) {
            const defaultType = typeof DEFAULT_RECIPE[key];
            let parsedVal: any;

            if (defaultType === "number") {
              parsedVal = parseFloat(paramVal);
            } else if (defaultType === "boolean") {
              parsedVal = paramVal === "true";
            } else {
              parsedVal = paramVal === "null" ? null : paramVal;
            }

            if (isValidValue(key, parsedVal)) {
              (updatedPatch as any)[key] = parsedVal;
            }
          }
        });

        if (Object.keys(updatedPatch).length > 0) {
          setRecipe(prev => ({
            ...prev,
            ...updatedPatch
          }));
        }
      } else {
        const saved = localStorage.getItem("reframe-settings");
        if (saved) {
          const parsed = JSON.parse(saved);
          setRecipe(prev => ({
            ...prev,
            preset: parsed.preset ?? prev.preset,
            quality: parsed.quality ?? prev.quality,
            speed: parsed.speed ?? prev.speed,
            customWidth: parsed.customWidth ?? prev.customWidth,
            customHeight: parsed.customHeight ?? prev.customHeight
          }));
        }
      }
    } catch (e) {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams();
      const recipeKeys = Object.keys(DEFAULT_RECIPE) as Array<keyof EditRecipe>;

      recipeKeys.forEach((key) => {
        const currentVal = recipe[key];
        const defaultVal = DEFAULT_RECIPE[key];

        if (currentVal !== defaultVal) {
          params.set(key, currentVal === null ? "null" : String(currentVal));
        }
      });

      const newQuery = params.toString();
      const currentQuery = window.location.search.replace(/^\?/, "");

      if (newQuery !== currentQuery) {
        const newUrl = newQuery
          ? `${window.location.pathname}?${newQuery}`
          : window.location.pathname;
        window.history.replaceState(null, "", newUrl);
      }
    } catch (e) {
      // ignore
    }
  }, [recipe]);

  useEffect(() => {
    try {
      localStorage.setItem("reframe-settings", JSON.stringify({
        preset: recipe.preset,
        quality: recipe.quality,
        speed: recipe.speed,
        customWidth: recipe.customWidth,
        customHeight: recipe.customHeight
      }));
    } catch (e) {
      // ignore
    }
  }, [recipe.preset, recipe.quality, recipe.speed, recipe.customWidth, recipe.customHeight]);
 main

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
clean-fix-console-log
  }, [file, recipe, duration]);

    finally {
      if (exportAbortControllerRef.current === abortController) {
        exportAbortControllerRef.current = null;
      }
    }
  }, [file, recipe, result, status, overlayFile, overlayPosition, overlaySize, overlayOpacity, duration, loopMusic, musicFile, musicVolume, originalAudioVolume]);


  useEffect(() => {
    if (status === "exporting") {
      document.title = `Exporting ${progress}% | Reframe`;
    } else if (status === "loading-engine") {
      document.title = `Loading engine... | Reframe`;
    } else if (status === "done") {
      document.title = `Export complete | Reframe`;
    } else if (file) {
      document.title = `Editing: ${file.name} | Reframe`;
    } else {
      document.title = DEFAULT_TITLE;
    }
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [status, progress, file]);

  useEffect(() => {
    const shouldWarn =
      status === "exporting" ||
      status === "loading-engine" ||
      status === "done";

    if (!shouldWarn) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [status]);
  
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === "Enter" &&
        file &&
        status !== "loading-engine" &&
        status !== "exporting"
      ) {
        handleExport();
      }
    };

    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [file, status, handleExport]);

  // M key: toggle audio mute — only when a file is loaded and focus isn't in a text field
  useEffect(() => {
    if (!file) return;

    const handleMuteShortcut = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "m" || e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      setRecipe((prev) => ({ ...prev, keepAudio: !prev.keepAudio }));
    };

    document.addEventListener("keydown", handleMuteShortcut);
    return () => {
      document.removeEventListener("keydown", handleMuteShortcut);
    };
  }, [file]);

  useEffect(()=>{
    return ()=>{
      if(result?.blobUrl){
        URL.revokeObjectURL(result.blobUrl);
      }
    }
   },[result?.blobUrl])
 main

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