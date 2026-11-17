"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import type { BookData } from "@/lib/book";
import { createFrontCoverPreviewBlob } from "@/lib/cover-renderer";

type Props = {
  title: string;
  editor: string;
  coverStyle: BookData["coverStyle"];
  coverColor: BookData["coverColor"];
  pageCount: number;
  className?: string;
};

export function CoverFrontPreview({ title, editor, coverStyle, coverColor, pageCount, className = "" }: Props) {
  const previewKey = JSON.stringify([title, editor, coverStyle, coverColor, pageCount]);
  const [preview, setPreview] = useState<{ key: string; url?: string; failed?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void createFrontCoverPreviewBlob({ title, editor, coverStyle, coverColor }, pageCount).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ key: previewKey, url: objectUrl });
    }).catch(() => {
      if (active) setPreview({ key: previewKey, failed: true });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [title, editor, coverStyle, coverColor, pageCount, previewKey]);

  const currentPreview = preview?.key === previewKey ? preview : null;

  return (
    <div className={`relative aspect-[105/148] overflow-hidden rounded-sm bg-stone-200 shadow-md ${className}`}>
      {currentPreview?.url ? (
        <Image src={currentPreview.url} alt="実際の入稿用画像から切り出した表表紙" fill unoptimized sizes="(max-width: 640px) 64px, 88px" className="object-cover" />
      ) : (
        <div className="grid h-full place-items-center p-3 text-center text-xs text-stone-600" role={currentPreview?.failed ? "alert" : "status"}>
          {currentPreview?.failed ? "表紙を表示できませんでした" : "表紙を準備しています…"}
        </div>
      )}
    </div>
  );
}
