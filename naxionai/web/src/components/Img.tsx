import { useState } from "react";
import { ImageOff } from "lucide-react";

// Img — ported from KimmyDeku/sebastian's src/components/ui/Img.tsx: a
// graceful placeholder (labeled, not a browser broken-image icon) when
// `src` is empty or fails to load. Confirmed gap: only LinkPreview.tsx
// handles a broken image today, and it's a one-off inline onError, not a
// reusable component.
export function Img({ src, alt, className = "", rounded = true }: { src?: string; alt: string; className?: string; rounded?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`flex flex-col items-center justify-center gap-1 bg-ink-900 border border-ink-800 text-cream-300/40 ${rounded ? "rounded-lg" : ""} ${className}`}>
        <ImageOff size={16} />
        <span className="text-[10px] px-2 text-center truncate max-w-full">{alt}</span>
      </div>
    );
  }
  return <img src={src} alt={alt} onError={() => setFailed(true)} className={`object-cover ${rounded ? "rounded-lg" : ""} ${className}`} />;
}
