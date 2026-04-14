import { useRef } from "react";
import { st } from "./builder-types.ts";

export interface VideoFilePickerProps {
    file:     File | null;
    onChange: (f: File | null) => void;
}

export function VideoFilePicker({ file, onChange }: VideoFilePickerProps) {
    const inputRef = useRef<HTMLInputElement | null>(null);

    return (
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button style={st.btn} onClick={() => inputRef.current?.click()}>
                {file ? "Change file" : "Choose file"}
            </button>
            <input
                ref={inputRef}
                type="file"
                accept="video/mp4,video/webm"
                style={{ display: "none" }}
                onChange={e => onChange(e.target.files?.[0] ?? null)}
            />
            {file
                ? <span style={{ fontSize: "12px", color: "#aaa" }}>{file.name}</span>
                : <span style={{ fontSize: "12px", color: "#666" }}>No file chosen</span>
            }
        </div>
    );
}