"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import type { BookData } from "@/lib/book";
import { createSpreadCoverPreviewBlob } from "@/lib/cover-renderer";
import { calculateCoverLayout } from "@/lib/production";

type Props = {
  title: string;
  editor: string;
  coverStyle: BookData["coverStyle"];
  coverColor: BookData["coverColor"];
  pageCount: number;
};

export function CoverSpreadPreview({ title, editor, coverStyle, coverColor, pageCount }: Props) {
  const key = JSON.stringify([title, editor, coverStyle, coverColor, pageCount]);
  const [preview, setPreview] = useState<{ key: string; url?: string; failed?: boolean } | null>(null);
  const layout = calculateCoverLayout(pageCount);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    void createSpreadCoverPreviewBlob({ title, editor, coverStyle, coverColor }, pageCount).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setPreview({ key, url: objectUrl });
    }).catch(() => {
      if (active) setPreview({ key, failed: true });
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [title, editor, coverStyle, coverColor, pageCount, key]);

  const current = preview?.key === key ? preview : null;
  return (
    <div
      className="mx-auto overflow-hidden rounded-md bg-stone-200 shadow-lg"
      style={{ aspectRatio: layout ? `${layout.pixelWidth} / ${layout.pixelHeight}` : "1.45 / 1" }}
    >
      {current?.url ? (
        <Image src={current.url} alt="表表紙・背表紙・裏表紙の全体プレビュー" width={layout?.pixelWidth ?? 960} height={layout?.pixelHeight ?? 660} unoptimized className="h-full w-full object-contain" />
      ) : (
        <div className="grid h-full min-h-24 place-items-center p-3 text-center text-sm text-stone-700" role={current?.failed ? "alert" : "status"}>
          {current?.failed ? "表紙プレビューを表示できませんでした" : "表紙プレビューを準備しています…"}
        </div>
      )}
    </div>
  );
}
