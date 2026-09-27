import { useEffect, useRef, useState } from "react";
import { cameraErrorMessage } from "./scanErrors.js";

/** This computer's camera can run here: getUserMedia exists and the page is a secure context (or localhost). */
export function isCameraSecure(): boolean {
  return typeof window !== "undefined" && (window.isSecureContext || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
}

export function isCameraContextAvailable(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && isCameraSecure();
}

/**
 * This computer's camera for photo capture (the parts scan and "Identify from a photo"): open it, show the stream in
 * `videoRef`, and `capture()` the current frame as a JPEG file. Stops the stream when closed or unmounted.
 */
export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setReady(false);
      return;
    }
    let disposed = false;
    setError(null);
    setReady(false);
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then((stream) => {
      if (disposed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setReady(true);
    }).catch((reason: unknown) => setError(cameraErrorMessage(reason, isCameraSecure())));
    return () => {
      disposed = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setReady(false);
    };
  }, [open]);

  // The <video> mounts after the stream is ready; attach the stream once it exists.
  useEffect(() => {
    if (ready && videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) videoRef.current.srcObject = streamRef.current;
  }, [ready]);

  const capture = async (): Promise<File | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ? new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" }) : null;
  };

  return { videoRef, streamRef, open, setOpen, ready, error, capture };
}
